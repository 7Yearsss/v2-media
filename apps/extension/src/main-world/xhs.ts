/**
 * MAIN world 嗅探脚本（world:"MAIN", document_start）。
 * 机制照 docs/xhs-extension-research.md：
 *  - hook XMLHttpRequest.prototype.open/send + window.fetch，readyState 4 时按
 *    classifyXhsApiUrl(responseURL) 分类，响应 JSON 交给 shared 的纯函数解析；
 *  - 结果经 window.dispatchEvent(new CustomEvent("v2m:notes")) 发给隔离 world；
 *  - 页面 load 后读 __INITIAL_STATE__（Vue3 reactive 包装，shared 的 unwrap 处理
 *    _rawValue）：feed.feeds / user.notes / search.feeds；
 *  - 最近采集结果缓存在 window.__V2M_XHS_CACHE__，隔离 world 用 v2m:req/v2m:res
 *    CustomEvent 往返拉取（keep-alive）。
 * 只在 www 站嗅探；creator 子域由 creator-publish.ts 负责。
 */

import {
  classifyXhsApiUrl,
  commentsFromResponse,
  noteCardsFromInitialState,
  noteCardsFromResponse,
  noteDetailFromFeedResponse,
  unwrap,
} from "@v2media/shared";
import type {
  CollectSource,
  NoteCard,
  NoteComment,
  NoteDetail,
} from "@v2media/shared";
import {
  EVT_COMMENTS,
  EVT_NOTES,
  EVT_REQ,
  EVT_RES,
} from "../lib/messages";
import type { MainRequest, MainResponse } from "../lib/messages";

type Any = Record<string, any>; // 页面 __INITIAL_STATE__ / API JSON 均为未知形状，边界处交给 shared 解析器

interface XhsCache {
  cards: Record<string, NoteCard>;
  details: Record<string, NoteDetail>;
  comments: Record<string, NoteComment[]>;
  order: string[]; // noteId LRU 顺序
}

declare global {
  interface Window {
    __INITIAL_STATE__?: Any;
    __V2M_XHS_CACHE__?: XhsCache;
    __v2m_xhs_main_ready?: boolean;
  }
}

const MAX_CARDS = 300;
const MAX_DETAILS = 60;
const MAX_COMMENTS = 60;

const onXhsSite =
  location.hostname === "www.xiaohongshu.com" || location.hostname === "xiaohongshu.com";

if (onXhsSite && !window.__v2m_xhs_main_ready) {
  window.__v2m_xhs_main_ready = true;
  const cache: XhsCache = (window.__V2M_XHS_CACHE__ = {
    cards: {},
    details: {},
    comments: {},
    order: [],
  });

  // ---------- 缓存（keep-alive：隔离 world 随时可拉） ----------

  function touchCache() {
    while (cache.order.length > MAX_CARDS) {
      const id = cache.order.shift();
      if (id && !cache.details[id]) delete cache.cards[id];
    }
    const detailIds = Object.keys(cache.details);
    if (detailIds.length > MAX_DETAILS) {
      for (const id of detailIds.slice(0, detailIds.length - MAX_DETAILS)) {
        delete cache.details[id];
      }
    }
    const commentIds = Object.keys(cache.comments);
    if (commentIds.length > MAX_COMMENTS) {
      for (const id of commentIds.slice(0, commentIds.length - MAX_COMMENTS)) {
        delete cache.comments[id];
      }
    }
  }

  function pageContext(): CollectBatchContext {
    const ctx: CollectBatchContext = { pageUrl: location.href };
    const u = new URL(location.href);
    const kw = u.searchParams.get("keyword") ?? u.searchParams.get("q");
    if (kw) ctx.keyword = kw;
    const m = u.pathname.match(/\/user\/profile\/([0-9a-f]+)/i);
    if (m?.[1]) ctx.authorId = m[1];
    return ctx;
  }
  type CollectBatchContext = { keyword?: string; authorId?: string; pageUrl?: string };

  function emitNotes(
    source: CollectSource,
    items: NoteCard[],
    details?: NoteDetail[],
  ) {
    if (!items.length && !details?.length) return;
    for (const it of items) {
      cache.cards[it.noteId] = it;
      cache.order = cache.order.filter((x) => x !== it.noteId);
      cache.order.push(it.noteId);
    }
    for (const d of details ?? []) cache.details[d.noteId] = d;
    touchCache();
    window.dispatchEvent(
      new CustomEvent(EVT_NOTES, {
        detail: { source, context: pageContext(), items, details },
      }),
    );
  }

  function emitComments(noteId: string | undefined, comments: NoteComment[]) {
    if (!comments.length) return;
    if (noteId) cache.comments[noteId] = comments;
    touchCache();
    window.dispatchEvent(
      new CustomEvent(EVT_COMMENTS, { detail: { noteId, comments } }),
    );
  }

  // ---------- 响应处理 ----------

  const FEED_PATH = "/api/sns/web/v1/feed"; // 详情接口

  function commentNoteId(url: URL): string | undefined {
    // 评论接口 query 里带 note_id / noteId / item_id，视版本而定
    return (
      url.searchParams.get("note_id") ??
      url.searchParams.get("noteId") ??
      url.searchParams.get("item_id") ??
      undefined
    );
  }

  function sniffJson(urlStr: string, parsed: Any) {
    let u: URL;
    try {
      u = new URL(urlStr, location.href);
    } catch {
      return;
    }
    // TODO(契约): shared 的 classifyXhsApiUrl 未覆盖详情接口 /v1/feed，
    // 这里在插件侧补分支；契约若补 kind:"detail" 可并回去。
    if (u.pathname === FEED_PATH) {
      const detail = noteDetailFromFeedResponse(parsed);
      if (detail) {
        emitNotes("detail", [
          {
            noteId: detail.noteId,
            xsecToken: detail.xsecToken,
            type: detail.type,
            title: detail.title,
            desc: detail.desc,
            author: detail.author,
            cover: detail.cover,
            likes: detail.likes,
            collects: detail.collects,
            comments: detail.comments,
            shares: detail.shares,
            url: detail.url,
            source: "detail",
          },
        ], [detail]);
      }
      return;
    }
    const cls = classifyXhsApiUrl(urlStr);
    if (!cls) return;
    if (cls.kind === "comments") {
      emitComments(commentNoteId(u), commentsFromResponse(parsed));
    } else {
      const { items } = noteCardsFromResponse(parsed, cls.source);
      emitNotes(cls.source, items);
    }
  }

  function sniffText(url: string, text: string) {
    if (typeof text !== "string" || !text || text[0] !== "{") return;
    let parsed: Any;
    try {
      parsed = JSON.parse(text) as Any;
    } catch {
      return;
    }
    sniffJson(url, parsed);
  }

  // ---------- XHR hook（open 记 URL，send 后 readyState 4 取响应） ----------

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async = true,
    user?: string | null,
    password?: string | null,
  ) {
    (this as { __v2m_url?: string }).__v2m_url = String(url || "");
    return (origOpen as any).call(this, method, url, async, user, password);
  };
  XMLHttpRequest.prototype.send = function (...args: any[]) {
    this.addEventListener("readystatechange", function () {
      if (this.readyState !== 4) return;
      const url = this.responseURL || (this as { __v2m_url?: string }).__v2m_url || "";
      try {
        sniffText(url, this.responseText);
      } catch {
        /* 非 JSON / blob 响应 */
      }
    });
    return origSend.apply(this, args as []);
  };

  // ---------- fetch hook ----------

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args: Parameters<typeof fetch>) {
      const first: unknown = args[0];
      const url =
        typeof first === "string"
          ? first
          : first instanceof Request
            ? first.url
            : "";
      return origFetch.apply(this, args).then((resp) => {
        resp
          .clone()
          .text()
          .then((t) => sniffText(url, t))
          .catch(() => {});
        return resp;
      });
    };
  }

  // ---------- __INITIAL_STATE__ ----------

  const INITIAL_PATHS: Array<{ path: string; source: CollectSource }> = [
    { path: "feed.feeds", source: "homefeed" },
    { path: "search.feeds", source: "search" },
    { path: "user.notes", source: "user_posted" },
  ];

  /** SSR store 里详情是 camelCase，feed API 是 snake_case —— 键名适配后复用 shared 解析。 */
  function adaptDetailKeys(note: Any): Any {
    if (!note || typeof note !== "object") return note;
    const pick = (o: Any, ...keys: string[]) => {
      for (const k of keys) if (o[k] != null) return o[k];
      return undefined;
    };
    const ii = pick(note, "interact_info", "interactInfo") ?? {};
    const adaptIi = (x: Any): Any => ({
      liked_count: pick(x, "liked_count", "likedCount"),
      collected_count: pick(x, "collected_count", "collectedCount"),
      comment_count: pick(x, "comment_count", "commentCount"),
      share_count: pick(x, "share_count", "shareCount"),
    });
    const user = pick(note, "user") ?? {};
    const adaptUser = (x: Any): Any => ({
      user_id: pick(x, "user_id", "userId"),
      nickname: pick(x, "nickname", "nickName", "nick_name"),
      avatar: pick(x, "avatar", "image"),
    });
    const out: Any = { ...note };
    out.note_id = pick(note, "note_id", "noteId");
    out.display_title = pick(note, "display_title", "displayTitle", "title");
    out.interact_info = adaptIi(ii);
    out.user = adaptUser(user);
    out.image_list = pick(note, "image_list", "imageList", "images_list");
    out.tag_list = pick(note, "tag_list", "tagList");
    out.ip_location = pick(note, "ip_location", "ipLocation");
    out.last_update_time = pick(note, "last_update_time", "lastUpdateTime", "time");
    const cover = pick(note, "cover");
    if (cover && typeof cover === "object") {
      out.cover = {
        url_default: pick(cover, "url_default", "urlDefault", "url"),
        url_pre: pick(cover, "url_pre", "urlPre"),
      };
    }
    return out;
  }

  /** __INITIAL_STATE__.note.noteDetailMap -> NoteDetail[]（详情页 SSR 兜底）。 */
  function detailsFromInitialState(state: Any): NoteDetail[] {
    const noteState = unwrap<Any>(state.note) ?? {};
    const map = unwrap<Any>(noteState.noteDetailMap ?? noteState.note_detail_map) ?? {};
    const out: NoteDetail[] = [];
    for (const [noteId, entry] of Object.entries(map)) {
      const e = unwrap<Any>(entry) ?? {};
      const raw = unwrap<Any>(e.note ?? e);
      if (!raw) continue;
      const card = adaptDetailKeys(raw);
      const detail = noteDetailFromFeedResponse(
        { data: { items: [{ id: noteId, xsec_token: raw.xsec_token ?? e.xsecToken, note_card: card }] } },
        { noteId },
      );
      if (detail) out.push(detail);
    }
    return out;
  }

  function reparseInitialState(): { items: NoteCard[]; details: NoteDetail[] } {
    const state = window.__INITIAL_STATE__;
    if (!state || typeof state !== "object") return { items: [], details: [] };
    const items: NoteCard[] = [];
    for (const { path, source } of INITIAL_PATHS) {
      items.push(...noteCardsFromInitialState(state, path, source));
    }
    const details = detailsFromInitialState(state);
    return { items, details };
  }

  function scanInitialState() {
    const { items, details } = reparseInitialState();
    if (!items.length && !details.length) return;
    const source: CollectSource = details.length
      ? "detail"
      : /\/user\/profile\//.test(location.pathname)
        ? "user_posted"
        : /search_result/.test(location.pathname)
          ? "search"
          : "homefeed";
    emitNotes(source, items, details);
  }

  // document_start 时 __INITIAL_STATE__ 可能还没渲染出来，轮询等它。
  let tries = 0;
  const initTimer = setInterval(() => {
    tries++;
    scanInitialState();
    if (tries > 30) clearInterval(initTimer); // ~15s
  }, 500);
  window.addEventListener("load", () => scanInitialState());

  // SPA 路由切换后 SSR 状态会更新，延迟重扫
  const rescans = () => setTimeout(scanInitialState, 800);
  window.addEventListener("popstate", rescans);
  for (const key of ["pushState", "replaceState"] as const) {
    const orig = history[key];
    history[key] = function (...args: Parameters<typeof orig>) {
      const r = orig.apply(this, args);
      rescans();
      return r;
    };
  }

  // ---------- 隔离 world 请求（v2m:req / v2m:res） ----------

  function loginState() {
    const state = window.__INITIAL_STATE__ ?? {};
    const user = unwrap<Any>(state.user) ?? {};
    const info = unwrap<Any>(user.userInfo ?? user.user_info) ?? {};
    const loggedIn = Boolean(unwrap(user.loggedIn ?? user.logged_in));
    return {
      loggedIn,
      userId: String(info.userId ?? info.user_id ?? info.red_id ?? ""),
      nickname: String(info.nickname ?? info.nickName ?? info.nick_name ?? ""),
      avatar: String(info.avatar ?? info.image ?? info.images ?? ""),
    };
  }

  document.addEventListener(EVT_REQ, (ev) => {
    const req = (ev as CustomEvent<MainRequest>).detail;
    if (!req?.requestId) return;
    const reply = (r: Omit<MainResponse, "requestId">) =>
      document.dispatchEvent(
        new CustomEvent<MainResponse>(EVT_RES, {
          detail: { requestId: req.requestId, ...r },
        }),
      );
    try {
      switch (req.action) {
        case "getNote": {
          const id = req.noteId ?? "";
          let card = cache.cards[id];
          let detail = cache.details[id];
          if (!card && !detail) {
            // 兜底：现场重扫 __INITIAL_STATE__
            const { items, details } = reparseInitialState();
            card = items.find((x) => x.noteId === id);
            detail = details.find((x) => x.noteId === id);
          }
          reply({
            ok: true,
            result: { card, detail, comments: cache.comments[id] },
          });
          break;
        }
        case "listCached":
          reply({
            ok: true,
            result: {
              cards: Object.values(cache.cards),
              details: Object.values(cache.details),
            },
          });
          break;
        case "loginState":
          reply({ ok: true, result: loginState() });
          break;
        case "reparseInitialState":
          scanInitialState();
          reply({ ok: true, result: reparseInitialState() });
          break;
        default:
          reply({ ok: false, error: `unknown action ${String(req.action)}` });
      }
    } catch (e) {
      reply({ ok: false, error: String((e as Error)?.message ?? e) });
    }
  });
}
