import type { NoteCard } from "@v2media/shared";
export const taskNoteId = (n: number) => n.toString(16).padStart(24, "0");
export function taskCard(n = 1, likes = 1000): NoteCard { return { noteId: taskNoteId(n), title: `备餐 ${n}`, desc: "", type: "image", xsecToken: "test",
  author: { userId: "author", nickname: "备餐作者", avatar: "" }, cover: "https://cdn.test/image", likes, collects: 0, comments: 0, shares: 0,
  url: `https://www.xiaohongshu.com/explore/${taskNoteId(n)}?xsec_token=test`, source: "search" }; }
