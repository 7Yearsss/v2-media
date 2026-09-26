/**
 * 小红书站隔离 world 内容脚本（document_idle，仅 www 站干活）：
 *  - 收 main-world 的 v2m:notes / v2m:comments，去抖后 EXT_COLLECT 上报 background；
 *  - 笔记卡片右上角浮「采集本篇」按钮 —— 全部渲染在我们自己的 Shadow DOM host
 *    里（fixed 定位对齐卡片），绝不动站点 DOM；
 *  - 右下浮动条：已嗅探 N 条 / 一键全部入库 / 详情页「采集本篇」；
 *  - 应答 background 的 GET_LOGIN_STATE（心跳用）；
 *  - __v2m_collect=1 标记页：等数据齐后自动采集并回执 COLLECT_URL_DONE。
 */

import type { CollectBatch, NoteCard, NoteComment, NoteDetail } from "@v2media/shared";
import {
  EVT_COMMENTS,
  EVT_NOTES,
  mainRequest,
  sendToBackground,
} from "./lib/messages";
import type {
  CachedNote,
  CommentsEventDetail,
  LoginState,
} from "./lib/messages";
import { el, shadowHost, toastIn } from "./lib/ui";
import { getSettings, onSettingsChanged, type ExtSettings } from "./lib/settings";

const isWww =
  location.hostname === "www.xiaohongshu.com" || location.hostname === "xiaohongshu.com";

if (isWww) {
  // ---------- 已嗅探数据缓存 ----------

  const cards = new Map<string, NoteCard>();
  const details = new Map<string, NoteDetail>();
  const commentsMap = new Map<string, NoteComment[]>();
  // 卡片/详情分开记：卡片已传不阻挡后续到达的详情（详情含完整正文/图集/评论）
  const uploadedCards = new Set<string>();
  const uploadedDetails = new Set<string>();
  let lastContext: CollectBatch["context"];

  // ---------- UI：一个 shadow host 装卡片按钮层 + 浮动条 ----------

  const { shadow } = shadowHost("v2m-xhs-ext");
  const CSS = `
  :host { all: initial; }
  .overlay { position: fixed; inset: 0; z-index: 2147482990; pointer-events: none; }
  .pick { position: fixed; z-index: 2147482991; pointer-events: auto;
    padding: 3px 10px; border: 0; border-radius: 999px; font: 12px/1.6 system-ui, sans-serif;
    background: rgba(230, 34, 45, .92); color: #fff; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.25); opacity: .96; }
  .pick:hover { background: #e6212d; }
  .bar { position: fixed; right: 16px; bottom: 16px; z-index: 2147482992;
    display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px;
    background: rgba(24,24,27,.92); color: #fafafa; font: 12px/1.5 system-ui, sans-serif;
    box-shadow: 0 6px 20px rgba(0,0,0,.3); }
  .bar .dot { width: 7px; height: 7px; border-radius: 50%; background: #a1a1aa; flex: none; }
  .bar .dot.ok { background: #4ade80; }
  .bar button { border: 0; border-radius: 999px; padding: 4px 12px; font: inherit;
    cursor: pointer; background: #e6212d; color: #fff; }
  .bar button.ghost { background: transparent; border: 1px solid #52525b; color: #d4d4d8; }
  .bar button:disabled { opacity: .5; cursor: default; }
  `;
  shadow.append(el("style", {}, CSS));

  const overlay = el("div", { class: "overlay" });
  const dot = el("span", { class: "dot" });
  const countEl = el("span", {}, "已嗅探 0 条");
  const collectAllBtn = el("button", {}, "一键全部入库");
  const collectThisBtn = el("button", { class: "ghost", style: "display:none" }, "采集本篇");
  const bar = el("div", { class: "bar" }, dot, countEl, collectAllBtn, collectThisBtn);
  shadow.append(overlay, bar);

  // ---------- 启停开关（popup 写入 chrome.storage.local.v2m_settings） ----------
  let cfg: ExtSettings = { enabled: true, autoCollect: true, collectionId: null, deepCollect: false };
  function applySettings() {
    // 停用：隐藏全部注入 UI，嗅探只记内存不上报
    bar.style.display = cfg.enabled ? "" : "none";
    overlay.style.display = cfg.enabled ? "" : "none";
  }
  void getSettings().then((s) => {
    cfg = s;
    applySettings();
  });
  onSettingsChanged((s) => {
    const wasAuto = cfg.autoCollect;
    cfg = s;
    // 关掉自动采集：已经在排队的那批也不能再发出去
    if (wasAuto && !s.autoCollect && flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    applySettings();
  });

  const toast = (msg: string, ok = true) => toastIn(shadow, msg, ok);

  /** 当前页面上下文：搜索页带 keyword（和 main-world 的 pageContext 同逻辑）。 */
  function pageContext(): CollectBatch["context"] {
    const ctx: NonNullable<CollectBatch["context"]> = { pageUrl: location.href };
    const u = new URL(location.href);
    const kw = u.searchParams.get("keyword") ?? u.searchParams.get("q");
    if (kw) ctx.keyword = kw;
    return ctx;
  }

  function refreshCount() {
    countEl.textContent = `已嗅探 ${cards.size} 条`;
  }

  // ---------- 上报（去抖合并） ----------

  interface Pending<T> {
    data: T;
    /** 入队时的采集库快照：去抖期间用户换库，早入队的仍进旧库 */
    colId: number | null;
  }
  let pendingItems = new Map<string, Pending<NoteCard>>();
  let pendingDetails = new Map<string, Pending<NoteDetail>>();
  let flushTimer: number | undefined;

  async function uploadBatch(
    items: NoteCard[],
    dets: NoteDetail[],
    source: CollectBatch["source"],
    context: CollectBatch["context"],
    colId: number | null,
  ) {
    if (!items.length && !dets.length) return;
    if (!cfg.enabled) {
      // 停用中不发：塞回 pending（保留原库快照），重新启用后随下一批一起上报
      for (const it of items) pendingItems.set(it.noteId, { data: it, colId });
      for (const d of dets) pendingDetails.set(d.noteId, { data: d, colId });
      return;
    }
    const batch: CollectBatch = {
      source,
      context,
      collectionId: colId,
      items,
      details: dets.length ? dets : undefined,
    };
    try {
      const r = await sendToBackground<{ saved?: number }>({ type: "EXT_COLLECT", batch });
      for (const it of items) uploadedCards.add(it.noteId);
      for (const d of dets) uploadedDetails.add(d.noteId);
      if (typeof r?.saved === "number" && r.saved > 0) {
        toast(`已入库 ${r.saved} 条`);
      }
    } catch (e) {
      // 上报失败（含插件被停用拒绝）：塞回 pending 等重试，不标记已上传
      for (const it of items) pendingItems.set(it.noteId, { data: it, colId });
      for (const d of dets) pendingDetails.set(d.noteId, { data: d, colId });
      console.debug("[v2m] collect upload failed:", e);
    }
  }

  function queueUpload(batch: CollectBatch) {
    const colId = cfg.collectionId ?? null; // 入队时快照所选库
    for (const it of batch.items) {
      if (!uploadedCards.has(it.noteId) && !uploadedDetails.has(it.noteId))
        pendingItems.set(it.noteId, { data: it, colId });
    }
    for (const d of batch.details ?? []) {
      if (!uploadedDetails.has(d.noteId)) pendingDetails.set(d.noteId, { data: d, colId });
    }
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = window.setTimeout(
      () => flushQueue(batch.source, batch.context ?? lastContext),
      1500,
    );
  }

  function flushQueue(
    source: CollectBatch["source"],
    context: CollectBatch["context"],
  ) {
    // 按入队时的库分组：去抖期间换过库的就拆成多批发
    const groups = new Map<
      string,
      { colId: number | null; items: NoteCard[]; dets: NoteDetail[] }
    >();
    const push = <T>(
      p: Pending<T>,
      pick: (g: { items: NoteCard[]; dets: NoteDetail[] }) => T[],
    ) => {
      const k = String(p.colId);
      const g = groups.get(k) ?? { colId: p.colId, items: [], dets: [] };
      pick(g).push(p.data as never);
      groups.set(k, g);
    };
    for (const p of pendingItems.values()) push(p, (g) => g.items);
    for (const p of pendingDetails.values()) push(p, (g) => g.dets);
    pendingItems = new Map();
    pendingDetails = new Map();
    for (const g of groups.values())
      void uploadBatch(g.items, g.dets, source, context, g.colId);
  }

  // ---------- 事件接入 ----------

  document.addEventListener(EVT_NOTES, (ev) => {
    if (!cfg.enabled) return; // 总开关关：不动
    const batch = (ev as CustomEvent<CollectBatch>).detail;
    if (!batch) return;
    lastContext = batch.context ?? lastContext;
    for (const it of batch.items) {
      if (!cards.has(it.noteId)) {
        cards.set(it.noteId, it);
      }
    }
    for (const d of batch.details ?? []) details.set(d.noteId, d);
    refreshCount();
    if (cfg.autoCollect) queueUpload(batch); // 关自动采集：仍入库缓存供手动按钮，但不自动上报
    scheduleScan();
  });

  document.addEventListener(EVT_COMMENTS, (ev) => {
    if (!cfg.enabled) return;
    const d = (ev as CustomEvent<CommentsEventDetail>).detail;
    if (!d?.noteId) return;
    commentsMap.set(d.noteId, d.comments);
    // 缓存里的详情同步带上评论：后续任何详情重传都不会丢评论
    const det = details.get(d.noteId);
    if (det) details.set(d.noteId, { ...det, commentsData: d.comments } as NoteDetail);
    // 只补「已经采过」的笔记（手动采集过 / 自动模式已入库）：关自动采集时
    // 逛详情页不应产生上传。评论仍进 commentsMap，下次手动采集会带上。
    const collected =
      cfg.autoCollect || uploadedCards.has(d.noteId) || uploadedDetails.has(d.noteId);
    if (!collected) return;
    // 已排队的详情要就地合并评论（不能跳过，否则 flush 出去的是无评论版本）
    const pending = pendingDetails.get(d.noteId);
    if (pending) {
      pending.data = { ...pending.data, commentsData: d.comments } as NoteDetail;
      return;
    }
    const det2 = details.get(d.noteId);
    if (det2) {
      pendingDetails.set(d.noteId, {
        data: det2,
        colId: cfg.collectionId ?? null,
      });
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = window.setTimeout(() => flushQueue("detail", lastContext), 1500);
    }
  });

  // ---------- 卡片浮层按钮（site DOM 之外，fixed 对齐） ----------

  const NOTE_LINK =
    'a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]';
  const pickBtns = new Map<Element, { btn: HTMLElement; noteId: string }>();
  let rafScheduled = false;

  function noteIdFromCard(section: Element): string | null {
    const a = section.querySelector<HTMLAnchorElement>(NOTE_LINK);
    const m = a?.href.match(/\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i);
    return m?.[1] ?? null;
  }

  function scanCards() {
    const seen = new Set<Element>();
    for (const section of document.querySelectorAll("section.note-item")) {
      const noteId = noteIdFromCard(section);
      if (!noteId) continue;
      seen.add(section);
      if (!pickBtns.has(section)) {
        const btn = el("button", { class: "pick", onclick: () => void collectOne(noteId) }, "采集本篇");
        overlay.append(btn);
        pickBtns.set(section, { btn, noteId });
      }
    }
    // 卡片被 SPA 移除时清掉按钮
    for (const [section, rec] of pickBtns) {
      if (!seen.has(section) || !document.contains(section)) {
        rec.btn.remove();
        pickBtns.delete(section);
      }
    }
    reposition();
  }

  function reposition() {
    const vw = innerWidth;
    const vh = innerHeight;
    for (const [section, rec] of pickBtns) {
      const r = section.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width < 40) {
        rec.btn.style.display = "none";
        continue;
      }
      rec.btn.style.display = "";
      rec.btn.style.top = `${r.top + 8}px`;
      rec.btn.style.left = `${r.right - 76}px`;
    }
  }

  function scheduleScan() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      scanCards();
    });
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("scroll", scheduleScan, { capture: true, passive: true });
  window.addEventListener("resize", scheduleScan);
  // SPA 数据就绪可能晚于 mutation 风平浪静，低频兜底一次
  setInterval(scanCards, 2500);
  scanCards();

  // ---------- 采集动作 ----------

  function pageNoteId(): string | null {
    const m = location.pathname.match(/\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i);
    return m?.[1] ?? null;
  }

  async function collectOne(noteId: string): Promise<boolean> {
    if (!cfg.enabled) {
      toast("插件已停用", false);
      return false;
    }
    let card = cards.get(noteId);
    let detail = details.get(noteId);
    if (!card && !detail) {
      // 缓存未命中：让 main world 解析当前页 __INITIAL_STATE__
      try {
        const res = await mainRequest<CachedNote>("getNote", { noteId });
        card = card ?? res.card;
        detail = detail ?? res.detail;
        if (res.comments?.length) commentsMap.set(noteId, res.comments);
      } catch {
        /* 页面数据读不到 */
      }
    }
    // 只有卡片没有详情：后台拉详情页 HTML 补齐（tags/正文/发布时间/互动数），不用点进去
    if (!detail && card?.url) {
      try {
        const res = await mainRequest<CachedNote>(
          "fetchDetail",
          { url: card.url },
          15_000,
        );
        detail = detail ?? res.detail;
      } catch {
        /* 详情拉不到就按卡片上报 */
      }
    }
    if (!card && !detail) {
      toast("未嗅探到该笔记数据，稍等页面加载完再试", false);
      return false;
    }
    // TODO(契约): CollectBatch/NoteDetail 没有评论列表字段（NoteDetail.comments
    // 是数量）。按服务端 schema 的 comments_data 列名附带，等契约补字段后入协议。
    const detailWithComments = detail
      ? { ...detail, commentsData: commentsMap.get(noteId) }
      : undefined;
    const batch: CollectBatch = {
      source: detail ? "detail" : card?.source ?? "detail",
      context: pageContext(),
      collectionId: cfg.collectionId ?? null,
      items: card ? [card] : [],
      details: detailWithComments ? [detailWithComments] : undefined,
    };
    try {
      const r = await sendToBackground<{ saved?: number }>({ type: "EXT_COLLECT", batch });
      uploadedCards.add(noteId);
      if (detail) uploadedDetails.add(noteId);
      toast(`已入库：${(card?.title || detail?.title || noteId).slice(0, 30)}${r?.saved === 0 ? "（已存在）" : ""}`);
      // 深度采集：开隐藏标签页进详情页，让页面自己发评论接口被嗅探。
      // collectFlag 页本身就在详情页、不再套娃触发。
      if (
        cfg.deepCollect &&
        !collectFlag &&
        !commentsMap.get(noteId)?.length &&
        (card?.url || detail?.url)
      ) {
        void sendToBackground({
          type: "DEEP_COLLECT",
          url: card?.url || detail!.url,
        }).catch(() => {});
      }
      return true;
    } catch (e) {
      toast(`采集失败：${String((e as Error)?.message ?? e).slice(0, 60)}`, false);
      return false;
    }
  }

  async function collectAll() {
    if (!cfg.enabled) {
      toast("插件已停用", false);
      return;
    }
    collectAllBtn.disabled = true;
    collectAllBtn.textContent = "入库中…";
    try {
      // 拉一次 main-world 全量缓存，合进本地（keep-alive 数据）
      const res = await mainRequest<{ cards: NoteCard[]; details: NoteDetail[] }>(
        "listCached",
      ).catch(() => ({ cards: [], details: [] }));
      for (const c of res.cards) cards.set(c.noteId, c);
      for (const d of res.details) details.set(d.noteId, d);
      refreshCount();
      const items = [...cards.values()];
      const dets = [...details.values()];
      // 混合来源批量上报：取占多数的那个 source（服务端按 noteId upsert，不影响去重）
      const sourceVotes = new Map<string, number>();
      for (const it of items) sourceVotes.set(it.source, (sourceVotes.get(it.source) ?? 0) + 1);
      const majority =
        [...sourceVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "search";
      const batch: CollectBatch = {
        source: majority as CollectBatch["source"],
        context: pageContext(),
        collectionId: cfg.collectionId ?? null,
        items,
        details: dets.length ? dets : undefined,
      };
      const r = await sendToBackground<{ saved?: number }>({ type: "EXT_COLLECT", batch });
      for (const it of items) uploadedCards.add(it.noteId);
      for (const d of dets) uploadedDetails.add(d.noteId);
      toast(`全部入库完成（${r?.saved ?? items.length} 条）`);
    } catch (e) {
      toast(`入库失败：${String((e as Error)?.message ?? e).slice(0, 60)}`, false);
    } finally {
      collectAllBtn.disabled = false;
      collectAllBtn.textContent = "一键全部入库";
    }
  }

  collectAllBtn.addEventListener("click", () => void collectAll());
  collectThisBtn.addEventListener("click", () => {
    const id = pageNoteId();
    if (id) void collectOne(id);
  });

  // 详情页显「采集本篇」
  let lastPath = "";
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    collectThisBtn.style.display = pageNoteId() ? "" : "none";
    scheduleScan();
  }, 500);

  // ---------- background 消息 ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "GET_LOGIN_STATE") {
      mainRequest<LoginState>("loginState").then(
        (s) => sendResponse({ ok: true, data: s }),
        (e) =>
          sendResponse({
            ok: false,
            error: String((e as Error)?.message ?? e),
          }),
      );
      return true;
    }
    return false;
  });

  // 授权状态点
  void sendToBackground<{ authorized?: boolean }>({ type: "GET_STATUS" }).then(
    (s) => dot.classList.toggle("ok", Boolean(s?.authorized)),
    () => {},
  );

  // content 脚本(document_idle)晚于 main world(document_start)：先拉一次
  // keep-alive 缓存补齐计数（页面早期嗅探到的批次在监听注册前就发了）。
  void mainRequest<{ cards: NoteCard[]; details: NoteDetail[] }>("listCached")
    .then((res) => {
      for (const c of res.cards) cards.set(c.noteId, c);
      for (const d of res.details) details.set(d.noteId, d);
      refreshCount();
    })
    .catch(() => {});

  // ---------- __v2m_collect=1：工作台 COLLECT_URL 打开的页 ----------

  const collectFlag = new URL(location.href).searchParams.get("__v2m_collect");
  if (collectFlag) {
    const noteId = pageNoteId();
    let done = false;
    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      void sendToBackground({ type: "COLLECT_URL_DONE", ok, noteId: noteId ?? undefined, error });
    };
    const started = Date.now();
    const tick = async () => {
      if (done) return;
      cfg = await getSettings(); // 同步 cfg 可能还没加载，这里每次拿最新的
      if (!cfg.enabled) {
        finish(false, "插件已停用");
        return;
      }
      if (noteId && (cards.has(noteId) || details.has(noteId))) {
        finish(await collectOne(noteId));
        return;
      }
      // 还没嗅探到：催 main world 重扫 __INITIAL_STATE__，再等嗅探响应
      await mainRequest("reparseInitialState").catch(() => undefined);
      if (Date.now() - started > 20000) {
        // 最后兜底：直接按缓存/SSR 里有什么算什么
        finish(noteId ? await collectOne(noteId) : false, "等待页面数据超时");
        return;
      }
      setTimeout(tick, 1200);
    };
    void tick();
  }
}
