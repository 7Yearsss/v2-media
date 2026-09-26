import type { Db } from "./index";

/** MVP：幂等 DDL，启动时执行。后续结构变更换 drizzle-kit 迁移流。 */
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS hosted_accounts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  platform varchar(32) NOT NULL DEFAULT 'xhs',
  sub_type varchar(32) NOT NULL DEFAULT 'pc',
  xhs_user_id varchar(128) NOT NULL DEFAULT '',
  nickname varchar(128) NOT NULL DEFAULT '',
  avatar text NOT NULL DEFAULT '',
  status varchar(32) NOT NULL DEFAULT 'unknown',
  status_message text NOT NULL DEFAULT '',
  last_seen_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS collected_notes (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  note_id varchar(128) NOT NULL,
  type varchar(16) NOT NULL DEFAULT 'image',
  title varchar(512) NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  author_name varchar(128) NOT NULL DEFAULT '',
  author_id varchar(128) NOT NULL DEFAULT '',
  cover text NOT NULL DEFAULT '',
  images jsonb NOT NULL DEFAULT '[]',
  video_url text,
  likes integer NOT NULL DEFAULT 0,
  collects integer NOT NULL DEFAULT 0,
  comments integer NOT NULL DEFAULT 0,
  shares integer NOT NULL DEFAULT 0,
  tags jsonb NOT NULL DEFAULT '[]',
  comments_data jsonb NOT NULL DEFAULT '[]',
  source varchar(32) NOT NULL DEFAULT 'search',
  source_url text NOT NULL DEFAULT '',
  raw_json jsonb,
  saved_at timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS collections (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  name varchar(64) NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS collections_user_name ON collections(user_id, name);
ALTER TABLE collected_notes ADD COLUMN IF NOT EXISTS collection_id integer;
ALTER TABLE collected_notes DROP CONSTRAINT IF EXISTS collected_notes_collection_id_fkey;
ALTER TABLE collected_notes ADD CONSTRAINT collected_notes_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS collected_notes_user_note ON collected_notes(user_id, note_id);
ALTER TABLE collected_notes ADD COLUMN IF NOT EXISTS title_fallback boolean NOT NULL DEFAULT false;
ALTER TABLE collected_notes ADD COLUMN IF NOT EXISTS has_detail boolean NOT NULL DEFAULT false;
ALTER TABLE collected_notes ADD COLUMN IF NOT EXISTS source_keyword varchar(255) NOT NULL DEFAULT '';
ALTER TABLE collected_notes ADD COLUMN IF NOT EXISTS published_at timestamp;
ALTER TABLE collected_notes ADD COLUMN IF NOT EXISTS ip_location varchar(64) NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS collection_analyses (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  collection_id integer NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  note_count integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}',
  report text NOT NULL DEFAULT '',
  created_at timestamp DEFAULT now() NOT NULL
);
ALTER TABLE collection_analyses ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS collection_analyses_col ON collection_analyses(user_id, collection_id);
CREATE TABLE IF NOT EXISTS drafts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  collected_note_id integer REFERENCES collected_notes(id),
  title varchar(512) NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]',
  images jsonb NOT NULL DEFAULT '[]',
  status varchar(32) NOT NULL DEFAULT 'draft',
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS publish_jobs (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  draft_id integer NOT NULL REFERENCES drafts(id),
  account_id integer NOT NULL REFERENCES hosted_accounts(id),
  status varchar(32) NOT NULL DEFAULT 'pending',
  scheduled_at timestamp,
  visibility varchar(32) NOT NULL DEFAULT 'public',
  claimed_by varchar(128),
  error text,
  result_url text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  type varchar(64) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status varchar(32) NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamp DEFAULT now() NOT NULL,
  finished_at timestamp
);
-- 幂等约束修补：删采集笔记保留草稿（SET NULL），删草稿/账号联动删除发布任务（CASCADE）
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_collected_note_id_fkey;
ALTER TABLE drafts ADD CONSTRAINT drafts_collected_note_id_fkey FOREIGN KEY (collected_note_id) REFERENCES collected_notes(id) ON DELETE SET NULL;
ALTER TABLE publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_draft_id_fkey;
ALTER TABLE publish_jobs ADD CONSTRAINT publish_jobs_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE;
ALTER TABLE publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_account_id_fkey;
ALTER TABLE publish_jobs ADD CONSTRAINT publish_jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES hosted_accounts(id) ON DELETE CASCADE;
`;

export async function migrate(db: Db) {
  // drizzle 的 execute 走底层驱动；pglite/node-postgres 都支持单字符串多语句？pg 驱动默认不允许。
  const stmts = DDL.split(";").map((s) => s.trim()).filter(Boolean);
  const { sql } = await import("drizzle-orm");
  for (const stmt of stmts) {
    await db.execute(sql.raw(stmt));
  }
}
