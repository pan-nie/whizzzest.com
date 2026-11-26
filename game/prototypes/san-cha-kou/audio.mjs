export class Percussion {
  constructor() {
    this.enabled = true;
    this.context = null;
  }

  unlock() {
    if (!this.enabled) return;
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return;
    if (!this.context) {
      try {
        this.context = new Audio();
      } catch {
        return;
      }
      this.output = this.context.createGain();
      this.output.gain.value = .65;
      this.output.connect(this.context.destination);
      this.noise = this.context.createBuffer(1, this.context.sampleRate / 2, this.context.sampleRate);
      const buffer = this.noise.getChannelData(0);
      for (let index = 0; index < buffer.length; index++) buffer[index] = Math.random() * 2 - 1;
    }
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) this.unlock();
    if (this.context) this.output.gain.setTargetAtTime(enabled ? .65 : 0, this.context.currentTime, .018);
  }

  tone(time, frequency, end, gain, duration, shape = 'sine') {
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = shape;
    oscillator.frequency.setValueAtTime(frequency, time);
    oscillator.frequency.exponentialRampToValueAtTime(end, time + duration);
    envelope.gain.setValueAtTime(.001, time);
    envelope.gain.exponentialRampToValueAtTime(gain, time + .009);
    envelope.gain.exponentialRampToValueAtTime(.001, time + duration);
    oscillator.connect(envelope);
    envelope.connect(this.output);
    oscillator.start(time);
    oscillator.stop(time + duration + .02);
  }

  texture(time, frequency, gain, duration) {
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    source.buffer = this.noise;
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = .83;
    envelope.gain.setValueAtTime(gain, time);
    envelope.gain.exponentialRampToValueAtTime(.001, time + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.output);
    source.start(time);
    source.stop(time + duration + .02);
  }

  drum(time, deep) {
    this.tone(time, deep ? 176 : 286, deep ? 70 : 185, deep ? .27 : .09, .133, 'triangle');
    this.texture(time, deep ? 780 : 1710, deep ? .25 : .21, .064);
  }

  gong(time, small = false) {
    const base = small ? 425 : 239;
    const gain = small ? .032 : .09;
    const length = small ? .32 : .82;
    for (const [ratio, amplitude, decay] of [[1, 1, 1], [1.59, .65, .87], [2.17, .49, .63], [3.22, .39, .49], [4.28, .21, .24]]) {
      this.tone(time, base * ratio, base * ratio * .974, gain * amplitude, length * decay);
    }
    this.texture(time, small ? 2200 : 1680, small ? .12 : .23, .14);
  }

  play(type, strength = 0) {
    if (!this.enabled || this.context?.state !== 'running') return;
    const time = this.context.currentTime + .012;
    switch (type) {
      case 'begin':
        this.drum(time, true);
        this.drum(time + .11, false);
        this.gong(time + .23);
        break;
      case 'cue':
        this.drum(time, true);
        this.drum(time + .084, false);
        break;
      case 'count':
        this.drum(time, false);
        break;
      case 'gong':
        this.gong(time);
        break;
      case 'parry':
        this.gong(time, true);
        this.texture(time, 3340, .23, .071);
        break;
      case 'hit': {
        const heavy = strength >= 2;
        this.tone(time, heavy ? 132 : 180, heavy ? 43 : 77, heavy ? .29 : .17, heavy ? .19 : .10, 'triangle');
        this.texture(time, heavy ? 980 : 1530, heavy ? .26 : .17, heavy ? .095 : .063);
        if (heavy) this.texture(time + .007, 3100, .12, .06);
        break;
      }
      case 'break':
        this.tone(time, 166, 46, .29, .22, 'triangle');
        this.texture(time, 2170, .28, .15);
        this.drum(time + .048, true);
        break;
      case 'block':
        this.tone(time, 573, 493, .087, .10, 'triangle');
        this.texture(time, 2520, .19 + strength * .025, .083);
        break;
      case 'step':
      case 'dodge':
        this.texture(time, type === 'step' ? 530 : 1150, .080, .099);
        break;
      case 'swing':
        this.texture(time, strength ? 1440 : 1190, .077, .079);
        break;
      case 'roundEnd':
        this.drum(time, true);
        break;
      case 'complete':
        this.drum(time, true);
        this.gong(time + .13);
        break;
    }
  }
}
