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

/** 采集库分析的确定性统计（服务端计算，不经 AI）。 */
export interface CollectionAnalysisStats {
  totalNotes: number;
  totalLikes: number;
  totalCollects: number;
  totalComments: number;
  totalShares: number;
  avgEngagement: number;
  /** 互动量 top 笔记榜。 */
  topNotes: Array<{
    noteId: string;
    title: string;
    likes: number;
    collects: number;
    comments: number;
    shares: number;
    engagement: number;
  }>;
  /** 高频标签 top。 */
  topTags: Array<{ tag: string; count: number }>;
  /** 数据覆盖：多少篇进过详情页（藏/评/转/正文只有详情页才采得到）。 */
  coverage?: { withDetail: number; total: number };
}

/** AI 对库内内容产出的结构化洞察（JSON 解析失败时为 null，看 report）。 */
export interface CollectionInsight {
  /** 一句话结论。 */
  summary: string;
  /** AI 挑出的爆款及原因。 */
  topNotes: Array<{ title: string; why: string }>;
  /** 共性规律。 */
  patterns: string[];
  /** 机会点。 */
  opportunities: string[];
  /** 行动建议。 */
  actions: string[];
}

/** AI 分析结果：对一个采集库跑出的一轮分析快照。 */
export interface CollectionAnalysis {
  id: number;
  collectionId: number;
  /** 本轮分析覆盖的笔记数。 */
  noteCount: number;
  data: { stats: CollectionAnalysisStats; insight: CollectionInsight | null };
  /** AI 原文（结构化失败时的兜底）。 */
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
  /** 搜索采集时带的搜索词（热度归因）。 */
  sourceKeyword?: string;
  /** 笔记发布时间（ISO；详情页才有）。 */
  publishedAt?: string | null;
  /** 作者 IP 属地（详情页才有）。 */
  ipLocation?: string;
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

/** 选题池条目（策划层）：一条"想写/计划写"的内容方向。 */
export type TopicStatus =
  | "idea" // 想法
  | "planned" // 已排期（有 plannedAt）
  | "drafted" // 已转草稿
  | "published" // 已发布
  | "archived"; // 归档不做

export type TopicSourceType =
  | "manual" // 手填
  | "collection" // 采集库分析产出
  | "note" // 单篇笔记标记而来
  | "ai"; // AI 生成

/**
 * 选题七维评分明细（各 1-10）。cost/risk 为反向分——越高越省事/越安全；
 * 口径与 docs/planning-attribution-design.md 一致（借 Easel scoring-dimensions）。
 */
export interface TopicScoreDetail {
  /** 流量潜力（痛感强度+话题热度+搜索需求）。 */
  traffic?: number;
  /** 账号匹配（与定位/受众契合度）。 */
  fit?: number;
  /** 竞争差异化（高分=竞争低/有空白角度）。 */
  diff?: number;
  /** 变现潜力。 */
  monetization?: number;
  /** 时效价值（高分=常青长尾）。 */
  evergreen?: number;
  /** 制作成本（反向：高分=低成本易执行）。 */
  cost?: number;
  /** 合规风险（反向：高分=低风险）。 */
  risk?: number;
}

export interface Topic {
  id: number;
  title: string;
  /** 切入角度/要点说明。 */
  angle: string;
  sourceType: TopicSourceType;
  collectionId?: number;
  sourceNoteId?: number;
  accountId?: number;
  status: TopicStatus;
  /** AI 综合分 0-100；未评分为 undefined。 */
  score?: number;
  scoreDetail?: TopicScoreDetail;
  /** 计划发布时间。 */
  plannedAt?: string;
  draftId?: number;
  publishJobId?: number;
  createdAt: string;
  updatedAt: string;
  /** 列表联查补充字段（非表列）：来源采集库名。 */
  collectionName?: string;
  /** 列表联查补充字段：目标账号昵称。 */
  accountNickname?: string;
  /** 列表联查补充字段：来源笔记标题。 */
  sourceNoteTitle?: string;
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
