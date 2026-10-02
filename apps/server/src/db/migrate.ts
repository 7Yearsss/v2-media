import type { Db } from "./index";

/** MVP：幂等 DDL，启动时执行。后续结构变更换 drizzle-kit 迁移流。 */
const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan varchar(16) NOT NULL DEFAULT 'free';
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
ALTER TABLE collection_analyses ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'done';
ALTER TABLE collection_analyses ADD COLUMN IF NOT EXISTS error text;
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
  outcome varchar(32),
  note_id varchar(128),
  verified_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS outcome varchar(32);
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS note_id varchar(128);
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS verified_at timestamp;
CREATE TABLE IF NOT EXISTS jobs (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  type varchar(64) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status varchar(32) NOT NULL DEFAULT 'pending',
  due_at timestamp,
  claimed_by varchar(128),
  claimed_at timestamp,
  error text,
  created_at timestamp DEFAULT now() NOT NULL,
  finished_at timestamp
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS due_at timestamp;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_by varchar(128);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_at timestamp;
CREATE INDEX IF NOT EXISTS jobs_status_due ON jobs(status, due_at);
-- 幂等约束修补：删采集笔记保留草稿（SET NULL），删草稿/账号联动删除发布任务（CASCADE）
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_collected_note_id_fkey;
ALTER TABLE drafts ADD CONSTRAINT drafts_collected_note_id_fkey FOREIGN KEY (collected_note_id) REFERENCES collected_notes(id) ON DELETE SET NULL;
ALTER TABLE publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_draft_id_fkey;
ALTER TABLE publish_jobs ADD CONSTRAINT publish_jobs_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE;
ALTER TABLE publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_account_id_fkey;
ALTER TABLE publish_jobs ADD CONSTRAINT publish_jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES hosted_accounts(id) ON DELETE CASCADE;
CREATE TABLE IF NOT EXISTS topics (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  title varchar(512) NOT NULL DEFAULT '',
  angle text NOT NULL DEFAULT '',
  source_type varchar(32) NOT NULL DEFAULT 'manual',
  collection_id integer,
  source_note_id integer,
  account_id integer,
  status varchar(32) NOT NULL DEFAULT 'idea',
  score integer,
  score_detail jsonb,
  planned_at timestamp,
  draft_id integer,
  publish_job_id integer,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_collection_id_fkey;
ALTER TABLE topics ADD CONSTRAINT topics_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE SET NULL;
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_source_note_id_fkey;
ALTER TABLE topics ADD CONSTRAINT topics_source_note_id_fkey FOREIGN KEY (source_note_id) REFERENCES collected_notes(id) ON DELETE SET NULL;
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_account_id_fkey;
ALTER TABLE topics ADD CONSTRAINT topics_account_id_fkey FOREIGN KEY (account_id) REFERENCES hosted_accounts(id) ON DELETE SET NULL;
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_draft_id_fkey;
ALTER TABLE topics ADD CONSTRAINT topics_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE SET NULL;
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_publish_job_id_fkey;
ALTER TABLE topics ADD CONSTRAINT topics_publish_job_id_fkey FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS topics_user_status ON topics(user_id, status);

-- 归因底座（切片②）：已发笔记指标时序 + 账号概览快照
CREATE TABLE IF NOT EXISTS note_metrics (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  publish_job_id integer,
  note_id varchar(128) NOT NULL DEFAULT '',
  note_url text,
  captured_at timestamp DEFAULT now() NOT NULL,
  views integer,
  likes integer,
  collects integer,
  comments integer,
  shares integer,
  exposure integer,
  extra jsonb
);
ALTER TABLE note_metrics DROP CONSTRAINT IF EXISTS note_metrics_publish_job_id_fkey;
ALTER TABLE note_metrics ADD CONSTRAINT note_metrics_publish_job_id_fkey FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS note_metrics_user_note ON note_metrics(user_id, note_id, captured_at);

CREATE TABLE IF NOT EXISTS account_snapshots (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  account_id integer,
  captured_at timestamp DEFAULT now() NOT NULL,
  followers integer,
  likes_total integer,
  notes_count integer,
  extra jsonb
);
ALTER TABLE account_snapshots DROP CONSTRAINT IF EXISTS account_snapshots_account_id_fkey;
ALTER TABLE account_snapshots ADD CONSTRAINT account_snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES hosted_accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS account_snapshots_user_account ON account_snapshots(user_id, account_id, captured_at);
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS images_version integer NOT NULL DEFAULT 0;
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS draft_snapshot jsonb;
CREATE TABLE IF NOT EXISTS media_assets (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  draft_id integer NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  upload_id varchar(36) NOT NULL,
  filename varchar(255) NOT NULL,
  source_file varchar(64) NOT NULL,
  source_hash varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  key text,
  url text,
  width integer,
  height integer,
  error text,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS media_assets_user_upload ON media_assets(user_id, upload_id);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS kind varchar(16) NOT NULL DEFAULT 'upload';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS text_version integer NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS generation_state varchar(16) NOT NULL DEFAULT 'idle';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS generation_revision integer NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS generation_error text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS generation_warnings jsonb NOT NULL DEFAULT '[]';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cover_spec jsonb;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cover_revision integer NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cover_state varchar(16) NOT NULL DEFAULT 'idle';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cover_error text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cover_asset_id integer;
ALTER TABLE hosted_accounts ADD COLUMN IF NOT EXISTS positioning text NOT NULL DEFAULT '';
ALTER TABLE hosted_accounts ADD COLUMN IF NOT EXISTS style_notes text NOT NULL DEFAULT '';
ALTER TABLE hosted_accounts ADD COLUMN IF NOT EXISTS redlines text NOT NULL DEFAULT '';
ALTER TABLE hosted_accounts ADD COLUMN IF NOT EXISTS persona_version integer NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS account_id integer REFERENCES hosted_accounts(id) ON DELETE SET NULL;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS persona_snapshot jsonb;
ALTER TABLE topics ADD COLUMN IF NOT EXISTS persona_snapshot jsonb;
ALTER TABLE publish_jobs ADD COLUMN IF NOT EXISTS persona_snapshot jsonb;
`;

export async function migrate(db: Db) {
  // drizzle 的 execute 走底层驱动；pglite/node-postgres 都支持单字符串多语句？pg 驱动默认不允许。
  const stmts = DDL.split(";").map((s) => s.trim()).filter(Boolean);
  const { sql } = await import("drizzle-orm");
  await db.transaction(async tx => {
    const before = await tx.execute(sql`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'drafts' AND column_name = 'account_id'
    ) AS present`) as { rows: Array<{ present: boolean }> };
    for (const stmt of stmts) await tx.execute(sql.raw(stmt));
    // Backfill once when adding the writing-account field. Later explicit "通用风格" stays null.
    if (!before.rows[0]?.present) await tx.execute(sql`
      UPDATE drafts d SET account_id = t.account_id
      FROM (
        SELECT DISTINCT ON (draft_id, user_id) draft_id, user_id, account_id
        FROM topics WHERE draft_id IS NOT NULL AND account_id IS NOT NULL
        ORDER BY draft_id, user_id, updated_at DESC, id DESC
      ) t WHERE d.id = t.draft_id AND d.user_id = t.user_id AND d.account_id IS NULL
    `);
  });
}
