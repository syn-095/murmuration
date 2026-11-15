import { Engine } from './engine.js';
import { C, SONGS } from './agent.js';
import { GENRES } from './songs.js';
import { packetTones, packPayload, N_SYM, SYM } from './modem.js';
const rawOf = p => p.raw ?? packPayload(p.pkt);

const $ = id => document.getElementById(id);
const ROLE_COL = ['#ff7a59', '#ffd166', '#7bdff2', '#b388ff'];
const ROLE_NAME = C.ROLES;
const SONG_HUE = [222, 262, 32, 330, 140, 190, 285, 8];

const logLines = [];
function log(m) {
  const t = new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
  logLines.unshift(`${t}  ${m}`); logLines.length = Math.min(logLines.length, 4);
  $('log').innerHTML = logLines.map(l => `<div>${l.replace(/[<&]/g, c => ({ '<': '&lt;', '&': '&amp;' }[c]))}</div>`).join('');
}

const rx = new Map();       // slot -> {at, kind}
const ripples = [];         // {slot, at, out}
let engine;

$('go').onclick = async () => {
  $('go').disabled = true; $('err').textContent = '';
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('demo')) Object.assign(C, { FOUND_AFTER: 0.3, LISTEN_MIN: 2, LISTEN_MAX: 4 });   // judges don't wait
    engine = new Engine({ onLog: log, onPacket });
    engine.onFrame = onFrame;
    if (q.has('big')) $('spec').classList.add('show');
    engine.onState = st => { $('resume').style.display = st === 'running' ? 'none' : 'flex'; };
    await engine.start();
    if (q.has('genre')) { const g = Math.max(0, Math.min(GENRES.length - 1, +q.get('genre') || 0)); engine.agent.song = engine.agent.adv = g * 2; }
    $('start').remove();
    log('listening for the swarm…');
    if (new URLSearchParams(location.search).has('debug')) $('dbg').classList.add('show');
    requestAnimationFrame(draw);
    setInterval(updateText, 250);
  } catch (e) {
    console.error(e);
    $('err').textContent = `Couldn't start audio: ${e.message || e}. The page needs https and microphone permission.`;
    $('go').disabled = false;
  }
};
$('deaf').onclick = () => {
  const on = !engine.muted; engine.setDeaf(on);
  $('deaf').classList.toggle('on', on);
  $('deaf').textContent = on ? 'Let me hear again' : 'Knock me out';
};
$('resume').onclick = () => engine.ctx.resume();
// genre: propose the next genre to the whole band (same handshake as a key change, so everyone flips together)
$('genreBtn').onclick = () => {
  const a = engine.agent, now = engine.ctx.currentTime, cur = SONGS[a.song];
  const target = ((cur.genre + 1) % GENRES.length) * 2 + (a.song % 2);
  if (a.propose) a.propose(target, now); else { a.song = target; }
  log(`I'd like ${GENRES[SONGS[target].genre]}: telling the band by song…`);
  $('genreBtn').textContent = `→ ${GENRES[SONGS[target].genre]}…`;
};

// big "LOCKED" moment when the band grows or I snap into it
let lastSize = 1, flashT = 0, shownSong = null;
function flash(text) {
  $('flash').textContent = text; $('flash').classList.add('on');
  clearTimeout(flashT); flashT = setTimeout(() => $('flash').classList.remove('on'), 1600);
}
$('dbgBtn').onclick = () => $('dbg').classList.toggle('show');
$('specBtn').onclick = () => $('spec').classList.toggle('show');
// in-page message box: never use prompt(), which freezes the page (and on iOS the audio clock) while you type
const closeSay = () => { $('say').classList.remove('show'); $('sayIn').blur(); };
const sendSay = t => {
  t = (t || '').trim(); if (!t) return;
  const msg = engine.say(t); closeSay();
  log(`I'll sing "${msg}" on my next turn instead of my usual song`);
};
$('sayBtn').onclick = () => { $('say').classList.add('show'); $('sayIn').value = ''; };
$('sayGo').onclick = () => sendSay($('sayIn').value);
$('sayIn').onkeydown = e => { if (e.key === 'Enter') sendSay($('sayIn').value); if (e.key === 'Escape') closeSay(); };
$('sayX').onclick = closeSay;
document.querySelectorAll('.chips button').forEach(b => b.onclick = () => sendSay(b.textContent));
for (let i = 0; i < 8; i++) $('bars').appendChild(document.createElement('div'));

function onPacket(e) {
  if (!e.ok) return;
  if (e.msg != null) {
    specPackets.push({ s: e.tStart, raw: e.payload, label: `message: "${e.msg}"` });
    if (specPackets.length > 20) specPackets.shift();
    if (e.fresh) {
      flash(`“${e.msg}” — heard by ear`);
      log(`a message came by song: "${e.msg}" (I'll sing it on)`);
      drawScoreRaw(e.payload, `someone sang a message: <span style="color:${FIELD_COL.song}">“${e.msg}”</span>`);
    }
    return;
  }
  const k = e.res === 'self' ? 'self' : (e.res && e.res.kind) || e.res;
  if (e.extra) {   // a spare-bar beacon: timing + song only, its id field is the bar number, not a device
    specPackets.push({ s: e.tStart, pkt: e.pkt, extra: true, label: `beacon · bar ${e.pkt.id + 1} · ${SONGS[e.pkt.song].name}` });
    if (specPackets.length > 20) specPackets.shift();
    if (k === 'snap') flash(`LOCKED · ${SONGS[engine.agent.song].name}`);
    return;
  }
  specPackets.push({ s: e.tStart, pkt: e.pkt, label: `#${e.pkt.id} · ${ROLE_NAME[e.pkt.role]} · ${SONGS[e.pkt.song].name}` });   // my own song shows up too
  if (specPackets.length > 20) specPackets.shift();
  if (k === 'self') return;
  rx.set(e.pkt.id, { at: performance.now(), kind: k });
  const a = engine.agent, size = a.groupSize(engine.ctx.currentTime);
  if (k === 'snap' || size > lastSize) flash(`LOCKED · band of ${size} · ${SONGS[a.song].name}`);
  lastSize = size;
  drawScore(e.pkt);
  ripples.push({ slot: e.pkt.id, at: performance.now(), out: false });
}

function updateText() {
  const a = engine.agent, now = engine.ctx.currentTime;
  const mode = engine.muted || a.deafDetected ? 'playing from memory' : a.mode === 'listening' ? 'listening…' : a.mode === 'founder' ? 'founder, waiting for company' : 'in the swarm';
  // countdown while the band is agreeing on a new genre (shown on every device that knows about it)
  let eta = null;
  if (a.switchEta) eta = a.switchEta(now);
  else if (a.switchAt != null && a.lastBoundary != null) eta = (a.switchAt - a.cycleNo) * C.CYCLE - (now - a.lastBoundary);
  const nextG = a.adv != null ? SONGS[a.adv].genre : null, curG = SONGS[a.song].genre;
  if (eta != null && isFinite(eta) && nextG != null && nextG !== curG && eta > -1)
    $('genreBtn').textContent = `♪ ${GENRES[nextG]} in ${Math.max(0, Math.ceil(eta))} s…`;
  else if (!$('genreBtn').textContent.startsWith('→') || $('genreBtn').textContent.includes(GENRES[curG]))
    $('genreBtn').textContent = `♪ ${GENRES[curG]} · tap to change`;
  $('status').innerHTML = [
    `<b>${mode}</b>`,
    a.id >= 0 ? `slot <b>#${a.id}</b> · group of <b>${a.groupSize(now)}</b>` : 'choosing a slot',
    `latency <b>${a.R != null ? Math.round(a.R * 1000) + ' ms' : '?'}</b>`,
  ].join('<br>');
  if ($('dbg').classList.contains('show')) {
    const lv = engine.toneLevels();
    [...$('bars').children].forEach((b, i) => b.style.height = Math.min(100, lv[i] * 2.5) + '%');
    const s = engine.settings || {}, d = engine.detector.stats;
    $('dbgText').innerHTML = [
      `sr ${engine.sr} · out ${Math.round((engine.ctx.outputLatency || 0) * 1000)} ms · base ${Math.round((engine.ctx.baseLatency || 0) * 1000)} ms`,
      `mic: echoCancel ${s.echoCancellation} · noiseSup ${s.noiseSuppression} · agc ${s.autoGainControl}`,
      `level ${(20 * Math.log10(engine.level + 1e-9)).toFixed(0)} dBFS · floor ${(10 * Math.log10(engine.detector.floor + 1e-20)).toFixed(0)} dB`,
      `packets ok ${d.ok} · bad ${d.bad} · preambles ${d.cands}`,
      `R samples ${a.rS.map(x => Math.round(x * 1000)).join(' ')}`,
      `tx ${a.stats.tx} rx ${a.stats.rx} snaps ${a.stats.snaps} · drift ${a.drift.toFixed(1)} ms`,
      `peers ${[...a.peers.entries()].map(([i, p]) => `#${i}:${ROLE_NAME[p.role]}${p.lastE != null ? ' ' + Math.round(p.lastE * 1000) + 'ms' : ''}`).join(', ') || '-'}`,
    ].join('<br>');
  }
}

const cv = $('c'), g = cv.getContext('2d');
function draw() {
  requestAnimationFrame(draw);
  const dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const a = engine.agent, ctx = engine.ctx;
  const heard = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0.02);
  // most recent beat that has sounded
  let last = null; for (const b of engine.beats) if (b.time <= heard) last = b;
  const since = last ? heard - last.time : 9;
  const pulse = Math.exp(-since * (last && last.beat === 0 ? 4 : 7)) * (last && last.beat === 0 ? 1 : 0.55);
  const frac = Math.min(1, since / C.BEAT);
  const pos = last ? ((last.bar * 4 + last.beat + frac) / 32) : 0;
  // the song the band is *playing* (from the beat events), flash when it changes: everyone flips on the same downbeat
  if (last && last.song !== shownSong) { if (shownSong != null && a.mode !== 'listening') flash(`KEY CHANGE → ${SONGS[last.song].name}`); shownSong = last.song; }
  const hue = SONG_HUE[last ? last.song : a.song];
  const deaf = engine.muted || a.deafDetected;
  const specEl = $('spec'), topY = specEl.classList.contains('show') ? specEl.getBoundingClientRect().bottom + 8 : 110, botY = document.querySelector('.bottom').getBoundingClientRect().top - 10;
  const cx = W / 2, cy = (topY + botY) / 2, Rr = Math.max(40, Math.min(W * 0.36, (botY - topY) / 2 - 46));

  // background glow
  const bg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
  bg.addColorStop(0, `hsla(${hue},70%,${18 + pulse * 10}%,1)`); bg.addColorStop(1, '#07080f');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  // cycle ring with 8 bar segments
  for (let s = 0; s < 8; s++) {
    const a0 = -Math.PI / 2 + s * Math.PI / 4 + 0.03, a1 = a0 + Math.PI / 4 - 0.06;
    g.beginPath(); g.arc(cx, cy, Rr, a0, a1);
    const current = last && last.bar === s;
    g.strokeStyle = current ? `hsla(${hue},90%,75%,0.9)` : 'rgba(255,255,255,0.12)';
    g.lineWidth = current ? 6 : 3; g.stroke();
  }
  // sweeping hand
  const ang = -Math.PI / 2 + pos * 2 * Math.PI;
  g.beginPath(); g.arc(cx + Math.cos(ang) * Rr, cy + Math.sin(ang) * Rr, 6, 0, 7);
  g.fillStyle = '#fff'; g.fill();

  // slots: me and my peers
  const nowMs = performance.now();
  for (let s = 0; s < 8; s++) {
    const sa = -Math.PI / 2 + s * Math.PI / 4 + Math.PI / 8;
    const x = cx + Math.cos(sa) * (Rr + 34), y = cy + Math.sin(sa) * (Rr + 34);
    const p = a.peers.get(s), me = s === a.id;
    const r = rx.get(s), flash = r ? Math.exp(-(nowMs - r.at) / 500) : 0;
    if (me) {
      g.beginPath(); g.arc(x, y, 15 + pulse * 3, 0, 7); g.fillStyle = ROLE_COL[a.role]; g.fill();
      g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
      g.fillStyle = '#0a0c1c'; g.font = '700 11px Space Grotesk'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('me', x, y);
    } else if (p) {
      const inPhase = p.inPhaseAt != null && ctx.currentTime - p.inPhaseAt < 2 * C.CYCLE;
      g.beginPath(); g.arc(x, y, 10 + flash * 6, 0, 7);
      g.fillStyle = inPhase ? ROLE_COL[p.role] : 'rgba(255,255,255,0.25)'; g.fill();
      if (flash > 0.02) { g.beginPath(); g.arc(x, y, 10 + (1 - flash) * 30, 0, 7); g.strokeStyle = `rgba(255,255,255,${flash})`; g.lineWidth = 2; g.stroke(); }
    } else {
      g.beginPath(); g.arc(x, y, 4, 0, 7); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fill();
    }
  }
  // my own transmission: rings flying out of my slot
  if (engine.lastTxAt && a.id >= 0) {
    const dt = heard - engine.lastTxAt;
    if (dt > 0 && dt < 1.6) {
      const sa = -Math.PI / 2 + a.id * Math.PI / 4 + Math.PI / 8;
      const x = cx + Math.cos(sa) * (Rr + 34), y = cy + Math.sin(sa) * (Rr + 34);
      for (let k = 0; k < 3; k++) { const rr = ((dt * 120 + k * 40) % 120); g.beginPath(); g.arc(x, y, 15 + rr, 0, 7); g.strokeStyle = `rgba(255,255,255,${0.5 * (1 - rr / 120)})`; g.lineWidth = 2; g.stroke(); }
    }
  }
  // ripples from peers into the centre
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i], t = (nowMs - rp.at) / 700;
    if (t > 1) { ripples.splice(i, 1); continue; }
    const sa = -Math.PI / 2 + rp.slot * Math.PI / 4 + Math.PI / 8;
    const x0 = cx + Math.cos(sa) * (Rr + 34), y0 = cy + Math.sin(sa) * (Rr + 34);
    const x = x0 + (cx - x0) * t, y = y0 + (cy - y0) * t;
    g.beginPath(); g.arc(x, y, 4, 0, 7); g.fillStyle = `rgba(255,255,255,${1 - t})`; g.fill();
  }

  // centre orb
  const orb = Rr * (0.45 + pulse * 0.08);
  const og = g.createRadialGradient(cx, cy - orb * 0.3, orb * 0.1, cx, cy, orb);
  og.addColorStop(0, deaf ? 'hsl(35,90%,75%)' : `hsl(${hue},85%,${72 + pulse * 15}%)`);
  og.addColorStop(1, deaf ? 'hsl(25,70%,35%)' : `hsl(${hue},70%,32%)`);
  g.beginPath(); g.arc(cx, cy, orb, 0, 7); g.fillStyle = og; g.fill();
  g.beginPath(); g.arc(cx, cy, orb + 4, 0, 7); g.strokeStyle = ROLE_COL[a.role]; g.lineWidth = 4; g.stroke();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${Math.round(orb * 0.32)}px Space Grotesk`; g.fillText(ROLE_NAME[a.role], cx, cy - orb * 0.1);
  g.font = `500 ${Math.round(orb * 0.15)}px Space Grotesk`; g.globalAlpha = 0.85;
  g.fillText(a.mode === 'listening' ? 'listening…' : SONGS[a.song].name, cx, cy + orb * 0.25); g.globalAlpha = 1;
}

// ---- Rosetta strip: the packet as a score, and what it means ----
const NOTE = ['C7', 'D7', 'E7', 'G7', 'A7', 'C8', 'D8', 'E8'];
const FIELD_COL = { pre: '#ffffff', id: '#ff7a59', role: '#ffd166', song: '#7bdff2', gen: '#9aa8ff', mask: '#7be495', crc: '#666c8a' };
function fieldOf(k) { // data symbol k carries word bits 25-2k, 24-2k (payload bit b = word bit b+7)
  const b = 25 - 2 * k;
  return b >= 23 ? 'id' : b >= 21 ? 'role' : b >= 18 ? 'song' : b >= 16 ? 'gen' : b >= 8 ? 'mask' : 'crc';
}
function drawScore(pkt) {
  const heard = []; for (let i = 0; i < 8; i++) if (pkt.mask & (1 << i)) heard.push('#' + i);
  drawScoreRaw(packPayload(pkt), `<span style="color:${FIELD_COL.id}">#${pkt.id}</span> sang: "I play <span style="color:${FIELD_COL.role}">${ROLE_NAME[pkt.role]}</span>, ` +
    `in <span style="color:${FIELD_COL.song}">${SONGS[pkt.song].name}</span> (v${pkt.gen}), ` +
    `<span style="color:${FIELD_COL.mask}">${heard.length ? 'I hear ' + heard.join(' ') : 'I hear nobody yet'}</span>"`, pkt);
}
function drawScoreRaw(raw, html, pkt = null) {
  const cv = $('score'), g = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
  const W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr; g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tones = packetTones(raw), n = tones.length, lw = 26, cw = (W - lw) / n;
  g.font = '9px JetBrains Mono'; g.textBaseline = 'middle';
  for (let t = 0; t < 8; t++) {
    const y = H - 4 - t * (H - 8) / 7;
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillText(NOTE[t], 0, y);
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(lw, y, W - lw, 1);
  }
  tones.forEach((ts, k) => {
    const f = k < 2 ? 'pre' : !pkt ? (k - 2 < 10 ? 'song' : 'crc') : fieldOf(k - 2);
    for (const t of ts) {
      const y = H - 4 - t * (H - 8) / 7;
      g.fillStyle = FIELD_COL[f]; g.fillRect(lw + k * cw + 1, y - 3, cw - 2, 6);
    }
  });
  $('trans').innerHTML = html;
}

// ---- live spectrogram: the 8 bell bins over time, with decoded songs boxed and labelled ----
const SPEC_N = 1200;                       // columns kept (one per 12.5 ms analysis hop = 15 s)
const spec = new Float32Array(SPEC_N * 8); let specHead = 0, specEnd = 0, specHop = 0;
const specPackets = [];
function onFrame(end, e, floor) {
  if (specEnd) specHop = end - specEnd;
  specEnd = end;
  for (let t = 0; t < 8; t++) spec[specHead * 8 + t] = Math.max(0, 10 * Math.log10(e[t] / (floor + 1e-12)));
  specHead = (specHead + 1) % SPEC_N;
}
let specImg = null;
function drawSpec() {
  const el = $('spec'); if (!el.classList.contains('show') || !specHop) return;
  const cv = $('specCv'), g = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1);
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const lw = 30, cols = Math.min(SPEC_N, Math.round((W - lw) / 1.5));   // ~1.5 px per hop
  if (!specImg || specImg.width !== cols) specImg = new ImageData(cols, 8);
  const d = specImg.data;
  for (let c = 0; c < cols; c++) {
    const src = (specHead - cols + c + SPEC_N * 2) % SPEC_N;
    for (let t = 0; t < 8; t++) {
      const v = Math.min(1, spec[src * 8 + t] / 30), i = ((7 - t) * cols + c) * 4;
      d[i] = 40 + 215 * Math.pow(v, 0.8); d[i + 1] = 30 + 200 * v * v; d[i + 2] = 70 + 120 * v; d[i + 3] = 255;
    }
  }
  const tmp = drawSpec.tmp || (drawSpec.tmp = document.createElement('canvas'));
  tmp.width = cols; tmp.height = 8; tmp.getContext('2d').putImageData(specImg, 0, 0);
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, W, H);
  const top = 6, rowH = (H - top - 18) / 8, x0 = lw, pw = (W - lw) / cols;
  g.drawImage(tmp, x0, top, W - lw, rowH * 8);
  g.font = '9px JetBrains Mono'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(255,255,255,0.5)';
  for (let t = 0; t < 8; t++) g.fillText(NOTE[t], 2, top + (7 - t + 0.5) * rowH);
  // decoded packets: box each note where the decoder found it
  const symHops = SYM * engine.sr / specHop;
  for (const p of specPackets) {
    const startCol = cols - (specEnd - p.s) / specHop;            // column where the preamble starts
    if (startCol + N_SYM * symHops < 0) continue;
    const tones = packetTones(rawOf(p), !!p.extra), isMsg = p.raw != null;
    tones.forEach((ts, k) => {
      const f = k < 2 ? 'pre' : isMsg ? (k - 2 < 10 ? 'song' : 'crc') : fieldOf(k - 2), x = x0 + (startCol + k * symHops) * pw;
      for (const t of ts) { g.strokeStyle = FIELD_COL[f]; g.lineWidth = 1.5; g.strokeRect(x + 0.5, top + (7 - t) * rowH + 1, symHops * pw - 1, rowH - 2); }
    });
    const lx = x0 + startCol * pw;
    if (lx > -150) { g.fillStyle = '#fff'; g.font = '600 11px Space Grotesk'; g.textBaseline = 'top';
      g.fillText(p.label, Math.max(lx, x0 + 2), H - 15); }
  }
}
(function specLoop() { requestAnimationFrame(specLoop); if (engine) drawSpec(); })();
