// Schnelltest der Kernlogik ohne Server
const assert = require('assert');
const pl = require('../lib/playlist');
const e = require('../lib/engine');
const tags = require('../lib/tags');
assert.equal(e.camelotOf(1), '8A');
assert.equal(e.camelotOf(7), '11A');
assert.equal(pl.keyScore('8A', '8A'), 1);
assert.ok(pl.keyScore('8A', '9A') > 0.9);
assert.ok(pl.keyScore('8A', '2B') < 0.3);
assert.equal(pl.bpmScore(128, 64), 1);
const g = tags.guessFromFilename('Adam Freeland - Transhuman (Original Mix) - 8A - 135.mp3');
assert.deepEqual([g.artist, g.key, g.bpm], ['Adam Freeland', '8A', 135]);
const fake = Array.from({ length: 60 }, (_, i) => ({ uid: 'x' + i, artist: 'A' + i, title: 'T' + i, bpm: 120 + (i % 15), camelot: `${(i % 12) + 1}A`, energy: (i % 10) + 1, genre: 'Techno', length: 360 }));
const r = pl.generate(fake, { count: 10, curve: 'warmup' });
assert.equal(r.tracks.length, 10);
assert.equal(new Set(r.tracks.map((t) => t.uid)).size, 10);
console.log('✓ alle Tests bestanden');

// Key Lock: Dauer ändert sich, Tonhöhe bleibt
const dsp = require('../public/dsp.js');
{
  const sr = 44100, x = new Float32Array(sr * 4).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / sr));
  for (const rate of [0.94, 1.03, 1.08]) {
    const [y] = dsp.wsola([x], sr, rate);
    assert.ok(Math.abs(y.length - x.length / rate) < 2);
    let z = 0; for (let i = sr; i < y.length - sr; i++) if (y[i - 1] < 0 && y[i] >= 0) z++;
    const f = z / ((y.length - 2 * sr) / sr);
    assert.ok(Math.abs(f - 440) < 4, `Tonhöhe ${f} Hz bei rate ${rate}`);
  }
  const n = 1000, p = { lo: new Float32Array(n), mi: new Float32Array(n), hi: new Float32Array(n), n };
  for (let i = 505; i < n; i++) p.lo[i] = 1;
  assert.ok(Math.abs(dsp.onsetNear(p, 120, 500 / 120, 0.1) - 505 / 120) < 1e-6);
}
console.log('✓ DSP-Tests bestanden');

// Limiter und Lautheit
{
  const sr = 48000, n = sr * 2, sine = (a) => new Float32Array(n).map((_, i) => a * Math.sin((2 * Math.PI * 997 * i) / sr));
  const L = sine(2), R = sine(2), lim = new dsp.Limiter(sr); lim.process(L, R);
  let pk = 0; for (const x of L) pk = Math.max(pk, Math.abs(x));
  assert.ok(pk <= Math.pow(10, -0.3 / 20) + 1e-4, 'Limiter-Decke überschritten: ' + pk);
  assert.ok(pk > 0.9, 'Limiter zu stark: ' + pk);
  const q = sine(0.5), q2 = sine(0.5), orig = sine(0.5), l2 = new dsp.Limiter(sr); l2.process(q, q2);
  const D = l2.N - 1; let e = 0; for (let i = 0; i + D < n; i++) e = Math.max(e, Math.abs(q[i + D] - orig[i]));
  assert.ok(e < 1e-5, 'Leises Signal verändert: ' + e);
  const lu = (a) => dsp.loudness([sine(a), sine(a)], sr);
  assert.ok(Math.abs(lu(1) - lu(0.5) - 6.02) < 0.05, 'Lautheit-Differenz');
  assert.ok(Math.abs(lu(Math.pow(10, -23 / 20)) - -23) < 0.3, 'Referenz: Sinus −23 dBFS auf 2 Kanälen ≈ −23 LUFS, war ' + lu(Math.pow(10, -23 / 20)));
}
console.log('✓ Limiter- und Lautheitstests bestanden');

// Key Lock mit veränderlichem Tempo: Tonhöhe bleibt, Länge folgt der Positionsfunktion
{
  const sr = 44100, x = new Float32Array(sr * 6).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / sr));
  const outLen = sr * 5, pos = (o) => (x.length * Math.pow(o / outLen, 1.3)) * 0.98;
  const [y] = dsp.wsola([x], sr, 1, pos, outLen);
  assert.equal(y.length, outLen);
  let z = 0; for (let i = sr; i < outLen - sr; i++) if (y[i - 1] < 0 && y[i] >= 0) z++;
  const f = z / ((outLen - 2 * sr) / sr); assert.ok(Math.abs(f - 440) < 5, 'Tonhöhe bei Verlauf: ' + f);
}
console.log('✓ Tempo-Key-Lock-Test bestanden');
