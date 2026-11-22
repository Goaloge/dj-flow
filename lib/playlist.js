// Intelligenter Playlist-Generator: harmonisch (Camelot), BPM-Fluss, Energiekurve, Genre
'use strict';

function parseCamelot(c) {
  const m = /^(\d{1,2})([AB])$/i.exec(c || '');
  return m ? { n: Number(m[1]), l: m[2].toUpperCase() } : null;
}

/** Harmonische Kompatibilität 0..1 */
function keyScore(a, b) {
  const x = parseCamelot(a), y = parseCamelot(b);
  if (!x || !y) return 0.4;
  const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (d === 0 && x.l === y.l) return 1;          // gleiche Tonart
  if (d === 0) return 0.9;                       // Dur/Moll-Wechsel
  if (d === 1 && x.l === y.l) return 0.92;       // ±1 (Energy Boost / Drop)
  if (d === 2 && x.l === y.l) return 0.6;        // +2 Energy Boost
  if (d === 1) return 0.55;                      // Diagonal
  if (d === 7 && x.l === y.l) return 0.5;        // +7 Semitone-Trick
  return Math.max(0, 0.3 - d * 0.04);
}

/** BPM-Kompatibilität inkl. Halb-/Doppeltempo */
function bpmScore(a, b) {
  if (!a || !b) return 0.4;
  const r = [b / a, (b * 2) / a, b / (a * 2)].map((x) => Math.abs(1 - x));
  const diff = Math.min(...r) * 100; // Prozent Pitch-Änderung nötig
  if (diff <= 1) return 1;
  if (diff <= 3) return 0.9;
  if (diff <= 6) return 0.65;
  if (diff <= 8) return 0.4;
  return Math.max(0, 0.3 - diff / 50);
}

function energyScore(a, b) {
  if (a == null || b == null) return 0.5;
  return Math.max(0, 1 - Math.abs(a - b) / 4);
}

function genreScore(a, b) {
  if (!a || !b) return 0.6;
  if (a.toLowerCase() === b.toLowerCase()) return 1;
  const fam = (g) => {
    g = g.toLowerCase();
    if (/techno|acid|industrial/.test(g)) return 'techno';
    if (/house|disco|garage/.test(g)) return 'house';
    if (/trance|psy|goa/.test(g)) return 'trance';
    if (/edm|electro|big room|dance/.test(g)) return 'edm';
    if (/drum|dnb|jungle|breaks/.test(g)) return 'breaks';
    return g;
  };
  return fam(a) === fam(b) ? 0.8 : 0.35;
}

/** Gesamt-Übergangs-Score A -> B (0..100) mit Erklärung */
function transition(a, b) {
  const k = keyScore(a.camelot, b.camelot);
  const p = bpmScore(a.bpm, b.bpm);
  const e = energyScore(a.energy, b.energy);
  const g = genreScore(a.genre, b.genre);
  const score = Math.round((k * 0.38 + p * 0.34 + e * 0.16 + g * 0.12) * 100);
  const notes = [];
  if (k >= 0.9) notes.push('harmonisch perfekt'); else if (k < 0.5) notes.push('Key-Clash');
  if (p < 0.65) notes.push(`BPM-Sprung ${a.bpm}→${b.bpm}`);
  if (b.energy != null && a.energy != null && b.energy - a.energy >= 3) notes.push('großer Energie-Sprung');
  return { score, key: k, bpm: p, energy: e, genre: g, notes };
}

// Energiekurven (Position 0..1 -> Zielenergie 1..10)
const CURVES = {
  warmup:  (x) => 3 + x * 3,
  peak:    (x) => 7 + Math.min(1, x * 2) * 2.5,
  journey: (x) => 4 + Math.sin(x * Math.PI) * 5,
  wave:    (x) => 6 + Math.sin(x * Math.PI * 4) * 2.5 + x,
  cooldown:(x) => 8 - x * 5,
  steady:  () => 6.5,
};

function bpmTarget(opts, x) {
  if (opts.bpmStart && opts.bpmEnd) return opts.bpmStart + (opts.bpmEnd - opts.bpmStart) * x;
  return null;
}

/**
 * Playlist erzeugen.
 * opts: { genres[], bpmMin, bpmMax, bpmStart, bpmEnd, keys[], energyMin, energyMax, curve, count, minutes, startTrackId, harmonicStrict, avoidRecent }
 */
function generate(all, opts = {}) {
  let pool = all.filter((t) => t.bpm && t.camelot && !t.offline);
  if (opts.genres?.length) {
    const gs = opts.genres.map((g) => g.toLowerCase());
    pool = pool.filter((t) => t.genre && gs.some((g) => t.genre.toLowerCase().includes(g)));
  }
  if (opts.bpmMin) pool = pool.filter((t) => t.bpm >= opts.bpmMin);
  if (opts.bpmMax) pool = pool.filter((t) => t.bpm <= opts.bpmMax);
  if (opts.energyMin) pool = pool.filter((t) => t.energy >= opts.energyMin);
  if (opts.energyMax) pool = pool.filter((t) => t.energy <= opts.energyMax);
  if (opts.keys?.length) pool = pool.filter((t) => opts.keys.includes(t.camelot));
  if (!pool.length) return { tracks: [], transitions: [], poolSize: 0 };

  const curve = CURVES[opts.curve] || CURVES.journey;
  const targetMin = opts.minutes ? opts.minutes * 60 : null;
  const count = targetMin ? 500 : Math.min(opts.count || 20, pool.length);
  const used = new Set();
  const usedNames = new Set();
  const nameKey = (t) => `${t.artist}|${t.title}`.toLowerCase().replace(/\(.*?\)|[^a-z0-9|]/g, '');
  const list = [];

  // Start: gewählter Track oder bester Treffer zur Startenergie
  let cur = opts.startTrackId ? pool.find((t) => t.uid === opts.startTrackId) : null;
  if (!cur) {
    const e0 = curve(0), b0 = bpmTarget(opts, 0);
    const cands = pool
      .map((t) => ({ t, s: -Math.abs((t.energy ?? 5) - e0) - (b0 ? Math.abs(t.bpm - b0) / 3 : 0) + Math.random() * 0.8 }))
      .sort((a, b) => b.s - a.s);
    cur = cands[0].t;
  }
  list.push(cur); used.add(cur.uid); usedNames.add(nameKey(cur));
  let total = cur.length || 0;
  const recentArtists = [cur.artist];

  while (list.length < count && (!targetMin || total < targetMin)) {
    const x = targetMin ? Math.min(1, total / targetMin) : list.length / Math.max(1, count - 1);
    const eT = curve(x), bT = bpmTarget(opts, x);
    let best = null, bestS = -Infinity;
    for (const t of pool) {
      if (used.has(t.uid) || usedNames.has(nameKey(t))) continue;
      const tr = transition(cur, t);
      if (opts.harmonicStrict && tr.key < 0.85) continue;
      let s = tr.score;
      s -= Math.abs((t.energy ?? 5) - eT) * 6;           // Energiekurve folgen
      if (bT) s -= Math.abs(t.bpm - bT) * 1.5;           // BPM-Rampe folgen
      if (recentArtists.includes(t.artist)) s -= 15;      // Abwechslung
      s += Math.random() * 4;                             // leichte Kreativität
      if (s > bestS) { bestS = s; best = t; }
    }
    if (!best) break;
    list.push(best); used.add(best.uid); usedNames.add(nameKey(best));
    total += best.length || 0;
    recentArtists.push(best.artist); if (recentArtists.length > 4) recentArtists.shift();
    cur = best;
  }
  const transitions = list.slice(1).map((t, i) => transition(list[i], t));
  return { tracks: list, transitions, poolSize: pool.length, totalSec: total };
}

/** "Was passt als Nächstes?" – Top-N Vorschläge zu einem Track */
function suggestNext(all, track, n = 15) {
  return all
    .filter((t) => t.uid !== track.uid && t.bpm && !t.offline)
    .map((t) => ({ t, tr: transition(track, t) }))
    .sort((a, b) => b.tr.score - a.tr.score)
    .slice(0, n)
    .map(({ t, tr }) => ({ ...t, match: tr }));
}

/** Set-Doktor: Analyse einer bestehenden Reihenfolge */
function analyzeSet(tracks) {
  const transitions = tracks.slice(1).map((t, i) => transition(tracks[i], t));
  const avg = transitions.length ? Math.round(transitions.reduce((s, t) => s + t.score, 0) / transitions.length) : 0;
  const weak = transitions.map((t, i) => ({ i, ...t })).filter((t) => t.score < 60);
  return { transitions, avg, weak };
}

/** Reihenfolge optimieren (Greedy + 2-Opt) */
function optimizeOrder(tracks) {
  if (tracks.length < 3) return tracks;
  const cost = (a, b) => 100 - transition(a, b).score;
  const rest = [...tracks.slice(1)];
  const order = [tracks[0]];
  while (rest.length) {
    const last = order[order.length - 1];
    let bi = 0;
    for (let i = 1; i < rest.length; i++) if (cost(last, rest[i]) < cost(last, rest[bi])) bi = i;
    order.push(rest.splice(bi, 1)[0]);
  }
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 1; i < order.length - 2; i++) {
      for (let j = i + 1; j < order.length - 1; j++) {
        const d = cost(order[i - 1], order[i]) + cost(order[j], order[j + 1]) - cost(order[i - 1], order[j]) - cost(order[i], order[j + 1]);
        if (d > 0.5) { order.splice(i, j - i + 1, ...order.slice(i, j + 1).reverse()); improved = true; }
      }
    }
  }
  return order;
}

function toM3U(tracks, title) {
  const lines = ['#EXTM3U', `#PLAYLIST:${title}`];
  for (const t of tracks) {
    lines.push(`#EXTINF:${Math.round(t.length || 0)},${t.artist || ''} - ${t.title || t.filename}`);
    lines.push(t.path);
  }
  return lines.join('\n') + '\n';
}

module.exports = { generate, transition, suggestNext, analyzeSet, optimizeOrder, toM3U, keyScore, bpmScore, CURVES };
