import {
  CanvasTexture, Group, Mesh, MeshBasicMaterial, RingGeometry, Sprite, SpriteMaterial, SRGBColorSpace,
} from './vendor/three-gltf.mjs';

const COLORS = {
  hit: ['#fff3cc', '#ff9956'],
  block: ['#dff3ff', '#91c8f3'],
  parry: ['#effff2', '#69e2bd'],
  break: ['#fff2bd', '#ff7549'],
  dodge: ['#caf7eb', '#83c7b8'],
};

function mapFrom(draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  draw(canvas.getContext('2d'));
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  return map;
}

function sprite(map) {
  return new Sprite(new SpriteMaterial({ map, transparent: true, depthWrite: false, toneMapped: false }));
}

let flashMap;
let streakMap;

export class ImpactView {
  constructor(scene) {
    flashMap ??= mapFrom((ctx) => {
      const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 62);
      glow.addColorStop(0, '#fff');
      glow.addColorStop(.16, '#ffffffed');
      glow.addColorStop(.36, '#ffffff68');
      glow.addColorStop(.69, '#ffffff17');
      glow.addColorStop(1, '#ffffff00');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, 128, 128);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(6, 64);
      ctx.lineTo(57, 57);
      ctx.lineTo(64, 16);
      ctx.lineTo(71, 57);
      ctx.lineTo(122, 64);
      ctx.lineTo(71, 71);
      ctx.lineTo(64, 112);
      ctx.lineTo(57, 71);
      ctx.fill();
    });
    streakMap ??= mapFrom((ctx) => {
      const fade = ctx.createLinearGradient(0, 0, 128, 0);
      fade.addColorStop(0, '#ffffff00');
      fade.addColorStop(.68, '#ffffffcc');
      fade.addColorStop(1, '#fff');
      ctx.fillStyle = fade;
      ctx.beginPath();
      ctx.moveTo(2, 64);
      ctx.lineTo(112, 37);
      ctx.lineTo(127, 64);
      ctx.lineTo(112, 91);
      ctx.fill();
    });
    this.group = new Group();
    this.flash = sprite(flashMap);
    this.flash.renderOrder = 4;
    this.shards = Array.from({ length: 17 }, () => sprite(streakMap));
    this.shards.forEach(shard => { shard.renderOrder = 5; });
    this.ring = new Mesh(new RingGeometry(.87, 1, 44), new MeshBasicMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
    }));
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring, this.flash, ...this.shards);
    scene.add(this.group);
  }

  draw(impact) {
    this.group.visible = Boolean(impact && impact.age >= 0 && impact.age < .43);
    if (!this.group.visible) return;
    const { event, age } = impact;
    const { type, strength, knockout, x, y, z, dx, dz } = event;
    const [core, accent] = COLORS[type];
    const dodge = type === 'dodge';
    const clash = type === 'parry' || type === 'block';
    const surge = type === 'break' || knockout || strength >= 2;
    const weight = 1 + strength * .16 + (knockout ? .24 : 0);
    this.group.position.set(x, 0, z);
    this.flash.position.set(0, y, .035);
    this.flash.visible = !dodge && age < .16;
    this.flash.scale.set((.49 + age * 2.8) * weight, (.43 + age * 1.9) * weight, 1);
    this.flash.material.rotation = clash ? Math.PI * .22 : dx * .21;
    this.flash.material.opacity = Math.max(0, 1 - age / .16) ** 1.65;
    this.flash.material.color.set(core);

    this.ring.visible = (surge || dodge || type === 'parry') && age < .34;
    this.ring.position.set(dx * age * .52, .031, dz * age * .52);
    this.ring.scale.setScalar((.27 + age * 3.85) * weight);
    this.ring.material.color.set(accent);
    this.ring.material.opacity = Math.max(0, 1 - age / .34) * (dodge ? .55 : .44);

    this.shards.forEach((shard, index) => {
      const duration = .21 + (index % 5) * .046;
      const count = dodge ? 7 : surge ? 17 : 11;
      shard.visible = index < count && age < duration;
      if (!shard.visible) return;
      const angle = index * 2.39996 + event.index * .48;
      const speed = (1.25 + (index % 4) * .55) * weight;
      const drift = clash ? .24 : .64;
      const vx = (Math.cos(angle) + dx * drift) * speed;
      const vz = Math.sin(angle * 1.75) * 1.18 + dz * speed * drift;
      const vy = dodge ? .27 + index * .09 : (Math.sin(angle) * .78 + .45) * speed;
      const height = Math.max(.05, y + vy * age - 3.1 * age * age);
      const stretch = Math.max(.04, .20 + speed * .065 - age * .48);
      shard.position.set(vx * (age + .012), height, vz * (age + .012) + .045);
      shard.scale.set(stretch, stretch * (dodge ? .14 : .20), 1);
      shard.material.rotation = Math.atan2(vy - age * 3.1, vx);
      shard.material.color.set(index % 3 ? accent : core);
      shard.material.opacity = (1 - age / duration) ** .8 * .92;
    });
  }
}
