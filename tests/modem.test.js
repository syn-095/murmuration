import { synthPacket, packPayload, unpackPayload, Detector, PACKET_DUR } from '../js/modem.js';
import { rng, babble, white, reverb, addAt, rms } from './channel.js';

const sr = 48000;
function run(label, { snrDb, wet = 0, rt60 = 0.8, trials = 40, collide = null, noise = 'babble', seed = 7 }) {
  const r = rng(seed); let ok = 0, wrong = 0, terr = [], missed = 0;
  for (let k = 0; k < trials; k++) {
    const pl = { id: k & 7, role: (k >> 1) & 3, song: (k * 3) & 7, gen: k & 3, mask: (k * 37) & 255 };
    const p = packPayload(pl);
    let sig = synthPacket(p, sr);
    const at = Math.round(sr * (0.7 + r() * 0.3));
    const n = at + sig.length + sr;
    const mix = new Float32Array(n);
    addAt(mix, sig, at);
    if (collide) { const q = synthPacket(packPayload({ ...pl, id: (pl.id + 3) & 7 }), sr); addAt(mix, q, at + Math.round(sr * collide.offset), Math.pow(10, -collide.db / 20)); }
    let room = wet ? reverb(mix, sr, r, wet, rt60) : mix;
    const sigRms = rms(sig);
    const nz = noise === 'babble' ? babble(n, sr, r, sigRms * Math.pow(10, -snrDb / 20)) : white(n, r, sigRms * Math.pow(10, -snrDb / 20));
    for (let i = 0; i < n; i++) room[i] += nz[i];
    const got = [];
    const d = new Detector(sr, e => got.push(e));
    for (let i = 0; i < n; i += 128) d.push(room.subarray(i, Math.min(n, i + 128)));
    const good = got.filter(e => e.ok);
    if (good.some(e => e.payload === p)) { ok++; terr.push(Math.abs(good.find(e => e.payload === p).tStart - at) / sr * 1000); }
    else missed++;
    wrong += good.filter(e => e.payload !== p && !(collide)).length;
  }
  terr.sort((a, b) => a - b);
  const med = terr.length ? terr[terr.length >> 1].toFixed(2) : '-', p90 = terr.length ? terr[Math.floor(terr.length * 0.9)].toFixed(2) : '-';
  console.log(`${label.padEnd(44)} decode ${(100 * ok / trials).toFixed(0).padStart(3)}%  falseAccept ${wrong}  timing med ${med} ms p90 ${p90} ms`);
  return ok / trials;
}
function falseAlarm(seconds = 60) {
  const r = rng(99); const n = sr * seconds; const nz = babble(n, sr, r, 0.1);
  let ok = 0, any = 0; const d = new Detector(sr, e => { any++; if (e.ok) ok++; });
  for (let i = 0; i < n; i += 128) d.push(nz.subarray(i, i + 128));
  console.log(`false alarm in ${seconds}s babble: candidates ${any}, accepted ${ok}`);
  return ok;
}
const t0 = Date.now();
const res = [
  run('clean', { snrDb: 30 }),
  run('babble 0 dB', { snrDb: 0 }),
  run('babble -10 dB', { snrDb: -10 }),
  run('babble -15 dB', { snrDb: -15 }),
  run('white -10 dB', { snrDb: -10, noise: 'white' }),
  run('-5 dB + reverb wet 1.0 RT 0.8', { snrDb: -5, wet: 1 }),
  run('-10 dB + reverb wet 1.0 RT 1.2', { snrDb: -10, wet: 1, rt60: 1.2 }),
  run('0 dB + reverb wet 3.0 RT 1.2', { snrDb: 0, wet: 3, rt60: 1.2 }),
  run('collision, other 6 dB weaker, +0.35 s', { snrDb: 0, collide: { db: 6, offset: 0.35 } }),
];
const fa = falseAlarm(60);
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (res[2] < 0.9 || fa > 0) { console.log('FAIL'); process.exit(1); } else console.log('PASS');
