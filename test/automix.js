// Auto-Mix-Planer: Länge, Raster, Drop-Ausrichtung, Abwechslung, Rückkehr
const assert = require('assert');
const AM = require('../public/automix.js');

function track(i, seed) {
  let s = seed * 9301 + i * 49297; const r = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const bpm = 124 + Math.round(r() * 10), beat = 60 / bpm, bar = beat * 4, dur = 300 + Math.round(r() * 120);
  const fb = 0.1 + r() * 0.05, t = (b) => fb + b * bar;
  const intro = 8 * (2 + Math.floor(r() * 3)), d1 = 32 + Math.floor(r() * 16), brk = 16, d2 = 32;
  const sections = [{ full: false, start: t(0), end: t(intro) }, { full: true, start: t(intro), end: t(intro + d1) }, { full: false, start: t(intro + d1), end: t(intro + d1 + brk) }, { full: true, start: t(intro + d1 + brk), end: t(intro + d1 + brk + d2) }, { full: false, start: t(intro + d1 + brk + d2), end: dur }];
  return { uid: '1:' + i, bpm, energy: 1 + Math.floor(r() * 10), length: dur, grid: { firstBeatSec: fb, beatSec: beat, durationSec: dur }, sections };
}
const tracks = Array.from({ length: 100 }, (_, i) => track(i, 3));

// 100 Songs in 60 Minuten
let p = AM.plan(tracks, { totalSec: 3600, seed: 11 });
const first = p;
assert.equal(p.entries.length, 100);
assert.ok(Math.abs(p.plannedSec - 3600) / 3600 < 0.06, 'Gesamtdauer ' + p.plannedSec);
const info = new Map(tracks.map((t) => [t.uid, AM.describe(t)]));
const onGrid = (d, x) => Math.abs(((x - d.fb) / d.bar) % 1) < 1e-6 || Math.abs(((x - d.fb) / d.bar) % 1 - 1) < 1e-6;
p.entries.forEach((e, k) => {
  const d = info.get(e.uid);
  assert.ok(e.enter >= d.fb - 1e-6 && e.leave <= d.dur, 'außerhalb des Tracks ' + k);
  assert.ok(e.leave - e.enter >= 8 * d.bar - 1e-6, 'Ausschnitt zu kurz ' + k);
  assert.ok(onGrid(d, e.enter) && onGrid(d, e.leave), 'nicht auf dem Raster ' + k);
  const prev = k ? p.entries[k - 1].style : null;
  if (prev && prev.style === 'breakIn') assert.ok(Math.abs(e.drop - (e.enter + prev.bars * d.bar)) < 1e-6, 'Drop nicht am Blend-Ende ' + k);
  if (prev && prev.style !== 'breakIn') assert.ok(Math.abs(e.drop - e.enter) < 1e-6, 'Cut/Double: B muss am Drop starten ' + k);
  if (k < 99) assert.ok(e.style, 'Stil fehlt ' + k); else assert.equal(e.style, null);
});
for (let k = 2; k < 99; k++) assert.ok(!(p.entries[k].style.style === p.entries[k - 1].style.style && p.entries[k - 1].style.style === p.entries[k - 2].style.style), 'Stil dreimal hintereinander ' + k);
const used = new Set(p.entries.map((e) => e.style?.style).filter(Boolean));
assert.ok(used.size >= 5, 'zu wenig Abwechslung: ' + [...used]);

// nur ausgewählte Stile
p = AM.plan(tracks.slice(0, 20), { totalSec: 1200, styles: ['dropIn', 'echoDrop'], seed: 2 });
assert.ok(p.entries.slice(0, -1).every((e) => ['dropIn', 'echoDrop'].includes(e.style.style)));

// Rückkehr A–B–A
p = AM.plan(tracks.slice(0, 20), { totalSec: 1800, returnEvery: 4, seed: 5 });
const rets = p.entries.filter((e) => e.ret);
assert.ok(rets.length >= 1, 'keine Rückkehr geplant');
for (const r of rets) {
  const idx = p.entries.indexOf(r), host = p.entries[idx - 2], d = info.get(r.uid);
  assert.equal(host.uid, r.uid, 'Rückkehr gehört zum Host');
  assert.ok(host.leave <= d.second.start - 8 * d.bar + 1e-6, 'Host hört zu spät auf');
  assert.ok(r.drop === d.second.start, 'Rückkehr nicht am zweiten Drop');
}

// kürzere Gesamtdauer → kürzere Ausschnitte; ohne Beatgrid wird übersprungen
const short = AM.plan(tracks.slice(0, 10), { totalSec: 600, seed: 1 }), long = AM.plan(tracks.slice(0, 10), { totalSec: 1800, seed: 1 });
assert.ok(short.entries[3].bars < long.entries[3].bars);
const bad = AM.plan([tracks[0], { ...tracks[1], grid: null }, tracks[2]], { totalSec: 300 });
assert.equal(bad.skipped.length, 1); assert.equal(bad.entries.length, 2);
assert.ok(AM.plan([tracks[0]], {}).error);
console.log(`✓ Auto-Mix-Planer: 100 Tracks in ${(first.plannedSec / 60).toFixed(1)} Min geplant, ${used.size} Stile, ${rets.length} Rückkehr(en) im Test mit 20 Tracks`);
