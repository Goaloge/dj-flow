// DJ FLOW – Electron-Hülle: startet den lokalen Server im App-Prozess und zeigt die Oberfläche
'use strict';
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

// Bisherige Sets/Cue-Bearbeitungen aus der Browser-Version einmalig übernehmen
function migrate(dataDir) {
  const old = path.join(os.homedir(), 'Claude Projekte', 'DJ Flow', 'data');
  for (const f of ['edits.json', 'sets.json', 'markers.json', 'settings.json']) {
    const src = path.join(old, f), dst = path.join(dataDir, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1000, minHeight: 650,
    backgroundColor: '#07080d', title: 'DJ FLOW',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="background:#07080d;color:#00e5ff;font:300 22px -apple-system,Segoe UI,sans-serif;display:flex;height:100vh;margin:0;align-items:center;justify-content:center;letter-spacing:3px">DJ FLOW · lese Bibliothek …</body>'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  migrate(dataDir);
  process.env.DJFLOW_DATA = dataDir;

  // kurz warten, damit der Ladebildschirm steht – das Einlesen blockiert den Prozess
  setTimeout(async () => {
    try {
      const url = await require('../server').start();
      win.loadURL(url);
    } catch (e) {
      win.loadURL('data:text/plain;charset=utf-8,' + encodeURIComponent('Start fehlgeschlagen: ' + e.message));
    }
  }, 300);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
