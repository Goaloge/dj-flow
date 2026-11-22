// Dekodierung mit ffmpeg: Der Browser verliert bei manchen MP3s den Anfang (gemessen bis 993 ms) und liegt dann neben dem Engine-Beatgrid
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WIN = process.platform === 'win32';
const name = WIN ? 'ffmpeg.exe' : 'ffmpeg';
let cached;
function find() {
  if (cached !== undefined) return cached;
  const list = [];
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, name)); // falls künftig mitgeliefert
  list.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  try { list.push(execFileSync(WIN ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()); } catch { /* nicht im PATH */ }
  cached = list.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
  return cached;
}
/** Streamt die Datei als WAV (32-Bit-Float, damit Spitzen über 0 dBFS erhalten bleiben) */
function stream(file, res, from = 0) {
  // -ss vor -i: springt beim Dekodieren an die Stelle, genau auf das Sample
  const seek = from > 0 ? ['-ss', String(from)] : [];
  const p = spawn(find(), ['-v', 'error', '-nostdin', ...seek, '-i', file, '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'wav', '-']);
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
  p.stdout.pipe(res);
  p.on('error', () => res.destroy());
  res.on('close', () => p.kill());
}
module.exports = { find, stream };
