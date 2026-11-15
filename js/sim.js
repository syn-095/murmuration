// Virtual room: N agents, each with its own clock offset, output/input latency and position.
// Sound travels at 343 m/s; packets (slot songs and spare-bar extras alike) collide; loudness falls with distance; walls (partitions) block.
import { Agent, C, wrap } from './agent.js';
import { PACKET_DUR } from './modem.js';

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

export class World {
  constructor({ seed = 1, loss = 0.3, jitter = 0.002, range = 8, onLog = null } = {}) {
    this.rng = mulberry(seed);
    this.t = 0;                   // global time
    this.loss = loss; this.jitter = jitter; this.range = range;
    this.nodes = [];
    this.inflight = [];           // { from, emit (global), end, x, y, payload }
    this.deliveries = [];         // { at (global), to, ev }
    this.onLog = onLog;
    this.wall = null;             // x coordinate of a soundproof wall, or null
    this.events = [];             // recent visual events {type, from, to, t}
  }

  addNode({ x = this.rng() * 6, y = this.rng() * 4, O, I } = {}) {
    const idx = this.nodes.length;
    const node = {
      idx, x, y,
      offset: this.rng() * 1000,                  // local clock = global + offset
      O: O ?? 0.02 + this.rng() * 0.18,           // output latency
      I: I ?? 0.01 + this.rng() * 0.08,           // input latency
      deaf: false, txUntil: -1, beats: [],
    };
    node.agent = new Agent({ rng: mulberry(Math.floor(this.rng() * 1e9)), now: this.t + node.offset,
      onLog: m => this.onLog && this.onLog(idx, m) });
    this.nodes.push(node);
    return node;
  }

  blocked(a, b) { return this.wall != null && (a.x - this.wall) * (b.x - this.wall) < 0; }
  dist(a, b) { return Math.max(0.05, Math.hypot(a.x - b.x, a.y - b.y)); }

  step(dt) {
    const tEnd = this.t + dt;
    while (this.t < tEnd) {
      const h = Math.min(0.02, tEnd - this.t);
      this.t += h;
      for (const n of this.nodes) {
        const local = this.t + n.offset;
        for (const ev of n.agent.tick(local, 0.15)) {
          const g = ev.time - n.offset + n.O;              // global audible time
          if (ev.type === 'beat') { n.beats.push({ g, ...ev }); if (n.beats.length > 64) n.beats.shift(); }
          if (ev.type === 'tx' && !(n.quietUntil && this.t < n.quietUntil)) {
            this.inflight.push({ from: n.idx, emit: g, end: g + PACKET_DUR, payload: ev.payload, extra: !!ev.extra });
            n.txUntil = g + PACKET_DUR;
          }
        }
      }
      this.resolve();
      this.deliveries.sort((a, b) => a.at - b.at);
      while (this.deliveries.length && this.deliveries[0].at <= this.t) {
        const d = this.deliveries.shift();
        const n = this.nodes[d.to];
        const res = n.agent.onDetect(d.ev, this.t + n.offset);
        if (d.ev.ok && d.to !== d.from) this.events.push({ type: 'rx', from: d.from, to: d.to, t: this.t, kind: res && res.kind, extra: !!d.ev.extra });
      }
      if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    }
  }

  // once a packet has fully played, decide who decoded it
  resolve() {
    const done = this.inflight.filter(p => p.end + 0.2 < this.t);
    if (!done.length) return;
    this.inflight = this.inflight.filter(p => p.end + 0.2 >= this.t);
    this.recent = (this.recent || []).filter(p => p.end > this.t - 5);
    for (const p of done) this.recent.push(p);
    for (const p of done) {
      const src = this.nodes[p.from];
      for (const n of this.nodes) {
        if (n.deaf) continue;
        const self = n.idx === p.from;
        const d = self ? 0.05 : this.dist(src, n);
        if (!self && (this.blocked(src, n) || d > this.range)) continue;
        const arrive = p.emit + d / 343;
        // collisions: any other packet overlapping at this receiver (including ones still playing)
        let lostData = false, lostAll = false;
        for (const q of this.recent.concat(this.inflight)) {
          if (q === p) continue;
          const qs = this.nodes[q.from];
          const dq = q.from === n.idx ? 0.05 : this.dist(qs, n);
          if (q.from !== n.idx && (this.blocked(qs, n) || dq > this.range)) continue;
          const qa = q.emit + dq / 343;
          if (qa < arrive + PACKET_DUR && arrive < qa + PACKET_DUR) {
            const margin = 20 * Math.log10(dq / d);         // dB by which p is louder than q
            if (margin < 4) lostData = true;
            if (margin < 0 && Math.abs(qa - arrive) < 0.2) lostAll = true;
          }
        }
        const pLoss = self ? 0.05 : this.loss * Math.min(1, 0.5 + d / this.range);
        if (lostAll || this.rng() < pLoss * 0.5) continue;
        const ok = !lostData && this.rng() > pLoss;
        const tLocal = arrive + n.I + n.offset + (this.rng() - 0.5) * 2 * this.jitter;
        this.deliveries.push({ at: arrive + PACKET_DUR + 0.05, to: n.idx, from: p.from,
          ev: { ok, pkt: ok ? p.payload : null, t: tLocal, extra: p.extra } });
      }
      this.events.push({ type: 'tx', from: p.from, t: this.t, extra: p.extra });
    }
  }

  // audible beat-phase spread (ms) among a set of nodes, using their played grids
  spread(idxs = this.nodes.map(n => n.idx)) {
    const ph = idxs.map(i => { const n = this.nodes[i]; return n.agent.T0p - n.offset + n.O; });
    if (ph.length < 2) return 0;
    let worst = 0;
    for (let a = 0; a < ph.length; a++) for (let b = a + 1; b < ph.length; b++)
      worst = Math.max(worst, Math.abs(wrap(ph[a] - ph[b], C.CYCLE)));
    return worst * 1000;
  }
  songsAgree(idxs = this.nodes.map(n => n.idx)) { return new Set(idxs.map(i => this.nodes[i].agent.song)).size === 1; }
  slotsUnique(idxs = this.nodes.map(n => n.idx)) { const ids = idxs.map(i => this.nodes[i].agent.id); return !ids.includes(-1) && new Set(ids).size === ids.length; }
}
