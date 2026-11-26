const county = 'https://www.wanzai.gov.cn/wzxrmzf';
const sessions = (...dates) => dates.map((date) => {
  const [start, end = ''] = date.split(' / ');
  return { start, end };
});

// Seven editorial samples from docs/文旅活动公告试编.md. Import into local tests only.
module.exports = [
  {
    title: '第六届万载花炮文化节', location: '万载龙湖公园焰火燃放国际赛事中心',
    summary: '第六届万载花炮文化节安排在 2026 年 10 月 31 日至 11 月 2 日，主会场为万载龙湖公园焰火燃放国际赛事中心。',
    source_name: '智慧万载（县政府门户转载）', source_date: '2026-09-28',
    source_title: '第六届万载花炮文化节来啦！亮点请先看', channel: 'xwfbh1', article: '2104468642607239168',
    sessions: sessions('2026-10-31 / 2026-11-02'),
  },
  {
    title: '赤兴乡送戏下乡演出', location: '赤兴乡集镇粤客隆超市旁',
    summary: '宜春市采茶舞剧院的送戏下乡演出安排在 2026 年 4 月 13 日 14:00，地点为赤兴乡集镇粤客隆超市旁。',
    source_name: '万载县赤兴乡人民政府', source_date: '2026-04-13',
    source_title: '演出通知', channel: 'xwbzwdtdc', article: '2043586583458578432',
    sessions: sessions('2026-04-13T14:00'),
  },
  {
    title: '万载县图书馆新馆开放', location: '万载县环湖西路 1 号',
    summary: '图书馆自 2026 年 1 月 1 日起在环湖西路 1 号恢复开放。公告所列时段为周二至周日 9:00–17:00，周一闭馆。',
    source_name: '万载县文广新旅局', source_date: '2026-01-01',
    source_title: '万载县图书馆新馆开放公告', channel: 'ggwh', article: '2036286565852749824',
    sessions: sessions('2026-01-01'),
  },
  {
    title: '万载古城十二月花灯戏与傩戏', location: '万载古城从泉茶馆',
    summary: '2024 年 12 月 7、14、21、28 日各有一场花灯戏与傩戏演出，每场 20:30 开始，地点为万载古城从泉茶馆。',
    source_name: '万载县文广新旅局', source_date: '2024-12-02',
    source_title: '演出预告 | 12月好戏来袭，共迎四季终章', channel: 'ggwh', article: '2036286535355965440',
    sessions: sessions('2024-12-07T20:30', '2024-12-14T20:30', '2024-12-21T20:30', '2024-12-28T20:30'),
  },
  {
    title: '万载县图书馆闭馆维修', location: '万载县图书馆',
    summary: '图书馆于 2024 年 10 月 16 日起闭馆改造，原通知预计约三个月，馆内借阅等服务暂停，公众号数字阅读服务继续提供。',
    source_name: '万载县文广新旅局刊载，县图书馆署名', source_date: '2024-10-15',
    source_title: '万载县图书馆闭馆维修改造通知', channel: 'ggwh', article: '2036286475490664448',
    sessions: sessions('2024-10-16'),
  },
  {
    title: '龙湖公园焰火晚会延期', location: '万载县龙湖公园', state: 'rescheduled',
    summary: '「人间烟火 家和万载」焰火文艺晚会延期，具体抢票安排由「万载发布」另行公布。',
    source_name: '万载县文化广电新闻出版旅游局', source_date: '2023-07-25',
    source_title: '焰火晚会延期公告！', channel: 'ggwh', article: '2029449368382054400',
    sessions: sessions('2023-08-05'), previous_sessions: sessions('2023-07-29'),
    change_note: '受台风天气影响，晚会由 7 月 29 日延期至 8 月 5 日。',
  },
  {
    title: '龙湖公园「猎鹰之夜」', location: '万载龙湖公园国际赛事中心',
    summary: '「猎鹰之夜」焰火及社区文艺汇演排在 2023 年 4 月 26 日 19:30–21:00，地点为万载龙湖公园国际赛事中心。',
    source_name: '万载发布（县政府门户转载）', source_date: '2023-04-26',
    source_title: '今晚七点半！“猎鹰之夜”焰火表演+文化汇演即将开始！', channel: 'ggwh', article: '2029449360479985664',
    sessions: sessions('2023-04-26T19:30 / 2023-04-26T21:00'),
  },
].map(({ channel, article, ...row }) => ({
  state: 'scheduled', verified_on: '2026-11-26',
  source_url: `${county}/${channel}/pc/content/${article}/content_${article}.html`, ...row,
}));
