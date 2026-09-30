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
  /** 已采到的评论明细；comments 是站点显示的评论数量。 */
  commentsData?: NoteComment[];
}

export interface NoteComment {
  avatar?: string;
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
  authorAvatar?: string;
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
  /** 是否收过详情页数据；false 时收藏/评论/分享的 0 只是"未采到"。 */
  hasDetail?: boolean;
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

/** GET /api/notes/summary：当前筛选范围的摘要。 */
export interface NotesSummary {
  notes: number;
  likes: number;
  collects: number;
  comments: number;
  /** 其中收过详情的笔记数（收藏/评论合计只覆盖这部分）。 */
  withDetail: number;
  topTags: Array<{ tag: string; notes: number }>;
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

/** 读回对账结论：插件回创作者中心核对已发列表后的结果。 */
export type PublishOutcome =
  | "verified"        // 在已发列表里按标题+时间窗匹配到 → 拿到真实 noteId
  | "unverified"      // 列表读到了但没匹配上（可能还在审、或标题被改）
  | "login_required"  // 创作中心未登录/登录过期
  | "readback_error"; // 其他读回失败（超时/页面结构变了）

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
  /** 读回对账结论（done 后由插件回采回填）。 */
  outcome?: PublishOutcome;
  /** 读回确认的小红书 note_id。 */
  noteId?: string;
  /** 对账通过时间。 */
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 已发笔记指标快照（一条笔记的一次回采）。 */
export interface NoteMetrics {
  id: number;
  publishJobId?: number;
  noteId: string;
  noteUrl?: string;
  capturedAt: string;
  views?: number;
  likes?: number;
  collects?: number;
  comments?: number;
  shares?: number;
  /** 曝光量——创作中心才有；www 侧回采拿不到。 */
  exposure?: number;
  /** 流量来源拆解等原始字段。 */
  extra?: Record<string, unknown>;
}

/** 账号概览快照（粉丝/获赞/发文数的时序）。 */
export interface AccountSnapshot {
  id: number;
  accountId: number;
  capturedAt: string;
  followers?: number;
  likesTotal?: number;
  notesCount?: number;
  extra?: Record<string, unknown>;
}
/** Content library ordering; the server applies it before cursor pagination. */
export type NoteSortField = "id" | "likes" | "collects" | "comments" | "savedAt" | "publishedAt";
export type NoteSortDirection = "asc" | "desc";
