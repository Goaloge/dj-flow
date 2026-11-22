// Stem Separation mit Demucs (lokal). Eigene Python-Umgebung, Warteschlange, ein Job zur Zeit.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const platform = require('./platform');

const STEMS = ['drums', 'bass', 'other', 'vocals'];
const WIN = process.platform === 'win32';
// macOS-Finder/PATH: Electron-Apps erben den Shell-PATH nicht
const PATHS = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')].filter(Boolean).join(path.delimiter);
const envVars = () => ({ ...process.env, PATH: PATHS });

let DATA = null;
const S = { env: 'unknown', log: '', job: null, queue: [], error: null, setupPct: 0 };
const envDir = () => path.join(DATA, 'stems-env');
const py = () => path.join(envDir(), WIN ? 'Scripts/python.exe' : 'bin/python');
const marker = () => path.join(envDir(), '.ready');
const ENV_VERSION = 'v2'; // v2: Demucs 4.1 + PyTorch 2.7, läuft auf dem Apple-Grafikchip
function init(dataDir) {
  DATA = dataDir;
  let v = ''; try { v = fs.readFileSync(marker(), 'utf8').trim(); } catch { /* */ }
  S.env = v === ENV_VERSION ? 'ready' : 'missing';
  S.outdated = !!v && v !== ENV_VERSION;
}

function which(cmd) {
  try { return execFileSync(WIN ? 'where' : 'which', [cmd], { encoding: 'utf8', env: envVars() }).split(/\r?\n/)[0].trim() || null; } catch { return null; }
}
function run(cmd, args, onLine) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { env: { ...envVars(), TORCH_HOME: path.join(envDir(), 'torch') } });
    let tail = '';
    const on = (d) => { const s = d.toString(); tail = (tail + s).slice(-4000); onLine?.(s); };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(tail.trim().split('\n').slice(-3).join(' ').slice(-400) || `Exit ${c}`))));
  });
}

const MODEL = '955717e8-8726e21a.th', MODEL_URL = 'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/' + MODEL;
/** Modell selbst laden: Pythons Download hängt je nach Netz ohne Zeitlimit an IPv6 fest */
async function ensureModel() {
  const dir = path.join(envDir(), 'torch', 'hub', 'checkpoints'), f = path.join(dir, MODEL);
  if (fs.existsSync(f)) return;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = f + '.part'; let got = 0, total = 84141911;
  // Erst IPv4, dann IPv6: In manchen Netzen hängt IPv6 zu diesem Server
  const attempt = (family) => { const fd = fs.openSync(tmp, 'w'); got = 0; return new Promise((res, rej) => {
    const req = https.get(MODEL_URL, { family, timeout: 60000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('Modell-Download: HTTP ' + r.statusCode)); }
      total = +r.headers['content-length'] || total;
      r.on('data', (c) => { fs.writeSync(fd, c); got += c.length; S.log = 'Lade Trennmodell … ' + Math.round((got / total) * 100) + ' %'; });
      r.on('end', res); r.on('error', rej);
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung beim Modell-Download')));
    req.on('error', rej);
  }).finally(() => { fs.closeSync(fd); }); };
  // curl zuerst: kommt in allen getesteten Netzen durch, Node und Python hingen teils
  const curl = which('curl');
  let done = false;
  if (curl) {
    const iv = setInterval(() => { try { got = fs.statSync(tmp).size; S.log = 'Lade Trennmodell … ' + Math.round((got / total) * 100) + ' %'; } catch { /* */ } }, 500);
    try { await run(curl, ['-fsSL', '--retry', '2', '--connect-timeout', '20', '-o', tmp, MODEL_URL]); got = fs.statSync(tmp).size; done = true; } catch { /* Fallback unten */ } finally { clearInterval(iv); }
  }
  if (!done) { try { await attempt(4); } catch { await attempt(6); } }
  if (got !== total) { fs.rmSync(tmp, { force: true }); throw new Error('Modell-Download unvollständig'); }
  fs.renameSync(tmp, f); S.log = '';
}

/** Umgebung einrichten (einmalig, ca. 2 GB Download) */
async function setup() {
  if (S.env === 'installing' || S.env === 'ready') return;
  S.env = 'installing'; S.error = null; S.log = 'Bereite vor …';
  try {
    const uv = which('uv');
    const pkgs = ['demucs==4.1.0', 'torch==2.7.1', 'torchaudio==2.7.1', 'soundfile', 'numpy<2'];
    if (uv) {
      await run(uv, ['venv', '--python', '3.11', '--clear', envDir()], (s) => { S.log = 'Python wird eingerichtet …'; });
      S.log = 'Lade PyTorch und Demucs (ca. 2 GB) …';
      await run(uv, ['pip', 'install', '--python', py(), ...pkgs], (s) => { const l = s.trim().split('\n').pop(); if (l) S.log = l.slice(0, 120); });
    } else {
      const sys = ['python3.11', 'python3.10', 'python3.12', 'python3', 'python'].map(which).find(Boolean);
      if (!sys) throw new Error('Python nicht gefunden. Bitte Python 3.11 installieren.');
      await run(sys, ['-m', 'venv', envDir()]);
      S.log = 'Lade PyTorch und Demucs (ca. 2 GB) …';
      await run(py(), ['-m', 'pip', 'install', ...pkgs], (s) => { const l = s.trim().split('\n').pop(); if (l) S.log = l.slice(0, 120); });
    }
    await ensureModel();
    S.log = 'Prüfe Installation …';
    await run(py(), ['-c', 'import demucs, torch, soundfile']);
    fs.writeFileSync(marker(), ENV_VERSION);
    S.env = 'ready'; S.log = ''; S.outdated = false;
    pump();
  } catch (e) { S.env = 'missing'; S.error = 'Einrichtung fehlgeschlagen: ' + e.message; S.log = ''; }
}

/** Stems liegen auf dem Laufwerk des Tracks; so belegen sie nicht die Systemplatte */
function cacheRoot(track) {
  const v = platform.listVolumes().find((x) => platform.isOnVolume(track.path, x));
  if (v && v.mount !== '/' && !/^C:/i.test(v.mount)) return path.join(v.mount, 'DJ FLOW Stems');
  return path.join(DATA, 'stems');
}
function cacheDir(track) {
  const st = fs.statSync(track.path);
  const key = crypto.createHash('sha1').update(`${track.path}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 20);
  return path.join(cacheRoot(track), key);
}
function hasStems(track) {
  try { const d = cacheDir(track); return STEMS.every((s) => fs.existsSync(path.join(d, s + '.flac'))); } catch { return false; }
}
function stemFile(track, stem) {
  if (!STEMS.includes(stem)) throw new Error('Unbekannter Stem');
  return path.join(cacheDir(track), stem + '.flac');
}

function enqueue(track) {
  if (hasStems(track) || S.job?.uid === track.uid || S.queue.some((q) => q.uid === track.uid)) return;
  S.queue.push(track); pump();
}
function cancel() { S.queue = []; if (S.job?.proc) S.job.proc.kill(); }

async function pump() {
  if (S.job || !S.queue.length || S.env !== 'ready') return;
  const t = S.queue.shift();
  S.job = { uid: t.uid, title: t.title || t.filename, pct: 0, startedAt: Date.now() };
  S.error = null;
  const dir = cacheDir(t), tmp = dir + '.tmp';
  try {
    await ensureModel();
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    const devices = process.platform === 'darwin' && process.arch === 'arm64' && !S.noMps ? ['mps', 'cpu'] : ['cpu'];
    for (const device of devices) {
      try { await separateWith(device); break; } catch (e) {
        if (device === 'mps' && /MPS|mps/.test(e.message)) { S.noMps = true; fs.rmSync(tmp, { recursive: true, force: true }); continue; }
        throw e;
      }
    }
    function separateWith(device) { return new Promise((res, rej) => {
      const p = spawn(py(), ['-m', 'demucs', '-n', 'htdemucs', '--flac', '-d', device, '-o', tmp, '--filename', '{stem}.{ext}', t.path], { env: { ...envVars(), TORCH_HOME: path.join(envDir(), 'torch'), PYTORCH_ENABLE_MPS_FALLBACK: '1' } });
      S.job.proc = p; let tail = '', last = Date.now();
      // Hängt der Prozess ohne Fortschritt, abbrechen statt ewig zu warten
      const dog = setInterval(() => { if (Date.now() - last > 300000) p.kill(); }, 10000);
      p.on('close', () => clearInterval(dog));
      p.stderr.on('data', (d) => { last = Date.now(); const s = d.toString(); tail = (tail + s).slice(-3000); const m = s.match(/(\d+)%\|/g); if (m) S.job.pct = parseInt(m[m.length - 1], 10); });
      p.stdout.on('data', () => {});
      p.on('error', rej);
      p.on('close', (c) => (c === 0 ? res() : rej(new Error(tail.trim().split('\n').slice(-2).join(' ').slice(-300) || 'Abgebrochen'))));
    }); }
    const out = path.join(tmp, 'htdemucs');
    for (const s of STEMS) if (!fs.existsSync(path.join(out, s + '.flac'))) throw new Error('Stem fehlt: ' + s);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(out, dir); fs.rmSync(tmp, { recursive: true, force: true });
    S.job = null;
  } catch (e) {
    S.error = `${t.title || t.filename}: ${e.message}`; S.job = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  pump();
}

const status = () => ({ outdated: !!S.outdated, env: S.env, log: S.log, error: S.error, job: S.job && { uid: S.job.uid, title: S.job.title, pct: S.job.pct, sec: Math.round((Date.now() - S.job.startedAt) / 1000) }, queue: S.queue.map((q) => q.uid) });

module.exports = { init, setup, status, hasStems, stemFile, enqueue, cancel, STEMS };
