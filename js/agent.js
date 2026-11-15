// Murmuration agent: the brain of one musician. Pure logic, no audio or DOM.
// Time is the device's own clock in seconds (AudioContext time in the browser).
//
// Grid: 120 BPM, 4 beats per bar, 1 bar = 1 slot (2 s), 8 slots = 1 cycle (16 s, one chord progression).
// Each agent owns one slot (its id) and sings its packet on the first beat of that bar.
// Timing is never sent as data: a listener knows WHEN the preamble started and WHICH slot sent it.
// Latency: every agent hears its own packet, measuring R = output + input latency. Comparing a
// neighbour's arrival with your own arrival (both through the same mic) cancels the input path.
//
// Slot clashes: your own speaker drowns out anyone else in your slot, so a clash can only be heard
// on a bar you leave silent. A newcomer stays silent on its second turn to check its slot is really
// free, and settled members skip a turn now and then (SKIP_P) to catch clashes that slip through.
//
// Song changes are a two-cycle handshake carried in `gen` (2 bits). Settled songs have an even gen.
// A proposer bumps gen by 2 and announces it with gen-1 (odd) for one cycle, then gen (even) for
// one cycle, then everyone switches together at the same cycle boundary:
//   cycle k: "gen odd"  = switch at the end of NEXT cycle,   cycle k+1: "gen even" = switch at the end of THIS cycle.
// So a node gets two whole cycles of chances to hear about a change and still switches on time.

export const C = {
  BEAT: 0.5, BEATS_PER_BAR: 4, SLOTS: 8,
  get SLOT() { return this.BEAT * this.BEATS_PER_BAR; },
  get CYCLE() { return this.SLOT * this.SLOTS; },
  BIG: 0.040,        // larger errors are "snaps" (out of sync), smaller are tracked
  K: 0.3,            // tracking gain
  DEAD: 0.002,       // ignore errors below this
  TOF: 0.004,        // assumed time of flight bias (~1.3 m)
  SLEW: 0.030,       // max audible grid shift per beat
  JUMP: 0.150,       // bigger gaps jump instead of slewing
  NEAR: 0.250,       // a loner this close is probably a newcomer still guessing its latency
  SETTLED: 0.006,    // only transmit when played grid is this close to target
  R_GUESS: 0.12,     // round-trip latency guess before we have heard ourselves
  R_WIN: 7,
  PEER_TIMEOUT: 8,   // cycles without hearing a neighbour before we forget it (and free its slot and role)
  FRESH: 4,          // cycles a neighbour counts as 'in my group' after we last heard it in phase
  FOUND_AFTER: 1.0,  // cycles of total silence before founding a swarm (+1 if we hear garbled sound)...
  FOUND_JITTER: 0.5, // ...plus up to this many more, at random, so two devices started together don't both found
  LISTEN_MIN: 0,     // (unused now: we claim a slot right after the first packet, using its ack mask)
  LISTEN_MAX: 0,
  SKIP_P: 0.1,       // settled members stay silent on this fraction of their turns, to hear clashes
  MUTATE_S: 75,      // a group proposes a new song about this often (seconds)
  ROLES: ['bass', 'melody', 'pads', 'drums'],
  ROLE_ORDER: [0, 1, 2, 3, 2, 1, 3, 2],
};

export const wrap = (x, p) => x - p * Math.round(x / p);
const popcount = m => { let n = 0; for (; m; m &= m - 1) n++; return n; };
const lowestBit = m => { for (let k = 0; k < 8; k++) if (m & (1 << k)) return k; return 8; };
const barsOf = m => { const out = []; for (let k = 0; k < 8; k++) if (m & (1 << k)) out.push(k); return out; };
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// Songs (genre x section) live in songs.js; re-exported here for older imports.
export { SONGS, RELATED, GENRES } from './songs.js';
import { SONGS, RELATED, GENRES } from './songs.js';

export class Agent {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.now0 = opts.now ?? 0;
    this.onLog = opts.onLog || (() => {});
    this.id = -1;
    this.mode = 'listening';      // listening | founder | synced
    this.deaf = false;            // set by UI (mic muted)
    this.deafDetected = false;    // can't hear our own packets
    this.T0 = this.now0 + this.rng() * C.CYCLE;   // target grid epoch (start of a cycle)
    this.T0p = this.T0;           // played grid epoch
    this.beatNo = null;           // next beat index to schedule (relative to T0p)
    this.lastBeatTime = -Infinity;
    this.R = null; this.rS = [];
    this.peers = new Map();       // id -> { last, role, song, gen, size, mask, inPhaseAt, lastE }
    this.role = Math.floor(this.rng() * 4);
    this.song = Math.floor(this.rng() * 8);       // the song we are playing now
    this.prevSong = this.song;    // the song before our last switch
    this.G = 0;                   // settled gen of the song we're heading for (always even)
    this.adv = this.song;         // the song we're heading for (what we advertise)
    this.switchAt = null;         // cycle number at whose start we switch to `adv`
    this.lastChange = -99;        // cycle number of our last switch
    this.proposedAt = null;       // when we proposed the change we're heading for (if it's ours)
    this.lastTx = null; this.lastSelfHeard = null; this.selfMiss = 0;
    this.recentTx = [];           // my last few transmissions { t, id, extra }, to recognise their echoes
    this.extraHeard = new Map();  // bar -> { at, mask }: spare-bar songs heard lately
    this.listenStart = this.now0; this.heardAny = false; this.firstHeard = null;
    this.foundJit = this.rng(); this.foundedAt = -Infinity; this.claimAt = -Infinity;
    this.userProp = 0;            // >0 while a change the user asked for is pending (retries left + 1)
    this.crossAnn = false;        // pending change is a genre change, announced with the fast rule
    this.userHold = null;         // after it applies: { song, until (cycle), left (re-announcements) }
    this.snapCand = null;
    this.lonelyCycles = 0; this.cycleNo = 0; this.lastBoundary = -Infinity;
    this.missAck = 0; this.txSinceClaim = 0; this.verifyLeft = 0; this.selfGarbled = 0; this.garbledT = null;
    this.roleWant = null; this.roleWantN = 0;
    this.lastHeardAny = -Infinity; this.lastGarbled = -Infinity; this.lastClean = -Infinity;
    this.lastForeign = -Infinity; // last time we heard someone singing off our grid
    this.stats = { tx: 0, rx: 0, snaps: 0, nudges: 0, clashes: 0, extras: 0 };
  }

  log(msg) { this.onLog(msg); }
  get Rest() { return this.R ?? C.R_GUESS; }

  // advertised gen: odd during the first announcement cycle of a change
  get gen() { return this.genAt(this.id); }
  // gen to sing in bar `bar` (my slot or an extra)
  genAt(bar) {
    if (this.switchAt == null) return this.G;
    // a genre change (fast): odd only in a bar whose half-cycle rule names the same switch point
    if (this.crossAnn) return this.switchAt === this.fastAt(bar, this.cycleNo) ? (this.G + 3) & 3 : this.G;
    return this.switchAt - this.cycleNo >= 2 ? (this.G + 3) & 3 : this.G;
  }
  set gen(g) { this.G = (g + (g & 1)) & 3; }
  get pending() { return this.switchAt == null ? null : { song: this.adv, gen: this.G, at: this.switchAt }; }

  groupSize(now) {
    let n = 1;
    for (const [i, p] of this.peers) if (i !== this.id && p.inPhaseAt != null && now - p.inPhaseAt < C.FRESH * C.CYCLE) n++;
    return n;
  }

  heardMask(now) {
    let m = 0;
    for (const [i, p] of this.peers) if (p.inPhaseAt != null && now - p.inPhaseAt < C.FRESH * C.CYCLE && i !== this.id) m |= 1 << i;
    return m;
  }
  payload(now) {
    // until we've heard ourselves our timing may be off by our latency guess: claim no group,
    // so nobody follows us
    const mask = (this.R == null && this.stats.tx < 4) ? 0 : this.heardMask(now);
    let size = 1; for (let m = mask; m; m &= m - 1) size++;
    return { id: this.id, role: this.role, song: this.adv, gen: this.gen, mask, size };
  }
  // an extra: same state, but id = the bar it's sung in, and mask = my whole band including my own slot,
  // so a newcomer hearing just this one knows every taken slot
  extraPayload(now, bar) {
    const mask = this.payload(now).mask | (1 << this.id);
    return { id: bar, role: this.role, song: this.adv, gen: this.genAt(bar), mask, size: 1 + popcount(mask) };
  }

  // ---- extras: free bars filled with spare songs, 2 always left free for newcomers -------------
  // slots owned by my band as I see it: me, everyone in phase, everyone they ack
  owned(now) {
    let m = this.id >= 0 ? 1 << this.id : 0;
    for (const [i, p] of this.peers)
      if (i !== this.id && p.inPhaseAt != null && now - p.inPhaseAt < C.FRESH * C.CYCLE) m |= (1 << i) | (p.mask || 0);
    return m;
  }
  // the 2 spare bars among the free ones: the highest, and the one farthest round the cycle from it
  static spares(free) {
    if (free.length <= 2) return free.slice();
    const a = free[free.length - 1]; let b = -1, best = -1;
    for (const f of free) if (f !== a) { const d = Math.min((a - f + 8) % 8, (f - a + 8) % 8); if (d >= best) { best = d; b = f; } }
    return [a, b];
  }
  // the deal (same on every member that sees the same band): free bars minus spares, round-robin by slot
  static deal(owned) {
    const members = barsOf(owned), free = barsOf(~owned & 255), sp = Agent.spares(free);
    // (the bar after each spare stays quiet too: a newcomer's first song can run late by its latency guess)
    const guard = sp.map(b => (b + 1) % 8);
    const extras = free.filter(f => !sp.includes(f) && !guard.includes(f)), out = new Map();
    extras.forEach((b, k) => out.set(b, members[k % members.length]));
    return out;   // bar -> slot of the member who sings it
  }
  myExtras(now) {
    if (!this.canSingExtras(now)) return [];
    const d = Agent.deal(this.owned(now)), mine = [];
    for (const [b, who] of d) if (who === this.id) mine.push(b);
    return mine;
  }
  canSingExtras(now) {
    if (this.deaf || this.mode === 'listening' || this.id < 0 || this.verifyLeft > 0 || this.R == null) return false;
    // someone off our grid (another band, a knocked-out friend): leave the bars quiet so we can hear each other
    if (now - this.lastForeign < 2 * C.CYCLE) return false;
    if (Math.abs(wrap(this.T0 - this.T0p, C.CYCLE)) >= C.SETTLED) return false;
    // a lone founder fills the bars too (so newcomers find it fast), once it's been playing a little while
    // (off-grid sound, e.g. another loner, already stopped us above)
    if (this.mode === 'founder') return this.peers.size === 0 && now - this.foundedAt > C.CYCLE / 2;
    return this.groupSize(now) >= 2;
  }

  // slots we believe are taken: everyone heard lately, plus everyone they say they hear
  occupied(now) {
    let m = 0;
    for (const [i, p] of this.peers) {
      if (now - p.last < C.PEER_TIMEOUT * C.CYCLE) m |= 1 << i;
      if (p.mask && now - p.last < C.FRESH * C.CYCLE) m |= p.mask;
    }
    // (an extra's mask is its singer's whole band)
    for (const x of this.extraHeard.values()) if (now - x.at < 1.5 * C.CYCLE) m |= x.mask;
    return m;
  }

  // nearest local time at which slot `s` of the target grid starts, to time t
  slotStart(s, t) {
    const base = this.T0 + s * C.SLOT;
    return base + C.CYCLE * Math.round((t - base) / C.CYCLE);
  }

  // ev = { ok, pkt: {id,role,song,gen,mask,size} | null, t: local time the preamble onset was DETECTED (mic clock) }
  onDetect(ev, now) {
    this.lastHeardAny = now;
    // my own echo? (of my slot's song or of one of my extras: match the preamble kind and the id)
    const echo = this.recentTx.find(x => ev.t - x.t > -0.02 && ev.t - x.t < 0.6 && x.extra === !!ev.extra &&
        (!ev.ok || ev.pkt.id === x.id));
    if (echo) {
      if (ev.ok) {
        const r = ev.t - echo.t;
        this.rS.push(r); if (this.rS.length > C.R_WIN) this.rS.shift();
        const old = this.Rest; this.R = median(this.rS);
        // everything we lined up so far assumed the old latency: shift the grid by the difference
        const fix = this.mode === 'founder' ? 0 : old - this.R;
        this.T0 += fix;
        if (this.rS.length === 1)
          this.log(`heard myself: latency ${(this.R * 1000).toFixed(0)} ms` + (Math.abs(fix) > 0.005 ? `, shifted ${(fix * 1000).toFixed(0)} ms` : ''));
        this.lastSelfHeard = Math.max(this.lastSelfHeard ?? -Infinity, echo.t); this.selfMiss = 0; if (!echo.extra) this.selfGarbled = 0;
        if (this.deafDetected) { this.deafDetected = false; this.log('can hear again'); }
      } else if (!echo.extra && this.mode === 'founder' && this.peers.size === 0 && ++this.selfGarbled >= 2) {
        // alone, and my own song keeps coming back muffled: someone may be singing on top of me
        const old = this.id; this.repick(now, old); this.verifyLeft = 0; this.selfGarbled = 0;
        this.log(`my song keeps coming back muffled: moving to #${this.id}`);
      }
      return 'self';
    }
    if (this.deaf) return 'deaf';
    const t = ev.t - this.Rest - C.TOF;      // when the sender's sound left its speaker, on my clock (minus my output latency)
    if (!ev.ok) {
      this.lastGarbled = now; this.garbledT = t;
      if (Math.abs(wrap(t - this.T0, C.SLOT)) > C.NEAR) this.lastForeign = now;   // (closer: a newcomer's latency guess)
      // a packet starting right on MY slot while I kept quiet: someone else is singing there
      if (!ev.extra && this.mode !== 'listening' && Math.abs(wrap(t - this.slotStart(this.id, t), C.CYCLE)) < C.NEAR) {
        const old = this.id; this.stats.clashes++;
        this.repick(now, old);
        this.log(`someone else sings in slot #${old}: moving to #${this.id}`);
        return 'clash';
      }
      // preamble only: we don't know the slot, but it still tells us where their bars start. A loner lines
      // up its bars with it, so our packets stop overlapping theirs and we can decode each other
      const eb = wrap(t - this.T0, C.SLOT);
      // (not if it's nearly on our grid: that's probably a newcomer still guessing its latency)
      // (always if it trod on my own last packet: that will happen every cycle until one of us moves)
      const trod = this.lastTx != null && Math.abs(t - this.lastTx) < C.SLOT;
      if (this.mode !== 'synced' && this.groupSize(now) === 1 && Math.abs(eb) > C.NEAR && (trod || this.rng() < 0.6)) {
        this.T0 += eb;
        if (this.mode !== 'listening') {
          this.log(`heard a muffled neighbour: shifting my bars ${(eb * 1000).toFixed(0)} ms`);
          // if that packet clashed with mine, the shift puts my slot right on top of it: take another bar
          const b = ((Math.round((t - this.T0) / C.SLOT) % C.SLOTS) + C.SLOTS) % C.SLOTS;
          if (b === this.id) { this.repick(now, b); this.verifyLeft = 0; }
        }
        return 'align';
      }
      if (this.mode === 'synced') {
        const e = wrap(t - this.T0, C.SLOT);
        if (Math.abs(e) < C.BIG && Math.abs(e) > C.DEAD) this.T0 += C.K * 0.5 * e;
      }
      return 'preamble';
    }
    const p = ev.pkt;
    // An extra (spare-bar song): its id is the bar it was sung in, its mask the singer's whole band (acks plus
    // the singer's own slot). It gives timing and song news exactly like a primary, but it is not a device:
    // no peer entry, no acks, no group size, no slot clash.
    const extra = !!ev.extra;
    if (extra) this.extraHeard.set(p.id, { at: now, mask: p.mask });
    // a founder who has only just started and never heard anyone has nobody to drag along: it gives way at once
    const junior = this.mode === 'founder' && this.stats.rx === 0 && now - this.foundedAt < 2 * C.CYCLE;
    this.stats.rx++; this.heardAny = true; this.lastClean = now;
    if (this.firstHeard == null) this.firstHeard = now;
    if (!extra && p.id === this.id && this.mode !== 'listening') {
      // I can only hear this on a bar I left silent: someone else sings in my slot
      const old = this.id; this.stats.clashes++;
      this.repick(now, old);
      this.log(`someone else sings in slot #${old}: moving to #${this.id}`);
    }
    const e = wrap(t - this.slotStart(p.id, t), C.CYCLE);
    const theirs = extra ? Math.max(1, popcount(p.mask)) : p.size, mine = this.groupSize(now);
    const peer = extra ? {} : this.peers.get(p.id) || {};
    if (!extra) {
      Object.assign(peer, { last: now, role: p.role, song: p.song, gen: p.gen, size: p.size, mask: p.mask });
      if (this.id >= 0 && p.mask != null) { this.heardThisCycle = true; if (p.mask & (1 << this.id)) this.ackedThisCycle = true; }
      this.peers.set(p.id, peer);
    }
    // (tie-break by slot: an extra stands for its band's lowest slot)
    const theirId = extra ? lowestBit(p.mask) : p.id;
    let result;
    const wasIn = peer.inPhaseAt != null && now - peer.inPhaseAt < C.FRESH * C.CYCLE;
    // (if I haven't heard myself yet either, my own guess adds to the error)
    if (!extra && Math.abs(e) > C.BIG && Math.abs(e) < (this.R != null ? C.NEAR : 2 * C.NEAR) && p.mask === 0 && this.mode !== 'listening') {
      // a newcomer on my grid that hasn't heard itself yet, so it's out by its latency guess. It fixes
      // that as soon as it hears this very packet: welcome it now instead of making it wait a cycle.
      if (peer.inPhaseAt == null || now - peer.inPhaseAt > C.FRESH * C.CYCLE) this.log(`#${p.id} is joining in`);
      peer.inPhaseAt = now;
      if (this.mode === 'founder') this.mode = 'synced';
      result = 'welcome';
    } else if (Math.abs(e) > C.BIG) {
      this.lastForeign = now;
      const shouldFollow = this.mode === 'listening' || junior || theirs > mine || (theirs === mine && theirId < this.id);
      if (shouldFollow) {
        // a single wild timing estimate shouldn't yank a synced node: need two that agree
        // (from anyone: everyone in the other group sits on the same grid)
        // A loner can trust one. But a loner just a little out (< NEAR) is probably a newcomer trying
        // to sit on MY grid with an untested latency guess: let them fix themselves.
        const loner = mine === 1 && (theirs > 1 || Math.abs(e) > C.NEAR);
        const agree = this.snapCand && Math.abs(wrap(e - this.snapCand.e, C.CYCLE)) < 0.03 && now - this.snapCand.at < 4 * C.CYCLE;
        // (if they're only a little out, wait until they've had time to measure their latency)
        // we both count each other but sit a little apart (e.g. two founders that welcomed each other as
        // newcomers): don't wait, the deal (bigger group, then lower slot) is the same on both sides
        const mutual = wasIn && (p.mask & (1 << this.id)) && Math.abs(e) < C.NEAR;
        const confirmed = this.mode === 'listening' || junior || loner || mutual || theirs >= 2 * mine ||
          (agree && (Math.abs(e) > C.NEAR || now - this.snapCand.at > 1.5 * C.CYCLE));
        if (confirmed) {
          this.T0 += e; this.snapCand = null; this.stats.snaps++;
          for (const q of this.peers.values()) q.inPhaseAt = null;
          peer.inPhaseAt = now;
          this.log(extra ? `joined the band (${theirs}) by its spare-bar song: jumped ${(e * 1000).toFixed(0)} ms`
            : `joined #${p.id}'s group (${theirs}): jumped ${(e * 1000).toFixed(0)} ms`);
          this.joinSong(p, now, t);
          if (this.mode === 'founder') {
            // a lone founder has nobody relying on its slot: take the soonest free one, like a newcomer
            this.mode = 'synced';
            const old = this.id, next = Math.floor((now + 0.3 - this.T0) / C.SLOT) + 1;
            this.id = this.pickSlot(now, -1, ((next % C.SLOTS) + C.SLOTS) % C.SLOTS);
            this.txSinceClaim = 0; this.verifyLeft = 1; this.missAck = 0; this.claimAt = now;
            if (this.id !== old) this.log(`taking slot #${this.id}`);
          } else if (this.mode !== 'listening') {
            this.mode = 'synced';
            // (their mask may still list my slot from before I drifted off, so only trust a direct clash)
            const other = this.peers.get(this.id);
            if ((!extra && p.id === this.id) || (other && now - other.last < C.FRESH * C.CYCLE)) {
              const old = this.id; this.repick(now, old); this.log(`slot #${old} is taken here: moving to #${this.id}`);
            } else { this.verifyLeft = Math.max(this.verifyLeft, 1); this.claimAt = now; this.txSinceClaim = 0; }   // one quiet turn to check, once welcomed
          }
          result = 'snap';
        } else { if (!agree) this.snapCand = { e, at: now, from: p.id }; result = 'snap?'; }
      } else result = 'ignore';
    } else {
      this.maybeHop(p, now, t);
      // (not toward someone still guessing their latency, unless we're guessing too)
      if (Math.abs(e) > C.DEAD && !(p.mask === 0 && this.R != null && this.mode !== 'listening')) { this.T0 += C.K * e; this.stats.nudges++; }
      if (!extra) {
        peer.inPhaseAt = now;
        if (this.mode === 'founder') { this.mode = 'synced'; this.log(`#${p.id} is with me: we're a band`); }
      }
      this.considerSong(p, now, t);
      result = 'track';
    }
    peer.lastE = e;
    return { kind: result, e, from: p.id, extra };
  }

  // ---- song agreement -------------------------------------------------------------------------
  // what a packet says, as (settled gen, song, cycle number at whose start to switch)
  songView(p, now, t) {
    const odd = p.gen & 1;
    // which cycle did this packet belong to? (a slot-7 packet is decoded around the next downbeat)
    const s0 = this.slotStart(p.id, t);
    const cycleEnd = s0 + (C.SLOTS - p.id) * C.SLOT;
    const late = this.lastBoundary > cycleEnd - 0.5 || now > cycleEnd ? 1 : 0;
    // a genre change can only come from a person (spontaneous changes stay in the genre), so it uses the
    // fast rule: switch at the half-cycle point named by the announcing packet's slot (see fastAt)
    const fast = !!odd && SONGS[p.song].genre !== SONGS[this.song].genre;
    const pc = this.cycleNo - late;
    return { G: (p.gen + odd) & 3, S: p.song, fast, at: fast ? this.fastAt(p.id, pc) : pc + (odd ? 2 : 1) };
  }

  // Fast (genre) changes switch at a half-cycle point (bar 0 or bar 4), at least a bar after the announcing
  // packet has been decoded: slots 0-2 -> bar 4 of that cycle, 3-6 -> the next downbeat, 7 -> bar 4 of the
  // next cycle. Returned in cycle numbers (x.5 = bar 4).
  fastAt(slot, cycle) { return cycle + (slot <= 2 ? 0.5 : slot <= 6 ? 1 : 1.5); }
  // where we are now, in the same units
  pos(now) { return this.cycleNo + (now >= this.lastBoundary + C.CYCLE / 2 - 0.2 ? 0.5 : 0); }
  // my next turn's switch point (if my turn this cycle has passed, next cycle's)
  myFastAt(now) {
    let best = Infinity;
    for (const b of [this.id, ...this.myExtras(now)])
      best = Math.min(best, this.fastAt(b, this.lastBoundary + b * C.SLOT > now + 0.2 ? this.cycleNo : this.cycleNo + 1));
    return best;
  }

  // seconds until the pending song change (or null). For the UI's countdown.
  switchEta(now) {
    if (this.switchAt == null) return null;
    return Math.max(0, this.lastBoundary + (this.switchAt - this.cycleNo) * C.CYCLE - now);
  }

  considerSong(p, now, t) {
    const v = this.songView(p, now, t);
    const d = (v.G - this.G) & 3;
    if (d === 2 && (p.gen & 1)) {
      this.adopt(v, now);                                               // a fresh proposal (odd gen) is always news
    } else if (d === 2) {
      // We just switched to what a person picked, but they're still on the old song: they missed every
      // announcement. Announce it again (same gen, a fresh odd one for them) rather than being outvoted
      const h = this.userHold;
      if (h && h.song === this.song && this.cycleNo <= h.until && h.left > 0 && this.switchAt == null && v.S !== this.song) {
        h.left--; this.adv = this.song; this.crossAnn = true; this.switchAt = this.myFastAt(now);
        this.log(`reminding the band: ${GENRES[SONGS[this.song].genre]}!`);
        return;
      }
      // newer, or a straggler that missed the last change? If we're mid-change or just changed, we
      // know: they're the straggler. Otherwise go with what most neighbours said in the last cycle.
      if (this.switchAt != null || this.cycleNo - this.lastChange <= 2) return;
      let mine = 0, theirs = 0;
      for (const [i, q] of this.peers) {
        if (i === this.id || q.inPhaseAt == null || now - q.inPhaseAt > C.CYCLE) continue;
        const g = (q.gen + (q.gen & 1)) & 3;
        if (g === this.G) mine++; else if (g === v.G) theirs++;
      }
      // (a tie goes to a genre change: only a person makes those, so it's the newer choice)
      const cross = SONGS[v.S].genre !== SONGS[this.song].genre;
      if (mine > theirs || (mine === theirs && !cross && this.adv <= v.S)) return;
      if (cross) { v.at = this.pos(now) + 0.5; v.fast = true; }   // they've switched already: catch up at the next half-cycle
      this.adopt(v, now);
    } else if (d === 0) {
      // two proposals at once: a genre change (someone tapped a button) beats a change within the
      // genre (a spontaneous one); otherwise the lowest song wins
      const recent = this.switchAt != null || this.cycleNo - this.lastChange <= 3;
      const base = SONGS[this.switchAt != null ? this.song : this.prevSong].genre;
      const cross = s => SONGS[s].genre !== base;
      const win = recent && cross(v.S) !== cross(this.adv) ? cross(v.S) : v.S < this.adv;
      if (v.S !== this.adv && win) this.adopt(v, now);
      else if (v.S === this.adv && this.switchAt != null && v.at < this.switchAt) this.adopt(v, now);   // they're ahead of me
    }
  }

  adopt(v, now) {
    this.proposedAt = null; this.userProp = 0; this.userHold = null; this.joining = false;
    const fresh = v.S !== this.adv;
    this.G = v.G; this.adv = v.S; this.switchAt = v.at; this.crossAnn = !!v.fast;
    if (fresh && v.S !== this.song) this.log(SONGS[v.S].genre !== SONGS[this.song].genre
      ? `the band's going ${GENRES[SONGS[v.S].genre]}!` : `heard a proposal: ${SONGS[v.S].name} coming up`);
    if (this.switchAt <= this.pos(now)) this.applySwitch();
  }

  joinSong(p, now, t) {
    this.proposedAt = null; this.userProp = 0; this.joining = true; this.crossAnn = false;
    const v = this.songView(p, now, t);
    this.G = v.G; this.adv = v.S; this.switchAt = Math.max(v.at, this.cycleNo + 1);
    if (this.mode === 'listening') this.song = v.S;   // nothing audible to change from yet
  }

  applySwitch() {
    if (this.adv !== this.song) { this.log(`key change → ${SONGS[this.adv].name}`); this.prevSong = this.song; }
    // after a genre change (anyone's, not just the proposer's) remind anyone still on the old song
    if (this.userProp || this.crossAnn) this.userHold = { song: this.adv, until: this.cycleNo + 4, left: 2 };
    // (catching up with the band I just joined isn't a band change: don't let it shield me from the majority)
    this.song = this.adv; this.switchAt = null; this.lastChange = this.joining ? -99 : this.cycleNo; this.userProp = 0; this.joining = false;
    this.crossAnn = false;
  }

  // A person tapped a genre (or song) button. The band switches together on the same beat; it also works
  // alone, and wins against a spontaneous change proposed at the same moment (see considerSong). A genre
  // change is fast: announced on my next turn, it lands at the next half-cycle point after it (see fastAt),
  // usually 6-20 s after the tap. A change within the genre uses the normal two-cycle handshake.
  propose(song, now) {
    song = ((Math.floor(song) % SONGS.length) + SONGS.length) % SONGS.length;
    if (song === this.adv && (this.switchAt != null || song === this.song)) return false;   // already on it
    const cross = SONGS[song].genre !== SONGS[this.song].genre;
    this.log(cross ? `switching the band to ${GENRES[SONGS[song].genre]}` : `switching to ${SONGS[song].name}`);
    if (this.mode === 'listening') { this.song = this.adv = song; this.switchAt = null; return true; }  // nothing to agree yet
    this.proposedAt = now; this.userProp = 3;
    if (cross) {
      if (this.switchAt == null) this.G = (this.G + 2) & 3;   // (on top of a pending change: take it over, same gen)
      this.adv = song; this.crossAnn = true;
      this.switchAt = this.groupSize(now) < 2 ? this.pos(now) + 0.5 : this.myFastAt(now);
      return true;
    }
    if (this.switchAt != null) {
      // a change is already on its way: take it over (same gen, same downbeat). Bumping gen again would
      // wrap round (it's only 2 bits) and look like a straggler; the genre change wins the tie-break
      this.adv = song;
      return true;
    }
    this.adv = song; this.G = (this.G + 2) & 3;
    // alone: next downbeat. Otherwise two cycles' notice
    this.switchAt = this.cycleNo + (this.groupSize(now) < 2 ? 1 : this.notice(now));
    return true;
  }

  // two whole cycles of notice, counted from a cycle in which my turn is still to come
  notice(now) { return this.lastBoundary + this.id * C.SLOT > now + 0.2 ? 2 : 3; }

  // ---- slots ----------------------------------------------------------------------------------
  pickSlot(now, avoid = -1, soonFrom = null) {
    const occ = this.occupied(now) | (avoid >= 0 ? 1 << avoid : 0);
    let pool = [...Array(C.SLOTS).keys()].filter(i => !(occ & (1 << i)));
    if (!pool.length) pool = [...Array(C.SLOTS).keys()].filter(i => i !== avoid);
    // joining a band: take one of the 2 spare bars it keeps free (the others are full of its extras)
    const base = this.occupied(now);
    let sp = null;
    if (base) {
      sp = Agent.spares(barsOf(~base & 255)).filter(b => b !== avoid);
      if (sp.length) pool = sp; else sp = null;
    }
    if (soonFrom != null && pool.length > 1) {
      // newcomer: take a free slot that comes round soon, so we hear ourselves (and lock) quickly
      pool.sort((a, b) => ((a - soonFrom + C.SLOTS) % C.SLOTS) - ((b - soonFrom + C.SLOTS) % C.SLOTS));
      return this.rng() < (sp ? 0.85 : 0.7) ? pool[0] : pool[1];
    }
    return pool[Math.floor(this.rng() * pool.length)];
  }

  repick(now, avoid = -1) {
    this.id = this.pickSlot(now, avoid);
    this.txSinceClaim = 0; this.verifyLeft = 2; this.missAck = 0; this.claimAt = now;
  }

  // Newcomer: my first song went out, the band has sung since (time enough to have heard it) and doesn't
  // list me, so they missed it. Rather than wait a whole cycle, hop once to the other spare bar if it comes sooner.
  maybeHop(p, now, t) {
    if (this.mode !== 'synced' || this.txSinceClaim !== 1 || this.hopped === this.claimAt || this.lastTx == null) return;
    if (t - this.lastTx < 3.5 || t - this.lastTx > C.CYCLE - 1 || (p.mask & (1 << this.id))) return;
    const occ = this.occupied(now) & ~(1 << this.id);
    const other = Agent.spares(barsOf(~occ & 255)).find(b => b !== this.id);
    if (other == null) return;
    const ahead = b => ((this.slotStart(b, now) - now) % C.CYCLE + C.CYCLE) % C.CYCLE;
    if (ahead(other) < 0.3 || ahead(other) > ahead(this.id)) return;
    this.hopped = this.claimAt; const old = this.id; this.id = other; this.txSinceClaim = 0;
    this.log(`nobody caught my first song: trying bar #${other} instead of #${old}`);
  }

  // has everyone in my group sung since I took my slot, listing me?
  ackedByAll(now) {
    let any = false;
    for (const [i, p] of this.peers) {
      if (i === this.id || p.inPhaseAt == null || now - p.inPhaseAt > C.FRESH * C.CYCLE) continue;
      if (p.last < this.claimAt || !(p.mask & (1 << this.id))) return false;
      any = true;
    }
    return any;
  }

  readyToClaim(now) {
    const waited = now - this.listenStart;
    if (this.firstHeard == null) {
      // silence for a while (randomised, so two devices started together don't both found): found a
      // swarm. Garbled sound: someone's there, give it another cycle
      const heardSomething = this.lastHeardAny > this.listenStart;
      return waited > (C.FOUND_AFTER + C.FOUND_JITTER * this.foundJit + (heardSomething ? 1 : 0)) * C.CYCLE;
    }
    // one clean packet is enough: its ack mask says which slots are taken. The silent check turns
    // and the missing-ack rule catch anyone it didn't list
    return now - this.firstHeard >= C.LISTEN_MIN;
  }

  // Called often. Returns events with times between now and now+ahead:
  //   { type:'beat', time, beat (index in bar), bar (0-7 in cycle), cycle, song, role }   and   { type:'tx', time, payload }
  tick(now, ahead = 0.15) {
    const out = [];
    if (this.beatNo == null) this.beatNo = Math.ceil((now + 0.05 - this.T0p) / C.BEAT);
    for (let guard = 0; guard < 16; guard++) {
      let t = this.T0p + this.beatNo * C.BEAT;
      if (t > now + ahead) break;
      // move played grid toward target
      const d = wrap(this.T0 - this.T0p, C.BEAT * C.BEATS_PER_BAR * C.SLOTS);
      if (Math.abs(d) > C.JUMP) this.T0p += d;
      else this.T0p += Math.max(-C.SLEW, Math.min(C.SLEW, d));
      // keep T0 and T0p numerically close (T0 may have moved by whole cycles)
      this.T0 = this.T0p + wrap(this.T0 - this.T0p, C.CYCLE);
      // re-derive the beat index so the next beat is after the last one we played
      this.beatNo = Math.ceil((Math.max(now, this.lastBeatTime + C.BEAT * 0.5) - this.T0p) / C.BEAT - 1e-9);
      t = this.T0p + this.beatNo * C.BEAT;
      if (t > now + ahead) break;
      const b = this.beatNo, perCycle = C.BEATS_PER_BAR * C.SLOTS;
      const beat = ((b % C.BEATS_PER_BAR) + C.BEATS_PER_BAR) % C.BEATS_PER_BAR;
      const bar = ((Math.floor(b / C.BEATS_PER_BAR) % C.SLOTS) + C.SLOTS) % C.SLOTS;
      const cycle = Math.floor(b / perCycle);
      if (beat === 0 && bar === 0) this.cycleBoundary(t);
      if (beat === 0) this.barStart(t, bar, out);
      out.push({ type: 'beat', time: t, beat, bar, cycle, song: this.song, role: this.role });
      this.lastBeatTime = t;
      this.beatNo++;
    }
    return out;
  }

  barStart(t, bar, out) {
    const now = t;
    if (bar === C.SLOTS / 2 && this.switchAt != null && this.switchAt <= this.cycleNo + 0.5) this.applySwitch();   // half-cycle switch
    if (this.mode === 'listening' && this.readyToClaim(now)) {
      if (this.peers.size || this.extraHeard.size) {
        this.id = this.pickSlot(now, -1, bar);
        this.mode = 'synced';
        this.log(`took free slot #${this.id}`);
      } else {
        // start singing straight away (this bar or the next) so anyone listening finds us quickly,
        // but not in the bar where we last heard a muffled packet: someone we couldn't decode sings there
        const gb = this.garbledT != null && now - this.lastGarbled < 2 * C.CYCLE
          ? ((Math.round((this.garbledT - this.T0) / C.SLOT) % C.SLOTS) + C.SLOTS) % C.SLOTS : -1;
        this.id = this.pickSlot(now, gb, bar);
        this.mode = 'founder'; this.foundedAt = now;
        this.log(`nobody here: founding the swarm in slot #${this.id}`);
      }
      this.txSinceClaim = 0; this.verifyLeft = this.mode === 'founder' ? 0 : 2; this.claimAt = now;
    }
    if (this.mode !== 'listening' && bar !== this.id) {
      if (this.myExtras(now).includes(bar)) {
        this.stats.extras++; this.pushTx(t, bar, true);
        out.push({ type: 'tx', time: t, payload: this.extraPayload(now, bar), extra: true });
      }
      return;
    }
    if (this.mode !== 'listening' && bar === this.id) {
      const settled = Math.abs(wrap(this.T0 - this.T0p, C.CYCLE)) < C.SETTLED;
      if (!settled) return;
      let skip;
      // founder: mostly sing, so newcomers find us; but if we hear garbled packets, someone else may be
      // singing over us on another grid, and only a silent turn lets us decode them
      // (off-grid sound only: a garbled packet on our grid is a newcomer or just loss)
      // (once we've decoded someone since, that was probably them, now out of our way: sing every turn)
      if (this.mode === 'founder') skip = this.rng() < (now - this.lastForeign < 4 * C.CYCLE && this.lastClean < this.lastForeign ? 0.5 : 0.05);
      else if (this.verifyLeft > 0 && this.txSinceClaim >= 1 && (this.R != null || this.txSinceClaim >= 3) &&
               (this.ackedByAll(now) || this.txSinceClaim >= 3)) {
        // new slot: stay quiet on a couple of random turns (random, so two clashers don't both
        // go quiet on the same turn) and listen: is anyone else in my slot? Only once everyone I hear
        // has acked me (or after a few turns), so the quiet turns don't hold up the welcome
        // (a real clash shows up as missing acks anyway)
        skip = this.rng() < 0.5; if (skip) this.verifyLeft--;
      } else skip = this.verifyLeft === 0 && this.groupSize(now) >= 2 && this.rng() < C.SKIP_P;
      this.txSinceClaim++;
      if (this.proposedAt != null && this.switchAt != null && this.switchAt - this.cycleNo >= 1 && this.userProp) skip = false;  // announcing a person's pick: don't waste a turn
      if (skip) return;
      if (this.lastTx != null) {
        if (this.lastSelfHeard == null || this.lastSelfHeard < this.lastTx) this.selfMiss++; else this.selfMiss = 0;
        if (this.selfMiss >= 2 && !this.deafDetected) { this.deafDetected = true; this.log("can't hear myself: playing on from memory"); }
      }
      this.lastTx = t; this.lastTxId = this.id; this.stats.tx++; this.pushTx(t, this.id, false);
      out.push({ type: 'tx', time: t, payload: this.payload(now) });
    }
  }

  pushTx(t, id, extra) {
    this.recentTx.push({ t, id, extra });
    while (this.recentTx.length > 4) this.recentTx.shift();
  }

  cycleBoundary(t) {
    const now = t; this.cycleNo++; this.lastBoundary = t;
    if (this.switchAt == null && this.song !== this.adv && !this.deaf) this.switchAt = this.cycleNo;  // song changed from outside
    if (this.switchAt != null && this.cycleNo >= this.switchAt) {
      // my own proposal: only go ahead if somebody has picked it up
      // (a person's choice goes ahead anyway if I'm alone; in a band, ask again a couple of times first)
      const fresh = [...this.peers.values()].filter(q => this.proposedAt != null && q.last > this.proposedAt &&
          ((q.gen + (q.gen & 1)) & 3) === this.G);
      // (a fast genre change goes ahead regardless: stragglers get reminded, see considerSong)
      const takenUp = this.proposedAt == null || this.crossAnn || fresh.some(q => q.song === this.adv);
      // A person's choice only waits (asks again) in a duo whose other half has been heard since without
      // taking it up. In a bigger band the others relay it to each other, so they're most likely switching now
      // too; and if they're switching to a rival change at the same gen, the genre change wins the tie-break
      const stale = [...this.peers.entries()].filter(([i, q]) => i !== this.id && q.inPhaseAt != null &&
          now - q.inPhaseAt < C.FRESH * C.CYCLE && this.proposedAt != null && q.last > this.proposedAt).length;
      if (!takenUp && this.userProp > 1 && this.groupSize(now) >= 2 && !fresh.length && this.groupSize(now) === 2 && stale >= 1) {
        this.userProp--; this.switchAt = this.cycleNo + 2;
      } else if (!takenUp && !this.userProp && stale >= this.groupSize(now) - 1) {
        // (a spontaneous change is dropped only if I've heard every bandmate since and none took it up:
        // otherwise they're probably switching, and dropping it would leave me the odd one out)
        this.log(`nobody took up ${SONGS[this.adv].name}: never mind`);
        this.adv = this.song; this.G = (this.G + 2) & 3; this.switchAt = null;
      } else this.applySwitch();
    }
    this.proposedAt = this.switchAt == null ? null : this.proposedAt;
    for (const [i, p] of this.peers) if (now - p.last > C.PEER_TIMEOUT * C.CYCLE) { this.peers.delete(i); this.log(`lost #${i}`); }
    for (const [b, x] of this.extraHeard) if (now - x.at > 2 * C.CYCLE) this.extraHeard.delete(b);
    const size = this.groupSize(now);
    const heard = this.heardThisCycle, acked = this.ackedThisCycle;
    this.heardThisCycle = false; this.ackedThisCycle = false;
    if (this.mode === 'listening') return;
    if (this.peers.size === 0) {
      this.lonelyCycles++;
      if (this.lonelyCycles >= 3 && this.rng() < 0.5 && this.mode === 'synced') this.mode = 'founder';
    } else this.lonelyCycles = 0;
    // neighbours keep hearing each other but never list me: my slot is probably drowned out
    if (heard && !acked && this.stats.tx > 0) this.missAck++;
    else if (acked) this.missAck = 0;
    if (this.missAck >= 3 && this.rng() < 0.5) {
      const old = this.id; this.repick(now, old);
      this.log(`nobody hears slot #${old} (clash?): moving to #${this.id}`);
    }
    this.roleRule(now);
    // mutation: about once every MUTATE_S seconds across the whole group, only when all agree
    if (size >= 2 && this.switchAt == null && this.rng() < C.CYCLE / (C.MUTATE_S * size)) {
      let calm = true;
      for (const [i, q] of this.peers)
        if (i !== this.id && q.inPhaseAt != null && now - q.inPhaseAt < C.FRESH * C.CYCLE && (q.gen !== this.G || q.song !== this.adv)) calm = false;
      if (calm) {
        const rel = RELATED[this.song];
        this.adv = rel[Math.floor(this.rng() * rel.length)];
        this.G = (this.G + 2) & 3; this.switchAt = this.cycleNo + 2; this.proposedAt = now;
        this.log(`I fancy a change: proposing ${SONGS[this.adv].name}`);
      }
    }
  }

  // Everyone runs the same deterministic deal on what they can hear: in slot order, keep your role
  // if it's still needed; extras move to the missing roles. Only I move, and only if I see the
  // same answer two cycles running (my picture of the others may be one cycle stale).
  roleRule(now) {
    const members = [[this.id, this.role]];
    for (const [i, p] of this.peers)
      if (i !== this.id && p.inPhaseAt != null && now - p.inPhaseAt < C.PEER_TIMEOUT * C.CYCLE) members.push([i, p.role]);
    members.sort((a, b) => a[0] - b[0]);
    const n = members.length, quota = [0, 0, 0, 0];
    for (let k = 0; k < n; k++) quota[C.ROLE_ORDER[k % 8]]++;
    const movers = []; let mine = null;
    for (const [i, r] of members) {
      if (quota[r] > 0) { quota[r]--; if (i === this.id) mine = r; } else movers.push(i);
    }
    if (mine == null) {
      const open = [];
      for (let k = 0; k < n; k++) { const r = C.ROLE_ORDER[k % 8]; if (quota[r] > 0) { quota[r]--; open.push(r); } }
      mine = open[movers.indexOf(this.id)];
    }
    if (mine == null || mine === this.role) { this.roleWant = null; return; }
    if (this.roleWant === mine) this.roleWantN++; else { this.roleWant = mine; this.roleWantN = 1; }
    if (this.roleWantN >= 2) {
      const had = this.role; this.role = mine; this.roleWant = null;
      this.log(`too many on ${C.ROLES[had]}: switching to ${C.ROLES[mine]}`);
    }
  }

  // audible-sync helper for UI: phase of played grid relative to target, ms
  get drift() { return wrap(this.T0 - this.T0p, C.CYCLE) * 1000; }
}
