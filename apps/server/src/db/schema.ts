import { boolean, integer, jsonb, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
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
  data: jsonb("data").$type<{
    stats: {
      totalNotes: number;
      totalLikes: number;
      totalCollects: number;
      totalComments: number;
      totalShares: number;
      avgEngagement: number;
      topNotes: Array<{
        noteId: string;
        title: string;
        likes: number;
        collects: number;
        comments: number;
        shares: number;
        engagement: number;
      }>;
      topTags: Array<{ tag: string; count: number }>;
    };
    insight: {
      summary: string;
      topNotes: Array<{ title: string; why: string }>;
      patterns: string[];
      opportunities: string[];
      actions: string[];
    } | null;
  }>().notNull(),
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
  rawJson: jsonb("raw_json"),
  savedAt: timestamp("saved_at").defaultNow().notNull(),
});

export const drafts = pgTable("drafts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  collectedNoteId: integer("collected_note_id").references(() => collectedNotes.id, { onDelete: "set null" }),
  title: varchar("title", { length: 512 }).notNull().default(""),
  content: text("content").notNull().default(""),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  images: jsonb("images").$type<Array<{ url: string }>>().notNull().default([]),
  status: varchar("status", { length: 32 }).notNull().default("draft"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const publishJobs = pgTable("publish_jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  draftId: integer("draft_id").notNull().references(() => drafts.id, { onDelete: "cascade" }),
  accountId: integer("account_id").notNull().references(() => hostedAccounts.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  scheduledAt: timestamp("scheduled_at"),
  visibility: varchar("visibility", { length: 32 }).notNull().default("public"),
  claimedBy: varchar("claimed_by", { length: 128 }),
  error: text("error"),
  resultUrl: text("result_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  type: varchar("type", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
});
