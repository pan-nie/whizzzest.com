import {
  ACESFilmicToneMapping, CanvasTexture, CircleGeometry, DirectionalLight, DoubleSide, FogExp2, Group,
  HemisphereLight, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry,
  RingGeometry, Scene, SRGBColorSpace, Sprite, SpriteMaterial, Vector3, WebGLRenderer,
  GLTFLoader, mergeGeometries,
} from './vendor/three-gltf.mjs';
import { DASH_DURATION, ROSTER } from './combat.mjs';
import { ImpactView } from './impact.mjs';

const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const ease = (p) => { const x = clamp(p, 0, 1); return x * x * (3 - 2 * x); };
const JOINTS = ['Torso', 'Head', 'ArmL', 'ArmR', 'ForeL', 'ForeR', 'HandL', 'HandR',
  'LegL', 'LegR', 'ShinL', 'ShinR', 'Flag0', 'Flag1', 'Flag2', 'Flag3'];

function texture(draw, w = 128, h = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  return map;
}

function nameplate(label, x, y, z, width, height) {
  const map = texture((ctx, w, h) => {
    ctx.fillStyle = '#f2d585';
    ctx.font = 'bold 114px "Songti SC", "Noto Serif CJK SC", SimSun, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#ffb54c';
    ctx.shadowBlur = 9;
    ctx.fillText(label, w / 2, h * .53);
  }, 576, 192);
  const sign = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map, transparent: true }));
  sign.position.set(x, y, z);
  return sign;
}

function staticMeshes(asset) {
  asset.updateMatrixWorld(true);
  const byMaterial = new Map();
  asset.traverse((obj) => {
    if (!obj.isMesh) return;
    const geometry = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone();
    geometry.applyMatrix4(obj.matrixWorld);
    for (const key of Object.keys(geometry.attributes)) {
      if (key !== 'position' && key !== 'normal') geometry.deleteAttribute(key);
    }
    if (!byMaterial.has(obj.material)) byMaterial.set(obj.material, []);
    byMaterial.get(obj.material).push(geometry);
  });
  const stage = new Group();
  for (const [material, pieces] of byMaterial) {
    stage.add(new Mesh(mergeGeometries(pieces), material));
    pieces.forEach(piece => piece.dispose());
  }
  return stage;
}

function markerGeometry(inner, outer, arc = Math.PI) {
  return new RingGeometry(inner, outer, 48, 1, -Math.PI / 2 - arc, arc * 2);
}

function floorMesh(geometry, material, y = .02) {
  const mesh = new Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

const TRAIL_SAMPLES = 9;
const BLADE = { ren: [.04, .83, .19], liu: [.04, .57, .17], gao: [0, 1.50, 1.12] };
const trailPoint = new Vector3();

function actorView(source, index, maps) {
  const model = source.clone(true);
  const group = new Group();
  const pivot = new Group();
  pivot.position.y = 1;
  model.position.y = -1;
  group.add(pivot);
  pivot.add(model);
  const joints = {};
  model.traverse((obj) => {
    const name = obj.name.replace(/(?:[._]?\d{3})$/, '');
    if (JOINTS.includes(name)) joints[name] = obj;
  });
  const elevation = joints.Torso.position.y;
  const marker = new Group();
  const color = index ? '#d15f4e' : '#80d3bf';
  const ring = floorMesh(markerGeometry(.446, .466), new MeshBasicMaterial({
    color, transparent: true, opacity: .68, depthWrite: false,
  }), .023);
  const shadow = floorMesh(new PlaneGeometry(1.96, 1.58), new MeshBasicMaterial({
    map: maps.shadow, transparent: true, depthWrite: false,
  }), .013);
  const tip = floorMesh(new CircleGeometry(.059, 5), new MeshBasicMaterial({ color }), .026);
  tip.position.z = .485;
  marker.add(shadow, ring, tip);

  const warning = new Group();
  const glow = new MeshBasicMaterial({ color: '#ffad55', transparent: true, opacity: .12, depthWrite: false });
  const line = new MeshBasicMaterial({ color: '#ffd581', transparent: true, opacity: .9, depthWrite: false });
  const moves = ROSTER[source.userData.fighterId].moves;
  const fans = Object.fromEntries(['heavy', 'special'].map(kind => {
    const fan = new Group();
    fan.add(floorMesh(markerGeometry(.02, 1, moves[kind].arc), glow, .025));
    fan.add(floorMesh(markerGeometry(.978, 1.006, moves[kind].arc), line, .027));
    warning.add(fan);
    return [kind, fan];
  }));
  const trail = new Mesh(new PlaneGeometry(1, 1, 1, TRAIL_SAMPLES - 1), new MeshBasicMaterial({
    map: maps.trail, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false,
  }));
  trail.visible = false;
  trail.frustumCulled = false;
  return { group, pivot, joints, elevation, marker, warning, fans, glow, line, trail };
}

function pose(view, fighter, time, preview) {
  const { joints, elevation, pivot } = view;
  const moving = fighter.moving;
  const sideways = Math.abs(fighter.strafe);
  const shift = fighter.strafe * moving;
  const gait = Math.sin(fighter.gait) * moving * fighter.travel * (1 - sideways * .64);
  const slide = Math.sin(fighter.gait) * shift * .24;
  const alive = fighter.hp > 0;
  const liu = fighter.id === 'liu';
  const gao = fighter.id === 'gao';
  const audience = Math.sin(fighter.heading);
  const breath = Math.sin(time * 3.2) * .022;
  let height = elevation + breath - (liu ? .09 : 0) + Math.abs(gait) * .019;
  let lean = liu ? .21 : .07;
  let twist = -.26 * audience;
  let roll = -shift * .14;
  let headX = -.07, headY = -twist * .57;
  let right = -.54 + gait * .19, rightSide = .49, rightTwist = -.34, rightFore = -.29;
  let left = -.44 - gait * .24, leftSide = -.30, leftTwist = .24, leftFore = -.43;
  let rightLeg = .12 + gait * .51, leftLeg = -.19 - gait * .51;
  let rightShin = .19 + Math.max(0, -gait) * .43;
  let leftShin = .13 + Math.max(0, gait) * .43;
  let wrist = gao ? .30 : -.09;
  let wristYaw = 0;
  let fall = 0;
  let legShift = shift * .21;
  const reaction = fighter.reaction;
  const reactionAge = reaction ? time - reaction.at : Infinity;

  if (preview) {
    rightSide = gao ? .27 : .46;
    right = -.72;
    rightFore = -.32;
  } else if (!alive) {
    fall = ease((reactionAge - .035) / .47);
    lean = -.49 * (1 - fall);
    roll = .24;
    headX = -.25 + fall * .55;
    rightSide = 1.15;
    leftSide = -.86;
    leftLeg = -.66 * (1 - fall);
    rightLeg = .35 * (1 - fall);
    rightShin = .12 + .59 * Math.sin(fall * Math.PI);
  } else if (reaction?.type !== 'block' && reactionAge < .49 && !fighter.action && !fighter.dash) {
    const hit = 1 - ease(reactionAge / (reaction.strength >= 2 || reaction.type !== 'hit' ? .49 : .26));
    const weight = reaction.strength >= 2 || reaction.type !== 'hit' ? 1 : .59;
    height -= hit * .14 * weight;
    lean -= hit * .76 * weight;
    twist += hit * .39;
    roll = hit * .26;
    rightSide += hit * .71;
    right += hit * .46;
    leftSide -= hit * .42;
    headX -= hit * .34;
    rightLeg += hit * .39;
    leftLeg -= hit * .37;
    leftShin += hit * .39;
  } else if (fighter.dash) {
    const motion = Math.sin(clamp((time - fighter.dash.began) / DASH_DURATION, 0, 1) * Math.PI);
    const { x, z } = fighter.dash;
    const forward = x * Math.sin(fighter.heading) + z * Math.cos(fighter.heading);
    const across = x * Math.cos(fighter.heading) - z * Math.sin(fighter.heading);
    height -= motion * (liu ? .37 : .24);
    lean += motion * forward * .59;
    roll = -motion * across * .56;
    legShift = motion * across * .29;
    rightLeg -= motion * (.49 + forward * .36);
    leftLeg += motion * forward * .62;
    rightShin += motion * .39;
    right = -.38;
    left = -.91;
  } else if (fighter.guard) {
    const recoil = reaction?.type === 'block' ? 1 - ease(reactionAge / .19) : 0;
    const raise = .55 + .45 * ease((time - fighter.guardedAt) / .07);
    height -= .11 + recoil * .06;
    lean = .21 - recoil * .45;
    twist -= .26 + recoil * .18;
    right = -.54 - .61 * raise;
    rightSide = .14 + recoil * .11;
    rightTwist = -.75;
    rightFore = -.64 + recoil * .25;
    left = -1.03;
    leftSide = -.19;
    leftFore = -.65;
    wrist = .08;
  } else if (fighter.action) {
    const attack = fighter.action;
    const move = ROSTER[fighter.id].moves[attack.kind];
    const elapsed = time - attack.began;
    const heavy = attack.kind === 'heavy';
    const special = attack.kind === 'special';
    const follow = attack.kind === 'follow';
    const strong = heavy || special;
    const reverse = follow || special ? -1 : 1;
    const launch = move.windup * .72;
    const extension = move.windup + move.active * .32;
    const wind = ease(elapsed / launch) * (1 - ease((elapsed - launch) / (extension - launch)));
    const strike = ease((elapsed - launch) / (extension - launch)) *
      (1 - ease((elapsed - extension) / (move.total - extension)));
    twist += reverse * (-wind * (gao ? .42 : strong ? 1.04 : .64) + strike * (gao ? .33 : .86));
    roll += reverse * (-wind * .15 + strike * .23);
    height += wind * (liu ? -.25 : heavy ? .085 : -.065) - strike * (liu ? .17 : .105);
    lean += strike * (gao ? .48 : .34) - wind * .22;
    right = -.54 + wind * (heavy && !liu && !gao ? -1.48 : .69) - strike * (gao ? .98 : 1.02);
    rightSide += wind * (follow ? -.36 : .61) - strike * (gao ? .42 : reverse * .62);
    rightTwist += wind * reverse * .86 - strike * reverse * .52;
    rightFore += wind * (gao ? -.84 : -.62) + strike * .26;
    wrist += strike * (special && gao ? .76 : gao ? .97 : heavy && !liu ? 1.19 : .84);
    wristYaw = reverse * (wind * .33 - strike * .58);
    left = -.44 - strike * (gao ? 1.02 : .56) - wind * .29;
    leftSide -= strike * (gao ? -.12 : .43);
    leftFore -= wind * .45;
    leftLeg -= strike * .58;
    rightLeg += wind * .37 + strike * .34;
    leftShin += strike * .42;
    headY = -twist * .64;
  }

  pivot.position.y = 1 - fall * .72;
  pivot.rotation.set(-fall * 1.43, 0, 0);
  joints.Torso.position.y = height;
  joints.Torso.rotation.set(lean, twist, roll);
  joints.Head.rotation.set(headX, headY, 0);
  joints.ArmR.rotation.set(right, rightTwist, rightSide);
  joints.ArmL.rotation.set(left, leftTwist, leftSide);
  joints.ForeR.rotation.x = rightFore;
  joints.ForeL.rotation.x = leftFore;
  joints.HandR.rotation.set(wrist, wristYaw, 0);
  joints.LegL.rotation.set(leftLeg, 0, -.16 + legShift - slide);
  joints.LegR.rotation.set(rightLeg, 0, .15 + legShift + slide);
  joints.ShinL.rotation.x = leftShin;
  joints.ShinR.rotation.x = rightShin;
  for (let i = 0; i < 4; i++) {
    if (!joints['Flag' + i]) continue;
    joints['Flag' + i].rotation.set(Math.sin(time * 5 + i * .75) * (.035 + moving * .12),
      twist * -.15, Math.cos(time * 4.7 + i) * .046);
  }
}

function bladeTrail(view, fighter, time, preview) {
  const { trail, joints } = view;
  const action = fighter.action;
  trail.visible = false;
  if (!action || preview) return;
  const move = ROSTER[fighter.id].moves[action.kind];
  const elapsed = time - action.began;
  const start = move.windup * .79;
  const end = move.windup + move.active + .055;
  if (elapsed <= start || elapsed > end) return;
  const [offset, tip, base] = BLADE[fighter.id];
  const positions = trail.geometry.attributes.position;
  for (let row = 0; row < TRAIL_SAMPLES; row++) {
    const past = row / (TRAIL_SAMPLES - 1);
    const sample = Math.max(start, elapsed - past * .088);
    pose(view, fighter, action.began + sample, false);
    joints.HandR.updateWorldMatrix(true, false);
    const width = (tip - base) * (.33 + .32 * (1 - past));
    [tip - width, tip].forEach((reach, index) => {
      trailPoint.set(offset, 0, reach).applyMatrix4(joints.HandR.matrixWorld);
      positions.setXYZ(row * 2 + index, trailPoint.x, trailPoint.y, trailPoint.z);
    });
  }
  positions.needsUpdate = true;
  trail.material.color.set(action.kind === 'special' ? '#ffae58' : action.kind === 'heavy' ? '#ffe6a5' : '#c2f4ec');
  trail.material.opacity = (1 - ease((elapsed - move.windup) / (end - move.windup))) * .86;
  trail.visible = true;
}

export class StageView {
  constructor(container) {
    this.container = container;
    this.scene = new Scene();
    this.scene.background = null;
    this.scene.fog = new FogExp2('#281820', .040);
    this.renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.17;
    this.renderer.domElement.setAttribute('aria-label', '三岔口 3D 戏台');
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.tabIndex = -1;
    container.prepend(this.renderer.domElement);
    this.camera = new PerspectiveCamera(33, 1, .05, 45);
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.framing = null;
    const sky = new HemisphereLight('#e6cebf', '#2b2232', 1.68);
    const key = new DirectionalLight('#ffe2bd', 3.35);
    key.position.set(-2.6, 6, 5);
    const rim = new DirectionalLight('#ffc184', 2.97);
    rim.position.set(1.8, 4.8, -4);
    const fill = new DirectionalLight('#9bd6f4', 1.27);
    fill.position.set(6.5, 3.6, 3);
    this.scene.add(sky, key, rim, fill);
    this.scene.add(nameplate('三 岔 口', 0, 4.72, -2.998, 2.48, .55));
    this.scene.add(nameplate('出将', -2.53, 4.31, -3.188, 1.16, .27));
    this.scene.add(nameplate('入相', 2.53, 4.31, -3.188, 1.16, .27));

    const radial = (stops) => texture((ctx, w, h) => {
      const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      for (const [stop, color] of stops) gradient.addColorStop(stop, color);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    });
    const lanternMap = radial([[0, '#ffdf9a88'], [.35, '#ffb55b36'], [.64, '#ec723b0c'], [1, '#ec723b00']]);
    for (const [x, y, z, size] of [[-5.2, 3.82, -2.40, 1.74], [5.2, 3.82, -2.40, 1.74], [3.86, 1.43, -2.29, .52]]) {
      const lantern = new Sprite(new SpriteMaterial({ map: lanternMap, depthWrite: false, toneMapped: false }));
      lantern.position.set(x, y, z);
      lantern.scale.setScalar(size);
      this.scene.add(lantern);
    }
    const wash = floorMesh(new PlaneGeometry(12, 6.7), new MeshBasicMaterial({
      map: radial([[0, '#efaa6120'], [.4, '#efaa6115'], [1, '#efaa6100']]),
      transparent: true, depthWrite: false, toneMapped: false,
    }), .009);
    wash.position.z = .36;
    this.scene.add(wash);
    this.maps = {
      shadow: radial([[0, '#10070bd7'], [.30, '#10070bc2'], [.65, '#10070b56'], [1, '#10070b00']]),
      trail: texture((ctx, w, h) => {
        const fade = ctx.createLinearGradient(0, 0, 0, h);
        fade.addColorStop(0, '#fff');
        fade.addColorStop(.42, '#ffffffae');
        fade.addColorStop(1, '#ffffff00');
        ctx.fillStyle = fade;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'destination-in';
        const edge = ctx.createLinearGradient(0, 0, w, 0);
        edge.addColorStop(0, '#ffffff00');
        edge.addColorStop(.69, '#ffffff1d');
        edge.addColorStop(.93, '#fff');
        edge.addColorStop(1, '#fff');
        ctx.fillStyle = edge;
        ctx.fillRect(0, 0, w, h);
      }),
    };
    this.impacts = [new ImpactView(this.scene), new ImpactView(this.scene)];
    this.assets = {};
    this.actors = [];
    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(container);
    this.resize();
  }

  async load() {
    const loader = new GLTFLoader();
    const names = ['stage', ...Object.keys(ROSTER)];
    const loaded = await Promise.all(names.map(name => loader.loadAsync(
      new URL('./models/' + name + '.glb', import.meta.url).href,
    )));
    names.forEach((name, index) => {
      this.assets[name] = loaded[index].scene;
      this.assets[name].userData.fighterId = name;
    });
    this.scene.add(staticMeshes(this.assets.stage));
  }

  setFighters(ids) {
    for (const old of this.actors) {
      this.scene.remove(old.group, old.marker, old.warning, old.trail);
      // The cloned actors share the assets' mesh buffers and materials.
      for (const group of [old.marker, old.warning, old.trail]) group.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.geometry.dispose();
      });
      for (const item of [...old.marker.children, old.trail]) item.material.dispose();
      old.glow.dispose();
      old.line.dispose();
    }
    this.framing = null;
    this.actors = ids.map((id, index) => actorView(this.assets[id], index, this.maps));
    this.actors.forEach(actor => this.scene.add(actor.group, actor.marker, actor.warning, actor.trail));
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  draw(actors, time, { preview = false, replay = false, delta = 0, effects = [] } = {}) {
    const [first, second] = actors;
    const depth = (first.z + second.z) / 2;
    const split = Math.abs(second.x - first.x);
    const horizontalFov = Math.tan(this.camera.fov * Math.PI / 360) * this.camera.aspect;
    const distance = Math.max(8.65, (split * .5 + 1.55) / horizontalFov + 1.05)
      + Math.max(0, depth) * .8 + Math.abs(second.z - first.z) * .32;
    const visibleHalfWidth = (distance - Math.max(first.z, second.z)) * horizontalFov;
    const panLimit = Math.max(2.80, 6.42 - visibleHalfWidth);
    const center = clamp((first.x + second.x) / 2, -panLimit, panLimit);
    if (!this.framing || this.framing.replay !== replay || replay) {
      this.framing = { center, depth, distance, replay };
    } else {
      const blend = 1 - Math.exp(-delta * 9);
      this.framing.center += (center - this.framing.center) * blend;
      this.framing.depth += (depth - this.framing.depth) * blend;
      this.framing.distance += (distance - this.framing.distance) * (distance > this.framing.distance ? blend : blend * .48);
    }
    const frame = this.framing;
    const shot = effects.find(({ event, age }) => event.type !== 'dodge' && age >= 0 && age < .24);
    const punch = shot && !this.reducedMotion.matches ?
      (.041 + shot.event.strength * .028 + (shot.event.knockout ? .067 : 0)) * (1 - shot.age / .24) ** 2 : 0;
    const joltX = punch ? Math.cos(shot.age * 53) * punch * shot.event.dx : 0;
    const joltY = punch ? Math.sin(shot.age * 59 + .65) * punch * .58 : 0;
    this.camera.position.set(frame.center + joltX, 3.88 + joltY, frame.distance - punch * 1.25);
    this.camera.lookAt(frame.center + joltX, 1.66 + joltY, frame.depth * .48 - .13);

    for (const [index, fighter] of actors.entries()) {
      const view = this.actors[index];
      view.group.position.set(fighter.x, .005, fighter.z);
      view.group.rotation.y = fighter.heading;
      view.marker.position.set(fighter.x, 0, fighter.z);
      view.marker.rotation.y = fighter.heading;
      view.marker.visible = fighter.hp > 0;
      bladeTrail(view, fighter, time, preview);
      pose(view, fighter, time, preview);

      const kind = fighter.action?.kind;
      const move = view.fans[kind] && ROSTER[fighter.id].moves[kind];
      const elapsed = move && time - fighter.action.began;
      view.warning.visible = Boolean(move && elapsed >= 0 && elapsed < move.windup + move.active && !preview);
      if (view.warning.visible) {
        const progress = elapsed / move.windup;
        const fade = progress <= 1 ? 1 : 1 - (elapsed - move.windup) / move.active;
        view.fans.heavy.visible = kind === 'heavy';
        view.fans.special.visible = kind === 'special';
        view.warning.position.set(fighter.x, 0, fighter.z);
        view.warning.rotation.y = fighter.heading;
        view.warning.scale.set(move.range, 1, move.range);
        view.glow.opacity = (.025 + Math.min(1, progress) * .13) * fade;
        view.line.opacity = (.34 + Math.min(1, progress) * .58) * fade;
      }
    }
    this.impacts.forEach((impact, index) => impact.draw(effects[index]));
    this.renderer.render(this.scene, this.camera);
  }
}
