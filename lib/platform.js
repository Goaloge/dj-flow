// Plattform-Unterschiede (macOS / Windows) an einer Stelle
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFile } = require('child_process');
const WIN = process.platform === 'win32';

/** Alle Laufwerke: [{ name, mount }] */
function listVolumes() {
  if (WIN) {
    const out = [];
    for (let c = 65; c <= 90; c++) {
      const mount = `${String.fromCharCode(c)}:\\`;
      try { fs.accessSync(mount); out.push({ name: `${String.fromCharCode(c)}:`, mount }); } catch { /* frei */ }
    }
    return out;
  }
  const out = [{ name: 'Macintosh HD', mount: '/' }];
  try {
    for (const v of fs.readdirSync('/Volumes')) {
      const mount = path.join('/Volumes', v);
      // Symlink auf die Systemplatte überspringen
      try { if (fs.realpathSync(mount) === '/') continue; } catch { continue; }
      out.push({ name: v, mount });
    }
  } catch { /* */ }
  return out;
}

/** Name des Laufwerks, auf dem ein Pfad liegt */
function volumeOf(p) {
  if (WIN) return path.parse(path.resolve(p)).root.slice(0, 2).toUpperCase();
  return p.startsWith('/Volumes/') ? p.split('/')[2] : 'Macintosh HD';
}

function isOnVolume(p, vol) {
  return volumeOf(p) === vol.name;
}

function engineLibraryCandidates() {
  const list = [path.join(os.homedir(), 'Music', 'Engine Library')];
  for (const v of listVolumes()) list.push(path.join(v.mount, 'Engine Library'));
  return list;
}

function engineIsRunning() {
  try {
    if (WIN) return /Engine DJ/i.test(execSync('tasklist /FI "IMAGENAME eq Engine DJ.exe" /NH', { encoding: 'utf8', stdio: 'pipe' }));
    execSync('pgrep -x "Engine DJ"', { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function reveal(p) {
  if (WIN) execFile('explorer.exe', [`/select,${p}`]);
  else execFile('open', ['-R', p]);
}

/** Datei in den Papierkorb legen (wiederherstellbar) */
async function trash(p) {
  fs.accessSync(p);
  let shell = null;
  try { shell = require('electron').shell; } catch { /* reiner Node-Start */ }
  if (shell?.trashItem) return shell.trashItem(p);
  await new Promise((res, rej) => {
    const done = (e) => (e ? rej(e) : res());
    if (WIN) execFile('powershell', ['-NoProfile', '-Command', 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:DJF_PATH, "OnlyErrorDialogs", "SendToRecycleBin")'], { env: { ...process.env, DJF_PATH: p } }, done);
    else execFile('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', p], done);
  });
}

function openTrash() {
  if (WIN) execFile('explorer.exe', ['shell:RecycleBinFolder']);
  else execFile('open', [path.join(os.homedir(), '.Trash')]);
}

function openUrl(u) {
  if (WIN) execFile('cmd', ['/c', 'start', '', u]);
  else execFile('open', [u]);
}

module.exports = { listVolumes, volumeOf, isOnVolume, engineLibraryCandidates, engineIsRunning, reveal, openUrl, trash, openTrash };
