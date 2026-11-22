// Libraries-Tab: Playlists, Cue-/Loop-Status, automatische Cues & Loops für einzelne Tracks oder alle fehlenden
'use strict';
const { DatabaseSync } = require('node:sqlite');
const engine = require('./engine');
const cuesLib = require('./cues');

const open = (lib) => new DatabaseSync(lib.db, { readOnly: true });

/** Anzahl belegter Cue- und Loop-Plätze je Track: { trackId: [cues, loops] } */
function cueStats(lib) {
  const db = open(lib), out = {};
  try {
    for (const r of db.prepare('SELECT trackId, quickCues, loops FROM PerformanceData').all()) {
      out[r.trackId] = [cuesLib.decodeCues(r.quickCues).cues.filter(Boolean).length, cuesLib.decodeLoops(r.loops).filter(Boolean).length];
    }
  } finally { db.close(); }
  return out;
}

/** Playlist-Baum in Engine-Reihenfolge (verkettete Listen) */
function playlistTree(lib) {
  const db = open(lib);
  try {
    const rows = db.prepare('SELECT id, title, parentListId, nextListId FROM Playlist').all();
    const counts = Object.fromEntries(db.prepare('SELECT listId, count(*) n FROM PlaylistEntity GROUP BY listId').all().map((r) => [r.listId, r.n]));
    const kids = new Map();
    for (const r of rows) { if (!kids.has(r.parentListId)) kids.set(r.parentListId, []); kids.get(r.parentListId).push(r); }
    const order = (list) => {
      const next = new Map(list.map((r) => [r.id, r.nextListId])), pointedTo = new Set(list.map((r) => r.nextListId));
      let cur = list.find((r) => !pointedTo.has(r.id)); const out = [], seen = new Set();
      while (cur && !seen.has(cur.id)) { out.push(cur); seen.add(cur.id); const n = next.get(cur.id); cur = list.find((r) => r.id === n); }
      for (const r of list) if (!seen.has(r.id)) out.push(r); // falls die Kette Lücken hat
      return out;
    };
    const build = (parent) => order(kids.get(parent) || []).map((r) => ({ id: r.id, title: r.title, count: counts[r.id] || 0, children: build(r.id) }));
    return build(0);
  } finally { db.close(); }
}

/** Einträge einer Playlist in Reihenfolge: [{ trackId, uuid }]. uuid = Datenbank, in der der Track liegt (Engine erlaubt Verweise auf andere Libraries) */
function playlistTracks(lib, listId) {
  const db = open(lib);
  try {
    const uuid = db.prepare('SELECT uuid FROM Information').get()?.uuid;
    const rows = db.prepare('SELECT id, trackId, databaseUuid, nextEntityId FROM PlaylistEntity WHERE listId=?').all(listId);
    const byId = new Map(rows.map((r) => [r.id, r])), pointed = new Set(rows.map((r) => r.nextEntityId));
    let cur = rows.find((r) => !pointed.has(r.id)); const ordered = [], seen = new Set();
    while (cur && !seen.has(cur.id)) { ordered.push(cur); seen.add(cur.id); cur = byId.get(cur.nextEntityId); }
    for (const r of rows) if (!seen.has(r.id)) ordered.push(r);
    return ordered.map((r) => ({ trackId: r.trackId, uuid: r.databaseUuid || uuid }));
  } finally { db.close(); }
}

/** Zuordnung Quell-Track → Ziel-Track über Dateiname + Dateigröße (gleiche Audiodatei) */
function matchTracks(src, dst, ids) {
  if (src.id === dst.id) return new Map(ids.map((i) => [i, i]));
  const a = open(src), b = open(dst), key = (r) => `${String(r.filename || '').toLowerCase()}|${r.fileBytes || 0}`;
  try {
    const target = new Map();
    for (const r of b.prepare('SELECT id, filename, fileBytes FROM Track').all()) if (!target.has(key(r))) target.set(key(r), r.id);
    const q = a.prepare('SELECT id, filename, fileBytes FROM Track WHERE id=?'), out = new Map();
    for (const i of ids) { const r = q.get(i); const t = r && target.get(key(r)); if (t) out.set(i, t); }
    return out;
  } finally { a.close(); b.close(); }
}

const near = (a, b) => Math.abs(a - b) < 0.2;
/**
 * Plan für automatische Cues & Loops.
 * mode 'fill': nur leere Plätze füllen, Vorhandenes bleibt; 'all': alle 8 + 8 ersetzen.
 * Basis sind Waveform und Beatgrid der Quell-Library; vorhandene Cues der Ziel-Library bleiben bei 'fill' erhalten.
 */
async function planAuto(src, dst, ids, mode, onProgress) {
  const L = new engine.EngineLibrary(src), map = matchTracks(src, dst, ids), D = src.id === dst.id ? L : new engine.EngineLibrary(dst);
  const entries = [], skip = { noGrid: 0, noMatch: 0, nothing: 0 };
  try {
    for (let k = 0; k < ids.length; k++) {
      if (k % 200 === 0) { onProgress?.(k, ids.length); await new Promise((r) => setImmediate(r)); }
      const id = ids[k], tid = map.get(id);
      if (!tid) { skip.noMatch++; continue; }
      const p = L.performance(id); const a = p?.auto;
      if (!a || !p.grid?.beatSec || !a.cues.length) { skip.noGrid++; continue; }
      const t = D === L ? p : D.performance(tid);
      let cues, loops;
      const fresh = { cues: [], loops: [] };
      if (mode === 'all') { cues = Array.from({ length: 8 }, (_, i) => a.cues[i] || null); loops = Array.from({ length: 8 }, (_, i) => a.loops[i] || null); cues.forEach((c, i) => c && fresh.cues.push(i)); loops.forEach((l, i) => l && fresh.loops.push(i)); }
      else {
        cues = (t.engineCues || []).slice(0, 8); loops = (t.engineLoops || []).slice(0, 8);
        while (cues.length < 8) cues.push(null); while (loops.length < 8) loops.push(null);
        const before = cues.filter(Boolean).length + loops.filter(Boolean).length;
        for (const c of a.cues) { if (cues.some((x) => x && near(x.sec, c.sec))) continue; const i = cues.indexOf(null); if (i < 0) break; cues[i] = c; fresh.cues.push(i); }
        for (const l of a.loops) { if (loops.some((x) => x && near(x.start, l.start) && near(x.end, l.end))) continue; const i = loops.indexOf(null); if (i < 0) break; loops[i] = l; fresh.loops.push(i); }
        if (cues.filter(Boolean).length + loops.filter(Boolean).length === before) { skip.nothing++; continue; }
      }
      entries.push({ trackId: tid, srcId: id, fresh, cues, loops, mainCue: null });
    }
  } finally { L.close(); if (D !== L) D.close(); }
  onProgress?.(ids.length, ids.length);
  return { entries, skip };
}

module.exports = { cueStats, playlistTree, playlistTracks, planAuto };
/** Dateipfade der Quell-Tracks */
module.exports.pathsOf = (lib, ids) => { const L = new engine.EngineLibrary(lib); try { const q = L.db.prepare('SELECT path FROM Track WHERE id=?'); return new Map(ids.map((i) => [i, L.absPath(q.get(i)?.path)])); } finally { L.close(); } };

// ---------- Feinkorrektur: Cues und Loops auf den echten Einschlag ziehen (wie im Mix-Lab, bis ±60 ms) ----------
const { spawn } = require('child_process');
const dsp = require('../public/dsp.js');
const PEAK_RATE = 120, DEC_SR = 11025;

/** Track mono und mit reduzierter Rate dekodieren (reicht für Einschläge, spart Zeit) */
function decodeMono(file) {
  const ff = require('./decode').find();
  if (!ff) return Promise.reject(new Error('ffmpeg fehlt'));
  return new Promise((res, rej) => {
    const p = spawn(ff, ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(DEC_SR), '-f', 'f32le', '-']);
    const parts = []; let n = 0;
    p.stdout.on('data', (d) => { parts.push(d); n += d.length; });
    p.on('error', rej);
    p.on('close', (c) => {
      if (c !== 0 || !n) return rej(new Error('Dekodieren fehlgeschlagen'));
      const b = Buffer.concat(parts, n); res(new Float32Array(b.buffer, b.byteOffset, Math.floor(n / 4)));
    });
  });
}

/** 3-Band-Spitzen wie im Mix-Lab (gleiche Filter, gleiche Rate) */
function peaks(x) {
  const win = Math.floor(DEC_SR / PEAK_RATE), n = Math.floor(x.length / win);
  const lo = new Float32Array(n), mi = new Float32Array(n), hi = new Float32Array(n);
  const a1 = 1 - Math.exp((-2 * Math.PI * 200) / DEC_SR), a2 = 1 - Math.exp((-2 * Math.PI * 4000) / DEC_SR);
  let l1 = 0, l2 = 0;
  for (let i = 0, k = 0; i < n; i++) {
    let ml = 0, mm = 0, mh = 0;
    for (let j = 0; j < win; j++, k++) {
      const v = x[k]; l1 += a1 * (v - l1); l2 += a2 * (v - l2);
      const vl = Math.abs(l1), vm = Math.abs(l2 - l1), vh = Math.abs(v - l2);
      if (vl > ml) ml = vl; if (vm > mm) mm = vm; if (vh > mh) mh = vh;
    }
    lo[i] = ml; mi[i] = mm; hi[i] = mh;
  }
  const norm = (a) => { let m = 0; for (const v of a) if (v > m) m = v; m = m || 1; for (let i = 0; i < a.length; i++) a[i] /= m; };
  norm(lo); norm(mi); norm(hi);
  return { lo, mi, hi, n };
}

/**
 * Neu erzeugte Cues und Loops eines Plans verfeinern. Nur die neuen, vorhandene bleiben unangetastet.
 * paths: Map srcTrackId -> Datei. Läuft mit `parallel` gleichzeitigen Dekodierungen.
 */
async function refine(plan, paths, { parallel = 4, onTrack, shouldStop } = {}) {
  const stats = { refined: 0, noFile: 0, shiftsMs: [] };
  let next = 0;
  const work = async () => {
    while (next < plan.entries.length && !shouldStop?.()) {
      const e = plan.entries[next++], file = paths.get(e.srcId);
      try {
        if (!file) throw new Error('keine Datei');
        const P = peaks(await decodeMono(file));
        for (const i of e.fresh.cues) {
          const c = e.cues[i]; const s = dsp.onsetNear(P, PEAK_RATE, c.sec, 0.06);
          stats.shiftsMs.push(Math.round((s - c.sec) * 1000)); e.cues[i] = { ...c, sec: s };
        }
        for (const i of e.fresh.loops) {
          const l = e.loops[i]; const d = dsp.onsetNear(P, PEAK_RATE, l.start, 0.06) - l.start;
          e.loops[i] = { ...l, start: l.start + d, end: l.end + d };
        }
        stats.refined++;
      } catch { stats.noFile++; }
      onTrack?.();
    }
  };
  await Promise.all(Array.from({ length: parallel }, work));
  return stats;
}

module.exports.refine = refine;
module.exports.decodeMono = decodeMono;
module.exports.peaks = peaks;
