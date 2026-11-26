# 三岔口 · 梨园对阵

本地键鼠试玩。网页和 3D 模型由本地服务器提供，音效在浏览器内合成。需要支持 WebGL 2 的浏览器。

在仓库根目录运行

```sh
python3 -m http.server 8764 --bind 127.0.0.1 --directory game/prototypes/san-cha-kou
```

访问 http://127.0.0.1:8764/ 。选择任堂惠、刘利华或高宠，与电脑打一轮。终场回放支持暂停和拖动进度。

- WASD 走位，左键轻招，右键格挡，E 重招，Shift 配方向闪步，Q 消耗三格气势发动绝技。
- J/K 可代替鼠标左右键。Esc 暂停。右键在戏台内按下。
- 起鼓与末锣用 Web Audio 合成，为试玩编排的提示音。开打后播放，也可静音。金色扇面提供对应的视觉提示。

## Blender 源文件和素材

`art/san-cha-kou.blend` 包含戏台和三个原创风格化人物。角色用可动节点组织，浏览器按攻防状态驱动姿态。重新导出模型和选角肖像时运行

```sh
blender --background --factory-startup --python game/prototypes/san-cha-kou/art/build_scene.py -- --portraits
```

素材参考国家京剧院的《三岔口》剧目资料和国家大剧院的京剧武生讲堂。场景、人物、肖像和音效在此原型制作。玩法、招式判定和鼓点属于游戏改编。

`vendor/three-gltf.mjs` 是 Three.js 0.181.2 的浏览器打包版，包含 GLTFLoader 和 BufferGeometryUtils 的 mergeGeometries。此打包版用 Web Crypto 生成 UUID 的随机字节。许可证在 `vendor/LICENSE-Three.txt`。
