export const ROUND_SECONDS = 60;
export const MAX_FOCUS = 3;

export const ROSTER = {
  ren: {
    name: '任堂惠', speed: 2.9, dash: 7.8,
    moves: {
      light: { name: '试探刀', windup: .15, active: .075, total: .39, range: 1.43, damage: 10, arc: .73, step: .36 },
      follow: { name: '反手刀', windup: .135, active: .085, total: .43, range: 1.58, damage: 12, arc: .86, step: .54 },
      heavy: { name: '劈面刀', windup: .43, active: .10, total: .86, range: 1.83, damage: 24, arc: .87, step: .64 },
      special: { name: '回身刀', windup: .36, active: .125, total: .86, range: 2.10, damage: 33, arc: 1.26, step: .96 },
    },
  },
  liu: {
    name: '刘利华', speed: 3.22, dash: 9.0,
    moves: {
      light: { name: '贴身短刀', windup: .12, active: .075, total: .34, range: 1.24, damage: 9, arc: .78, step: .42 },
      follow: { name: '反撩短刀', windup: .115, active: .08, total: .37, range: 1.37, damage: 11, arc: .94, step: .57 },
      heavy: { name: '矮身撩刀', windup: .37, active: .10, total: .75, range: 1.58, damage: 21, arc: .99, step: .81 },
      special: { name: '伏身掠步', windup: .30, active: .12, total: .76, range: 1.83, damage: 30, arc: 1.15, step: 1.17 },
    },
  },
  gao: {
    name: '高宠', speed: 2.59, dash: 7.1,
    moves: {
      light: { name: '探枪', windup: .195, active: .085, total: .47, range: 1.90, damage: 12, arc: .51, step: .31 },
      follow: { name: '进步点枪', windup: .165, active: .09, total: .52, range: 2.00, damage: 13, arc: .54, step: .47 },
      heavy: { name: '压台枪', windup: .52, active: .105, total: 1.00, range: 2.31, damage: 29, arc: .58, step: .62 },
      special: { name: '挑车枪', windup: .43, active: .13, total: .97, range: 2.48, damage: 37, arc: .71, step: .78 },
    },
  },
};

const PLAYER = 0;
const MIN_SEPARATION = .84;
const BOX = { x: 5.20, near: 2.62, far: -1.95 };
export const DASH_DURATION = .26;
const BUFFER_SECONDS = .17;
const REPLAY_SECONDS = 3.5;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

function direction(dx, dz) {
  const length = Math.hypot(dx, dz);
  return length > .0001 ? { x: dx / length, z: dz / length } : { x: 0, z: 0 };
}

function targetHeading(fighter, target) {
  return Math.atan2(target.x - fighter.x, target.z - fighter.z);
}

function relativeMove(fighter, advance, sidestep) {
  return direction(
    Math.sin(fighter.heading) * advance + Math.cos(fighter.heading) * sidestep,
    Math.cos(fighter.heading) * advance - Math.sin(fighter.heading) * sidestep,
  );
}

function inRange(attacker, target, move) {
  const angle = targetHeading(attacker, target) - attacker.heading;
  return Math.hypot(attacker.x - target.x, attacker.z - target.z) <= move.range &&
    Math.cos(angle) >= Math.cos(move.arc);
}

function actor(id, x, heading) {
  return {
    id, x, z: .43, heading, hp: 100, stance: 100, focus: 0, guard: false,
    guardedAt: -Infinity, action: null, dash: null, dashReady: 0, stunUntil: 0,
    reaction: null, stanceReady: 0, gait: 0, moving: 0, travel: 1, strafe: 0,
  };
}

function snapshot(actor) {
  return {
    id: actor.id, x: actor.x, z: actor.z, heading: actor.heading, hp: actor.hp,
    stance: actor.stance, focus: actor.focus, guard: actor.guard,
    gait: actor.gait, moving: actor.moving, travel: actor.travel, strafe: actor.strafe, guardedAt: actor.guardedAt,
    reaction: actor.reaction, action: actor.action && { ...actor.action }, dash: actor.dash,
  };
}

export class Duel {
  constructor(player, opponent, { random = Math.random, onEvent = () => {} } = {}) {
    this.fighters = [actor(player, -1.68, Math.PI / 2), actor(opponent, 1.68, -Math.PI / 2)];
    this.random = random;
    this.onEvent = onEvent;
    this.time = 0;
    this.result = null;
    this.endedAt = null;
    this.hitStop = 0;
    this.buffer = {};
    this.ai = { think: .26, nextAttack: .76, guardUntil: 0, sidestep: 1, move: 'approach' };
    this.frames = [];
    this.events = [];
    this.nextFrame = 0;
    this.highlight = null;
    this.clip = null;
    this.record();
  }

  get remaining() { return Math.max(0, ROUND_SECONDS - (this.endedAt ?? this.time)); }

  clearInput() { this.buffer = {}; }

  perform(index, kind, direction = null) {
    const fighter = this.fighters[index];
    if (this.result || fighter.dash || fighter.guard || this.time < fighter.stunUntil) return false;
    if (fighter.action) {
      const { kind: current, connectedAt } = fighter.action;
      if (kind !== 'light' || current !== 'light' || connectedAt == null || this.time < connectedAt + .045) return false;
      kind = 'follow';
    }
    if (kind === 'dash') {
      if (this.time < fighter.dashReady) return false;
      const vector = direction || relativeMove(fighter, -1, 0);
      fighter.dash = { began: this.time, ...vector };
      fighter.dashReady = this.time + .51;
      this.emit({ type: 'step', index });
      return true;
    }
    const move = ROSTER[fighter.id].moves[kind];
    if (!move || (kind === 'special' && fighter.focus < MAX_FOCUS)) return false;
    if (kind === 'special') fighter.focus = 0;
    fighter.action = { kind, began: this.time, contact: false, released: false, midCue: false };
    if (kind === 'heavy' || kind === 'special') this.emit({ type: 'cue', index, kind, name: move.name });
    return true;
  }

  setGuard(fighter, requested) {
    const blockStun = fighter.guard && fighter.reaction?.type === 'block';
    const guard = Boolean(requested && !fighter.action && !fighter.dash && fighter.stance > 0 &&
      (blockStun || this.time >= fighter.stunUntil));
    if (guard && !fighter.guard) fighter.guardedAt = this.time;
    fighter.guard = guard;
  }

  step(dt, input = {}) {
    if (this.clip) return;
    const playerMove = direction(input.horizontal || 0, input.depth || 0);
    if (!this.result) {
      if (input.attack) this.buffer.attack = { kind: input.attack, until: this.time + BUFFER_SECONDS };
      if (input.dash) this.buffer.dash = {
        direction: playerMove.x || playerMove.z ? playerMove : null, until: this.time + BUFFER_SECONDS,
      };
    }
    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - dt);
      return;
    }
    this.time += dt;
    const [player, opponent] = this.fighters;
    let opponentMove = { x: 0, z: 0 };
    if (!this.result) {
      // Refresh facing before reading attack inputs. Movement stays in screen space.
      this.face(player, opponent);
      this.face(opponent, player);
      this.setGuard(player, input.guard);
      const brain = this.computer();
      this.setGuard(opponent, brain.guard);
      const dash = this.buffer.dash;
      const attack = this.buffer.attack;
      if (dash && (this.time > dash.until || this.perform(PLAYER, 'dash', dash.direction))) {
        delete this.buffer.dash;
      }
      if (attack && (this.time > attack.until || this.perform(PLAYER, attack.kind))) delete this.buffer.attack;
      if (brain.attack) this.perform(1, brain.attack);
      opponentMove = relativeMove(opponent, brain.advance, brain.sidestep);
      const strength = Math.min(1, Math.hypot(brain.advance, brain.sidestep));
      opponentMove.x *= strength;
      opponentMove.z *= strength;
    }
    this.travel(player, dt, this.result ? { x: 0, z: 0 } : playerMove);
    this.travel(opponent, dt, opponentMove);
    this.separate();
    if (!this.result) this.advanceActions();
    if (!this.result && (player.hp <= 0 || opponent.hp <= 0 || this.remaining === 0)) {
      this.result = player.hp === opponent.hp ? 'draw' : player.hp > opponent.hp ? 'win' : 'lose';
      this.endedAt = this.time;
      this.emit({ type: 'roundEnd', index: player.hp >= opponent.hp ? 0 : 1, knockout: player.hp === 0 || opponent.hp === 0 });
    }
    if (this.time >= this.nextFrame) this.record();
    if (this.result && this.time >= this.endedAt + .62) {
      this.record();
      this.clip = this.makeClip();
    }
  }

  computer() {
    const [target, cpu] = this.fighters;
    const brain = this.ai;
    const set = ROSTER[cpu.id].moves;
    const distance = Math.hypot(cpu.x - target.x, cpu.z - target.z);
    const threat = target.action && ROSTER[target.id].moves[target.action.kind];
    const countdown = threat && target.action.began + threat.windup - this.time;
    if (cpu.dash || this.time < cpu.stunUntil) return { advance: 0, sidestep: 0, guard: cpu.guard };
    if (cpu.action?.kind === 'light' && cpu.action.connectedAt != null && this.time >= cpu.action.connectedAt + .065) {
      return { advance: 0, sidestep: 0, guard: false, attack: 'light' };
    }
    if (
      this.time >= brain.think && !cpu.action && threat && !target.action.released &&
      countdown > .085 && countdown < .28 && distance < threat.range + threat.step * .55
    ) {
      brain.think = this.time + .24;
      if (this.random() < .59) brain.guardUntil = this.time + countdown + .19;
    }
    if (this.time < brain.guardUntil) return { advance: 0, sidestep: 0, guard: true };
    if (this.time >= brain.think) {
      brain.think = this.time + .32 + this.random() * .33;
      if (this.random() < .48) brain.sidestep *= -1;
      brain.move = this.random() < .28 ? 'circle' : 'approach';
    }
    if (!cpu.action && this.time >= brain.nextAttack && distance < set.heavy.range + set.heavy.step * .53) {
      let kind = 'heavy';
      if (distance < set.light.range + set.light.step * .32 && this.random() < .66) kind = 'light';
      if (cpu.focus >= MAX_FOCUS && this.random() < .6) kind = 'special';
      brain.nextAttack = this.time + .70 + this.random() * .54;
      return { advance: 0, sidestep: 0, attack: kind, guard: false };
    }
    const preferred = set.light.range * .85;
    const advance = distance > preferred ? (brain.move === 'circle' ? .58 : .9) : distance < .98 ? -.44 : 0;
    return { advance, sidestep: brain.sidestep * (brain.move === 'circle' ? .59 : .14), guard: false };
  }

  face(fighter, target) {
    const action = fighter.action;
    if (this.time >= fighter.stunUntil &&
      (!action || this.time - action.began < ROSTER[fighter.id].moves[action.kind].windup * .39)) {
      fighter.heading = targetHeading(fighter, target);
    }
  }

  travel(fighter, dt, intent) {
    let x = 0;
    let z = 0;
    const { action, reaction, dash } = fighter;
    if (dash && this.time - dash.began >= DASH_DURATION) fighter.dash = null;
    if (reaction && this.time - reaction.at < reaction.duration + dt) {
      const progress = (time) => 1 - (1 - clamp((time - reaction.at) / reaction.duration, 0, 1)) ** 2.4;
      const speed = reaction.distance * (progress(this.time) - progress(this.time - dt)) / dt;
      x = reaction.x * speed;
      z = reaction.z * speed;
    } else if (fighter.dash) {
      const speed = ROSTER[fighter.id].dash * (1 - .63 * (this.time - dash.began) / DASH_DURATION);
      x = dash.x * speed;
      z = dash.z * speed;
    } else if (action && !this.result) {
      const move = ROSTER[fighter.id].moves[action.kind];
      const start = move.windup * .56;
      const duration = move.windup * .44 + move.active * .74;
      const progress = (time) => {
        const phase = clamp((time - action.began - start) / duration, 0, 1);
        return phase * phase * (3 - 2 * phase);
      };
      const speed = move.step * (progress(this.time) - progress(this.time - dt)) / dt;
      x = Math.sin(fighter.heading) * speed;
      z = Math.cos(fighter.heading) * speed;
    } else if (!this.result && this.time >= fighter.stunUntil) {
      const speed = ROSTER[fighter.id].speed * (fighter.guard ? .36 : 1);
      x = intent.x * speed;
      z = intent.z * speed;
    }
    fighter.x = clamp(fighter.x + x * dt, -BOX.x, BOX.x);
    fighter.z = clamp(fighter.z + z * dt, BOX.far, BOX.near);
    const walking = !action && !fighter.dash && this.time >= fighter.stunUntil && !this.result ?
      Math.min(1, Math.hypot(x, z) / 2.5) : 0;
    const blend = Math.min(1, dt * 14);
    const forward = Math.sin(fighter.heading) * intent.x + Math.cos(fighter.heading) * intent.z;
    const side = Math.cos(fighter.heading) * intent.x - Math.sin(fighter.heading) * intent.z;
    fighter.moving += (walking - fighter.moving) * blend;
    fighter.strafe += ((walking ? side : 0) - fighter.strafe) * blend;
    fighter.gait += dt * 12;
    if (walking && Math.abs(forward) > .09) fighter.travel = forward < 0 ? -1 : 1;
    if (!fighter.guard && this.time >= fighter.stanceReady) fighter.stance = Math.min(100, fighter.stance + dt * 22);
  }

  separate() {
    const [first, second] = this.fighters;
    const dx = second.x - first.x, dz = second.z - first.z;
    const distance = Math.hypot(dx, dz);
    if (distance >= MIN_SEPARATION) return;
    const vector = distance > .0001 ? direction(dx, dz) : { x: 1, z: 0 };
    const push = (MIN_SEPARATION - distance) / 2;
    first.x = clamp(first.x - vector.x * push, -BOX.x, BOX.x);
    first.z = clamp(first.z - vector.z * push, BOX.far, BOX.near);
    second.x = clamp(second.x + vector.x * push, -BOX.x, BOX.x);
    second.z = clamp(second.z + vector.z * push, BOX.far, BOX.near);
  }

  advanceActions() {
    const contacts = [];
    for (const [index, attacker] of this.fighters.entries()) {
      const action = attacker.action;
      if (!action) continue;
      const move = ROSTER[attacker.id].moves[action.kind];
      const elapsed = this.time - action.began;
      const strong = action.kind === 'heavy' || action.kind === 'special';
      if (!action.midCue && strong && elapsed >= move.windup * .54) {
        action.midCue = true;
        this.emit({ type: 'count', index, kind: action.kind });
      }
      if (!action.released && elapsed >= move.windup) {
        action.released = true;
        this.emit({ type: strong ? 'gong' : 'swing', index, kind: action.kind });
      }
      if (!action.contact && elapsed >= move.windup && elapsed < move.windup + move.active) {
        const target = this.fighters[1 - index];
        if (inRange(attacker, target, move)) {
          action.contact = true;
          contacts.push({ index, action, move, type: this.defense(attacker, target) });
        }
      }
      if (!action.contact && elapsed >= move.windup + move.active) {
        action.contact = true;
        if (strong) this.mark({ type: 'miss', index, kind: action.kind, name: move.name, priority: 1 });
      }
      if (elapsed >= move.total) attacker.action = null;
    }
    // Classify both contacts before applying recoil so attacks can trade on the same tick.
    for (const contact of contacts) this.resolve(contact);
    if (contacts.length) this.record();
  }

  defense(attacker, target) {
    if (target.dash) {
      const elapsed = this.time - target.dash.began;
      if (elapsed >= .036 && elapsed <= .195) return 'dodge';
    }
    if (!target.guard || Math.cos(targetHeading(target, attacker) - target.heading) < .25) return 'hit';
    return this.time - target.guardedAt <= .13 ? 'parry' : 'block';
  }

  react(fighter, source, type, strength, distance, duration, stun = duration) {
    const vector = direction(fighter.x - source.x, fighter.z - source.z);
    fighter.reaction = { at: this.time, type, strength, distance, duration, ...vector };
    fighter.stunUntil = this.time + stun;
    fighter.heading = targetHeading(fighter, source);
    fighter.action = null;
    fighter.dash = null;
    if (type !== 'block') fighter.guard = false;
  }

  resolve({ index, action, move, type }) {
    const attacker = this.fighters[index], target = this.fighters[1 - index];
    const { kind } = action;
    const strength = { light: 0, follow: 1, heavy: 2, special: 3 }[kind];
    const strong = strength >= 2;
    let freeze = 0;
    let priority = 2;
    if (type === 'dodge') {
      this.focus(target, 1);
      priority = index === 1 ? 6 : 3;
    } else if (type === 'parry') {
      this.focus(target, 2);
      this.react(attacker, target, 'parry', strength, .54, .24, .49);
      freeze = 5 / 60;
      priority = index === 1 ? 7 : 4;
    } else if (type === 'block') {
      target.stance = Math.max(0, target.stance - [16, 19, 48, 63][strength]);
      target.stanceReady = this.time + (target.stance > 0 ? .48 : .72);
      if (target.stance > 0) {
        target.hp = Math.max(1, target.hp - (strong ? 4 : 1));
        this.react(target, attacker, 'block', strength, strong ? .44 : .19, strong ? .16 : .09);
        freeze = (strong ? 4 : 2) / 60;
      } else {
        type = 'break';
        target.hp = Math.max(0, target.hp - Math.round(move.damage * .72));
        this.react(target, attacker, type, strength, .84, .34, .64);
        this.focus(attacker, 1);
        freeze = 6 / 60;
        priority = 6;
      }
    } else {
      if (kind !== 'follow') this.focus(attacker, 1);
      action.connectedAt = this.time;
      target.hp = Math.max(0, target.hp - move.damage);
      this.react(target, attacker, type, strength, [.23, .47, .88, 1.14][strength],
        [.17, .23, .32, .39][strength], [.29, .30, .38, .48][strength]);
      freeze = [3, 4, 6, 8][strength] / 60;
      priority = [3, 4, 5, 6][strength];
    }
    const knockout = target.hp === 0;
    if (knockout) {
      target.reaction.distance = Math.max(target.reaction.distance, 1.12);
      target.reaction.duration = .44;
      freeze = Math.max(freeze, 9 / 60);
      priority = 10;
    }
    const vector = direction(target.x - attacker.x, target.z - attacker.z);
    this.hitStop = Math.max(this.hitStop, freeze);
    this.mark({
      type, index, kind, name: move.name, priority, strength, freeze, knockout,
      combo: type === 'hit' && kind === 'follow' ? 2 : 0,
      x: target.x - vector.x * .34, z: target.z - vector.z * .34,
      dx: vector.x, dz: vector.z,
      y: type === 'dodge' ? .20 : target.id === 'liu' ? 1.04 : 1.20,
    });
  }

  focus(fighter, amount) { fighter.focus = Math.min(MAX_FOCUS, fighter.focus + amount); }

  emit(event) {
    const timed = { ...event, time: this.time };
    this.events.push(timed);
    this.onEvent(timed);
    return timed;
  }

  mark(event) {
    const timed = this.emit(event);
    if (this.highlight && this.highlight.event.priority > timed.priority) return;
    this.highlight = {
      event: timed,
      frames: this.frames.filter(frame => frame.time >= timed.time - 1.65),
    };
  }

  record() {
    if (this.frames.at(-1)?.time === this.time) return;
    const frame = { time: this.time, actors: this.fighters.map(snapshot) };
    this.frames.push(frame);
    while (this.frames.length && this.frames[0].time < this.time - REPLAY_SECONDS) this.frames.shift();
    if (this.highlight && frame.time - this.highlight.event.time <= 1.12) this.highlight.frames.push(frame);
    this.nextFrame = this.time + 1 / 33;
  }

  makeClip() {
    const frames = this.highlight?.frames ?? [...this.frames];
    const event = this.highlight?.event ?? null;
    const start = frames[0].time;
    const last = frames.at(-1).time;
    const end = Math.max(last, (event?.time ?? last) + .55);
    return { frames, event, start, end, events: this.events.filter(cue => cue.time >= start && cue.time <= last) };
  }
}

export function replayFrame(frames, time) {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle].time <= time) low = middle;
    else high = middle - 1;
  }
  const frame = frames[low];
  const following = frames[low + 1];
  if (!following) return frame.actors;
  const blend = clamp((time - frame.time) / Math.max(.001, following.time - frame.time), 0, 1);
  return frame.actors.map((fighter, index) => {
    const next = following.actors[index];
    const turn = next.heading - fighter.heading;
    return {
      ...fighter,
      x: fighter.x + (next.x - fighter.x) * blend,
      z: fighter.z + (next.z - fighter.z) * blend,
      heading: fighter.heading + Math.atan2(Math.sin(turn), Math.cos(turn)) * blend,
      gait: fighter.gait + (next.gait - fighter.gait) * blend,
      moving: fighter.moving + (next.moving - fighter.moving) * blend,
      strafe: fighter.strafe + (next.strafe - fighter.strafe) * blend,
    };
  });
}
