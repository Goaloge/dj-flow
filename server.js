#!/usr/bin/env node
// DJ FLOW – lokaler Server (keine Electron-Installation nötig). Start: npm start
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const platform = require('./lib/platform');
const engine = require('./lib/engine');
const tags = require('./lib/tags');
const pl = require('./lib/playlist');
const encoders = require('./lib/encoders');
const stems = require('./lib/stems');
const decode = require('./lib/decode');
const libtools = require('./lib/libtools');

const PORT = Number(process.env.PORT) || 4747;
const ROOT = __dirname;
const DATA = process.env.DJFLOW_DATA || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
stems.init(DATA);

// ---------- Persistenz ----------
const jsonFile = (name, def) => ({
  file: path.join(DATA, name),
  // Fehlende Einstellungen mit Standardwerten auffüllen (sonst fehlt z.B. der Export-Ordner in einer alten oder leeren Datei)
  load() { try { const v = JSON.parse(fs.readFileSync(this.file, 'utf8')); return def && !Array.isArray(def) && typeof def === 'object' && v && typeof v === 'object' ? { ...def, ...v } : v; } catch { return def; } },
  save(v) { fs.writeFileSync(this.file, JSON.stringify(v, null, 2)); },
});
const settingsStore = jsonFile('settings.json', { extraRoots: [], exportDir: path.join(require('os').homedir(), 'Music', 'DJ FLOW Playlists') });
const markersStore = jsonFile('markers.json', {});
const editsStore = jsonFile('edits.json', {});
const trashedStore = jsonFile('trashed.json', []);
const setsStore = jsonFile('sets.json', []);

// ---------- Bibliothek laden (mit Cache) ----------
let LIBS = [];
const LIBROWS = new Map(); // Library-ID -> Track-Zeilen (auch Duplikate, die in TRACKS zusammengeführt sind)
const BACKED_UP = new Set(); // je Library ein Backup pro Programmstart
let LIBJOB = null;
let TRACKS = [];
let BY_UID = new Map();
const OPEN = new Map();

function openLib(lib) {
  if (!OPEN.has(lib.id)) OPEN.set(lib.id, new engine.EngineLibrary(lib));
  return OPEN.get(lib.id);
}

function loadAll(force = false) {
  for (const l of OPEN.values()) l.close();
  OPEN.clear();
  LIBS = engine.discoverLibraries(settingsStore.load().extraRoots);
  const all = [];
  for (const lib of LIBS) {
    if (!lib.trackCount) continue;
    const mtime = fs.statSync(lib.db).mtimeMs;
    const cacheFile = path.join(DATA, `cache-${lib.id.slice(-24)}.json`);
    let rows = null;
    if (!force) {
      try {
        const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (c.mtime === mtime && c.dir === lib.dir) rows = c.rows;
      } catch { /* kein Cache */ }
    }
    if (!rows) {
      const t0 = Date.now();
      rows = openLib(lib).tracks();
      fs.writeFileSync(cacheFile, JSON.stringify({ mtime, dir: lib.dir, rows }));
      console.log(`  ↳ ${lib.volume}: ${rows.length} Tracks eingelesen (${Date.now() - t0} ms)`);
    }
    LIBROWS.set(lib.id, rows);
    all.push(...rows);
  }
  // Energie bibliotheksweit auf 1..10 normalisieren (Perzentil)
  const vals = all.map((t) => t.energyRaw).filter((v) => v != null).sort((a, b) => a - b);
  const rank = (v) => {
    let lo = 0, hi = vals.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] < v) lo = m + 1; else hi = m; }
    return lo / Math.max(1, vals.length - 1);
  };
  for (const t of all) {
    t.uid = `${t.libId}:${t.id}`;
    t.energy = t.energyRaw != null ? Math.max(1, Math.min(10, Math.round(1 + rank(t.energyRaw) * 9))) : null;
  }
  // Doppelte (gleiche Datei in mehreren Libraries) zusammenführen
  const seen = new Map();
  TRACKS = [];
  const gone = new Set(trashedStore.load());
  for (const t of all) {
    if (gone.has(t.path)) continue; // in den Papierkorb gelegt, steht aber noch in der Engine-DB
    const k = t.path;
    if (seen.has(k)) { seen.get(k).alsoIn = (seen.get(k).alsoIn || []).concat(t.volume); continue; }
    seen.set(k, t); TRACKS.push(t);
  }
  BY_UID = new Map(TRACKS.map((t) => [t.uid, t]));
  console.log(`DJ FLOW: ${TRACKS.length} Tracks aus ${LIBS.length} Libraries`);
}

/** „123:456#2“ ist ein zweites Vorkommen desselben Tracks (A–B–A); für alle Datenzugriffe zählt die Basis-uid */
const baseUid = (u) => String(u).replace(/#\d+$/, '');
const trackOf = (u) => BY_UID.get(baseUid(u));
function libOf(uid) {
  const [libId, id] = baseUid(uid).split(':');
  const lib = LIBS.find((l) => l.id === libId);
  return lib ? { lib: openLib(lib), id: Number(id), meta: lib } : null;
}

const slim = (t) => {
  const { energyRaw, ...rest } = t;
  return rest;
};

// ---------- HTTP-Helfer ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.ogg': 'audio/ogg' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function streamFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'Datei nicht gefunden (Laufwerk getrennt?)' }); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = Number(s), end = e ? Number(e) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  }
}

function drives() {
  const out = [];
  for (const v of platform.listVolumes()) {
    try {
      const st = fs.statfsSync(v.mount);
      const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
      out.push({
        name: v.name, mount: v.mount, totalGB: +(total / 1073741824).toFixed(1), freeGB: +(free / 1073741824).toFixed(1),
        usedPct: total ? Math.round((1 - free / total) * 100) : 0,
        engineLibrary: LIBS.find((l) => l.volume === v.name) || null,
        tracksOnDrive: TRACKS.filter((t) => platform.isOnVolume(t.path, v)).length,
      });
    } catch { /* nicht lesbar */ }
  }
  return out;
}

// ---------- Routen ----------
let RENDER = null;
const FILE_OK = new Map(); // Zwischenspeicher: Datei vorhanden?
const routes = {
  'GET /api/status': () => ({ ffmpeg: !!decode.find(), tracks: TRACKS.length, libraries: LIBS, engineRunning: engine.engineIsRunning(), settings: settingsStore.load() }),
  'GET /api/tracks': () => TRACKS.map(slim),
  'GET /api/drives': () => drives(),
  'POST /api/rescan': () => { loadAll(true); return { ok: true, tracks: TRACKS.length }; },
  'POST /api/settings': (b) => { const s = { ...settingsStore.load(), ...b }; settingsStore.save(s); return s; },
  'POST /api/libraries/add': (b) => {
    const s = settingsStore.load();
    if (b.root && !s.extraRoots.includes(b.root)) s.extraRoots.push(b.root);
    settingsStore.save(s); loadAll(); return { libraries: LIBS };
  },
  'GET /api/perf': (_, q) => {
    const r = libOf(q.get('uid'));
    if (!r) throw new Error('Unbekannter Track');
    return { ...r.lib.performance(r.id), markers: markersStore.load()[q.get('uid')] || [], edit: editsStore.load()[q.get('uid')] || null };
  },
  'POST /api/markers': (b) => {
    const m = markersStore.load();
    m[b.uid] = b.markers || [];
    markersStore.save(m); return { ok: true };
  },
  // Lokale Bearbeitung je Track: { mixIn, mixOut, cues[8], loops[8], dirty }
  'POST /api/edits': (b) => {
    const m = editsStore.load();
    if (b.edit) m[b.uid] = { ...b.edit, savedAt: Date.now() }; else delete m[b.uid];
    editsStore.save(m); return { ok: true };
  },
  // Cues & Loops in die Engine-DB schreiben (pro Library gruppiert, mit Backup)
  'POST /api/engine/cues': (b) => {
    const edits = editsStore.load();
    const byLib = new Map();
    for (const uid of b.uids || []) {
      const e = edits[uid]; const r = libOf(uid);
      if (!e || !r) continue;
      if (!byLib.has(r.meta.id)) byLib.set(r.meta.id, { lib: r.meta, entries: [], uids: [] });
      byLib.get(r.meta.id).entries.push({ trackId: r.id, cues: e.cues, loops: e.loops, mainCue: e.mainCue ?? null });
      byLib.get(r.meta.id).uids.push(uid);
    }
    for (const l of OPEN.values()) l.close();
    OPEN.clear();
    const results = [];
    for (const { lib, entries, uids } of byLib.values()) {
      const r = engine.writeCuesLoops(lib, entries);
      for (const u of uids) edits[u].dirty = false;
      results.push({ library: lib.dir, ...r });
    }
    editsStore.save(edits);
    return { results };
  },
  'GET /api/sets': () => setsStore.load(),
  'POST /api/sets': (b) => {
    const all = setsStore.load();
    const s = { ...b, id: b.id || `set-${Date.now()}`, updated: Date.now() };
    const i = all.findIndex((x) => x.id === s.id);
    if (i >= 0) all[i] = s; else all.unshift(s);
    setsStore.save(all); return s;
  },
  'POST /api/sets/delete': (b) => { setsStore.save(setsStore.load().filter((s) => s.id !== b.id)); return { ok: true }; },
  'GET /api/tags': async (_, q) => {
    const t = trackOf(q.get('uid'));
    if (!t) throw new Error('Unbekannter Track');
    return { file: await tags.readTags(t.path), engine: slim(t), guess: tags.guessFromFilename(t.filename || t.path) };
  },
  'POST /api/tags': (b) => {
    const t = trackOf(b.uid);
    if (!t) throw new Error('Unbekannter Track');
    const lost = tags.writeTags(t.path, b.tags);
    Object.assign(t, Object.fromEntries(Object.entries(b.tags).filter(([k]) => ['title', 'artist', 'album', 'genre', 'label', 'year', 'comment'].includes(k))));
    return { ok: true, lost };
  },
  'GET /api/missing': () => {
    const fields = ['title', 'artist', 'genre', 'bpm', 'camelot', 'year', 'album'];
    return TRACKS.map((t) => ({ uid: t.uid, missing: fields.filter((f) => !t[f]) }))
      .filter((r) => r.missing.length);
  },
  'POST /api/autofix': (b) => {
    // Fehlende Tags aus Engine-Analyse + Dateiname in die Datei schreiben
    const results = [];
    for (const uid of b.uids || []) {
      const t = trackOf(uid);
      if (!t) continue;
      const g = tags.guessFromFilename(t.filename || t.path);
      const patch = {};
      if (!t.title && g.title) patch.title = g.title;
      if (!t.artist && g.artist) patch.artist = g.artist;
      if (t.bpm) patch.bpm = t.bpm;
      if (t.camelot) patch.key = b.keyFormat === 'musical' ? t.keyName : t.camelot;
      if (!t.genre && b.suggestGenre) patch.genre = tags.suggestGenre(t.bpm);
      try {
        const lost = tags.writeTags(t.path, patch);
        Object.assign(t, { title: patch.title ?? t.title, artist: patch.artist ?? t.artist, genre: patch.genre ?? t.genre });
        results.push({ uid, ok: true, patch, lost });
      } catch (e) { results.push({ uid, ok: false, error: e.message }); }
    }
    return { results, note: 'Tags in Dateien geschrieben. In Engine DJ: Tracks markieren → „Reload Tags“, damit Engine die Änderungen übernimmt.' };
  },
  'POST /api/generate': (b) => {
    const exists = (t) => { let v = FILE_OK.get(t.path); if (v === undefined) { v = fs.existsSync(t.path); FILE_OK.set(t.path, v); } return v; };
    const r = pl.generate(TRACKS.filter((t) => (!b.volume || t.volume === b.volume) && (b.available === false || exists(t))), b);
    return { ...r, tracks: r.tracks.map(slim) };
  },
  'POST /api/suggest': (b) => {
    const t = trackOf(b.uid);
    if (!t) throw new Error('Unbekannter Track');
    return pl.suggestNext(TRACKS, t, b.n || 20).map(slim);
  },
  'POST /api/transition': (b) => pl.transition(trackOf(b.a), trackOf(b.b)),
  'POST /api/analyze': (b) => pl.analyzeSet((b.uids || []).map((u) => trackOf(u)).filter(Boolean)),
  'POST /api/optimize': (b) => pl.optimizeOrder((b.uids || []).map((u) => trackOf(u)).filter(Boolean)).map((t) => t.uid),
  'GET /api/duplicates': () => {
    const groups = new Map();
    for (const t of TRACKS) {
      const k = `${(t.artist || '').toLowerCase().replace(/\W/g, '')}|${(t.title || '').toLowerCase().replace(/\(.*?\)|\W/g, '')}`;
      if (k.length < 4) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t.uid);
    }
    return [...groups.values()].filter((g) => g.length > 1).slice(0, 500);
  },
  'POST /api/export': (b) => {
    const tracks = (b.uids || []).map((u) => trackOf(u)).filter(Boolean);
    if (!tracks.length) throw new Error('Playlist ist leer');
    const title = (b.title || 'DJ FLOW Set').replace(/[/:]/g, '-');
    if (b.mode === 'engine') {
      // Alle Tracks müssen aus derselben Engine-Library stammen
      const libId = tracks[0].libId;
      const lib = LIBS.find((l) => l.id === libId);
      const ids = [...new Set(tracks.filter((t) => t.libId === libId).map((t) => t.id))]; // jeder Track nur einmal (Engine verbietet Doppelte)
      const r = engine.writePlaylist(lib, title, ids);
      loadAll(true);
      return { ...r, library: lib.dir, skipped: tracks.length - ids.length };
    }
    const dir = b.folder || settingsStore.load().exportDir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${title}.m3u8`);
    fs.writeFileSync(file, pl.toM3U(tracks, title));
    return { file };
  },
  // Set-Export: Start → Chunks (rohe Float32-L/R) → Ende. Erst am Ende bekommt die Datei ihren Namen.
  'POST /api/render/start': async (b) => {
    const dir = b.folder || settingsStore.load().exportDir;
    fs.mkdirSync(dir, { recursive: true });
    const name = String(b.title || 'DJ FLOW Set').replace(/[\\/:*?"<>|]/g, '-');
    let file = path.join(dir, `${name}.${b.format}`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${name} (${i}).${b.format}`);
    const part = file + '.part';
    RENDER = { file, part, w: await encoders.create(b.format, part, b.sampleRate), clipped: 0 };
    return { file };
  },
  'POST /api/render/finish': (b) => {
    if (!RENDER) throw new Error('Kein Export aktiv');
    const r = RENDER; RENDER = null;
    try { r.w.end(); } catch (e) { fs.rmSync(r.part, { force: true }); throw e; }
    if (b.cancel) { fs.rmSync(r.part, { force: true }); return { cancelled: true }; }
    fs.renameSync(r.part, r.file);
    if (!process.env.NO_OPEN) platform.reveal(r.file);
    return { file: r.file, sizeMB: +(fs.statSync(r.file).size / 1048576).toFixed(1), clipped: r.clipped };
  },
  // Nur Dateien bekannter Tracks; Pfade vom Client werden nicht angenommen
  'POST /api/trash': async (b) => {
    const results = [], gone = trashedStore.load();
    for (const uid of b.uids || []) {
      const t = trackOf(uid);
      if (!t) { results.push({ uid, ok: false, error: 'Unbekannter Track' }); continue; }
      try {
        await platform.trash(t.path);
        gone.push(t.path); BY_UID.delete(uid); TRACKS = TRACKS.filter((x) => x !== t);
        results.push({ uid, ok: true, path: t.path });
      } catch (e) { results.push({ uid, ok: false, error: e.message }); }
    }
    trashedStore.save(gone);
    return { results };
  },
  'GET /api/stems/status': () => stems.status(),
  'POST /api/stems/has': (b) => Object.fromEntries((b.uids || []).map((u) => [u, !!trackOf(u) && stems.hasStems(trackOf(u))])),
  'POST /api/stems/setup': () => { stems.setup(); return stems.status(); },
  'POST /api/stems/separate': (b) => { for (const u of b.uids || []) { const t = trackOf(u); if (t) stems.enqueue(t); } return stems.status(); },
  'POST /api/stems/cancel': () => { stems.cancel(); return { ok: true }; },
  // Ausgeblendete (in den Papierkorb gelegte) Dateien: wieder aufnehmen, sobald sie zurück am Platz sind
  'GET /api/trashed': () => trashedStore.load().map((p) => ({ path: p, exists: fs.existsSync(p) })),
  'POST /api/trashed/restore': (b) => {
    const want = new Set(b.paths || []), back = [], missing = [];
    const rest = trashedStore.load().filter((p) => {
      if (!want.has(p)) return true;
      if (fs.existsSync(p)) { back.push(p); return false; }
      missing.push(p); return true;
    });
    trashedStore.save(rest);
    if (back.length) loadAll();
    return { back, missing };
  },
  'POST /api/trash/open': () => { platform.openTrash(); return { ok: true }; },
  // ---- Libraries-Tab ----
  'GET /api/lib/list': () => LIBS.map((l) => ({ ...l, device: !l.dir.startsWith(require('os').homedir()) && fs.existsSync(path.join(l.dir, 'user.profile')) })),
  'GET /api/lib/tracks': (_, q) => {
    const lib = LIBS.find((l) => l.id === q.get('lib')); if (!lib) throw new Error('Library nicht gefunden');
    const st = libtools.cueStats(lib), gone = new Set(trashedStore.load());
    return (LIBROWS.get(lib.id) || []).filter((t) => !gone.has(t.path)).map((t) => ({ lib: lib.id, volume: lib.volume, id: t.id, uid: `${lib.id}:${t.id}`, artist: t.artist, title: t.title || t.filename, bpm: t.bpm, camelot: t.camelot, length: t.length, genre: t.genre, cues: st[t.id]?.[0] ?? 0, loops: st[t.id]?.[1] ?? 0 }));
  },
  'GET /api/lib/playlists': (_, q) => { const lib = LIBS.find((l) => l.id === q.get('lib')); if (!lib) throw new Error('Library nicht gefunden'); return libtools.playlistTree(lib); },
  'GET /api/lib/playlist': (_, q) => {
    const lib = LIBS.find((l) => l.id === q.get('lib')); if (!lib) throw new Error('Library nicht gefunden');
    const byUuid = new Map(LIBS.map((l) => [openLib(l).uuid, l]));
    const items = libtools.playlistTracks(lib, Number(q.get('id'))), stats = new Map(), rowsOf = new Map(), out = []; let missing = 0;
    for (const it of items) {
      const l = byUuid.get(it.uuid); if (!l) { missing++; continue; }
      if (!stats.has(l.id)) { stats.set(l.id, libtools.cueStats(l)); rowsOf.set(l.id, new Map((LIBROWS.get(l.id) || []).map((t) => [t.id, t]))); }
      const t = rowsOf.get(l.id).get(it.trackId); if (!t) { missing++; continue; }
      const st = stats.get(l.id)[t.id];
      out.push({ id: t.id, lib: l.id, volume: l.volume, uid: `${l.id}:${t.id}`, artist: t.artist, title: t.title || t.filename, bpm: t.bpm, camelot: t.camelot, length: t.length, genre: t.genre, cues: st?.[0] ?? 0, loops: st?.[1] ?? 0 });
    }
    return { tracks: out, missing };
  },
  'GET /api/lib/job': () => LIBJOB && { ...LIBJOB, shifts: undefined },
  'POST /api/lib/stop': () => { if (LIBJOB?.running) LIBJOB.stop = true; return { ok: true }; },
  /** Auto-Cues & Loops: ids = bestimmte Tracks, sonst alle mit fehlenden Cues oder Loops. dry = nur zählen */
  'POST /api/lib/auto': async (b) => {
    const src = LIBS.find((l) => l.id === b.lib), dst = LIBS.find((l) => l.id === (b.target || b.lib));
    if (!src || !dst) throw new Error('Library nicht gefunden');
    if (LIBJOB?.running) throw new Error('Es läuft schon ein Auftrag');
    let ids = b.ids;
    if (!ids) { const st = libtools.cueStats(src); ids = (LIBROWS.get(src.id) || []).map((t) => t.id).filter((i) => !st[i] || st[i][0] === 0 || st[i][1] === 0); }
    const mode = b.mode === 'all' ? 'all' : 'fill';
    if (b.dry) return { tracks: ids.length };
    if (engine.engineIsRunning()) throw new Error('Engine DJ läuft – bitte schließen.');
    // Feinkorrektur nur auf ausdrücklichen Wunsch: gemessen lagen die Beatgrid-Positionen näher am Einschlag (Median 16 statt 33 ms)
    const refine = b.refine === true;
    const job = LIBJOB = { running: true, phase: refine ? 'Berechne und verfeinere' : 'Berechne', done: 0, total: ids.length, target: dst.dir, written: 0, skip: { noGrid: 0, noMatch: 0, nothing: 0 }, refined: 0, noFile: 0, shifts: [], backup: null, stop: false };
    (async () => {
      try {
        // Paketweise: Abbrechen behält bereits geschriebene Pakete
        const CHUNK = refine ? 200 : 2000;
        for (let o = 0; o < ids.length && !job.stop; o += CHUNK) {
          const part = ids.slice(o, o + CHUNK), base = job.done;
          const plan = await libtools.planAuto(src, dst, part, mode, refine ? null : (d) => { job.done = base + d; });
          for (const k of ['noGrid', 'noMatch', 'nothing']) job.skip[k] += plan.skip[k];
          if (refine && plan.entries.length) {
            let n = 0; const skipped = part.length - plan.entries.length;
            const st = await libtools.refine(plan, libtools.pathsOf(src, plan.entries.map((e) => e.srcId)), { onTrack: () => { job.done = base + skipped + ++n; }, shouldStop: () => job.stop });
            job.refined += st.refined; job.noFile += st.noFile; job.shifts.push(...st.shiftsMs);
            if (job.stop) break;
          }
          job.done = base + part.length;
          if (plan.entries.length) {
            for (const l of OPEN.values()) l.close(); OPEN.clear();
            const r = engine.writeCuesLoops(dst, plan.entries, { backup: !BACKED_UP.has(dst.id) });
            if (r.backup) { BACKED_UP.add(dst.id); job.backup = r.backup; }
            job.written += r.written;
          }
        }
        const sh = job.shifts.map(Math.abs).sort((x, y) => x - y);
        Object.assign(job, { running: false, phase: job.stop ? 'Abgebrochen' : 'Fertig', shiftMedianMs: sh.length ? sh[sh.length >> 1] : 0, moved: sh.filter((x) => x > 2).length, shifts: undefined });
      } catch (e) { Object.assign(job, { running: false, phase: 'Fehler', error: e.message, shifts: undefined }); }
    })();
    return job;
  },
  'POST /api/reveal': (b) => { const t = trackOf(b.uid); const p = t ? t.path : b.path; platform.reveal(p); return { ok: true }; },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const host = (req.headers.host || '').split(':')[0];
  const origin = req.headers.origin;
  if (!['localhost', '127.0.0.1'].includes(host) || (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) return send(res, 403, { error: 'verboten' });
  try {
    if (url.pathname === '/api/stems/file') {
      const t = trackOf(url.searchParams.get('uid'));
      return t ? streamFile(req, res, stems.stemFile(t, url.searchParams.get('stem'))) : send(res, 404, { error: 'unbekannt' });
    }
    if (url.pathname === '/api/pcm') {
      const t = trackOf(url.searchParams.get('uid'));
      if (!t) return send(res, 404, { error: 'unbekannt' });
      if (!decode.find() || !fs.existsSync(t.path)) return send(res, 404, { error: 'ffmpeg oder Datei fehlt' });
      return decode.stream(t.path, res, Math.max(0, Number(url.searchParams.get('t')) || 0));
    }
    if (url.pathname === '/api/audio') {
      const t = trackOf(url.searchParams.get('uid'));
      return t ? streamFile(req, res, t.path) : send(res, 404, { error: 'unbekannt' });
    }
    if (url.pathname === '/api/render/chunk' && req.method === 'POST') {
      if (!RENDER) return send(res, 409, { error: 'Kein Export aktiv' });
      const parts = []; for await (const c of req) parts.push(c);
      const raw = Buffer.concat(parts), ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length);
      const n = raw.length / 8, L = new Float32Array(ab, 0, n), R = new Float32Array(ab, n * 4, n);
      for (let i = 0; i < n; i++) if (Math.abs(L[i]) > 1 || Math.abs(R[i]) > 1) RENDER.clipped++;
      RENDER.w.write(L, R);
      return send(res, 200, { ok: true });
    }
    const h = routes[`${req.method} ${url.pathname}`];
    if (h) {
      const b = req.method === 'POST' ? await body(req) : null;
      return send(res, 200, await h(b, url.searchParams));
    }
    // statische Dateien
    let f = path.normalize(path.join(ROOT, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(path.join(ROOT, 'public'))) return send(res, 403, { error: 'verboten' });
    if (!fs.existsSync(f)) return send(res, 404, { error: 'nicht gefunden' });
    send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

/** Server starten; liefert die URL. Belegter Port → nächster freier. */
function start({ port = PORT, open = false } = {}) {
  loadAll();
  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && port < PORT + 20) server.listen(++port, '127.0.0.1');
      else reject(e);
    });
    server.on('listening', () => {
      const u = `http://localhost:${port}`;
      console.log(`\n  🎧 DJ FLOW läuft auf ${u}\n`);
      if (open) platform.openUrl(u);
      resolve(u);
    });
    server.listen(port, '127.0.0.1');
  });
}

if (require.main === module) start({ open: !process.env.NO_OPEN });
module.exports = { start };
