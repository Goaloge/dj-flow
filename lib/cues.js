// Engine-DJ Hot Cues & Loops: Decoder, Encoder und automatische Erkennung aus der Waveform
'use strict';
const zlib = require('zlib');

const COLORS = ['#f4d338', '#ef8130', '#e8414d', '#d74fd6', '#8a5ef0', '#1dafd7', '#2fd27b', '#9be03b'];

function qUncompress(blob) {
  if (!blob || blob.length < 5) return null;
  try { return zlib.inflateSync(Buffer.from(blob).subarray(4)); } catch { return null; }
}
function qCompress(buf) {
  const head = Buffer.alloc(4); head.writeUInt32BE(buf.length);
  return Buffer.concat([head, zlib.deflateSync(buf)]);
}
const hexToArgb = (hex) => { const h = (hex || '#ffffff').replace('#', ''); return Buffer.from('ff' + h.padEnd(6, '0').slice(0, 6), 'hex'); };

/** quickCues -> { cues: [8 Slots | null], mainCue, mainCueAdjusted, defaultMainCue } (Positionen in Samples) */
function decodeCues(blob) {
  const out = { cues: Array(8).fill(null), mainCue: -1, mainCueAdjusted: 0, defaultMainCue: -1 };
  const b = qUncompress(blob);
  if (!b) return out;
  try {
    const n = Number(b.readBigInt64BE(0)); let o = 8;
    for (let i = 0; i < n; i++) {
      const len = b[o]; o++;
      const label = b.subarray(o, o + len).toString('utf8'); o += len;
      const pos = b.readDoubleBE(o); o += 8;
      const color = '#' + b.subarray(o + 1, o + 4).toString('hex'); o += 4;
      if (i < 8 && !(pos === -1 && !len)) out.cues[i] = { label, samples: pos, color };
    }
    out.mainCue = b.readDoubleBE(o); out.mainCueAdjusted = b[o + 8]; out.defaultMainCue = b.readDoubleBE(o + 9);
  } catch { /* Rest fehlt */ }
  return out;
}

function encodeCues({ cues, mainCue = -1, mainCueAdjusted = 0, defaultMainCue = -1 }) {
  const parts = [];
  const cnt = Buffer.alloc(8); cnt.writeBigInt64BE(8n); parts.push(cnt);
  for (let i = 0; i < 8; i++) {
    const c = cues[i];
    const label = Buffer.from(c ? (c.label || '') : '', 'utf8').subarray(0, 255);
    parts.push(Buffer.from([label.length]), label);
    const pos = Buffer.alloc(8); pos.writeDoubleBE(c ? c.samples : -1); parts.push(pos);
    parts.push(c ? hexToArgb(c.color) : Buffer.alloc(4));
  }
  const tail = Buffer.alloc(17);
  tail.writeDoubleBE(mainCue, 0); tail[8] = mainCueAdjusted ? 1 : 0; tail.writeDoubleBE(defaultMainCue, 9);
  parts.push(tail);
  return qCompress(Buffer.concat(parts));
}

/** loops (unkomprimiert, Little Endian) -> [8 Slots | null] */
function decodeLoops(blob) {
  const out = Array(8).fill(null);
  if (!blob || blob.length < 8) return out;
  const b = Buffer.from(blob);
  try {
    const n = Number(b.readBigInt64LE(0)); let o = 8;
    for (let i = 0; i < n; i++) {
      const len = b[o]; o++;
      const label = b.subarray(o, o + len).toString('utf8'); o += len;
      const start = b.readDoubleLE(o), end = b.readDoubleLE(o + 8);
      const ss = b[o + 16], es = b[o + 17];
      const color = '#' + b.subarray(o + 19, o + 22).toString('hex'); o += 22;
      if (i < 8 && ss && es && start >= 0 && end > start) out[i] = { label, start, end, color };
    }
  } catch { /* */ }
  return out;
}

function encodeLoops(loops) {
  const parts = [];
  const cnt = Buffer.alloc(8); cnt.writeBigInt64LE(8n); parts.push(cnt);
  for (let i = 0; i < 8; i++) {
    const l = loops[i];
    const label = Buffer.from(l ? (l.label || '') : '', 'utf8').subarray(0, 255);
    parts.push(Buffer.from([label.length]), label);
    const v = Buffer.alloc(18);
    v.writeDoubleLE(l ? l.start : -1, 0); v.writeDoubleLE(l ? l.end : -1, 8);
    v[16] = l ? 1 : 0; v[17] = l ? 1 : 0;
    parts.push(v, l ? hexToArgb(l.color) : Buffer.alloc(4));
  }
  return Buffer.concat(parts);
}

/**
 * Automatische Cues & Loops aus Overview-Waveform + Beatgrid.
 * Arbeitet in Takten: 4-Takt-Blöcke werden in "voll" (Bass + Energie) und "leer" (Break/Intro/Outro) eingeteilt;
 * an den Wechseln entstehen Drops, Breaks, Outro. Alle Positionen liegen exakt auf dem Grid.
 * Rückgabe in Sekunden.
 */
function autoCuesLoops(ov, grid, dur, opts = {}) {
  const maxC = opts.cues ?? 8, maxL = opts.loops ?? 8;
  if (!ov?.length || !grid?.beatSec || !dur) return { cues: [], loops: [], mixIn: 0, mixOut: dur ? dur * 0.85 : 0, sections: [] };
  const beat = grid.beatSec, bar = beat * 4, fb = grid.firstBeatSec;
  const nBars = Math.floor((dur - fb) / bar);
  const at = (t) => ov[Math.min(ov.length - 1, Math.max(0, Math.floor((t / dur) * ov.length)))];
  // Takt-Werte
  const E = [], L = [];
  for (let b = 0; b < nBars; b++) {
    let e = 0, l = 0, c = 0;
    for (let t = fb + b * bar; t < fb + (b + 1) * bar; t += bar / 6) { const [lo, mi, hi] = at(t); e += lo * 1.3 + mi + hi * 0.5; l += lo; c++; }
    E.push(e / c); L.push(l / c);
  }
  const BLK = 4, nBlk = Math.ceil(nBars / BLK);
  const blk = (arr, i) => { const s = arr.slice(i * BLK, (i + 1) * BLK); return s.reduce((a, b) => a + b, 0) / Math.max(1, s.length); };
  const be = [], bl = [];
  for (let i = 0; i < nBlk; i++) { be.push(blk(E, i)); bl.push(blk(L, i)); }
  const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)] || 0; };
  const thrE = (pct(be, 0.15) + pct(be, 0.9)) / 2, thrL = (pct(bl, 0.15) + pct(bl, 0.9)) / 2;
  let lab = be.map((e, i) => (e >= thrE * 0.95 && bl[i] >= thrL * 0.85 ? 1 : 0));
  // kurze Ausreißer (1 Block) glätten
  lab = lab.map((v, i) => (i > 0 && i < lab.length - 1 && lab[i - 1] === lab[i + 1] && v !== lab[i - 1] ? lab[i - 1] : v));
  const sections = [];
  for (let i = 0; i < lab.length; i++) {
    if (!sections.length || sections[sections.length - 1].full !== !!lab[i]) sections.push({ full: !!lab[i], startBar: i * BLK, endBar: (i + 1) * BLK });
    else sections[sections.length - 1].endBar = (i + 1) * BLK;
  }
  for (const s of sections) s.endBar = Math.min(s.endBar, nBars);
  const tBar = (b) => fb + b * bar;
  const firstFull = sections.find((s) => s.full);
  const lastFull = [...sections].reverse().find((s) => s.full);

  // ---- Cues ----
  const cand = [];
  cand.push({ label: 'Start', bar: 0, prio: 10 });
  let drop = 0, brk = 0;
  for (let i = 1; i < sections.length; i++) {
    const s = sections[i];
    if (s.full) cand.push({ label: `Drop ${++drop}`, bar: s.startBar, prio: drop === 1 ? 9 : 6 });
    else if (s === sections[sections.length - 1] || s.startBar > nBars * 0.8) cand.push({ label: 'Outro', bar: s.startBar, prio: 8 });
    else cand.push({ label: `Break ${++brk}`, bar: s.startBar, prio: brk === 1 ? 7 : 5 });
  }
  // Mix-In = erste 16-Takt-Phrase vor dem ersten Drop (mind. Takt 0); Mix-Out = 16/32 Takte vor Ende des letzten vollen Teils
  const mixInBar = 0;
  const outroBar = lastFull ? lastFull.endBar : Math.max(0, nBars - 32);
  const mixOutBar = Math.max(firstFull ? firstFull.startBar : 0, Math.floor((Math.min(outroBar, nBars - 16)) / 8) * 8);
  if (mixOutBar > 16 && !cand.some((c) => Math.abs(c.bar - mixOutBar) < 4)) cand.push({ label: 'Mix Out', bar: mixOutBar, prio: 8 });
  if (firstFull && firstFull.startBar >= 16) cand.push({ label: '−16 Takte', bar: firstFull.startBar - 16, prio: 3 });
  const chosen = cand.sort((a, b) => b.prio - a.prio).slice(0, maxC).sort((a, b) => a.bar - b.bar);
  const cues = chosen.map((c, i) => ({ label: c.label, sec: tBar(c.bar), color: c.label.startsWith('Drop') ? COLORS[2] : c.label.startsWith('Break') ? COLORS[5] : c.label === 'Start' ? COLORS[6] : c.label === 'Outro' || c.label === 'Mix Out' ? COLORS[3] : COLORS[0] }));

  // ---- Loops (Längen in Beats, Potenzen von 2) ----
  const lc = [];
  const pushL = (label, startBar, beats, prio, color) => {
    if (startBar < 0 || tBar(startBar) + beats * beat > dur) return;
    if (lc.some((l) => l.startBar === startBar && l.beats === beats)) return;
    lc.push({ label, startBar, beats, prio, color });
  };
  pushL('Intro 8', 0, 32, 10, COLORS[6]);
  pushL('Intro 4', 0, 16, 4, COLORS[7]);
  if (firstFull) {
    pushL('Pre-Drop 1', firstFull.startBar - 1, 4, 8, COLORS[1]);
    pushL('Roll ½', firstFull.startBar - 1, 2, 6, COLORS[0]);
    pushL('Groove 4', firstFull.startBar, 16, 7, COLORS[2]);
    pushL('Bass 1', firstFull.startBar + 8, 4, 5, COLORS[4]);
  }
  const breaks = sections.filter((s) => !s.full && s.startBar > 0 && s.endBar < nBars - 8);
  if (breaks[0]) pushL('Break 4', breaks[0].startBar, 16, 6, COLORS[5]);
  pushL('Outro 8', mixOutBar, 32, 9, COLORS[3]);
  pushL('Outro 4', Math.max(0, nBars - 8), 16, 5, COLORS[3]);
  pushL('Roll ¼', Math.max(0, nBars - 2), 1, 3, COLORS[0]);
  const loops = lc.sort((a, b) => b.prio - a.prio).slice(0, maxL).sort((a, b) => a.startBar - b.startBar)
    .map((l) => ({ label: l.label, start: tBar(l.startBar), end: tBar(l.startBar) + l.beats * beat, color: l.color }));

  return { cues, loops, mixIn: tBar(mixInBar), mixOut: tBar(mixOutBar), sections: sections.map((s) => ({ ...s, start: tBar(s.startBar), end: tBar(s.endBar) })) };
}

module.exports = { decodeCues, encodeCues, decodeLoops, encodeLoops, autoCuesLoops, COLORS, qUncompress };
