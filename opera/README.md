# 梨园剧场

子站 [opera.whizzzest.com](https://opera.whizzzest.com/) 由独立的 `whizzzest-opera` Workers Static Assets 项目提供。

| URL | 内容 |
|---|---|
| `/` | 三个栏目入口及《三岔口》试玩推荐 |
| `/game/` | 《三岔口》3D 网页试玩 |
| `/music/` | 从专用 R2 桶读取原创音频并在线播放 |
| `/video/` | 京剧演出与数字演绎的官方观看链接 |

首页与两个栏目在 `site/` 下，游戏源码在 `game/prototypes/san-cha-kou/` 下。首页封面使用该游戏的 Blender 戏台和角色渲染。构建只复制游戏的网页运行文件，Blender 源工程仍保存在游戏原型目录。

从仓库根目录执行

```sh
node opera/build.mjs
npx --no-install wrangler deploy --config opera/wrangler.jsonc --dry-run
```

本地预览可运行 `npx --no-install wrangler dev --config opera/wrangler.jsonc --port 8765`。发布时先重新构建，再从仓库根目录执行 `npx --no-install wrangler deploy --cwd opera --strict`。本机的 `opera` 目录已绑定专用 Wrangler 登录配置 `opera-subsite`。

GitHub Actions 会在 PR 中构建并校验梨园剧场，合并到 `main` 后先部署梨园剧场，再部署包含曲库管理的管理后台。

## 上传音乐

1. 登录 [管理后台](https://admin.whizzzest.com/#/music/opera)，在「音乐」中选择「梨园剧场音乐」，点击「新增曲目」。
2. 选择 MP3、M4A、OGG 或 WAV 文件，单个文件最多 20 MB。填写曲名、简介和曲序，也可以上传封面。
3. 选择「上线」并保存，打开 [公开音乐页](https://opera.whizzzest.com/music/) 即可试听。选择「隐藏」可先留在后台，随后用列表中的「上线」按钮发布。

「万载音乐」和「梨园剧场音乐」共用管理界面，各自使用原有的存储。梨园剧场的音频、封面和曲目信息存放于专用 R2 桶 `whizzzest-opera-music`。之前上传到 `tracks/` 的曲目仍沿用原来的试听地址，并可在后台编辑、隐藏或删除。

## 内容安全策略

子站 HTML 每次响应都生成一个随机的 CSP nonce，Cloudflare 将它应用到自己的访问检测脚本。静态资源继续使用 `site/_headers` 中的强制策略。 [Cloudflare JavaScript Detections](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/)

HTML 同时执行两条 CSP。第一条要求内联脚本使用匹配的 nonce，第二条要求外部脚本来自本站。两条规则的交集允许 Cloudflare 的内联访问检测及其同源资源，并阻止浏览器加载外部 Web Analytics 脚本。这个限制在子站 Worker 内生效。 [CSP 多策略执行规则](https://www.w3.org/TR/CSP3/#multiple-policies)
