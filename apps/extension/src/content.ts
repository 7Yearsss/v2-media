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
  const verifiedDetailIds = new Set<string>();
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

  // 归因任务页（URL 带 __v2m_task=N）：嗅探到的笔记数据直接回传后台，不走采集入库
  const taskMarker = location.href.match(/__v2m_task=(\d+)/)?.[1];

  // 详情补齐：对只有卡片的笔记后台拉详情页 HTML（SSR 里有 tags/正文/发布时间/
  // 互动数/图集）。fetchDetail 成功会再发一条 EVT_NOTES（detail 批次），回到这里入缓存。
  const detailRequested = new Set<string>();
  /** 发起一次详情补齐；返回 promise 便于批量并发等待。失败/空结果放行重试。 */
  function requestDetail(it: NoteCard) {
    detailRequested.add(it.noteId);
    return mainRequest<CachedNote>("fetchDetail", { url: it.url }, 15_000)
      .then((r) => {
        if (!r?.detail) detailRequested.delete(it.noteId); // 解析不到详情也放行重试
      })
      .catch(() => detailRequested.delete(it.noteId)); // 失败放行：下次事件可再试
  }
  function backfillDetails(items: NoteCard[]) {
    for (const it of items) {
      if (
        detailRequested.has(it.noteId) ||
        details.has(it.noteId) ||
        uploadedDetails.has(it.noteId) ||
        !it.url
      )
        continue;
      void requestDetail(it);
    }
  }

  // 采集时用的库（按笔记记）：后续补传要跟原批次同一个库，防止换库后补传把笔记挪走
  const colOfUpload = new Map<string, number | null>();

  document.addEventListener(EVT_NOTES, (ev) => {
    if (!cfg.enabled) return; // 总开关关：不动
    const batch = (ev as CustomEvent<CollectBatch>).detail;
    if (!batch) return;
    if (taskMarker) {
      const taskId = Number(taskMarker);
      for (const d of batch.details ?? []) {
        void chrome.runtime
          .sendMessage({
            type: "TASK_DATA",
            taskId,
            data: {
              noteId: d.noteId,
              url: d.url,
              likes: d.likes,
              collects: d.collects,
              comments: d.comments,
              shares: d.shares,
            },
          })
          .catch(() => {});
      }
      return; // 任务页不叠加采集 UI/入库
    }
    lastContext = batch.context ?? lastContext;
    for (const it of batch.items) {
      if (!cards.has(it.noteId)) {
        cards.set(it.noteId, it);
      }
    }
    for (const d of batch.details ?? []) {
      // 评论可能先于详情到（隐藏页/详情浏览）：合并进缓存，后续上传带上
      const cms = commentsMap.get(d.noteId);
      const incoming = (cms?.length ? { ...d, commentsData: cms } : d) as NoteDetail;
      // 与 main-world emitNotes 同款合并：瘦详情（SSR 重扫）不能冲掉富详情
      const prev = details.get(d.noteId);
      details.set(
        d.noteId,
        prev
          ? {
              ...incoming,
              images:
                incoming.images.length >= prev.images.length ? incoming.images : prev.images,
              videoUrl: incoming.videoUrl ?? prev.videoUrl,
              tags: incoming.tags.length ? incoming.tags : prev.tags,
              content: incoming.content || prev.content,
              desc: incoming.desc || prev.desc,
              cover: incoming.cover || prev.cover,
              publishedAt: incoming.publishedAt || prev.publishedAt,
              ipLocation: incoming.ipLocation || prev.ipLocation,
            }
          : incoming,
      );
      // 手动模式下，晚到的详情对已采卡片做补传（autoCollect 走 queueUpload 已覆盖）；
      // 沿用卡片入库时的库，不取当前选择（用户可能已换库）
      if (
        !cfg.autoCollect &&
        !collectFlag &&
        !uploadedDetails.has(d.noteId) &&
        uploadedCards.has(d.noteId)
      ) {
        pendingDetails.set(d.noteId, {
          data: details.get(d.noteId)!,
          colId: colOfUpload.get(d.noteId) ?? cfg.collectionId ?? null,
        });
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = window.setTimeout(() => flushQueue("detail", lastContext), 1500);
      }
    }
    refreshCount();
    if (cfg.autoCollect) {
      backfillDetails(batch.items); // 自动采集也补齐详情（只多发一次页面 fetch，不开页）
      queueUpload(batch); // 关自动采集：仍入库缓存供手动按钮，但不自动上报
    }
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
        colId: colOfUpload.get(d.noteId) ?? cfg.collectionId ?? null,
      });
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = window.setTimeout(() => flushQueue("detail", lastContext), 1500);
    }
  });

  // ---------- 卡片浮层按钮（site DOM 之外，fixed 对齐） ----------

  const NOTE_LINK =
    'a[href*="/explore/"], a[href*="/search_result/"], a[href*="/discovery/item/"]';
  const pickBtns = new Map<Element, { btn: HTMLElement; noteId: string }>();
  const cardEls = new Map<string, Element>();
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
      cardEls.set(noteId, section);
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
        cardEls.delete(rec.noteId);
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

  const detectChallenge = () => {
    if (/\/404\/sec_|\/sec_[a-z]/i.test(location.pathname)) return true;
    const text = document.body?.innerText ?? "";
    return (
      /请完成验证|安全验证|拖动滑块|拖动箭头|验证后继续|Security Verification|完成拼图/i.test(text) ||
      Boolean(document.querySelector('iframe[src*="captcha"], iframe[src*="verify"]'))
    );
  };

  const advanceComments = () => {
    const roots = document.querySelectorAll<HTMLElement>(
      '.comments-container, [class*="comments-container"], [class*="comment-list"], [class*="comments-list"], .parent-comment',
    );
    const candidates = new Set<HTMLElement>();
    for (const root of roots) {
      let current: HTMLElement | null = root;
      for (let depth = 0; current && depth < 6; depth += 1) {
        const style = getComputedStyle(current);
        if (
          current.scrollHeight - current.clientHeight > 50 &&
          current.offsetParent !== null &&
          /(auto|scroll)/.test(style.overflowY)
        ) {
          candidates.add(current);
          break;
        }
        current = current.parentElement;
      }
    }
    const noteScroller = document.querySelector<HTMLElement>(".note-scroller");
    if (
      noteScroller &&
      noteScroller.scrollHeight - noteScroller.clientHeight > 50 &&
      noteScroller.offsetParent !== null
    ) {
      candidates.add(noteScroller);
    }
    const target = [...candidates].reduce<HTMLElement | null>((best, el) => {
      const range = el.scrollHeight - el.clientHeight;
      const bestRange = best ? best.scrollHeight - best.clientHeight : 0;
      return range > Math.max(50, bestRange) ? el : best;
    }, null);
    const fallback = document.scrollingElement as HTMLElement | null;
    const scrollTarget = target ?? fallback;
    if (!scrollTarget) return;
    const top = 400 + Math.round(Math.random() * 300);
    scrollTarget.scrollBy({ top, behavior: "smooth" });
    scrollTarget.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: top }));
  };

  let modalCollecting = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 原地详情弹窗采集：点当前页的笔记卡片打开原生 modal（不新开 tab），
  // modal 自己发签名接口被嗅探；滚动评论容器翻页；验证码也在当前可见页由用户处理
  async function deepCollectInline(noteId: string): Promise<boolean> {
    if (modalCollecting || collectFlag) return false;
    const section = cardEls.get(noteId);
    // 卡片内有多个匹配锚点，第一个是 0×0 的不可见幻影；必须取有尺寸的封面锚点
    const link = section
      ? [...section.querySelectorAll<HTMLAnchorElement>(NOTE_LINK)].find(
          (a) => a.getBoundingClientRect().width > 50,
        )
      : undefined;
    if (!section || !link || !document.contains(section)) return false;
    modalCollecting = true;
    let challengeToastShown = false;
    try {
      // .click() 是非受信任事件会被 XHS 弹窗 handler 忽略（走默认跳转被 302）；
      // 必须滚动到可见后用 chrome.debugger 发真实鼠标点击
      link.scrollIntoView({ block: "center" });
      await sleep(500);
      const rect = link.getBoundingClientRect();
      const cx = Math.round(rect.left + rect.width / 2);
      const cy = Math.round(rect.top + rect.height / 2);
      const clickRes = await sendToBackground<{ ok?: boolean }>({
        type: "TRUSTED_CLICK",
        x: cx,
        y: cy,
      }).catch(() => null);
      if (!clickRes?.ok) return false;
      // 等弹窗路由生效（URL pushState 到 /explore/<id>）
      let opened = false;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (pageNoteId() === noteId) {
          opened = true;
          break;
        }
      }
      if (!opened) return false;
      const startAt = Date.now();
      let challengeMs = 0;
      let challengeSince: number | undefined;
      let lastCount = commentsMap.get(noteId)?.length ?? 0;
      let stableSince = Date.now();
      while (Date.now() - startAt - challengeMs < 30_000 && Date.now() - startAt < 120_000) {
        if (detectChallenge()) {
          if (!challengeToastShown) {
            challengeToastShown = true;
            toast("需要验证：请在当前页面完成，完成后自动继续", true);
          }
          challengeSince ??= Date.now();
          await sleep(1500);
          continue;
        }
        if (challengeSince) {
          challengeMs += Date.now() - challengeSince;
          challengeSince = undefined;
        }
        const count = commentsMap.get(noteId)?.length ?? 0;
        if (count > lastCount) {
          lastCount = count;
          stableSince = Date.now();
        } else if (count > 0 && Date.now() - stableSince > 3500) {
          break;
        }
        advanceComments();
        await sleep(1200);
      }
      try {
        const res = await mainRequest<CachedNote>("getNote", { noteId });
        if (res.card) cards.set(noteId, res.card);
        if (res.detail) {
          verifiedDetailIds.add(noteId);
          details.set(noteId, res.detail);
        }
        if (res.comments?.length) commentsMap.set(noteId, res.comments);
      } catch {
        /* 收尾读取失败就按已缓存的上传 */
      }
      return Boolean(commentsMap.get(noteId)?.length);
    } finally {
      modalCollecting = false;
      if (pageNoteId() === noteId) history.back();
    }
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
    // 页面详情经常先只给封面；SSR 详情可补齐完整图集、正文和标签。
    // SSR fetch 详情要带 xsec_token 才不被 302：优先选已带 token 的
    // 详情/卡片 URL（接口嗅探到的 detail.url 有，feed 卡片常没有）
    const urlCandidates = [detail?.url, card?.url].filter((u): u is string => Boolean(u));
    let detailUrl =
      urlCandidates.find((u) => u.includes("xsec_token")) ??
      (pageNoteId() === noteId
        ? `${location.origin}${location.pathname}${location.search}`
        : undefined) ??
      urlCandidates[0];
    const xsec = card?.xsecToken || detail?.xsecToken;
    if (detailUrl && xsec && !detailUrl.includes("xsec_token")) {
      detailUrl += `${detailUrl.includes("?") ? "&" : "?"}xsec_token=${encodeURIComponent(xsec)}&xsec_source=pc_feed`;
    }
    if (
      detailUrl &&
      (!detail ||
        !detail.content ||
        !detail.tags.length ||
        (detail.type === "image" && detail.images.length <= 1))
    ) {
      try {
        const res = await mainRequest<CachedNote>(
          "fetchDetail",
          { url: detailUrl },
          15_000,
        );
        if (res.detail) {
          verifiedDetailIds.add(noteId);
          detail = detail
            ? {
                ...detail,
                ...res.detail,
                content: res.detail.content || detail.content,
                tags: res.detail.tags.length ? res.detail.tags : detail.tags,
                images:
                  res.detail.images.length > detail.images.length
                    ? res.detail.images
                    : detail.images,
                videoUrl: res.detail.videoUrl || detail.videoUrl,
              }
            : res.detail;
          details.set(noteId, detail);
        }
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
      colOfUpload.set(noteId, cfg.collectionId ?? null);
      if (detail) uploadedDetails.add(noteId);
      // 上传飞行期间到达的评论/详情：手动采集成功后补传一次（in-flight 时 collected/
      // uploadedCards 还不满足，EVT_COMMENTS / EVT_NOTES 只进了缓存）
      const lateDetail = details.get(noteId);
      if (lateDetail && !uploadedDetails.has(noteId)) {
        pendingDetails.set(noteId, {
          data: lateDetail,
          colId: cfg.collectionId ?? null,
        });
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = window.setTimeout(() => flushQueue("detail", lastContext), 1500);
      }
      const late = commentsMap.get(noteId);
      if (
        detail &&
        late?.length &&
        !(detail as NoteDetail & { commentsData?: unknown[] }).commentsData?.length
      ) {
        pendingDetails.set(noteId, {
          data: { ...detail, commentsData: late } as NoteDetail,
          colId: colOfUpload.get(noteId) ?? cfg.collectionId ?? null,
        });
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = window.setTimeout(() => flushQueue("detail", lastContext), 1500);
      }
      toast(`已入库：${(card?.title || detail?.title || noteId).slice(0, 30)}${r?.saved === 0 ? "（已存在）" : ""}`);
      // 手动点采集 = 明确要这篇，始终深度补评论。优先在当前列表页原地打开
      // 笔记详情弹窗采集（不新开 tab，验证码也只在当前可见页弹）；卡片不在
      // DOM 里打不开弹窗时退回后台隐藏页通道。
      // collectFlag 页本身就在详情页、不再套娃触发。
      if (
        !collectFlag &&
        !commentsMap.get(noteId)?.length &&
        (card?.url || detail?.url)
      ) {
        const url = detail?.url || card!.url; // 详情 URL 带 xsec_token，兜底隐藏页也更不容易被 302
        void deepCollectInline(noteId).then(async (got) => {
          if (got) {
            // 弹窗已采到评论：取消队列里同笔记的兜底隐藏页任务（防 SW 重放死页）
            void sendToBackground({ type: "DEEP_COLLECT_CANCEL", noteId }).catch(() => {});
            await collectOne(noteId); // 重传一次带评论明细的详情
          } else {
            void sendToBackground({ type: "DEEP_COLLECT", url }).catch(() => {});
          }
        });
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
      // 对缺详情的卡片全部发起补齐（4 并发泵在后台跑，不取消）：上传只等 15s，
      // 之后到达的详情走 EVT_NOTES 补传通道 / 上报后兜底扫一遍
      const missing = [...cards.values()].filter(
        (c) => !details.has(c.noteId) && !detailRequested.has(c.noteId) && c.url,
      );
      const pump = (async () => {
        for (let i = 0; i < missing.length; i += 4) {
          await Promise.all(missing.slice(i, i + 4).map((c) => requestDetail(c)));
        }
      })();
      await Promise.race([pump, new Promise((r) => setTimeout(r, 15_000))]);
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
      const batchColId = cfg.collectionId ?? null;
      for (const it of items) uploadedCards.add(it.noteId);
      for (const d of dets) uploadedDetails.add(d.noteId);
      for (const n of [...items, ...dets]) colOfUpload.set(n.noteId, batchColId);
      // 上传飞行期间到的详情：兜底扫一遍（fetchDetail 在飞的响应可能刚好卡在边界）
      for (const d of details.values()) {
        if (uploadedCards.has(d.noteId) && !uploadedDetails.has(d.noteId)) {
          pendingDetails.set(d.noteId, { data: d, colId: batchColId });
          uploadedDetails.add(d.noteId); // 防 EVT_NOTES 补传重复入队
        }
      }
      // 同 collectOne：飞行期间晚到的评论补传
      for (const d of dets) {
        const late = commentsMap.get(d.noteId);
        const sent = d as NoteDetail & { commentsData?: unknown[] };
        if (late?.length && !sent.commentsData?.length) {
          pendingDetails.set(d.noteId, {
            data: { ...d, commentsData: late } as NoteDetail,
            colId: batchColId,
          });
        }
      }
      if (pendingDetails.size) {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = window.setTimeout(() => flushQueue("detail", lastContext), 1500);
      }
      toast(`全部入库完成（${r?.saved ?? items.length} 条）`);
      // 深度采集开：缺评论的笔记优先原地弹窗补（可见页面，验证码可直接人工处理）；
      // 卡片不在 DOM 里的退回后台隐藏页队列
      if (cfg.deepCollect) {
        let inline = 0;
        let queued = 0;
        for (const n of [...items, ...dets]) {
          if (commentsMap.get(n.noteId)?.length) continue;
          if (cardEls.has(n.noteId)) {
            const got = await deepCollectInline(n.noteId);
            if (got) {
              inline++;
              void sendToBackground({ type: "DEEP_COLLECT_CANCEL", noteId: n.noteId }).catch(() => {});
              const d = details.get(n.noteId);
              const late = commentsMap.get(n.noteId);
              if (d && late?.length) {
                pendingDetails.set(n.noteId, {
                  data: { ...d, commentsData: late } as NoteDetail,
                  colId: batchColId,
                });
              }
            }
          } else if (n.url) {
            const r = await sendToBackground<{ queued?: boolean }>({
              type: "DEEP_COLLECT",
              url: n.url,
            }).catch(() => null);
            if (r?.queued) queued++;
          }
        }
        if (pendingDetails.size) {
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = window.setTimeout(() => flushQueue("detail", lastContext), 1500);
        }
        if (inline) toast(`弹窗补评论完成 ${inline} 篇`);
        if (queued) toast(`深度补评论已排队 ${queued} 篇（较慢，后台进行）`);
      }
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
  if (collectFlag) sessionStorage.setItem("v2m_collect_url", location.href);
  const storedCollectUrl = sessionStorage.getItem("v2m_collect_url");
  if (collectFlag || storedCollectUrl) {
    const collectUrl = collectFlag ? location.href : storedCollectUrl!;
    const noteId =
      pageNoteId() ??
      collectUrl.match(/\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i)?.[1] ??
      null;
    let done = false;
    let challengeNotified = false;
    const finish = (
      ok: boolean,
      error?: string,
      result?: {
        detailCaptured: boolean;
        commentsCaptured: boolean;
        imageCount: number;
      },
    ) => {
      if (done) return;
      done = true;
      void sendToBackground({
        type: "COLLECT_URL_DONE",
        ok,
        noteId: noteId ?? undefined,
        error,
        ...result,
      });
    };
    let started = Date.now();
    let challengeBegan: number | undefined;
    let dataSince: number | undefined;
    const tick = async () => {
      if (done) return;
      cfg = await getSettings(); // 同步 cfg 可能还没加载，这里每次拿最新的
      if (!cfg.enabled) {
        finish(false, "插件已停用");
        return;
      }
      if (detectChallenge()) {
        challengeBegan ??= Date.now();
        if (!challengeNotified) {
          challengeNotified = true;
          void sendToBackground({
            type: "COLLECT_URL_CHALLENGE",
            noteId: noteId ?? undefined,
          });
        }
        // 被重定向到验证中转页（无 collectFlag）：周期性跳回原笔记页，
        // 用户验证通过后即可回到采集流程；未通过则再次落在验证页循环。
        if (!collectFlag) {
          setTimeout(() => {
            location.href = collectUrl;
          }, 10_000);
          return;
        }
        setTimeout(tick, 1200);
        return;
      }
      if (!collectFlag) return; // 中转页未命中验证文案但也不是笔记页：不再继续
      if (challengeBegan) {
        const pausedFor = Date.now() - challengeBegan;
        started += pausedFor;
        if (dataSince) dataSince += pausedFor;
        challengeBegan = undefined;
        void sendToBackground({
          type: "COLLECT_URL_CHALLENGE_DONE",
          noteId: noteId ?? undefined,
        });
      }
      challengeNotified = false;
      if (noteId && (cards.has(noteId) || details.has(noteId))) {
        dataSince ??= Date.now();
        advanceComments();
        const detail = details.get(noteId);
        const card = cards.get(noteId);
        const expectedComments = Math.max(detail?.comments ?? 0, card?.comments ?? 0);
        const commentsCount = commentsMap.get(noteId)?.length ?? 0;
        const elapsed = Date.now() - dataSince;
        const commentsCaptured =
          commentsCount > 0 || (expectedComments === 0 && elapsed > 4000);
        const detailCaptured = Boolean(
          detail &&
            (detail.type === "video"
              ? detail.videoUrl
              : detail.images.length > 1 ||
                (detail.images.length === 1 && verifiedDetailIds.has(noteId))),
        );
        const waitExpired = elapsed > 15_000;
        if ((detailCaptured && commentsCaptured) || waitExpired) {
          const uploaded = await collectOne(noteId);
          const finalDetail = details.get(noteId);
          const finalDetailCaptured = Boolean(
            finalDetail &&
              (finalDetail.type === "video"
                ? finalDetail.videoUrl
                : finalDetail.images.length > 1 ||
                  (finalDetail.images.length === 1 && verifiedDetailIds.has(noteId))),
          );
          const imageCount = finalDetail?.images.length ?? 0;
          const complete = uploaded && finalDetailCaptured && commentsCaptured;
          finish(
            complete,
            complete
              ? undefined
              : !finalDetailCaptured
                ? "详情或完整媒体未采集到"
                : `评论采集超时（笔记显示 ${expectedComments} 条评论）`,
            { detailCaptured: finalDetailCaptured, commentsCaptured, imageCount },
          );
          return;
        }
      }
      // 还没嗅探到：催 main world 重扫 __INITIAL_STATE__，再等嗅探响应
      await mainRequest("reparseInitialState").catch(() => undefined);
      if (Date.now() - started > 32_000) {
        const uploaded = noteId ? await collectOne(noteId) : false;
        const detail = noteId ? details.get(noteId) : undefined;
        finish(false, uploaded ? "深度采集等待数据超时" : "等待页面数据超时", {
          detailCaptured: Boolean(detail),
          commentsCaptured: Boolean(noteId && commentsMap.get(noteId)?.length),
          imageCount: detail?.images.length ?? 0,
        });
        return;
      }
      setTimeout(tick, 1200);
    };
    void tick();
  }
}
