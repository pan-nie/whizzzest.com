# 原创游戏预留域名

`game.whizzzest.com` 留给未来自主开发的作品。原合集已退役；不再收录、镜像、分发第三方游戏或调用其外部 API。

当前仅保留 `worker/index.js` 与部署配置：

- `/`、`/en`、`/en/`：中英文预留页。
- `/robots.txt`：暂不收录。
- 旧运行页、游戏资源、目录和代理路径：410 Gone。
- POST/PUT 等写入方法：405；无存储、静态资产或服务绑定。

主站首页和导航已撤下游戏入口。预留页随主分支自动部署，先通过构建、安全回归、`npm run test:game` 与六个 Worker 的 dry-run/运行时检查。

历史记录见[网站整改记录](../docs/operations/2026-11-04-security-foundation/README.md)，其中另列 R2 旧桶的清理进度。

## 发布第一款原创游戏

- 自研原型《接烟花》的源码可用 `git show f003625:game/public/assets/js/games/catch-fireworks.js` 查看。同期的《花炮合合》是 2048 机制的验收原型，源码保存在同一提交的 `game/public/assets/js/games/huapao2048.js`。两份源码依赖旧运行壳里的接口，接入新站时可提取玩法代码并单独适配。
- 为每款原创作品设置独立页面，例如 `/games/<id>/`，并记录代码、图像、音频等素材的来源与许可。
- 发布时更新目录页、索引策略与部署测试。旧目录、`/play/*`、`/g/*` 和旧代理路径继续返回 410，使旧收藏链接与新作品地址保持独立。
