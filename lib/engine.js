// Engine DJ Datenbank-Zugriff (Engine DJ 2.x / 3.x / 4.x, Schema "Database2/m.db")
// Nutzt das eingebaute node:sqlite – keine nativen Abhängigkeiten.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const cuesLib = require('./cues');
const platform = require('./platform');

// Engine-DJ-Key-Index (0..23) -> Camelot / Musikalisch
const ENGINE_KEYS = [
  ['8B', 'C'], ['8A', 'Am'], ['9B', 'G'], ['9A', 'Em'], ['10B', 'D'], ['10A', 'Bm'],
  ['11B', 'A'], ['11A', 'F#m'], ['12B', 'E'], ['12A', 'C#m'], ['1B', 'B'], ['1A', 'G#m'],
  ['2B', 'F#'], ['2A', 'D#m'], ['3B', 'Db'], ['3A', 'Bbm'], ['4B', 'Ab'], ['4A', 'Fm'],
  ['5B', 'Eb'], ['5A', 'Cm'], ['6B', 'Bb'], ['6A', 'Gm'], ['7B', 'F'], ['7A', 'Dm'],
];
const camelotOf = (k) => (k == null || k < 0 || k > 23 ? null : ENGINE_KEYS[k][0]);
const musicalOf = (k) => (k == null || k < 0 || k > 23 ? null : ENGINE_KEYS[k][1]);

/** Alle Engine-Library-Ordner auf Systemplatte + externen Laufwerken finden */
function discoverLibraries(extraRoots = []) {
  const candidates = platform.engineLibraryCandidates();
  for (const r of extraRoots) candidates.push(r.endsWith('Engine Library') ? r : path.join(r, 'Engine Library'));
  const seen = new Set();
  const out = [];
  for (const dir of candidates) {
    const db = path.join(dir, 'Database2', 'm.db');
    let real;
    try { real = fs.realpathSync(db); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const volume = platform.volumeOf(dir);
    let count = 0;
    try {
      const d = new DatabaseSync(db, { readOnly: true });
      count = d.prepare('SELECT count(*) n FROM Track').get().n;
      d.close();
    } catch { /* gesperrt/kaputt */ }
    out.push({ id: Buffer.from(dir).toString('base64url'), dir, db, volume, trackCount: count });
  }
  return out;
}

// --- Blob-Decoder (Qt qCompress: 4 Byte BE-Länge + zlib) ---
function qUncompress(blob) {
  if (!blob || blob.length < 5) return null;
  try { return zlib.inflateSync(Buffer.from(blob).subarray(4)); } catch { return null; }
}

/** Overview-Waveform: 1024 Einträge (low, mid, high) */
function decodeOverview(blob) {
  const b = qUncompress(blob);
  if (!b || b.length < 16) return null;
  const n = Number(b.readBigUInt64BE(0));
  const pts = [];
  for (let i = 0; i < n && 16 + i * 3 + 2 < b.length; i++) {
    const o = 16 + i * 3;
    pts.push([b[o], b[o + 1], b[o + 2]]);
  }
  return pts;
}

/** Beatgrid: Samplerate, Länge, Marker (sampleOffset, beatNumber) */
function decodeBeatData(blob) {
  const b = qUncompress(blob);
  if (!b || b.length < 25) return null;
  const sampleRate = b.readDoubleBE(0);
  const samples = b.readDoubleBE(8);
  let o = 17;
  const readGrid = () => {
    const n = Number(b.readBigInt64BE(o)); o += 8;
    const markers = [];
    for (let i = 0; i < n; i++) {
      markers.push({ offset: b.readDoubleLE(o), beat: Number(b.readBigInt64LE(o + 8)), beatsToNext: b.readInt32LE(o + 16) });
      o += 24;
    }
    return markers;
  };
  let def = [], adj = [];
  try { def = readGrid(); adj = readGrid(); } catch { /* unvollständig */ }
  const markers = adj.length >= 2 ? adj : def;
  let firstBeatSec = null, beatSec = null;
  if (markers.length >= 2 && sampleRate > 0) {
    const a = markers[0], z = markers[markers.length - 1];
    beatSec = (z.offset - a.offset) / (z.beat - a.beat) / sampleRate;
    // erster Beat >= 0 (Marker kann vor Trackanfang liegen)
    let t = a.offset / sampleRate - a.beat * beatSec;
    while (t < 0) t += beatSec;
    firstBeatSec = t;
  }
  return { sampleRate, durationSec: sampleRate ? samples / sampleRate : null, markers, firstBeatSec, beatSec };
}

/** Hot Cues (8 Stück) */
function decodeQuickCues(blob) {
  const b = qUncompress(blob);
  if (!b || b.length < 8) return [];
  const cues = [];
  try {
    const n = Number(b.readBigInt64BE(0));
    let o = 8;
    for (let i = 0; i < n; i++) {
      const len = b[o]; o += 1;
      const label = b.subarray(o, o + len).toString('utf8'); o += len;
      const pos = b.readDoubleBE(o); o += 8;
      const color = '#' + b.subarray(o + 1, o + 4).toString('hex'); o += 4;
      if (pos >= 0) cues.push({ index: i, label: label || `Cue ${i + 1}`, samples: pos, color });
    }
  } catch { /* egal */ }
  return cues;
}

/** Energie 1..10 aus Overview-Waveform (Lautheit, Bass-Dichte, Höhen, "Drop-Anteil") */
function energyFromOverview(ov) {
  if (!ov || !ov.length) return null;
  const n = ov.length;
  let sum = 0, low = 0, high = 0;
  const loud = [];
  for (const [l, m, h] of ov) {
    const v = l + m + h;
    loud.push(v); sum += v; low += l; high += h;
  }
  const mean = sum / n;
  const sorted = [...loud].sort((a, b) => a - b);
  const p90 = sorted[Math.floor(n * 0.9)] || 1;
  const sustained = loud.filter((v) => v > p90 * 0.75).length / n; // Anteil "voller" Passagen
  const raw = (mean / 3 / 255) * 0.45 + (low / n / 255) * 0.25 + (high / n / 255) * 0.1 + sustained * 0.2;
  return raw; // wird bibliotheksweit auf 1..10 normalisiert
}

/** Mix-In / Mix-Out Vorschläge aus Waveform + Beatgrid (phrasen-ausgerichtet) */
function mixPoints(ov, grid, durationSec) {
  if (!ov || !ov.length || !durationSec) return null;
  const n = ov.length;
  const loud = ov.map(([l, m, h]) => l * 1.4 + m + h * 0.6);
  // geglättet
  const sm = loud.map((_, i) => {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - 6); j <= Math.min(n - 1, i + 6); j++) { s += loud[j]; c++; }
    return s / c;
  });
  const max = Math.max(...sm) || 1;
  const thr = max * 0.72;
  const firstFull = sm.findIndex((v) => v >= thr);
  let lastFull = n - 1;
  while (lastFull > 0 && sm[lastFull] < thr) lastFull--;
  const toSec = (i) => (i / n) * durationSec;
  const res = { introEndSec: toSec(Math.max(0, firstFull)), outroStartSec: toSec(lastFull) };
  if (grid && grid.beatSec) {
    const bar = grid.beatSec * 4, phrase = bar * 16;
    const snap = (t, unit) => grid.firstBeatSec + Math.round((t - grid.firstBeatSec) / unit) * unit;
    res.barSec = bar;
    res.phraseSec = phrase;
    res.mixInSec = Math.max(grid.firstBeatSec, 0);
    res.introBars = Math.max(0, Math.round((res.introEndSec - grid.firstBeatSec) / bar));
    res.mixOutSec = Math.min(durationSec - bar, Math.max(snap(res.outroStartSec, phrase), snap(res.outroStartSec, bar * 8)));
    res.outroBars = Math.max(0, Math.round((durationSec - res.mixOutSec) / bar));
    res.introEndSec = snap(res.introEndSec, bar * 8);
  } else {
    res.mixInSec = 0;
    res.mixOutSec = res.outroStartSec;
  }
  return res;
}

class EngineLibrary {
  constructor(lib) {
    this.lib = lib;
    this.db = new DatabaseSync(lib.db, { readOnly: true });
    this.uuid = this.db.prepare('SELECT uuid FROM Information').get()?.uuid;
  }
  close() { try { this.db.close(); } catch { /* */ } }

  absPath(rel) {
    if (!rel) return null;
    return path.isAbsolute(rel) ? rel : path.resolve(this.lib.dir, rel);
  }

  tracks() {
    const rows = this.db.prepare(`
      SELECT t.id, t.path, t.filename, t.title, t.artist, t.album, t.genre, t.label, t.comment, t.remixer,
             t.year, t.bpm, t.bpmAnalyzed, t.key, t.length, t.rating, t.bitrate, t.fileType, t.dateAdded,
             t.isAnalyzed, t.timeLastPlayed, p.overviewWaveFormData ov
      FROM Track t LEFT JOIN PerformanceData p ON p.trackId = t.id
      WHERE t.path IS NOT NULL`).all();
    return rows.map((r) => {
      const ov = decodeOverview(r.ov);
      return {
        id: r.id,
        libId: this.lib.id,
        volume: this.lib.volume,
        path: this.absPath(r.path),
        filename: r.filename,
        title: r.title, artist: r.artist, album: r.album, genre: r.genre, label: r.label,
        comment: r.comment, remixer: r.remixer, year: r.year,
        bpm: r.bpmAnalyzed ? Math.round(r.bpmAnalyzed * 100) / 100 : r.bpm || null,
        keyIndex: r.key,
        camelot: camelotOf(r.key),
        keyName: musicalOf(r.key),
        length: r.length, rating: r.rating, bitrate: r.bitrate, fileType: r.fileType,
        dateAdded: r.dateAdded, analyzed: !!r.isAnalyzed, lastPlayed: r.timeLastPlayed,
        energyRaw: energyFromOverview(ov),
      };
    });
  }

  performance(trackId) {
    const r = this.db.prepare('SELECT t.length, p.* FROM Track t LEFT JOIN PerformanceData p ON p.trackId=t.id WHERE t.id=?').get(trackId);
    if (!r) return null;
    const overview = decodeOverview(r.overviewWaveFormData);
    const grid = decodeBeatData(r.beatData);
    const dur = grid?.durationSec || r.length;
    const sr = grid?.sampleRate || 44100;
    const qc = cuesLib.decodeCues(r.quickCues);
    const engineCues = qc.cues.map((c) => c && { label: c.label, sec: c.samples / sr, color: c.color });
    const engineLoops = cuesLib.decodeLoops(r.loops).map((l) => l && { label: l.label, start: l.start / sr, end: l.end / sr, color: l.color });
    const g = grid && { firstBeatSec: grid.firstBeatSec, beatSec: grid.beatSec, sampleRate: sr, durationSec: dur };
    return {
      overview,
      grid: g,
      cues: engineCues.filter(Boolean),
      engineCues, engineLoops, mainCue: qc.mainCue >= 0 ? qc.mainCue / sr : null,
      auto: cuesLib.autoCuesLoops(overview, g, dur),
      mix: mixPoints(overview, grid, dur),
    };
  }

  playlists() {
    return this.db.prepare('SELECT id, title, parentListId FROM Playlist').all();
  }
}

const engineIsRunning = platform.engineIsRunning;

/** Playlist direkt in die Engine-DB schreiben (mit Backup, nur wenn Engine DJ geschlossen ist) */
function writePlaylist(lib, title, trackIds, parentTitle = 'DJ FLOW') {
  if (engineIsRunning()) throw new Error('Engine DJ läuft – bitte schließen, bevor in die Datenbank geschrieben wird.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(path.dirname(lib.db), `m.db.djflow-backup-${stamp}`);
  fs.copyFileSync(lib.db, backup);
  const db = new DatabaseSync(lib.db);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    db.exec('BEGIN');
    const uuid = db.prepare('SELECT uuid FROM Information').get().uuid;
    const ins = db.prepare('INSERT INTO Playlist (title, parentListId, isPersisted, nextListId, lastEditTime, isExplicitlyExported) VALUES (?, ?, 1, 0, ?, 1)');
    let parent = db.prepare('SELECT id FROM Playlist WHERE title=? AND parentListId=0').get(parentTitle);
    if (!parent) parent = { id: Number(ins.run(parentTitle, 0, now).lastInsertRowid) };
    let name = title, i = 2;
    while (db.prepare('SELECT 1 FROM Playlist WHERE title=? AND parentListId=?').get(name, parent.id)) name = `${title} (${i++})`;
    const listId = Number(ins.run(name, parent.id, now).lastInsertRowid);
    const insE = db.prepare('INSERT INTO PlaylistEntity (listId, trackId, databaseUuid, nextEntityId, membershipReference) VALUES (?, ?, ?, 0, 0)');
    const ids = trackIds.map((t) => Number(insE.run(listId, t, uuid).lastInsertRowid));
    const upd = db.prepare('UPDATE PlaylistEntity SET nextEntityId=? WHERE id=?');
    for (let k = 0; k < ids.length - 1; k++) upd.run(ids[k + 1], ids[k]);
    db.exec('COMMIT');
    return { listId, name, backup };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  } finally { db.close(); }
}

function backupDb(lib) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(path.dirname(lib.db), `m.db.djflow-backup-${stamp}`);
  fs.copyFileSync(lib.db, backup);
  return backup;
}

/**
 * Hot Cues + Loops in die Engine-DB schreiben.
 * entries: [{ trackId, cues: [8 | null] (sec), loops: [8 | null] (sec), mainCue (sec|null) }]
 */
function writeCuesLoops(lib, entries, opt = {}) {
  if (engineIsRunning()) throw new Error('Engine DJ läuft – bitte schließen, bevor Cues/Loops geschrieben werden.');
  const backup = opt.backup === false ? null : backupDb(lib);
  const db = new DatabaseSync(lib.db);
  let written = 0;
  try {
    db.exec('BEGIN');
    const get = db.prepare('SELECT quickCues, beatData FROM PerformanceData WHERE trackId=?');
    const upd = db.prepare('UPDATE PerformanceData SET quickCues=?, loops=? WHERE trackId=?');
    for (const e of entries) {
      const row = get.get(e.trackId);
      if (!row) continue;
      const sr = decodeBeatData(row.beatData)?.sampleRate || 44100;
      const old = cuesLib.decodeCues(row.quickCues);
      const cues = Array.from({ length: 8 }, (_, i) => { const c = e.cues?.[i]; return c ? { label: c.label, samples: c.sec * sr, color: c.color } : null; });
      const loops = Array.from({ length: 8 }, (_, i) => { const l = e.loops?.[i]; return l ? { label: l.label, start: l.start * sr, end: l.end * sr, color: l.color } : null; });
      const main = e.mainCue != null ? e.mainCue * sr : old.mainCue;
      upd.run(cuesLib.encodeCues({ cues, mainCue: main, mainCueAdjusted: e.mainCue != null ? 1 : old.mainCueAdjusted, defaultMainCue: old.defaultMainCue }), cuesLib.encodeLoops(loops), e.trackId);
      written++;
    }
    db.exec('COMMIT');
    return { written, backup };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw err;
  } finally { db.close(); }
}

module.exports = {
  writeCuesLoops,
  ENGINE_KEYS, camelotOf, musicalOf, discoverLibraries, EngineLibrary, engineIsRunning, writePlaylist,
  decodeOverview, decodeBeatData, decodeQuickCues, mixPoints,
};
