-- 公告采集待审队列与最近一次执行状态。每日任务只写采集表。
-- npx wrangler d1 execute whizzzest --remote --file scripts/migrations/011-20261127-activity-notice-collection.sql
-- 本地演练使用相同命令的 --local 选项。
-- 执行记录：2026-11-27 本地测试通过，生产两张表和两个索引均已核验。

CREATE TABLE IF NOT EXISTS activity_notice_inbox (
  source_url TEXT PRIMARY KEY NOT NULL,
  source_title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_date TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  handled_fingerprint TEXT,
  notice_id TEXT REFERENCES activity_notices(id),
  is_change INTEGER NOT NULL CHECK (is_change IN (0, 1)),
  detected_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_notice_inbox_pending
  ON activity_notice_inbox(detected_at DESC, source_url) WHERE handled_fingerprint IS NOT fingerprint;
CREATE INDEX IF NOT EXISTS idx_activity_notice_inbox_fingerprint ON activity_notice_inbox(fingerprint);

CREATE TABLE IF NOT EXISTS activity_notice_collection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  changed INTEGER NOT NULL,
  failed INTEGER NOT NULL
);
