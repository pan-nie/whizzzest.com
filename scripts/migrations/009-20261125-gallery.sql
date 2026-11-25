-- 万载图库（docs/自摄图库.md）。仅新增图库表及索引。
-- 远端：npx wrangler d1 execute whizzzest --remote --file scripts/migrations/009-20261125-gallery.sql
-- 本地：同一命令使用 --local，并让主站与后台共享本地 D1 和 R2。
-- 执行记录：2026-11-25 隔离环境和生产均已执行，生产已核对表与索引。

CREATE TABLE IF NOT EXISTS gallery_photos (
  id TEXT PRIMARY KEY NOT NULL,
  image_token TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 2048),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 2048),
  photographer TEXT NOT NULL,
  taken_on TEXT NOT NULL DEFAULT '',
  title_zh TEXT NOT NULL,
  location_zh TEXT NOT NULL,
  alt_zh TEXT NOT NULL,
  license_zh TEXT NOT NULL,
  title_en TEXT NOT NULL DEFAULT '',
  location_en TEXT NOT NULL DEFAULT '',
  alt_en TEXT NOT NULL DEFAULT '',
  license_en TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden', 'deleted')),
  sort INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gallery_photos_status_order
  ON gallery_photos(status, sort, created_at DESC, id);
