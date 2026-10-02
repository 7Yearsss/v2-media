import type { AccountPersonaSnapshot, AnalysisProgress, AnalysisVisualItem, CollectionAnalysisStats, CollectionInsight, CoverSpec, NoteImage, PlanningSnapshot, PostmortemEvidence, PostmortemInsight, CollectionTaskRules, NoteCard } from "@v2media/shared";
import { boolean, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  /** 会员等级：free=压缩存储 / pro=原画质。媒体存储策略按它分档。 */
  plan: varchar("plan", { length: 16 }).notNull().default("free"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const hostedAccounts = pgTable("hosted_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  platform: varchar("platform", { length: 32 }).notNull().default("xhs"),
  subType: varchar("sub_type", { length: 32 }).notNull().default("pc"),
  xhsUserId: varchar("xhs_user_id", { length: 128 }).notNull().default(""),
  nickname: varchar("nickname", { length: 128 }).notNull().default(""),
  avatar: text("avatar").notNull().default(""),
  status: varchar("status", { length: 32 }).notNull().default("unknown"),
  statusMessage: text("status_message").notNull().default(""),
  lastSeenAt: timestamp("last_seen_at"),
  positioning: text("positioning").notNull().default(""),
  styleNotes: text("style_notes").notNull().default(""),
  redlines: text("redlines").notNull().default(""),
  personaVersion: integer("persona_version").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** 采集分组：一批采集归到一个库（如「健身」），便于按主题分析。 */
export const collections = pgTable("collections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  name: varchar("name", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/** AI 分析结果：对某个采集库的一轮分析快照（库被删时随库删除）。 */
export const collectionAnalyses = pgTable("collection_analyses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  collectionId: integer("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  noteCount: integer("note_count").notNull().default(0),
  /** 结构化分析：{stats: 服务端算的确定性统计, insight: AI 产出的 JSON 洞察}。 */
  data: jsonb("data")
    .$type<{
      stats: CollectionAnalysisStats;
      insight: CollectionInsight | null;
      positioning?: string;
      persona?: AccountPersonaSnapshot | null;
      visual?: AnalysisVisualItem[];
      progress?: AnalysisProgress;
    }>()
    .notNull(),
  /** running=后台还在跑 / done / failed。老数据默认 done。 */
  status: varchar("status", { length: 16 }).notNull().default("done"),
  error: text("error"),
  /** AI 原始文本（JSON 解析失败时的兜底展示）。 */
  report: text("report").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const collectedNotes = pgTable("collected_notes", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  collectionId: integer("collection_id").references(() => collections.id, { onDelete: "set null" }),
  noteId: varchar("note_id", { length: 128 }).notNull(),
  type: varchar("type", { length: 16 }).notNull().default("image"),
  title: varchar("title", { length: 512 }).notNull().default(""),
  /** 标题是兜底生成的（正文节选/无标题占位），真标题到来时可被替换。 */
  titleFallback: boolean("title_fallback").notNull().default(false),
  /** 是否收过详情页数据（藏/评/转/正文/标签只有详情页才有）。 */
  hasDetail: boolean("has_detail").notNull().default(false),
  content: text("content").notNull().default(""),
  authorName: varchar("author_name", { length: 128 }).notNull().default(""),
  authorId: varchar("author_id", { length: 128 }).notNull().default(""),
  cover: text("cover").notNull().default(""),
  images: jsonb("images").$type<Array<{ url: string; width?: number; height?: number }>>().notNull().default([]),
  videoUrl: text("video_url"),
  likes: integer("likes").notNull().default(0),
  collects: integer("collects").notNull().default(0),
  comments: integer("comments").notNull().default(0),
  shares: integer("shares").notNull().default(0),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  commentsData: jsonb("comments_data").$type<unknown[]>().notNull().default([]),
  source: varchar("source", { length: 32 }).notNull().default("search"),
  sourceUrl: text("source_url").notNull().default(""),
  /** 搜索场景采进来时的搜索词（热度归因用）。 */
  sourceKeyword: varchar("source_keyword", { length: 255 }).notNull().default(""),
  /** 笔记发布时间（详情页 time 字段，毫秒时间戳转存）。 */
  publishedAt: timestamp("published_at"),
  /** 作者 IP 属地（详情页才有）。 */
  ipLocation: varchar("ip_location", { length: 64 }).notNull().default(""),
  rawJson: jsonb("raw_json"),
  savedAt: timestamp("saved_at").defaultNow().notNull(),
});

export const drafts = pgTable("drafts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  collectedNoteId: integer("collected_note_id").references(() => collectedNotes.id, { onDelete: "set null" }),
  accountId: integer("account_id").references(() => hostedAccounts.id, { onDelete: "set null" }),
  personaSnapshot: jsonb("persona_snapshot").$type<AccountPersonaSnapshot>(),
  title: varchar("title", { length: 512 }).notNull().default(""),
  content: text("content").notNull().default(""),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  images: jsonb("images").$type<NoteImage[]>().notNull().default([]),
  imagesVersion: integer("images_version").notNull().default(0),
  textVersion: integer("text_version").notNull().default(0),
  generationState: varchar("generation_state", { length: 16 }).notNull().default("idle"),
  generationRevision: integer("generation_revision").notNull().default(0),
  generationError: text("generation_error"),
  generationWarnings: jsonb("generation_warnings").$type<Array<{ word: string; kind: string; count: number }>>().notNull().default([]),
  coverSpec: jsonb("cover_spec").$type<CoverSpec>(),
  coverRevision: integer("cover_revision").notNull().default(0),
  coverState: varchar("cover_state", { length: 16 }).notNull().default("idle"),
  coverError: text("cover_error"),
  coverAssetId: integer("cover_asset_id"),
  status: varchar("status", { length: 32 }).notNull().default("draft"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const publishJobs = pgTable("publish_jobs", {
  planningSnapshot: jsonb("planning_snapshot").$type<PlanningSnapshot>(),
  coverSnapshot: jsonb("cover_snapshot").$type<CoverSpec>(),
  publishedAt: timestamp("published_at"),
  reportedAt: timestamp("reported_at"),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  draftId: integer("draft_id").notNull().references(() => drafts.id, { onDelete: "cascade" }),
  accountId: integer("account_id").notNull().references(() => hostedAccounts.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  scheduledAt: timestamp("scheduled_at"),
  visibility: varchar("visibility", { length: 32 }).notNull().default("public"),
  personaSnapshot: jsonb("persona_snapshot").$type<AccountPersonaSnapshot>(),
  draftSnapshot: jsonb("draft_snapshot").$type<{ title: string; content: string; tags: string[]; images: NoteImage[] }>(),
  claimedBy: varchar("claimed_by", { length: 128 }),
  leaseId: varchar("lease_id", { length: 36 }),
  attempt: integer("attempt").notNull().default(0),
  leaseUntil: timestamp("lease_until"),
  error: text("error"),
  resultUrl: text("result_url"),
  /** 读回对账结论：verified | unverified | login_required | readback_error */
  outcome: varchar("outcome", { length: 32 }),
  /** 读回确认的小红书 note_id（归因关联点）。 */
  noteId: varchar("note_id", { length: 128 }),
  verifiedAt: timestamp("verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** 元数据留库，源文件持久暂存到 uploads，R2 完成后删除源文件。 */
export const mediaAssets = pgTable("media_assets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  draftId: integer("draft_id").notNull().references(() => drafts.id, { onDelete: "cascade" }),
  uploadId: varchar("upload_id", { length: 36 }).notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  kind: varchar("kind", { length: 16 }).notNull().default("upload"),
  sourceFile: varchar("source_file", { length: 64 }).notNull(),
  sourceHash: varchar("source_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("queued"),
  key: text("key"),
  url: text("url"),
  width: integer("width"),
  height: integer("height"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [uniqueIndex("media_assets_user_upload").on(t.userId, t.uploadId)]);

/** 选题池（策划层）：一条"想写/计划写"的内容方向，串联 draft → publish_job。 */
export const topics = pgTable("topics", {
  scoreMethod: text("score_method"),
  scoreModel: text("score_model"),
  scoredAt: timestamp("scored_at"),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  personaSnapshot: jsonb("persona_snapshot").$type<AccountPersonaSnapshot>(),
  title: varchar("title", { length: 512 }).notNull().default(""),
  /** 切入角度/要点说明。 */
  angle: text("angle").notNull().default(""),
  /** manual | collection | note | ai */
  sourceType: varchar("source_type", { length: 32 }).notNull().default("manual"),
  collectionId: integer("collection_id").references(() => collections.id, { onDelete: "set null" }),
  sourceNoteId: integer("source_note_id").references(() => collectedNotes.id, { onDelete: "set null" }),
  accountId: integer("account_id").references(() => hostedAccounts.id, { onDelete: "set null" }),
  /** idea | planned | drafted | published | archived */
  status: varchar("status", { length: 32 }).notNull().default("idea"),
  /** AI 综合分 0-100；未评分 NULL。 */
  score: integer("score"),
  /** 七维明细，见 shared TopicScoreDetail。 */
  scoreDetail: jsonb("score_detail").$type<Record<string, number>>(),
  plannedAt: timestamp("planned_at"),
  draftId: integer("draft_id").references(() => drafts.id, { onDelete: "set null" }),
  publishJobId: integer("publish_job_id").references(() => publishJobs.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  type: varchar("type", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  /** 到期时间——插件只领 dueAt<=now 的（归因任务按 T+1h/1d/7d 排期）。 */
  dueAt: timestamp("due_at"),
  /** 认领标识（插件 SW id），防多浏览器重复执行。 */
  claimedBy: varchar("claimed_by", { length: 128 }),
  /** 认领时间；浏览器归因执行以 leaseUntil 为有效期。 */
  claimedAt: timestamp("claimed_at"),
  leaseId: varchar("lease_id", { length: 36 }),
  attempt: integer("attempt").notNull().default(0),
  leaseUntil: timestamp("lease_until"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});

/** 已发笔记指标快照：一条笔记的一次回采行（时序对比看曲线）。 */
export const noteMetrics = pgTable("note_metrics", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  publishJobId: integer("publish_job_id").references(() => publishJobs.id, { onDelete: "set null" }),
  /** 小红书 note_id（读回对账确认）。 */
  noteId: varchar("note_id", { length: 128 }).notNull().default(""),
  noteUrl: text("note_url"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
  views: integer("views"),
  likes: integer("likes"),
  collects: integer("collects"),
  comments: integer("comments"),
  shares: integer("shares"),
  /** 曝光量——创作中心才有；www 侧回采拿不到。 */
  exposure: integer("exposure"),
  /** 流量来源拆解等原始字段。 */
  extra: jsonb("extra").$type<Record<string, unknown>>(),
});

/** 账号概览快照：粉丝/获赞/发文数时序（账号矩阵趋势底座）。 */
export const accountSnapshots = pgTable("account_snapshots", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  accountId: integer("account_id").references(() => hostedAccounts.id, { onDelete: "cascade" }),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
  followers: integer("followers"),
  likesTotal: integer("likes_total"),
  notesCount: integer("notes_count"),
  extra: jsonb("extra").$type<Record<string, unknown>>(),
});

/** Receipts are independent of editable drafts/accounts and retained for replay acknowledgement. */
export const browserExecutionReceipts = pgTable("browser_execution_receipts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  domain: varchar("domain", { length: 16 }).notNull(),
  executionId: integer("execution_id").notNull(),
  receiptId: varchar("receipt_id", { length: 36 }).notNull(),
  bodyHash: varchar("body_hash", { length: 64 }).notNull(),
  ack: jsonb("ack").$type<{ ok: true; rescheduled?: boolean }>().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, t => [uniqueIndex("browser_execution_receipts_user_receipt").on(t.userId, t.receiptId)]);

export const postmortemReports = pgTable("postmortem_reports", {
  engine: varchar("engine", { length: 16 }),
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  publishJobId: integer("publish_job_id").notNull().references(() => publishJobs.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 16 }).notNull().default("queued"),
  model: text("model").notNull(), promptVersion: text("prompt_version").notNull(),
  evidence: jsonb("evidence").$type<PostmortemEvidence>().notNull(),
  insight: jsonb("insight").$type<PostmortemInsight>(), error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(), finishedAt: timestamp("finished_at"),
});

export const collectionTasks = pgTable("collection_tasks", {
  id: serial("id").primaryKey(), userId: integer("user_id").notNull().references(() => users.id),
  collectionId: integer("collection_id").references(() => collections.id, { onDelete: "set null" }),
  collectionName: text("collection_name").notNull(), rules: jsonb("rules").$type<CollectionTaskRules>().notNull(),
  status: varchar("status", { length: 16 }).notNull().default("queued"), revision: integer("revision").notNull().default(0),
  controlRevision: integer("control_revision").notNull().default(0), lastControlAction: varchar("last_control_action", { length: 16 }),
  phase: varchar("phase", { length: 16 }).notNull().default("search"), scrollSteps: integer("scroll_steps").notNull().default(0),
  reason: text("reason"), leaseId: varchar("lease_id", { length: 36 }), claimedBy: varchar("claimed_by", { length: 128 }), leaseUntil: timestamp("lease_until"),
  createdAt: timestamp("created_at").notNull().defaultNow(), updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export const collectionTaskItems = pgTable("collection_task_items", {
  id: serial("id").primaryKey(), taskId: integer("task_id").notNull().references(() => collectionTasks.id, { onDelete: "cascade" }),
  noteId: varchar("note_id", { length: 128 }).notNull(), card: jsonb("card").$type<NoteCard>().notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"), reason: text("reason"),
  collectedNoteId: integer("collected_note_id").references(() => collectedNotes.id, { onDelete: "set null" }), alreadyExisted: boolean("already_existed").notNull().default(false),
  platformComments: integer("platform_comments"), capturedComments: integer("captured_comments").notNull().default(0), capturedReplies: integer("captured_replies").notNull().default(0),
  commentCoverage: varchar("comment_coverage", { length: 16 }).notNull().default("not_requested"),
}, t => [uniqueIndex("collection_task_items_note").on(t.taskId, t.noteId)]);
