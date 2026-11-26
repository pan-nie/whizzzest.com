import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const output = new URL('./dist/', import.meta.url);
const gameOutput = new URL('game/', output);
const site = new URL('./site/', import.meta.url);
const game = new URL('../game/prototypes/san-cha-kou/', import.meta.url);

await rm(output, { recursive: true, force: true });
await cp(site, output, { recursive: true });
await mkdir(gameOutput);

const assets = ['audio.mjs', 'combat.mjs', 'impact.mjs', 'main.mjs', 'stage.mjs', 'style.css', 'models', 'vendor'];
await Promise.all(assets.map(name => cp(new URL(name, game), new URL(name, gameOutput), { recursive: true })));

const index = await readFile(new URL('index.html', game), 'utf8');
const navigation = '<nav aria-label="试玩设置">';
const metadata = '<meta name="robots" content="noindex">';
if (!index.includes(navigation) || !index.includes(metadata)) {
  throw new Error('《三岔口》模板缺少剧场导航或页面元数据的位置。');
}

const theatreIndex = index
  .replace(navigation, navigation + '\n        <a class="quiet-button" href="/">剧场首页</a>')
  .replace(metadata, '<link rel="canonical" href="https://opera.whizzzest.com/game/">');
await writeFile(new URL('index.html', gameOutput), theatreIndex);
