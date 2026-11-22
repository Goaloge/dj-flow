// DJ FLOW – Tab „Libraries“: Library wählen, Playlists und Tracks mit Cue-/Loop-Status, Auto-Cues für einzelne oder alle fehlenden
'use strict';
(() => {
  const LB = { libs: [], lib: null, list: null, rows: [], limit: 400, open: new Set(), confirmed: new Set() };
  const el = (s) => document.querySelector(s);
  const pill = (n) => `<span class="lb-n ${n === 0 ? 'zero' : n >= 8 ? 'full' : ''}">${n}/8</span>`;

  async function init() {
    LB.libs = await api('/api/lib/list');
    const opt = (l) => `<option value="${l.id}">${esc(l.volume)}${l.device ? ' (Gerät)' : ''} · ${l.trackCount.toLocaleString('de')} Tracks</option>`;
    el('#lb-lib').innerHTML = LB.libs.filter((l) => l.trackCount).map(opt).join('');
    el('#lb-target').innerHTML = '<option value="">Library des Tracks</option>' + LB.libs.filter((l) => l.trackCount).map(opt).join('');
    if (!LB.lib || !LB.libs.some((l) => l.id === LB.lib)) LB.lib = LB.libs.find((l) => l.trackCount)?.id || null;
    el('#lb-lib').value = LB.lib || '';
    await loadLib();
  }
  async function loadLib() {
    if (!LB.lib) { el('#lb-tree').innerHTML = '<p class="muted">Keine Engine Library gefunden.</p>'; return; }
    LB.list = null; LB.open.clear();
    el('#lb-tree').innerHTML = '<p class="muted">Lese Playlists …</p>';
    const tree = await api('/api/lib/playlists?lib=' + encodeURIComponent(LB.lib));
    LB.tree = tree; renderTree();
    await loadRows();
  }
  function renderTree() {
    const node = (p, d) => `<div class="lb-pl ${LB.list === p.id ? 'sel' : ''}" data-pl="${p.id}" style="padding-left:${6 + d * 14}px">${p.children.length ? `<b class="lb-tw" data-tw="${p.id}">${LB.open.has(p.id) ? '▾' : '▸'}</b>` : '<b class="lb-tw"></b>'}<span class="ell">${esc(p.title)}</span><span class="muted">${p.count || ''}</span></div>` +
      (LB.open.has(p.id) ? p.children.map((c) => node(c, d + 1)).join('') : '');
    el('#lb-tree').innerHTML = `<div class="lb-pl ${LB.list == null ? 'sel' : ''}" data-pl="">◉ <span>Alle Tracks</span></div>` + LB.tree.map((p) => node(p, 0)).join('');
  }
  async function loadRows() {
    el('#lb-rows').innerHTML = '<tr><td class="muted">Lese Tracks und Cues …</td></tr>';
    let note = '';
    if (LB.list == null) LB.rows = await api('/api/lib/tracks?lib=' + encodeURIComponent(LB.lib));
    else {
      const r = await api(`/api/lib/playlist?lib=${encodeURIComponent(LB.lib)}&id=${LB.list}`);
      LB.rows = r.tracks; if (r.missing) note = ` · ${r.missing} Einträge zeigen auf eine nicht angeschlossene Library`;
    }
    LB.limit = 400; LB.note = note; renderRows(); updateBulk();
  }
  function shown() { return el('#lb-miss').checked ? LB.rows.filter((t) => t.cues === 0 || t.loops === 0) : LB.rows; }
  function renderRows() {
    const rows = shown(), libVol = LB.libs.find((l) => l.id === LB.lib)?.volume;
    const missing = LB.rows.filter((t) => t.cues === 0 || t.loops === 0).length;
    el('#lb-info').textContent = `${LB.rows.length.toLocaleString('de')} Tracks · ${missing.toLocaleString('de')} ohne Cues oder Loops${LB.note || ''}`;
    el('#lb-rows').innerHTML = rows.slice(0, LB.limit).map((t) => `<tr data-lib="${t.lib}" data-id="${t.id}"><td class="ell">${esc(t.artist || '')}</td><td class="ell">${esc(t.title || '')}</td><td>${t.bpm ? t.bpm.toFixed(1) : '–'}</td><td>${keyBadge(t.camelot)}</td><td>${pill(t.cues)}</td><td>${pill(t.loops)}</td><td class="muted">${t.volume !== libVol ? esc(t.volume) : ''}</td><td><button class="lb-one" title="Cues & Loops für diesen Track automatisch setzen">✦</button></td></tr>`).join('') +
      (rows.length > LB.limit ? `<tr><td colspan="8" class="more"><button id="lb-more">Weitere ${Math.min(500, rows.length - LB.limit)} anzeigen</button></td></tr>` : '') +
      (!rows.length ? '<tr><td colspan="8" class="muted">Keine Tracks.</td></tr>' : '');
  }
  function updateBulk() {
    const lib = LB.libs.find((l) => l.id === LB.lib), missing = (LB.list == null ? LB.rows : LB.rows.filter((t) => t.lib === LB.lib)).filter((t) => t.cues === 0 || t.loops === 0).length;
    el('#lb-bulk').textContent = `✦ Alle fehlenden${LB.list == null ? '' : ' der Playlist'} (${missing.toLocaleString('de')})`;
    el('#lb-bulk').disabled = !missing;
    const tgt = LB.libs.find((l) => l.id === el('#lb-target').value);
    el('#lb-warn').innerHTML = (tgt || lib)?.device ? '⚠ Ziel ist ein Prime-Gerät: Es darf währenddessen nicht laufen. Danach das Laufwerk am Mac auswerfen.' : '';
  }

  async function run(lib, ids, label) {
    const target = el('#lb-target').value || lib, tl = LB.libs.find((l) => l.id === target), mode = el('#lb-mode').value;
    const key = target + '|' + mode;
    if (!LB.confirmed.has(key) || ids == null) {
      const n = ids ? ids.length : (await api('/api/lib/auto', { lib, target, mode, dry: true })).tracks;
      const text = `${label}: ${n.toLocaleString('de')} Track(s)\nZiel: ${tl.volume}${tl.device ? ' (Prime-Gerät)' : ''}\n${mode === 'all' ? 'Vorhandene Cues und Loops werden ERSETZT.' : 'Nur freie Plätze werden gefüllt, Vorhandenes bleibt.'}\n\nEngine DJ muss geschlossen sein${tl.device ? ', das Gerät darf nicht laufen' : ''}. Beim ersten Schreiben in diese Library entsteht ein Backup der Datenbank.`;
      if (!confirm(text)) return;
      if (ids) LB.confirmed.add(key);
    }
    const job = await api('/api/lib/auto', { lib, target, ids, mode }).catch((e) => { toast('⚠ ' + esc(e.message), 7000); return null; });
    if (!job) return;
    for (;;) {
      const j = await api('/api/lib/job');
      el('#lb-job').textContent = `${j.phase} … ${j.done.toLocaleString('de')}/${j.total.toLocaleString('de')}`;
      if (!j.running) {
        if (j.error) { el('#lb-job').textContent = ''; toast('⚠ ' + esc(j.error), 8000); return; }
        const sk = j.skip || {}, parts = [];
        if (sk.noMatch) parts.push(`${sk.noMatch} ohne passenden Track im Ziel`);
        if (sk.noGrid) parts.push(`${sk.noGrid} ohne Beatgrid`);
        if (sk.nothing) parts.push(`${sk.nothing} schon vollständig`);
        el('#lb-job').textContent = `✓ ${j.written.toLocaleString('de')} Track(s) geschrieben${parts.length ? ' · ' + parts.join(', ') : ''}${j.backup ? ' · Backup angelegt' : ''}`;
        await loadRows(); return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  el('#lb-lib').onchange = (e) => { LB.lib = e.target.value; loadLib(); };
  el('#lb-target').onchange = updateBulk;
  el('#lb-miss').onchange = () => { LB.limit = 400; renderRows(); };
  el('#lb-rescan').onclick = async () => { toast('Lese alle Libraries neu ein …'); await api('/api/rescan', {}); await load(); await init(); toast('Fertig ✓'); };
  el('#lb-bulk').onclick = () => run(LB.lib, null, 'Alle fehlenden in ' + (LB.libs.find((l) => l.id === LB.lib)?.volume || ''));
  el('#lb-tree').addEventListener('click', (e) => {
    const tw = e.target.closest('[data-tw]');
    if (tw && tw.dataset.tw) { const id = +tw.dataset.tw; LB.open.has(id) ? LB.open.delete(id) : LB.open.add(id); renderTree(); return; }
    const pl = e.target.closest('[data-pl]'); if (!pl) return;
    LB.list = pl.dataset.pl === '' ? null : +pl.dataset.pl; renderTree(); loadRows();
  });
  el('#lb-rows').addEventListener('click', (e) => {
    if (e.target.id === 'lb-more') { LB.limit += 500; renderRows(); return; }
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    if (e.target.classList.contains('lb-one')) { const t = LB.rows.find((r) => String(r.id) === tr.dataset.id && r.lib === tr.dataset.lib); return run(tr.dataset.lib, [+tr.dataset.id], (t?.title || 'Track')); }
    Player.load(tr.dataset.lib + ':' + tr.dataset.id, true, 'drop');
  });
  window.Libraries = { init, _state: LB };
})();
