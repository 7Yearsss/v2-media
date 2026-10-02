/** XHS task navigation is deliberately separate from the generic task state machine. */
export function xhsCollectionUrl(keyword: string, taskId: number, leaseId: string) {
  const url = new URL("https://www.xiaohongshu.com/search_result");
  url.searchParams.set("keyword", keyword); url.searchParams.set("source", "web_search_result_notes");
  return markXhsCollectionUrl(url.href, taskId, leaseId);
}
export function markXhsCollectionUrl(raw: string, taskId: number, leaseId: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !["www.xiaohongshu.com", "xiaohongshu.com"].includes(url.hostname) || url.username || url.password || url.port) throw new Error("只允许小红书站内任务页");
  url.searchParams.set("__v2m_collect_task", String(taskId)); url.searchParams.set("__v2m_lease", leaseId); return url.href;
}
export function xhsTaskNoteUrl(raw: string, noteId: string) {
  try { const u = new URL(raw); return u.protocol === "https:" && ["www.xiaohongshu.com", "xiaohongshu.com"].includes(u.hostname)
    && !u.username && !u.password && !u.port && new RegExp(`^/(?:explore|search_result|discovery/item)/${noteId}$`, "i").test(u.pathname); } catch { return false; }
}
