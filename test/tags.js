// Tags schreiben für alle Formate: Werte kommen zurück, Audio bleibt bitgleich, Cover bleibt erhalten
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const tags = require('../lib/tags');
const ff = require('../lib/decode').find();
if (!ff) { console.log('– Tag-Tests übersprungen (kein ffmpeg)'); process.exit(0); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagtest'));
const md5 = (f) => execFileSync(ff, ['-v', 'error', '-i', f, '-map', '0:a:0', '-f', 'md5', '-'], { encoding: 'utf8' }).trim();
(async () => {
  const cover = path.join(dir, 'c.png');
  execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', cover]);
  for (const ext of ['mp3', 'wav', 'aiff', 'flac']) {
    const f = path.join(dir, 'x.' + ext);
    const coverArgs = ['flac', 'm4a', 'mp3'].includes(ext) ? ['-i', cover, '-map', '0', '-map', '1', '-disposition:v', 'attached_pic', ...(ext === 'm4a' ? ['-c:v', 'png'] : [])] : [];
    execFileSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', ...coverArgs, '-ac', '2', ...(ext === 'mp3' ? ['-id3v2_version', '3'] : []), f]);
    // vorhandenes Sonderfeld, das erhalten bleiben muss
    if (ext === 'flac') { const g = f + '.g.flac'; execFileSync(ff, ['-v', 'error', '-i', f, '-map', '0', '-c', 'copy', '-metadata', 'MIXEDINKEY=keep', g]); fs.renameSync(g, f); }
    if (ext === 'wav' || ext === 'aiff') tags.writeTags(f, { title: 'alt' });
    if (ext === 'wav' || ext === 'aiff' || ext === 'mp3') { if (ext === 'mp3') require('node-id3').update({ userDefinedText: [{ description: 'MIXEDINKEY', value: 'keep' }] }, f); }
    const before = md5(f);
    const t = { title: 'Täst ✓', artist: 'D.j. Mr. Brown', album: 'AL', genre: 'Acid', year: 2024, bpm: 133, key: '8A', label: 'LB', remixer: 'RX', comment: 'CM' };
    const lost = tags.writeTags(f, t);
    tags.writeTags(f, { genre: 'Techno' }); // zweites Schreiben ändert nur ein Feld
    const r = await tags.readTags(f);
    assert.equal(md5(f), before, ext + ': Audio verändert');
    assert.equal(r.title, t.title, ext + ' Titel'); assert.equal(r.artist, t.artist, ext + ' Artist'); assert.equal(r.genre, 'Techno', ext + ' Genre');
    assert.equal(Number(r.bpm), 133, ext + ' BPM');
    if (!lost.includes('key')) assert.equal(r.key, '8A', ext + ' Key');
    if (coverArgs.length) assert.ok(r.cover, ext + ': Cover verloren');
    const mm = await import('music-metadata'), nat = JSON.stringify((await mm.parseFile(f)).native);
    if (ext === 'flac' || ext === 'mp3') assert.ok(nat.includes('keep'), ext + ': Sonderfeld verloren');
    assert.ok(!fs.readdirSync(dir).some((n) => n.includes('djflow-tmp')), 'Temp-Datei übrig');
    console.log(`✓ ${ext}: Tags gelesen, Audio unverändert${coverArgs.length ? ', Cover erhalten' : ''}${lost.length ? ' (nicht speicherbar: ' + lost.join(', ') + ')' : ''}`);
  }
  // M4A darf nicht beschrieben werden
  assert.throws(() => tags.writeTags(path.join(dir, 'y.m4a'), { title: 'x' }));
  console.log('✓ m4a wird abgelehnt');
  fs.rmSync(dir, { recursive: true });
})().catch((e) => { console.error(e.message); process.exit(1); });
