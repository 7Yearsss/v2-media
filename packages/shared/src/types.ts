/** 归一化的平台无关类型 —— 插件 / 服务端 / 工作台三端共享。 */

export type NoteType = "image" | "video";

/** 列表/搜索流里的笔记卡片（已归一化）。 */
export interface NoteCard {
  noteId: string;
  xsecToken: string;
  type: NoteType;
  title: string;
  desc: string;
  author: { userId: string; nickname: string; avatar: string };
  cover: string;
  likes: number;
  collects: number;
  comments: number;
  shares: number;
  /** 详情页链接（含 xsec_token）。 */
  url: string;
  /** 本条数据来自哪个采集场景。 */
  source: CollectSource;
}

export type CollectSource =
  | "homefeed"
  | "search"
  | "user_posted"
  | "collect_page"
  | "like_page"
  | "detail";

export interface NoteImage {
  url: string;
  width?: number;
  height?: number;
}

export interface NoteDetail extends Omit<NoteCard, "source"> {
  content: string;
  tags: string[];
  images: NoteImage[];
  videoUrl?: string;
  publishedAt?: string;
  ipLocation?: string;
}

export interface NoteComment {
  commentId: string;
  userName: string;
  userId?: string;
  content: string;
  likes: number;
  subComments?: NoteComment[];
}

/** 采集分组：一批笔记归入的库（工作台按库筛选分析）。 */
export interface Collection {
  id: number;
  name: string;
  noteCount: number;
  createdAt: string;
}

/** AI 分析结果：对一个采集库跑出的爆款分析报告。 */
export interface CollectionAnalysis {
  id: number;
  collectionId: number;
  /** 本轮分析覆盖的笔记数。 */
  noteCount: number;
  /** markdown 格式报告全文。 */
  report: string;
  createdAt: string;
}

/** 插件嗅探到的一批笔记（ingest 请求的载荷）。 */
export interface CollectBatch {
  source: CollectSource;
  /** 页面上下文信息：搜索词 / 作者主页等。 */
  context?: { keyword?: string; authorId?: string; pageUrl?: string };
  /** 目标采集库 id：number=该库；null=显式不分组；缺省=老客户端不动原分组。 */
  collectionId?: number | null;
  items: NoteCard[];
  /** 详情页采集时附带的完整正文。 */
  details?: NoteDetail[];
}

/** 托管账号：插件探测到的已登录小红书账号。 */
export interface HostedAccount {
  id: number;
  platform: "xhs";
  subType: "pc" | "creator";
  xhsUserId: string;
  nickname: string;
  avatar: string;
  /** online=插件最近心跳正常 / stale=心跳超时 / expired=登录态失效 */
  status: "online" | "stale" | "expired" | "unknown";
  statusMessage: string;
  lastSeenAt: string;
  createdAt: string;
}

/** 服务端存的内容库条目。 */
export interface CollectedNote {
  id: number;
  noteId: string;
  type: NoteType;
  title: string;
  content: string;
  authorName: string;
  authorId: string;
  cover: string;
  images: NoteImage[];
  videoUrl?: string;
  likes: number;
  collects: number;
  comments: number;
  shares: number;
  tags: string[];
  source: CollectSource;
  sourceUrl: string;
  savedAt: string;
}

export interface Draft {
  id: number;
  collectedNoteId?: number;
  title: string;
  content: string;
  tags: string[];
  images: NoteImage[];
  status: "draft" | "ready" | "published";
  updatedAt: string;
}

export type PublishJobStatus =
  | "pending"
  | "claimed"
  | "running"
  | "done"
  | "failed"
  | "canceled";

export interface PublishJob {
  id: number;
  draftId: number;
  accountId: number;
  status: PublishJobStatus;
  /** 立即发布 or 定时（unix ms，由创作者平台定时发布支持）。 */
  scheduledAt?: number;
  visibility: "public" | "private" | "friends";
  error?: string;
  resultUrl?: string;
  createdAt: string;
  updatedAt: string;
}
