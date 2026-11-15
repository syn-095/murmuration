// Murmuration acoustic modem: pure DSP, no Web Audio. Runs in the AudioWorklet, the browser and Node.
//
// A packet is a short bell melody on C major pentatonic (C7-E8):
//   2 preamble chords (C7+G7, then E7+C8)  -> its onset marks the sender's beat
//   13 data symbols, alternating tone set A (even) / B (odd), 2 bits each -> 26 bits
//   26 bits = 19 payload bits + CRC-7
// Alternating sets means the echo of one symbol never lands in the next symbol's bins.

export const SYM = 0.125;               // seconds per symbol: a 16th note at 120 BPM, so songs sit on the beat grid
export const N_PRE = 2, N_DATA = 13, N_SYM = N_PRE + N_DATA;
export const PACKET_DUR = N_SYM * SYM;  // 1.875 s, inside a 2 s bar
export const RAMP = 0.005;

//               C7      D7      E7      G7      A7      C8      D8      E8
export const F = [2093.0, 2349.3, 2637.0, 3136.0, 3520.0, 4186.0, 4698.6, 5274.0];
export const SET_A = [0, 2, 4, 6];      // C7 E7 A7 D8
export const SET_B = [1, 3, 5, 7];      // D7 G7 C8 E8
export const CHORD1 = [0, 3];           // C7 + G7
export const CHORD2 = [2, 5];           // E7 + C8
// Preamble order is information too: CHORD1 then CHORD2 = a device's own slot; CHORD2 then CHORD1 = an
// 'extra' song in a spare bar (its id field then holds the bar number, not the singer's id).
export const PRE = [[CHORD1, CHORD2], [CHORD2, CHORD1]];

// ---------- bits ----------
// payload: id 3 | role 2 | song 3 | gen 2 | mask 8 | spare 1  (19 bits)
// mask = the slots this sender has heard cleanly lately (acknowledgements; group size = 1 + popcount)
export const P_BITS = 19;
export function packPayload({ id, role, song, gen, mask = 0 }) {
  return ((id & 7) << 16) | ((role & 3) << 14) | ((song & 7) << 11) | ((gen & 3) << 9) | ((mask & 255) << 1);
}
export function unpackPayload(v) {
  const mask = (v >> 1) & 255;
  let size = 1; for (let m = mask; m; m &= m - 1) size++;
  return { id: (v >> 16) & 7, role: (v >> 14) & 3, song: (v >> 11) & 7, gen: (v >> 9) & 3, mask, size };
}
// ---------- messages: the spare bit set means "this song carries 3 characters of text" ----------
export const ALPHABET = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?.,:;'-+=/()<>@#&*%♥★♪☺☀✿☁";
export const isMessage = v => (v & 1) === 1;
export function packMessage(text) {
  const cs = [...text.toUpperCase()].map(c => Math.max(0, ALPHABET.indexOf(c)));
  while (cs.length < 3) cs.push(0);
  return (cs[0] << 13) | (cs[1] << 7) | (cs[2] << 1) | 1;
}
export function unpackMessage(v) {
  const at = i => ALPHABET[i] ?? '?';
  return (at((v >> 13) & 63) + at((v >> 7) & 63) + at((v >> 1) & 63)).trimEnd();
}
export function crc7(v, nbits) {        // poly x^7 + x^3 + 1, MSB first, init 0x7F (so all-zero isn't valid)
  let c = 0x7f;
  for (let i = nbits - 1; i >= 0; i--) {
    const b = ((v >> i) & 1) ^ ((c >> 6) & 1);
    c = (c << 1) & 0x7f;
    if (b) c ^= 0x09;
  }
  return c;
}
export function payloadToSymbols(p) {
  const word = (p << 7) | crc7(p, P_BITS);   // 26 bits
  const syms = [];
  for (let k = 0; k < N_DATA; k++) syms.push((word >> (2 * N_DATA - 2 - 2 * k)) & 3);
  return syms;
}
export function symbolsToPayload(syms) {
  let word = 0;
  for (const s of syms) word = (word << 2) | s;
  const p = word >> 7, c = word & 0x7f;
  return crc7(p, P_BITS) === c ? p : -1;
}
// tone indices to play for each of the 12 symbol slots
export function packetTones(p, extra = false) {
  const syms = payloadToSymbols(p);
  return [...PRE[extra ? 1 : 0], ...syms.map((s, k) => [(k % 2 ? SET_B : SET_A)[s]])];
}

// ---------- synthesis ----------
// body: a warm bell partial two octaves below each note (523-1318 Hz). It sits between the detector's
// bins, so it costs nothing in decoding, and it is what the ear hears as the 'voice'; the 2-5 kHz carrier
// becomes a shimmer on top.
// bodyHz (optional, 8 entries): the body pitch for each tone, e.g. chord tones of the bar being played,
// so the song arpeggiates the band's harmony. Must stay below the 2 kHz data band.
export function synthPacket(p, sr, amp = 0.45, body = 0, bodyHz = null, extra = false) {
  const tones = packetTones(p, extra);
  const n = Math.round(SYM * sr), ramp = Math.round(RAMP * sr);
  const out = new Float32Array(n * N_SYM);
  const phase = new Float64Array(F.length);   // keep phase continuous per tone (cleaner sound)
  for (let k = 0; k < N_SYM; k++) {
    const ts = tones[k], a = amp / ts.length;
    for (const t of ts) {
      const w = 2 * Math.PI * F[t] / sr;
      for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / ramp, (n - 1 - i) / ramp);
        out[k * n + i] += a * env * Math.sin(phase[t] + w * (k * n + i));
      }
      if (body) {
        const wb = bodyHz ? 2 * Math.PI * bodyHz[t] / sr : w / 4, ab = body / ts.length, tau = 0.09 * sr;
        for (let i = 0; i < n * 2 && k * n + i < out.length; i++) {      // rings into the next note a little
          const env = Math.min(1, i / ramp) * Math.exp(-i / tau);
          out[k * n + i] += ab * env * Math.sin(wb * i);
        }
      }
    }
  }
  return out;
}

// ---------- detection ----------
function goertzel(buf, start, len, mask, coef, win) {
  // buf is a ring buffer (length = mask+1, power of two)
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    const x = buf[(start + i) & mask] * (win ? win[i] : 1);
    const s0 = x + coef * s1 - s2; s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coef * s1 * s2;   // power
}

export class Detector {
  // onPacket({ ok, payload, tStart (sample index of preamble onset), conf, snr, extra })
  constructor(sr, onPacket) {
    this.sr = sr; this.onPacket = onPacket;
    this.N = Math.round(SYM * sr);
    this.hop = Math.round(this.N / 8);
    this.size = 1 << Math.ceil(Math.log2(sr * 4));   // 4 s ring
    this.mask = this.size - 1;
    this.buf = new Float32Array(this.size);
    this.pos = 0;                                    // absolute sample count written
    this.nextHop = this.N * 3;
    this.win = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.N - 1));
    this.coef = F.map(f => 2 * Math.cos(2 * Math.PI * f / sr));
    this.coefWide = F.map(f => [0.998, 1, 1.002].map(m => 2 * Math.cos(2 * Math.PI * f * m / sr)));
    this.frames = [];          // recent frames: { end, e: Float64Array(8) }
    this.floor = 1e-9;         // running noise floor (median tone energy)
    this.cand = null;          // best pending preamble candidate
    this.pending = [];         // aligned candidates waiting for full packet
    this.quietUntil = 0;       // absolute sample: ignore detections before this (after a decode)
    this.muteRanges = [];      // [start,end) absolute samples where we were transmitting
    this.stats = { frames: 0, cands: 0, ok: 0, bad: 0 };
  }

  push(samples) {
    for (let i = 0; i < samples.length; i++) this.buf[(this.pos + i) & this.mask] = samples[i];
    this.pos += samples.length;
    while (this.pos >= this.nextHop) { this.frame(this.nextHop); this.nextHop += this.hop; }
    this.flushPending();
  }

  energies(start, wide) {
    const e = new Float64Array(8);
    for (let t = 0; t < 8; t++) {
      if (wide) { let m = 0; for (const c of this.coefWide[t]) m = Math.max(m, goertzel(this.buf, start, this.N, this.mask, c, this.win)); e[t] = m; }
      else e[t] = goertzel(this.buf, start, this.N, this.mask, this.coef[t], this.win);
    }
    return e;
  }

  chordScore(e, chord, ignore = []) {
    const inn = Math.min(e[chord[0]], e[chord[1]]);
    let out = 0;
    for (let t = 0; t < 8; t++) if (!chord.includes(t) && !ignore.includes(t)) out = Math.max(out, e[t]);
    return { inn, ratio: inn / (out + 1e-12) };
  }

  frame(end) {
    const e = this.energies(end - this.N, false);
    this.stats.frames++;
    const sorted = Array.from(e).sort((a, b) => a - b);
    const med = (sorted[3] + sorted[4]) / 2;
    // floor follows the median slowly (faster downwards)
    this.floor = med < this.floor ? this.floor * 0.9 + med * 0.1 : this.floor * 0.995 + med * 0.005;
    this.frames.push({ end, e });
    if (this.frames.length > 40) this.frames.shift();
    const back = this.frames.length - 1 - 8;
    if (back < 0) return;
    const f1 = this.frames[back], f2 = this.frames[this.frames.length - 1];
    if (f2.end - f1.end !== this.N) return;
    const start = f1.end - this.N;
    const thr = this.floor * 12;
    let pass = false;
    for (let kind = 0; kind < 2; kind++) {
      const [A, Bc] = PRE[kind];
      const c1 = this.chordScore(f1.e, A), c2 = this.chordScore(f2.e, Bc, A);  // the first chord's echo is expected in the second window
      const ok = c1.ratio > 3 && c2.ratio > 3 && c1.inn > thr && c2.inn > thr && start >= this.quietUntil;
      if (!ok) continue;
      pass = true;
      const score = Math.min(c1.inn, c2.inn) * Math.min(c1.ratio, c2.ratio, 30);
      if (!this.cand || score > this.cand.score) this.cand = { start, score, kind, snr: Math.min(c1.inn, c2.inn) / this.floor, seen: end };
    }
    if (this.cand && end - this.cand.seen >= this.hop * 3) {   // candidate peak passed
      const c = this.cand; this.cand = null;
      this.stats.cands++;
      const t0 = this.refine(c.start, c.kind);
      this.pending.push({ t0, snr: c.snr, extra: c.kind === 1 });
      this.quietUntil = t0 + Math.round(this.N * (N_SYM - 0.5));
    } else if (this.cand && pass) this.cand.seen = end;
  }

  // fine onset: maximise rectangular-window chord amplitude (triangle-shaped peak), 0.5 ms steps
  refine(s, kind = 0) {
    const [CA, CB] = PRE[kind];
    const step = Math.max(1, Math.round(this.sr * 0.0005)), span = Math.round(this.N * 0.25);
    const amp = (st, t) => Math.sqrt(Math.max(0, goertzel(this.buf, st, this.N, this.mask, this.coef[t], null)));
    const sc = st => amp(st, CA[0]) + amp(st, CA[1]) + amp(st + this.N, CB[0]) + amp(st + this.N, CB[1])
      - 0.5 * (amp(st, CB[0]) + amp(st, CB[1]) + amp(st + this.N, CA[0]) + amp(st + this.N, CA[1]));
    let best = s, bs = -Infinity;
    for (let d = -span; d <= span; d += step) { const v = sc(s + d); if (v > bs) { bs = v; best = s + d; } }
    // parabolic interpolation around best
    const a = sc(best - step), b = bs, c = sc(best + step);
    const den = a - 2 * b + c;
    const off = den < 0 ? 0.5 * (a - c) / den : 0;
    return best + Math.max(-1, Math.min(1, off)) * step;
  }

  flushPending() {
    while (this.pending.length && this.pos >= this.pending[0].t0 + this.N * N_SYM + 4) {
      const { t0, snr, extra } = this.pending.shift();
      const s0 = Math.round(t0);
      const syms = []; let conf = Infinity;
      for (let k = 0; k < N_DATA; k++) {
        const e = this.energies(s0 + (N_PRE + k) * this.N, true);
        const set = k % 2 ? SET_B : SET_A;
        let bi = 0, b1 = -1, b2 = -1;
        for (let j = 0; j < 4; j++) { const v = e[set[j]]; if (v > b1) { b2 = b1; b1 = v; bi = j; } else if (v > b2) b2 = v; }
        syms.push(bi); conf = Math.min(conf, b1 / (b2 + 1e-12));
      }
      const p = symbolsToPayload(syms);
      const ok = p >= 0 && conf > 1.5;
      ok ? this.stats.ok++ : this.stats.bad++;
      if (!ok) this.quietUntil = Math.min(this.quietUntil, s0 + this.N * 3); // allow quick retry on a real packet
      this.onPacket({ ok, payload: ok ? p : -1, tStart: t0, conf, snr, extra });
    }
  }
}
