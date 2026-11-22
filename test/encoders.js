// Encoder gegen macOS-eigenen Decoder prüfen (afconvert)
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { FORMATS, create } = require('../lib/encoders');
const sr = 44100, n = sr * 5, L = new Float32Array(n), R = new Float32Array(n);
for (let i = 0; i < n; i++) { L[i] = 0.5 * Math.sin(i * 0.03) + 0.1 * (Math.random() - 0.5); R[i] = 0.4 * Math.sin(i * 0.05); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc'));
(async () => { for (const f of Object.keys(FORMATS)) {
  const file = path.join(dir, 't.' + f), w = await create(f, file, sr);
  for (let i = 0; i < n; i += 30000) w.write(L.subarray(i, i + 30000), R.subarray(i, i + 30000));
  w.end();
  const out = path.join(dir, f + '.wav');
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEF32', file, out]);
  const b = fs.readFileSync(out), d = b.indexOf('data') + 8, frames = (b.length - d) / 8;
  assert.ok(Math.abs(frames - n) < 4000, `${f}: ${frames} Frames`);
  if (f !== 'mp3') { assert.equal(frames, n); let e = 0; for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(b.readFloatLE(d + i * 8) - L[i])); assert.ok(e < 1e-5, `${f} Abweichung ${e}`); }
  console.log(`✓ ${f}: ${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${frames} Frames`);
}
fs.rmSync(dir, { recursive: true }); })();
