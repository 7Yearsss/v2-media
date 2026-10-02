import { mergeComments, type CollectionPageCommand, type CollectionPageSnapshot, type NoteCard, type NoteDetail } from "@v2media/shared";
import { mainRequest, type LoginState } from "../../lib/messages";
import { el, shadowHost } from "../../lib/ui";

const url = new URL(location.href);
const marker = url.searchParams.get("__v2m_collect_task"), lease = url.searchParams.get("__v2m_lease");
if (marker && lease) sessionStorage.setItem("v2m_collection_page", JSON.stringify({ marker, lease }));
const stored = sessionStorage.getItem("v2m_collection_page");
if (["www.xiaohongshu.com", "xiaohongshu.com"].includes(location.hostname) && stored) {
  const identity = JSON.parse(stored) as { marker: string; lease: string };
  const { shadow } = shadowHost("v2m-collection-task");
  shadow.append(el("style", {}, ":host{all:initial} .notice{position:fixed;bottom:16px;right:16px;z-index:2147482992;padding:10px 14px;border-radius:12px;background:#202024;color:#fff;font:12px/1.6 system-ui,sans-serif;pointer-events:none}"),
    el("div", { class: "notice", role: "status" }, `自动采集任务 #${identity.marker}；暂停/继续请到工作台。遇验证时请手动处理。`));
  const visible = (element: Element) => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== "hidden" && getComputedStyle(element).display !== "none"; };
  const challenge = () => /\/404\/sec_|\/sec_[a-z]|captcha/i.test(location.pathname)
    || [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="verify"],[class*="captcha"],[class*="verify-container"]')].some(visible)
    || /请完成验证|拖动滑块|完成拼图|验证后继续/.test(document.body?.innerText ?? "");
  function scrollPage(note: boolean) {
    const selectors = note ? ".note-scroller, .comments-container, [class*=comment-list]" : ".feeds-container, .search-result, main";
    const candidates = [...document.querySelectorAll<HTMLElement>(selectors)].filter(e => visible(e) && e.scrollHeight - e.clientHeight > 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
    const target = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? document.scrollingElement;
    target?.scrollBy({ top: Math.max(400, (target.clientHeight || innerHeight) * .8), behavior: "instant" });
  }
  async function read(command: CollectionPageCommand): Promise<CollectionPageSnapshot> {
    if (challenge()) return { state: "blocked", reason: "小红书要求安全验证，请手动处理后在工作台继续", cards: [], exhausted: false };
    const login = await mainRequest<LoginState>("loginState");
    if (!login.loggedIn) return { state: "login_required", reason: "小红书登录已失效，请登录后在工作台继续", cards: [], exhausted: false };
    if (command.action === "scroll") scrollPage(Boolean(command.noteId));
    const cached = await mainRequest<{ cards: NoteCard[]; details: NoteDetail[]; comments?: Record<string, any[]>; commentsHasMore?: Record<string, boolean> }>("listCached");
    const detail = command.noteId ? cached.details.find(d => d.noteId === command.noteId) : undefined;
    const comments = command.noteId ? cached.comments?.[command.noteId] : undefined;
    const exhausted = [...document.querySelectorAll('footer,[class*="end-tip"],[class*="no-more"]')].some(e => visible(e) && /没有更多|到底了|没有找到|暂无搜索结果/.test(e.textContent ?? ""));
    return { state: "ready", keyword: new URL(location.href).searchParams.get("keyword") ?? undefined,
      cards: cached.cards.filter(c => command.noteId ? c.noteId === command.noteId : c.source === "search"),
      detail: detail ? { ...detail, commentsData: mergeComments(detail.commentsData ?? [], comments ?? []) } : undefined,
      commentsHasMore: command.noteId ? cached.commentsHasMore?.[command.noteId] : undefined, exhausted };
  }
  chrome.runtime.onMessage.addListener((command: CollectionPageCommand, _sender, respond) => {
    if (command.type !== "COLLECTION_PAGE") return false;
    if (command.leaseId !== identity.lease) { respond({ ok: false, error: "任务页租约不匹配" }); return false; }
    void read(command).then(data => respond({ ok: true, data }), e => respond({ ok: false, error: String(e) })); return true;
  });
}
