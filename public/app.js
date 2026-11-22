// DJ FLOW – Frontend
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (url, body) => {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '–');
const keyColor = (c) => { const n = parseInt(c, 10); return isNaN(n) ? '#444' : `hsl(${(n - 1) * 30},85%,${c.endsWith('A') ? 62 : 72}%)`; };
const keyBadge = (c) => (c ? `<span class="key" style="background:${keyColor(c)}">${c}</span>` : '<span class="muted">–</span>');
const energyBar = (e) => (e ? `<span class="energy" title="Energie ${e}/10">${Array.from({ length: 10 }, (_, i) => `<i class="${i < e ? 'on' : ''}"></i>`).join('')}</span>` : '–');
const scoreCls = (s) => (s >= 80 ? 's-hi' : s >= 60 ? 's-mid' : 's-lo');
function toast(msg, ms = 3500) { const t = $('#toast'); t.innerHTML = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }

const S = {
  tracks: [], byUid: new Map(), filtered: [], sort: { k: 'artist', dir: 1 }, limit: 300, sel: null,
  set: JSON.parse(localStorage.getItem('djflow.set') || '[]'),
  curve: 'journey', lastGen: null, decks: { A: null, B: null },
};
const saveSet = () => localStorage.setItem('djflow.set', JSON.stringify(S.set));

// ---------- Navigation ----------
$$('.nav > button[data-view]').forEach((b) => b.onclick = () => show(b.dataset.view));
function show(v) {
  $$('.nav > button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === `view-${v}`));
  if (v === 'set') renderSet();
  if (v === 'drives') renderDrives();
  if (v === 'libs') Libraries.init();
  if (v === 'mixlab') MixLab.render();
}

// ---------- Laden ----------
async function load() {
  $('#stat').textContent = 'Lade Bibliothek …';
  S.tracks = await api('/api/tracks');
  S.byUid = new Map(S.tracks.map((t) => [t.uid, t]));
  const st = await api('/api/status');
  $('#stat').innerHTML = `${S.tracks.length.toLocaleString('de')} Tracks<br>${st.libraries.filter((l) => l.trackCount).length} Engine-Libraries${st.engineRunning ? '<br><span style="color:var(--amber)">● Engine DJ läuft</span>' : ''}`;
  const genres = [...new Set(S.tracks.map((t) => t.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('#f-genre').innerHTML = '<option value="">Alle Genres</option>' + genres.map((g) => `<option>${esc(g)}</option>`).join('');
  const vols = [...new Set(S.tracks.map((t) => t.volume))];
  $('#f-vol').innerHTML = '<option value="">Alle Laufwerke</option>' + vols.map((g) => `<option>${esc(g)}</option>`).join('');
  filter();
}
$('#rescan').onclick = async () => { toast('Lese alle Engine-Libraries neu ein …'); await api('/api/rescan', {}); await load(); toast('Fertig ✓'); };

// ---------- Bibliothek / Smart Search ----------
function filter() {
  const raw = $('#q').value.trim().toLowerCase();
  const genre = $('#f-genre').value, vol = $('#f-vol').value;
  const words = [];
  const preds = [];
  for (const w of raw.split(/\s+/).filter(Boolean)) {
    let m;
    if ((m = /^(\d{1,2}[ab])$/.exec(w))) preds.push((t) => t.camelot?.toLowerCase() === m[1]);
    else if ((m = /^(\d{2,3})-(\d{2,3})$/.exec(w))) preds.push((t) => t.bpm >= +m[1] && t.bpm <= +m[2]);
    else if ((m = /^e([<>]=?|=)(\d+)$/.exec(w))) { const [, op, v] = m; preds.push((t) => t.energy != null && (op[0] === '>' ? t.energy >= +v + (op === '>' ? 1 : 0) : op[0] === '<' ? t.energy <= +v - (op === '<' ? 1 : 0) : t.energy === +v)); }
    else words.push(w);
  }
  S.filtered = S.tracks.filter((t) => {
    if (genre && t.genre !== genre) return false;
    if (vol && t.volume !== vol) return false;
    for (const p of preds) if (!p(t)) return false;
    if (words.length) {
      const hay = `${t.artist} ${t.title} ${t.album} ${t.genre} ${t.label} ${t.filename}`.toLowerCase();
      for (const w of words) if (!hay.includes(w)) return false;
    }
    return true;
  });
  const { k, dir } = S.sort;
  S.filtered.sort((a, b) => { const x = a[k], y = b[k]; return (x == null) - (y == null) || (x > y ? 1 : x < y ? -1 : 0) * dir; });
  S.limit = 300;
  renderTable();
}
let qT; $('#q').oninput = () => { clearTimeout(qT); qT = setTimeout(filter, 150); };
$('#f-genre').onchange = filter; $('#f-vol').onchange = filter;
$$('th[data-sort]').forEach((th) => th.onclick = () => { const k = th.dataset.sort; S.sort = { k, dir: S.sort.k === k ? -S.sort.dir : 1 }; filter(); });

function renderTable() {
  $('#count').textContent = `${S.filtered.length.toLocaleString('de')} Treffer`;
  const rows = S.filtered.slice(0, S.limit).map((t) => `<tr data-uid="${t.uid}" class="${t.uid === S.sel ? 'sel' : ''} ${t.uid === Player.uid ? 'playing' : ''}">
    <td>${esc(t.artist)}</td><td>${esc(t.title || t.filename)}</td><td>${esc(t.genre)}</td>
    <td>${t.bpm ? t.bpm.toFixed(1) : '–'}</td><td>${keyBadge(t.camelot)}</td><td>${energyBar(t.energy)}</td>
    <td>${fmt(t.length)}</td><td class="muted">${esc(t.volume)}</td><td class="row-btns"><button class="edit-tags" title="Tags bearbeiten (Taste E)">✎</button><button class="add" title="Zum Set">＋</button></td></tr>`).join('');
  $('#tbl tbody').innerHTML = rows + (S.filtered.length > S.limit ? `<tr><td colspan="9" class="more"><button id="more">Weitere ${Math.min(500, S.filtered.length - S.limit)} anzeigen</button></td></tr>` : '');
  const more = $('#more'); if (more) more.onclick = () => { S.limit += 500; renderTable(); };
}
$('#tbl tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-uid]'); if (!tr) return;
  if (e.target.classList.contains('add')) return addToSet(tr.dataset.uid);
  if (e.target.classList.contains('edit-tags')) return openTagEditor(tr.dataset.uid);
  select(tr.dataset.uid);
});
$('#tbl tbody').addEventListener('dblclick', (e) => { if (e.target.closest('button')) return; const tr = e.target.closest('tr[data-uid]'); if (tr) MixLab.addTrack(tr.dataset.uid, true); });

async function select(uid) {
  S.sel = uid;
  $$('#tbl tbody tr').forEach((r) => r.classList.toggle('sel', r.dataset.uid === uid));
  const t = S.byUid.get(uid);
  $('#suggest').innerHTML = `<h3>Passt danach</h3><div class="muted">zu ${esc(t.artist)} – ${esc(t.title)}</div><div class="muted">Berechne …</div>`;
  const sug = await api('/api/suggest', { uid });
  if (S.sel !== uid) return;
  $('#suggest').innerHTML = `<h3>Passt danach</h3><div class="muted" style="margin-bottom:8px">zu <b>${esc(t.title)}</b> · ${t.bpm?.toFixed(0) ?? '–'} BPM · ${t.camelot ?? '–'} · E${t.energy ?? '–'}</div>` +
    sug.map((s) => `<div class="sug" data-uid="${s.uid}"><span class="score ${scoreCls(s.match.score)}">${s.match.score}</span>
      <div><div>${esc(s.artist)} – ${esc(s.title)}</div><div class="muted">${s.bpm?.toFixed(0)} BPM · ${keyBadge(s.camelot)} · E${s.energy ?? '–'} ${s.match.notes.length ? '· ' + esc(s.match.notes.join(', ')) : ''}</div></div>
      <button class="add" title="Zum Set">＋</button></div>`).join('');
}
$('#suggest').addEventListener('click', (e) => {
  const d = e.target.closest('.sug'); if (!d) return;
  if (e.target.classList.contains('add')) return addToSet(d.dataset.uid);
  Player.load(d.dataset.uid, true);
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,select,textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); if (S.sel && Player.uid !== S.sel) Player.load(S.sel, true); else Player.toggle(); }
  if ((e.key === '+' || e.key === '=') && S.sel) addToSet(S.sel);
  if (e.key.toLowerCase() === 'e' && S.sel && !e.metaKey && !e.ctrlKey && $('#view-library').classList.contains('active')) { e.preventDefault(); openTagEditor(S.sel); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const i = S.filtered.findIndex((t) => t.uid === S.sel) + (e.key === 'ArrowDown' ? 1 : -1);
    if (S.filtered[i]) { e.preventDefault(); select(S.filtered[i].uid); $(`tr[data-uid="${CSS.escape(S.filtered[i].uid)}"]`)?.scrollIntoView({ block: 'nearest' }); }
  }
});

// ---------- Waveform-Zeichnung (Engine-Overview: low/mid/high) ----------
function drawWave(cv, perf, opts = {}) {
  const dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const ov = perf?.overview;
  const dur = perf?.grid?.durationSec || opts.duration || 1;
  if (!ov) { g.fillStyle = '#7b84a0'; g.fillText('Keine Engine-Analyse vorhanden', 10, h / 2); return; }
  const mid = h / 2, n = ov.length;
  // Phrasen-Raster (16 Takte) + Takte
  const grid = perf.grid;
  if (grid?.beatSec && opts.grid !== false) {
    const bar = grid.beatSec * 4;
    for (let t = grid.firstBeatSec, i = 0; t < dur; t += bar, i++) {
      const x = (t / dur) * w;
      if (i % 16 === 0) { g.fillStyle = '#ffffff22'; g.fillRect(x, 0, 1, h); g.fillStyle = '#ffffff55'; if (h > 80) g.fillText(String(i / 16 * 16 + 1), x + 2, 10); }
      else if (i % 4 === 0 && w / (dur / bar) > 2) { g.fillStyle = '#ffffff0d'; g.fillRect(x, 0, 1, h); }
    }
  }
  // Mix-Zonen
  const mx = perf.mix;
  if (mx && opts.zones !== false) {
    g.fillStyle = '#00e5ff14'; g.fillRect(0, 0, (mx.introEndSec / dur) * w, h);
    g.fillStyle = '#ff2bd614'; g.fillRect((mx.mixOutSec / dur) * w, 0, w, h);
  }
  for (let x = 0; x < w; x++) {
    const [l, m, hi] = ov[Math.floor((x / w) * n)];
    const s = (v) => (v / 255) * (mid - 2);
    g.fillStyle = '#1e5cff'; g.fillRect(x, mid - s(l), 1, s(l) * 2);
    g.fillStyle = '#ff8a00cc'; g.fillRect(x, mid - s(m) * 0.75, 1, s(m) * 1.5);
    g.fillStyle = '#ffffffcc'; g.fillRect(x, mid - s(hi) * 0.45, 1, s(hi) * 0.9);
  }
  const marker = (sec, col, label, top = true) => {
    if (sec == null) return; const x = (sec / dur) * w;
    g.fillStyle = col; g.fillRect(x - 1, 0, 2, h);
    if (label && h > 60) { g.font = '10px sans-serif'; const tw = g.measureText(label).width + 6; g.fillRect(x, top ? 0 : h - 13, tw, 13); g.fillStyle = '#000'; g.fillText(label, x + 3, top ? 10 : h - 3); }
  };
  if (mx && opts.zones !== false) { marker(mx.mixInSec, '#00e5ff', 'MIX IN'); marker(mx.introEndSec, '#b6ff3b', `DROP · ${mx.introBars ?? '?'} Takte`, false); marker(mx.mixOutSec, '#ff2bd6', `MIX OUT · ${mx.outroBars ?? '?'} Takte`); }
  for (const c of perf.cues || []) if (c.sec != null) marker(c.sec, c.color, opts.labels === false ? '' : c.label, false);
  for (const m of perf.markers || []) marker(m.sec, '#ffb02e', '★ ' + (m.label || ''), true);
  if (opts.pos != null) { g.fillStyle = '#fff'; g.fillRect((opts.pos / dur) * w, 0, 2, h); }
}

// ---------- Player ----------
// Vorhören: mit ffmpeg dekodiert und ab Position gestreamt, damit es zum Engine-Beatgrid passt.
// Ohne ffmpeg Rückfall auf die Browser-Dekodierung (kann bei manchen MP3s versetzt sein).
const Player = {
  audio: $('#audio'), uid: null, perf: null, base: 0, ff: null,
  pos() { return this.base + (this.audio.currentTime || 0); },
  src(t) {
    const u = encodeURIComponent(this.uid);
    if (this.ff) { this.base = t; this.audio.src = `/api/pcm?uid=${u}&t=${t.toFixed(3)}`; }
    else { this.base = 0; if (!this.audio.src.includes('/api/audio')) this.audio.src = `/api/audio?uid=${u}`; this.audio.currentTime = t; }
  },
  async seek(t, play = true) {
    if (!this.uid) return;
    this.src(Math.max(0, t));
    if (play) await this.audio.play().catch((e) => toast('Abspielen fehlgeschlagen: ' + e.message));
    this.draw();
  },
  async load(uid, play = false, at = null) {
    const t = S.byUid.get(uid); if (!t) return;
    if (this.ff == null) this.ff = !!(await api('/api/status').catch(() => ({}))).ffmpeg;
    this.uid = uid; this.audio.removeAttribute('src');
    $('#p-title').textContent = `${t.artist || ''} – ${t.title || t.filename}`;
    $('#p-sub').innerHTML = `${t.bpm?.toFixed(1) ?? '–'} BPM · ${t.camelot ?? '–'} ${t.keyName ? '(' + t.keyName + ')' : ''} · E${t.energy ?? '–'} · ${esc(t.genre || '')}`;
    this.perf = null;
    const perf = api(`/api/perf?uid=${encodeURIComponent(uid)}`).then((p) => { if (this.uid === uid) { this.perf = p; this.draw(); } return p; });
    if (at === 'drop' || at === 'in') {
      // erst die Position kennen, dann direkt dort starten
      const p = await perf; if (this.uid !== uid) return;
      const m = p?.mix; await this.seek(m ? (at === 'in' ? m.mixInSec : m.introEndSec) : 0, play);
    } else await this.seek(0, play);
    renderTable();
  },
  toggle() { if (!this.uid) return; if (!this.audio.src) return this.seek(0); this.audio.paused ? this.audio.play() : this.audio.pause(); },
  jump(where) {
    const m = this.perf?.mix; if (!m) return;
    this.seek(where === 'in' ? m.mixInSec : where === 'drop' ? m.introEndSec : m.mixOutSec);
  },
  draw() { drawWave($('#p-wave'), this.perf, { pos: this.pos(), labels: false, duration: S.byUid.get(this.uid)?.length }); },
};
$('#p-play').onclick = () => Player.toggle();
$('#p-in').onclick = () => Player.jump('in');
$('#p-drop').onclick = () => Player.jump('drop');
$('#p-out').onclick = () => Player.jump('out');
$('#p-add').onclick = () => Player.uid && addToSet(Player.uid);
Player.audio.onplay = () => ($('#p-play').textContent = '❚❚');
Player.audio.onpause = () => ($('#p-play').textContent = '▶');
Player.audio.ontimeupdate = () => Player.perf && Player.draw();
$('#p-wave').onclick = (e) => { const d = Player.perf?.grid?.durationSec || S.byUid.get(Player.uid)?.length; if (!d) return; Player.seek((e.offsetX / e.target.clientWidth) * d, !Player.audio.paused || true); };

// ---------- Generator ----------
const CURVES = {
  warmup: ['Warm-Up', (x) => 3 + x * 3], peak: ['Peak Time', (x) => 7 + Math.min(1, x * 2) * 2.5],
  journey: ['Journey', (x) => 4 + Math.sin(x * Math.PI) * 5], wave: ['Wellen', (x) => 6 + Math.sin(x * Math.PI * 4) * 2.5 + x],
  cooldown: ['Cool-Down', (x) => 8 - x * 5], steady: ['Konstant', () => 6.5],
};
$('#curves').innerHTML = Object.entries(CURVES).map(([k, [n]]) => `<button data-c="${k}" class="${k === S.curve ? 'active' : ''}">${n}</button>`).join('');
$('#curves').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.curve = b.dataset.c; $$('#curves button').forEach((x) => x.classList.toggle('active', x === b)); drawCurve(); };
function drawCurve(actual) {
  const cv = $('#curve-preview'), g = cv.getContext('2d'), w = cv.width, h = cv.height;
  g.clearRect(0, 0, w, h);
  g.strokeStyle = '#ff2bd6'; g.lineWidth = 2; g.beginPath();
  for (let x = 0; x <= w; x++) { const y = h - (CURVES[S.curve][1](x / w) / 10) * h; x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  if (actual?.length) {
    g.strokeStyle = '#00e5ff'; g.beginPath();
    actual.forEach((e, i) => { const x = (i / Math.max(1, actual.length - 1)) * w, y = h - ((e ?? 5) / 10) * h; i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
  }
}
drawCurve();
const num = (id) => { const v = $(id).value; return v === '' ? undefined : Number(v); };
const list = (id) => $(id).value.split(',').map((s) => s.trim()).filter(Boolean);
async function generate() {
  const opts = {
    genres: list('#g-genres'), bpmMin: num('#g-bpmmin'), bpmMax: num('#g-bpmmax'), bpmStart: num('#g-bpmstart'), bpmEnd: num('#g-bpmend'),
    energyMin: num('#g-emin'), energyMax: num('#g-emax'), curve: S.curve, count: num('#g-count'), minutes: num('#g-min'),
    harmonicStrict: $('#g-strict').checked,
  };
  const keys = list('#g-keys').map((k) => k.toUpperCase());
  if (keys.length) { const start = S.tracks.filter((t) => keys.includes(t.camelot) && (!opts.bpmMin || t.bpm >= opts.bpmMin) && (!opts.bpmMax || t.bpm <= opts.bpmMax)); if (start.length) opts.startTrackId = start[Math.floor(Math.random() * start.length)].uid; }
  $('#g-result').innerHTML = '<p class="muted">Berechne harmonischen Pfad …</p>';
  const r = await api('/api/generate', opts);
  S.lastGen = r;
  if (!r.tracks.length) { $('#g-result').innerHTML = '<p>Keine passenden Tracks gefunden – Filter lockern?</p>'; return; }
  drawCurve(r.tracks.map((t) => t.energy));
  const avg = Math.round(r.transitions.reduce((s, t) => s + t.score, 0) / Math.max(1, r.transitions.length));
  $('#g-result').innerHTML = `<div class="card"><div class="bar"><h3 style="margin:0">${r.tracks.length} Tracks · ${fmt(r.totalSec)} · Ø Mix-Score <span class="${scoreCls(avg)}">${avg}</span> <span class="muted">(aus ${r.poolSize} Kandidaten)</span></h3>
    <span style="flex:1"></span><button id="g-toset" class="primary">→ In den Set-Builder</button></div>
    ${trackListHTML(r.tracks, r.transitions)}</div>`;
  $('#g-toset').onclick = () => { S.set = r.tracks.map((t) => t.uid); saveSet(); show('set'); toast('Set übernommen – jetzt feinschleifen & exportieren'); };
}
function trackListHTML(tracks, trans) {
  return `<table><tbody>${tracks.map((t, i) => `${i ? `<tr><td colspan="6" class="tr-badge ${scoreCls(trans[i - 1].score)}">↳ Mix-Score ${trans[i - 1].score} ${esc(trans[i - 1].notes.join(' · '))}</td></tr>` : ''}
    <tr data-uid="${t.uid}" class="gen-row"><td class="muted">${i + 1}</td><td>${esc(t.artist)} – ${esc(t.title)}</td><td>${esc(t.genre)}</td><td>${t.bpm.toFixed(1)}</td><td>${keyBadge(t.camelot)}</td><td>${energyBar(t.energy)}</td></tr>`).join('')}</tbody></table>`;
}
$('#g-run').onclick = generate; $('#g-again').onclick = generate;
$('#g-result').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-uid]'); if (tr) Player.load(tr.dataset.uid, true, 'drop'); });

// ---------- Set-Builder ----------
function addToSet(uid) { if (!S.set.includes(uid)) { S.set.push(uid); saveSet(); } const t = S.byUid.get(uid); toast(`＋ ${esc(t?.title)} → Set (${S.set.length})`, 1500); }
async function renderSet() {
  S.set = S.set.filter((u) => S.byUid.has(u));
  const tracks = S.set.map((u) => S.byUid.get(u));
  const an = tracks.length > 1 ? await api('/api/analyze', { uids: S.set }) : { transitions: [], avg: 0, weak: [] };
  const total = tracks.reduce((s, t) => s + (t.length || 0), 0);
  $('#set-score').innerHTML = tracks.length ? `<p>${tracks.length} Tracks · ${fmt(total)} · Ø Mix-Score <b class="${scoreCls(an.avg)}">${an.avg}</b>${an.weak.length ? ` · <span class="s-lo">${an.weak.length} schwache Übergänge</span> – „Reihenfolge optimieren“ probieren` : ' · alles im Flow ✓'}</p>` : '<p class="muted">Set ist leer. Tracks mit ＋ hinzufügen oder den Generator nutzen.</p>';
  $('#set-list').innerHTML = tracks.map((t, i) => `${i ? `<div class="tr-badge ${scoreCls(an.transitions[i - 1].score)}">↳ ${an.transitions[i - 1].score} ${esc(an.transitions[i - 1].notes.join(' · '))} <a href="#" data-mix="${i}">im Mix-Lab prüfen</a></div>` : ''}
    <li draggable="true" data-uid="${t.uid}"><span>${esc(t.artist)} – ${esc(t.title)} <span class="muted">${esc(t.genre || '')}</span></span><span>${t.bpm?.toFixed(1) ?? '–'}</span>${keyBadge(t.camelot)}${energyBar(t.energy)}<button class="ghost rm">✕</button></li>`).join('');
  drawSetChart(tracks);
}
function drawSetChart(tracks) {
  const cv = $('#set-chart'); const dpr = devicePixelRatio; const w = cv.clientWidth, h = 140;
  cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  if (tracks.length < 2) return;
  const bpms = tracks.map((t) => t.bpm || 0), bmin = Math.min(...bpms) - 2, bmax = Math.max(...bpms) + 2;
  const X = (i) => 20 + (i / (tracks.length - 1)) * (w - 40);
  g.strokeStyle = '#ff2bd6'; g.lineWidth = 2; g.beginPath(); tracks.forEach((t, i) => { const y = h - 15 - ((t.energy ?? 5) / 10) * (h - 30); i ? g.lineTo(X(i), y) : g.moveTo(X(i), y); }); g.stroke();
  g.strokeStyle = '#00e5ff'; g.beginPath(); tracks.forEach((t, i) => { const y = h - 15 - ((t.bpm - bmin) / (bmax - bmin)) * (h - 30); i ? g.lineTo(X(i), y) : g.moveTo(X(i), y); }); g.stroke();
  tracks.forEach((t, i) => { g.fillStyle = keyColor(t.camelot || ''); g.beginPath(); g.arc(X(i), h - 6, 4, 0, 7); g.fill(); });
  g.fillStyle = '#ff2bd6'; g.fillText('Energie', 8, 12); g.fillStyle = '#00e5ff'; g.fillText(`BPM ${bmin.toFixed(0)}–${bmax.toFixed(0)}`, 60, 12); g.fillStyle = '#7b84a0'; g.fillText('● Key', 160, 12);
}
let dragUid = null;
$('#set-list').addEventListener('dragstart', (e) => { dragUid = e.target.dataset.uid; e.target.classList.add('drag'); });
$('#set-list').addEventListener('dragover', (e) => e.preventDefault());
$('#set-list').addEventListener('drop', (e) => {
  e.preventDefault(); const li = e.target.closest('li'); if (!li || !dragUid) return;
  const from = S.set.indexOf(dragUid); S.set.splice(from, 1); S.set.splice(S.set.indexOf(li.dataset.uid) + (from <= S.set.indexOf(li.dataset.uid) ? 1 : 0), 0, dragUid);
  saveSet(); renderSet();
});
$('#set-list').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (e.target.classList.contains('rm')) { S.set = S.set.filter((u) => u !== li.dataset.uid); saveSet(); return renderSet(); }
  if (e.target.dataset.mix) { e.preventDefault(); return MixLab.openPair(+e.target.dataset.mix - 1); }
  if (li) Player.load(li.dataset.uid, true, 'drop');
});
$('#set-optimize').onclick = async () => { const before = S.set.slice(); S.set = await api('/api/optimize', { uids: S.set }); saveSet(); await renderSet(); toast(before.join() === S.set.join() ? 'Reihenfolge war schon optimal' : 'Reihenfolge optimiert ⚡'); };
$('#set-clear').onclick = () => { if (confirm('Set leeren?')) { S.set = []; saveSet(); renderSet(); } };
$('#set-m3u').onclick = async () => { try { const r = await api('/api/export', { uids: S.set, title: $('#set-title').value, mode: 'm3u' }); toast(`M3U gespeichert:<br><code>${esc(r.file)}</code><br>In Engine DJ: Datei in die Playlist-Spalte ziehen.`, 7000); api('/api/reveal', { path: r.file }); } catch (e) { toast('⚠ ' + e.message); } };
$('#set-engine').onclick = async () => {
  if (!confirm('Playlist direkt in die Engine-DJ-Datenbank schreiben?\n\n• Engine DJ muss geschlossen sein\n• Vorher wird automatisch ein Backup von m.db angelegt\n• Die Playlist landet im Ordner „DJ FLOW“')) return;
  try { const r = await api('/api/export', { uids: S.set, title: $('#set-title').value, mode: 'engine' }); toast(`✓ Playlist „${esc(r.name)}“ in Engine gespeichert${r.skipped ? ` (${r.skipped} Tracks aus anderer Library übersprungen)` : ''}.<br>Backup: <code>${esc(r.backup.split('/').pop())}</code>`, 8000); await load(); } catch (e) { toast('⚠ ' + e.message, 6000); }
};

// ---------- Tag-Doktor ----------
$('#t-missing').onclick = async () => {
  const miss = await api('/api/missing');
  const counts = {}; miss.forEach((m) => m.missing.forEach((f) => (counts[f] = (counts[f] || 0) + 1)));
  const rows = miss.slice(0, 1000).map((m) => { const t = S.byUid.get(m.uid); return t ? `<tr data-uid="${m.uid}"><td><input type="checkbox" class="tk" ${/\.(mp3|wav|aiff?|flac)$/i.test(t.path) ? 'checked' : 'disabled title="Für dieses Format schreibt DJ FLOW keine Tags"'}></td><td>${esc(t.artist)}</td><td>${esc(t.title || t.filename)}</td><td>${m.missing.map((f) => `<span class="miss">${f}</span>`).join('')}</td><td class="muted">${esc(t.volume)}</td><td><button class="edit">✎ Bearbeiten</button></td></tr>` : ''; }).join('');
  $('#t-out').innerHTML = `<div class="card"><p>${miss.length.toLocaleString('de')} Tracks mit Lücken: ${Object.entries(counts).map(([f, c]) => `<span class="miss">${f}: ${c}</span>`).join(' ')}</p>
    <div class="bar"><button id="t-fix" class="primary">⚡ Auto-Fix für markierte Dateien</button><button id="t-all" class="ghost">Alle an/aus</button><span class="muted">Schreibt Titel/Artist (aus Dateiname), BPM + Key (aus Engine-Analyse) und optional Genre in die Datei.</span></div>
    <table><tbody>${rows}</tbody></table>${miss.length > 1000 ? '<p class="muted">… erste 1000 angezeigt</p>' : ''}</div>`;
  $('#t-all').onclick = () => { const boxes = $$('.tk:not(:disabled)'); const on = !boxes[0]?.checked; boxes.forEach((b) => (b.checked = on)); };
  $('#t-fix').onclick = async () => {
    const uids = $$('.tk:checked').map((b) => b.closest('tr').dataset.uid);
    if (!uids.length || !confirm(`${uids.length} Dateien mit ergänzten Tags beschreiben?`)) return;
    const r = await api('/api/autofix', { uids, suggestGenre: $('#t-genre').checked, keyFormat: $('#t-keyfmt').value });
    const ok = r.results.filter((x) => x.ok).length;
    toast(`✓ ${ok} Dateien aktualisiert, ${r.results.length - ok} Fehler.<br>${esc(r.note)}`, 9000);
  };
};
$('#t-dupes').onclick = async () => {
  const groups = await api('/api/duplicates');
  $('#t-out').innerHTML = `<div class="card"><p>${groups.length} mögliche Duplikat-Gruppen (gleicher Artist + Titel)</p>${groups.map((g) => `<div class="card" style="padding:8px">${g.map((u) => { const t = S.byUid.get(u); return `<div data-uid="${u}" class="sug" style="grid-template-columns:1fr auto auto auto"><span>${esc(t.artist)} – ${esc(t.title)} <span class="muted">${t.bitrate || '?'} kbps · ${esc(t.fileType || '')} · ${esc(t.volume)}</span><br><small class="muted">${esc(t.path)}</small></span><button class="reveal">Zeigen</button><button class="edit">✎</button><button class="trash" title="In den Papierkorb legen">🗑 Löschen</button></div>`; }).join('')}</div>`).join('')}</div>`;
};
$('#t-out').addEventListener('click', (e) => {
  const row = e.target.closest('[data-uid]'); if (!row) return;
  if (e.target.classList.contains('edit')) openTagEditor(row.dataset.uid);
  else if (e.target.classList.contains('reveal')) api('/api/reveal', { uid: row.dataset.uid });
  else if (e.target.classList.contains('trash')) trashTrack(row);
  else if (!e.target.matches('input')) Player.load(row.dataset.uid, true, 'drop');
});
$('#t-trashed').onclick = renderTrashed;
async function renderTrashed() {
  const list = await api('/api/trashed'), back = list.filter((x) => x.exists);
  $('#t-out').innerHTML = '<div class="card"><div class="bar"><h3 style="margin:0">Gelöschte Dateien</h3>' +
    (back.length ? '<button id="tr-back" class="primary">Wieder aufnehmen (' + back.length + ')</button>' : '') + '<button id="tr-open" class="ghost">Papierkorb öffnen</button></div>' +
    '<p class="muted small">Dateien, die DJ FLOW in den Papierkorb gelegt hat. Um eine zurückzuholen: im Papierkorb „Zurücklegen“, dann hier „Wieder aufnehmen“.</p>' +
    (list.length ? list.map((x) => '<div class="st-row"><span class="ell">' + esc(x.path) + '</span><span>' + (x.exists ? '<b class="s-hi">wieder da</b>' : '<span class="muted">im Papierkorb</span>') + '</span></div>').join('') : '<p class="muted">Keine gelöschten Dateien.</p>') + '</div>';
  const bb = $('#tr-back'); if (bb) bb.onclick = async () => { const r = await api('/api/trashed/restore', { paths: back.map((x) => x.path) }); toast('✓ ' + r.back.length + ' Datei(en) wieder in der Bibliothek'); await load(); renderTrashed(); };
  $('#tr-open').onclick = () => api('/api/trash/open', {});
}
async function trashTrack(row) {
  const uid = row.dataset.uid, t = S.byUid.get(uid), group = row.parentElement;
  const last = group.querySelectorAll('[data-uid]').length <= 1;
  if (!confirm(`Datei in den Papierkorb legen?\n\n${t.path}${last ? '\n\n⚠ Das ist die letzte Kopie in dieser Gruppe.' : ''}\n\nEngine DJ zeigt den Track danach als fehlend an, bis du ihn dort entfernst.`)) return;
  const r = (await api('/api/trash', { uids: [uid] })).results[0];
  if (!r.ok) return toast('⚠ Nicht gelöscht: ' + esc(r.error), 7000);
  S.byUid.delete(uid); S.tracks = S.tracks.filter((x) => x.uid !== uid); S.set = S.set.filter((u) => u !== uid); saveSet();
  row.remove(); filter();
  if (group.querySelectorAll('[data-uid]').length < 2) group.remove();
  toast('🗑 Im Papierkorb. Dort lässt sich die Datei wiederherstellen.');
}
async function openTagEditor(uid) {
  const m = $('#tag-editor'); document.body.appendChild(m); m.classList.remove('hidden'); // aus der versteckten Ansicht lösen
  m.innerHTML = '<div class="card">Lese Tags …</div>';
  let r; try { r = await api(`/api/tags?uid=${encodeURIComponent(uid)}`); } catch (e) { m.innerHTML = `<div class="card">⚠ ${esc(e.message)}<br><button onclick="this.closest('.modal').classList.add('hidden')">Schließen</button></div>`; return; }
  const f = r.file, en = r.engine, gs = r.guess;
  const sugg = { title: gs.title, artist: gs.artist, bpm: en.bpm && Math.round(en.bpm), key: en.camelot, genre: f.genre ? null : null };
  const field = (k, label) => `<label>${label}<input data-k="${k}" value="${esc(f[k] ?? '')}">${sugg[k] && String(sugg[k]) !== String(f[k] ?? '') ? `<span class="sugg" data-k="${k}" data-v="${esc(sugg[k])}">↳ Vorschlag: ${esc(sugg[k])}</span>` : ''}</label>`;
  m.innerHTML = `<div class="card">${f.cover ? `<img class="cover" src="${f.cover}">` : ''}<h3>Tags bearbeiten</h3><p class="muted" style="word-break:break-all">${esc(en.path)}<br>${esc(f.codec || '')} · ${f.bitrate ? Math.round(f.bitrate / 1000) + ' kbps' : ''}</p>
    <div class="tag-grid">${field('title', 'Titel')}${field('artist', 'Artist')}${field('album', 'Album')}${field('genre', 'Genre')}${field('year', 'Jahr')}${field('bpm', 'BPM')}${field('key', 'Key')}${field('label', 'Label')}${field('remixer', 'Remixer')}${field('comment', 'Kommentar')}</div>
    <div class="bar"><button class="primary" id="te-save">Speichern</button><button class="ghost" id="te-close">Abbrechen</button><button class="ghost" id="te-play">▶ Anhören</button></div></div>`;
  m.onclick = (e) => {
    if (e.target === m || e.target.id === 'te-close') m.classList.add('hidden');
    if (e.target.classList.contains('sugg')) $(`input[data-k="${e.target.dataset.k}"]`, m).value = e.target.dataset.v;
    if (e.target.id === 'te-play') Player.load(uid, true, 'drop');
  };
  $('#te-save').onclick = async () => {
    const tagsOut = {}; $$('input[data-k]', m).forEach((i) => { if (i.value !== '') tagsOut[i.dataset.k] = i.value; });
    try { const res = await api('/api/tags', { uid, tags: tagsOut }); if (res.lost?.length) setTimeout(() => toast('Hinweis: Dieses Format speichert ' + res.lost.join(', ') + ' nicht.', 6000), 3700); Object.assign(S.byUid.get(uid), { title: tagsOut.title, artist: tagsOut.artist, genre: tagsOut.genre, album: tagsOut.album, label: tagsOut.label }); m.classList.add('hidden'); renderTable(); toast('✓ Tags gespeichert. In Engine DJ „Reload Tags“ ausführen.'); } catch (e) { toast('⚠ ' + e.message); }
  };
}

// ---------- Laufwerke ----------
async function renderDrives() {
  const ds = await api('/api/drives');
  $('#drives').innerHTML = ds.map((d) => `<div class="drive ${d.engineLibrary ? 'engine' : ''}"><b>⛁ ${esc(d.name)}</b> <span class="muted">${esc(d.mount)}</span>
    <div class="meter"><i style="width:${d.usedPct}%"></i></div>
    <div>${d.freeGB} GB frei von ${d.totalGB} GB</div>
    <div>${d.engineLibrary ? `<span style="color:var(--cyan)">● Engine Library · ${d.engineLibrary.trackCount.toLocaleString('de')} Tracks</span>` : '<span class="muted">keine Engine Library</span>'}</div>
    <div class="muted">${d.tracksOnDrive.toLocaleString('de')} Tracks liegen auf diesem Laufwerk</div>
    ${d.tracksOnDrive ? `<button class="ghost" data-vol="${esc(d.name)}">In Bibliothek filtern</button>` : ''}</div>`).join('');
}
$('#drives').addEventListener('click', (e) => { const v = e.target.dataset.vol; if (v) { show('library'); $('#q').value = ''; const o = [...$('#f-vol').options].find((x) => x.value === v); $('#f-vol').value = o ? v : ''; filter(); } });
$('#d-add').onclick = async () => { const root = $('#d-root').value.trim(); if (!root) return; await api('/api/libraries/add', { root }); await api('/api/rescan', {}); await load(); renderDrives(); toast('Library hinzugefügt'); };

load().catch((e) => { $('#stat').textContent = 'Fehler: ' + e.message; });
