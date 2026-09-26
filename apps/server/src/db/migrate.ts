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
CREATE UNIQUE INDEX IF NOT EXISTS collected_notes_user_note ON collected_notes(user_id, note_id);
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
`;

export async function migrate(db: Db) {
  // drizzle 的 execute 走底层驱动；pglite/node-postgres 都支持单字符串多语句？pg 驱动默认不允许。
  const stmts = DDL.split(";").map((s) => s.trim()).filter(Boolean);
  const { sql } = await import("drizzle-orm");
  for (const stmt of stmts) {
    await db.execute(sql.raw(stmt));
  }
}
