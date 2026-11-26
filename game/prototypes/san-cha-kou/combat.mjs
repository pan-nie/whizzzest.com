export const ROUND_SECONDS = 60;
export const MAX_FOCUS = 3;

export const ROSTER = {
  ren: {
    name: '任堂惠', speed: 2.9, dash: 7.8,
    moves: {
      light: { name: '试探刀', windup: .19, total: .46, range: 1.62, damage: 11, arc: .82, step: .46 },
      heavy: { name: '劈面刀', windup: .68, total: 1.13, range: 2.03, damage: 24, arc: .94, step: .65 },
      special: { name: '回身刀', windup: .55, total: .98, range: 2.30, damage: 32, arc: 1.38, step: 1.18 },
    },
  },
  liu: {
    name: '刘利华', speed: 3.22, dash: 9.0,
    moves: {
      light: { name: '贴身短刀', windup: .15, total: .38, range: 1.41, damage: 10, arc: .78, step: .52 },
      heavy: { name: '矮身撩刀', windup: .57, total: 1.00, range: 1.82, damage: 21, arc: 1.12, step: 1.04 },
      special: { name: '伏身掠步', windup: .46, total: .88, range: 2.04, damage: 29, arc: 1.22, step: 1.62 },
    },
  },
  gao: {
    name: '高宠', speed: 2.59, dash: 7.1,
    moves: {
      light: { name: '探枪', windup: .25, total: .56, range: 1.91, damage: 13, arc: .66, step: .42 },
      heavy: { name: '压台枪', windup: .80, total: 1.41, range: 2.61, damage: 30, arc: .76, step: .78 },
      special: { name: '挑车枪', windup: .68, total: 1.25, range: 2.92, damage: 39, arc: .85, step: .99 },
    },
  },
};

const PLAYER = 0;
const MIN_SEPARATION = .84;
const BOX = { x: 5.20, near: 2.62, far: -1.95 };
const DASH_DURATION = .27;
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

function actor(id, x, heading) {
  return {
    id, x, z: .43, heading, hp: 100, stance: 100, focus: 0, guard: false,
    guardedAt: -Infinity, action: null, dash: null, dashReady: 0, stunUntil: 0,
    hurtAt: -4, gait: 0, moving: 0, travel: 0,
  };
}

function snapshot(actor) {
  return {
    id: actor.id, x: actor.x, z: actor.z, heading: actor.heading, hp: actor.hp,
    stance: actor.stance, focus: actor.focus, guard: actor.guard,
    stunUntil: actor.stunUntil, hurtAt: actor.hurtAt, gait: actor.gait, moving: actor.moving,
    travel: actor.travel, action: actor.action && { ...actor.action }, dash: actor.dash && { ...actor.dash },
  };
}

export class Duel {
  constructor(player, opponent, { random = Math.random, onEvent = () => {} } = {}) {
    this.fighters = [actor(player, -1.91, Math.PI / 2), actor(opponent, 1.91, -Math.PI / 2)];
    this.random = random;
    this.onEvent = onEvent;
    this.time = 0;
    this.result = null;
    this.ai = { think: .32, nextAttack: .92, guardUntil: 0, sidestep: 1, move: 'approach' };
    this.frames = [];
    this.events = [];
    this.nextFrame = 0;
    this.highlight = null;
    this.clip = null;
    this.record();
  }

  get remaining() { return Math.max(0, ROUND_SECONDS - this.time); }

  perform(index, kind, advance = 0, sidestep = 0) {
    const fighter = this.fighters[index];
    if (this.result || fighter.action || fighter.dash || fighter.guard || this.time < fighter.stunUntil) return false;
    if (kind === 'dash') {
      if (this.time < fighter.dashReady) return false;
      const vector = relativeMove(fighter, advance || sidestep ? advance : -1, sidestep);
      fighter.dash = { began: this.time, ...vector };
      fighter.dashReady = this.time + .62;
      this.emit({ type: 'step', index });
      return true;
    }
    const move = ROSTER[fighter.id].moves[kind];
    if (!move || (kind === 'special' && fighter.focus < MAX_FOCUS)) return false;
    if (kind === 'special') fighter.focus = 0;
    fighter.action = { kind, began: this.time, landed: false, midCue: false };
    this.emit({ type: kind === 'light' ? 'swing' : 'cue', index, kind, name: move.name });
    return true;
  }

  setGuard(fighter, requested) {
    const guard = Boolean(requested && !fighter.action && !fighter.dash &&
      this.time >= fighter.stunUntil && fighter.stance > 0);
    if (guard && !fighter.guard) fighter.guardedAt = this.time;
    fighter.guard = guard;
  }

  step(dt, input = {}) {
    if (this.result) return;
    this.time += dt;
    const [player, opponent] = this.fighters;
    this.setGuard(player, input.guard);
    const brain = this.computer();
    this.setGuard(opponent, brain.guard);
    if (input.dash) this.perform(PLAYER, 'dash', input.advance, input.sidestep);
    if (input.attack) this.perform(PLAYER, input.attack);
    if (brain.attack) this.perform(1, brain.attack);
    this.travel(player, opponent, dt, input.advance || 0, input.sidestep || 0);
    this.travel(opponent, player, dt, brain.advance, brain.sidestep);
    this.separate();
    this.advanceActions();
    if (this.time >= this.nextFrame) this.record();
    if (player.hp <= 0 || opponent.hp <= 0 || this.remaining === 0) {
      this.result = player.hp === opponent.hp ? 'draw' : player.hp > opponent.hp ? 'win' : 'lose';
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
    if (
      this.time >= brain.think && !cpu.action && !cpu.dash && threat && !target.action.landed &&
      countdown > .10 && countdown < .35 && distance < threat.range + .26
    ) {
      brain.think = this.time + .24;
      if (this.random() < .63) brain.guardUntil = this.time + countdown + .14;
    }
    if (this.time < brain.guardUntil) return { advance: 0, sidestep: 0, guard: true };
    if (this.time >= brain.think) {
      brain.think = this.time + .32 + this.random() * .33;
      if (this.random() < .48) brain.sidestep *= -1;
      brain.move = this.random() < .28 ? 'circle' : 'approach';
    }
    if (!cpu.action && !cpu.dash && this.time >= brain.nextAttack && distance < set.heavy.range + .12) {
      let kind = 'heavy';
      if (distance < set.light.range - .08 && this.random() < .60) kind = 'light';
      if (cpu.focus >= MAX_FOCUS && this.random() < .6) kind = 'special';
      brain.nextAttack = this.time + .90 + this.random() * .65;
      return { advance: 0, sidestep: 0, attack: kind, guard: false };
    }
    const preferred = set.light.range * .78;
    const advance = distance > preferred ? (brain.move === 'circle' ? .61 : .87) : distance < .91 ? -.42 : 0;
    return { advance, sidestep: brain.sidestep * (brain.move === 'circle' ? .66 : .27), guard: false };
  }

  travel(fighter, target, dt, advance, sidestep) {
    const action = fighter.action;
    const move = action && ROSTER[fighter.id].moves[action.kind];
    if (!action || this.time - action.began < move.windup * .46) {
      fighter.heading = targetHeading(fighter, target);
    }
    let x = 0;
    let z = 0;
    if (fighter.dash) {
      if (this.time - fighter.dash.began < DASH_DURATION) {
        const speed = ROSTER[fighter.id].dash * (1 - .55 * (this.time - fighter.dash.began) / DASH_DURATION);
        x = fighter.dash.x * speed;
        z = fighter.dash.z * speed;
      } else {
        fighter.dash = null;
      }
    } else if (this.time >= fighter.stunUntil) {
      if (action) {
        const elapsed = this.time - action.began;
        if (elapsed >= move.windup * .60 && elapsed <= move.windup + .07) {
          const speed = move.step / (move.windup * .40 + .07);
          x = Math.sin(fighter.heading) * speed;
          z = Math.cos(fighter.heading) * speed;
        }
      } else if (advance || sidestep) {
        const vector = relativeMove(fighter, advance, sidestep);
        const speed = ROSTER[fighter.id].speed * Math.min(1, Math.hypot(advance, sidestep)) * (fighter.guard ? .40 : 1);
        x = vector.x * speed;
        z = vector.z * speed;
      }
    }
    fighter.x = clamp(fighter.x + x * dt, -BOX.x, BOX.x);
    fighter.z = clamp(fighter.z + z * dt, BOX.far, BOX.near);
    const walking = !fighter.action && !fighter.dash ? Math.min(1, Math.hypot(x, z) / 2.5) : 0;
    fighter.moving += (walking - fighter.moving) * Math.min(1, dt * 12);
    fighter.gait += dt * 12;
    fighter.travel = advance < -.25 ? -1 : 1;
    if (!fighter.guard) fighter.stance = Math.min(100, fighter.stance + dt * 20);
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
    const ready = [];
    for (const [index, attacker] of this.fighters.entries()) {
      const action = attacker.action;
      if (!action) continue;
      const move = ROSTER[attacker.id].moves[action.kind];
      const elapsed = this.time - action.began;
      if (!action.midCue && action.kind !== 'light' && elapsed >= move.windup * .55) {
        action.midCue = true;
        this.emit({ type: 'count', index, kind: action.kind });
      }
      if (!action.landed && elapsed >= move.windup) {
        action.landed = true;
        ready.push({ index, move, kind: action.kind });
      }
      if (elapsed >= move.total) attacker.action = null;
    }
    for (const { index, move, kind } of ready) this.resolve(index, move, kind);
  }

  resolve(index, move, kind) {
    const attacker = this.fighters[index], target = this.fighters[1 - index];
    const angle = targetHeading(attacker, target) - attacker.heading;
    const distance = Math.hypot(attacker.x - target.x, attacker.z - target.z);
    if (kind !== 'light') this.emit({ type: 'gong', index, kind });
    const inside = distance <= move.range && Math.cos(angle) >= Math.cos(move.arc);
    const dodging = target.dash && this.time - target.dash.began <= .245;
    if (!inside || dodging) {
      if (dodging && distance < move.range + .64) {
        this.focus(target, 1);
        this.mark({ type: 'dodge', index, kind, name: move.name, priority: index === 1 ? 6 : 3 });
      } else if (kind !== 'light') {
        this.mark({ type: 'miss', index, kind, name: move.name, priority: 1 });
      }
      return;
    }
    if (target.guard && Math.cos(targetHeading(target, attacker) - target.heading) > -.16) {
      if (this.time - target.guardedAt <= .185) {
        this.focus(target, 2);
        attacker.action = null;
        attacker.stunUntil = this.time + .57;
        attacker.hurtAt = this.time;
        this.mark({ type: 'parry', index, kind, name: move.name, priority: index === 1 ? 7 : 4 });
        return;
      }
      target.stance = Math.max(0, target.stance - (kind === 'light' ? 20 : 51));
      if (target.stance > 0) {
        target.hp = Math.max(1, target.hp - (kind === 'light' ? 2 : 5));
        this.mark({ type: 'block', index, kind, name: move.name, priority: 2 });
        return;
      }
      target.guard = false;
      target.stunUntil = this.time + .74;
      target.hurtAt = this.time;
      target.hp = Math.max(0, target.hp - Math.round(move.damage * .72));
      this.focus(attacker, 1);
      this.mark({ type: 'break', index, kind, name: move.name, priority: target.hp <= 0 ? 10 : 5 });
      return;
    }
    this.focus(attacker, 1);
    target.hp = Math.max(0, target.hp - move.damage);
    target.hurtAt = this.time;
    target.stunUntil = this.time + (kind === 'light' ? .23 : .39);
    target.action = null;
    this.mark({ type: 'hit', index, kind, name: move.name, priority: target.hp <= 0 ? 10 : kind === 'light' ? 3 : 5 });
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
    };
  });
}
