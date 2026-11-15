// Wires a real device together: mic -> detector -> agent -> scheduler -> music + bell packets -> speaker.
import { Detector, synthPacket, packPayload, unpackPayload, F, isMessage, packMessage, unpackMessage } from './modem.js';
import { Agent, C } from './agent.js';
import { Music, chordPool, midiToHz } from './music.js';

export class Engine {
  constructor({ onLog, onPacket, onBeat }) {
    this.onLog = onLog; this.onPacket = onPacket; this.onBeat = onBeat;
    this.beats = []; this.txCache = new Map(); this.muted = false; this.outbox = []; this.seen = new Map();
    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // must be called from a tap
  async start() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const resumed = ctx.resume();
    // iOS unlock: play a silent buffer inside the gesture
    const sb = ctx.createBufferSource(); sb.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); sb.connect(ctx.destination); sb.start();
    const stream = this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } } });
    await resumed;
    this.settings = stream.getAudioTracks()[0].getSettings();
    await ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));

    // output buses
    // master -> brick-wall limiter. iOS plays Web Audio much quieter while the mic is open (WebKit bugs
    // 236219/311451), so iPhones get a big boost and lean on the limiter.
    this.isPhone = this.isIOS || /Android|Mobi/i.test(navigator.userAgent);
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
    lim.connect(ctx.destination);
    this.master = ctx.createGain(); this.master.gain.value = this.isIOS ? 3.0 : 1.0; this.master.connect(lim);
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.ratio.value = 4; comp.connect(this.master);
    const lp1 = ctx.createBiquadFilter(), lp2 = ctx.createBiquadFilter();
    for (const f of [lp1, lp2]) { f.type = 'lowpass'; f.frequency.value = 1100; f.Q.value = 0.6; }
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.8;
    this.musicBus.connect(lp1); lp1.connect(lp2); lp2.connect(comp);
    this.txBus = ctx.createGain(); this.txBus.gain.value = this.isIOS ? 0.45 : 0.4; this.txBus.connect(this.master);

    // input
    const src = ctx.createMediaStreamSource(stream);
    this.cap = new AudioWorkletNode(ctx, 'murmur-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = ctx.createGain(); sink.gain.value = 0; src.connect(this.cap); this.cap.connect(sink); sink.connect(ctx.destination);
    this.sr = ctx.sampleRate;
    this.detector = new Detector(this.sr, e => this.handleDetect(e));
    // tap every analysis frame for the live spectrogram
    const det = this.detector, frame = det.frame.bind(det);
    det.frame = end => { frame(end); const f = det.frames[det.frames.length - 1]; this.onFrame && this.onFrame(end, f.e, det.floor); };
    this.frameBase = null;
    this.level = 0;
    this.cap.port.onmessage = ({ data }) => {
      if (this.frameBase == null) this.frameBase = data.frame - this.detector.pos;
      const expected = this.frameBase + this.detector.pos;
      if (data.frame > expected + 8) this.detector.push(new Float32Array(Math.min(data.frame - expected, this.sr)));   // dropped audio: keep sample clock aligned
      if (data.frame > expected + this.sr) this.frameBase = data.frame - this.detector.pos;
      let p = 0; for (let i = 0; i < data.data.length; i += 4) p += data.data[i] * data.data[i];
      this.level = 0.9 * this.level + 0.1 * Math.sqrt(p / (data.data.length / 4));
      this.detector.push(data.data);
    };

    this.music = new Music(ctx, this.musicBus, { lift: this.isPhone ? 12 : 0 });
    this.agent = new Agent({ now: ctx.currentTime, onLog: m => this.onLog && this.onLog(m) });
    this.timer = setInterval(() => this.schedule(), 25);
    this.wake();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { this.wake(); ctx.resume(); } });
    ctx.onstatechange = () => this.onState && this.onState(ctx.state);
  }

  async wake() { try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }

  schedule() {
    const now = this.ctx.currentTime;
    // clock-stall guard: if the audio clock stopped while real time went on (iOS pauses audio for dialogs,
    // calls, Siri...), the band kept playing without us. Shift my grid by the stall so I stay with them.
    const real = performance.now() / 1000;
    if (this.lastReal != null && this.ctx.state === 'running') {
      const stall = (real - this.lastReal) - (now - this.lastCtx);
      if (stall > 0.03 && stall < 600) {
        this.agent.T0 -= stall; this.agent.T0p -= stall;
        if (stall > 0.3) this.onLog && this.onLog(`my audio clock froze for ${stall.toFixed(1)} s: catching up with the band`);
      }
    }
    this.lastReal = real; this.lastCtx = now;
    for (const ev of this.agent.tick(now, 0.15)) {
      if (ev.type === 'beat') {
        const a = this.agent, now = this.ctx.currentTime;
        const dup = [...a.peers.entries()].some(([i, p]) => i < a.id && p.role === a.role && p.inPhaseAt != null && now - p.inPhaseAt < C.FRESH * C.CYCLE);
        this.music.beat(ev, { size: a.groupSize(now), dup });
        this.beats.push(ev); if (this.beats.length > 16) this.beats.shift();
      } else if (ev.type === 'tx' && ev.time > (this.quietUntil || 0)) {
        // messages ride in a spare-bar beacon if I have one (losing a beacon is harmless; my own slot's song
        // carries the sync and acks). Only if no beacon turns up within a cycle does it take my own slot.
        const msgDue = this.outbox.length && (ev.extra || now - this.outboxSince > C.CYCLE + 1);
        if (msgDue) {
          const p = this.outbox.shift(); this.outboxSince = now;
          this.sendRaw(p, ev.time, !!ev.extra);
          this.onLog && this.onLog(`singing "${unpackMessage(p)}" now…`);
        } else if (ev.extra) this.sendPacket(ev.payload, ev.time, true);       // a spare-bar beacon (marked by its preamble order)
        else this.sendPacket(ev.payload, ev.time);
      }
    }
  }

  sendPacket(pl, when, extra = false) { this.sendRaw(packPayload(pl), when, extra); }

  // text by song: queue it for my next turn; neighbours who hear it show it and sing it on once
  say(text) {
    const p = packMessage(text.slice(0, 3)); const msg = unpackMessage(p);
    this.seen.set(msg, this.ctx.currentTime); if (!this.outbox.length) this.outboxSince = this.ctx.currentTime; this.outbox.push(p);
    return msg;
  }

  sendRaw(p, when, extra = false) {
    // the audible body of the song arpeggiates the chord the band is playing in the bar it's sung in
    const song = this.agent.song, bar = extra ? (p >> 16) & 7 : Math.max(0, this.agent.id), key = `${p}|${song}|${bar >> 1}|${extra}`;
    let buf = this.txCache.get(key);
    if (!buf) {
      const pool = chordPool(song, bar, 67, 88), bodyHz = [...Array(8)].map((_, t) => midiToHz(pool[Math.round(t * (pool.length - 1) / 7)]));
      const data = synthPacket(p, this.sr, 0.5, 0.55, bodyHz, extra);
      buf = this.ctx.createBuffer(1, data.length, this.sr); buf.copyToChannel(data, 0);
      this.txCache.set(key, buf); if (this.txCache.size > 64) this.txCache.delete(this.txCache.keys().next().value);
    }
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.txBus); s.start(when);
    // duck the music under our own song: clearer call, no clipping, cleaner decode for neighbours
    const g = this.musicBus.gain;
    g.setTargetAtTime(0.35, when - 0.01, 0.01); g.setTargetAtTime(0.8, when + buf.duration, 0.08);
    this.lastTxAt = when;
  }

  handleDetect(e) {
    const t = (e.tStart + this.frameBase) / this.sr, now = this.ctx.currentTime;
    if (e.ok && isMessage(e.payload)) {
      // a text song: the agent only gets its timing (like a garbled preamble)
      const res = this.agent.onDetect({ ok: false, pkt: null, t, extra: !!e.extra }, now);
      const msg = unpackMessage(e.payload);
      const mine = this.lastTxAt != null && Math.abs(t - this.lastTxAt - (this.agent.R ?? 0.12)) < 0.3;
      const fresh = !this.seen.has(msg) || now - this.seen.get(msg) > 60;
      if (!mine && fresh) { this.seen.set(msg, now); if (!this.outbox.length) this.outboxSince = now; this.outbox.push(e.payload); }   // pass it on, once
      this.onPacket && this.onPacket({ ...e, t, pkt: null, msg, fresh: !mine && fresh, mine, res });
      return;
    }
    const pkt = e.ok ? unpackPayload(e.payload) : null;
    const res = this.agent.onDetect({ ok: e.ok, pkt, t, extra: !!e.extra }, now);
    this.onPacket && this.onPacket({ ...e, t, pkt, res });
  }

  // "knock me out": cut my ears AND scramble my clock and key, so the band audibly falls apart,
  // then has to find me again by ear once I can hear
  setDeaf(d, scramble = true) {
    const a = this.agent;
    this.muted = d; a.deaf = d;
    this.cap.port.postMessage({ muted: d });
    if (d && scramble) {
      a.T0 += C.CYCLE * (0.2 + 0.5 * Math.random());
      a.song = Math.floor(Math.random() * 8);
      for (const p of a.peers.values()) p.inPhaseAt = null;
    }
    // coming back: stay silent for a cycle so I can't sing over the band while trying to hear it
    if (!d) this.quietUntil = this.ctx.currentTime + C.CYCLE + 1;
    this.onLog && this.onLog(d ? 'knocked out: deaf, lost my place, on my own now' : 'ears back: listening quietly for the band…');
  }

  // live energy per bell tone (debug spectrum)
  toneLevels() {
    const fr = this.detector.frames[this.detector.frames.length - 1];
    if (!fr) return F.map(() => 0);
    return Array.from(fr.e).map(v => Math.max(0, (10 * Math.log10(v / (this.detector.floor + 1e-12)))));
  }
}
