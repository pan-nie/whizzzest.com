import { Duel, ROSTER, ROUND_SECONDS, MAX_FOCUS, replayFrame } from './combat.mjs';
import { StageView } from './stage.mjs';
import { Percussion } from './audio.mjs';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
const cards = [...ui.roster.querySelectorAll('button[data-id]')];
const audio = new Percussion();
const opponentFor = { ren: 'liu', liu: 'gao', gao: 'ren' };
const effects = new Set(['hit', 'parry', 'break', 'block', 'dodge']);
const movementKeys = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright', 'j', 'e', 'q', 'k', 'shift']);
const input = { keys: new Set(), mouseGuard: false, queued: null, dash: false };
const hud = ['p', 'c'].map(key => ({
  name: ui[key + '-name'],
  hp: ui[key + '-health'],
  trail: ui[key + '-health'].previousElementSibling,
  stance: ui[key + '-stance'],
  focus: ui[key + '-focus'],
  pips: [...ui[key + '-focus'].children],
}));
const fixedStep = 1 / 60;
let phase = 'selection';
let selected = 'ren';
let match = new Duel(selected, opponentFor[selected]);
let view;
let ready = false;
let cueUntil = 0;
let impacts = [];
let combo = null;
let replay = null;
let displayTime = 0;
let previousTime;
let accumulator = 0;

function resetInputs() {
  input.keys.clear();
  input.mouseGuard = false;
  input.queued = null;
  input.dash = false;
  match.clearInput();
}

function setText(element, label) {
  if (element.textContent !== label) element.textContent = label;
}

function setPhase(next) {
  phase = next;
  ui.arena.dataset.phase = next;
  ui.pause.hidden = next !== 'playing';
  ui.result.hidden = next !== 'complete';
  ui['pause-overlay'].hidden = next !== 'paused';
  ui['replay-controls'].hidden = next !== 'replay';
  ui.start.disabled = !ready || next !== 'selection';
  for (const card of cards) card.disabled = next === 'playing' || next === 'replay' || next === 'paused';
  setText(ui['mode-tag'], { selection: '对阵', playing: '对阵中', paused: '暂停', complete: '落幕', replay: '回放' }[next]);
  ui.cue.hidden = true;
  ui.combo.hidden = true;
  resetInputs();
}

function updateHud(actors, remaining) {
  actors.forEach((actor, index) => {
    const display = hud[index];
    setText(display.name, ROSTER[actor.id].name);
    if (display.hp.getAttribute('aria-valuenow') !== String(actor.hp)) {
      display.hp.setAttribute('aria-valuenow', String(actor.hp));
      display.hp.style.transform = 'scaleX(' + actor.hp / 100 + ')';
      display.trail.style.transform = display.hp.style.transform;
    }
    const stance = Math.round(actor.stance);
    if (display.stance.getAttribute('aria-valuenow') !== String(stance)) {
      display.stance.setAttribute('aria-valuenow', String(stance));
      display.stance.style.transform = 'scaleX(' + stance / 100 + ')';
    }
    if (display.focus.dataset.value === String(actor.focus)) return;
    display.focus.dataset.value = actor.focus;
    display.focus.setAttribute('aria-valuenow', String(actor.focus));
    display.pips.forEach((pip, at) => pip.classList.toggle('filled', at < actor.focus));
  });
  setText(ui.timer, String(Math.ceil(remaining)).padStart(2, '0'));
}

function loadMatch(withEvents = false) {
  match = new Duel(selected, opponentFor[selected], { onEvent: withEvents ? onEvent : undefined });
  if (ready) view.setFighters(match.fighters.map(fighter => fighter.id));
  updateHud(match.fighters, ROUND_SECONDS);
  cueUntil = 0;
  impacts = [];
  combo = null;
  replay = null;
  accumulator = 0;
}

function select(id) {
  if (!Object.hasOwn(ROSTER, id)) return;
  selected = id;
  cards.forEach(card => card.setAttribute('aria-pressed', String(card.dataset.id === id)));
  setText(ui.opponent, ROSTER[opponentFor[id]].name);
  loadMatch();
  setPhase('selection');
}

function startMatch() {
  if (!ready) return;
  audio.unlock();
  loadMatch(true);
  setPhase('playing');
  announce('', '开打', '', 'finish', .72);
  audio.play('begin');
  view.renderer.domElement.focus({ preventScroll: true });
}

function announce(source, title, detail, tone = 'neutral', duration = .85) {
  setText(ui['cue-source'], source);
  setText(ui['cue-name'], title);
  setText(ui['cue-detail'], detail);
  ui.cue.dataset.tone = tone;
  ui.cue.hidden = false;
  cueUntil = match.time + duration;
}

function playEvent(event) {
  audio.play(event.type, event.strength ?? (event.kind === 'follow' ? 1 : 0));
}

function onEvent(event) {
  playEvent(event);
  if (effects.has(event.type)) {
    impacts.push(event);
    if (impacts.length > 2) impacts.shift();
  }
  if (event.combo) combo = event;
  const fromPlayer = event.index === 0;
  const attacker = ROSTER[match.fighters[event.index].id].name;
  if (event.type === 'roundEnd') {
    announce('', event.knockout ? '击倒' : '时尽', '', 'finish', .74);
    return;
  }
  if (event.type === 'cue') {
    announce(fromPlayer ? '你的起鼓' : '对手起鼓', event.name, '', 'neutral', .59);
  }
  if (event.type === 'parry' || event.type === 'dodge') {
    const title = event.type === 'parry' ? '精准格挡' : '闪步避开';
    announce(fromPlayer ? '电脑化解' : '你已化解', title, '', fromPlayer ? 'bad' : 'good', .85);
  }
  if (event.type === 'break') announce(attacker, '打破架势', '', fromPlayer ? 'good' : 'bad');
  if (event.type === 'hit' && event.strength >= 2) {
    announce(attacker, event.name + '命中', '', fromPlayer ? 'good' : 'bad');
  }
  if (event.type === 'miss' && !fromPlayer) announce('对手出招', '重招落空', '可以趁对手收招还手。', 'good');
}

function describe(event) {
  if (!event) return { title: '末场走位', detail: '回看片段中双方的距离与收步。' };
  const attacker = ROSTER[match.fighters[event.index].id].name;
  const defender = ROSTER[match.fighters[1 - event.index].id].name;
  switch (event.type) {
    case 'parry':
      return { title: defender + ' · 精准格挡', detail: '格挡刚好接在「' + event.name + '」命中前，对手被震开，反击窗口出现。' };
    case 'dodge':
      return { title: defender + ' · 闪步避开', detail: '在「' + event.name + '」落下时处于闪步中，避开攻击并获得一格气势。' };
    case 'miss':
      return { title: attacker + ' · ' + event.name + '落空', detail: '出招时对手已经离开攻击距离或角度，留意双方脚下的位置。' };
    case 'block':
      return { title: defender + ' · 格挡', detail: '挡住了「' + event.name + '」，代价是消耗架势和少量体力。' };
    case 'break':
      return { title: attacker + ' · 打破架势', detail: '「' + event.name + '」耗尽对手剩余的架势，使守方失衡。' };
    default:
      return { title: attacker + ' · ' + event.name + '命中', detail: '出手时对手仍在攻击范围内。拖动进度条可比较起势和命中时的站位。' };
  }
}

function finish() {
  const titles = { win: '此场胜出', lose: '电脑胜出', draw: '平分秋色' };
  setText(ui.outcome, titles[match.result]);
  const key = describe(match.clip.event);
  setText(ui['result-caption'], '关键一招 · ' + key.title);
  setPhase('complete');
  audio.play('complete');
  ui.replay.focus({ preventScroll: true });
}

function pause() {
  if (phase !== 'playing') return;
  setPhase('paused');
  ui.resume.focus({ preventScroll: true });
}

function resume() {
  if (phase !== 'paused') return;
  setPhase('playing');
  view.renderer.domElement.focus({ preventScroll: true });
}

function setReplayProgress(time, withSound = false) {
  if (withSound) {
    for (const event of match.clip.events) {
      if (event.time > replay.time && event.time <= time) playEvent(event);
    }
  }
  replay.time = time;
  const fraction = (time - match.clip.start) / (match.clip.end - match.clip.start);
  ui.scrub.value = String(Math.round(fraction * 1000));
}

function toggleReplay(paused) {
  replay.playing = !paused;
  setText(ui['replay-play'], paused ? '▶' : 'Ⅱ');
  ui['replay-play'].setAttribute('aria-label', paused ? '播放回放' : '暂停回放');
}

function openReplay() {
  const clip = match.clip;
  if (!clip) return;
  audio.unlock();
  const info = describe(clip.event);
  setText(ui['replay-title'], info.title);
  setText(ui['replay-caption'], info.detail);
  ui['replay-point'].style.left = (((clip.event?.time ?? clip.end) - clip.start) / (clip.end - clip.start) * 100) + '%';
  replay = { time: clip.start, playing: true };
  setPhase('replay');
  setReplayProgress(clip.start);
  toggleReplay(false);
  ui['replay-play'].focus({ preventScroll: true });
}

function closeReplay() {
  setPhase('complete');
  updateHud(match.fighters, match.remaining);
  ui.replay.focus({ preventScroll: true });
}

function controls() {
  const has = (key, arrow) => Number(input.keys.has(key) || input.keys.has(arrow));
  const state = {
    horizontal: has('d', 'arrowright') - has('a', 'arrowleft'),
    depth: has('s', 'arrowdown') - has('w', 'arrowup'),
    guard: input.mouseGuard || input.keys.has('k'),
    attack: input.queued,
    dash: input.dash,
  };
  input.queued = null;
  input.dash = false;
  return state;
}

for (const card of cards) card.addEventListener('click', () => select(card.dataset.id));
ui.start.addEventListener('click', startMatch);
ui.rematch.addEventListener('click', startMatch);
ui.pause.addEventListener('click', pause);
ui.resume.addEventListener('click', resume);
ui.quit.addEventListener('click', () => { select(selected); ui.start.focus({ preventScroll: true }); });
ui.replay.addEventListener('click', openReplay);
ui['replay-close'].addEventListener('click', closeReplay);
ui['replay-play'].addEventListener('click', () => {
  if (replay.time >= match.clip.end) setReplayProgress(match.clip.start);
  toggleReplay(replay.playing);
});
ui.scrub.addEventListener('input', () => {
  toggleReplay(true);
  setReplayProgress(match.clip.start + Number(ui.scrub.value) / 1000 * (match.clip.end - match.clip.start));
});
ui.sound.addEventListener('click', () => {
  audio.setEnabled(!audio.enabled);
  ui.sound.setAttribute('aria-pressed', String(audio.enabled));
  setText(ui.sound.lastElementChild, audio.enabled ? '音效开' : '音效关');
});
ui.arena.addEventListener('contextmenu', (event) => {
  if (phase === 'playing') event.preventDefault();
});
ui.arena.addEventListener('pointerdown', (event) => {
  if (phase !== 'playing') return;
  if (event.button === 0) input.queued = 'light';
  if (event.button === 2) input.mouseGuard = true;
  if (event.button === 0 || event.button === 2) event.preventDefault();
});
window.addEventListener('pointerup', (event) => { if (event.button === 2) input.mouseGuard = false; });
window.addEventListener('pointercancel', () => { input.mouseGuard = false; });
window.addEventListener('blur', resetInputs);
window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'escape') {
    if (phase === 'playing') pause();
    else if (phase === 'paused') resume();
    else if (phase === 'replay') closeReplay();
    return;
  }
  if (phase !== 'playing' || !movementKeys.has(key) || event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  input.keys.add(key);
  if (event.repeat) return;
  if (key === 'j') input.queued = 'light';
  if (key === 'e') input.queued = 'heavy';
  if (key === 'q') {
    if (match.fighters[0].focus >= MAX_FOCUS) input.queued = 'special';
    else announce('绝技', '气势尚未蓄满', '命中、闪避或精准格挡可获得气势。', 'neutral', .93);
  }
  if (key === 'shift') input.dash = true;
});
window.addEventListener('keyup', (event) => { input.keys.delete(event.key.toLowerCase()); });

function frame(timestamp) {
  const delta = previousTime === undefined ? 0 : Math.min(.12, (timestamp - previousTime) / 1000);
  previousTime = timestamp;
  displayTime += delta;
  if (phase === 'playing') {
    accumulator += delta;
    while (accumulator >= fixedStep && !match.clip) {
      accumulator -= fixedStep;
      match.step(fixedStep, controls());
    }
    if (match.time >= cueUntil) ui.cue.hidden = true;
    ui.combo.hidden = !combo || match.time - combo.time >= .77;
    if (!ui.combo.hidden) {
      ui.combo.dataset.side = combo.index === 0 ? 'player' : 'cpu';
      setText(ui.combo, combo.combo + ' 连击');
    }
    updateHud(match.fighters, match.remaining);
    if (match.clip) finish();
  }
  if (phase === 'replay') {
    if (replay.playing) {
      const time = Math.min(match.clip.end, replay.time + delta * .58);
      setReplayProgress(time, true);
      if (time >= match.clip.end) toggleReplay(true);
    }
    const actors = replayFrame(match.clip.frames, replay.time);
    const effectsInClip = match.clip.events.filter(event => effects.has(event.type) && event.time <= replay.time &&
      replay.time - event.time < .43).slice(-2).reverse().map(event => ({ event, age: replay.time - event.time }));
    updateHud(actors, ROUND_SECONDS - replay.time);
    view.draw(actors, replay.time, { replay: true, effects: effectsInClip });
  } else {
    const liveEffects = impacts.map(event => {
      const since = match.time - event.time;
      const age = since + (since === 0 ? Math.max(0, event.freeze - match.hitStop) : event.freeze);
      return { event, age };
    }).reverse();
    view.draw(match.fighters, phase === 'selection' ? displayTime : match.time, {
      preview: phase === 'selection',
      delta: phase === 'paused' ? 0 : delta,
      effects: liveEffects,
    });
  }
  requestAnimationFrame(frame);
}

async function init() {
  try {
    view = new StageView(ui.arena);
    await view.load();
    ready = true;
    select(selected);
    ui.loading.hidden = true;
    requestAnimationFrame(frame);
  } catch (error) {
    console.error(error);
    setText(ui.loading, '戏台载入失败。请用支持 WebGL 的浏览器刷新试玩。');
  }
}
init();
