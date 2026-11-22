// DJ FLOW – Auto-Mix-Planer: Ausschnitte, Stile und Einstiegspunkte für ein ganzes Set berechnen.
// Reine Rechnung ohne Browser, auch im Node-Test nutzbar.
'use strict';
(function (root) {
  const STYLE_IDS = ['breakIn', 'dropIn', 'doubleDrop', 'echoDrop', 'rollDrop', 'spinDrop', 'filterDrop'];
  const WEIGHT = { breakIn: 3, doubleDrop: 2, dropIn: 2, filterDrop: 1.5, rollDrop: 1.5, echoDrop: 1, spinDrop: 0.6 };
  const CUT_BARS = { dropIn: 1, echoDrop: 4, rollDrop: 4, spinDrop: 2, filterDrop: 8 };

  function rng(seed) { let s = (seed >>> 0) || 1; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  /**
   * Struktur eines Tracks für die Planung.
   * t: { uid, bpm, energy, length, grid: { firstBeatSec, beatSec, durationSec }, sections: [{ full, start, end }] } (Sekunden im Track)
   */
  function describe(t) {
    const g = t.grid;
    if (!g?.beatSec) return null;
    const dur = g.durationSec || t.length, bar = g.beatSec * 4, fb = g.firstBeatSec || 0;
    if (!dur || dur < 40 * bar) return null; // zu kurz für sinnvolle Ausschnitte
    const snap = (s) => fb + Math.round((s - fb) / bar) * bar;
    const secs = (t.sections || []).map((s) => ({ full: !!s.full, start: snap(s.start), end: Math.min(dur, snap(s.end)) }));
    const full = secs.filter((s) => s.full && s.start >= fb + 2 * bar);
    // Hauptdrop: längster voller Teil mit mindestens 8 Takten, der nach mindestens 4 Takten beginnt
    const good = full.filter((s) => s.end - s.start >= 8 * bar && s.start >= fb + 4 * bar && s.start <= dur - 16 * bar);
    let main = (good.length ? good : full.filter((s) => s.start <= dur - 16 * bar)).reduce((b, s) => (!b || s.end - s.start > b.end - b.start ? s : b), null);
    if (!main) { const at = snap(fb + 0.4 * (dur - fb)); main = { start: at, end: Math.min(dur, at + 32 * bar), guess: true }; }
    // zweiter Drop für die Rückkehr (A–B–A): deutlich nach dem ersten
    const second = full.filter((s) => s.start >= main.end + 8 * bar && s.end - s.start >= 8 * bar && s.start <= dur - 24 * bar).sort((x, y) => x.start - y.start)[0] || null;
    const bounds = [...new Set(secs.flatMap((s) => [s.start, s.end]))].filter((x) => x > fb && x < dur).sort((x, y) => x - y);
    return { uid: t.uid, bpm: t.bpm, energy: t.energy, dur, bar, fb, main, second, bounds };
  }

  function pickStyle(e, next, prev, allowed, rand, avgBars) {
    const a = e.x, b = next.x, dB = next.ret ? b.d.second : b.d.main;
    const w = {};
    for (const s of allowed) w[s] = WEIGHT[s];
    const room = (dB.start - b.d.fb) / b.d.bar;                   // Takte vor dem Drop von B
    const D = room >= 16 && avgBars >= 28 && rand() < 0.4 ? 16 : 8;
    if (room < D) delete w.breakIn;
    // Tempoabstand (Halb-/Doppeltempo zählt nicht als Abweichung)
    const r = (x, y) => Math.abs(x / y - 1);
    const dev = a.t.bpm && b.t.bpm ? Math.min(r(a.t.bpm, b.t.bpm), r(a.t.bpm, 2 * b.t.bpm), r(2 * a.t.bpm, b.t.bpm)) : 0;
    if (dev > 0.06) {
      if (w.breakIn) w.breakIn *= 0.25;
      if (w.doubleDrop) w.doubleDrop *= 0.15;
      for (const s of ['dropIn', 'echoDrop', 'spinDrop']) if (w[s]) w[s] *= 1.8; // harte Wechsel verstecken Tempounterschiede
    }
    const de = (b.t.energy ?? 5) - (a.t.energy ?? 5);
    if (de >= 2) { if (w.rollDrop) w.rollDrop *= 1.8; if (w.filterDrop) w.filterDrop *= 1.6; if (w.breakIn) w.breakIn *= 1.3; }
    else if (de <= -2) { if (w.echoDrop) w.echoDrop *= 1.6; if (w.doubleDrop) w.doubleDrop *= 0.7; }
    if (prev && w[prev.style]) w[prev.style] *= 0.25; // Abwechslung
    const list = Object.entries(w);
    if (!list.length) return { style: 'dropIn', bars: CUT_BARS.dropIn };
    let x = rand() * list.reduce((s, [, v]) => s + v, 0), style = list[list.length - 1][0];
    for (const [k, v] of list) { if ((x -= v) <= 0) { style = k; break; } }
    return { style, bars: style === 'breakIn' ? D : style === 'doubleDrop' ? 8 : CUT_BARS[style] };
  }

  /** Auf die nächste Abschnittsgrenze in ±tol rasten, falls eine existiert */
  function snapToBound(leave, bounds, minLeave, tol) {
    let best = leave, bd = tol + 1e-6;
    for (const b of bounds) { const d = Math.abs(b - leave); if (b >= minLeave && d < bd) { bd = d; best = b; } }
    return best;
  }

  /**
   * Plan für ein ganzes Set.
   * opts: { totalSec, styles[], returnEvery, seed, master, minBars, firstBuildBars }
   * Rückgabe: { entries: [{ uid, ret, enter, leave, bars, drop, style: { style, bars } | null }], skipped, master, barSec, plannedSec }
   */
  function plan(tracks, opts = {}) {
    const rand = rng(opts.seed ?? 7);
    const allowed = (opts.styles?.length ? opts.styles : STYLE_IDS).filter((s) => STYLE_IDS.includes(s));
    const items = [], skipped = [];
    for (const t of tracks) { const d = describe(t); if (d) items.push({ t, d }); else skipped.push({ uid: t.uid, why: 'kein Beatgrid oder zu kurz' }); }
    if (items.length < 2) return { entries: [], skipped, error: 'Mindestens 2 Tracks mit Beatgrid nötig' };
    const M = opts.master || median(items.map((x) => x.t.bpm).filter(Boolean)) || 128, barSec = 240 / M;
    // Einträge, bei Wunsch mit Rückkehr: A, B, A (A kehrt an seinem zweiten Drop zurück)
    const entries = []; let hosts = 0;
    for (let i = 0; i < items.length; i++) {
      const x = items[i]; entries.push({ x, ret: false }); hosts++;
      if (opts.returnEvery && hosts % opts.returnEvery === 0 && i + 1 < items.length && x.d.second && x.d.second.start - x.d.main.start >= 32 * x.d.bar) {
        entries.push({ x: items[i + 1], ret: false }); entries.push({ x, ret: true }); i++;
      }
    }
    const totalBars = (opts.totalSec || 3600) / barSec, avgBars = totalBars / entries.length;
    let used = 0, prev = null; const out = [];
    for (let k = 0; k < entries.length; k++) {
      const e = entries[k], d = e.x.d, bar = d.bar, drop = e.ret ? d.second : d.main, next = entries[k + 1];
      const style = next ? pickStyle(e, next, prev, allowed, rand, avgBars) : null;
      // Einstieg: erster Track mit Aufbau, nach Blend-Stilen mit Aufbau vor dem Drop, sonst direkt am Drop
      let enter = !prev ? drop.start - (opts.firstBuildBars ?? 8) * bar : prev.style === 'breakIn' ? drop.start - prev.bars * bar : drop.start;
      enter = Math.max(d.fb, enter);
      // Länge nach Restbudget, in 4-Takt-Schritten, mindestens bis 8 Takte nach dem Drop
      const want = Math.max(0, totalBars - used) / (entries.length - k);
      let bars = Math.max(opts.minBars ?? 8, Math.round(want / 4) * 4);
      bars = Math.max(bars, Math.ceil(((drop.start - enter) / bar + 8) / 4) * 4);
      let leave = snapToBound(enter + bars * bar, d.bounds, enter + 8 * bar, 4 * bar);
      const tail = style ? (style.style === 'breakIn' || style.style === 'doubleDrop' ? style.bars : style.style === 'echoDrop' ? 4 : 0) : 0;
      leave = Math.min(leave, d.dur - (tail + 2) * bar);
      // Host vor der Rückkehr: muss vor dem zweiten Drop aufhören
      if (entries[k + 2] && entries[k + 2].ret && entries[k + 2].x === e.x && !e.ret) leave = Math.min(leave, d.second.start - 8 * bar);
      leave = Math.max(leave, enter + 8 * bar);
      const n = Math.round((leave - enter) / bar);
      used += n;
      out.push({ uid: e.x.t.uid, ret: e.ret, enter, leave, bars: n, drop: drop.start, style });
      prev = style;
    }
    return { entries: out, skipped, master: M, barSec, plannedSec: used * barSec };
  }

  const api = { STYLE_IDS, describe, plan };
  if (typeof module !== 'undefined') module.exports = api; else root.AutoMix = api;
})(typeof window !== 'undefined' ? window : globalThis);
