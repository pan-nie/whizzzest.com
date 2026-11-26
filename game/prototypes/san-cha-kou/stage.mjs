import {
  ACESFilmicToneMapping, CanvasTexture, CircleGeometry, DirectionalLight, FogExp2, Group,
  HemisphereLight, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry,
  RingGeometry, Scene, SRGBColorSpace, Sprite, SpriteMaterial, Vector3, WebGLRenderer,
  GLTFLoader, mergeGeometries,
} from './vendor/three-gltf.mjs';
import { ROSTER } from './combat.mjs';

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

function actorView(source, index) {
  const group = source.clone(true);
  const joints = {};
  group.traverse((obj) => {
    const name = obj.name.replace(/(?:[._]?\d{3})$/, '');
    if (JOINTS.includes(name)) joints[name] = obj;
  });
  const elevation = joints.Torso.position.y;
  const marker = new Group();
  const color = index ? '#d15f4e' : '#80d3bf';
  const ring = floorMesh(markerGeometry(.465, .486), new MeshBasicMaterial({
    color, transparent: true, opacity: .84, depthWrite: false,
  }), .023);
  const shadow = floorMesh(new PlaneGeometry(1.96, 1.58), new MeshBasicMaterial({
    map: texture((ctx) => {
      const shade = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
      shade.addColorStop(0, 'rgba(13,5,6,.72)');
      shade.addColorStop(1, 'rgba(13,5,6,0)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, 128, 128);
    }), transparent: true, depthWrite: false,
  }), .013);
  const tip = floorMesh(new CircleGeometry(.059, 5), new MeshBasicMaterial({ color }), .026);
  tip.position.z = .485;
  marker.add(shadow, ring, tip);

  const warning = new Group();
  const glow = new MeshBasicMaterial({ color: '#ffad55', transparent: true, opacity: .12, depthWrite: false });
  const line = new MeshBasicMaterial({ color: '#ffd581', transparent: true, opacity: .9, depthWrite: false });
  const arc = ROSTER[source.userData.fighterId].moves.heavy.arc;
  warning.add(floorMesh(markerGeometry(.01, 1, arc), glow, .016));
  warning.add(floorMesh(markerGeometry(.984, 1.01, arc), line, .021));
  warning.visible = false;
  return { group, joints, elevation, marker, warning, glow, line };
}

function pose(view, fighter, time, preview) {
  const { joints, elevation } = view;
  const moving = fighter.moving;
  const gait = Math.sin(fighter.gait) * moving * fighter.travel;
  const alive = fighter.hp > 0;
  const liu = fighter.id === 'liu';
  const gao = fighter.id === 'gao';
  const breath = Math.sin(time * 3.2) * .022;
  let height = elevation + breath - (liu ? .09 : 0) + Math.abs(gait) * .019;
  let lean = liu ? .15 : .03;
  let twist = -.17;
  let roll = 0;
  let headX = -.05, headY = .16;
  let right = -.54 + gait * .19, rightSide = .49, rightTwist = -.34, rightFore = -.29;
  let left = -.44 - gait * .24, leftSide = -.30, leftTwist = .24, leftFore = -.43;
  let rightLeg = .10 + gait * .47, leftLeg = -.19 - gait * .47;
  let rightShin = .19 + Math.max(0, -gait) * .43;
  let leftShin = .13 + Math.max(0, gait) * .43;

  if (preview) {
    rightSide = .39;
    right = -.72;
    rightFore = -.32;
  } else if (!alive) {
    height = elevation * .43;
    roll = 1.02;
    headX = .47;
    rightSide = .98;
    left = -.15;
    leftLeg = -.88;
    rightLeg = -.50;
    rightShin = .80;
  } else if (time < fighter.stunUntil && time - fighter.hurtAt < .46) {
    const hit = 1 - ease((time - fighter.hurtAt) / .43);
    lean -= hit * .49;
    roll = hit * .28;
    rightSide += hit * .70;
    leftSide -= hit * .40;
    headX -= hit * .26;
  } else if (fighter.dash) {
    const motion = Math.sin(clamp((time - fighter.dash.began) / .27, 0, 1) * Math.PI);
    height -= motion * (liu ? .37 : .24);
    lean += motion * .54;
    roll = motion * .18;
    rightLeg -= motion * .86;
    leftLeg += motion * .59;
    right = -.38;
    left = -.91;
  } else if (fighter.guard) {
    height -= .096;
    lean = .17;
    twist = -.23;
    right = -1.01;
    rightSide = .12;
    rightTwist = -.75;
    rightFore = -.54;
    left = -1.03;
    leftSide = -.19;
    leftFore = -.65;
  } else if (fighter.action) {
    const attack = fighter.action;
    const move = ROSTER[fighter.id].moves[attack.kind];
    const elapsed = time - attack.began;
    const wind = elapsed < move.windup ? ease(elapsed / (move.windup * .66)) * (1 - ease((elapsed / move.windup - .68) / .32)) : 0;
    const impact = elapsed < move.windup
      ? ease((elapsed / move.windup - .67) / .33)
      : 1 - ease((elapsed - move.windup) / (move.total - move.windup));
    const heavy = attack.kind !== 'light';
    twist = -.15 - wind * (gao ? .84 : 1.10) + impact * (gao ? .39 : .94);
    roll = -wind * .17 + impact * .12;
    height += wind * (liu ? -.27 : .08) - impact * (liu ? .15 : .09);
    lean += impact * .43 - wind * .17;
    right = -.51 + wind * (heavy ? 1.09 : .43) - impact * (gao ? 1.15 : 1.30);
    rightSide += wind * (heavy ? .88 : .44) - impact * (gao ? .49 : .81);
    rightTwist += wind * .55 - impact * .34;
    rightFore -= wind * 1.05 - impact * .26;
    left = -.42 - impact * (gao ? 1.08 : .51) - wind * .28;
    leftSide -= impact * .35;
    leftFore -= wind * .37;
    leftLeg -= impact * .60;
    rightLeg += wind * .27 + impact * .26;
    leftShin += impact * .49;
    headY = -twist * .69;
  }

  joints.Torso.position.y = height;
  joints.Torso.rotation.set(lean, twist, roll);
  joints.Head.rotation.set(headX, headY, 0);
  joints.ArmR.rotation.set(right, rightTwist, rightSide);
  joints.ArmL.rotation.set(left, leftTwist, leftSide);
  joints.ForeR.rotation.x = rightFore;
  joints.ForeL.rotation.x = leftFore;
  joints.HandR.rotation.x = gao ? .30 : -.09;
  joints.LegL.rotation.set(leftLeg, 0, -.16);
  joints.LegR.rotation.set(rightLeg, 0, .15);
  joints.ShinL.rotation.x = leftShin;
  joints.ShinR.rotation.x = rightShin;
  for (let i = 0; i < 4; i++) {
    if (!joints['Flag' + i]) continue;
    joints['Flag' + i].rotation.set(Math.sin(time * 5 + i * .75) * (.035 + moving * .12),
      twist * -.15, Math.cos(time * 4.7 + i) * .046);
  }
}

export class StageView {
  constructor(container) {
    this.container = container;
    this.scene = new Scene();
    this.scene.background = null;
    this.scene.fog = new FogExp2('#291615', .024);
    this.renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.30;
    this.renderer.domElement.setAttribute('aria-label', '三岔口 3D 戏台');
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.tabIndex = -1;
    container.prepend(this.renderer.domElement);
    this.camera = new PerspectiveCamera(35, 1, .05, 45);

    const sky = new HemisphereLight('#f8d4ab', '#412326', 2.03);
    const key = new DirectionalLight('#ffdab2', 3.15);
    key.position.set(-2.5, 6.8, 6);
    const rim = new DirectionalLight('#f49767', 1.34);
    rim.position.set(-6, 4.0, -3);
    const fill = new DirectionalLight('#a9cfe3', .85);
    fill.position.set(6.5, 2.6, 3);
    this.scene.add(sky, key, rim, fill);
    this.scene.add(nameplate('三 岔 口', 0, 4.72, -2.998, 2.48, .55));
    this.scene.add(nameplate('出将', -2.53, 4.31, -3.188, 1.16, .27));
    this.scene.add(nameplate('入相', 2.53, 4.31, -3.188, 1.16, .27));

    const effectMap = texture((ctx) => {
      const shine = ctx.createRadialGradient(64, 64, 0, 64, 64, 59);
      shine.addColorStop(0, '#fff3c1');
      shine.addColorStop(.18, '#ffda79');
      shine.addColorStop(.63, 'rgba(255,123,45,.35)');
      shine.addColorStop(1, 'rgba(255,60,0,0)');
      ctx.fillStyle = shine;
      ctx.fillRect(0, 0, 128, 128);
      ctx.strokeStyle = '#ffe6ac';
      ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4 + .13;
        ctx.beginPath();
        ctx.moveTo(64 + Math.cos(a) * 16, 64 + Math.sin(a) * 16);
        ctx.lineTo(64 + Math.cos(a) * (i % 2 ? 45 : 58), 64 + Math.sin(a) * (i % 2 ? 45 : 58));
        ctx.stroke();
      }
    });
    this.spark = new Sprite(new SpriteMaterial({ map: effectMap, transparent: true, depthWrite: false }));
    this.spark.visible = false;
    this.scene.add(this.spark);
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
      this.scene.remove(old.group, old.marker, old.warning);
      // The cloned actors share the assets' mesh buffers and materials.
      for (const group of [old.marker, old.warning]) group.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.geometry.dispose();
        obj.material.map?.dispose();
        obj.material.dispose();
      });
    }
    this.actors = ids.map((id, index) => actorView(this.assets[id], index));
    this.actors.forEach(actor => this.scene.add(actor.group, actor.marker, actor.warning));
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  draw(actors, time, { preview = false, effect = null } = {}) {
    const center = (actors[0].x + actors[1].x) / 2;
    const split = Math.hypot(actors[1].x - actors[0].x, actors[1].z - actors[0].z);
    const distance = 11.85 + Math.max(0, 1.44 - this.camera.aspect) * 5.0
      + Math.max(0, split - 5.2) * .49;
    this.camera.position.set(center * .57 + .24, 6.0, distance);
    this.camera.lookAt(center * .69, 2.07, -.40);

    for (const [index, fighter] of actors.entries()) {
      const view = this.actors[index];
      view.group.position.set(fighter.x, .005, fighter.z);
      view.group.rotation.y = fighter.heading;
      view.marker.position.set(fighter.x, 0, fighter.z);
      view.marker.rotation.y = fighter.heading;
      view.marker.visible = !preview;
      pose(view, fighter, time, preview);

      const kind = fighter.action?.kind;
      const move = kind && ROSTER[fighter.id].moves[kind];
      const progress = move && (time - fighter.action.began) / move.windup;
      view.warning.visible = Boolean(kind && kind !== 'light' && progress >= 0 && progress < 1.16 && !preview);
      if (view.warning.visible) {
        const range = move.range;
        view.warning.position.set(fighter.x, 0, fighter.z);
        view.warning.rotation.y = fighter.heading;
        view.warning.scale.set(range, 1, range);
        view.glow.opacity = .05 + Math.min(1, progress) * .19;
        view.line.opacity = progress < 1 ? .45 + progress * .49 : .9 * (1.16 - progress) / .16;
      }
    }
    const sparkAge = effect ? time - effect.time : 3;
    this.spark.visible = sparkAge >= 0 && sparkAge < .26;
    if (this.spark.visible) {
      const [first, second] = actors;
      this.spark.position.copy(new Vector3((first.x + second.x) / 2, 1.14, (first.z + second.z) / 2));
      this.spark.scale.setScalar(.35 + sparkAge * 3.7);
      this.spark.material.opacity = 1 - sparkAge / .26;
      this.spark.material.color.set(effect.type === 'parry' ? '#83e5ce' : '#ffbf6c');
    }
    this.renderer.render(this.scene, this.camera);
  }
}
