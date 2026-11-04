# 网站整改执行记录：2026-11-04

本记录持续更新实施状态。原始审计报告保持不变，不能将完成部分整改表述为完成全部安全问题。

## 当前批次：传输安全和部署保护

- [x] 保存原配置与版本基线：Git 95a7601；主域 HTTPS 强制跳转关闭、TLS 最低 1.0、HSTS 未启用。
- [x] Cloudflare 主域 Always Use HTTPS 开启；10 个网站主机的 HTTP 地址全部返回 HTTPS 跳转。
- [x] 最低 TLS 配置为 1.2，保留 TLS 1.3；通过系统代理的 CONNECT 隧道实测 TLS 1.0/1.1 返回协议版本拒绝，TLS 1.2/1.3 握手成功。
- [x] HSTS 配置为控制台最短 1 个月（2592000 秒），不启用 includeSubDomains 或 preload。10 个主机的 HTTPS 响应均实测带 HSTS。
- [x] 6 个 Worker 增加应用层 HTTPS 检查：普通页面升级 HTTPS；HTTP API、非只读提交及 WebSocket 升级在业务处理前拒绝；仅保留精确回环地址的本地开发。
- [x] 6 份 Wrangler 配置显式关闭 workers.dev 和版本预览，固化已核实的线上状态。
- [x] 部署作业依赖构建检查，加入传输安全回归测试，检查失败不再继续部署。
- [x] 本地安全测试 6 项通过；32 页静态站构建通过；6 个 Worker dry-run 通过。
- [x] 6 个 Worker 的 workerd 运行时集成测试通过，共 18 个传输行为检查；无生产绑定和业务数据写入。
- [x] PR #2 已合并为 2c1f951；Actions 41807629165 的检查、5 个应用部署和企业仓库镜像全部成功。游戏 Worker 原本不在自动部署流水线中，当前仅完成本地检查和全域边缘配置保护，单独发布时记录版本。
- [x] Access 已开放 Touch ID/生物识别、安全密钥和验证器应用登记方式；未全局强制 MFA。
- [ ] App Launcher 登记门户：仅站长邮箱、30 分钟会话的策略草稿已准备，等待新增受限入口的执行确认。验证器需用户亲自登记后，再强制后台人工访问 MFA；保留服务令牌独立流程。
- [ ] 部署令牌：确认调用方和最小权限，替代凭据验证通过后再撤旧。
- [ ] DNSSEC：需要注册商 DS 发布和完整链验证；不能只开启 Cloudflare 一侧即算完成。

原始配置快照、HTTP 检查结果和控制台截图保存在本项目忽略目录 `.build-tmp/security-foundation/`；不把账户截图或带认证参数的跳转地址提交到公共仓库。打包诊断输出在 `/private/tmp/whizzzest-security-build/`。

## 第二批：内容脚本输出安全

- [x] 独立调查与本地复现确认：商户、文库及同类结构化数据可以打断 script 原始文本边界。
- [x] 共用脚本上下文 JSON 序列化，覆盖 5 个动态模块的 JSON-LD/i18n 和构建期同类输出，保留原始 JSON 语义。
- [x] 17 项安全测试通过，包含 10 个模块/语言组合，每组 4 类恶意内容和 1 个正常 Unicode/标点控制；新增序列化契约测试。
- [x] 32 页构建通过，全部静态 JSON-LD 数据与修复前解析结果一致；主 Worker dry-run 通过。
- [x] 一次独立候选复核未发现具体绕过或回归。
- [ ] 远端检查、上线和版本核对。

第一批上线版本：主站 1d83d27a-708b-48aa-8ba8-e13575079b50；后台 abe58e06-f23d-4619-82c8-10cf6b83e8db；商户 aee8bbce-3f52-4a07-9a49-e829d986d5db；作者 ddfbc9f2-d495-437f-afe9-1f479811bc51；IM 26655d87-9f15-4d6f-9018-9fc37a60dbf2。后续发布会替换相应版本，以发布记录为准。

另经 npm 官方审计确认，当前工具依赖存在 4 项高风险聚合项（sharp、undici、miniflare、wrangler）；将在独立批次更新依赖及流水线固定版本并重跑构建、图像和运行时检查。它们与原应用源码审计的 9 项发现是不同集合。

## 后续批次覆盖表

| 批次 | 工作内容 | 状态与验收要求 |
|---|---|---|
| 安全基础 | HTTPS、TLS、HSTS、令牌、MFA、DNSSEC、备份 | 进行中；配置和应用层分别验证，保持可恢复入口 |
| 认证及 IM | 账户撤销/Passkey、内容注入、密钥备份、WS 过期/登出/限流、验证码预算、上传预算 | 待实施；依据原安全报告逐项修复并做回归 |
| 游戏退役 | 保留 game 域名及预留页；清理旧入口、游戏包、R2 对象、缓存及绑定 | 待实施；先生成精确清单，不可逆删除需执行时确认 |
| 域名和资产 | 2 个 Zone、9 个 Worker、邮箱 DNS、平台默认入口、归属和用途 | 清单已核实；保留旧 .top 跳转及 auth.thu 认证入口 |
| 支付 | 订单/核销/权益/续费/退款/审计、实际网关接入 | 待实施；重复通知幂等、续费保留剩余期限、过期保留免费资料 |
| 新闻 | 官方来源、采集、摘要/出处、去重、待审、重试和监控 | 待实施；先验证质量与来源授权边界 |
| 视觉及无障碍 | 共享组件、首屏信息层次、对比度、标签、焦点、减少动效 | 待实施；键盘和移动端验收，并检查加载/交互性能 |
| 自摄图库 | 原片、公开版本、拍摄/授权/许可元数据、隐私处理、替代文本 | 待实施；拍摄需要用户提供真实照片，不以 AI 图冒充实拍 |
| 上线与并发 | 发布版本对应 Git、监控、关键流程回归、受控并发和回滚 | 持续进行；本地模拟不能代替线上/真实支付验证 |

## 本批次回滚与限制

Worker 代码通过版本回滚恢复；数据库与对象数据不会随代码回滚。当前没有执行数据迁移或删除。

边缘配置原值保存在快照中。HSTS 已被浏览器缓存时，修改控制台不会立即清除客户端缓存；如需撤回，应先通过 HTTPS 发送 max-age=0 并维持有效 HTTPS。不能先关闭证书或停用 HTTPS。

参考：[Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)、[HSTS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/)、[Access MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/)。
