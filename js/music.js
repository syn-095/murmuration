// Generative band. Everything stays below ~1.1 kHz (the music bus is low-passed) so it never covers the
// 2-5 kHz bell band the devices use to talk.
//
// What a device plays depends on three things it worked out by ear:
//   the song (genre x section, agreed by the swarm), its role (dealt by the swarm), and the band size.
// A lone device is a one-man band; two devices split the arrangement; four or more play one part each,
// and duplicates of a part play a variation (harmony / arpeggio) instead of doubling.
import { SONGS } from './songs.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const pc = x => ((x % 12) + 12) % 12;

export function chordFor(songIdx, bar) {
  const s = SONGS[songIdx], scale = s.minor ? MINOR : MAJOR;
  const deg = s.prog[Math.floor(bar / 2) % 4];
  const note = k => { const d = deg + k; return s.root + scale[d % 7] + 12 * Math.floor(d / 7); };
  return { pcs: [note(0), note(2), note(4)], seventh: note(6), scale: scale.map(x => x + s.root), root: note(0),
    pent: (s.minor ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9]).map(x => x + s.root), genre: s.genre };
}

// chord tones from lo..hi (MIDI), used for the audible body of the bell songs: they arpeggiate the harmony
export function chordPool(songIdx, bar, lo = 72, hi = 88) {
  const ch = chordFor(songIdx, bar), pcs = ch.pcs.map(pc), out = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(pc(m))) out.push(m);
  return out;
}
export const midiToHz = mtof;

// which parts this device covers, given its role and the band size
export function duties(role, size, dup) {
  if (size <= 1) return { bass: 1, chords: 1, drums: 1, lead: 1, light: true };
  if (size === 2) return role === 0 || role === 3 ? { bass: 1, drums: 1 } : { lead: 1, chords: 1 };
  if (size === 3) return [{ bass: 1, drums: 1 }, { lead: 1 }, { chords: 1 }, { drums: 1, bass: 1 }][role];
  const d = [{ bass: 1 }, { lead: 1 }, { chords: 1 }, { drums: 1 }][role];
  if (dup) d.variant = true;
  return d;
}

function h(...xs) { let a = 2166136261; for (const x of xs) { a ^= (x * 2654435761) >>> 0; a = Math.imul(a, 16777619); } return ((a >>> 0) % 10007) / 10007; }

export class Music {
  constructor(ctx, out, { lift = 0 } = {}) {
    this.ctx = ctx; this.out = out;
    this.lift = lift;            // phones: bass an octave up, their speakers can't play the real thing
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.seed = Math.floor(Math.random() * 1000);
    this.mel = null;
  }

  tone(freq, t, dur, { type = 'triangle', gain = 0.2, attack = 0.005, release = 0.25, detune = 0 } = {}) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setTargetAtTime(0, t + Math.max(attack, dur - release), release / 3);
    o.connect(g).connect(this.out);
    o.start(t); o.stop(t + dur + release * 2);
  }
  kick(t, gain = 0.6) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + 0.3);
    this.tone(320, t, 0.03, { type: 'sine', gain: gain * 0.4, attack: 0.001, release: 0.03 });   // click for small speakers
  }
  noiseHit(t, { gain = 0.12, len = 0.06, freq = 900, q = 1.2 } = {}) {
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    s.connect(f).connect(g).connect(this.out); s.start(t, Math.random() * 0.5); s.stop(t + len + 0.02);
  }
  snare(t, gain = 0.3) { this.noiseHit(t, { gain, len: 0.14, freq: 950, q: 0.8 }); this.tone(190, t, 0.06, { type: 'triangle', gain: gain * 0.6, attack: 0.001, release: 0.05 }); }
  hat(t, gain = 0.07) { this.noiseHit(t, { gain, len: 0.03, freq: 1050, q: 2 }); }
  rim(t, gain = 0.18) { this.tone(820, t, 0.02, { type: 'square', gain: gain * 0.5, attack: 0.001, release: 0.02 }); this.noiseHit(t, { gain: gain * 0.6, len: 0.03, freq: 1000, q: 3 }); }

  // ev: { time, beat, bar, cycle, song, role }   band: { size, dup }
  beat(ev, { size = 1, dup = false } = {}, B = 0.5) {
    const { time: t, beat, bar, cycle, song, role } = ev;
    const ch = chordFor(song, bar), genre = ch.genre, d = duties(role, size, dup), L = d.light ? 0.7 : 1;
    const bassRoot = 36 + this.lift + pc(ch.root);
    const sw = genre === 1 ? 0.07 : 0;                 // lo-fi swing on the off-beat 8ths
    const off = t + B / 2 + sw;

    if (d.drums) this.drums(genre, t, off, beat, bar, cycle, B, L);
    if (d.bass) this.bass(genre, t, off, beat, bar, cycle, B, bassRoot, ch, L);
    if (d.chords) this.chords(genre, t, off, beat, bar, B, ch, L, d.variant);
    if (d.lead) this.lead(genre, t, beat, bar, cycle, song, B, ch, L, d.variant, sw);
    // a soft mid pluck on each downbeat so the swarm's sync is audible even on tiny speakers
    if (beat === 0 && !d.drums) this.tone(mtof(60 + pc(ch.root)), t, 0.08, { type: 'triangle', gain: 0.12, attack: 0.002, release: 0.06 });
  }

  drums(genre, t, off, beat, bar, cycle, B, L) {
    switch (genre) {
      case 0:   // dream pop: soft kick on 1 & 3, shaker
        if (beat === 0 || beat === 2) this.kick(t, (beat === 0 ? 0.6 : 0.45) * L);
        if (beat === 1 || beat === 3) this.noiseHit(t, { gain: 0.16 * L, len: 0.09, freq: 700 });
        this.noiseHit(off, { gain: 0.06 * L, len: 0.04, freq: 1000 });
        break;
      case 1:   // lo-fi boom-bap: kick 1 and the and-of-2, snare 2 & 4, lazy swung hats
        if (beat === 0) this.kick(t, 0.65 * L);
        if (beat === 1 && h(this.seed, cycle, bar) > 0.3) this.kick(off, 0.45 * L);
        if (beat === 1 || beat === 3) this.snare(t + 0.015, 0.28 * L);
        this.hat(t, 0.05 * L); this.hat(off, 0.035 * L);
        break;
      case 2:   // disco: four on the floor, open off-beat hats, clap on 2 & 4
        this.kick(t, 0.6 * L);
        this.hat(off, 0.1 * L); this.noiseHit(off, { gain: 0.05 * L, len: 0.12, freq: 1050, q: 1.5 });
        if (beat === 1 || beat === 3) this.snare(t, 0.26 * L);
        break;
      case 3:   // reggae one-drop: kick + rim on 3 only, light hats
        if (beat === 2) { this.kick(t, 0.6 * L); this.rim(t, 0.2 * L); }
        this.hat(t, 0.04 * L); this.hat(off, 0.05 * L);
        if (beat === 3 && h(this.seed, cycle, bar) > 0.6) this.rim(off, 0.12 * L);
        break;
    }
  }

  bass(genre, t, off, beat, bar, cycle, B, root, ch, L) {
    const n = (m, at, dur, g = 0.3) => {
      this.tone(mtof(m), at, dur, { type: 'triangle', gain: g * L, release: 0.1 });
      this.tone(mtof(m + 12), at, dur * 0.8, { type: 'sine', gain: g * 0.35 * L, release: 0.1 });
    };
    const fifth = root + 7;
    switch (genre) {
      case 0:   // long roots on 1 & 3
        if (beat === 0 || beat === 2) n(root, t, B * 1.7, 0.3);
        break;
      case 1:   // root, then a walk toward the next chord
        if (beat === 0) n(root, t, B * 1.2, 0.32);
        if (beat === 2) n(h(cycle, bar) > 0.5 ? fifth : root + 12, t, B * 0.6, 0.26);
        if (beat === 3) n(root + (h(bar, cycle, 3) > 0.5 ? 10 : 5), off, B * 0.4, 0.22);
        break;
      case 2:   // octave-jumping 8ths
        n(root, t, B * 0.4, 0.28); n(root + 12, off, B * 0.35, 0.24);
        break;
      case 3:   // deep, syncopated: rest on 1, notes on the and-of-1, 2, and-of-3
        if (beat === 0) n(root, off, B * 0.45, 0.34);
        if (beat === 1) n(root, t, B * 0.8, 0.3);
        if (beat === 2) n(fifth - 12 >= 28 ? fifth - 12 : fifth, off, B * 0.45, 0.28);
        if (beat === 3) n(root + 12, t, B * 0.4, 0.22);
        break;
    }
  }

  chords(genre, t, off, beat, bar, B, ch, L, variant) {
    const voice = (k, top = 67) => { let m = 60 + pc(k); if (m > top) m -= 12; return m; };
    const notes = ch.pcs.map(p => voice(p));
    if (genre === 1) notes.push(voice(ch.seventh, 71));                  // lo-fi: 7th chords
    const stab = (at, dur, g, type = 'triangle') => notes.forEach((m, i) =>
      this.tone(mtof(m), at, dur, { type, gain: g * L, attack: 0.004, release: Math.min(0.3, dur), detune: i * 3 - 3 }));
    if (variant) {   // duplicate chord player: 8th-note arpeggio an octave up
      const a = [...notes].sort((x, y) => x - y);
      this.tone(mtof(a[(beat * 2) % a.length] + 12), t, B * 0.4, { gain: 0.07 * L, release: 0.15 });
      this.tone(mtof(a[(beat * 2 + 1) % a.length] + 12), t + B / 2, B * 0.4, { gain: 0.06 * L, release: 0.15 });
      return;
    }
    switch (genre) {
      case 0:   // swelling pads, once per bar
        if (beat === 0) notes.forEach((m, i) => {
          this.tone(mtof(m), t, B * 4, { type: 'sine', gain: 0.09 * L, attack: 0.25, release: 0.5, detune: i * 4 - 4 });
          this.tone(mtof(m), t, B * 4, { type: 'triangle', gain: 0.04 * L, attack: 0.3, release: 0.5, detune: 7 });
        });
        break;
      case 1:   // warm electric-piano chords on 1 and the and-of-2
        if (beat === 0) stab(t, B * 1.3, 0.07, 'sine');
        if (beat === 1) stab(off, B * 0.9, 0.06, 'sine');
        break;
      case 2:   // short off-beat stabs
        if (beat === 1 || beat === 3) stab(off, 0.12, 0.08);
        break;
      case 3:   // the skank: short chops on every off-beat
        stab(off, 0.09, 0.08, 'square');
        break;
    }
  }

  lead(genre, t, beat, bar, cycle, song, B, ch, L, variant, sw) {
    // rhythmic motifs per genre (8 eighth-note slots per bar), stepwise pentatonic line landing on chord tones
    const PATS = {
      0: [[1,0,1,1,0,1,0,0],[1,0,0,1,0,0,1,0],[1,0,1,0,1,0,0,0],[0,0,1,0,1,0,1,1]],
      1: [[1,0,0,0,0,1,0,0],[0,0,1,0,0,0,1,0],[1,0,0,1,0,0,0,0],[0,1,0,0,1,0,0,0]],
      2: [[1,1,0,1,1,0,1,0],[1,0,1,1,0,1,1,0],[0,1,1,0,1,1,0,1],[1,1,1,0,1,0,1,0]],
      3: [[0,1,0,1,0,0,1,0],[1,0,0,0,1,0,1,0],[0,0,1,0,0,1,0,1],[1,0,1,0,0,0,0,0]],
    }[genre];
    const pat = PATS[Math.floor(h(this.seed, cycle, bar >> 1) * PATS.length)];
    const shift = variant ? -4 : 0, lo = 64 + shift, hi = 81 + shift, pool = [];
    for (let m = lo; m <= hi; m++) if (ch.pent.some(p => pc(m - p) === 0)) pool.push(m);
    if (this.mel == null || this.mel >= pool.length) this.mel = Math.floor(pool.length / 2);
    const type = genre === 3 ? 'square' : 'triangle', gainK = genre === 3 ? 0.5 : 1;
    for (let half = 0; half < 2; half++) {
      const slot = beat * 2 + half;
      if (!pat[slot]) continue;
      const r = h(this.seed + (variant ? 77 : 0), cycle, bar, slot);
      if (slot === 0) {   // downbeat: nearest chord tone
        let best = this.mel, bd = 99;
        pool.forEach((m, i) => { if (ch.pcs.some(p => pc(m - p) === 0) && Math.abs(i - this.mel) < bd) { bd = Math.abs(i - this.mel); best = i; } });
        this.mel = best;
      } else this.mel += r < 0.4 ? -1 : r < 0.8 ? 1 : (r < 0.9 ? -2 : 2);
      this.mel = Math.max(1, Math.min(pool.length - 2, this.mel));
      const long = slot === 7 || !pat[slot + 1];
      const at = t + half * (B / 2 + sw);
      const dur = genre === 1 && long ? B * 1.2 : long ? B * 0.8 : B * 0.4;
      this.tone(mtof(pool[this.mel]), at, dur, { type, gain: 0.17 * gainK * L, attack: 0.004, release: long ? 0.3 : 0.15 });
      if (!variant) this.tone(mtof(pool[this.mel] + 12), at, 0.06, { type: 'sine', gain: 0.03 * L, attack: 0.002, release: 0.05 });
    }
  }
}
