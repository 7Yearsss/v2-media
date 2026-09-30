/** 合并已采到的多页评论；同一 id 更新内容，保留已加载的回复。 */
export interface CommentRecord {
  avatar?: string;
  commentId?: string;
  content: string;
  subComments?: CommentRecord[];
}

export function mergeComments<T extends CommentRecord>(previous: T[], incoming: T[]): T[] {
  const merged = new Map<string, T>();
  for (const comment of [...previous, ...incoming]) {
    const key = comment.commentId || comment.content;
    const old = merged.get(key);
    merged.set(key, old ? {
      ...old, ...comment,
      avatar: comment.avatar || old.avatar,
      subComments: mergeComments(old.subComments ?? [], comment.subComments ?? []),
    } : comment);
  }
  return [...merged.values()];
}
