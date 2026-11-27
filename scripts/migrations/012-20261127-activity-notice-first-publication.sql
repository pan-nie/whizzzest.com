-- 经逐篇核对的首批历史活动公告，仅保存事实摘要和原公告链接。
-- npx wrangler d1 execute whizzzest --remote --file scripts/migrations/012-20261127-activity-notice-first-publication.sql
-- 本地演练使用相同命令的 --local 选项。
-- 执行记录：2026-11-27 本地重跑测试通过，生产已核验六条历史公告及六条发布审核记录。
-- 审核记录的 actor_uid=-1 保留给这次人工核对后的上线导入。
-- 重复执行保留现有公告和后续编辑，若原文已手工录入则跳过。

WITH seed(id, payload, state, start, until) AS (VALUES
  ('b571bb77-fa20-49f6-a05e-590c85d21001', '{"previous_sessions":[],"change_note":"","visible_through":"","title":"万载县文化馆花灯戏专场","summary":"县文旅部门公告所列场次为 2026 年 4 月 29 日 9:00。活动安排有花灯戏讲座、剧团演出和非遗展板参观，原公告注明免费并需报名。","location":"万载县文化馆","source_name":"万载县文化广电旅游局","source_title":"关于开展2026年“固定开放月”活动的公告","source_url":"https://www.wanzai.gov.cn/wzxrmzf/ggwh/pc/content/2047608870067290112/content_2047608870067290112.html","source_date":"2026-07-03","state":"scheduled","sessions":[{"start":"2026-04-29T09:00","end":""}],"verified_on":"2026-11-27"}', 'scheduled', 1777424400000, 1777478400000),
  ('b571bb77-fa20-49f6-a05e-590c85d21002', '{"previous_sessions":[],"change_note":"","visible_through":"","state":"scheduled","verified_on":"2026-11-27","source_url":"https://www.wanzai.gov.cn/wzxrmzf/xwbzwdtdc/pc/content/2043586583458578432/content_2043586583458578432.html","title":"赤兴乡送戏下乡演出","location":"赤兴乡集镇粤客隆超市旁","summary":"宜春市采茶舞剧院的送戏下乡演出安排在 2026 年 4 月 13 日 14:00，地点为赤兴乡集镇粤客隆超市旁。","source_name":"万载县赤兴乡人民政府","source_date":"2026-04-13","source_title":"演出通知","sessions":[{"start":"2026-04-13T14:00","end":""}]}', 'scheduled', 1776060000000, 1776096000000),
  ('b571bb77-fa20-49f6-a05e-590c85d21003', '{"previous_sessions":[],"change_note":"","visible_through":"","state":"scheduled","verified_on":"2026-11-27","source_url":"https://www.wanzai.gov.cn/wzxrmzf/ggwh/pc/content/2036286565852749824/content_2036286565852749824.html","title":"万载县图书馆新馆开放","location":"万载县环湖西路 1 号","summary":"图书馆自 2026 年 1 月 1 日起在环湖西路 1 号恢复开放。公告所列时段为周二至周日 9:00–17:00，周一闭馆。","source_name":"万载县文广新旅局","source_date":"2026-01-01","source_title":"万载县图书馆新馆开放公告","sessions":[{"start":"2026-01-01","end":""}]}', 'scheduled', 1767196800000, 1767283200000),
  ('b571bb77-fa20-49f6-a05e-590c85d21004', '{"previous_sessions":[],"change_note":"","visible_through":"","state":"scheduled","verified_on":"2026-11-27","source_url":"https://www.wanzai.gov.cn/wzxrmzf/ggwh/pc/content/2036286535355965440/content_2036286535355965440.html","title":"万载古城十二月花灯戏与傩戏","location":"万载古城从泉茶馆","summary":"2024 年 12 月 7、14、21、28 日各有一场花灯戏与傩戏演出，每场 20:30 开始，地点为万载古城从泉茶馆。","source_name":"万载县文广新旅局","source_date":"2024-12-02","source_title":"演出预告 | 12月好戏来袭，共迎四季终章","sessions":[{"start":"2024-12-07T20:30","end":""},{"start":"2024-12-14T20:30","end":""},{"start":"2024-12-21T20:30","end":""},{"start":"2024-12-28T20:30","end":""}]}', 'scheduled', 1733574600000, 1735401600000),
  ('b571bb77-fa20-49f6-a05e-590c85d21005', '{"previous_sessions":[],"change_note":"","visible_through":"","state":"scheduled","verified_on":"2026-11-27","source_url":"https://www.wanzai.gov.cn/wzxrmzf/ggwh/pc/content/2036286475490664448/content_2036286475490664448.html","title":"万载县图书馆闭馆维修","location":"万载县图书馆","summary":"图书馆于 2024 年 10 月 16 日起闭馆改造，原通知预计约三个月，馆内借阅等服务暂停，公众号数字阅读服务继续提供。","source_name":"万载县文广新旅局刊载，县图书馆署名","source_date":"2024-10-15","source_title":"万载县图书馆闭馆维修改造通知","sessions":[{"start":"2024-10-16","end":""}]}', 'scheduled', 1729008000000, 1729094400000),
  ('b571bb77-fa20-49f6-a05e-590c85d21006', '{"previous_sessions":[{"start":"2023-07-29","end":""}],"change_note":"受台风天气影响，晚会由 7 月 29 日延期至 8 月 5 日。","visible_through":"","state":"rescheduled","verified_on":"2026-11-27","source_url":"https://www.wanzai.gov.cn/wzxrmzf/ggwh/pc/content/2029449368382054400/content_2029449368382054400.html","title":"龙湖公园焰火晚会延期","location":"万载县龙湖公园","summary":"「人间烟火 家和万载」焰火文艺晚会延期，具体抢票安排由「万载发布」另行公布。","source_name":"万载县文化广电新闻出版旅游局","source_date":"2023-07-25","source_title":"焰火晚会延期公告！","sessions":[{"start":"2023-08-05","end":""}]}', 'rescheduled', 1691164800000, 1691251200000)
) INSERT INTO activity_notices(id, draft, published, revision, published_revision, public_state, public_start, public_until)
SELECT id, payload, payload, 2, 2, state, start, until FROM seed
WHERE NOT EXISTS (SELECT 1 FROM activity_notices existing
  WHERE json_extract(existing.draft, '$.source_url') = json_extract(seed.payload, '$.source_url')
     OR json_extract(existing.published, '$.source_url') = json_extract(seed.payload, '$.source_url'))
ON CONFLICT(id) DO NOTHING;

INSERT INTO activity_notice_history(notice_id, revision, action, actor_uid, content)
SELECT id, published_revision, 'publish', -1, published FROM activity_notices
WHERE published_revision = 2 AND id IN ('b571bb77-fa20-49f6-a05e-590c85d21001', 'b571bb77-fa20-49f6-a05e-590c85d21002', 'b571bb77-fa20-49f6-a05e-590c85d21003', 'b571bb77-fa20-49f6-a05e-590c85d21004', 'b571bb77-fa20-49f6-a05e-590c85d21005', 'b571bb77-fa20-49f6-a05e-590c85d21006')
ON CONFLICT(notice_id, revision) DO NOTHING;
