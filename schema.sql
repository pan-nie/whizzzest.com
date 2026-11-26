-- 焰境·万载 —— D1 全量图纸（仅供参考，勿直接对线上执行）
-- 变更一律走 scripts/migrations/ 编号迁移（纪律见 scripts/migrations/README.md，docs/全站优化方案.md W2）；
-- 每次迁移合入时同步更新本文件，保持图纸 = 线上最新结构。

-- 官网留言表（联系表单）
-- read_at：后台标记已读的时间（NULL = 未读），由 admin worker 写入（2026-09-06 迁移）
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  message TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  read_at TEXT
);

-- 访客监控（后台「访客分析」数据源，2026-09-06；会话/环境维度 2026-09-06 二期）
-- vid = 第一方匿名 Cookie（HttpOnly，主站 Worker 下发，1 年）
-- sid = 会话 Cookie（30 分钟滑动过期）；pv_id = 单次页面浏览 ID（页面关闭时回报停留时长）
-- 未携带 Cookie 的访问按 IP 归组展示；国家取自 Cloudflare 边缘地理信息
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vid TEXT,
  sid TEXT,
  pv_id TEXT,
  path TEXT NOT NULL,
  referrer TEXT,
  ref_host TEXT,
  kind TEXT,
  country TEXT,
  device TEXT,
  browser TEXT,
  os TEXT,
  lang TEXT,
  ua TEXT,
  ip TEXT,
  is_bot INTEGER DEFAULT 0,
  engage_ms INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_visits_vid ON visits(vid, created_at);
CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at);
CREATE INDEX IF NOT EXISTS idx_visits_sid ON visits(sid);
CREATE INDEX IF NOT EXISTS idx_visits_pvid ON visits(pv_id);
-- 访客治理（2026-09-08，迁移 003）：「排除爬虫 + 时间窗」组合查询走此索引，避免全表过滤
CREATE INDEX IF NOT EXISTS idx_visits_bot_created ON visits(is_bot, created_at);

-- 扫描器异常流量日计数（2026-09-08，迁移 003，docs/访客治理方案.md 阶段二）：
-- 扫描/探测请求不再写 visits 明细，改为「天 × 特征分类」累加，保留宏观可见性
CREATE TABLE IF NOT EXISTS scan_stats (
  date TEXT NOT NULL,                      -- 北京时区日期（与 visits 展示口径一致）
  category TEXT NOT NULL,                  -- scan-path 命中扫描特征路径 | 404 落点不存在路径
  count INTEGER NOT NULL DEFAULT 0,
  last_path TEXT,                          -- 最近一次样本
  last_ua TEXT,
  last_at TEXT,
  PRIMARY KEY (date, category)
);

-- 全站配置（key-value，2026-09-08 迁移 004）：visit_tracking 访客采集总开关（'1' 开 / '0' 关，
-- 后台「访客」页切换，主站 Worker 60s 实例缓存读取）；后续全站级开关/配置统一放这里
CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO site_settings (key, value) VALUES ('visit_tracking', '1');

-- 商户展示与入驻（M1，docs/商户功能方案.md）
-- tier: free 基础卡片 | verified 认证商户 | featured 置顶推荐
-- status: pending 待审核 | approved 已上线 | rejected 已驳回 | expired 已过期
-- paid_until: 付费展示到期日（NULL = 免费期）；slug 为空时审核通过自动生成 m<id>
CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,              -- food|stay|specialty|fireworks|other
  tier TEXT NOT NULL DEFAULT 'free',
  intro TEXT NOT NULL,
  detail TEXT,
  cover TEXT,
  images TEXT,
  address TEXT,
  phone TEXT,
  wechat TEXT,
  hours TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  paid_until TEXT,
  tier_request TEXT,                       -- M3（2026-09-06 增量迁移加入，见 scripts/migrations/）：申请目标等级 verified|featured，NULL = 无待核销申请
  paid_requested_at TEXT,                  -- M3：申请时间（admin 排序/提醒用）
  sort_weight INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_merchants_status ON merchants(status, sort_weight DESC, id DESC);

-- 商户门户账号（M2，merchant.whizzzest.com）：一商户一账号，手机号+密码登录；
-- email（M2.1）：绑定的登录邮箱（可空），绑定后可用「邮箱+验证码」免密登录
-- pass_hash = PBKDF2-SHA256(pass_salt, 10万次)，密码不明文存储
-- phone（2026-09-09 迁移 005）：统一 E.164 存储（如 +8613800138000，docs/手机号国际化方案.md）
CREATE TABLE IF NOT EXISTS merchant_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL UNIQUE REFERENCES merchants(id),
  phone TEXT UNIQUE NOT NULL,              -- E.164（+86…），登录账号（编号计划级核验，不发短信）
  email TEXT,
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mu_email ON merchant_users(email);

-- M3 变现闭环：商户自助申请升级/续费 → 站长核销
-- （tier_request / paid_requested_at 两列为 2026-09-06 增量迁移加入，见 scripts/migrations/）

-- M2.1 邮箱验证码登录（2026-09-06）：发往已绑定邮箱的 6 位验证码
-- code_hash = SHA-256(6位码)，10 分钟有效，≤5 次尝试；purpose 区分 login / bind
-- （merchant_users.email 列与 UNIQUE 索引为 2026-09-06 增量迁移加入，见 scripts/migrations/）
CREATE TABLE IF NOT EXISTS email_login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',   -- login 登录 | bind 绑定邮箱
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 管理后台多账号（2026-09-06）：ADMIN_PASSWORD 仍是主账号「站长」；
-- admin_users 为后台「账号」Tab 自助添加的运营账号，权限与站长相同
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,           -- 2-20 位字母/数字/下划线/连字符
  pass_hash TEXT NOT NULL,                 -- PBKDF2-SHA256(pass_salt, 10万次)
  pass_salt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 万载TV 视频频道（2026-09-06，docs/万载TV方案.md）
-- source: bilibili B站嵌入（bvid）| upload R2 直传（file_key，桶 whizzzest-media，主站 /media/* 代理）
-- cover: R2 键（不带 / 前缀 → /media/…）或站内路径（/assets/img/…）；B站封面有防盗链需后台上传
-- series/episode：短剧剧集聚合（如《一朝相逢便是万载》第 N 集）
-- status: published 上线 | hidden 隐藏；featured：频道页焦点大位
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',  -- drama|fireworks|heritage|food|tourism|other
  source TEXT NOT NULL DEFAULT 'bilibili',
  bvid TEXT,
  file_key TEXT,
  cover TEXT,
  duration INTEGER DEFAULT 0,              -- 秒；上传时浏览器端预读元数据自动带出
  series TEXT,
  episode INTEGER,
  intro TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_videos_pub ON videos(status, category, id DESC);
CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series);

-- 剧集/合集级信息（2026-09-06）：货架「总封面」（竖版海报最佳）；name 与 videos.series 对应
CREATE TABLE IF NOT EXISTS video_series (
  name TEXT PRIMARY KEY,
  cover TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 文库（2026-09-06，docs/文库方案.md）：小说/图文连载，作者投稿 → admin 审核 → 主站 /library/ 上线
-- status: pending 待审 | approved 上线 | rejected 已驳回 | hidden 站长下线；slug 审核通过生成 b<id>
-- 冗余 chapter_count/word_count 在章节变更时重算；views 为作品详情+阅读页浏览合计
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',  -- novel 小说 | story 故事 | essay 随笔 | other 其他
  intro TEXT NOT NULL,
  cover TEXT,                              -- R2 键 book/c-*.jpg（主站 /media/ 代理公开读取）
  author_name TEXT,                        -- 展示笔名（投稿时填，可空）
  writer_id INTEGER,                       -- writer_users.id；admin 后台直建时为 NULL（免审）
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  sort_weight INTEGER NOT NULL DEFAULT 0,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_books_pub ON books(status, sort_weight DESC, updated_at DESC);

-- 章节：body 为分段纯文本（[图] 占位行，渲染时按 images 顺序替换 <figure>）；
-- 章节级审核：已上线作品加新章/改章不影响上架，新章 approved 后才可读；
-- draft = 作者草稿（v1.2）：不进审核队列、读者不可见，不计入作品章节数/字数冗余
CREATE TABLE IF NOT EXISTS book_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id),
  idx INTEGER NOT NULL,                    -- 章节序号（1 起），阅读页 URL 用
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  images TEXT,                             -- JSON 数组：R2 键列表 book/b<bookId>/…
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | draft
  reject_reason TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chapters_book ON book_chapters(book_id, idx);
CREATE INDEX IF NOT EXISTS idx_chapters_status ON book_chapters(status, id DESC);

-- 万载音乐（2026-09-06）：admin 直传 MP3 → 主站 /music/ 播放器页
-- file_key: R2 键（music/ 前缀，主站 /media/* 代理，Range 已支持 → 拖进度条 seek 可用）
-- cover: R2 键（music/c-*）或站内路径（/assets/img/…），空则前台「焰」字占位
-- status: published 上线 | hidden 隐藏；sort 小者靠前（列表顺序即专辑曲序）
CREATE TABLE IF NOT EXISTS music_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  artist TEXT,
  cover TEXT,
  file_key TEXT NOT NULL,
  duration INTEGER DEFAULT 0,              -- 秒；上传时浏览器端预读元数据自动带出
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  plays INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_music_pub ON music_tracks(status, sort, id);

-- 旅游景点（2026-09-06）：瀑布流推荐栏 + 详情页（对标 /tv/* /merchants/*，D1 权威）
-- slug 详情 URL（后台唯一）；body 空行分段纯文本，渲染时 esc 包 <p>——白名单结构，天然免疫 XSS
-- status: published 上线 | hidden 下线；sort 小者靠前
CREATE TABLE IF NOT EXISTS attractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT,                               -- 逗号分隔（古城,山水）
  cover TEXT,                              -- R2 键（attra/c-*）或站内路径（/assets/img/…）
  body TEXT,
  address TEXT,
  hours TEXT,
  tickets TEXT,
  transport TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attractions_pub ON attractions(status, sort, id DESC);

-- 万载图库（迁移 009），只存公开资料和 R2 图片标识。deleted 表示待清理图片。
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
CREATE INDEX IF NOT EXISTS idx_gallery_photos_status_order ON gallery_photos(status, sort, created_at DESC, id);

-- 万载活动公告（迁移 010）。草稿与最近一次审核通过的公开内容独立保存。
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

-- 作者账号（writer.whizzzest.com，docs/文库方案.md）：与商户门户完全独立的账号体系，
-- 同手机号/邮箱可在两边各注册（不同表不同会话密钥）；登录方式与商户一致
-- 2026-09-06 二次迁移：phone 允许 NULL（支持纯邮箱注册），部分唯一索引仅约束非空手机号
-- （线上旧表迁移：DROP TABLE writer_users; 后按本结构重建——当时为空表，无数据损失）
CREATE TABLE IF NOT EXISTS writer_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT,                              -- 手机号（E.164，如 +86…）注册账号填；纯邮箱注册为 NULL（迁移 005 起）
  email TEXT,
  pass_hash TEXT NOT NULL,                 -- PBKDF2-SHA256(pass_salt, 10万次)
  pass_salt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wu_email ON writer_users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wu_phone ON writer_users(phone) WHERE phone IS NOT NULL;

-- AI 助手「花傩」（2026-09-06，docs/AI助手方案.md）：知识库 / 设置 / 用量日志
-- knowledge.status: published 参与检索 | hidden 剔除；keywords 逗号分隔，命中数即相关度
CREATE TABLE IF NOT EXISTS ai_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  keywords TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_pub ON ai_knowledge(status, sort, id);

-- 运行设置（key-value）：enabled(1/0)、model、system_prompt、greeting（空=不弹气泡）、
-- quick_questions（JSON 数组，欢迎页快捷问题）
CREATE TABLE IF NOT EXISTS ai_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 问答日志：admin「AI 助手」Tab 用量卡数据源（问题分布 → 找知识缺口），可清空
CREATE TABLE IF NOT EXISTS ai_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer_len INTEGER DEFAULT 0,
  action TEXT,                             -- 命中的 action 类型（调试），无则 NULL
  sources TEXT,                            -- 命中知识条目 id 列表 JSON，无则 NULL
  duration_ms INTEGER DEFAULT 0,
  ip TEXT,
  vid TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_chats_created ON ai_chats(created_at);

-- 门户通行密钥（2026-09-08，docs/商户功能方案.md v1.7 / docs/文库方案.md v1.2）
-- merchant / writer 两门户共用一张表，portal 列隔离（与两门户账号隔离一致）；
-- credential_id / public_key 均为 base64url 字符串；transports 为 JSON 数组字符串
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portal TEXT NOT NULL,                    -- 'merchant' | 'writer' | 'admin'
  user_id INTEGER NOT NULL,                -- merchant_users.id / writer_users.id
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,      -- 验签后回写，回退视为重放
  transports TEXT,
  device TEXT,                             -- 展示名（UA 推断 + 是否云同步）
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_portal_user ON webauthn_credentials(portal, user_id);
