-- 万载活动公告（docs/文旅活动公告试编.md）。仅新增表和索引，不导入样稿。
-- 生产：npx wrangler d1 execute whizzzest --remote --file scripts/migrations/010-20261126-activity-notices.sql
-- 本地：npx wrangler d1 execute whizzzest --local --file scripts/migrations/010-20261126-activity-notices.sql
-- 主站和后台须指向同一个本地 D1。
-- 执行记录：2026-11-26 隔离本地 D1 已执行，2026-11-27 生产已核验。

CREATE TABLE IF NOT EXISTS activity_notices (
  id TEXT PRIMARY KEY NOT NULL,
  draft TEXT NOT NULL CHECK (json_valid(draft)),
  published TEXT CHECK (published IS NULL OR json_valid(published)),
  revision INTEGER NOT NULL DEFAULT 1,
  published_revision INTEGER,
  public_state TEXT CHECK (public_state IN ('scheduled', 'rescheduled', 'postponed', 'cancelled')),
  public_start INTEGER,
  public_until INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_notices_public
  ON activity_notices(public_state, public_until, public_start) WHERE published IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_notices_updated ON activity_notices(updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS activity_notice_history (
  notice_id TEXT NOT NULL REFERENCES activity_notices(id),
  revision INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('publish', 'withdraw')),
  actor_uid INTEGER NOT NULL,
  content TEXT NOT NULL CHECK (json_valid(content)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (notice_id, revision)
);
