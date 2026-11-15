// Synthetic acoustic channel for tests: babble-ish noise, room echo, mixing.
export function rng(seed = 1) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
export function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
// speech-shaped noise: white -> one-pole lowpass ~800 Hz, 4 Hz syllable modulation
export function babble(n, sr, r, rms = 1) {
  const out = new Float32Array(n); const a = Math.exp(-2 * Math.PI * 800 / sr); let y = 0, y2 = 0;
  for (let i = 0; i < n; i++) { y = a * y + (1 - a) * gauss(r); y2 = a * y2 + (1 - a) * y; out[i] = y2 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * i / sr + 3 * Math.sin(i / sr))); }
  let p = 0; for (const v of out) p += v * v; const g = rms / Math.sqrt(p / n + 1e-20);
  for (let i = 0; i < n; i++) out[i] *= g; return out;
}
export function white(n, r, rms = 1) { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = gauss(r) * rms; return o; }
// exponential-decay reverb tail, energy ratio `wet` relative to direct, RT60 seconds
export function reverb(x, sr, r, wet = 1, rt60 = 1.0) {
  const L = Math.round(sr * rt60), ir = new Float32Array(L); const k = 6.9 / L; let e = 0;
  for (let i = Math.round(sr * 0.01); i < L; i++) { ir[i] = gauss(r) * Math.exp(-k * i); e += ir[i] * ir[i]; }
  const g = Math.sqrt(wet / e);
  // sparse FIR (decimated taps) to stay fast
  const out = Float32Array.from(x); const step = 23;
  for (let j = 0; j < L; j += step) { const h = ir[j] * g * Math.sqrt(step); if (!h) continue; for (let i = 0; i + j < x.length; i++) out[i + j] += h * x[i]; }
  return out;
}
export function addAt(dst, src, at, gain = 1) { for (let i = 0; i < src.length && at + i < dst.length; i++) if (at + i >= 0) dst[at + i] += gain * src[i]; }
export function rms(x) { let p = 0; for (const v of x) p += v * v; return Math.sqrt(p / x.length); }
