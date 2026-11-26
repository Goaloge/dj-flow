// DJ FLOW – Mix-Lab: Set-Editor, zoombare Waveforms mit Beatgrid, Engine-Cues & -Loops, Übergangs-Engine
'use strict';
(() => {
  const TYPES = {
    stems:       { name: 'Stem-Mix',      icon: '▥', bars: 16, desc: 'Drums, Bass, Melodie und Vocals bekommen je einen eigenen Modus. Tracks ohne Stems nutzen ersatzweise die EQ-Bänder.' },
    bands:       { name: 'Band-Mix',      icon: '☰', bars: 16, desc: 'Bass, Mitten und Höhen bekommen je einen eigenen Modus.' },
    longBlend:   { name: 'Long Blend',    icon: '≋', bars: 32, desc: 'B blendet über die erste Hälfte ein, in der Mitte tauschen die Bässe, danach blendet A aus.' },
    bassSwap:    { name: 'Bass-Swap',     icon: '⇅', bars: 16, desc: 'Beide laufen voll; B ohne Bass. In der Mitte (auf dem Takt) wird der Bass getauscht, am Ende fährt A raus.' },
    cut:         { name: 'Cut',           icon: '✂', bars: 1,  desc: 'Harter Wechsel exakt auf den Beat: A stoppt am Mix-Out, B startet am Mix-In.' },
    filterSweep: { name: 'Filter Sweep',  icon: '◢', bars: 16, desc: 'Hochpass dünnt A aus, B öffnet sich aus dem Tiefpass.' },
    echoOut:     { name: 'Echo Out',      icon: '◎', bars: 4,  desc: 'A hallt am Ende des Übergangs aus (bei Cut am Mix-Out).' },
    spinback:    { name: 'Spinback',      icon: '↺', bars: 1,  desc: 'A dreht am Ende des Übergangs rückwärts weg (bei Cut vor dem Mix-Out).' },
    loopRoll:    { name: 'Loop Roll',     icon: '∞', bars: 2,  desc: 'A rollt mit kürzer werdenden Loops (1 → 1/8 Beat) zum Ende des Übergangs.' },
  };
  // Ein Übergang = eine Mischart (tr.type) + beliebig viele Effekt-Ebenen (tr.fx)
  const STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];
  const defStems = () => ({ drums: 'swap', bass: 'swap', other: 'crossfade', vocals: 'crossfade' });
  const BASES = ['stems', 'bands', 'longBlend', 'bassSwap', 'cut'], FX = ['filterSweep', 'echoOut', 'spinback', 'loopRoll'];
  function normTr(tr) {
    if (tr.norm) return tr;
    tr.fx = [];
    if (FX.includes(tr.type)) {
      tr.fx = [tr.type];
      if (tr.type === 'filterSweep') { tr.type = 'bands'; tr.bands = { low: 'crossfade', mid: 'crossfade', high: 'crossfade' }; } else tr.type = 'cut';
    }
    tr.norm = true;
    return tr;
  }
  const hasFx = (tr, f) => !!tr?.fx?.includes(f);
  const trLabel = (tr) => [TYPES[tr.type]?.name || '', ...(tr.fx || []).map((f) => TYPES[f].name)].join(' + ');
  const BAR_OPTS = [1, 2, 4, 8, 16, 32, 64];
  const COLORS = ['#f4d338', '#ef8130', '#e8414d', '#d74fd6', '#8a5ef0', '#1dafd7', '#2fd27b', '#9be03b'];
  const PEAK_RATE = 120; // Waveform-Punkte pro Sekunde (Hi-Res)

  const ML = {
    trans: JSON.parse(localStorage.getItem('djflow.trans') || '{}'),
    pair: 0, setId: localStorage.getItem('djflow.setId') || null,
    ts: new Map(), // uid -> TrackState
    snap: 4, loopLen: 16, sync: true,
    views: {}, // 'A' | 'B' -> WaveView
    preview: null, playingSet: false,
  };
  // ================= Undo/Redo: Zustands-Schnappschüsse, nur echte Änderungen werden ein Schritt =================
  const H = {
    undo: [], redo: [], last: null, timer: null, down: false, restoring: false,
    editJson: (e) => JSON.stringify(e, (k, v) => (k === 'dirty' || k === 'savedAt' ? undefined : v)),
    snap() {
      const edits = {}; for (const [u, ts] of ML.ts) edits[u] = H.editJson(ts.edit);
      const trans = {}; for (const k in ML.trans) trans[k] = JSON.stringify(ML.trans[k]);
      return { set: JSON.stringify(S.set), master: ML.master ?? null, tempo: JSON.stringify(ML.tempo || []), samples: JSON.stringify(ML.samples || []), trans, edits, pair: ML.pair };
    },
    same(a, b) {
      if (a.set !== b.set || a.master !== b.master || a.tempo !== b.tempo || a.samples !== b.samples) return false;
      for (const k in b.trans) if (k in a.trans && a.trans[k] !== b.trans[k]) return false;
      for (const k in a.trans) if (k in b.trans && a.trans[k] !== b.trans[k]) return false;
      for (const u in b.edits) if (u in a.edits && a.edits[u] !== b.edits[u]) return false;
      return true;
    },
    // Neu geladene Tracks und automatisch angelegte Übergänge sind keine Bearbeitung
    adopt(s) {
      for (const u in s.edits) if (!(u in H.last.edits)) H.last.edits[u] = s.edits[u];
      for (const k in s.trans) if (!(k in H.last.trans)) H.last.trans[k] = s.trans[k];
    },
    commit() {
      if (H.restoring) return;
      const s = H.snap();
      if (!H.last) { H.last = s; H.ui(); return; }
      H.adopt(s);
      if (H.same(H.last, s)) return;
      H.undo.push(H.last); if (H.undo.length > 100) H.undo.shift();
      H.redo = []; H.last = s; H.ui();
    },
    soon() { clearTimeout(H.timer); H.timer = setTimeout(() => { if (H.down || TL.drag) H.soon(); else H.commit(); }, 250); },
    async apply(to) {
      H.restoring = true;
      const was = H.last, wasPlaying = TL.playing;
      if (wasPlaying) TL.stop();
      S.set = JSON.parse(to.set); registerAliases(); saveSet();
      ML.tempo = JSON.parse(to.tempo); localStorage.setItem('djflow.tempo', to.tempo);
      ML.master = to.master ?? null; localStorage.setItem('djflow.master', ML.master ?? ''); const bpmIn = $('#tl-bpm'); if (bpmIn) bpmIn.value = '';
      ML.samples = JSON.parse(to.samples || '[]'); localStorage.setItem('djflow.samples', to.samples || '[]');
      for (const k in to.trans) ML.trans[k] = JSON.parse(to.trans[k]);
      localStorage.setItem('djflow.trans', JSON.stringify(ML.trans));
      for (const u in to.edits) {
        const ts = ML.ts.get(u); if (!ts || was.edits[u] === to.edits[u]) continue;
        const dirty = ts.edit.dirty; ts.edit = JSON.parse(to.edits[u]); ts.edit.dirty = dirty;
        api('/api/edits', { uid: u, edit: ts.edit });
      }
      ML.pair = Math.max(0, Math.min(to.pair, S.set.length - 2));
      H.last = to; ML.scores = {};
      await render(); redrawAll(); renderPads();
      H.restoring = false; H.ui();
      if (wasPlaying) TL.play();
    },
    async step(from, into, name) {
      clearTimeout(H.timer); H.commit();
      if (!from.length) return toast('Nichts zum ' + name, 1200);
      into.push(H.last); await H.apply(from.pop());
    },
    ui() { const u = $('#tl-undo'), r = $('#tl-redo'); if (u) { u.disabled = !H.undo.length; r.disabled = !H.redo.length; } },
  };
  const undo = () => H.step(H.undo, H.redo, 'Rückgängigmachen'), redo = () => H.step(H.redo, H.undo, 'Wiederherstellen');
  const saveTrans = () => { localStorage.setItem('djflow.trans', JSON.stringify(ML.trans)); H.soon(); };
  const pairKey = (a, b) => `${a}>${b}`;
  const nameKey = (t) => `${t.artist}|${t.title}`.toLowerCase().replace(/\(.*?\)|[^a-z0-9|]/g, '');
  const inSet = (uid) => { const t = S.byUid.get(uid); if (!t) return false; const k = nameKey(t); return S.set.some((u) => u === uid || nameKey(S.byUid.get(u)) === k); };

  // ================= Audio =================
  let AC = null, master = null;
  let limNode = null, limOn = true;
  async function setupLimiter(c) {
    try {
      await c.audioWorklet.addModule('dsp.js'); await c.audioWorklet.addModule('limiter-worklet.js');
      limNode = new AudioWorkletNode(c, 'djf-limiter', { outputChannelCount: [2] });
      master.disconnect(); master.connect(limNode); limNode.connect(c.destination); limNode.connect(meter('T'));
      limNode.port.postMessage({ on: limOn });
      limNode.port.onmessage = (e) => { const el = $('#tl-gr'); if (el) { const db = 20 * Math.log10(e.data.gain); el.textContent = limOn ? (db < -0.05 ? db.toFixed(1) : '0.0') + ' dB' : 'aus'; } };
    } catch (e) { console.warn('Limiter nicht verfügbar', e); master.connect(meter('T')); }
  }
  function ac() {
    if (!AC) { AC = new AudioContext(); master = AC.createGain(); master.connect(AC.destination); setupLimiter(AC); }
    if (AC.state === 'suspended') AC.resume();
    return AC;
  }
  const bufCache = new Map();
  async function loadBuffer(ts) {
    if (ts.buf) return ts.buf;
    if (ts.baseUid) { const bs = await getTS(ts.baseUid); await loadBuffer(bs); ts.buf = bs.buf; ts.peaks = bs.peaks; return ts.buf; } // Audio vom ersten Vorkommen mitbenutzen
    if (!ts.bufP) {
      ts.loadingAudio = true; redrawAll();
      ts.bufP = (async () => {
        let buf;
        try {
          const r = await fetch(`/api/pcm?uid=${encodeURIComponent(ts.uid)}`); if (!r.ok) throw new Error('pcm');
          buf = await ac().decodeAudioData(await r.arrayBuffer());
        } catch {
          // Rückfall ohne ffmpeg: kann bei manchen MP3s gegenüber Engine versetzt sein
          if (!ML.warnedDecode) { ML.warnedDecode = true; toast('⚠ ffmpeg nicht gefunden. Manche MP3s können gegenüber dem Engine-Beatgrid versetzt sein.', 8000); }
          buf = await ac().decodeAudioData(await (await fetch(`/api/audio?uid=${encodeURIComponent(ts.uid)}`)).arrayBuffer());
        }
        ts.buf = buf; ts.peaks = computePeaks(buf); ts.loadingAudio = false;
        bufCache.set(ts.uid, ts);
        if (bufCache.size > 8) { const [k, old] = bufCache.entries().next().value; if (!isActive(k)) { old.buf = null; old.bufP = null; old.stret = null; old.stems = null; old.stemsSt = null; } bufCache.delete(k); }
        redrawAll();
        return buf;
      })().catch((e) => { ts.loadingAudio = false; ts.bufP = null; toast('⚠ Audio konnte nicht geladen werden: ' + e.message); throw e; });
    }
    return ts.bufP;
  }
  const isActive = (uid) => [ML.views.A?.ts?.uid, ML.views.B?.ts?.uid, ML.cueView?.ts?.uid].includes(uid);

  // 3-Band-Peaks (low < 200 Hz, mid, high > 4 kHz) per Ein-Pol-Filter
  function computePeaks(buf) {
    const sr = buf.sampleRate, ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const win = Math.floor(sr / PEAK_RATE), n = Math.floor(ch0.length / win);
    const lo = new Float32Array(n), mi = new Float32Array(n), hi = new Float32Array(n);
    const a1 = 1 - Math.exp(-2 * Math.PI * 200 / sr), a2 = 1 - Math.exp(-2 * Math.PI * 4000 / sr);
    let l1 = 0, l2 = 0;
    for (let i = 0, k = 0; i < n; i++) {
      let ml = 0, mm = 0, mh = 0;
      for (let j = 0; j < win; j++, k++) {
        const x = (ch0[k] + ch1[k]) * 0.5;
        l1 += a1 * (x - l1); l2 += a2 * (x - l2);
        const vl = Math.abs(l1), vm = Math.abs(l2 - l1), vh = Math.abs(x - l2);
        if (vl > ml) ml = vl; if (vm > mm) mm = vm; if (vh > mh) mh = vh;
      }
      lo[i] = ml; mi[i] = mm; hi[i] = mh;
    }
    const norm = (a) => { let m = 0; for (const v of a) if (v > m) m = v; m = m || 1; for (let i = 0; i < a.length; i++) a[i] /= m; };
    norm(lo); norm(mi); norm(hi);
    return { lo, mi, hi, n };
  }

  // ================= Lautstärke: Gain + Fades + Automationskurve =================
  function autoDb(e, sec) {
    const p = e.auto; if (!p?.length) return 0;
    if (sec <= p[0].sec) return p[0].db;
    for (let i = 1; i < p.length; i++) if (sec <= p[i].sec) { const a = p[i - 1], b = p[i]; return a.db + ((b.db - a.db) * (sec - a.sec)) / Math.max(1e-6, b.sec - a.sec); }
    return p[p.length - 1].db;
  }
  /** Linearer Verstärkungsfaktor an einer Trackposition */
  function envAt(ts, sec, withGain = true) {
    const e = ts.edit; let v = Math.pow(10, ((withGain ? e.gainDb || 0 : 0) + autoDb(e, sec)) / 20);
    const fi = (e.fadeIn || 0) * bar(ts), fo = (e.fadeOut || 0) * bar(ts);
    if (fi && sec < fi) v *= Math.max(0, sec / fi);
    if (fo && sec > ts.dur - fo) v *= Math.max(0, (ts.dur - sec) / fo);
    if (e.endAt != null) { const fe = 2 * bar(ts); if (sec > e.endAt - fe) v *= Math.max(0, (e.endAt - sec) / fe); } // Set endet hier: 2 Takte ausblenden
    return v;
  }
  function scheduleEnv(param, ts, pos, at, rate, until, constant = false, map = null) {
    if (constant) { param.value = 1; return; }
    const d = Math.max(0.05, until - at), n = Math.max(2, Math.min(40000, Math.ceil(d * 30)));
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = envAt(ts, map ? map(at + (i / (n - 1)) * d) : pos + (i / (n - 1)) * d * rate, false);
    param.setValueCurveAtTime(c, at, d);
  }
  // ================= Effekt-Bereiche & Automation =================
  const FX_TYPES = { filterHP: ['Hochpass-Sweep', '#2fd27b'], filterLP: ['Tiefpass-Sweep', '#1dafd7'], echo: ['Echo', '#d74fd6'], reverb: ['Hall', '#8a5ef0'], roll: ['Loop Roll', '#ef8130'] };
  const LANES = { low: ['Low', -26, 6, ' dB'], mid: ['Mid', -26, 6, ' dB'], high: ['High', -26, 6, ' dB'], filter: ['Filter', -1, 1, ''], echo: ['Echo', 0, 1, ''], reverb: ['Hall', 0, 1, ''] };
  function laneValue(pts, sec) {
    if (!pts?.length) return 0;
    if (sec <= pts[0].sec) return pts[0].v;
    for (let i = 1; i < pts.length; i++) if (sec <= pts[i].sec) { const a = pts[i - 1], b = pts[i]; return a.v + ((b.v - a.v) * (sec - a.sec)) / Math.max(1e-6, b.sec - a.sec); }
    return pts[pts.length - 1].v;
  }
  /** Wert eines Parameters an einer Trackposition: Automation, von Effekt-Bereichen überlagert */
  function paramAt(ts, p, sec) {
    let v = laneValue(ts.edit.lanes[p], sec);
    for (const f of ts.edit.fx) {
      if (sec < f.start || sec >= f.end) continue;
      const x = (sec - f.start) / Math.max(1e-6, f.end - f.start), edge = Math.min(1, (sec - f.start) / 0.03);
      if (p === 'filter' && f.type === 'filterHP') v = Math.max(v, 0.85 * x);
      if (p === 'filter' && f.type === 'filterLP') v = Math.min(v, -0.85 * x);
      if (p === 'echo' && f.type === 'echo') v = Math.max(v, 0.7 * edge);
      if (p === 'reverb' && f.type === 'reverb') v = Math.max(v, 0.6 * edge);
    }
    return v;
  }
  const usesParam = (ts, p) => (ts.edit.lanes[p]?.length > 0) || ts.edit.fx.some((f) => (p === 'filter' && f.type.startsWith('filter')) || f.type === p);
  const irCache = new WeakMap();
  function reverbIR(c) {
    if (irCache.has(c)) return irCache.get(c);
    const n = Math.floor(c.sampleRate * 2.4), b = c.createBuffer(2, n, c.sampleRate);
    for (let k = 0; k < 2; k++) { const d = b.getChannelData(k); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3); }
    irCache.set(c, b); return b;
  }
  /** Automation + Effekt-Bereiche eines Abschnitts einplanen */
  function scheduleFx(c, ch, ts, pos, at, r, until, map = null) {
    const d = Math.max(0.05, until - at), n = Math.max(2, Math.min(60000, Math.ceil(d * 60)));
    const curve = (param, fn) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = fn(map ? map(at + (i / (n - 1)) * d) : pos + (i / (n - 1)) * d * r); param.setValueCurveAtTime(a, at, d); };
    if (usesParam(ts, 'low')) curve(ch.aL.gain, (s) => paramAt(ts, 'low', s));
    if (usesParam(ts, 'mid')) curve(ch.aM.gain, (s) => paramAt(ts, 'mid', s));
    if (usesParam(ts, 'high')) curve(ch.aH.gain, (s) => paramAt(ts, 'high', s));
    if (usesParam(ts, 'filter')) {
      const nyq = c.sampleRate / 2 - 100;
      ch.hp.type = 'highpass'; ch.lp.type = 'lowpass'; ch.hp.Q.value = 1; ch.lp.Q.value = 1;
      curve(ch.hp.frequency, (s) => { const v = paramAt(ts, 'filter', s); return v > 0.01 ? 20 * Math.pow(250, v) : 10; });
      curve(ch.lp.frequency, (s) => { const v = paramAt(ts, 'filter', s); return v < -0.01 ? Math.max(80, 20000 * Math.pow(1 + v, 3)) : nyq; });
    }
    if (usesParam(ts, 'echo')) {
      const send = c.createGain(), dl = c.createDelay(4), fb = c.createGain();
      dl.delayTime.value = Math.min(3.9, (beat(ts) / r) * 0.75); fb.gain.value = 0.55;
      ch.lp.connect(send); send.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(ch.out);
      curve(send.gain, (s) => paramAt(ts, 'echo', s));
    }
    if (usesParam(ts, 'reverb')) {
      const send = c.createGain(), cv = c.createConvolver(); cv.buffer = reverbIR(c);
      ch.lp.connect(send); send.connect(cv); cv.connect(ch.out);
      curve(send.gain, (s) => paramAt(ts, 'reverb', s));
    }
  }
  const meters = {};
  function meter(k) {
    if (!meters[k]) { meters[k] = ac().createAnalyser(); meters[k].fftSize = 1024; }
    return meters[k];
  }
  function drawMeter(v, an) {
    const cv = v.el.closest('.ml-deck')?.querySelector('.ml-meter'); if (!cv) return;
    const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H);
    let db = -60, peak = 0;
    if (an) {
      const a = new Float32Array(an.fftSize); an.getFloatTimeDomainData(a);
      let s = 0; for (const x of a) { s += x * x; const y = Math.abs(x); if (y > peak) peak = y; }
      db = 10 * Math.log10(s / a.length + 1e-9);
    }
    const X = (d) => Math.max(0, Math.min(1, (d + 48) / 54)) * W;
    const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#2fd27b'); gr.addColorStop(0.75, '#f4d338'); gr.addColorStop(0.9, '#e8414d');
    g.fillStyle = gr; g.fillRect(0, 0, X(db), H);
    const pd = 20 * Math.log10(peak + 1e-9);
    g.fillStyle = peak >= 1 ? '#ff2020' : '#fff'; g.fillRect(X(pd) - 1, 0, 2, H);
    g.fillStyle = '#ffffff55'; g.fillRect(X(0), 0, 1, H);
    v.el.closest('.ml-deck').querySelector('.ml-clip')?.classList.toggle('on', peak >= 1);
  }

  // Einzel-Deck-Wiedergabe (Vorhören, Cue-/Loop-Pads)
  const solo = { src: null, ts: null, t0: 0, pos0: 0, loop: null };
  function soloStop() { try { solo.src?.stop(); } catch { /* */ } solo.src = null; solo.ts = null; redrawAll(); }
  async function soloPlay(ts, from, loop = null) {
    stopPreview(); soloStop(); Player.audio.pause();
    const buf = await loadBuffer(ts), c = ac(), mt = meter('S'), p0 = Math.max(0, from), t0 = c.currentTime + 0.02;
    let handle;
    if (loop) {
      const ch = deckChain(c, mt); applyEq(ch, ts); scheduleEnv(ch.env.gain, ts, p0, t0, 1, t0 + 1, true);
      const src = c.createBufferSource(); src.buffer = buf; src.loop = true; src.loopStart = loop.start; src.loopEnd = loop.end; src.connect(ch.input); src.start(t0, p0);
      handle = { stop() { try { src.stop(); } catch { /* */ } ch.out.disconnect(); } }; solo.vol = ch.vol;
    } else {
      // gleiche Kette wie Timeline und Export, damit Effekte und Automation mitklingen
      const clip = { ts, rate: 1, start: 0, in: p0, end: ts.dur - p0, tr: null, prevTr: null, noStret: true, g: (p) => p - p0 };
      const n = scheduleClip(c, clip, t0, master, mt, 60 / beat(ts));
      handle = { stop() { n.srcs.forEach((s) => { try { s.stop(); } catch { /* */ } }); n.ch.out.disconnect(); } }; solo.vol = n.ch.vol;
    }
    Object.assign(solo, { src: handle, ts, t0, pos0: p0, loop });
    tick();
  }
  function soloPos() {
    if (!solo.src) return null;
    let p = solo.pos0 + (AC.currentTime - solo.t0);
    if (!solo.loop && p >= solo.ts.dur) { soloStop(); return null; }
    if (solo.loop && p > solo.loop.end) { const L = solo.loop.end - solo.loop.start; p = solo.loop.start + ((p - solo.loop.start) % L); }
    return p;
  }

  // ================= Track-Zustand =================
  // Pro Track genau ein Zustandsobjekt, auch bei parallelen Aufrufen (sonst gehen Bearbeitungen verloren)
  const tsLoading = new Map();
  function getTS(uid) {
    if (ML.ts.has(uid)) return Promise.resolve(ML.ts.get(uid));
    if (!tsLoading.has(uid)) tsLoading.set(uid, loadTS(uid).finally(() => tsLoading.delete(uid)));
    return tsLoading.get(uid);
  }
  async function loadTS(uid) {
    const t = S.byUid.get(uid);
    const perf = await api(`/api/perf?uid=${encodeURIComponent(uid)}`);
    const pad8 = (a) => Array.from({ length: 8 }, (_, i) => a?.[i] || null);
    const edit = perf.edit ? { ...perf.edit, cues: pad8(perf.edit.cues), loops: pad8(perf.edit.loops) } : {
      mixIn: perf.auto?.mixIn ?? perf.grid?.firstBeatSec ?? 0,
      mixOut: perf.auto?.mixOut ?? (perf.grid?.durationSec || t.length) * 0.8,
      cues: pad8(perf.engineCues), loops: pad8(perf.engineLoops), dirty: false,
    };
    edit.gainDb ??= 0; edit.fadeIn ??= 0; edit.fadeOut ??= 0; edit.auto ??= []; edit.keyLock ??= true; edit.fx ??= []; edit.lanes ??= {}; edit.stemOff ??= {}; edit.eq ??= { high: 0, mid: 0, low: 0, filter: 0 };
    const stemInfo = await api('/api/stems/has', { uids: [uid] });
    const ts = { hasStems: !!stemInfo[uid], uid, t, perf, edit, dur: perf.grid?.durationSec || t.length || 1, buf: null, peaks: null };
    ts.baseUid = uid.includes('#') ? uid.split('#')[0] : null; // zweites Vorkommen desselben Tracks (A–B–A)
    ML.ts.set(uid, ts);
    return ts;
  }
  const saveT = new Map();
  function changed(ts) {
    ts.edit.dirty = true; H.soon();
    updateLiveEq(ts);
    clearTimeout(saveT.get(ts.uid));
    saveT.set(ts.uid, setTimeout(() => api('/api/edits', { uid: ts.uid, edit: ts.edit }), 400));
    redrawAll(); renderPads(); renderCuePads(); renderTransPanel(); renderTimelineChips(); TL.dirty();
  }
  const beat = (ts) => ts.perf.grid?.beatSec || 60 / (ts.t.bpm || 128);
  const bar = (ts) => beat(ts) * 4;
  const fb = (ts) => ts.perf.grid?.firstBeatSec || 0;
  function snapSec(ts, sec, units = ML.snap) {
    if (!units) return sec;
    if (units < 0) { if (!ts.peaks) { loadBuffer(ts).catch(() => {}); return sec; } return DSP.onsetNear(ts.peaks, PEAK_RATE, sec, beat(ts) / 2); }
    const u = units * beat(ts);
    return fb(ts) + Math.round((sec - fb(ts)) / u) * u;
  }
  const barNo = (ts, sec) => Math.floor((sec - fb(ts)) / bar(ts)) + 1;

  async function applyAuto(ts, mode) {
    const a = ts.perf.auto; if (!a) return toast('Kein Beatgrid – bitte erst in Engine DJ analysieren');
    const e = ts.edit;
    if (mode === 'all') {
      e.cues = Array.from({ length: 8 }, (_, i) => a.cues[i] || null);
      e.loops = Array.from({ length: 8 }, (_, i) => a.loops[i] || null);
    } else {
      const fill = (slots, items, same) => { for (const it of items) { if (slots.some((s) => s && same(s, it))) continue; const i = slots.indexOf(null); if (i < 0) break; slots[i] = it; } };
      fill(e.cues, a.cues, (s, it) => Math.abs(s.sec - it.sec) < 0.2);
      fill(e.loops, a.loops, (s, it) => Math.abs(s.start - it.start) < 0.2 && Math.abs(s.end - it.end) < 0.2);
    }
    e.mixIn = a.mixIn; e.mixOut = a.mixOut;
    // Keine automatische Feinkorrektur mehr: gemessen lagen die Beatgrid-Positionen näher am echten Einschlag (Median 16 statt 33 ms).
    // Wer einen Punkt auf einen Einschlag legen will, nutzt den Snap-Modus „Transient“.
    changed(ts);
  }

  // ================= Übergangs-Empfehlung =================
  function introBars(ts) { const f = ts.perf.auto?.sections?.find((s) => s.full); return f ? f.startBar : 16; }
  function recommend(A, B, tr) {
    const pitch = Math.abs(A.t.bpm / B.t.bpm - 1) * 100;
    const halfDouble = Math.abs(A.t.bpm / (B.t.bpm * 2) - 1) * 100 < 3 || Math.abs((A.t.bpm * 2) / B.t.bpm - 1) * 100 < 3;
    const dE = (B.t.energy ?? 5) - (A.t.energy ?? 5);
    if (pitch > 8 && !halfDouble) return dE >= 2 ? 'spinback' : 'echoOut';
    if (tr && tr.key < 0.5) return introBars(B) >= 8 ? 'filterSweep' : 'echoOut';
    if (introBars(B) < 4) return dE >= 2 ? 'loopRoll' : 'cut';
    if (dE >= 3) return 'loopRoll';
    if (tr && tr.key >= 0.9 && introBars(B) >= 16) return 'longBlend';
    return 'bassSwap';
  }
  function getTrans(A, B, tr) {
    const k = pairKey(A.uid, B.uid);
    if (!ML.trans[k]) { const type = recommend(A, B, tr); ML.trans[k] = { type, bars: TYPES[type].bars, lead: 8, auto: true }; saveTrans(); }
    return normTr(ML.trans[k]);
  }
  function rateFor(A, B) {
    let r = A.t.bpm && B.t.bpm ? A.t.bpm / B.t.bpm : 1;
    if (r > 1.3) r /= 2; else if (r < 0.77) r *= 2; // Halb-/Doppeltempo
    return r;
  }

  // ================= Übergangs-Engine (Web Audio) =================
  function deckChain(c, mk, dest = master) {
    const env = c.createGain();
    const low = c.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 180;
    const mid = c.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.7;
    const high = c.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 4500;
    const filt = c.createBiquadFilter(); filt.type = 'peaking'; filt.gain.value = 0; // neutral: Allpass würde die Phase drehen
    const dry = c.createGain(), send = c.createGain(), delay = c.createDelay(4), fbk = c.createGain(), wet = c.createGain(), out = c.createGain();
    send.gain.value = 0; fbk.gain.value = 0; wet.gain.value = 1;
    const eqL = c.createBiquadFilter(); eqL.type = 'lowshelf'; eqL.frequency.value = 180;
    const eqM = c.createBiquadFilter(); eqM.type = 'peaking'; eqM.frequency.value = 1000; eqM.Q.value = 0.7;
    const eqH = c.createBiquadFilter(); eqH.type = 'highshelf'; eqH.frequency.value = 4500;
    const eqF = c.createBiquadFilter(); eqF.type = 'peaking'; eqF.gain.value = 0;
    const vol = c.createGain();
    env.connect(vol); vol.connect(eqL); eqL.connect(eqM); eqM.connect(eqH); eqH.connect(eqF);
    const aL = c.createBiquadFilter(); aL.type = 'lowshelf'; aL.frequency.value = 180;
    const aM = c.createBiquadFilter(); aM.type = 'peaking'; aM.frequency.value = 1000; aM.Q.value = 0.7;
    const aH = c.createBiquadFilter(); aH.type = 'highshelf'; aH.frequency.value = 4500;
    const hp = c.createBiquadFilter(); hp.type = 'peaking'; hp.gain.value = 0;
    const lp = c.createBiquadFilter(); lp.type = 'peaking'; lp.gain.value = 0;
    eqF.connect(aL); aL.connect(aM); aM.connect(aH); aH.connect(hp); hp.connect(lp); lp.connect(low); low.connect(mid).connect(high).connect(filt);
    filt.connect(dry).connect(out);
    filt.connect(send).connect(delay); delay.connect(fbk).connect(delay); delay.connect(wet).connect(out);
    out.connect(dest); if (mk) out.connect(mk);
    return { input: env, env, vol, aL, aM, aH, hp, lp, eqL, eqM, eqH, eqF, low, mid, high, filt, dry, send, delay, fbk, wet, out };
  }
  const OFF = -40;
  const BAND_PRESETS = {
    'Bass-Swap': { low: 'swap', mid: 'crossfade', high: 'crossfade' },
    Crossfade: { low: 'crossfade', mid: 'crossfade', high: 'crossfade' },
    'Höhen zuerst': { low: 'swap', mid: 'swap', high: 'crossfade' },
    'Alles tauschen': { low: 'swap', mid: 'swap', high: 'swap' },
    'Beide voll': { low: 'swap', mid: 'full', high: 'full' },
  };
  const defBands = () => ({ low: 'swap', mid: 'crossfade', high: 'crossfade' });
  /** Band-Modi: none = beide stumm, swap = Wechsel in der Mitte, crossfade = gleitend, full = beide voll */
  function bandFx(ch, dir, bands, T, D, mid, beatLen, keepAudible = false) {
    const low = keepAudible ? -12 : OFF;
    const set = (p, v, t) => p.setValueAtTime(v, Math.max(0, t)), ramp = (p, v, t) => p.linearRampToValueAtTime(v, Math.max(0, t));
    for (const b of ['low', 'mid', 'high']) {
      const p = ch[b].gain, mode = (bands || defBands())[b];
      if (dir === 'out') {
        if (mode === 'none') { set(p, 0, T - 0.01); ramp(p, low, T + 0.02); }
        else if (mode === 'swap') { set(p, 0, mid); ramp(p, low, mid + beatLen / 4); }
        else if (mode === 'crossfade') { set(p, 0, T); ramp(p, low, T + D); }
      } else {
        if (mode === 'none') { set(p, OFF, T); set(p, OFF, T + D - 0.01); ramp(p, 0, T + D + 0.02); }
        else if (mode === 'swap') { set(p, OFF, T); set(p, OFF, mid); ramp(p, 0, mid + beatLen / 4); }
        else if (mode === 'crossfade') { set(p, OFF, T); ramp(p, 0, T + D); }
      }
    }
    if (dir === 'out' && !keepAudible) { set(ch.out.gain, 1, T + D - beatLen); ramp(ch.out.gain, 0, T + D); }
  }
  function setVol(node, ts) {
    const t = node.context.currentTime, v = Math.pow(10, (ts.edit.gainDb || 0) / 20);
    node.gain.cancelScheduledValues(t);
    if (t === 0) node.gain.value = v; else node.gain.setTargetAtTime(v, t, 0.015);
  }
  /** Feste Klangregelung eines Tracks (getrennt von den Übergängen) */
  function applyEq(ch, ts) {
    const q = ts.edit.eq || {}, t = ch.low.context.currentTime;
    setVol(ch.vol, ts);
    ch.eqL.gain.setValueAtTime(q.low || 0, t); ch.eqM.gain.setValueAtTime(q.mid || 0, t); ch.eqH.gain.setValueAtTime(q.high || 0, t);
    const f = q.filter || 0;
    if (Math.abs(f) < 0.02) ch.eqF.type = 'peaking';
    else if (f < 0) { ch.eqF.type = 'lowpass'; ch.eqF.frequency.setValueAtTime(Math.max(80, 20000 * Math.pow(1 + f, 3)), t); }
    else { ch.eqF.type = 'highpass'; ch.eqF.frequency.setValueAtTime(20 * Math.pow(250, f), t); }
  }

  /** Übergang A → B abspielen. opt: { lead (Takte vor Mix-Out), tail (Takte nach Ende) } */
  async function playTransition(A, B, trSet, opt = {}) {
    await TL.refresh();
    const c = TL.clips.find((k) => k.ts === A && TL.clips[k.i + 1]?.ts === B); if (!c) return { done: Promise.resolve(), stopped: true };
    TL.pos = Math.max(0, c.T - (opt.lead ?? trSet.lead ?? 8) * 240 / TL.M);
    const W = $('#tl-canvas').clientWidth; if (TL.secX(c.T) < 0 || TL.secX(c.T) > W) TL.x0 = Math.max(0, c.T - (W * 0.3) / TL.px);
    await TL.play();
    const stopAt = c.end + (opt.tail ?? 8) * 240 / TL.M, pv = { stopped: false };
    pv.done = new Promise((res) => {
      const iv = setInterval(() => {
        if (!TL.playing) { pv.stopped = true; clearInterval(iv); res(); }
        else if (TL.pos >= stopAt) { clearInterval(iv); TL.stop(); res(); }
      }, 100);
    });
    return pv;
  }
  function stopPreview() { if (TL.playing) TL.stop(); }

  const LANE_COL = { low: '#5a8cff', mid: '#ff8a00', high: '#e6e9f2', filter: '#2fd27b', echo: '#d74fd6', reverb: '#a98cff', vol: '#b6ff3b' };
  const laneDef = (k) => (k === 'vol' ? { min: -36, max: 12, col: LANE_COL.vol, key: 'db' } : { min: LANES[k][1], max: LANES[k][2], col: LANE_COL[k], key: 'v' });
  const curveList = (ts) => (ts.curveMode === 'vol' ? ts.edit.auto : (ts.edit.lanes[ts.curveMode] ||= []));

  /** Waagerechter Scrollbalken. o: { view() -> {start, span, total}, set(start) } */
  function hScroll(el, o) {
    el.classList.add('hscroll'); const th = document.createElement('i'); el.appendChild(th);
    const update = () => {
      const { start, span, total } = o.view(), W = el.clientWidth; if (!W || !total) return;
      const w = Math.max(28, Math.min(W, (span / total) * W)), range = W - w, maxS = Math.max(1e-6, total - span);
      th.style.width = w + 'px'; th.style.transform = 'translateX(' + Math.max(0, Math.min(range, (start / maxS) * range)) + 'px)';
      el.classList.toggle('full', span >= total);
    };
    const toStart = (x) => { const { span, total } = o.view(), W = el.clientWidth, w = th.offsetWidth; o.set(Math.max(0, Math.min(1, x / Math.max(1, W - w))) * Math.max(0, total - span)); update(); };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const left = el.getBoundingClientRect().left, onThumb = e.target === th, grab = onThumb ? e.clientX - th.getBoundingClientRect().left : th.offsetWidth / 2;
      toStart(e.clientX - left - grab); el.setPointerCapture(e.pointerId);
      const mv = (ev) => toStart(ev.clientX - left - grab);
      const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    });
    return update;
  }

  // ================= Waveform-Ansicht =================
  class WaveView {
    constructor(el, role) {
      this.role = role; // 'A' (raus) | 'B' (rein) | 'single'
      this.el = el;
      el.innerHTML = `<canvas class="wv-main"></canvas><div class="wv-scroll"></div><canvas class="wv-ov"></canvas>`;
      this.scrollUpdate = hScroll(el.querySelector('.wv-scroll'), { view: () => ({ start: this.start, span: this.W * this.spp, total: this.ts?.dur || 0 }), set: (s) => { this.start = s; this.changed(); } });
      this.cv = el.querySelector('.wv-main'); this.ov = el.querySelector('.wv-ov');
      this.start = 0; this.spp = 0.05; this.ts = null; this.followOn = false;
      this.bind();
      new ResizeObserver(() => this.draw()).observe(el);
    }
    setTrack(ts) { this.ts = ts; this.fit(); }
    get W() { return this.cv.clientWidth || 800; }
    fit() { if (!this.ts) return; this.spp = this.ts.dur / this.W; this.start = 0; this.changed(false); }
    zoomTo(center, spp) {
      const ts = this.ts; if (!ts) return;
      this.spp = Math.max(0.0015, Math.min(ts.dur / this.W * 1.05, spp));
      this.start = center - (this.W / 2) * this.spp; this.clamp(); this.changed();
    }
    zoomBy(f, atX = this.W / 2) {
      const t = this.start + atX * this.spp;
      this.spp = Math.max(0.0015, Math.min(this.ts.dur / this.W * 1.05, this.spp * f));
      this.start = t - atX * this.spp; this.clamp(); this.changed();
    }
    clamp() { const max = Math.max(0, this.ts.dur - this.W * this.spp * 0.5); this.start = Math.max(-this.W * this.spp * 0.5, Math.min(max, this.start)); }
    x(sec) { return (sec - this.start) / this.spp; }
    sec(x) { return this.start + x * this.spp; }
    follow(on) { this.followOn = on; }
    changed(propagate = true) {
      this.draw();
      if (propagate && ML.sync && (this.role === 'A' || this.role === 'B')) syncFrom(this);
    }
    // ---- Hit-Test ----
    hit(px, py) {
      const ts = this.ts, e = ts.edit, H = this.cv.clientHeight, near = (s) => Math.abs(this.x(s) - px) <= 6;
      if (py >= H - 38 && py < H - 22) for (let i = e.fx.length - 1; i >= 0; i--) { const f = e.fx[i]; if (near(f.start)) return { k: 'fxStart', i }; if (near(f.end)) return { k: 'fxEnd', i }; if (px > this.x(f.start) && px < this.x(f.end)) return { k: 'fxBody', i }; }
      if (!this.noMix && near(e.mixIn) && py < 22) return { k: 'mixIn' };
      if (!this.noMix && near(e.mixOut) && py < 22) return { k: 'mixOut' };
      for (let i = 0; i < 8; i++) { const c = e.cues[i]; if (c && near(c.sec) && py > H - 22) return { k: 'cue', i }; }
      for (let i = 0; i < 8; i++) {
        const l = e.loops[i]; if (!l) continue;
        const ly = 24 + (i % 4) * 9;
        if (py >= ly - 2 && py <= ly + 9) {
          if (near(l.start)) return { k: 'loopStart', i };
          if (near(l.end)) return { k: 'loopEnd', i };
          if (px > this.x(l.start) && px < this.x(l.end)) return { k: 'loopBody', i };
        }
      }
      if (!this.noMix && near(e.mixIn)) return { k: 'mixIn' };
      if (!this.noMix && near(e.mixOut)) return { k: 'mixOut' };
      for (let i = 0; i < 8; i++) { const c = e.cues[i]; if (c && near(c.sec)) return { k: 'cue', i }; }
      return null;
    }
    bind() {
      const cv = this.cv;
      let drag = null;
      cv.addEventListener('pointerdown', (ev) => {
        if (!this.ts || ev.button !== 0) return;
        cv.setPointerCapture(ev.pointerId);
        const px = ev.offsetX, s = this.sec(px);
        if (this.ts.curveMode) {
          const e = this.ts.edit, mode = this.ts.curveMode, list = curveList(this.ts), H = this.cv.clientHeight;
          const valAt = (y) => (mode === 'vol' ? Math.max(-36, Math.min(12, 12 - ((y - 20) / (H - 42)) * 48)) - (e.gainDb || 0) : (() => { const L = LANES[mode]; return Math.max(L[1], Math.min(L[2], L[2] - ((y - 20) / (H - 42)) * (L[2] - L[1]))); })());
          const key = mode === 'vol' ? 'db' : 'v';
          let pt = list.find((p) => Math.abs(this.x(p.sec) - px) < 7);
          if (!pt) { pt = { sec: snapSec(this.ts, s), [key]: valAt(ev.offsetY) }; list.push(pt); list.sort((a, b) => a.sec - b.sec); }
          drag = { mode: 'pt', pt, key, list, dbAt: valAt, dirty: true }; this.draw(); return;
        }
        if (this.ts.fxBrush) { const st = snapSec(this.ts, s); drag = { mode: 'newFx', st, f: null }; return; }
        const h = this.hit(px, ev.offsetY);
        if (h) drag = { mode: 'marker', h, s0: s, orig: JSON.parse(JSON.stringify(this.ts.edit)) };
        else if (ev.altKey) { const st = snapSec(this.ts, s); drag = { mode: 'newLoop', st, i: this.ts.edit.loops.indexOf(null) }; if (drag.i < 0) { toast('Alle 8 Loop-Slots belegt'); drag = null; } }
        else drag = { mode: 'pan', x0: px, start0: this.start, moved: false };
      });
      cv.addEventListener('pointermove', (ev) => {
        if (!this.ts) return;
        const px = ev.offsetX, s = this.sec(px);
        if (!drag) { const h = this.hit(px, ev.offsetY); cv.style.cursor = this.ts.curveMode || this.ts.fxBrush ? 'crosshair' : h ? (h.k === 'loopBody' || h.k === 'fxBody' ? 'grab' : 'ew-resize') : ev.altKey ? 'crosshair' : 'default'; return; }
        const e = this.ts.edit;
        if (drag.mode === 'pt') { drag.pt.sec = Math.max(0, snapSec(this.ts, s)); drag.pt[drag.key] = drag.dbAt(ev.offsetY); drag.list.sort((a, b) => a.sec - b.sec); this.draw(); return; }
        if (drag.mode === 'newFx') {
          let en = snapSec(this.ts, s); if (en <= drag.st) en = drag.st + (ML.snap > 0 ? ML.snap : 1) * beat(this.ts);
          if (!drag.f) { drag.f = { type: this.ts.fxBrush, start: drag.st, end: en }; e.fx.push(drag.f); } else drag.f.end = en;
          drag.dirty = true; this.draw(); return;
        }
        if (drag.mode === 'pan') {
          if (Math.abs(px - drag.x0) > 3) drag.moved = true;
          this.start = drag.start0 - (px - drag.x0) * this.spp; this.clamp(); this.changed(); return;
        }
        if (drag.mode === 'newLoop') {
          let en = snapSec(this.ts, s); if (en <= drag.st) en = drag.st + (ML.snap > 0 ? ML.snap : 1) * beat(this.ts);
          e.loops[drag.i] = { label: `Loop ${drag.i + 1}`, start: drag.st, end: en, color: COLORS[drag.i] }; drag.dirty = true; this.draw(); return;
        }
        const h = drag.h, o = drag.orig, d = s - drag.s0, sn = (v) => snapSec(this.ts, v);
        if (h.k.startsWith('fx')) { const f = e.fx[h.i], g0 = o.fx[h.i]; if (h.k === 'fxStart') f.start = Math.min(sn(g0.start + d), g0.end - 0.05); else if (h.k === 'fxEnd') f.end = Math.max(sn(g0.end + d), g0.start + 0.05); else { const L = g0.end - g0.start; f.start = Math.max(0, sn(g0.start + d)); f.end = f.start + L; } drag.dirty = true; this.draw(); return; }
        if (h.k === 'mixIn') e.mixIn = sn(o.mixIn + d);
        else if (h.k === 'mixOut') e.mixOut = sn(o.mixOut + d);
        else if (h.k === 'cue') e.cues[h.i] = { ...o.cues[h.i], sec: sn(o.cues[h.i].sec + d) };
        else if (h.k === 'loopStart') e.loops[h.i] = { ...o.loops[h.i], start: Math.min(sn(o.loops[h.i].start + d), o.loops[h.i].end - 0.05) };
        else if (h.k === 'loopEnd') e.loops[h.i] = { ...o.loops[h.i], end: Math.max(sn(o.loops[h.i].end + d), o.loops[h.i].start + 0.05) };
        else if (h.k === 'loopBody') { const L = o.loops[h.i].end - o.loops[h.i].start, st = sn(o.loops[h.i].start + d); e.loops[h.i] = { ...o.loops[h.i], start: st, end: st + L }; }
        drag.dirty = true;
        if (ML.sync && (h.k === 'mixIn' || h.k === 'mixOut')) syncFrom(this); else this.draw();
      });
      cv.addEventListener('pointerup', (ev) => {
        if (!drag) return;
        if (drag.mode === 'pan' && !drag.moved) {
          const s = this.sec(ev.offsetX);
          if (this.ts) { this.cursor = Math.max(0, s); soloPlay(this.ts, s); }
        }
        if (drag.dirty) changed(this.ts);
        drag = null;
      });
      cv.addEventListener('dblclick', (ev) => {
        if (!this.ts || this.ts.curveMode || this.ts.fxBrush || this.hit(ev.offsetX, ev.offsetY)) return;
        const e = this.ts.edit, i = e.cues.indexOf(null);
        if (i < 0) return toast('Alle 8 Cue-Slots belegt');
        e.cues[i] = { label: `Cue ${i + 1}`, sec: snapSec(this.ts, this.sec(ev.offsetX)), color: COLORS[i] };
        changed(this.ts);
      });
      cv.addEventListener('contextmenu', (ev) => {
        ev.preventDefault(); if (!this.ts) return;
        if (this.ts.curveMode) { const l = curveList(this.ts), i = l.findIndex((p) => Math.abs(this.x(p.sec) - ev.offsetX) < 7); if (i >= 0) { l.splice(i, 1); changed(this.ts); } return; }
        const h = this.hit(ev.offsetX, ev.offsetY); if (!h) return;
        const e = this.ts.edit, a = this.ts.perf.auto;
        if (h.k.startsWith('fx')) e.fx.splice(h.i, 1);
        else if (h.k === 'cue') e.cues[h.i] = null;
        else if (h.k.startsWith('loop')) e.loops[h.i] = null;
        else if (h.k === 'mixIn') e.mixIn = a?.mixIn ?? 0;
        else if (h.k === 'mixOut') e.mixOut = a?.mixOut ?? this.ts.dur * 0.8;
        changed(this.ts);
      });
      cv.addEventListener('wheel', (ev) => {
        if (!this.ts) return; ev.preventDefault();
        if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) { this.start += (ev.deltaX || ev.deltaY) * this.spp; this.clamp(); this.changed(); }
        else this.zoomBy(Math.pow(1.0018, ev.deltaY), ev.offsetX);
      }, { passive: false });
      this.ov.addEventListener('pointerdown', (ev) => {
        if (!this.ts) return;
        const go = (x) => { const t = (x / this.ov.clientWidth) * this.ts.dur; this.start = t - (this.W / 2) * this.spp; this.clamp(); this.changed(); };
        go(ev.offsetX); this.ov.setPointerCapture(ev.pointerId);
        this.ov.onpointermove = (e2) => go(e2.offsetX);
        this.ov.onpointerup = () => { this.ov.onpointermove = null; };
      });
    }
    // ---- Zeichnen ----
    draw(pos = null) {
      const ts = this.ts, cv = this.cv, dpr = devicePixelRatio || 1, W = this.W, H = cv.clientHeight || 160;
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      g.font = '10px -apple-system, sans-serif';
      if (!ts) { g.fillStyle = '#7b84a0'; g.fillText('Kein Track', 10, H / 2); return; }
      const e = ts.edit, mid = (H - 22 + 40) / 2, amp = (H - 22 - 40) / 2;
      // Abschnitte (voll/Break) als Band oben
      for (const s of ts.perf.auto?.sections || []) {
        g.fillStyle = s.full ? '#ff2bd61a' : '#00e5ff10';
        g.fillRect(this.x(s.start), 0, this.x(s.end) - this.x(s.start), 20);
      }
      // Übergangszonen
      const pk = this.pairInfo();
      if (pk) {
        const zone = (from, len, col) => { g.fillStyle = col; g.fillRect(this.x(from), 20, len / this.spp, H - 42); };
        if (this.role === 'A') zone(e.mixOut, pk.D, '#ff2bd61f');
        if (this.role === 'B') zone(e.mixIn, pk.D * pk.rate, '#00e5ff1f');
      }
      // Grid
      const gr = ts.perf.grid;
      if (gr?.beatSec) {
        const bpx = gr.beatSec / this.spp, b0 = Math.floor((this.start - gr.firstBeatSec) / gr.beatSec) - 1;
        const step = bpx >= 5 ? 1 : bpx * 4 >= 5 ? 4 : bpx * 16 >= 5 ? 16 : 64;
        for (let b = Math.ceil(b0 / step) * step; ; b += step) {
          const t = gr.firstBeatSec + b * gr.beatSec, x = this.x(t);
          if (x > W) break; if (x < -1) continue;
          const isBar = b % 4 === 0, isPhrase = b % 64 === 0, is4 = b % 16 === 0;
          g.fillStyle = isPhrase ? '#ffffff55' : is4 ? '#ffffff30' : isBar ? '#ffffff1c' : '#ffffff0b';
          g.fillRect(Math.round(x), 20, 1, H - 42);
          const barN = b / 4 + 1;
          const lblEvery = bpx * 4 > 34 ? 1 : bpx * 16 > 34 ? 4 : bpx * 64 > 34 ? 16 : 64;
          if (isBar && (barN - 1) % lblEvery === 0 && barN >= 1) { g.fillStyle = isPhrase ? '#fff' : '#8b93ad'; g.fillText(String(barN), x + 2, 15); }
        }
      }
      // Waveform
      const P = ts.peaks, ov = ts.perf.overview;
      for (let x = 0; x < W; x++) {
        const t0 = this.sec(x), t1 = t0 + this.spp;
        if (t1 < 0 || t0 > ts.dur) continue;
        let l = 0, m = 0, h = 0;
        if (P) {
          const i0 = Math.max(0, Math.floor(t0 * PEAK_RATE)), i1 = Math.min(P.n, Math.max(i0 + 1, Math.ceil(t1 * PEAK_RATE)));
          for (let i = i0; i < i1; i++) { if (P.lo[i] > l) l = P.lo[i]; if (P.mi[i] > m) m = P.mi[i]; if (P.hi[i] > h) h = P.hi[i]; }
        } else if (ov) {
          const i = Math.min(ov.length - 1, Math.max(0, Math.floor((t0 / ts.dur) * ov.length)));
          [l, m, h] = ov[i].map((v) => v / 255);
        }
        g.fillStyle = '#2563ff'; g.fillRect(x, mid - l * amp, 1, l * amp * 2);
        g.fillStyle = '#ff8a00d0'; g.fillRect(x, mid - m * amp * 0.8, 1, m * amp * 1.6);
        g.fillStyle = '#ffffffd0'; g.fillRect(x, mid - h * amp * 0.5, 1, h * amp);
      }
      if (!P && ts.loadingAudio) { g.fillStyle = '#ffb02e'; g.fillText('lade Hi-Res-Waveform …', W - 140, 34); }
      // Loops
      e.loops.forEach((l, i) => {
        if (!l) return;
        const x0 = this.x(l.start), x1 = this.x(l.end), y = 24 + (i % 4) * 9;
        if (x1 < 0 || x0 > W) return;
        g.fillStyle = l.color + '26'; g.fillRect(x0, 20, x1 - x0, H - 42);
        g.fillStyle = l.color; g.fillRect(x0, y, Math.max(2, x1 - x0), 7);
        g.fillRect(x0, 20, 1, H - 42); g.fillRect(x1 - 1, 20, 1, H - 42);
        if (x1 - x0 > 30) { g.fillStyle = '#000'; g.fillText(`${i + 1} ${l.label}`.slice(0, Math.floor((x1 - x0) / 6)), x0 + 3, y + 7); }
      });
      // Cues
      e.cues.forEach((c, i) => {
        if (!c) return; const x = this.x(c.sec); if (x < -50 || x > W) return;
        g.fillStyle = c.color; g.fillRect(x - 1, 20, 2, H - 42);
        const lbl = `${i + 1} ${c.label}`, tw = g.measureText(lbl).width + 8;
        g.fillRect(x, H - 20, tw, 16); g.fillStyle = '#000'; g.fillText(lbl, x + 4, H - 8);
      });
      // Lautstärkekurve (0 dB in der Mitte der Skala −36…+12)
      if (ts.curveMode === 'vol' || e.auto.length || e.gainDb || e.fadeIn || e.fadeOut) {
        const Y = (db) => 20 + ((12 - Math.max(-36, Math.min(12, db))) / 48) * (H - 42);
        g.strokeStyle = '#b6ff3b'; g.lineWidth = 1.5; g.beginPath();
        for (let x = 0; x <= W; x += 3) { const s = Math.max(0, Math.min(ts.dur, this.sec(x))); const y = Y(20 * Math.log10(envAt(ts, s) + 1e-4)); x ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke(); g.lineWidth = 1;
        if (ts.curveMode === 'vol') for (const p of e.auto) { g.fillStyle = '#b6ff3b'; g.fillRect(this.x(p.sec) - 4, Y(p.db + (e.gainDb || 0)) - 4, 8, 8); }
      }
      // Automationsspuren: gewählte kräftig, andere dezent
      const LC = { low: '#5a8cff', mid: '#ff8a00', high: '#e6e9f2', filter: '#2fd27b', echo: '#d74fd6', reverb: '#a98cff' };
      for (const [k, L] of Object.entries(LANES)) {
        const pts = e.lanes[k], on = ts.curveMode === k; if (!on && !pts?.length) continue;
        const Y = (v) => 20 + ((L[2] - v) / (L[2] - L[1])) * (H - 42);
        g.strokeStyle = LC[k]; g.globalAlpha = on ? 1 : 0.45; g.lineWidth = on ? 1.5 : 1; g.beginPath();
        for (let x = 0; x <= W; x += 3) { const v = laneValue(pts, Math.max(0, this.sec(x))); x ? g.lineTo(x, Y(v)) : g.moveTo(x, Y(v)); }
        g.stroke(); g.lineWidth = 1;
        if (on) { for (const p of pts || []) { g.fillStyle = LC[k]; g.fillRect(this.x(p.sec) - 4, Y(p.v) - 4, 8, 8); } g.fillStyle = LC[k]; g.fillText(L[0] + ' · Klick setzt Punkt', 6, 32); }
        g.globalAlpha = 1;
      }
      // Effekt-Bereiche
      for (const f of e.fx) {
        const a = this.x(f.start), b = this.x(f.end), col = FX_TYPES[f.type][1]; if (b < 0 || a > W) continue;
        g.fillStyle = col + '22'; g.fillRect(a, 20, b - a, H - 58);
        g.fillStyle = col; g.fillRect(a, H - 38, b - a, 15);
        g.save(); g.beginPath(); g.rect(a, H - 38, b - a, 15); g.clip(); g.fillStyle = '#000'; g.fillText(FX_TYPES[f.type][0], a + 4, H - 27); g.restore();
      }
      // Mix-Marker
      const flag = (sec, col, txt) => {
        const x = this.x(sec); if (x < -60 || x > W + 60) return;
        g.fillStyle = col; g.fillRect(x - 1, 0, 3, H - 20);
        const tw = g.measureText(txt).width + 10; g.fillRect(x, 0, tw, 18); g.fillStyle = '#000'; g.font = 'bold 10px -apple-system, sans-serif'; g.fillText(txt, x + 5, 13); g.font = '10px -apple-system, sans-serif';
      };
      if (!this.noMix) { flag(e.mixIn, '#00e5ff', `MIX IN · T${barNo(ts, e.mixIn)}`); flag(e.mixOut, '#ff2bd6', `MIX OUT · T${barNo(ts, e.mixOut)}`); }
      // Playhead
      const p = pos ?? this.playPos() ?? this.cursor;
      if (p != null) { const x = this.x(p); g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2, H); g.fillStyle = '#ffffff22'; g.fillRect(0, 0, Math.max(0, x), 20); }
      this.drawOverview(p);
      this.scrollUpdate?.();
    }
    playPos() {
      const ts = this.ts; if (!ts) return null;
      const pv = ML.preview;
      if (TL.playing) { const k = TL.clips.find((c) => c.ts === ts); if (k && TL.pos >= k.start && TL.pos < k.end) return k.in + (TL.pos - k.start) * k.rate; }
      if (solo.ts === ts) return soloPos();
      return null;
    }
    pairInfo() {
      const v = this.role === 'A' ? ML.views.B : this.role === 'B' ? ML.views.A : null;
      if (!v?.ts || !this.ts) return null;
      const A = this.role === 'A' ? this.ts : v.ts, B = this.role === 'A' ? v.ts : this.ts;
      const tr = ML.trans[pairKey(A.uid, B.uid)]; if (!tr) return null;
      return { D: tr.bars * bar(A), rate: rateFor(A, B) };
    }
    drawOverview(pos) {
      const ts = this.ts, cv = this.ov, dpr = devicePixelRatio || 1, W = cv.clientWidth || 800, H = cv.clientHeight || 30;
      cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const ov = ts.perf.overview; if (!ov) return;
      for (let x = 0; x < W; x++) { const [l, m] = ov[Math.floor((x / W) * ov.length)]; g.fillStyle = '#2b4fb3'; const v = (l / 255) * H * 0.45; g.fillRect(x, H / 2 - v, 1, v * 2); g.fillStyle = '#c66a00aa'; const w = (m / 255) * H * 0.3; g.fillRect(x, H / 2 - w, 1, w * 2); }
      const X = (s) => (s / ts.dur) * W;
      if (!this.noMix) { g.fillStyle = '#00e5ff'; g.fillRect(X(ts.edit.mixIn), 0, 2, H); g.fillStyle = '#ff2bd6'; g.fillRect(X(ts.edit.mixOut), 0, 2, H); }
      ts.edit.cues.forEach((c) => { if (c) { g.fillStyle = c.color; g.fillRect(X(c.sec), H - 6, 2, 6); } });
      g.strokeStyle = '#ffffffaa'; g.strokeRect(X(this.start) + 0.5, 0.5, Math.max(3, (this.W * this.spp / ts.dur) * W), H - 1);
      if (pos != null) { g.fillStyle = '#fff'; g.fillRect(X(pos), 0, 1, H); }
    }
  }

  function syncFrom(v) {
    const A = ML.views.A, B = ML.views.B;
    if (!A?.ts || !B?.ts) { v.draw(); return; }
    const r = rateFor(A.ts, B.ts);
    if (v === A) { B.spp = A.spp * r; B.start = B.ts.edit.mixIn + (A.start - A.ts.edit.mixOut) * r; }
    else { A.spp = B.spp / r; A.start = A.ts.edit.mixOut + (B.start - B.ts.edit.mixIn) / r; }
    A.draw(); B.draw();
  }
  function redrawAll() { ML.views.A?.draw(); ML.views.B?.draw(); ML.cueView?.draw(); }

  // Animations-Schleife während Wiedergabe
  let raf = null;
  function tick() {
    if (raf) return;
    const loop = () => {
      raf = null;
      const active = (ML.preview && !ML.preview.stopped && AC.currentTime < ML.preview.end) || solo.src;
      if (ML.preview && AC && AC.currentTime >= ML.preview.end) ML.preview = null;
      for (const k of ['A', 'B']) {
        const v = ML.views[k]; if (!v?.ts) continue;
        const p = v.playPos();
        if (p != null && (v.followOn || solo.ts === v.ts)) { const x = v.x(p); if (x > v.W * 0.85 || x < 0) { v.start = p - v.W * 0.25 * v.spp; if (ML.sync && k === 'A') syncFrom(v); } }
        v.draw(p);
        const pv = ML.preview;
        drawMeter(v, pv && !pv.stopped ? (pv.A === v.ts ? meters.A : pv.B === v.ts ? meters.B : null) : solo.ts === v.ts ? meters.S : null);
      }
      const cv = ML.cueView;
      if (cv?.ts && solo.ts === cv.ts) {
        const p = soloPos();
        if (p != null) { cv.cursor = p; const x = cv.x(p); if (x > cv.W * 0.85 || x < 0) cv.start = p - cv.W * 0.25 * cv.spp; cv.draw(p); }
      }
      if (active) raf = requestAnimationFrame(loop);
      else { for (const k of ['A', 'B']) if (ML.views[k]?.ts) drawMeter(ML.views[k], null); ML.views.A?.follow(false); ML.views.B?.follow(false); redrawAll(); }
    };
    raf = requestAnimationFrame(loop);
  }

  // ================= Set-Timeline =================
  function setTracks() { registerAliases(); S.set = S.set.filter((u) => S.byUid.has(u)); return S.set; }
  async function render() {
    H.soon();
    const set = setTracks();
    if (ML.pair > Math.max(0, set.length - 2)) ML.pair = Math.max(0, set.length - 2);
    renderTimeline();
    TL.refresh(); renderBottom();
  }
  function cardHTML(uid, i) {
    const t = S.byUid.get(uid), ts = ML.ts.get(uid);
    const sel = i === ML.pair || i === ML.pair + 1;
    return `<div class="ml-card ${sel ? 'sel' : ''}" data-i="${i}">
      <div class="ml-card-h"><span class="num">${i + 1}</span><span class="ell" title="${esc(t.artist)} – ${esc(t.title)}"><b>${esc(t.title || t.filename)}</b><br><span class="muted">${esc(t.artist || '')}</span></span></div>
      <canvas class="ml-mini" data-uid="${uid}"></canvas>
      <div class="ml-card-f"><span>${t.bpm?.toFixed(1) ?? '–'}</span>${keyBadge(t.camelot)}${energyBar(t.energy)}${ts?.edit.dirty ? '<span class="dirty" title="Cues/Loops geändert, noch nicht in Engine">●</span>' : ''}</div>
      <div class="ml-card-a"><button data-act="left" title="nach links">◀</button><button data-act="swap" title="Gegen besten Alternativ-Track tauschen">⟳</button><button data-act="rm" title="Entfernen">✕</button><button data-act="right" title="nach rechts">▶</button></div>
    </div>`;
  }
  function chipHTML(i) {
    const a = S.set[i], b = S.set[i + 1];
    const tr = ML.trans[pairKey(a, b)];
    const ty = tr ? TYPES[tr.type] : null;
    return `<button class="ml-chip ${i === ML.pair ? 'sel' : ''}" data-pair="${i}" title="Übergang bearbeiten">
      <span class="ic">${ty ? ty.icon : '⇄'}</span><span>${tr ? esc(trLabel(tr)) : 'Übergang'}</span><span class="muted">${tr ? tr.bars + ' T' : ''}</span><span class="sc" data-score="${i}"></span></button>`;
  }
  function renderTimeline() {
    const set = S.set;
    $('#ml-timeline').innerHTML = (set.length ? set.map((u, i) => cardHTML(u, i) + (i < set.length - 1 ? chipHTML(i) : '')).join('') : '<div class="muted ml-empty">Noch keine Tracks im Set. Wähle einen Start-Track →</div>') +
      `<div class="ml-add"><button id="ml-pick" class="primary">＋ Track wählen</button><button id="ml-suggest">✦ Vorschlag${set.length ? ' passend zu #' + set.length : ''}</button></div>`;
    $$('#ml-timeline .ml-mini').forEach(async (cv) => { const ts = await getTS(cv.dataset.uid); drawMini(cv, ts); });
    renderTimelineChips();
  }
  async function renderTimelineChips() {
    for (let i = 0; i < S.set.length - 1; i++) {
      const el = $(`#ml-timeline [data-score="${i}"]`); if (!el) continue;
      const k = pairKey(S.set[i], S.set[i + 1]);
      if (!ML.scores?.[k]) { ML.scores = ML.scores || {}; ML.scores[k] = await api('/api/transition', { a: S.set[i], b: S.set[i + 1] }); }
      const sc = ML.scores[k].score; el.textContent = sc; el.className = `sc ${scoreCls(sc)}`;
      const tr = ML.trans[k]; const chip = el.closest('.ml-chip');
      if (chip && tr) chip.querySelector('.ic').textContent = TYPES[tr.type].icon;
    }
  }
  function drawMini(cv, ts) {
    const dpr = devicePixelRatio || 1, W = cv.clientWidth || 200, H = cv.clientHeight || 34;
    cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ov = ts.perf.overview; if (!ov) return;
    for (let x = 0; x < W; x++) { const [l, m, h] = ov[Math.floor((x / W) * ov.length)]; const v = ((l + m + h) / 765) * H * 0.9; g.fillStyle = '#3a6bff'; g.fillRect(x, H / 2 - v / 2, 1, v); }
    const X = (s) => (s / ts.dur) * W;
    g.fillStyle = '#00e5ff40'; g.fillRect(0, 0, X(ts.edit.mixIn), H);
    g.fillStyle = '#ff2bd640'; g.fillRect(X(ts.edit.mixOut), 0, W, H);
    g.fillStyle = '#00e5ff'; g.fillRect(X(ts.edit.mixIn), 0, 2, H); g.fillStyle = '#ff2bd6'; g.fillRect(X(ts.edit.mixOut), 0, 2, H);
  }

  $('#ml-timeline').addEventListener('click', async (ev) => {
    const chip = ev.target.closest('.ml-chip');
    if (chip) return openPair(+chip.dataset.pair);
    if (ev.target.id === 'ml-pick') return openPicker();
    if (ev.target.id === 'ml-suggest') return addSuggestion();
    const card = ev.target.closest('.ml-card'); if (!card) return;
    const i = +card.dataset.i, act = ev.target.dataset.act;
    if (act === 'rm') { S.set.splice(i, 1); saveSet(); return render(); }
    if (act === 'left' && i > 0) { [S.set[i - 1], S.set[i]] = [S.set[i], S.set[i - 1]]; saveSet(); return render(); }
    if (act === 'right' && i < S.set.length - 1) { [S.set[i + 1], S.set[i]] = [S.set[i], S.set[i + 1]]; saveSet(); return render(); }
    if (act === 'swap') {
      const prev = S.set[i - 1];
      const sug = prev ? await api('/api/suggest', { uid: prev, n: 30 }) : null;
      const cands = (sug || []).filter((s) => !inSet(s.uid));
      if (!cands.length) return toast('Keine Alternative gefunden');
      S.set[i] = cands[Math.floor(Math.random() * Math.min(5, cands.length))].uid; saveSet(); return render();
    }
    openPair(Math.min(i, Math.max(0, S.set.length - 2)));
  });

  async function addSuggestion() {
    if (!S.set.length) return openPicker();
    const last = S.set[S.set.length - 1];
    const sug = (await api('/api/suggest', { uid: last, n: 40 })).filter((s) => !inSet(s.uid));
    if (!sug.length) return toast('Kein passender Track gefunden');
    S.set.push(sug[0].uid); saveSet();
    ML.pair = S.set.length - 2; await render();
    toast(`✦ ${esc(sug[0].artist)} – ${esc(sug[0].title)} (Mix-Score ${sug[0].match.score})`);
  }
  async function addTrack(uid, open = false) {
    if (!S.set.includes(uid)) S.set.push(uid);
    saveSet();
    ML.pair = Math.max(0, S.set.indexOf(uid) - 1);
    if (open) { setBottom('transition'); show('mixlab'); } else await render();
  }

  // Track-Auswahl (Suche + passende Vorschläge)
  function openPicker() {
    const last = S.set.length ? S.byUid.get(S.set[S.set.length - 1]) : null;
    let m = $('#ml-picker');
    if (!m) { m = document.createElement('div'); m.id = 'ml-picker'; m.className = 'modal'; document.body.appendChild(m); }
    m.classList.remove('hidden');
    m.innerHTML = `<div class="card picker"><div class="bar"><input id="mp-q" placeholder="Suche (Artist, Titel, 8A, 124-128, e>6) …" autofocus><button class="ghost" id="mp-x">✕</button></div>
      <div class="muted small">${last ? `Sortiert nach Mix-Score zu <b>${esc(last.title)}</b> (${last.bpm?.toFixed(0)} BPM · ${last.camelot})` : 'Start-Track wählen'}</div><div id="mp-list" class="mp-list"></div></div>`;
    const q = $('#mp-q');
    const run = async () => {
      const txt = q.value.trim();
      let rows;
      if (!txt && last) rows = (await api('/api/suggest', { uid: last.uid, n: 60 })).filter((s) => !inSet(s.uid)).map((s) => ({ t: s, sc: s.match.score }));
      else {
        const prev = $('#q').value; $('#q').value = txt; filter(); $('#q').value = prev;
        rows = S.filtered.filter((t) => !inSet(t.uid)).slice(0, 400).map((t) => ({ t, sc: last ? quickScore(last, t) : null }));
        if (last) rows.sort((a, b) => b.sc - a.sc);
        rows = rows.slice(0, 80); filter();
      }
      $('#mp-list').innerHTML = rows.map(({ t, sc }) => `<div class="sug" data-uid="${t.uid}">${sc != null ? `<span class="score ${scoreCls(sc)}">${sc}</span>` : '<span></span>'}
        <div><div>${esc(t.artist)} – ${esc(t.title)}</div><div class="muted">${t.bpm?.toFixed(1)} BPM · ${keyBadge(t.camelot)} · E${t.energy ?? '–'} · ${esc(t.genre || '')}</div></div>
        <span><button class="ghost pv">▶</button><button class="add">＋</button></span></div>`).join('') || '<p class="muted">Nichts gefunden</p>';
    };
    let tmr; q.oninput = () => { clearTimeout(tmr); tmr = setTimeout(run, 180); };
    m.onclick = async (ev) => {
      if (ev.target === m || ev.target.id === 'mp-x') { m.classList.add('hidden'); return; }
      const row = ev.target.closest('.sug'); if (!row) return;
      if (ev.target.classList.contains('pv')) { const ts = await getTS(row.dataset.uid); return soloPlay(ts, ts.perf.auto?.sections?.find((s) => s.full)?.start ?? ts.edit.mixIn); }
      soloStop(); m.classList.add('hidden'); addTrack(row.dataset.uid);
    };
    run(); setTimeout(() => q.focus(), 50);
  }
  // Client-seitige Kurz-Bewertung (für Suchergebnisse)
  function quickScore(a, b) {
    const ca = /^(\d+)([AB])$/.exec(a.camelot || ''), cb = /^(\d+)([AB])$/.exec(b.camelot || '');
    let k = 0.4;
    if (ca && cb) { const d = Math.min((ca[1] - cb[1] + 12) % 12, (cb[1] - ca[1] + 12) % 12); k = d === 0 ? (ca[2] === cb[2] ? 1 : 0.9) : d === 1 ? (ca[2] === cb[2] ? 0.92 : 0.55) : d === 2 ? 0.6 : 0.2; }
    const diff = a.bpm && b.bpm ? Math.min(...[b.bpm / a.bpm, b.bpm * 2 / a.bpm, b.bpm / (a.bpm * 2)].map((x) => Math.abs(1 - x))) * 100 : 5;
    const p = diff <= 1 ? 1 : diff <= 3 ? 0.9 : diff <= 6 ? 0.65 : diff <= 8 ? 0.4 : 0.1;
    const e = a.energy != null && b.energy != null ? Math.max(0, 1 - Math.abs(a.energy - b.energy) / 4) : 0.5;
    return Math.round((k * 0.38 + p * 0.34 + e * 0.16 + 0.6 * 0.12) * 100);
  }

  // ================= Editor (Deck A · Übergang · Deck B) =================
  function deckShell(role, ts, idx) {
    const t = ts.t;
    return `<div class="ml-deck" data-role="${role}">
      <div class="ml-deck-h">
        <span><span class="tag ${role === 'B' ? 'tag-b' : ''}">${role === 'B' ? 'B' : 'A'}</span><b>#${idx + 1} ${esc(t.artist)} – ${esc(t.title)}</b>
          <span class="muted">${t.bpm?.toFixed(2)} BPM · ${t.camelot ?? '–'} ${t.keyName ? '(' + t.keyName + ')' : ''} · E${t.energy ?? '–'} · ${fmt(ts.dur)}</span></span>
        <span class="ml-deck-btns">
          <button data-d="play" title="Ab Mix-In / Mix-Out vorhören">▶</button><button data-d="stop">■</button>
          <span class="sep"></span>
          <button data-d="zout">－</button><button data-d="zin">＋</button><button data-d="fit">Ganz</button><button data-d="zmix">Übergang</button>
          <span class="sep"></span>
          <button data-d="auto" title="Cues & Loops automatisch aus der Waveform setzen">✦ Auto</button>
          <button data-d="engine" title="Original-Cues/Loops aus Engine wiederherstellen" class="ghost">↺ Engine</button>
          <button data-d="write" title="Cues & Loops dieses Tracks in Engine DJ schreiben">⇪ Engine</button>
        </span>
      </div>
      <div class="ml-level">
        <label>Gain <input type="range" data-lv="gainDb" min="-24" max="12" step="0.5" value="${ts.edit.gainDb}"><b data-lvv>${ts.edit.gainDb} dB</b></label>
        <label>Fade In <select data-lv="fadeIn">${[0, 1, 2, 4, 8, 16, 32].map((b) => `<option value="${b}" ${b === ts.edit.fadeIn ? 'selected' : ''}>${b ? b + ' T' : 'aus'}</option>`).join('')}</select></label>
        <label>Fade Out <select data-lv="fadeOut">${[0, 1, 2, 4, 8, 16, 32].map((b) => `<option value="${b}" ${b === ts.edit.fadeOut ? 'selected' : ''}>${b ? b + ' T' : 'aus'}</option>`).join('')}</select></label>
        <label>Automation <select data-curve title="Klick setzt Punkt, Ziehen verschiebt, Rechtsklick löscht"><option value="">aus</option><option value="vol" ${ts.curveMode === 'vol' ? 'selected' : ''}>Lautstärke</option>${Object.entries(LANES).map(([k, L]) => `<option value="${k}" ${ts.curveMode === k ? 'selected' : ''}>${L[0]}${ts.edit.lanes[k]?.length ? ' ●' : ''}</option>`).join('')}</select></label>
        <label>Effekt setzen <select data-brush title="Wählen, dann in der Waveform ziehen"><option value="">–</option>${Object.entries(FX_TYPES).map(([k, f]) => `<option value="${k}" ${ts.fxBrush === k ? 'selected' : ''}>${f[0]}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" data-lv="keyLock" ${ts.edit.keyLock ? 'checked' : ''}> Key Lock</label>
        <canvas class="ml-meter"></canvas><span class="ml-clip">CLIP</span>
      </div>
      <div class="ml-wave"></div>
      <div class="ml-pads">
        <div class="pads" data-kind="cue"></div>
        <div class="pads" data-kind="loop"></div>
        <div class="ml-mixpts">
          <span>Mix-In <button data-n="in-">◀</button><b data-v="in"></b><button data-n="in+">▶</button></span>
          <span>Mix-Out <button data-n="out-">◀</button><b data-v="out"></b><button data-n="out+">▶</button></span>
          <span class="muted small" data-v="secs"></span>
        </div>
      </div>
    </div>`;
  }

  async function renderEditor() {
    const set = S.set, ed = $('#ml-editor');
    if (!set.length) { ed.innerHTML = ''; ML.views = {}; return; }
    const iA = ML.pair, iB = ML.pair + 1;
    const A = await getTS(set[iA]); const B = set[iB] ? await getTS(set[iB]) : null;
    let tr = null, score = null;
    if (B) { score = await api('/api/transition', { a: A.uid, b: B.uid }); tr = getTrans(A, B, score); ML.scores = ML.scores || {}; ML.scores[pairKey(A.uid, B.uid)] = score; }
    ed.innerHTML = deckShell('A', A, iA) + (B ? `<div id="ml-trans" class="ml-trans"></div>` + deckShell('B', B, iB) : '<p class="muted center">Füge einen zweiten Track hinzu, um den Übergang zu gestalten.</p>');
    ML.views = {};
    ML.views.A = new WaveView($('.ml-deck[data-role="A"] .ml-wave'), B ? 'A' : 'single'); ML.views.A.ts = A;
    if (B) { ML.views.B = new WaveView($('.ml-deck[data-role="B"] .ml-wave'), 'B'); ML.views.B.ts = B; }
    ML.score = score;
    requestAnimationFrame(() => {
      if (B && ML.sync) zoomTransition(); else { ML.views.A.fit(); ML.views.B?.fit(); }
    });
    renderPads(); renderTransPanel();
    loadBuffer(A).catch(() => {}); if (B) loadBuffer(B).catch(() => {});
    $$('#ml-timeline .ml-card').forEach((c) => c.classList.toggle('sel', +c.dataset.i === iA || +c.dataset.i === iB));
    $$('#ml-timeline .ml-chip').forEach((c) => c.classList.toggle('sel', +c.dataset.pair === iA));
  }
  function zoomTransition() {
    const A = ML.views.A, B = ML.views.B; if (!A?.ts) return;
    if (!B?.ts) return A.fit();
    const tr = ML.trans[pairKey(A.ts.uid, B.ts.uid)];
    const span = ((tr?.bars || 16) + (tr?.lead || 8) + 8) * bar(A.ts);
    A.spp = span / A.W; A.start = A.ts.edit.mixOut - (tr?.lead || 8) * bar(A.ts) - 2 * bar(A.ts); A.clamp?.();
    syncFrom(A);
  }

  function renderPads() {
    for (const role of ['A', 'B']) {
      const v = ML.views[role]; if (!v?.ts) continue;
      const root = $(`.ml-deck[data-role="${role}"]`), e = v.ts.edit;
      $('.pads[data-kind="cue"]', root).innerHTML = '<span class="pl">CUES</span>' + e.cues.map((c, i) => `<button class="pad ${c ? 'on' : ''}" data-i="${i}" style="${c ? `--pc:${c.color}` : ''}" title="${c ? `Takt ${barNo(v.ts, c.sec)} · Klick = abspielen · Doppelklick = umbenennen · Rechtsklick = löschen` : 'Leer · Klick = Cue an Abspielposition / Ansichtsmitte setzen'}"><b>${i + 1}</b> ${c ? esc(c.label) : ''}</button>`).join('');
      $('.pads[data-kind="loop"]', root).innerHTML = '<span class="pl">LOOPS</span>' + e.loops.map((l, i) => `<button class="pad loop ${l ? 'on' : ''}" data-i="${i}" style="${l ? `--pc:${l.color}` : ''}" title="${l ? `T${barNo(v.ts, l.start)} · ${fmtBeats((l.end - l.start) / beat(v.ts))} · Klick = Loop abspielen` : 'Leer · Klick = Loop an Abspielposition setzen'}"><b>${i + 1}</b> ${l ? esc(l.label) + ' <small>' + fmtBeats((l.end - l.start) / beat(v.ts)) + '</small>' : ''}</button>`).join('');
      $('[data-v="in"]', root).textContent = `T${barNo(v.ts, e.mixIn)}`;
      $('[data-v="out"]', root).textContent = `T${barNo(v.ts, e.mixOut)}`;
      $('[data-v="secs"]', root).textContent = `${fmt(e.mixIn)} → ${fmt(e.mixOut)} · ${e.dirty ? '● geändert (lokal gespeichert)' : 'synchron mit Engine'}`;
    }
  }
  const fmtBeats = (b) => { const r = Math.round(b * 100) / 100; return r >= 4 && r % 4 === 0 ? `${r / 4} T` : r >= 1 ? `${r} B` : `1/${Math.round(1 / r)} B`; };

  function renderTransPanel() {
    const el = $('#ml-trans'); if (!el) return;
    const A = ML.views.A.ts, B = ML.views.B.ts, k = pairKey(A.uid, B.uid), tr = ML.trans[k], sc = ML.score;
    const rec = recommend(A, B, sc), rate = rateFor(A, B), pitch = (rate - 1) * 100;
    el.innerHTML = `<div class="ml-trans-l">
        <div class="big ${scoreCls(sc.score)}">${sc.score}</div>
        <div class="muted small">Key ${Math.round(sc.key * 100)} · BPM ${Math.round(sc.bpm * 100)} · Energie ${Math.round(sc.energy * 100)}</div>
        <div class="small">Pitch B <b>${pitch >= 0 ? '+' : ''}${pitch.toFixed(2)}%</b>${Math.abs(rate - A.t.bpm / B.t.bpm) > 0.01 ? ' (Halb-/Doppeltempo)' : ''}</div>
        ${sc.notes.length ? `<div class="small s-mid">${esc(sc.notes.join(' · '))}</div>` : ''}
      </div>
      <div class="ml-trans-m">
        <div class="desc"><b>${esc(trLabel(tr))}</b> · Mischart und Effekte stellst du im Tab „Übergang“ ein.</div>
        <div class="row-s">
          <label>Länge <select data-tr="bars">${BAR_OPTS.map((b) => `<option ${b === tr.bars ? 'selected' : ''} value="${b}">${b} Takt${b > 1 ? 'e' : ''}</option>`).join('')}</select></label>
          <label>Vorlauf <select data-tr="lead">${[2, 4, 8, 16].map((b) => `<option ${b === (tr.lead || 8) ? 'selected' : ''} value="${b}">${b} Takte</option>`).join('')}</select></label>
          <label>A-Loop halten <select data-tr="holdLoop"><option value="-1">nein</option>${A.edit.loops.map((l, i) => l ? `<option value="${i}" ${tr.holdLoop === i ? 'selected' : ''}>${i + 1} ${esc(l.label)}</option>` : '').join('')}</select></label>
          <span class="muted small">A: T${barNo(A, A.edit.mixOut)} → T${barNo(A, A.edit.mixOut + tr.bars * bar(A))} · B startet bei T${barNo(B, B.edit.mixIn)}</span>
        </div>
      </div>
      <div class="ml-trans-r">
        <button id="ml-play" class="primary big">▶ Übergang vorhören</button>
        <button id="ml-stop" class="ghost">■ Stopp</button>
        <button id="ml-autotrans" title="Mix-Punkte, Typ und Länge aus Cues und Loops ableiten">✦ Auto-Übergang</button>
      </div>`;
  }

  $('#ml-editor').addEventListener('input', (ev) => {
    const role = ev.target.closest('.ml-deck')?.dataset.role, tv = role && ML.views[role];
    if (tv && ev.target.matches('[data-curve]')) { tv.ts.curveMode = ev.target.value || null; if (tv.ts.curveMode) { tv.ts.fxBrush = null; ev.target.closest('.ml-level').querySelector('[data-brush]').value = ''; } tv.draw(); return; }
    if (tv && ev.target.matches('[data-brush]')) { tv.ts.fxBrush = ev.target.value || null; if (tv.ts.fxBrush) { tv.ts.curveMode = null; ev.target.closest('.ml-level').querySelector('[data-curve]').value = ''; toast('In der Waveform ziehen, um „' + FX_TYPES[tv.ts.fxBrush][0] + '“ zu setzen. Rechtsklick auf den Balken löscht.'); } tv.draw(); return; }
    const f = ev.target.dataset.lv; if (!f) return;
    const v = ML.views[ev.target.closest('.ml-deck').dataset.role], e = v.ts.edit;
    e[f] = f === 'keyLock' ? ev.target.checked : +ev.target.value;
    if (f === 'gainDb') ev.target.parentElement.querySelector('[data-lvv]').textContent = `${e.gainDb} dB`;
    changed(v.ts);
  });
  // Editor-Events (Delegation)
  $('#ml-editor').addEventListener('click', async (ev) => {
    const deck = ev.target.closest('.ml-deck'), role = deck?.dataset.role, v = role && ML.views[role];
    if (ev.target.closest('#ml-autotrans')) return autoTransition(ML.views.A.ts, ML.views.B.ts);
    const d = ev.target.closest('[data-d]')?.dataset.d;
    if (ev.target.closest('#ml-play')) { const A = ML.views.A.ts, B = ML.views.B.ts; return playTransition(A, B, ML.trans[pairKey(A.uid, B.uid)]); }
    if (ev.target.closest('#ml-stop')) { stopPreview(); soloStop(); return; }
    const tb = ev.target.closest('[data-type]');
    if (tb) {
      const A = ML.views.A.ts, B = ML.views.B.ts, k = pairKey(A.uid, B.uid);
      ML.trans[k] = { ...ML.trans[k], type: tb.dataset.type, bars: TYPES[tb.dataset.type].bars, auto: false }; saveTrans();
      renderTransPanel(); redrawAll(); renderTimelineChips(); return;
    }
    if (v && d) {
      const ts = v.ts;
      if (d === 'play') return soloPlay(ts, role === 'B' ? ts.edit.mixIn : Math.max(0, ts.edit.mixOut - 8 * bar(ts)));
      if (d === 'stop') { soloStop(); stopPreview(); return; }
      if (d === 'zin') return v.zoomBy(0.6);
      if (d === 'zout') return v.zoomBy(1.6);
      if (d === 'fit') { v.fit(); if (ML.sync && v.role !== 'single') syncFrom(v); return; }
      if (d === 'zmix') return zoomTransition();
      if (d === 'auto') {
        const has = ts.edit.cues.some(Boolean) || ts.edit.loops.some(Boolean);
        const mode = !has ? 'all' : confirm('Es gibt bereits Cues/Loops.\n\nOK = alle 8 Cues + 8 Loops durch Auto-Erkennung ersetzen\nAbbrechen = nur freie Slots auffüllen') ? 'all' : 'fill';
        await applyAuto(ts, mode); toast(`✦ Auto-Cues & Loops gesetzt (${mode === 'all' ? 'ersetzt' : 'freie Slots'}) · Mix-In/Out neu berechnet`); return;
      }
      if (d === 'engine') {
        const pad8 = (a) => Array.from({ length: 8 }, (_, i) => a?.[i] || null);
        ts.edit.cues = pad8(ts.perf.engineCues); ts.edit.loops = pad8(ts.perf.engineLoops); changed(ts); ts.edit.dirty = false;
        api('/api/edits', { uid: ts.uid, edit: ts.edit }); renderPads(); return;
      }
      if (d === 'write') return writeEngine([ts.uid]);
    }
    const nb = ev.target.dataset.n;
    if (v && nb) {
      const ts = v.ts, step = (ML.snap > 0 ? ML.snap : 1) * beat(ts) * (nb.endsWith('-') ? -1 : 1);
      if (nb.startsWith('in')) ts.edit.mixIn = snapSec(ts, ts.edit.mixIn + step); else ts.edit.mixOut = snapSec(ts, ts.edit.mixOut + step);
      changed(ts); if (ML.sync) syncFrom(v); return;
    }
    const pad = ev.target.closest('.pad');
    if (v && pad) {
      const ts = v.ts, i = +pad.dataset.i, kind = pad.parentElement.dataset.kind;
      const here = snapSec(ts, v.playPos() ?? v.sec(v.W / 2));
      if (kind === 'cue') {
        const c = ts.edit.cues[i];
        if (c) soloPlay(ts, c.sec); else { ts.edit.cues[i] = { label: `Cue ${i + 1}`, sec: here, color: COLORS[i] }; changed(ts); }
      } else {
        const l = ts.edit.loops[i];
        if (l) soloPlay(ts, l.start, l); else { ts.edit.loops[i] = { label: `Loop ${i + 1}`, start: here, end: here + ML.loopLen * beat(ts), color: COLORS[i] }; changed(ts); }
      }
    }
  });
  $('#ml-editor').addEventListener('dblclick', async (ev) => {
    const pad = ev.target.closest('.pad.on'); if (!pad) return;
    const v = ML.views[pad.closest('.ml-deck').dataset.role], i = +pad.dataset.i, kind = pad.parentElement.dataset.kind;
    const item = kind === 'cue' ? v.ts.edit.cues[i] : v.ts.edit.loops[i];
    const name = await askText('Name:', item.label); if (name == null) return;
    item.label = name.slice(0, 40); soloStop(); changed(v.ts);
  });
  $('#ml-editor').addEventListener('contextmenu', (ev) => {
    const pad = ev.target.closest('.pad.on'); if (!pad) return; ev.preventDefault();
    const v = ML.views[pad.closest('.ml-deck').dataset.role], i = +pad.dataset.i;
    if (pad.parentElement.dataset.kind === 'cue') v.ts.edit.cues[i] = null; else v.ts.edit.loops[i] = null;
    changed(v.ts);
  });
  $('#ml-editor').addEventListener('change', (ev) => {
    const f = ev.target.dataset.tr; if (!f) return;
    const A = ML.views.A.ts, B = ML.views.B.ts, k = pairKey(A.uid, B.uid);
    ML.trans[k] = { ...ML.trans[k], [f]: +ev.target.value }; saveTrans();
    renderTransPanel(); redrawAll(); renderTimelineChips();
  });

  async function writeEngine(uids) {
    const dirty = uids.filter((u) => ML.ts.get(u)?.edit && !u.includes('#')); // zweite Vorkommen nicht doppelt schreiben
    if (!dirty.length) return toast('Keine Änderungen zum Schreiben');
    // ungespeicherte Änderungen sofort sichern
    await Promise.all(dirty.map((u) => api('/api/edits', { uid: u, edit: ML.ts.get(u).edit })));
    if (!confirm(`Cues & Loops von ${dirty.length} Track(s) in die Engine-DJ-Datenbank schreiben?\n\n• Engine DJ muss geschlossen sein\n• Vorher wird automatisch ein Backup von m.db angelegt\n• Bestehende Hot Cues & Loops dieser Tracks werden überschrieben`)) return;
    try {
      const r = await api('/api/engine/cues', { uids: dirty });
      for (const u of dirty) ML.ts.get(u).edit.dirty = false;
      for (const u of dirty) { const ts = ML.ts.get(u); ts.perf.engineCues = ts.edit.cues.slice(); ts.perf.engineLoops = ts.edit.loops.slice(); }
      renderPads(); renderCuePads(); renderTimeline();
      toast(`✓ ${r.results.reduce((s, x) => s + x.written, 0)} Track(s) in Engine geschrieben.<br>Backup: <code>${esc(r.results[0]?.backup.split('/').pop() || '')}</code>`, 8000);
    } catch (e) { toast('⚠ ' + e.message, 7000); }
  }

  // Übergang aus Cues & Loops: B-Drop landet am Ende des Blends, kurzes A-Outro wird per Loop gehalten
  // ================= Übergangspunkte: Anker aus Cues, Loops und Abschnitten =================
  /** Alle sinnvollen Stellen eines Tracks, sortiert. Cue, Loop und Abschnitt an derselben Stelle (±0,25 s) werden zusammengefasst. */
  function anchorsOf(ts) {
    const e = ts.edit, a = ts.perf.auto, items = [];
    e.cues.forEach((c, i) => c && items.push({ kind: 'cue', i, label: c.label || 'Cue ' + (i + 1), sec: c.sec }));
    e.loops.forEach((l, i) => l && items.push({ kind: 'loop', i, label: l.label || 'Loop ' + (i + 1), sec: l.start, end: l.end }));
    for (const s of a?.sections || []) items.push({ kind: 'section', label: s.full ? 'Drop-Teil' : 'Break-Teil', sec: s.start, full: s.full, bars: s.endBar - s.startBar });
    items.sort((x, y) => x.sec - y.sec);
    const groups = [];
    for (const it of items) { const g = groups[groups.length - 1]; if (g && Math.abs(g.sec0 - it.sec) < 0.25) g.items.push(it); else groups.push({ sec0: it.sec, items: [it] }); }
    return groups.map((g) => {
      const cue = g.items.find((x) => x.kind === 'cue'), loop = g.items.find((x) => x.kind === 'loop'), sec = g.items.find((x) => x.kind === 'section'), rep = cue || loop || sec;
      return { sec: rep.sec, label: rep.label, hasCue: !!cue, loop: loop ? loop.i : null, loopBars: loop ? Math.round((loop.end - loop.sec) / bar(ts)) : 0, section: sec || null };
    });
  }
  const anchorText = (ts, x) => x.label + ' · Takt ' + barNo(ts, x.sec) + ' · ' + fmt(x.sec) + (x.loop != null ? ' · ⟲ ' + x.loopBars + ' T' : '') + (x.section && (x.hasCue || x.loop != null) ? ' · ' + (x.section.full ? 'Drop-Teil' : 'Break-Teil') : '');

  /** Vorschläge für Übergänge mitten im Song, beste zuerst: A steigt an einem Anker aus, B so ein, dass sein Drop am Blend-Ende landet */
  function midCandidates(A, B) {
    if (!A.perf.grid?.beatSec || !B.perf.grid?.beatSec) return [];
    const aBar = bar(A), bBar = bar(B), snapA = (s) => snapSec(A, s, 4), snapB = (s) => snapSec(B, s, 4);
    const aa = anchorsOf(A), bb = anchorsOf(B);
    let drops = bb.filter((x) => (x.section && x.section.full) || /^\s*drop/i.test(x.label)).map((x) => ({ at: snapB(x.sec), label: x.label })) // „Pre-Drop“ zählt nicht.filter((x) => x.at > fb(B) + 3 * bBar && x.at + 8 * bBar <= B.dur);
    if (!drops.length) drops = [{ at: snapB(B.edit.mixIn) + 16 * bBar, label: 'Einsatz' }];
    const perLeave = new Map();
    for (const a of aa) {
      const frac = a.sec / A.dur;
      if (frac < 0.18 || frac > 0.85 || a.sec < A.edit.mixIn + 16 * aBar) continue;
      const leave = Math.max(A.edit.mixIn + 8 * aBar, snapA(a.sec)), brk = a.section && !a.section.full;
      let sa = 1 - Math.min(1, Math.abs(frac - 0.5) / 0.35); // eher Songmitte
      if (brk) sa += 3; else if (a.hasCue) sa += 2; else if (a.loop != null) sa += 1; // Beginn eines Breaks: A wird dünner, B baut auf
      if (/break|outro|mix out/i.test(a.label)) sa += 1;
      const room = Math.floor((A.dur - leave) / aBar);
      // Ein Loop ab 2 Takten an dieser Stelle kann A im Blend halten; kürzere (Rolls, 1 Takt) wären monoton
      const hold = a.loop != null && a.loopBars >= 2 && Math.abs(A.edit.loops[a.loop].start - leave) < 0.3 ? a.loop : -1;
      if (hold >= 0) sa += 2;
      for (const d of drops) for (const D of [32, 16, 8]) {
        if (hold < 0 && D > room) continue;
        const enter = d.at - D * bBar; if (enter < fb(B) - 0.01 || enter > B.dur - 40 * bBar) continue; // B soll nach dem Einstieg noch ausreichend laufen
        let sb = 2 + (enter > fb(B) + 8 * bBar ? 1 : 0) + (D === 16 ? 0.5 : 0) - (enter / B.dur > 0.6 ? 1 : 0); // B steigt mitten im Song ein: Bonus, zu spät: Abzug
        if (brk && D <= a.section.bars && D >= a.section.bars / 2) sb += 1;      // Blend füllt den Break
        const c = { score: sa + sb, leave, enter: Math.max(0, snapB(enter)), bars: D, hold, aLabel: a.label, aBar: barNo(A, leave), bBar: barNo(B, enter), dropBar: barNo(B, d.at) };
        const list = perLeave.get(leave) || []; list.push(c); perLeave.set(leave, list);
      }
    }
    const out = [];
    for (const list of perLeave.values()) {
      const kept = [];
      for (const c of list.sort((x, y) => y.score - x.score)) {
        // fast gleiche Einstiege (Cue und Abschnitt eine Zeile auseinander) nur einmal
        if (kept.some((k) => k.bars === c.bars && Math.abs(k.enter - c.enter) < 2 * bBar)) continue;
        kept.push(c); if (kept.length === 2) break;
      }
      out.push(...kept);
    }
    return out.sort((x, y) => y.score - x.score).slice(0, 12);
  }
  /** Steigt ein Track weit hinten ein, darf sein eigenes Mix-Out nicht davor liegen (sonst beginnt sein Ausstieg sofort) */
  function keepOutAfterIn(ts) {
    const b = bar(ts), min = ts.edit.mixIn + 24 * b;
    if (ts.edit.mixOut >= min) return;
    const auto = ts.perf.auto?.mixOut, want = auto != null && auto >= min ? auto : ts.dur - 32 * b;
    ts.edit.mixOut = Math.min(ts.dur - 2 * b, snapSec(ts, Math.max(min, want), 4));
  }
  function applyMid(A, B, c) {
    const k = pairKey(A.uid, B.uid), tr = normTr(ML.trans[k] || getTrans(A, B, ML.score));
    A.edit.mixOut = c.leave; B.edit.mixIn = c.enter; keepOutAfterIn(B);
    tr.bars = c.bars; tr.holdLoop = c.hold; tr.auto = false;
    if (tr.style && tr.style !== 'breakIn') tr.fx = []; // Effekte eines anderen Stils nicht mitnehmen
    const rec = recommend(A, B, ML.score);
    if (!['bands', 'stems', 'longBlend', 'bassSwap'].includes(tr.type)) tr.type = ['longBlend', 'bassSwap', 'bands'].includes(rec) ? rec : 'bassSwap';
    saveTrans(); changed(A); changed(B);
  }
  /** Nächsten Vorschlag für einen Übergang mitten im Song anwenden (jeder Aufruf schaltet weiter) */
  async function autoMid(A, B) {
    await ensureAnchors(A, B);
    const list = midCandidates(A, B);
    if (!list.length) { toast('Keine passenden Punkte mitten im Song gefunden. Setze im Tab „Track & Cues“ Cues oder nutze „✦ Auto Ende“.', 7000); return false; }
    const k = pairKey(A.uid, B.uid), tr = normTr(ML.trans[k] || getTrans(A, B, ML.score));
    tr.midIdx = ((tr.midIdx ?? -1) + 1) % list.length;
    const c = list[tr.midIdx]; applyMid(A, B, c);
    toast(`✦ Vorschlag ${tr.midIdx + 1}/${list.length}: A verlässt „${esc(c.aLabel)}“ (Takt ${c.aBar}), B steigt bei Takt ${c.bBar} ein, Drop nach ${c.bars} Takten${c.hold >= 0 ? ' · A hält Loop ' + (c.hold + 1) : ''}`, 7000);
    return { i: tr.midIdx, n: list.length };
  }
  function transInfo(A, B, tr) {
    const pctA = Math.round((A.edit.mixOut / A.dur) * 100), pctB = Math.round((B.edit.mixIn / B.dur) * 100);
    const drop = (B.perf.auto?.sections || []).find((s) => s.full && s.start > B.edit.mixIn + 0.5 * bar(B));
    let t = `A steigt bei ${pctA} % aus, B bei ${pctB} % ein`;
    if (drop) { const n = Math.round((drop.start - B.edit.mixIn) / bar(B)); t += ' · B-Drop ' + (n === tr.bars ? 'landet am Blend-Ende ✓' : `nach ${n} Takten (Blend ${tr.bars})`); }
    return t;
  }
  function showTransition() {
    const c = TL.clips[ML.pair]; if (!c?.T) return;
    const W = $('#tl-canvas').clientWidth;
    if (TL.secX(c.T) < 0 || TL.secX(c.T + c.D) > W) TL.x0 = Math.max(0, c.T - (W * 0.2) / TL.px);
    TL.draw();
  }

  // ================= Drop-Stile: benannte Übergänge mitten im Song =================
  const DROP_STYLES = [
    ['breakIn', 'Break → Drop', 'A geht in den Break, B baut auf und droppt genau am Ende des Blends'],
    ['dropIn', 'Drop-In', 'Harter Wechsel: B droppt genau dort, wo der nächste Drop von A käme'],
    ['doubleDrop', 'Double Drop', 'B droppt voll, während A noch im Drop läuft; in der Mitte wechselt der Bass von A zu B'],
    ['echoDrop', 'Echo → Drop', 'A hallt im Echo aus, B droppt auf der Eins'],
    ['rollDrop', 'Roll → Drop', 'A rollt mit kürzer werdenden Loops, dann droppt B'],
    ['spinDrop', 'Spinback → Drop', 'A dreht rückwärts weg, dann droppt B'],
    ['filterDrop', 'Filter → Drop', 'A wird per Hochpass ausgedünnt, dann droppt B'],
  ];
  const STYLE_DEF = {
    dropIn: { type: 'cut', fx: [], bars: 1 }, doubleDrop: { type: 'bands', bands: { low: 'swap', mid: 'full', high: 'full' }, fx: [] }, // beide voll, nur der Bass wechselt in der Mitte
    echoDrop: { type: 'cut', fx: ['echoOut'], bars: 4 }, rollDrop: { type: 'cut', fx: ['loopRoll'], bars: 4 },
    spinDrop: { type: 'cut', fx: ['spinback'], bars: 2 }, filterDrop: { type: 'cut', fx: ['filterSweep'], bars: 8 },
  };
  /** Drops von B: Beginn eines vollen Teils oder Cue „Drop …“ („Pre-Drop“ zählt nicht), auf den Takt gerundet */
  function dropTargets(B) {
    const bBar = bar(B);
    return anchorsOf(B).filter((x) => (x.section && x.section.full) || /^\s*drop/i.test(x.label))
      .map((x) => ({ at: snapSec(B, x.sec, 4), label: x.label })).filter((x) => x.at > fb(B) + 3 * bBar && x.at <= B.dur - 40 * bBar);
  }
  /** Kandidaten für die Stile mit Drop-Einstieg: B startet genau an seinem Drop, A steigt an einer passenden Stelle aus */
  function styleCandidates(style, A, B) {
    const def = STYLE_DEF[style];
    if (!def || !A.perf.grid?.beatSec || !B.perf.grid?.beatSec) return [];
    const aBar = bar(A), bBar = bar(B), snapA = (s) => snapSec(A, s, 4), drops = dropTargets(B);
    if (!drops.length) return [];
    const lefts = [];
    if (style === 'doubleDrop') {
      // A ist noch im Drop: ab Beginn des vollen Teils, dann alle 8 Takte; A muss während der Überlappung im Drop bleiben
      for (const s of A.perf.auto?.sections || []) {
        if (!s.full) continue;
        for (const k of [0, 8, 16]) for (const D of [16, 8]) {
          const at = snapA(s.start + k * aBar);
          if (at + D * aBar <= s.end + aBar && at / A.dur >= 0.15 && at / A.dur <= 0.85 && at >= A.edit.mixIn + 16 * aBar) lefts.push({ at, label: 'Drop-Teil +' + k + ' Takte', bars: D, sa: 3 + (k > 0 ? 1 : 0) });
        }
      }
    } else {
      for (const a of anchorsOf(A)) {
        const frac = a.sec / A.dur, at = snapA(a.sec);
        if (frac < 0.15 || frac > 0.85 || at < A.edit.mixIn + 20 * aBar) continue;
        const full = a.section && a.section.full; // Beginn von A's Drop-Teil = Ende des Breaks: B's Drop ersetzt A's Drop
        let sa = full ? 4 : /^\s*drop/i.test(a.label) ? 3 : a.hasCue ? 1.5 : 1;
        if ((barNo(A, at) - 1) % 8 === 0) sa += 1; // Phrasengrenze
        lefts.push({ at, label: a.label, bars: def.bars, sa });
      }
    }
    const best = new Map();
    for (const l of lefts) for (const d of drops) {
      const frac = l.at / A.dur;
      let s = l.sa + 1 - Math.min(1, Math.abs(frac - 0.5) / 0.35) + 2 + (d.at > fb(B) + 8 * bBar ? 1 : 0) - (d.at / B.dur > 0.6 ? 1 : 0);
      const c = { score: s, leave: l.at, enter: d.at, bars: l.bars, aLabel: l.label, aBar: barNo(A, l.at), bBar: barNo(B, d.at), dropLabel: d.label };
      const key = c.leave.toFixed(1) + '|' + c.enter.toFixed(1);
      if (!best.has(key) || best.get(key).score < c.score) best.set(key, c);
    }
    const perLeave = new Map();
    for (const c of [...best.values()].sort((x, y) => y.score - x.score)) {
      const list = perLeave.get(c.leave.toFixed(1)) || []; if (list.length < 2) { list.push(c); perLeave.set(c.leave.toFixed(1), list); }
    }
    return [...perLeave.values()].flat().sort((x, y) => y.score - x.score).slice(0, 10);
  }
  function applyStyle(style, A, B, c) {
    const k = pairKey(A.uid, B.uid), tr = normTr(ML.trans[k] || getTrans(A, B, ML.score)), def = STYLE_DEF[style];
    A.edit.mixOut = c.leave; B.edit.mixIn = c.enter; keepOutAfterIn(B);
    tr.type = def.type; tr.fx = [...def.fx]; tr.bars = c.bars; tr.holdLoop = -1; tr.auto = false;
    if (def.bands) tr.bands = { ...def.bands };
    saveTrans(); changed(A); changed(B);
  }
  /** Stil anwenden; jeder weitere Klick auf denselben Stil zeigt die nächste passende Stelle */
  async function autoStyle(style, A, B) {
    const def = DROP_STYLES.find((s) => s[0] === style), k = pairKey(A.uid, B.uid);
    let tr = normTr(ML.trans[k] || getTrans(A, B, ML.score)), n = 0, i = 0;
    if (style === 'breakIn') {
      const r = await autoMid(A, B); if (!r) return false;
      tr = ML.trans[k]; i = r.i; n = r.n;
    } else {
      await ensureAnchors(A, B);
      const list = styleCandidates(style, A, B);
      if (!list.length) { toast('Für „' + def[1] + '“ fehlen Drops in B oder Aussteigepunkte in A. Setze Cues im Tab „Track & Cues“ oder nutze „✦ Auto“ dort.', 7000); return false; }
      tr.styleIdx ||= {}; i = ((tr.styleIdx[style] ?? -1) + 1) % list.length; tr.styleIdx[style] = i; n = list.length;
      const c = list[i]; applyStyle(style, A, B, c);
      toast(`✦ ${def[1]} ${i + 1}/${n}: A verlässt „${esc(c.aLabel)}“ (Takt ${c.aBar}), B droppt bei Takt ${c.bBar}`, 7000);
    }
    tr = ML.trans[k]; tr.style = style; tr.styleN = (i + 1) + '/' + n; saveTrans();
    return true;
  }
  /** Hat ein Track kaum Anker (unter 4 Cues, keine Loops), freie Plätze automatisch füllen; eigene Mix-Punkte bleiben */
  async function ensureAnchors(A, B) {
    for (const ts of [A, B]) {
      if (ts.edit.cues.filter(Boolean).length >= 4 || ts.edit.loops.some(Boolean)) continue;
      const mi = ts.edit.mixIn, mo = ts.edit.mixOut; await applyAuto(ts, 'fill'); ts.edit.mixIn = mi; ts.edit.mixOut = mo;
    }
  }

  async function autoTransition(A, B) {
    for (const ts of [A, B]) if (!ts.edit.cues.some((c) => c && /drop|outro|mix out/i.test(c.label))) await applyAuto(ts, 'fill');
    const cue = (ts, re) => ts.edit.cues.find((c) => c && re.test(c.label));
    const out = cue(A, /mix out/i) || cue(A, /outro/i);
    if (out) A.edit.mixOut = out.sec;
    const drop = cue(B, /^drop/i)?.sec ?? B.perf.auto?.sections?.find((s) => s.full)?.start ?? B.edit.mixIn;
    const toDrop = Math.floor((drop - fb(B)) / bar(B) + 0.01);
    const availA = Math.floor((A.dur - A.edit.mixOut) / bar(A));
    const k = pairKey(A.uid, B.uid);
    const fit = [32, 16, 8, 4].find((c) => c <= toDrop);
    let type = recommend(A, B, ML.score), bars = TYPES[type].bars, holdLoop = -1;
    if (!fit) {
      // kein Intro zum Blenden: B droppt direkt am Mix-Out
      const roll = A.edit.loops.some((l) => l && /roll/i.test(l.label));
      if (!['echoOut', 'spinback', 'loopRoll', 'cut'].includes(type)) type = roll ? 'loopRoll' : 'echoOut';
      bars = TYPES[type].bars; B.edit.mixIn = drop;
    } else if (['bands', 'longBlend', 'bassSwap', 'filterSweep'].includes(type)) {
      bars = fit;
      if (bars > availA) {
        const i = A.edit.loops.findIndex((l) => l && l.start >= A.edit.mixOut - 0.1 && l.end <= A.dur);
        if (i >= 0) { holdLoop = i; A.edit.mixOut = A.edit.loops[i].start; }
        else bars = [32, 16, 8, 4].find((c) => c <= availA && c <= toDrop) || 4;
      }
      B.edit.mixIn = drop - bars * bar(B);
    } else B.edit.mixIn = drop;
    ML.trans[k] = normTr({ ...ML.trans[k], type, bars, holdLoop, auto: false, style: null, styleN: null, norm: false }); saveTrans();
    changed(A); changed(B); zoomTransition();
    toast(`✦ ${TYPES[type].name}, ${bars} Takte${holdLoop >= 0 ? ' · A hält Loop ' + (holdLoop + 1) : ''}`);
  }

  function openPair(i) {
    ML.pair = Math.max(0, Math.min(i, S.set.length - 2));
    if (!$('#view-mixlab').classList.contains('active')) show('mixlab'); else { TL.draw(); renderBottom(); }
  }

  // Eingabedialog (window.prompt gibt es in Electron nicht)
  function askText(label, value) {
    return new Promise((resolve) => {
      const m = document.createElement('div'); m.className = 'modal';
      m.innerHTML = `<div class="card" style="width:360px"><label>${esc(label)}<input id="ask-v" value="${esc(value)}"></label><div class="bar"><button class="primary" id="ask-ok">OK</button><button class="ghost" id="ask-no">Abbrechen</button></div></div>`;
      document.body.appendChild(m);
      const i = $('#ask-v', m); i.focus(); i.select();
      const done = (v) => { m.remove(); resolve(v); };
      $('#ask-ok', m).onclick = () => done(i.value);
      $('#ask-no', m).onclick = () => done(null);
      i.onkeydown = (e) => { if (e.key === 'Enter') done(i.value); if (e.key === 'Escape') done(null); };
    });
  }

  // ================= Toolbar =================
  $('#ml-snap').onchange = (e) => (ML.snap = +e.target.value);
  $('#ml-looplen').onchange = (e) => (ML.loopLen = +e.target.value);
  $('#ml-sync').onchange = (e) => { ML.sync = e.target.checked; if (ML.sync) zoomTransition(); };
  $('#ml-autoall').onclick = async () => {
    for (const u of S.set) { const ts = await getTS(u); await applyAuto(ts, ts.edit.cues.some(Boolean) || ts.edit.loops.some(Boolean) ? 'fill' : 'all'); }
    toast(`✦ Cues & Loops für ${S.set.length} Tracks gesetzt (vorhandene Slots bleiben). Mit „Cues → Engine“ übernehmen.`, 6000);
    renderTimeline();
  };
  $('#ml-cues-engine').onclick = async () => { for (const u of S.set) await getTS(u); writeEngine(S.set.filter((u) => ML.ts.get(u)?.edit.dirty)); };
  $('#ml-pl-engine').onclick = () => { $('#set-title').value = $('#ml-title').value; $('#set-engine').click(); };
  $('#ml-m3u').onclick = () => { $('#set-title').value = $('#ml-title').value; $('#set-m3u').click(); };
  $('#ml-playset').onclick = async () => {
    if (ML.playingSet) { ML.playingSet = false; stopPreview(); $('#ml-playset').textContent = '▶ Set durchhören'; return; }
    if (S.set.length < 2) return toast('Mindestens zwei Tracks nötig');
    ML.playingSet = true; $('#ml-playset').textContent = '■ Set stoppen';
    for (let i = ML.pair; i < S.set.length - 1 && ML.playingSet; i++) {
      ML.pair = i; await renderEditor();
      const A = ML.views.A.ts, B = ML.views.B.ts;
      const pv = await playTransition(A, B, ML.trans[pairKey(A.uid, B.uid)], { lead: 4, tail: 4 });
      toast(`▶ Übergang ${i + 1} → ${i + 2}: ${TYPES[ML.trans[pairKey(A.uid, B.uid)].type].name}`, 3000);
      await pv.done;
      if (pv.stopped) break;
    }
    ML.playingSet = false; $('#ml-playset').textContent = '▶ Set durchhören';
  };

  // Gespeicherte Sets
  async function refreshSets() {
    const sets = await api('/api/sets');
    $('#ml-load').innerHTML = '<option value="">Gespeicherte Sets …</option>' + sets.map((s) => `<option value="${s.id}" ${s.id === ML.setId ? 'selected' : ''}>${esc(s.title)} (${s.tracks.length})</option>`).join('');
    return sets;
  }
  $('#ml-save').onclick = async () => {
    const trans = {}; for (let i = 0; i < S.set.length - 1; i++) { const k = pairKey(S.set[i], S.set[i + 1]); if (ML.trans[k]) trans[k] = ML.trans[k]; }
    const s = await api('/api/sets', { id: ML.setId, title: $('#ml-title').value, tracks: S.set, transitions: trans, tempo: ML.tempo, samples: ML.samples, master: ML.master });
    ML.setId = s.id; localStorage.setItem('djflow.setId', s.id); localStorage.setItem('djflow.setTitle', s.title);
    await refreshSets(); toast('💾 Set gespeichert');
  };
  $('#ml-load').onchange = async (e) => {
    const sets = await api('/api/sets'); const s = sets.find((x) => x.id === e.target.value); if (!s) return;
    S.set = s.tracks.slice(); registerAliases(); saveSet(); ML.tempo = s.tempo || []; saveTempo(); ML.samples = s.samples || []; saveSamples(); ML.master = s.master || null; saveMaster(); Object.assign(ML.trans, s.transitions || {}); saveTrans();
    ML.setId = s.id; $('#ml-title').value = s.title; localStorage.setItem('djflow.setId', s.id); localStorage.setItem('djflow.setTitle', s.title);
    ML.pair = 0; render();
  };
  $('#ml-new').onclick = () => {
    if (S.set.length && !confirm('Neues leeres Set beginnen? (Das aktuelle bleibt erhalten, wenn es gespeichert ist.)')) return;
    S.set = []; saveSet(); ML.tempo = []; saveTempo(); ML.samples = []; saveSamples(); ML.master = null; saveMaster(); ML.setId = null; localStorage.removeItem('djflow.setId'); $('#ml-title').value = 'Neues Set'; refreshSets(); render();
  };
  $('#ml-title').value = localStorage.getItem('djflow.setTitle') || 'Mein Set';
  $('#ml-title').onchange = () => localStorage.setItem('djflow.setTitle', $('#ml-title').value);
  refreshSets().catch(() => {});

  document.addEventListener('keydown', (e) => {
    if (!$('#view-mixlab').classList.contains('active') || e.target.matches('input,select,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); if (TL.playing || solo.src) { stopPreview(); soloStop(); } else TL.play(); }
  }, true);

  // ================= Tempo-Spur: Punkte in Takten; W rechnet Set-Zeit (bei Master-BPM) in echte Zeit um =================
  ML.tempo = JSON.parse(localStorage.getItem('djflow.tempo') || '[]');
  ML.master = Number(localStorage.getItem('djflow.master')) || null; // Master-BPM des Sets (leer = Tempo von Track 1)
  const saveMaster = () => { localStorage.setItem('djflow.master', ML.master ?? ''); H.soon(); };
  // Sample-Spur: Ausschnitte aus beliebigen Tracks oder deren Stems. start = Set-Zeit (bei Master-BPM), in/len = Sekunden im Quelltrack
  ML.samples = JSON.parse(localStorage.getItem('djflow.samples') || '[]');
  const saveSamples = () => { localStorage.setItem('djflow.samples', JSON.stringify(ML.samples)); H.soon(); };
  const sampleRate = (s, M) => { const ts = ML.ts.get(s.uid); return ts ? rateTo(M, ts.t.bpm) : 1; };
  const sampleEnd = (s, M) => s.start + s.len / sampleRate(s, M);
  async function prepareSample(s) {
    const ts = await getTS(s.uid);
    if (s.stem) { if (!ts.hasStems) return null; await loadStems(ts); return ts.stems[s.stem]; }
    return loadBuffer(ts);
  }
  /** Sample einplanen: im Set-Tempo (Tonhöhe folgt dem Tempo), kurze Rampen gegen Knackser */
  function scheduleSample(c, s, off, dest, M, tm) {
    const ts = ML.ts.get(s.uid), buf = ts && (s.stem ? ts.stems?.[s.stem] : ts.buf); if (!buf) return null;
    const r = rateTo(M, ts.t.bpm), real = (u) => off + tm.W(u), now = c.currentTime;
    const rs = real(s.start), re = real(s.start + s.len / r); if (re <= now) return null;
    const at = Math.max(rs, now + 0.02), pos = s.in + (tm.Winv(at - off) - s.start) * r;
    const src = c.createBufferSource(), g = c.createGain(); src.buffer = buf;
    src.playbackRate.value = r;
    if (tm.on) { const d = Math.max(0.01, re - at), n = Math.max(2, Math.ceil(d * 50)), a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = r * tm.ratio(tm.Winv(at - off + (i / (n - 1)) * d)); src.playbackRate.setValueCurveAtTime(a, at, d); }
    const v = Math.pow(10, (s.gainDb || 0) / 20), fade = Math.min(0.01, (re - at) / 4);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(v, at + fade); g.gain.setValueAtTime(v, re - fade); g.gain.linearRampToValueAtTime(0, re);
    src.connect(g); g.connect(dest); src.start(at, Math.max(0, pos)); src.stop(re);
    return { srcs: [src], ch: { out: g }, ts };
  }
  const saveTempo = () => { localStorage.setItem('djflow.tempo', JSON.stringify(ML.tempo)); H.soon(); };
  const IDENT = { W: (u) => u, Winv: (t) => t, ratio: () => 1, on: false, key: '' };
  function tempoMap(points, M) {
    if (!points?.length) return IDENT;
    const pts = [...points].sort((a, b) => a.bar - b.bar), barS = 240 / M, STEP = 0.25;
    const bpm = (b) => {
      if (b <= pts[0].bar) return pts[0].bpm;
      for (let i = 1; i < pts.length; i++) if (b <= pts[i].bar) { const p = pts[i - 1], q = pts[i]; return p.bpm + ((q.bpm - p.bpm) * (b - p.bar)) / Math.max(1e-6, q.bar - p.bar); }
      return pts[pts.length - 1].bpm;
    };
    const lastB = pts[pts.length - 1].bar + 8, n = Math.ceil(lastB / STEP) + 1, tab = new Float64Array(n);
    for (let i = 1; i < n; i++) tab[i] = tab[i - 1] + ((240 / bpm((i - 0.5) * STEP)) * STEP);
    const endBpm = pts[pts.length - 1].bpm;
    const W = (u) => {
      const b = u / barS; if (b <= 0) return (b * 240) / pts[0].bpm;
      const x = b / STEP, i = Math.floor(x);
      if (i >= n - 1) return tab[n - 1] + ((b - (n - 1) * STEP) * 240) / endBpm;
      return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
    };
    const Winv = (t) => {
      if (t <= 0) return (t * pts[0].bpm / 240) * barS;
      if (t >= tab[n - 1]) return ((n - 1) * STEP + ((t - tab[n - 1]) * endBpm) / 240) * barS;
      let lo = 0, hi = n - 1; while (hi - lo > 1) { const c = (lo + hi) >> 1; if (tab[c] <= t) lo = c; else hi = c; }
      return (lo + (t - tab[lo]) / (tab[hi] - tab[lo])) * STEP * barS;
    };
    return { W, Winv, ratio: (u) => bpm(u / barS) / M, bpm, on: true, key: JSON.stringify(pts) + M };
  }

  // ================= Timeline: ganzes Set =================
  const rateTo = (M, bpm) => { let r = bpm ? M / bpm : 1; if (r > 1.3) r /= 2; else if (r < 0.77) r *= 2; return r; };
  const dbLin = (d) => Math.pow(10, d / 20);

  /** Clips berechnen: Jeder Track startet dort, wo der vorige seinen Mix-Out erreicht. */
  async function buildClips() {
    const list = [];
    for (const u of S.set) list.push(await getTS(u));
    if (!list.length) return { clips: [], M: 128, tm: IDENT, total: 0 };
    const M = ML.master || list[0].t.bpm || 128;
    const clips = []; let start = 0;
    list.forEach((ts, i) => {
      const r = rateTo(M, ts.t.bpm), next = list[i + 1];
      const inn = Math.max(0, Math.min(ts.dur - 1, ts.edit.mixIn));
      const c = { ts, rate: r, start, in: inn, i, prevTr: clips[i - 1]?.tr || null, tr: null };
      c.g = (p) => c.start + (p - c.in) / r;
      const natural = c.g(ts.dur);
      if (next) {
        c.tr = ML.trans[pairKey(ts.uid, next.uid)];
        if (!c.tr) { const ty = recommend(ts, next, null); c.tr = ML.trans[pairKey(ts.uid, next.uid)] = { type: ty, bars: TYPES[ty].bars, lead: 8 }; saveTrans(); }
        const T = Math.max(start + 1, Math.min(natural, c.g(ts.edit.mixOut)));
        const D = c.tr.bars * 240 / M;
        normTr(c.tr);
        c.T = T; c.D = D;
        const isCut = c.tr.type === 'cut', fxT = isCut ? T : T + D, tail = hasFx(c.tr, 'echoOut') ? 960 / M : 0;
        c.end = isCut && !tail ? T + 0.01 : Math.max(fxT + tail, T + 0.25);
        if (!(c.tr.holdLoop >= 0) && !tail) c.end = Math.min(c.end, Math.max(natural, T + 0.25));
        start = T;
      } else { c.end = natural; if (ts.edit.endAt != null) c.end = Math.max(c.start + 1, Math.min(natural, c.g(ts.edit.endAt))); } // letzter Track: nur bis zum Ende des Ausschnitts
      clips.push(c);
    });
    const tm = tempoMap(ML.tempo, M); clips.forEach((c) => { c.tm = tm;
      const muted = STEM_NAMES.some((n) => c.ts.edit.stemOff?.[n]);
      c.useStems = !!c.ts.hasStems && (c.tr?.type === 'stems' || c.prevTr?.type === 'stems' || muted);
    });
    return { clips, M, tm, total: Math.max(...clips.map((c) => c.end)) };
  }

  async function loadStems(ts) {
    if (ts.stems) return ts.stems;
    if (ts.baseUid) { const bs = await getTS(ts.baseUid); ts.stems = await loadStems(bs); ts.stemLag = bs.stemLag; return ts.stems; }
    const out = {};
    await Promise.all(STEM_NAMES.map(async (n) => {
      const r = await fetch('/api/stems/file?uid=' + encodeURIComponent(ts.uid) + '&stem=' + n); if (!r.ok) throw new Error('Stem nicht gefunden: ' + n);
      out[n] = await ac().decodeAudioData(await r.arrayBuffer());
    }));
    // Demucs und der Browser dekodieren manche MP3s unterschiedlich (gemessen: bis 1 s Versatz): an das Original anlegen
    await loadBuffer(ts);
    const sr = ts.buf.sampleRate, o = ts.buf.getChannelData(0), n = out.drums.length, sum = new Float32Array(n);
    for (const k of STEM_NAMES) { const d = out[k].getChannelData(0); for (let i = 0; i < n; i++) sum[i] += d[i]; }
    const c0 = Math.floor(Math.min(ts.buf.length * 0.3, Math.max(0, ts.buf.length - sr * 2))), N = Math.floor(0.8 * sr), M = Math.round(2 * sr);
    const corr = (l, st) => { let s = 0; for (let k = 0; k < N; k += st) { const j = c0 + k + l; if (j >= 0 && j < n) s += o[c0 + k] * sum[j]; } return s; };
    let lag = 0, best = -Infinity;
    for (let l = -M; l <= M; l += 4) { const s = corr(l, 16); if (s > best) { best = s; lag = l; } }
    await new Promise((r) => setTimeout(r, 0));
    best = -Infinity; const coarse = lag; for (let l = coarse - 6; l <= coarse + 6; l++) { const s = corr(l, 2); if (s > best) { best = s; lag = l; } }
    ts.stemLag = lag;
    if (lag !== 0 || n !== ts.buf.length) for (const k of STEM_NAMES) {
      const src = out[k], b = ac().createBuffer(src.numberOfChannels, ts.buf.length, sr);
      for (let c = 0; c < src.numberOfChannels; c++) { const s = src.getChannelData(c), d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const j = i + lag; d[i] = j >= 0 && j < s.length ? s[j] : 0; } }
      out[k] = b;
    }
    ts.stems = out; ts.stemsSt = null; return out;
  }
  async function prepareClip(c) {
    const ts = c.ts; await loadBuffer(ts);
    const tm = c.tm || IDENT;
    if (ts.edit.keyLock && (tm.on || Math.abs(c.rate - 1) > 0.001)) {
      const hold = c.tr && c.tr.type !== 'cut' ? ts.edit.loops[c.tr.holdLoop] : null;
      let needTrack = Math.min(ts.dur, c.in + (c.end - c.start) * c.rate + 3); // Ende des gebrauchten Bereichs im Track
      if (hold) needTrack = Math.min(ts.dur, Math.max(needTrack, hold.end + 1));
      const key = c.in + '|' + c.rate + '|' + c.start + '|' + tm.key + '|' + Math.round(needTrack);
      if (!ts.stret || ts.stretKey !== key) {
        await new Promise((r) => setTimeout(r, 20));
        const sr = ts.buf.sampleRate, s0 = Math.floor(c.in * sr), endS = Math.ceil(needTrack * sr), chs = [];
        for (let i = 0; i < ts.buf.numberOfChannels; i++) chs.push(ts.buf.getChannelData(i).subarray(s0, endS));
        const W0 = tm.W(c.start), outLen = Math.round((tm.W(c.g(needTrack)) - W0) * sr);
        const st = DSP.wsola(chs, sr, c.rate, (o) => (tm.Winv(W0 + o / sr) - c.start) * c.rate * sr, outLen);
        const b = ac().createBuffer(chs.length, st[0].length, sr); st.forEach((d, i) => b.copyToChannel(d, i));
        ts.stret = b; ts.stretKey = key; ts.stretPlan = st.plan; ts.stemsSt = null;
      }
      if (c.useStems) {
        await loadStems(ts);
        if (!ts.stemsSt || ts.stemsStKey !== key) {
          const sr = ts.buf.sampleRate, s0 = Math.floor(c.in * sr), endS = Math.ceil(needTrack * sr), W0 = tm.W(c.start), outLen = ts.stret.length, res = {};
          for (const n of STEM_NAMES) {
            await new Promise((r) => setTimeout(r, 0));
            const src = ts.stems[n], chs = []; for (let i = 0; i < src.numberOfChannels; i++) chs.push(src.getChannelData(i).subarray(s0, endS));
            const st = DSP.wsola(chs, sr, c.rate, (o) => (tm.Winv(W0 + o / sr) - c.start) * c.rate * sr, outLen, ts.stretPlan);
            const b = ac().createBuffer(chs.length, st[0].length, sr); st.forEach((x, i) => b.copyToChannel(x, i)); res[n] = b;
          }
          ts.stemsSt = res; ts.stemsStKey = key;
        }
      }
    } else { ts.stret = null; if (c.useStems) await loadStems(ts); }
  }

  /** Einen Clip mit eingehendem und ausgehendem Übergang in einen Kontext legen (Echtzeit oder Offline). off = Kontextzeit von Sekunde 0 des Sets */
  function scheduleClip(c, clip, off, dest, mt, M) {
    const ts = clip.ts, r = clip.rate, st = clip.noStret ? null : ts.stret, buf = st || ts.buf;
    const tm = clip.tm || IDENT, real = (t) => off + tm.W(t - off);
    const bp = (p) => (st ? Math.max(0, tm.W(clip.g(p)) - tm.W(clip.start)) : p), pb = st ? 1 : r;
    const setRate = (s, a, b) => {
      s.playbackRate.value = pb; if (st || !tm.on) return;
      const ra = real(a), d = Math.max(0.01, real(b) - ra), n = Math.max(2, Math.ceil(d * 50)), arr = new Float32Array(n);
      // gleichmäßig in echter Zeit abtasten, sonst läuft die Position weg
      for (let i = 0; i < n; i++) arr[i] = r * tm.ratio(tm.Winv(ra - off + (i / (n - 1)) * d));
      s.playbackRate.setValueCurveAtTime(arr, ra, d);
    };
    const beatR = 60 / M, barR = beatR * 4, now = off + tm.Winv(c.currentTime - off), ch = deckChain(c, mt, dest), srcs = [];
    applyEq(ch, ts);
    const useStems = !!clip.useStems && !!ts.stems;
    if (useStems) {
      ch.stemT = {}; ch.stemM = {};
      for (const n of STEM_NAMES) { const a = c.createGain(), b = c.createGain(); a.connect(b); b.connect(ch.input); b.gain.value = ts.edit.stemOff[n] ? 0 : 1; ch.stemT[n] = a; ch.stemM[n] = b; }
    }
    // Eine Stimme je Stem, sonst eine für den ganzen Track
    const voices = useStems ? STEM_NAMES.map((n) => ({ buf: st ? ts.stemsSt[n] : ts.stems[n], node: ch.stemT[n] })) : [{ buf, node: ch.input }];
    const stemFx = (dir, modes, T, D, mid, keep) => {
      for (const n of STEM_NAMES) {
        const p = ch.stemT[n].gain, mode = (modes || defStems())[n];
        if (dir === 'out') {
          if (mode === 'none') { g(p, 1, T - 0.01); lin(p, 0, T + 0.02); }
          else if (mode === 'swap') { g(p, 1, mid); lin(p, 0, mid + beatR / 4); }
          else if (mode === 'crossfade') { g(p, 1, T); lin(p, 0, T + D); }
        } else if (mode === 'none') { g(p, 0, T); g(p, 0, T + D - 0.01); lin(p, 1, T + D + 0.02); }
        else if (mode === 'swap') { g(p, 0, T); g(p, 0, mid); lin(p, 1, mid + beatR / 4); }
        else if (mode === 'crossfade') { g(p, 0, T); lin(p, 1, T + D); }
      }
      if (dir === 'out' && !keep) { g(ch.out.gain, 1, T + D - beatR); lin(ch.out.gain, 0, T + D); }
    };
    const asBands = (mo) => ({ low: (mo || defStems()).bass, mid: (mo || defStems()).other, high: (mo || defStems()).drums });
    const g = (p, v, t) => p.setValueAtTime(v, Math.max(real(t), 0));
    const lin = (p, v, t) => p.linearRampToValueAtTime(v, Math.max(real(t), 0));
    const ex = (p, v, t) => p.exponentialRampToValueAtTime(Math.max(0.0001, v), Math.max(real(t), 0));
    const tS = off + clip.start, tEnd = off + clip.end;
    let srcEnd = tEnd;
    // --- eingehend: Mischart, dann Effekte ---
    if (clip.prevTr) {
      const tr = clip.prevTr, T = tS, D = tr.bars * barR, mid = T + Math.round(tr.bars / 2) * barR;
      if (tr.type === 'stems') { if (useStems) stemFx('in', tr.stemModes, T, D, mid); else bandFx(ch, 'in', asBands(tr.stemModes), real(T), real(T + D) - real(T), real(mid), beatR); }
      else if (tr.type === 'bands') bandFx(ch, 'in', tr.bands, real(T), real(T + D) - real(T), real(mid), beatR);
      else if (tr.type === 'longBlend') { g(ch.out.gain, 0, T); lin(ch.out.gain, 1, T + D / 2); g(ch.low.gain, OFF, T); g(ch.low.gain, OFF, mid); lin(ch.low.gain, 0, mid + beatR); }
      else if (tr.type === 'bassSwap') { g(ch.out.gain, 0, T); lin(ch.out.gain, 1, T + Math.min(D / 4, 2 * barR)); g(ch.low.gain, OFF, T); g(ch.low.gain, OFF, mid); lin(ch.low.gain, 0, mid + beatR / 4); g(ch.high.gain, -9, T); lin(ch.high.gain, 0, mid); }
      if (hasFx(tr, 'filterSweep') && tr.type !== 'cut') { ch.filt.type = 'lowpass'; ch.filt.Q.value = 1.2; ch.filt.frequency.value = 180; g(ch.filt.frequency, 180, T); ex(ch.filt.frequency, 20000, T + D); }
    }
    // --- ausgehend ---
    if (clip.tr) {
      const tr = clip.tr, T = off + clip.T, D = clip.D, mid = T + Math.round(tr.bars / 2) * barR, posAt = (t) => clip.in + (t - tS) * r;
      const isCut = tr.type === 'cut', fxT = isCut ? T : T + D, endFx = hasFx(tr, 'echoOut') || hasFx(tr, 'spinback') || hasFx(tr, 'loopRoll');
      if (tr.type === 'stems') { if (useStems) stemFx('out', tr.stemModes, T, D, mid, endFx); else bandFx(ch, 'out', asBands(tr.stemModes), real(T), real(T + D) - real(T), real(mid), beatR, endFx); }
      else if (tr.type === 'bands') bandFx(ch, 'out', tr.bands, real(T), real(T + D) - real(T), real(mid), beatR, endFx);
      else if (tr.type === 'longBlend') { g(ch.low.gain, 0, mid); lin(ch.low.gain, OFF, mid + beatR); if (!endFx) { g(ch.out.gain, 1, mid); lin(ch.out.gain, 0, T + D); } }
      else if (tr.type === 'bassSwap') { g(ch.low.gain, 0, mid); lin(ch.low.gain, OFF, mid + beatR / 4); if (!endFx) { g(ch.out.gain, 1, T + D * 0.75); lin(ch.out.gain, 0, T + D); } }
      else if (isCut) srcEnd = T;
      if (hasFx(tr, 'filterSweep')) {
        const a = isCut ? T - D : T, b = isCut ? T : T + D;
        ch.filt.type = 'highpass'; ch.filt.Q.value = 1.2; ch.filt.frequency.value = 20; /* offen bis zum Sweep, Standard wären 350 Hz */ g(ch.filt.frequency, 20, a); ex(ch.filt.frequency, 2500, b);
      }
      if (hasFx(tr, 'echoOut')) {
        ch.delay.delayTime.value = Math.min(3.9, beatR * 0.75); g(ch.fbk.gain, 0.55, tS);
        g(ch.send.gain, 0, fxT - barR); lin(ch.send.gain, 0.8, fxT - beatR); g(ch.dry.gain, 1, fxT - 0.01); lin(ch.dry.gain, 0, fxT + 0.03); g(ch.send.gain, 0.8, fxT); lin(ch.send.gain, 0, fxT + 0.05);
        g(ch.wet.gain, 1, fxT); lin(ch.wet.gain, 0, fxT + 4 * barR); srcEnd = fxT + 0.06;
      }
      if (hasFx(tr, 'spinback')) {
        const tSpin = fxT - 2 * beatR; srcEnd = tSpin;
        if (tSpin + 0.5 > now) {
          const sr = ts.buf.sampleRate, n = Math.floor(2.5 * sr), from = Math.max(0, Math.floor(posAt(tSpin) * sr) - n);
          const rev = c.createBuffer(ts.buf.numberOfChannels, n, sr);
          for (let k = 0; k < rev.numberOfChannels; k++) { const a = ts.buf.getChannelData(k).subarray(from, from + n), d = rev.getChannelData(k); for (let i = 0; i < a.length; i++) d[i] = a[a.length - 1 - i]; }
          const s = c.createBufferSource(); s.buffer = rev; const sg = c.createGain(); s.connect(sg); sg.connect(dest); if (mt) sg.connect(mt); srcs.push(s);
          const v = dbLin(ts.edit.gainDb || 0);
          const rS = real(tSpin), rE = real(fxT);
          s.playbackRate.setValueAtTime(1.2, rS); s.playbackRate.exponentialRampToValueAtTime(3.2, rS + 0.35); s.playbackRate.exponentialRampToValueAtTime(0.3, rE);
          sg.gain.setValueAtTime(v, rS); sg.gain.linearRampToValueAtTime(0, rE);
          s.start(real(Math.max(tSpin, now))); s.stop(rE + 0.05);
        }
      }
      if (hasFx(tr, 'loopRoll')) {
        const len = Math.min(4, tr.bars) * barR, tR = fxT - len, p0 = posAt(tR), stages = [1, 0.5, 0.25, 0.125]; srcEnd = tR;
        stages.forEach((f, i) => {
          const at = tR + (len / 4) * i, stop = at + len / 4; if (stop <= now) return;
          for (const v of voices) { const s = c.createBufferSource(); s.buffer = v.buf; setRate(s, Math.max(at, now), stop); s.loop = true; s.loopStart = bp(p0); s.loopEnd = bp(p0 + beatR * f * r);
          s.connect(v.node); s.start(real(Math.max(at, now)), bp(p0)); s.stop(real(stop)); srcs.push(s); }
        });
        if (!hasFx(tr, 'filterSweep')) { ch.filt.type = 'highpass'; ch.filt.frequency.value = 20; g(ch.filt.frequency, 20, tR); ex(ch.filt.frequency, 1200, fxT); }
      }
    }
    // --- Haupt-Quelle, auch bei Einstieg mitten im Clip ---
    if (srcEnd > now) {
      const at = tS >= now ? tS : now + 0.02, pos = clip.in + (at - tS) * r;
      const hold = clip.tr && clip.tr.type !== 'cut' ? ts.edit.loops[clip.tr.holdLoop] : null;
      const seg = (p, from, to) => {
        for (const v of voices) {
          const s = c.createBufferSource(); s.buffer = v.buf; setRate(s, from, to); s.connect(v.node);
          if (hold) { s.loop = true; s.loopStart = bp(hold.start); s.loopEnd = bp(hold.end); }
          s.start(real(from), bp(p)); s.stop(real(to)); srcs.push(s);
        }
      };
      let cur = at, p = pos;
      if (!hold) for (const f of ts.edit.fx.filter((x) => x.type === 'roll' && x.end > pos).sort((a, b) => a.start - b.start)) {
        const a = off + clip.g(f.start), b = off + clip.g(f.end); if (a >= srcEnd) break;
        if (a > cur) seg(p, cur, a);
        [1, 0.5, 0.25, 0.125].forEach((frac, i) => {
          const from = Math.max(cur, a + ((b - a) / 4) * i), to = Math.min(srcEnd, a + ((b - a) / 4) * (i + 1)); if (to <= from) return;
          for (const v of voices) { const s = c.createBufferSource(); s.buffer = v.buf; setRate(s, from, to); s.loop = true; s.loopStart = bp(f.start); s.loopEnd = bp(f.start + beat(ts) * frac);
          s.connect(v.node); s.start(real(from), bp(f.start)); s.stop(real(to)); srcs.push(s); }
        });
        cur = Math.max(cur, b); p = f.end;
      }
      if (cur < srcEnd) seg(p, cur, srcEnd);
      const posMap = tm.on ? (rt) => clip.in + (tm.Winv(rt - off) - clip.start) * r : null, rA = real(at), rB = real(Math.max(at + 0.05, tEnd));
      scheduleEnv(ch.env.gain, ts, pos, rA, r, rB, !!hold, posMap);
      scheduleFx(c, ch, ts, pos, rA, r, rB, posMap);
    }
    return { srcs, ch };
  }

  const TL = {
    on: true, tm: IDENT, bus: [], mute: [false, false, false], solo: [false, false, false], clips: [], M: 128, total: 0, px: 3, x0: 0, pos: 0, playing: false, live: [], off: 0, done: new Set(), timer: null,
    dirty() { if (TL.on) TL.refresh(); },
    async refresh() { const m = await buildClips(); Object.assign(TL, m); if (!TL.fitted && TL.clips.length && $('#tl-canvas').clientWidth) { TL.fitted = true; TL.px = Math.max(0.05, ($('#tl-canvas').clientWidth - 20) / Math.max(1, TL.total)); TL.x0 = 0; } TL.syncUI(); TL.draw(); renderStrips(); },
    syncUI() {
      const b = $('#tl-bpm'); if (b && document.activeElement !== b) b.value = TL.M.toFixed(2);
      const t = $('#tl-time'); if (t) t.textContent = fmt(TL.tm.W(TL.pos)) + ' / ' + fmt(TL.tm.W(TL.total)) + (TL.tm.on ? ' · ' + (TL.tm.ratio(TL.pos) * TL.M).toFixed(1) + ' BPM' : '');
    },
    secX(s) { return (s - TL.x0) * TL.px; },
    open: [false, false],
    /** Spurhöhen: aufgeklappte Decks bekommen vier Stem-Zeilen, bei Platzmangel scrollt die Fläche */
    layout() {
      const cv = $('#tl-canvas'), main = cv.closest('.st-main'), RUL = 24, ROW = 40, avail = Math.max(120, main.clientHeight - 15);
      const SL = 62, extra = TL.open.map((o) => (o ? ROW * 4 : 0)), free = avail - RUL - extra[0] - extra[1] - SL;
      const base = Math.max(84, free / 2), lane = [base + extra[0], base + extra[1], SL];
      const total = Math.round(RUL + lane[0] + lane[1] + SL);
      TL.geo = { lane, base: [base, base], ROW };
      if (cv.dataset.h !== String(total)) {
        cv.dataset.h = total; cv.style.height = total + 'px'; cv.style.flex = '0 0 auto';
        $('#tl-decks').style.gridTemplateRows = RUL + 'px ' + lane[0] + 'px ' + lane[1] + 'px ' + SL + 'px';
      }
      return TL.geo;
    },
    laneAt(y) { const L = TL.geo.lane; return y < 24 + L[0] ? 0 : y < 24 + L[0] + L[1] ? 1 : 2; },
    sampleY() { return 24 + TL.geo.lane[0] + TL.geo.lane[1]; },
    draw() {
      const cv = $('#tl-canvas'); if (!cv) return;
      const geo = TL.layout();
      const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1; if (!W) return;
      TL.x0 = Math.max(0, Math.min(TL.x0, Math.max(0, TL.total - W / TL.px)));
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.font = '10px -apple-system, sans-serif';
      g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H);
      const RUL = 24, LH = geo.lane[0];
      const barS = 240 / TL.M, every = [1, 4, 8, 16, 32, 64, 128, 256].find((b) => b * barS * TL.px > 44) || 512;
      for (let b = Math.max(0, Math.floor(TL.x0 / barS / every)) * every; ; b += every) {
        const x = TL.secX(b * barS); if (x > W) break;
        g.fillStyle = '#ffffff14'; g.fillRect(x, RUL, 1, H); g.fillStyle = '#8b93ad'; g.fillRect(x, 16, 1, 8); g.fillText(fmt(TL.tm.W(b * barS)) === '–' ? '0:00' : fmt(TL.tm.W(b * barS)), x + 3, 12);
      }
      g.fillStyle = '#2a3350'; g.fillRect(0, RUL + LH, W, 1); g.fillRect(0, RUL - 1, W, 1);
      const bands = [['high', '#e6e9f2'], ['mid', '#ff8a00'], ['low', '#2f6bff']];
      TL.clips.forEach((c, i) => {
        const y = RUL + (i % 2) * LH + 2, h = geo.base[i % 2] - 4, x0 = TL.secX(c.start), x1 = TL.secX(c.end), sel = i === ML.pair || i === ML.pair + 1;
        if (x1 < 0 || x0 > W) return;
        const key = c.ts.t.camelot || '–';
        g.fillStyle = '#141a2a'; g.fillRect(x0, y, x1 - x0, h);
        g.fillStyle = sel ? '#00b8d9' : '#2a3350'; g.fillRect(x0, y, x1 - x0, 15);
        const ov = c.ts.perf.overview, top = y + 16, rowH = (h - 16) / 3;
        if (ov) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x++) {
          const sec = TL.x0 + x / TL.px, p = c.in + (sec - c.start) * c.rate;
          if (p < 0 || p > c.ts.dur) continue;
          const pt = ov[Math.min(ov.length - 1, Math.floor((p / c.ts.dur) * ov.length))], e = Math.min(1.3, envAt(c.ts, p));
          bands.forEach(([b, col], r) => {
            const v = (pt[2 - r] / 255) * rowH * 0.95 * e, a = bandAlpha(c, i, b, sec);
            g.globalAlpha = a; g.fillStyle = col; g.fillRect(x, top + r * rowH + (rowH - v) / 2, 1, v);
          });
        }
        g.globalAlpha = 1;
        // Cues als Fähnchen
        c.ts.edit.cues.forEach((q) => { if (!q) return; const x = TL.secX(c.g(q.sec)); if (x > x0 && x < x1) { g.fillStyle = q.color; g.fillRect(x, top, 1, h - 16); } });
        for (const f of c.ts.edit.fx) {
          const a = Math.max(TL.secX(c.g(f.start)), x0), b = Math.min(TL.secX(c.g(f.end)), x1); if (b <= a) continue;
          const col = FX_TYPES[f.type][1]; g.fillStyle = col + '30'; g.fillRect(a, top, b - a, h - 16);
          g.fillStyle = col; g.fillRect(a, y + h - 14, b - a, 14);
          g.save(); g.beginPath(); g.rect(a, y + h - 14, b - a, 14); g.clip(); g.fillStyle = '#000'; g.fillText(FX_TYPES[f.type][0], a + 3, y + h - 4); g.restore();
        }
        // Automation
        for (const k of [...Object.keys(LANES), 'vol']) {
          const on = TL.lane === k, pts = k === 'vol' ? c.ts.edit.auto : c.ts.edit.lanes[k]; if (!on && !pts?.length) continue;
          const L = laneDef(k), yOf = (v) => top + ((L.max - v) / (L.max - L.min)) * (h - 16), off0 = k === 'vol' ? c.ts.edit.gainDb || 0 : 0;
          const valAt = (p) => (k === 'vol' ? autoDb(c.ts.edit, p) + off0 : laneValue(pts, p));
          g.strokeStyle = L.col; g.globalAlpha = on ? 1 : 0.4; g.lineWidth = on ? 2 : 1; g.beginPath(); let first = true;
          for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x += 2) { const p = c.in + (TL.x0 + x / TL.px - c.start) * c.rate, v = yOf(Math.max(L.min, Math.min(L.max, valAt(p)))); first ? g.moveTo(x, v) : g.lineTo(x, v); first = false; }
          g.stroke(); g.lineWidth = 1; g.globalAlpha = 1;
          if (on) for (const pt of pts || []) { const x = TL.secX(c.g(pt.sec)); if (x >= x0 && x <= x1) { g.fillStyle = L.col; g.fillRect(x - 4, yOf(k === 'vol' ? pt.db + off0 : pt.v) - 4, 8, 8); } }
        }
        if (TL.open[i % 2]) {
          const y0 = y + h + 2, ROW = geo.ROW, sp = c.ts.stemPeaks;
          STEM_COLS.forEach(([k, name, col], r) => {
            const ry = y0 + r * ROW, rh = ROW - 2;
            g.fillStyle = c.ts.edit.stemOff[k] ? '#0d1018' : '#10141f'; g.fillRect(x0, ry, x1 - x0, rh);
            if (sp?.[k]) {
              const a = sp[k], off = c.ts.edit.stemOff[k];
              g.fillStyle = col;
              for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x++) {
                const sec = TL.x0 + x / TL.px, p = c.in + (sec - c.start) * c.rate, idx = Math.floor(p * STEM_PEAK_RATE);
                if (idx < 0 || idx >= a.length) continue;
                const v = a[idx] * (rh - 2) * Math.min(1.3, envAt(c.ts, p));
                g.globalAlpha = off ? 0.12 : stemAlpha(c, i, k, sec);
                g.fillRect(x, ry + (rh - v) / 2, 1, v);
              }
              g.globalAlpha = 1;
            }
            const lx = Math.max(x0, 0) + 4;
            g.fillStyle = sp?.[k] ? col : '#7b84a0'; g.fillText(c.ts.hasStems ? (sp ? name : name + ' · lädt …') : (r === 0 ? 'Noch nicht getrennt: Tab „Stems“' : ''), lx, ry + 11);
          });
          if (c.ts.hasStems && !sp) ensureStemPeaks(c.ts);
        }
        g.save(); g.beginPath(); g.rect(Math.max(0, x0), y, Math.max(0, Math.min(W, x1) - Math.max(0, x0)), 15); g.clip();
        g.fillStyle = sel ? '#000' : '#e6e9f2'; g.fillText(key + '  ' + (i + 1) + ' · ' + (c.ts.t.title || c.ts.t.filename) + ' – ' + (c.ts.t.artist || '') + (Math.abs(c.rate - 1) > 0.001 ? '  ' + (c.rate > 1 ? '+' : '') + ((c.rate - 1) * 100).toFixed(1) + '%' : ''), Math.max(x0, 0) + 5, y + 11); g.restore();
        if (sel && TL.drag?.clip === c) { g.strokeStyle = '#fff'; g.strokeRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, h - 1); }
      });
      // Übergangszonen über beide Spuren
      TL.clips.forEach((c, i) => {
        if (!c.tr) return; const a = TL.secX(c.T), b = TL.secX(c.end); if (b < 0 || a > W) return;
        const on = i === ML.pair;
        g.fillStyle = on ? '#ff2bd622' : '#ff2bd60e'; g.fillRect(a, RUL, b - a, H - RUL);
        g.strokeStyle = on ? '#ff2bd6' : '#ff2bd655'; g.strokeRect(a + 0.5, RUL + 0.5, b - a - 1, H - RUL - 1);
        if (on) { g.fillStyle = '#ff2bd6'; const zb = TL.secX(c.T + c.D); g.fillRect(a - 2, RUL + LH - 14, 4, 28); g.fillRect(zb - 2, RUL + LH - 14, 4, 28); }
        const lbl = trLabel(c.tr) + ' · ' + c.tr.bars + ' T', tw = g.measureText(lbl).width + 10;
        g.fillStyle = on ? '#ff2bd6' : '#5a2a58'; g.fillRect(a, RUL + LH - 8, Math.min(tw, Math.max(tw, b - a)), 16); g.fillStyle = on ? '#000' : '#fff'; g.fillText(lbl, a + 5, RUL + LH + 4);
      });
      // Tempo-Spur
      if (TL.lane === 'tempo' || ML.tempo.length) {
        const on = TL.lane === 'tempo', yOf = (v) => RUL + ((TL.M + 25 - v) / 50) * (H - RUL), XB = (b) => TL.secX((b * 240) / TL.M);
        g.globalAlpha = on ? 1 : 0.5; g.strokeStyle = '#ffb02e'; g.lineWidth = on ? 2 : 1; g.beginPath();
        if (!ML.tempo.length) { g.moveTo(0, yOf(TL.M)); g.lineTo(W, yOf(TL.M)); }
        else { g.moveTo(0, yOf(ML.tempo[0].bpm)); for (const p of ML.tempo) g.lineTo(XB(p.bar), yOf(p.bpm)); g.lineTo(W, yOf(ML.tempo[ML.tempo.length - 1].bpm)); }
        g.stroke(); g.lineWidth = 1;
        if (on) for (const p of ML.tempo) { const x = XB(p.bar), y = yOf(p.bpm); g.fillStyle = '#ffb02e'; g.fillRect(x - 4, y - 4, 8, 8); g.fillText(p.bpm.toFixed(1) + ' · T' + (p.bar + 1), x + 7, y - 5); }
        g.globalAlpha = 1;
      }
      // Sample-Spur
      { const sy = TL.sampleY(), sh = geo.lane[2];
        g.fillStyle = '#0a0d15'; g.fillRect(0, sy, W, sh); g.fillStyle = '#2a3350'; g.fillRect(0, sy, W, 1);
        if (!ML.samples.length) { g.fillStyle = '#5b6380'; g.fillText('Sample-Spur · „＋ Sample“ links fügt einen Ausschnitt ein', 8, sy + sh / 2 + 3); }
        ML.samples.forEach((s, k) => {
          const ts = ML.ts.get(s.uid), r = ts ? rateTo(TL.M, ts.t.bpm) : 1, x0 = TL.secX(s.start), x1 = TL.secX(s.start + s.len / r); if (x1 < 0 || x0 > W) return;
          const col = s.stem ? STEM_COLS.find((x) => x[0] === s.stem)[2] : '#c08cff', sel = TL.selSample === s.id;
          g.fillStyle = col + '30'; g.fillRect(x0, sy + 3, x1 - x0, sh - 6);
          const ov = ts?.perf.overview, sp = s.stem ? ts?.stemPeaks?.[s.stem] : null;
          g.globalAlpha = TL.mute[2] ? 0.3 : 1; g.fillStyle = col;
          for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, x1); x++) {
            const p = s.in + (TL.x0 + x / TL.px - s.start) * r; let v = 0;
            if (sp) v = sp[Math.floor(p * STEM_PEAK_RATE)] || 0;
            else if (ov && ts) { const q = ov[Math.max(0, Math.min(ov.length - 1, Math.floor((p / ts.dur) * ov.length)))]; v = (q[0] * 1.2 + q[1] + q[2] * 0.5) / 700; }
            v *= (sh - 20) * Math.pow(10, (s.gainDb || 0) / 20); g.fillRect(x, sy + 14 + (sh - 18 - v) / 2, 1, v);
          }
          g.globalAlpha = 1; g.strokeStyle = sel ? '#fff' : col; g.strokeRect(x0 + 0.5, sy + 3.5, x1 - x0 - 1, sh - 7);
          g.save(); g.beginPath(); g.rect(x0, sy, x1 - x0, 14); g.clip(); g.fillStyle = '#e6e9f2';
          g.fillText((ts ? (ts.t.title || ts.t.filename) : '…') + (s.stem ? ' · ' + STEM_COLS.find((x) => x[0] === s.stem)[1] : '') + ((s.gainDb || 0) ? ' · ' + (s.gainDb > 0 ? '+' : '') + s.gainDb + ' dB' : ''), Math.max(x0, 0) + 4, sy + 13); g.restore();
          if (!ts) getTS(s.uid).then(() => TL.draw());
          else if (s.stem && ts.hasStems && !ts.stemPeaks) ensureStemPeaks(ts);
        });
      }
      const px = TL.secX(TL.pos); g.fillStyle = '#fff'; g.fillRect(px - 1, 0, 2, H);
      drawSetOverview(); TL.scrollUpdate?.();
    },
    stop() {
      TL.playing = false; clearInterval(TL.timer); cancelAnimationFrame(TL.raf);
      for (const n of TL.live) { n.srcs.forEach((s) => { try { s.stop(); } catch { /* */ } }); n.ch.out.disconnect(); }
      TL.live = []; TL.done.clear(); const b = $('#tl-play'); if (b) b.textContent = '▶'; drawLevels();
    },
    async play() {
      stopPreview(); soloStop(); Player.audio.pause(); TL.stop(); await TL.refresh();
      if (!TL.clips.length) return;
      const c = ac(); TL.playing = true; $('#tl-play').textContent = '❚❚';
      if (!TL.bus.length) TL.bus = [0, 1, 2].map(() => { const b = c.createGain(); b.connect(master); return b; });
      applyBus();
      const run = TL.run = (TL.run || 0) + 1;
      const from = TL.pos >= TL.total ? 0 : TL.pos;
      const first = TL.clips.filter((k) => k.end > from && k.start <= from + 1);
      for (const k of first) await prepareClip(k);
      if (!TL.playing || run !== TL.run) return;
      TL.off = c.currentTime + 0.15 - TL.tm.W(from);
      const pump = async () => {
        const nowG = TL.tm.Winv(c.currentTime - TL.off);
        for (const k of TL.clips) {
          // Clip-Objekte werden bei jeder Neuberechnung ersetzt, darum über einen festen Schlüssel prüfen
          const id = k.i + ':' + k.ts.uid;
          if (TL.done.has(id) || k.start > nowG + 40 || k.end < nowG) continue;
          TL.done.add(id); await prepareClip(k); if (!TL.playing || run !== TL.run) return;
          { const d = k.i % 2, tap = meter('T' + d); const bus = TL.bus[d]; bus.connect(tap); const n = scheduleClip(c, k, TL.off, bus, null, TL.M); n.ts = k.ts; TL.live.push(n); }
        }
        for (const s of ML.samples) {
          const id = 's:' + s.id; if (TL.done.has(id)) continue;
          await getTS(s.uid); if (s.start > nowG + 40 || sampleEnd(s, TL.M) < nowG) continue;
          TL.done.add(id); if (!(await prepareSample(s))) continue; if (!TL.playing || run !== TL.run) return;
          TL.bus[2].connect(meter('T2')); const n = scheduleSample(c, s, TL.off, TL.bus[2], TL.M, TL.tm); if (n) { n.sample = s.id; TL.live.push(n); }
        }
      };
      await pump(); TL.timer = setInterval(pump, 3000);
      const loop = () => {
        if (!TL.playing || run !== TL.run) return;
        TL.pos = TL.tm.Winv(c.currentTime - TL.off);
        if (TL.pos >= TL.total) { TL.stop(); TL.pos = 0; TL.draw(); return; }
        const W = $('#tl-canvas')?.clientWidth || 800; if (TL.secX(TL.pos) > W * 0.9) TL.x0 = TL.pos - (W * 0.1) / TL.px;
        const keyNow = [0, 1].map((d) => deckTrack(d)?.i).join();
        if (keyNow !== TL.stripKey && !TL.stripBusy) { TL.stripKey = keyNow; renderStrips(); }
        for (const k of ['A', 'B']) { const v = ML.views[k]; if (v?.ts && bottom === 'track' && v.el.isConnected) { const p = v.playPos(); if (p != null && v.x(p) > v.W * 0.9) { v.start = p - v.W * 0.2 * v.spp; if (ML.sync && k === 'A') syncFrom(v); } v.draw(p); } }
        TL.syncUI(); TL.draw(); drawLevels(); TL.raf = requestAnimationFrame(loop);
      };
      loop();
    },
  };
  // Stem-Wellen: einmal berechnen, Audio danach wieder freigeben
  const STEM_PEAK_RATE = 40;
  let stemPeakChain = Promise.resolve();
  function ensureStemPeaks(ts) {
    if (ts.stemPeaks || ts.stemPeakBusy) return;
    ts.stemPeakBusy = true;
    stemPeakChain = stemPeakChain.then(async () => {
      try {
        const keep = !!ts.stems, st = await loadStems(ts), out = {};
        for (const n of STEM_NAMES) {
          const b = st[n], L = b.getChannelData(0), Rr = b.numberOfChannels > 1 ? b.getChannelData(1) : L, win = Math.floor(b.sampleRate / STEM_PEAK_RATE), N = Math.floor(L.length / win), a = new Float32Array(N);
          let top = 0;
          for (let i = 0, k = 0; i < N; i++) { let p = 0; for (let j = 0; j < win; j += 8, k += 8) { const v = Math.abs(L[k]) + Math.abs(Rr[k]); if (v > p) p = v; } k = (i + 1) * win; a[i] = p / 2; if (p / 2 > top) top = p / 2; }
          // gemeinsame Skala ab 1.0, damit leise Stems auch leise aussehen
          const sc = Math.max(1, top); for (let i = 0; i < N; i++) a[i] /= sc;
          out[n] = a;
        }
        ts.stemPeaks = out;
        if (!keep && !TL.clips.some((c) => c.ts === ts && c.useStems)) { ts.stems = null; ts.stemsSt = null; }
        TL.draw();
      } catch (e) { toast('⚠ Stem-Spuren: ' + esc(e.message), 5000); } finally { ts.stemPeakBusy = false; }
    });
  }
  function stemAlpha(c, i, n, sec) {
    const dim = 0.15, md = (tr) => (tr.stemModes || defStems())[n];
    if (c.tr?.type === 'stems' && sec >= c.T) { const m = md(c.tr), x = (sec - c.T) / c.D; return m === 'none' ? dim : m === 'swap' ? (x < 0.5 ? 1 : dim) : m === 'crossfade' ? Math.max(dim, 1 - x) : 1; }
    const pv = TL.clips[i - 1];
    if (pv?.tr?.type === 'stems' && sec < pv.T + pv.D) { const m = md(pv.tr), x = (sec - pv.T) / pv.D; return m === 'none' ? dim : m === 'swap' ? (x < 0.5 ? dim : 1) : m === 'crossfade' ? Math.max(dim, x) : 1; }
    return 1;
  }
  function openSamplePicker() {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = '<div class="card picker"><div class="bar"><input id="sp-q" placeholder="Track suchen …"><select id="sp-stem"><option value="">ganzer Track</option>' + STEM_COLS.map(([k, n]) => '<option value="' + k + '">nur ' + n + '</option>').join('') + '</select><button class="ghost" id="sp-x">✕</button></div>' +
      '<div class="muted small">Eingefügt an der Abspielposition, 8 Takte ab dem ersten Drop. Danach in der Spur ziehen und an den Kanten kürzen. Stems gibt es nur für getrennte Tracks.</div><div id="sp-list" class="mp-list"></div></div>';
    document.body.appendChild(m);
    const run = () => {
      const q = $('#sp-q', m).value.trim().toLowerCase();
      const rows = (q ? S.tracks.filter((t) => (t.artist + ' ' + t.title).toLowerCase().includes(q)) : S.set.map((u) => S.byUid.get(u)).filter(Boolean)).slice(0, 80);
      $('#sp-list', m).innerHTML = rows.map((t) => '<div class="sug" data-uid="' + t.uid + '"><span></span><div><div>' + esc(t.artist || '') + ' – ' + esc(t.title || t.filename) + '</div><div class="muted">' + (t.bpm?.toFixed(1) ?? '–') + ' BPM · ' + keyBadge(t.camelot) + '</div></div><button class="add">＋</button></div>').join('') || '<p class="muted">Nichts gefunden</p>';
    };
    $('#sp-q', m).oninput = run; run(); setTimeout(() => $('#sp-q', m).focus(), 30);
    m.onclick = async (ev) => {
      if (ev.target === m || ev.target.id === 'sp-x') return m.remove();
      const row = ev.target.closest('.sug'); if (!row) return;
      const ts = await getTS(row.dataset.uid), stem = $('#sp-stem', m).value || null;
      if (stem && !ts.hasStems) return toast('Für diesen Track gibt es noch keine Stems (Tab „Stems“).');
      const drop = ts.perf.auto?.sections?.find((x) => x.full)?.start ?? ts.edit.mixIn ?? 0;
      const unit = 240 / TL.M, start = Math.max(0, Math.round(TL.pos / unit) * unit);
      const s = { id: 'smp' + Date.now().toString(36), uid: ts.uid, stem, in: drop, len: 8 * bar(ts), start, gainDb: 0 };
      ML.samples.push(s); TL.selSample = s.id; saveSamples(); m.remove(); TL.refresh(); renderStrips();
      if (TL.playing) TL.play();
    };
  }

  // Sichtbarkeit eines Bandes im Übergang (für die Clip-Darstellung)
  function bandAlpha(c, i, band, sec) {
    const dim = 0.13;
    const mode = (tr) => (tr.type === 'stems' ? (tr.stemModes || defStems())[{ low: 'bass', mid: 'other', high: 'drums' }[band]] : tr.bands?.[band]) || 'crossfade';
    if ((c.tr?.type === 'bands' || c.tr?.type === 'stems') && sec >= c.T) {
      const m = mode(c.tr), x = (sec - c.T) / c.D;
      return m === 'none' ? dim : m === 'swap' ? (x < 0.5 ? 1 : dim) : m === 'crossfade' ? Math.max(dim, 1 - x) : 1;
    }
    const pv = TL.clips[i - 1];
    if ((pv?.tr?.type === 'bands' || pv?.tr?.type === 'stems') && sec < pv.T + pv.D) {
      const m = mode(pv.tr), x = (sec - pv.T) / pv.D;
      return m === 'none' ? dim : m === 'swap' ? (x < 0.5 ? dim : 1) : m === 'crossfade' ? Math.max(dim, x) : 1;
    }
    return 1;
  }
  function drawSetOverview() {
    const cv = $('#tl-over'); if (!cv || !TL.total) return;
    const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#0a0c13'; g.fillRect(0, 0, W, H);
    const X = (s) => (s / TL.total) * W;
    TL.clips.forEach((c, i) => { g.fillStyle = i % 2 ? '#ff2bd688' : '#00e5ff88'; g.fillRect(X(c.start), i % 2 ? H / 2 + 1 : 2, X(c.end) - X(c.start), H / 2 - 3); });
    const vw = ($('#tl-canvas').clientWidth / TL.px);
    g.strokeStyle = '#fff'; g.strokeRect(X(TL.x0) + 0.5, 0.5, Math.max(4, X(vw)), H - 1);
    g.fillStyle = '#fff'; g.fillRect(X(TL.pos), 0, 2, H);
  }

  // ---- Kanalzüge ----
  const KNOBS = [['low', 'Low', -26, 6], ['mid', 'Mid', -26, 6], ['high', 'High', -26, 6], ['filter', 'Filter', -1, 1]];
  // Reglerstellung -1…+1: 0 = Mitte oben, links = Minimum, rechts = Maximum
  const knobPos = (K, v) => (v >= 0 ? v / K[3] : v / -K[2]);
  const knobVal = (K, p) => (p >= 0 ? p * K[3] : p * -K[2]);
  const knobTitle = (K, v) => K[1] + ': ' + (K[0] === 'filter' ? v.toFixed(2) : (v > 0 ? '+' : '') + v.toFixed(1) + ' dB') + ' · ziehen, Doppelklick = Mitte';
  function deckTrack(d) {
    if (TL.playing) { const c = TL.clips.find((k) => k.i % 2 === d && TL.pos >= k.start && TL.pos < k.end); if (c) return c; } const a = TL.clips[ML.pair], b = TL.clips[ML.pair + 1]; return a?.i % 2 === d ? a : b?.i % 2 === d ? b : null; }
  function renderStrips() {
    if (TL.stripBusy) return; // nie den Regler ersetzen, an dem gerade gezogen wird
    const ss = $('#tl-strip-s'), sel = ML.samples.find((x) => x.id === TL.selSample);
    if (ss) ss.innerHTML = '<div class="st-h"><b>Samples</b><canvas class="st-m" data-d="2"></canvas><input type="range" class="st-sv" min="-24" max="12" step="0.5" value="' + (sel?.gainDb ?? 0) + '" title="Lautstärke des gewählten Samples" ' + (sel ? '' : 'disabled') + '>' +
      '<button class="st-open" id="tl-addsample" title="Ausschnitt aus einem Track einfügen">＋ Sample</button><button class="st-b ' + (TL.solo[2] ? 'on' : '') + '" data-sm="solo" data-d="2">S</button><button class="st-b ' + (TL.mute[2] ? 'on' : '') + '" data-sm="mute" data-d="2">M</button></div>';
    for (const d of [0, 1]) {
      const el = $('#tl-strip-' + d); if (!el) continue;
      const c = deckTrack(d), e = c?.ts.edit;
      el.innerHTML = '<div class="st-h"><b>Deck ' + (d + 1) + '</b><canvas class="st-m" data-d="' + d + '"></canvas><input type="range" class="st-v" data-d="' + d + '" min="-24" max="12" step="0.5" value="' + (e?.gainDb ?? 0) + '" title="Lautstärke des Tracks" ' + (c ? '' : 'disabled') + '>' +
        '<button class="st-open ' + (TL.open[d] ? 'on' : '') + '" data-open="' + d + '" title="Stem-Spuren unter dem Track ein- oder ausblenden">' + (TL.open[d] ? '▾' : '▸') + ' Stems</button>' + '<button class="st-b ' + (TL.solo[d] ? 'on' : '') + '" data-sm="solo" data-d="' + d + '">S</button><button class="st-b ' + (TL.mute[d] ? 'on' : '') + '" data-sm="mute" data-d="' + d + '">M</button></div>' +
        '<div class="st-track muted ell">' + (c ? (c.i + 1) + ' · ' + esc(c.ts.t.title || '') : 'kein Track') + '</div>' +
        (c?.ts.hasStems ? '<div class="st-stems">' + STEM_COLS.map(([k, n, col]) => '<button class="st-stem ' + (e.stemOff[k] ? 'off' : '') + '" data-stemoff="' + k + '" data-d="' + d + '" title="' + n + ' ein/aus" style="--c:' + col + '">' + n[0] + '</button>').join('') + '</div>' : '') +
        '<div class="st-k">' + KNOBS.map(([k, l, a, b]) => { const K = [k, l, a, b], v = e?.eq?.[k] || 0; return '<div class="knob ' + (Math.abs(v) > 0.01 ? 'set' : '') + '" data-k="' + k + '" data-d="' + d + '" title="' + knobTitle(K, v) + '" style="--r:' + (knobPos(K, v) * 135) + 'deg"><i></i><span>' + l + '</span></div>'; }).join('') + '</div>';
    }
  }
  function applyBus() {
    const any = TL.solo[0] || TL.solo[1] || TL.solo[2];
    TL.bus.forEach((b, d) => { b.gain.value = TL.mute[d] || (any && !TL.solo[d]) ? 0 : 1; });
  }
  function updateLiveEq(ts) {
    for (const n of TL.live) if (n.ts === ts) applyEq(n.ch, ts);
    const pv = ML.preview; if (pv && !pv.stopped) { if (pv.A === ts) applyEq(pv.chA, ts); if (pv.B === ts) applyEq(pv.chB, ts); }
    if (solo.ts === ts && solo.vol) setVol(solo.vol, ts);
  }
  $('#tl-decks').addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.st-v, .knob')) return;
    TL.stripBusy = true;
    const up = () => { removeEventListener('pointerup', up); removeEventListener('pointercancel', up); TL.stripBusy = false; renderStrips(); };
    addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }, true);
  $('#tl-decks').addEventListener('click', (e) => {
    if (e.target.closest('#tl-addsample')) return openSamplePicker();
    const op = e.target.closest('[data-open]');
    if (op) { const d = +op.dataset.open; TL.open[d] = !TL.open[d]; renderStrips(); TL.draw(); return; }
    const so = e.target.closest('[data-stemoff]');
    if (so) {
      const c = deckTrack(+so.dataset.d); if (!c) return;
      c.ts.edit.stemOff[so.dataset.stemoff] = !c.ts.edit.stemOff[so.dataset.stemoff];
      changed(c.ts); renderStrips();
      const live = TL.live.find((n) => n.ts === c.ts);
      if (live?.ch.stemM) for (const n of STEM_NAMES) live.ch.stemM[n].gain.value = c.ts.edit.stemOff[n] ? 0 : 1;
      else if (TL.playing) TL.play();
      return;
    }
    const b = e.target.closest('[data-sm]'); if (!b) return;
    TL[b.dataset.sm][+b.dataset.d] = !TL[b.dataset.sm][+b.dataset.d]; applyBus(); renderStrips();
  });
  $('#tl-decks').addEventListener('input', (e) => {
    if (e.target.matches('.st-sv')) { const s = ML.samples.find((x) => x.id === TL.selSample); if (s) { s.gainDb = +e.target.value; saveSamples(); TL.draw(); for (const n of TL.live) if (n.sample === s.id) n.ch.out.gain.value = Math.pow(10, s.gainDb / 20); } return; }
    if (!e.target.matches('.st-v')) return; const c = deckTrack(+e.target.dataset.d); if (!c) return;
    c.ts.edit.gainDb = +e.target.value; changed(c.ts);
  });
  $('#tl-decks').addEventListener('pointerdown', (e) => {
    const kn = e.target.closest('.knob'); if (!kn) return; const c = deckTrack(+kn.dataset.d); if (!c) return;
    const K = KNOBS.find((x) => x[0] === kn.dataset.k), y0 = e.clientY, x0 = e.clientX, p0 = knobPos(K, c.ts.edit.eq[K[0]] || 0);
    const mv = (ev) => {
      // nach oben oder rechts = mehr; nahe der Mitte rastet der Regler auf 0
      let p = Math.max(-1, Math.min(1, p0 + ((y0 - ev.clientY) + (ev.clientX - x0)) / 100));
      if (Math.abs(p) < 0.04) p = 0;
      const v = knobVal(K, p); c.ts.edit.eq[K[0]] = v;
      kn.style.setProperty('--r', (p * 135) + 'deg'); kn.classList.toggle('set', p !== 0); kn.title = knobTitle(K, v); updateLiveEq(c.ts);
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); changed(c.ts); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  $('#tl-decks').addEventListener('dblclick', (e) => {
    const kn = e.target.closest('.knob'); if (!kn) return; const c = deckTrack(+kn.dataset.d); if (!c) return;
    c.ts.edit.eq[kn.dataset.k] = 0; updateLiveEq(c.ts); changed(c.ts);
  });
  function drawLevels() {
    const bar1 = (cv, an) => {
      if (!cv) return; const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H);
      if (!an) return; const a = new Float32Array(an.fftSize); an.getFloatTimeDomainData(a); let p = 0; for (const x of a) p = Math.max(p, Math.abs(x));
      const n = Math.max(0, Math.min(1, (20 * Math.log10(p + 1e-6) + 48) / 54));
      if (H > W) { g.fillStyle = p >= 1 ? '#e8414d' : '#2fd27b'; g.fillRect(0, H * (1 - n), W, H * n); } else { g.fillStyle = p >= 1 ? '#e8414d' : '#2fd27b'; g.fillRect(0, 0, W * n, H); }
    };
    $$('.st-m').forEach((cv) => bar1(cv, TL.playing ? meters['T' + cv.dataset.d] : null));
    bar1($('#tl-master'), TL.playing ? meters.T : null);
  }

  // ---- Untere Panels ----
  let bottom = 'transition';
  function setBottom(tab) {
    bottom = tab;
    $$('.ml-btab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.ml-pane').forEach((p) => { p.style.display = p.dataset.pane === tab ? '' : 'none'; });
    $('#view-mixlab').classList.toggle('tall', tab === 'track');
    if (tab !== 'track') soloStop();
    renderBottom(); requestAnimationFrame(() => TL.draw());
  }
  function renderBottom() {
    if (bottom === 'stems') renderStems();
    if (bottom === 'transition') renderTransition();
    else if (bottom === 'track') renderEditor();
    else if (bottom === 'list') renderTimeline();
  }
  $$('.ml-btab').forEach((b) => { b.onclick = () => setBottom(b.dataset.tab); });
  let stemPoll = null, lastJob = null;
  async function renderStems() {
    const el = $('#ml-pane-stems'); if (!el) return;
    const s = await api('/api/stems/status'), uids = S.set.filter((u) => S.byUid.has(u)), has = uids.length ? await api('/api/stems/has', { uids }) : {};
    for (const u of uids) { const ts = ML.ts.get(u); if (ts && ts.hasStems !== has[u]) { ts.hasStems = has[u]; TL.dirty(); renderStrips(); } }
    if (s.env !== 'ready') {
      el.innerHTML = (s.outdated ? '<p class="s-mid"><b>Update:</b> Die neue Version trennt rund doppelt so schnell über den Grafikchip. Dafür bitte einmal neu einrichten. Vorhandene Stems bleiben erhalten.</p>' : '') + '<h3>Stems einrichten</h3><p>Trennt Tracks in Drums, Bass, Melodie und Vocals. Läuft komplett auf diesem Rechner. Einmalig werden <b>ca. 2 GB</b> geladen (PyTorch und Demucs-Modell).</p>' +
        (s.env === 'installing' ? '<p class="s-mid">' + esc(s.log || 'Läuft …') + '</p>' : '<button id="st-setup" class="primary">Jetzt einrichten</button>') + (s.error ? '<p class="s-lo">' + esc(s.error) + '</p>' : '');
    } else {
      const open = uids.filter((u) => !has[u]);
      el.innerHTML = '<div class="bar"><h3 style="margin:0">Stems im Set</h3><button id="st-all" class="primary" ' + (open.length ? '' : 'disabled') + '>Alle trennen (' + open.length + ')</button>' + (s.job || s.queue.length ? '<button id="st-cancel" class="ghost">Abbrechen</button>' : '') + '</div>' +
        (s.error ? '<p class="s-lo">' + esc(s.error) + '</p>' : '') +
        uids.map((u) => { const t = S.byUid.get(u), job = s.job?.uid === u, q = s.queue.includes(u); return '<div class="st-row"><span class="ell">' + esc(t.artist || '') + ' – ' + esc(t.title || t.filename) + '</span><span>' + (has[u] ? '<b class="s-hi">✓ getrennt</b>' : job ? '<b class="s-mid">' + (s.job.pct || 0) + ' % · ' + s.job.sec + ' s</b>' : q ? '<span class="muted">wartet</span>' : '<button data-sep="' + u + '">Trennen</button>') + '</span></div>'; }).join('') +
        '<p class="muted small">Etwa 70 MB pro Track, gespeichert im Ordner „DJ FLOW Stems“ auf dem Laufwerk des Tracks. Rechenzeit grob 15 bis 30 % der Tracklänge.</p>';
    }
    const busy = s.env === 'installing' || s.job || s.queue.length;
    if (busy || lastJob) { clearTimeout(stemPoll); if (bottom === 'stems') stemPoll = setTimeout(renderStems, 1500); }
    lastJob = busy;
  }
  $('#ml-pane-stems').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'st-setup') await api('/api/stems/setup', {});
    else if (b.id === 'st-all') await api('/api/stems/separate', { uids: S.set });
    else if (b.id === 'st-cancel') await api('/api/stems/cancel', {});
    else if (b.dataset.sep) await api('/api/stems/separate', { uids: [b.dataset.sep] });
    lastJob = true; renderStems();
  });

  async function currentPair() {
    const a = S.set[ML.pair], b = S.set[ML.pair + 1]; if (!a || !b || !S.byUid.has(a) || !S.byUid.has(b)) return null;
    const A = await getTS(a), B = await getTS(b), score = await api('/api/transition', { a, b });
    ML.score = score; return { A, B, score, tr: getTrans(A, B, score), key: pairKey(a, b) };
  }
  const BAND_COLS = [['low', 'Bass', '#2f6bff'], ['mid', 'Mitten', '#ff8a00'], ['high', 'Höhen', '#d9dde8']];
  const STEM_COLS = [['drums', 'Drums', '#2fd27b'], ['bass', 'Bass', '#e0a23a'], ['other', 'Melodie', '#e8614d'], ['vocals', 'Vocals', '#5a8cff']];
  const MODES = [['none', 'Aus'], ['swap', 'Tausch'], ['crossfade', 'Crossfade'], ['full', 'Voll']];
  async function renderTransition() {
    const el = $('#ml-pane-transition'); const p = await currentPair();
    if (!p) { el.innerHTML = '<p class="muted">Mindestens zwei Tracks hinzufügen, dann lässt sich hier der Übergang gestalten.</p>'; return; }
    const { A, B, score: sc, tr } = p; normTr(tr); const rec = recommend(A, B, sc), isB = tr.type === 'bands';
    tr.bands ||= defBands(); tr.stemModes ||= defStems();
    const isS = tr.type === 'stems', cols = isS ? STEM_COLS : BAND_COLS, noStem = isS && !(A.hasStems && B.hasStems);
    const aAn = anchorsOf(A), bAn = anchorsOf(B);
    const ancOpts = (ts, list, cur) => '<option value="">aktuell: Takt ' + barNo(ts, cur) + ' · ' + fmt(cur) + '</option>' + list.map((x, i) => '<option value="' + i + '">' + esc(anchorText(ts, x)) + '</option>').join('');
    const styleRow = '<div class="tp-styles"><span class="muted small">Stile mitten im Song:</span>' + DROP_STYLES.map(([id, name, desc]) => '<button class="tp-style ' + (tr.style === id ? 'active' : '') + '" data-style="' + id + '" title="' + esc(desc) + ' · erneuter Klick zeigt die nächste Stelle">' + name + (tr.style === id && tr.styleN ? ' <small>' + tr.styleN + '</small>' : '') + '</button>').join('') + '</div>';
    const ptsRow = '<div class="tp-pts"><label>A verlässt bei <select data-pt="a">' + ancOpts(A, aAn, A.edit.mixOut) + '</select></label>' +
      '<label>B steigt ein bei <select data-pt="b">' + ancOpts(B, bAn, B.edit.mixIn) + '</select></label>' +
      '<span class="muted small">' + esc(transInfo(A, B, tr)) + '</span></div>' + styleRow;
    el.innerHTML = '<div class="tp-head">' + keyBadge(A.t.camelot) + ' <b>' + esc(A.t.title) + '</b> <span class="muted">' + esc(A.t.artist || '') + '</span> → ' + keyBadge(B.t.camelot) + ' <b>' + esc(B.t.title) + '</b> <span class="muted">' + esc(B.t.artist || '') + '</span> <span class="score ' + scoreCls(sc.score) + '">' + sc.score + '</span><span style="flex:1"></span>' +
      [4, 8, 16, 32].map((b) => '<button class="tp-len ' + (tr.bars === b ? 'active' : '') + '" data-bars="' + b + '">' + b + '</button>').join('') +
      '<button id="tp-auto" title="Mix-Out am Ende von A (Outro), B steigt am Anfang ein">✦ Auto Ende</button><button id="tp-hear" class="primary">▶ Vorhören</button></div>' + ptsRow +
      '<div class="tp-cols"><div class="tp-col"><h4>Vorlagen</h4>' + Object.keys(BAND_PRESETS).map((n) => '<button class="tp-it" data-preset="' + n + '">' + n + '</button>').join('') + '</div>' +
      '<div class="tp-col"><h4>Mischart</h4>' + BASES.map((k) => '<button class="tp-it ' + (tr.type === k ? 'active' : '') + '" data-ty="' + k + '">' + TYPES[k].icon + ' ' + TYPES[k].name + (k === rec ? ' ★' : '') + '</button>').join('') + '</div>' +
      '<div class="tp-col"><h4>Effekte (mehrere)</h4>' + FX.map((k) => '<button class="tp-it tp-fx ' + (hasFx(tr, k) ? 'active' : '') + '" data-fx="' + k + '"><span>' + (hasFx(tr, k) ? '☑' : '☐') + '</span> ' + TYPES[k].icon + ' ' + TYPES[k].name + (k === rec ? ' ★' : '') + '</button>').join('') + '</div>' +
      cols.map(([k, n, col]) => '<div class="tp-col tp-band ' + (isB || isS ? '' : 'off') + '"><h4 style="background:' + col + ';color:#000">' + n + '</h4>' + MODES.map(([m, l]) => '<button class="tp-it ' + ((isS ? tr.stemModes[k] === m : isB && tr.bands[k] === m) ? 'active' : '') + '" ' + (isS ? 'data-stemk' : 'data-band') + '="' + k + '" data-mode="' + m + '">' + l + '</button>').join('') + '</div>').join('') +
      '</div><div class="muted small tp-desc">' + [tr.type, ...tr.fx].map((k) => esc(TYPES[k].desc)).join(' ') + (tr.fx.length && tr.type === 'cut' ? '' : '') + (noStem ? ' <b class="s-mid">Noch nicht alle Stems vorhanden, im Tab „Stems“ trennen.</b>' : '') + ' In der Timeline: Griffe am Übergang ziehen ändert die Länge.</div>';
  }
  $('#ml-pane-transition').addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    const p = await currentPair(); if (!p) return; const tr = ML.trans[p.key];
    if (t.id === 'tp-hear') { const c = TL.clips[ML.pair]; if (c) { TL.pos = Math.max(0, c.T - (tr.lead || 8) * 240 / TL.M); const W = $('#tl-canvas').clientWidth; if (TL.secX(c.T) < 0 || TL.secX(c.T) > W) TL.x0 = Math.max(0, c.T - W * 0.3 / TL.px); TL.play(); } return; }
    if (t.id === 'tp-auto') return autoTransition(p.A, p.B).then(() => TL.refresh()).then(renderTransition);
    if (t.dataset.style) { if (TL.playing) TL.stop(); return autoStyle(t.dataset.style, p.A, p.B).then(() => TL.refresh()).then(showTransition).then(renderTransition); }
    tr.style = null; tr.styleN = null; // jede manuelle Änderung beendet den Stil
    if (t.dataset.bars) tr.bars = +t.dataset.bars;
    else if (t.dataset.preset) { tr.type = 'bands'; tr.bands = { ...BAND_PRESETS[t.dataset.preset] }; }
    else if (t.dataset.ty) { tr.type = t.dataset.ty; tr.bars = TYPES[t.dataset.ty].bars; }
    else if (t.dataset.fx) {
      const f = t.dataset.fx, list = new Set(tr.fx);
      if (list.has(f)) list.delete(f);
      else { list.add(f); if (f === 'spinback') list.delete('loopRoll'); if (f === 'loopRoll') list.delete('spinback'); }
      tr.fx = FX.filter((k) => list.has(k));
    }
    else if (t.dataset.stemk) { tr.type = 'stems'; tr.stemModes = { ...(tr.stemModes || defStems()), [t.dataset.stemk]: t.dataset.mode }; }
    else if (t.dataset.band) { tr.type = 'bands'; tr.bands = { ...(tr.bands || defBands()), [t.dataset.band]: t.dataset.mode }; }
    else return;
    tr.auto = false; saveTrans(); if (TL.playing) TL.stop(); await TL.refresh(); renderTransition();
  });

  // Auswahl eines Ankers aus Cues, Loops oder Abschnitten
  $('#ml-pane-transition').addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-pt]'); if (!sel || sel.value === '') return;
    const p = await currentPair(); if (!p) return; const { A, B } = p, tr = ML.trans[p.key];
    if (sel.dataset.pt === 'a') {
      const x = anchorsOf(A)[+sel.value]; if (!x) return;
      A.edit.mixOut = Math.max(A.edit.mixIn + bar(A), Math.min(A.dur - bar(A), snapSec(A, x.sec, 4)));
      tr.holdLoop = x.loop != null && Math.abs(A.edit.loops[x.loop].start - A.edit.mixOut) < 0.3 ? x.loop : -1; // Loop an dieser Stelle hält A im Blend
      changed(A);
    } else {
      const x = anchorsOf(B)[+sel.value]; if (!x) return;
      B.edit.mixIn = Math.max(0, Math.min(B.dur - 2 * bar(B), snapSec(B, x.sec, 4))); keepOutAfterIn(B);
      changed(B);
    }
    tr.auto = false; tr.style = null; tr.styleN = null; saveTrans(); if (TL.playing) TL.stop(); await TL.refresh(); showTransition(); renderTransition();
  });

  function setTool(brush, lane) {
    TL.brush = brush || null; TL.lane = lane || null;
    $('#tl-brush').value = TL.brush || ''; $('#tl-lane').value = TL.lane || '';
    $('#tl-brush').classList.toggle('tool-on', !!TL.brush); $('#tl-lane').classList.toggle('tool-on', !!TL.lane);
    const hint = $('#tl-hint');
    hint.textContent = TL.brush ? 'Im Clip ziehen setzt „' + FX_TYPES[TL.brush][0] + '“. Balken ziehen verschiebt, Rechtsklick löscht. Esc beendet.'
      : TL.lane === 'tempo' ? 'Tempo: Klick setzt einen Punkt (oben schneller), Ziehen verschiebt, Rechtsklick löscht. Bereich ±25 BPM um den Master. Esc beendet.' : TL.lane ? 'Im Clip klicken setzt einen Punkt, Ziehen verschiebt, Rechtsklick löscht. Esc beendet.' : '';
    hint.style.display = hint.textContent ? '' : 'none';
    TL.draw();
  }
  $('#tl-brush').innerHTML = '<option value="">✦ Effekt setzen …</option>' + Object.entries(FX_TYPES).map(([k, f]) => '<option value="' + k + '">' + f[0] + '</option>').join('');
  $('#tl-lane').innerHTML = '<option value="">〰 Automation …</option><option value="vol">Lautstärke</option>' + Object.entries(LANES).map(([k, L]) => '<option value="' + k + '">' + L[0] + '</option>').join('') + '<option value="tempo">Tempo (ganzes Set)</option>';
  $('#tl-brush').onchange = (e) => setTool(e.target.value, null);
  $('#tl-lane').onchange = (e) => setTool(null, e.target.value);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && (TL.brush || TL.lane)) setTool(null, null); });
  $('#tl-play').onclick = () => (TL.playing ? TL.stop() : TL.play());
  $('#tl-bpm').onchange = (e) => { ML.master = +e.target.value || null; saveMaster(); TL.stop(); TL.refresh(); };
  const fitAll = () => { TL.px = Math.max(0.05, ($('#tl-canvas').clientWidth - 20) / Math.max(1, TL.total)); TL.x0 = 0; TL.draw(); };
  $('#tl-fit').onclick = fitAll;
  const jump = (dir) => {
    const ts = TL.clips.filter((c) => c.tr).map((c, i) => ({ i, t: c.T - 4 * 240 / TL.M }));
    const n = dir > 0 ? ts.find((x) => x.t > TL.pos + 0.5) : [...ts].reverse().find((x) => x.t < TL.pos - 0.5);
    if (n) { ML.pair = n.i; TL.pos = Math.max(0, n.t); } else TL.pos = dir > 0 ? TL.pos : 0;
    if (TL.playing) TL.play(); else { TL.syncUI(); TL.draw(); renderBottom(); renderStrips(); }
  };
  $('#tl-start').onclick = () => { TL.pos = 0; TL.x0 = 0; if (TL.playing) TL.play(); else { TL.syncUI(); TL.draw(); } };
  $('#tl-prev').onclick = () => jump(-1);
  $('#tl-next').onclick = () => jump(1);
  $('#tl-add').onclick = () => openPicker();
  $('#tl-sug').onclick = () => addSuggestion();
  $('#tl-harm').onclick = async () => {
    if (S.set.length < 3) return toast('Mindestens drei Tracks nötig');
    S.set = await api('/api/optimize', { uids: S.set }); saveSet(); await render(); toast('Reihenfolge harmonisch optimiert');
  };
  $('#tl-over').addEventListener('pointerdown', (e) => { TL.x0 = Math.max(0, (e.offsetX / e.target.clientWidth) * TL.total - $('#tl-canvas').clientWidth / TL.px / 2); TL.draw(); });
  TL.scrollUpdate = hScroll($('#tl-scroll'), { view: () => ({ start: TL.x0, span: $('#tl-canvas').clientWidth / TL.px, total: TL.total }), set: (s) => { TL.x0 = s; TL.draw(); } });
  new ResizeObserver(() => requestAnimationFrame(() => TL.draw())).observe($('#tl-canvas'));
  (() => {
    const cv = $('#tl-canvas'), RUL = 24;
    const clipAt = (x, y) => {
      if (y < RUL) return -1; const lane = TL.laneAt(y), s = TL.x0 + x / TL.px;
      return TL.clips.findIndex((c) => c.i % 2 === lane && s >= c.start && s <= c.end);
    };
    // Griffe: rechte Kante = Länge, linke Kante in der Spur von A = Start bei festem Ende
    const zoneHit = (x, y) => {
      if (y < RUL) return null;
      const lane = TL.laneAt(y);
      for (const c of TL.clips) {
        if (!c.tr) continue;
        if (Math.abs(TL.secX(c.T + c.D) - x) < 7) return { i: c.i, k: 'end' };
        if (Math.abs(TL.secX(c.T) - x) < 7 && lane === c.i % 2) return { i: c.i, k: 'start' };
      }
      return null;
    };
    // Geometrie eines Clips auf der Fläche
    const clipBox = (c) => { const G = TL.geo, y = RUL + (c.i % 2) * G.lane[0] + 2, h = G.base[c.i % 2] - 4; return { y, h, top: y + 16 }; };
    const posOf = (c, x) => c.in + (TL.x0 + x / TL.px - c.start) * c.rate;
    const fxHit = (x, y) => {
      const c = TL.clips[clipAt(x, y)]; if (!c) return null; const b = clipBox(c); if (y < b.y + b.h - 14 || y > b.y + b.h) return null;
      for (let i = c.ts.edit.fx.length - 1; i >= 0; i--) {
        const f = c.ts.edit.fx[i], a = TL.secX(c.g(f.start)), e = TL.secX(c.g(f.end));
        if (Math.abs(x - a) < 6) return { c, i, k: 'start' }; if (Math.abs(x - e) < 6) return { c, i, k: 'end' }; if (x > a && x < e) return { c, i, k: 'body' };
      }
      return null;
    };
    const laneList = (c) => (TL.lane === 'vol' ? c.ts.edit.auto : (c.ts.edit.lanes[TL.lane] ||= []));
    const valY = (c, y) => { const L = laneDef(TL.lane), b = clipBox(c), v = L.max - ((y - b.top) / (b.h - 16)) * (L.max - L.min); return Math.max(L.min, Math.min(L.max, v)) - (TL.lane === 'vol' ? c.ts.edit.gainDb || 0 : 0); };
    const sampleHit = (x, y) => {
      if (TL.laneAt(y) !== 2) return null;
      for (let k = ML.samples.length - 1; k >= 0; k--) {
        const s = ML.samples[k], a = TL.secX(s.start), b = TL.secX(sampleEnd(s, TL.M));
        if (Math.abs(x - a) < 6) return { s, k: 'start' }; if (Math.abs(x - b) < 6) return { s, k: 'end' }; if (x > a && x < b) return { s, k: 'body' };
      }
      return { s: null };
    };
    cv.addEventListener('contextmenu', (e) => {
      const h = sampleHit(e.offsetX, e.offsetY); if (!h?.s) return;
      e.preventDefault(); e.stopImmediatePropagation();
      ML.samples = ML.samples.filter((x) => x !== h.s); saveSamples(); TL.refresh(); renderStrips(); if (TL.playing) TL.play();
    }, true);
    const tempoNear = (x) => ML.tempo.findIndex((p) => Math.abs(TL.secX((p.bar * 240) / TL.M) - x) < 8);
    const tempoAt = (x, y) => {
      const unit = ML.snap >= 4 ? ML.snap / 4 : 1, b = Math.max(0, Math.round(((TL.x0 + x / TL.px) * TL.M) / 240 / unit) * unit);
      const H = cv.clientHeight, v = TL.M + 25 - ((y - RUL) / (H - RUL)) * 50;
      return { bar: b, bpm: Math.round(Math.max(TL.M - 25, Math.min(TL.M + 25, v)) * 10) / 10 };
    };
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const h = TL.lane === 'tempo' ? null : fxHit(e.offsetX, e.offsetY);
      if (h) { h.c.ts.edit.fx.splice(h.i, 1); changed(h.c.ts); if (TL.playing) TL.play(); return; }
      const c = TL.clips[clipAt(e.offsetX, e.offsetY)];
      if (TL.lane === 'tempo') { const i = tempoNear(e.offsetX); if (i >= 0) { ML.tempo.splice(i, 1); saveTempo(); TL.refresh(); if (TL.playing) TL.play(); } return; }
      if (c && TL.lane) { const l = laneList(c), i = l.findIndex((p) => Math.abs(TL.secX(c.g(p.sec)) - e.offsetX) < 8); if (i >= 0) { l.splice(i, 1); changed(c.ts); if (TL.playing) TL.play(); } }
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) TL.x0 = Math.max(0, TL.x0 + (e.deltaX || e.deltaY) / TL.px);
      else { const t = TL.x0 + e.offsetX / TL.px; TL.px = Math.max(0.05, Math.min(200, TL.px * Math.pow(0.998, e.deltaY))); TL.x0 = Math.max(0, t - e.offsetX / TL.px); }
      TL.draw();
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (TL.lane === 'tempo' && e.offsetY >= RUL) {
        cv.setPointerCapture(e.pointerId);
        const i = tempoNear(e.offsetX); let pt = ML.tempo[i];
        if (!pt) { pt = tempoAt(e.offsetX, e.offsetY); ML.tempo.push(pt); ML.tempo.sort((a, b) => a.bar - b.bar); }
        TL.drag = { tool: 'tempo', pt, dirty: true }; TL.refresh(); return;
      }
      const fh = fxHit(e.offsetX, e.offsetY);
      if (fh) { cv.setPointerCapture(e.pointerId); const f = fh.c.ts.edit.fx[fh.i]; TL.drag = { tool: 'fxEdit', k: fh.k, clip: fh.c, f, x: e.offsetX, start: f.start, end: f.end }; return; }
      const tc = TL.clips[clipAt(e.offsetX, e.offsetY)];
      if (tc && TL.brush) { cv.setPointerCapture(e.pointerId); TL.drag = { tool: 'fxNew', clip: tc, st: snapSec(tc.ts, posOf(tc, e.offsetX)), f: null }; return; }
      if (tc && TL.lane) {
        cv.setPointerCapture(e.pointerId);
        const l = laneList(tc), key = laneDef(TL.lane).key; let pt = l.find((p) => Math.abs(TL.secX(tc.g(p.sec)) - e.offsetX) < 8);
        if (!pt) { pt = { sec: snapSec(tc.ts, posOf(tc, e.offsetX)), [key]: valY(tc, e.offsetY) }; l.push(pt); l.sort((a, b) => a.sec - b.sec); }
        TL.drag = { tool: 'pt', clip: tc, pt, key, l, dirty: true }; TL.draw(); return;
      }
      const sh = TL.lane === 'tempo' ? null : sampleHit(e.offsetX, e.offsetY);
      if (sh) {
        if (!sh.s) { TL.selSample = null; renderStrips(); TL.pos = Math.max(0, TL.x0 + e.offsetX / TL.px); if (TL.playing) TL.play(); else { TL.syncUI(); TL.draw(); } return; }
        cv.setPointerCapture(e.pointerId); TL.selSample = sh.s.id; renderStrips();
        TL.drag = { tool: 'sample', k: sh.k, sm: sh.s, x: e.offsetX, o: { ...sh.s }, r: sampleRate(sh.s, TL.M), moved: false }; TL.draw(); return;
      }
      const i = clipAt(e.offsetX, e.offsetY), c = TL.clips[i], s = TL.x0 + e.offsetX / TL.px;
      if (!c && !zoneHit(e.offsetX, e.offsetY)) { TL.pos = Math.max(0, s); if (TL.playing) TL.play(); else { TL.syncUI(); TL.draw(); } return; }
      cv.setPointerCapture(e.pointerId);
      const zone = zoneHit(e.offsetX, e.offsetY);
      if (zone) {
        const z = TL.clips[zone.i]; ML.pair = zone.i;
        TL.drag = { zone: zone.k, clip: z, i: zone.i, x: e.offsetX, moved: false, bars: z.tr.bars, mixOut: z.ts.edit.mixOut };
        return;
      }
      const leftEdge = Math.abs(TL.secX(c.start) - e.offsetX) < 7 && i > 0;
      TL.drag = { clip: c, i, x: e.offsetX, s, moved: false, leftEdge, mixOut: i > 0 ? TL.clips[i - 1].ts.edit.mixOut : 0, mixIn: c.ts.edit.mixIn };
    });
    cv.addEventListener('pointermove', (e) => {
      const d = TL.drag;
      if (d?.tool === 'sample') {
        const ds = (e.offsetX - d.x) / TL.px; if (Math.abs(e.offsetX - d.x) > 2) d.moved = true; if (!d.moved) return;
        const unit = ML.snap > 0 ? (ML.snap * 60) / TL.M : 0, sn = (v) => (unit ? Math.round(v / unit) * unit : v), o = d.o, sm = d.sm;
        if (d.k === 'body') sm.start = Math.max(0, sn(o.start + ds));
        else if (d.k === 'start') { const ns = Math.min(sn(o.start + ds), o.start + o.len / d.r - 0.1), dd = ns - o.start; if (o.in + dd * d.r >= 0) { sm.start = ns; sm.in = o.in + dd * d.r; sm.len = o.len - dd * d.r; } }
        else { const ne = Math.max(sn(o.start + o.len / d.r + ds), o.start + 0.1); sm.len = (ne - o.start) * d.r; }
        TL.draw(); return;
      }
      if (!d && TL.laneAt(e.offsetY) === 2) { const h = sampleHit(e.offsetX, e.offsetY); cv.style.cursor = h?.s ? (h.k === 'body' ? 'grab' : 'ew-resize') : 'default'; return; }
      if (d?.tool === 'tempo') { Object.assign(d.pt, tempoAt(e.offsetX, e.offsetY)); ML.tempo.sort((a, b) => a.bar - b.bar); TL.refresh(); return; }
      if (d?.tool) {
        const c = d.clip, ts = c.ts, p = posOf(c, e.offsetX);
        if (d.tool === 'fxNew') { let en = snapSec(ts, p); if (en <= d.st) en = d.st + (ML.snap > 0 ? ML.snap : 1) * beat(ts); if (!d.f) { d.f = { type: TL.brush, start: d.st, end: en }; ts.edit.fx.push(d.f); } else d.f.end = en; d.dirty = true; }
        else if (d.tool === 'fxEdit') {
          const dp = ((e.offsetX - d.x) / TL.px) * c.rate; if (Math.abs(e.offsetX - d.x) > 2) d.dirty = true; if (!d.dirty) return;
          if (d.k === 'start') d.f.start = Math.min(snapSec(ts, d.start + dp), d.end - 0.05);
          else if (d.k === 'end') d.f.end = Math.max(snapSec(ts, d.end + dp), d.start + 0.05);
          else { const L = d.end - d.start; d.f.start = Math.max(0, snapSec(ts, d.start + dp)); d.f.end = d.f.start + L; }
        } else { d.pt.sec = Math.max(0, Math.min(ts.dur, snapSec(ts, p))); d.pt[d.key] = valY(c, e.offsetY); d.l.sort((a, b) => a.sec - b.sec); }
        TL.draw(); return;
      }
      if (!d && (TL.brush || TL.lane)) { cv.style.cursor = fxHit(e.offsetX, e.offsetY) ? 'grab' : clipAt(e.offsetX, e.offsetY) >= 0 ? 'crosshair' : 'default'; return; }
      if (!d && fxHit(e.offsetX, e.offsetY)) { cv.style.cursor = 'grab'; return; }
      if (d?.zone) {
        const dBars = Math.round(((e.offsetX - d.x) / TL.px) / (240 / TL.M)); if (dBars) d.moved = true; if (!d.moved) return;
        const z = d.clip, barPos = 240 / TL.M * z.rate;
        if (d.zone === 'end') z.tr.bars = Math.max(1, Math.min(128, d.bars + dBars));
        else { const b = Math.max(1, Math.min(128, d.bars - dBars)), shift = d.bars - b; z.tr.bars = b; z.ts.edit.mixOut = Math.max(z.ts.edit.mixIn + 1, Math.min(z.ts.dur - 1, d.mixOut + shift * barPos)); }
        z.tr.auto = false; saveTrans(); d.dirty = z.ts; TL.refresh(); return;
      }
      if (!d) { if (zoneHit(e.offsetX, e.offsetY)) { cv.style.cursor = 'col-resize'; return; } const c = TL.clips[clipAt(e.offsetX, e.offsetY)]; cv.style.cursor = c && c.i > 0 && Math.abs(TL.secX(c.start) - e.offsetX) < 7 ? 'ew-resize' : c ? 'grab' : 'default'; return; }
      const ds = (e.offsetX - d.x) / TL.px; if (Math.abs(e.offsetX - d.x) > 3) d.moved = true; if (!d.moved) return;
      if (d.leftEdge) { d.clip.ts.edit.mixIn = Math.max(0, snapSec(d.clip.ts, d.mixIn + ds * d.clip.rate)); d.dirty = d.clip.ts; }
      else if (d.i > 0) { const A = TL.clips[d.i - 1]; A.ts.edit.mixOut = Math.min(A.ts.dur - 1, Math.max(A.ts.edit.mixIn + 1, snapSec(A.ts, d.mixOut + ds * A.rate))); d.dirty = A.ts; }
      TL.refresh();
    });
    cv.addEventListener('pointerup', () => {
      const d = TL.drag; TL.drag = null; if (!d) return;
      if (d.tool === 'sample') { if (d.moved) { saveSamples(); TL.refresh(); if (TL.playing) TL.play(); } return; }
      if (d.tool === 'tempo') { saveTempo(); if (TL.playing) TL.play(); TL.draw(); return; }
      if (d.tool) { if (d.dirty) { changed(d.clip.ts); if (TL.playing) TL.play(); } TL.draw(); return; }
      if (d.zone) { if (d.dirty) changed(d.dirty); TL.draw(); renderStrips(); if (!d.moved && bottom !== 'transition') setBottom('transition'); else renderBottom(); return; }
      if (d.dirty) { changed(d.dirty); return; }
      if (!d.moved) {
        // Klick im Übergang wählt diesen, sonst den Track; dazu Abspielposition
        // Trefferfläche eines Übergangs: ein halber Takt davor bis zum Ende, mindestens ein Takt (harte Wechsel sind sonst nur 0,01 s breit)
        const barS = 240 / TL.M, near = TL.clips.findIndex((c) => c.tr && d.s >= c.T - 0.5 * barS && d.s <= Math.max(c.end, c.T + barS));
        const inZone = near >= 0 ? near : d.clip.tr && d.s >= d.clip.T ? d.i : d.i > 0 && d.s < TL.clips[d.i - 1].end ? d.i - 1 : Math.min(d.i, Math.max(0, S.set.length - 2));
        ML.pair = inZone; TL.pos = d.s; if (TL.playing) TL.play(); else { TL.syncUI(); TL.draw(); }
        renderStrips();
        const zoneClick = near >= 0 || (d.clip.tr && d.s >= d.clip.T) || (d.i > 0 && d.s < TL.clips[d.i - 1].end);
        if (zoneClick && bottom !== 'transition') setBottom('transition'); else renderBottom();
      }
    });
    cv.addEventListener('dblclick', (e) => { const i = clipAt(e.offsetX, e.offsetY); if (i >= 0) { ML.pair = Math.min(i, Math.max(0, S.set.length - 2)); setBottom('track'); } });
  })();

  // ================= Export: Track für Track offline rendern, überlappend mischen, streamen =================
  let exporting = null;
  async function exportSet(format) {
    TL.stop(); stopPreview(); soloStop();
    const { clips, M, total, tm } = await buildClips();
    if (!clips.length) return toast('Set ist leer');
    const sr = ac().sampleRate, title = $('#ml-title').value;
    const prog = (t) => { $('#tl-progress').textContent = t; };
    const job = exporting = { cancel: false };
    const btn = $('#tl-export'); btn.textContent = '■ Abbrechen';
    await api('/api/render/start', { format, title, sampleRate: sr });
    const CH = sr * 30; let L = new Float32Array(0), R = new Float32Array(0), written = 0;
    const lim = limOn ? new DSP.Limiter(sr) : null;
    const post = async (a, b) => {
      const body = new Float32Array(a.length * 2); body.set(a); body.set(b, a.length);
      const r = await fetch('/api/render/chunk', { method: 'POST', body: body.buffer }); if (!r.ok) throw new Error('Schreiben fehlgeschlagen');
    };
    const send = async (n) => {
      const a = L.slice(0, n), b = R.slice(0, n); if (lim) lim.process(a, b);
      await post(a, b);
      L = L.slice(n); R = R.slice(n); written += n;
    };
    try {
      for (const s of ML.samples) await getTS(s.uid);
      const items = [...clips.map((k) => ({ k, start: k.start })), ...ML.samples.map((s) => ({ s, start: s.start }))].sort((a, b) => a.start - b.start);
      for (let i = 0; i < items.length && !job.cancel; i++) {
        const it = items[i], k = it.k, s = it.s;
        prog(k ? `Track ${k.i + 1}/${clips.length}: ${k.ts.t.title || ''} …` : 'Sample …');
        let out = null, startU = it.start, endU;
        if (k) {
          await prepareClip(k); endU = k.end;
          const oc = new OfflineAudioContext(2, Math.ceil((tm.W(k.end) - tm.W(k.start)) * sr) + 1, sr);
          scheduleClip(oc, k, -tm.W(k.start), oc.destination, null, M); out = await oc.startRendering();
        } else if (await prepareSample(s)) {
          endU = sampleEnd(s, M);
          const oc = new OfflineAudioContext(2, Math.ceil((tm.W(endU) - tm.W(s.start)) * sr) + 1, sr);
          if (scheduleSample(oc, s, -tm.W(s.start), oc.destination, M, tm)) out = await oc.startRendering();
        }
        if (out) {
          const len = out.length, at = Math.round(tm.W(startU) * sr) - written, need = at + len;
          if (need > L.length) { const a = new Float32Array(need), b = new Float32Array(need); a.set(L); b.set(R); L = a; R = b; }
          const c0 = out.getChannelData(0), c1 = out.getChannelData(out.numberOfChannels > 1 ? 1 : 0);
          for (let j = 0; j < len; j++) { L[at + j] += c0[j]; R[at + j] += c1[j]; }
        }
        // Alles vor dem Start des nächsten Elements ist endgültig
        const safe = i < items.length - 1 ? Math.round(tm.W(items[i + 1].start) * sr) - written : L.length;
        for (let done = 0; done < safe && !job.cancel;) { const n = Math.min(CH, safe - done); await send(n); done += n; prog(`${Math.round((written / sr / tm.W(total)) * 100)} %`); }
        if (k && !isActive(k.ts.uid) && !ML.samples.some((x) => x.uid === k.ts.uid)) { k.ts.buf = null; k.ts.bufP = null; k.ts.stret = null; bufCache.delete(k.ts.uid); }
      }
      if (lim && !job.cancel) { const [a, b] = lim.flush(); await post(a, b); }
      const r = await api('/api/render/finish', { cancel: job.cancel });
      if (r.cancelled) { prog('Abgebrochen'); return r; }
      const clipSec = r.clipped / sr;
      prog(`✓ ${r.file.split(/[\\\\/]/).pop()} · ${r.sizeMB} MB${r.clipped ? ` · ⚠ ${clipSec.toFixed(1)} s übersteuert – Gain senken` : ''}${lim && lim.limited ? ` · Limiter griff ${(lim.limited / sr).toFixed(1)} s, max ${(20 * Math.log10(lim.minGain)).toFixed(1)} dB` : ''}`);
      r.limit = lim && { sec: lim.limited / sr, maxDb: 20 * Math.log10(lim.minGain) };
      return r;
    } catch (e) {
      await api('/api/render/finish', { cancel: true }).catch(() => {});
      prog('⚠ ' + e.message); throw e;
    } finally { exporting = null; btn.textContent = '⇩ Exportieren'; }
  }
  $('#tl-export').onclick = () => { if (exporting) exporting.cancel = true; else exportSet($('#tl-format').value).catch((e) => toast('⚠ ' + e.message, 7000)); };

  $('#tl-lim').onchange = (e) => { limOn = e.target.checked; limNode?.port.postMessage({ on: limOn }); $('#tl-gr').textContent = limOn ? '0.0 dB' : 'aus'; };
  async function matchLoudness() {
    if (S.set.length < 2) return toast('Mindestens zwei Tracks nötig');
    const btn = $('#tl-loud'); btn.disabled = true;
    try {
      const list = []; for (const u of S.set) list.push(await getTS(u));
      for (let i = 0; i < list.length; i++) {
        const ts = list[i];
        if (ts.edit.lufs == null) {
          btn.textContent = 'Messe ' + (i + 1) + '/' + list.length + ' …';
          await new Promise((r) => setTimeout(r, 20));
          const wasLoaded = !!ts.buf, buf = await loadBuffer(ts), chs = [];
          for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
          ts.edit.lufs = +DSP.loudness(chs, buf.sampleRate).toFixed(2);
          if (!wasLoaded && !isActive(ts.uid) && i < list.length - 1) { ts.buf = null; ts.bufP = null; ts.stret = null; bufCache.delete(ts.uid); }
        }
      }
      // Ziel = Median des Sets; so bewegt sich der Pegel am wenigsten
      const sorted = list.map((t) => t.edit.lufs).sort((a, b) => a - b), target = sorted[Math.floor(sorted.length / 2)];
      for (const ts of list) { ts.edit.gainDb = Math.max(-24, Math.min(12, Math.round((target - ts.edit.lufs) * 2) / 2)); ts.edit.dirty = true; api('/api/edits', { uid: ts.uid, edit: ts.edit }); updateLiveEq(ts); }
      H.soon(); await TL.refresh(); renderBottom();
      toast('Angeglichen auf ' + target.toFixed(1) + ' LUFS: ' + list.map((t) => (t.edit.gainDb > 0 ? '+' : '') + t.edit.gainDb).join(' · ') + ' dB', 7000);
      return { target, gains: list.map((t) => t.edit.gainDb), lufs: list.map((t) => t.edit.lufs) };
    } catch (e) { toast('⚠ ' + e.message, 6000); } finally { btn.disabled = false; btn.textContent = '≈ Lautstärke angleichen'; }
  }
  $('#tl-loud').onclick = matchLoudness;
  $('#tl-undo').onclick = undo; $('#tl-redo').onclick = redo;
  addEventListener('pointerdown', () => { H.down = true; }, true);
  addEventListener('pointerup', () => { H.down = false; H.soon(); }, true);
  addEventListener('pointercancel', () => { H.down = false; }, true);
  addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !$('#view-mixlab').classList.contains('active') || e.target.matches?.('input[type=text],input[type=number],input:not([type]),textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
  });
  // ================= Auto-Mix: ganzes Set automatisch, auch als Kurzmix (z.B. 100 Songs in 60 Minuten) =================
  const BREAKIN_DEF = { type: 'bands', fx: [], bands: { low: 'swap', mid: 'crossfade', high: 'crossfade' } }; // Break → Drop: Bass-Tausch, sonst Crossfade
  const mapLimit = async (list, n, fn) => { let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } })); };

  function openAutoMix() {
    const cur = S.set.filter((u) => S.byUid.has(u) && !u.includes('#')).length;
    const m = document.createElement('div'); m.className = 'modal'; document.body.appendChild(m);
    m.innerHTML = `<div class="card am-card"><h3>✦ Auto-Mix</h3><div class="am-grid">
      <div><b>Tracks</b>
        <label class="check"><input type="radio" name="am-src" value="set" ${cur >= 2 ? 'checked' : ''} ${cur < 2 ? 'disabled' : ''}> Aktuelles Set (${cur} Tracks, Reihenfolge bleibt)</label>
        <label class="check"><input type="radio" name="am-src" value="gen" ${cur < 2 ? 'checked' : ''}> Neu aus der Bibliothek zusammenstellen</label>
        <div class="am-sub" id="am-gen">
          <label>Anzahl Tracks <input id="am-n" type="number" min="2" max="200" value="100"></label>
          <label>Genre <input id="am-genre" placeholder="techno, house …"></label>
          <label>BPM von <input id="am-bmin" type="number" placeholder="124"> bis <input id="am-bmax" type="number" placeholder="136"></label>
          <label>Laufwerk <select id="am-vol"><option value="">alle</option>${[...new Set(S.tracks.map((t) => t.volume))].map((v) => `<option>${esc(v)}</option>`).join('')}</select></label>
          <label>Energiekurve <select id="am-curve">${Object.entries(CURVES).map(([k, [n]]) => `<option value="${k}" ${k === 'journey' ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        </div></div>
      <div><b>Länge</b>
        <label>Gesamtdauer <input id="am-min" type="number" min="5" max="600" value="60"> Minuten</label>
        <div id="am-per" class="muted small"></div>
        <b class="am-h">Stile</b>
        <div class="am-styles">${DROP_STYLES.map(([id, name, desc]) => `<label class="check" title="${esc(desc)}"><input type="checkbox" class="am-st" value="${id}" checked> ${name}</label>`).join('')}</div>
        <label class="check"><input type="checkbox" id="am-ret"> Rückkehr (A–B–A) alle <input id="am-retn" type="number" min="2" max="20" value="5" style="width:52px"> Tracks</label>
        <label class="check" title="Misst jeden Track (ITU BS.1770) und gleicht den Gain an. Bei 100 Tracks einige Minuten."><input type="checkbox" id="am-loud"> Lautstärke angleichen (dauert)</label>
      </div></div>
      <p class="muted small">Jeder Song läuft nur im Ausschnitt rund um seinen Drop, die Übergänge liegen mitten in den Songs. Ersetzt das aktuelle Set, die Übergänge, die Tempo-Spur und die Samples; mit Undo (Cmd+Z) geht alles zurück.</p>
      <div class="bar"><button id="am-go" class="primary big">✦ Auto-Mix erstellen</button><button id="am-x" class="ghost">Abbrechen</button><span id="am-msg" class="muted"></span></div></div>`;
    const q = (s) => m.querySelector(s), src = () => m.querySelector('input[name="am-src"]:checked').value;
    const per = () => {
      const n = src() === 'set' ? cur : +q('#am-n').value || 0, min = +q('#am-min').value || 0;
      q('#am-gen').style.opacity = src() === 'gen' ? 1 : 0.4; q('#am-per').textContent = n ? `Ø ${Math.round((min * 60) / n)} s pro Track (etwa ${Math.round((min * 60) / n / 1.875)} Takte bei 128 BPM)` : '';
    };
    m.addEventListener('input', per); per();
    m.onclick = (e) => { if (e.target === m || e.target.id === 'am-x') m.remove(); };
    q('#am-go').onclick = async () => {
      const num = (id) => (q(id).value === '' ? undefined : Number(q(id).value));
      const o = { source: src(), n: num('#am-n') || 100, genres: q('#am-genre').value.split(',').map((x) => x.trim()).filter(Boolean), bpmMin: num('#am-bmin'), bpmMax: num('#am-bmax'), volume: q('#am-vol').value, curve: q('#am-curve').value,
        minutes: num('#am-min') || 60, styles: [...m.querySelectorAll('.am-st:checked')].map((x) => x.value), ret: q('#am-ret').checked, retN: num('#am-retn') || 5, loud: q('#am-loud').checked };
      if (!o.styles.length) return (q('#am-msg').textContent = 'Mindestens einen Stil wählen.');
      q('#am-go').disabled = true;
      try {
        const r = await runAutoMix(o, (t) => { q('#am-msg').textContent = t; });
        m.remove(); showAutoMixResult(r);
      } catch (e) { q('#am-msg').textContent = '⚠ ' + e.message; q('#am-go').disabled = false; }
    };
  }

  /** Planen und anwenden. Liefert eine Zusammenfassung. */
  async function runAutoMix(o, say) {
    let uids;
    if (o.source === 'gen') {
      say('Wähle passende Tracks aus der Bibliothek …');
      const r = await api('/api/generate', { genres: o.genres, bpmMin: o.bpmMin, bpmMax: o.bpmMax, count: o.n, curve: o.curve, volume: o.volume || undefined });
      if (!r.tracks.length) throw new Error('Keine passenden Tracks mit vorhandener Datei gefunden. Filter lockern?');
      uids = r.tracks.map((t) => t.uid);
    } else uids = [...new Set(S.set.filter((u) => S.byUid.has(u) && !u.includes('#')))];
    if (uids.length < 2) throw new Error('Mindestens zwei Tracks nötig.');
    const infos = new Array(uids.length); let done = 0;
    await mapLimit(uids, 6, async (u, k) => {
      const ts = await getTS(u), g = ts.perf.grid;
      infos[k] = { uid: u, bpm: ts.t.bpm, energy: ts.t.energy, length: ts.t.length, grid: g && g.beatSec ? { firstBeatSec: g.firstBeatSec, beatSec: g.beatSec, durationSec: ts.dur } : null, sections: (ts.perf.auto?.sections || []).map((s) => ({ full: s.full, start: s.start, end: s.end })) };
      say(`Lese Struktur … ${++done}/${uids.length}`);
    });
    say('Plane Ausschnitte und Übergänge …');
    const plan = AutoMix.plan(infos, { totalSec: o.minutes * 60, styles: o.styles, returnEvery: o.ret ? o.retN : 0, seed: (Math.random() * 1e6) | 0 });
    if (plan.error) throw new Error(plan.error);
    H.commit(); // Zustand davor für Undo sichern
    const newSet = plan.entries.map((e) => { if (!e.ret) return e.uid; const a = e.uid + '#2'; S.byUid.set(a, S.byUid.get(e.uid)); return a; });
    const last = plan.entries.length - 1, tss = [];
    for (let k = 0; k <= last; k++) {
      const e = plan.entries[k], ts = await getTS(newSet[k]);
      ts.edit.mixIn = e.enter; ts.edit.mixOut = e.leave; ts.edit.endAt = k === last ? e.leave : null; ts.edit.dirty = true; tss.push(ts);
    }
    for (let k = 0; k < last; k++) {
      const st = plan.entries[k].style, def = st.style === 'breakIn' ? BREAKIN_DEF : STYLE_DEF[st.style];
      ML.trans[pairKey(newSet[k], newSet[k + 1])] = { type: def.type, bars: st.bars, fx: [...def.fx], bands: def.bands ? { ...def.bands } : defBands(), stemModes: defStems(), lead: 8, auto: false, style: st.style, styleN: null, holdLoop: -1, norm: true };
    }
    S.set = newSet; saveSet(); ML.tempo = []; saveTempo(); ML.samples = []; saveSamples(); saveTrans();
    ML.master = plan.master; saveMaster(); ML.pair = 0; TL.fitted = false; TL.pos = 0;
    say('Berechne Zeitleiste …');
    await TL.refresh(); renderStrips(); renderBottom();
    say('Speichere …');
    await mapLimit(tss, 6, (ts) => api('/api/edits', { uid: ts.uid, edit: ts.edit }));
    if (o.loud) { say('Gleiche Lautstärke an … (misst jeden Track)'); await matchLoudness(); }
    H.commit();
    const styles = {}; for (const e of plan.entries) if (e.style) styles[e.style.style] = (styles[e.style.style] || 0) + 1;
    const far = infos.filter((x) => x.grid && x.bpm && Math.abs(rateTo(plan.master, x.bpm) - 1) > 0.08).length;
    return { n: newSet.length, returns: plan.entries.filter((e) => e.ret).length, durSec: TL.tm.W(TL.total), targetSec: o.minutes * 60, styles, skipped: plan.skipped.length, far, master: plan.master };
  }
  function showAutoMixResult(r) {
    const names = Object.entries(r.styles).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${MIX_STYLE_NAME(k)}`).join(', ');
    toast(`✦ Auto-Mix: ${r.n} Einträge in ${fmt(r.durSec)} (Ziel ${fmt(r.targetSec)}) bei ${r.master.toFixed(1)} BPM${r.returns ? ' · ' + r.returns + '× Rückkehr' : ''}<br>${esc(names)}${r.skipped ? `<br>⚠ ${r.skipped} Track(s) ohne Beatgrid übersprungen` : ''}${r.far ? `<br>⚠ ${r.far} Track(s) weichen mehr als 8 % vom Tempo ab` : ''}`, 12000);
  }
  const MIX_STYLE_NAME = (id) => DROP_STYLES.find((s) => s[0] === id)?.[1] || id;

  $('#tl-automix').onclick = openAutoMix;
  $('#tl-stylesel').innerHTML = '<option value="">Stil für Übergang …</option>' + DROP_STYLES.map(([id, n]) => `<option value="${id}">${n}</option>`).join('') + '<option value="auto">✦ Auto Ende (Songende)</option>';
  $('#tl-stylesel').onchange = async (e) => {
    const v = e.target.value; e.target.value = ''; if (!v) return;
    const p = await currentPair(); if (!p) return toast('Für einen Übergang braucht das Set mindestens zwei Tracks.');
    if (TL.playing) TL.stop(); setBottom('transition');
    if (v === 'auto') await autoTransition(p.A, p.B); else await autoStyle(v, p.A, p.B);
    await TL.refresh(); showTransition(); renderBottom();
  };

  // ================= Eigener Bereich „Cues & Loops“ (ohne Set und Mix-Lab) =================
  const CE = { q: '', list: [], ts: null };
  const CE_LOOPS = [[0.25, '1/4'], [0.5, '1/2'], [1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16'], [32, '32']];
  const ceActive = () => $('#view-cues').classList.contains('active');
  // Quelle der Liste: alle Tracks, eine Library oder eine Playlist
  CE.sel = new Set(); CE.rows = null; CE.lib = ''; CE.pl = ''; CE.libs = null; CE.job = false;
  const cePill = (n) => `<span class="lb-n ${n === 0 ? 'zero' : n >= 8 ? 'full' : ''}">${n}</span>`;
  function ceFilter() {
    const words = CE.q.toLowerCase().split(/\s+/).filter(Boolean);
    CE.list = (CE.rows || S.tracks).filter((t) => { const h = `${t.artist} ${t.title} ${t.filename || ''} ${t.genre}`.toLowerCase(); return words.every((w) => h.includes(w)); });
    renderCueList();
  }
  function renderCueList() {
    $('#ce-list').innerHTML = CE.list.slice(0, 300).map((t) => `<div class="ce-row ${CE.ts?.uid === t.uid ? 'sel' : ''}" data-uid="${t.uid}"><input type="checkbox" ${CE.sel.has(t.uid) ? 'checked' : ''} title="Für den Stapellauf auswählen"><div class="ce-t"><div class="ell">${esc(t.title || t.filename)}</div><div class="ell muted small">${esc(t.artist || '')} · ${t.bpm?.toFixed(0) ?? '–'} BPM · ${t.camelot ?? '–'}</div></div>${t.cues != null ? `<span class="ce-n" title="Cues / Loops in Engine">${cePill(t.cues)}${cePill(t.loops)}</span>` : ''}</div>`).join('') +
      (CE.list.length > 300 ? `<p class="muted small">${(CE.list.length - 300).toLocaleString('de')} weitere – Suche eingrenzen („alle“ wählt auch sie)</p>` : CE.list.length ? '' : '<p class="muted">Keine Treffer.</p>');
    ceBatchUi();
  }
  function ceBatchUi() {
    const n = CE.sel.size;
    $('#ce-all').checked = CE.list.length > 0 && CE.list.every((t) => CE.sel.has(t.uid));
    $('#ce-count').textContent = `${n.toLocaleString('de')} gewählt`;
    $('#ce-run').textContent = `✦ Stapel: ${n.toLocaleString('de')} Track${n === 1 ? '' : 's'}`;
    $('#ce-run').disabled = !n || CE.job; $('#ce-stop').style.display = CE.job ? '' : 'none';
  }
  async function ceShow() {
    if (!CE.libs) {
      CE.libs = (await api('/api/lib/list')).filter((l) => l.trackCount);
      const opt = (l) => `<option value="${l.id}">${esc(l.volume)}${l.device ? ' (Gerät)' : ''} · ${l.trackCount.toLocaleString('de')}</option>`;
      $('#ce-lib').innerHTML = '<option value="">Alle Tracks (nur Suche)</option>' + CE.libs.map(opt).join('');
      $('#ce-target').innerHTML = '<option value="">in die Library des Tracks</option>' + CE.libs.map((l) => `<option value="${l.id}">nach ${esc(l.volume)}${l.device ? ' (Gerät)' : ''}</option>`).join('');
    }
    ceFilter();
  }
  /** Zeilen der gewählten Quelle laden (mit Cue-/Loop-Anzahl) */
  async function ceLoad() {
    const lib = CE.lib, pl = CE.pl;
    let rows = null;
    if (lib) {
      $('#ce-list').innerHTML = '<p class="muted">Lese Tracks …</p>';
      rows = pl === '' ? await api('/api/lib/tracks?lib=' + encodeURIComponent(lib)) : (await api(`/api/lib/playlist?lib=${encodeURIComponent(lib)}&id=${pl}`)).tracks;
      rows = [...new Map(rows.map((r) => [r.uid, r])).values()];
    }
    if (lib !== CE.lib || pl !== CE.pl) return; // inzwischen umgeschaltet
    CE.rows = rows; ceFilter();
  }
  $('#ce-lib').onchange = async (e) => {
    CE.lib = e.target.value; CE.pl = ''; CE.sel.clear();
    const flat = (nodes, d) => nodes.flatMap((p) => [`<option value="${p.id}">${'  '.repeat(d)}${esc(p.title)}${p.count ? ' (' + p.count + ')' : ''}</option>`, ...flat(p.children, d + 1)]);
    $('#ce-pl').style.display = CE.lib ? '' : 'none';
    if (CE.lib) $('#ce-pl').innerHTML = '<option value="">Ganze Library</option>' + flat(await api('/api/lib/playlists?lib=' + encodeURIComponent(CE.lib)), 0).join('');
    await ceLoad();
  };
  $('#ce-pl').onchange = async (e) => { CE.pl = e.target.value; CE.sel.clear(); await ceLoad(); };
  $('#ce-all').onchange = (e) => { for (const t of CE.list) e.target.checked ? CE.sel.add(t.uid) : CE.sel.delete(t.uid); renderCueList(); };
  $('#ce-stop').onclick = () => { CE.stopped = true; api('/api/lib/stop', {}); };
  $('#ce-run').onclick = async () => {
    const uids = [...CE.sel]; if (!uids.length || CE.job) return;
    const kinds = $('#ce-kinds').value, mode = $('#ce-mode').value, target = $('#ce-target').value;
    const dev = CE.libs.filter((l) => l.device && (target ? l.id === target : uids.some((u) => u.startsWith(l.id + ':'))));
    const what = { both: 'Cues und Loops', cues: 'Cues', loops: 'Loops' }[kinds];
    if (!confirm(`${uids.length.toLocaleString('de')} Track(s): ${what} automatisch setzen und direkt in die Engine-Datenbank schreiben?\n\n${mode === 'all' ? `Vorhandene ${what} werden ERSETZT.` : 'Nur freie Plätze werden gefüllt, Vorhandenes bleibt.'}\nZiel: ${target ? CE.libs.find((l) => l.id === target).volume : 'Library des jeweiligen Tracks'}\n\nEngine DJ muss geschlossen sein${dev.length ? ', das Prime-Gerät darf nicht laufen' : ''}. Vorher entsteht ein Backup der Datenbank.`)) return;
    const byLib = new Map();
    for (const u of uids) { const [l, id] = u.split(':'); if (!byLib.has(l)) byLib.set(l, []); byLib.get(l).push(+id); }
    CE.job = true; CE.stopped = false; ceBatchUi(); soloStop();
    let written = 0, kept = 0; const skip = { noGrid: 0, noMatch: 0, nothing: 0 }; let error = null;
    try {
      for (const [lib, ids] of byLib) {
        if (CE.stopped) break;
        await api('/api/lib/auto', { lib, target: target || lib, ids, mode, kinds });
        for (;;) {
          const j = await api('/api/lib/job');
          $('#ce-job').textContent = `${j.phase} … ${j.done.toLocaleString('de')}/${j.total.toLocaleString('de')}`;
          if (!j.running) { if (j.error) throw new Error(j.error); written += j.written; kept += j.localKept || 0; for (const k in skip) skip[k] += j.skip?.[k] || 0; break; }
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    } catch (e) { error = e.message; }
    CE.job = false;
    const parts = [skip.nothing && `${skip.nothing} schon vollständig`, skip.noGrid && `${skip.noGrid} ohne Beatgrid`, skip.noMatch && `${skip.noMatch} ohne passenden Track im Ziel`, kept && `${kept} mit eigenen, noch nicht geschriebenen Änderungen (Anzeige unverändert)`].filter(Boolean);
    $('#ce-job').textContent = error ? '⚠ ' + error : `✓ ${written.toLocaleString('de')} Track(s) geschrieben${parts.length ? ' · ' + parts.join(', ') : ''}${CE.stopped ? ' · abgebrochen' : ''}`;
    if (error) toast('⚠ ' + esc(error), 8000);
    const touched = target ? [...ML.ts.keys()].filter((u) => u.startsWith(target + ':')) : uids;
    await ceForget(touched);
    await ceLoad();
  };
  async function openCues(uid) {
    if (!ceActive()) show('cues');
    soloStop();
    const ts = await getTS(uid);
    CE.ts = ts; ts.curveMode = null; ts.fxBrush = null; // Mix-Lab-Werkzeuge hier nicht aktiv
    $('#ce-main').classList.remove('empty');
    $('#ce-title').innerHTML = `<b>${esc(ts.t.artist || '')} – ${esc(ts.t.title || ts.t.filename)}</b> <span class="muted">${ts.t.bpm?.toFixed(2) ?? '–'} BPM · ${ts.t.camelot ?? '–'} · ${fmt(ts.dur)}${ts.perf.grid?.beatSec ? '' : ' · ⚠ kein Beatgrid (in Engine analysieren)'}</span>`;
    if (!ML.cueView) { ML.cueView = new WaveView($('#ce-wave'), 'cue'); ML.cueView.noMix = true; }
    const v = ML.cueView; v.ts = ts; v.cursor = ts.edit.cues.find(Boolean)?.sec ?? fb(ts);
    v.fit(); renderCuePads(); renderCueList();
    loadBuffer(ts).catch(() => {});
  }
  function renderCuePads() {
    const ts = CE.ts; if (!ts) return;
    const e = ts.edit;
    $('#ce-cues').innerHTML = '<span class="pl">CUES</span>' + e.cues.map((c, i) => `<button class="pad ${c ? 'on' : ''}" data-i="${i}" style="${c ? `--pc:${c.color}` : ''}" title="${c ? `Takt ${barNo(ts, c.sec)} · Klick = abspielen · Doppelklick = umbenennen · Rechtsklick = löschen` : 'Leer · Klick = Cue an der Abspielposition setzen'}"><b>${i + 1}</b> ${c ? esc(c.label) : ''}</button>`).join('');
    $('#ce-loops').innerHTML = '<span class="pl">LOOPS</span>' + e.loops.map((l, i) => `<button class="pad loop ${l ? 'on' : ''}" data-i="${i}" style="${l ? `--pc:${l.color}` : ''}" title="${l ? `T${barNo(ts, l.start)} · Klick = Loop abspielen · Rechtsklick = löschen` : 'Leer · Klick = Loop an der Abspielposition setzen'}"><b>${i + 1}</b> ${l ? esc(l.label) + ' <small>' + fmtBeats((l.end - l.start) / beat(ts)) + '</small>' : ''}</button>`).join('');
    $('#ce-state').textContent = e.dirty ? '● geändert (lokal gespeichert, noch nicht in Engine)' : 'unverändert gegenüber Engine';
  }
  const ceHere = () => Math.max(0, snapSec(CE.ts, (solo.ts === CE.ts ? soloPos() : null) ?? ML.cueView.cursor ?? 0));
  function ceCue(i) {
    const ts = CE.ts; if (!ts) return;
    const c = ts.edit.cues[i];
    if (c) { ML.cueView.cursor = c.sec; return soloPlay(ts, c.sec); }
    ts.edit.cues[i] = { label: `Cue ${i + 1}`, sec: ceHere(), color: COLORS[i] }; changed(ts);
  }
  function ceLoop(i) {
    const ts = CE.ts; if (!ts) return;
    const l = ts.edit.loops[i];
    if (l) return soloPlay(ts, l.start, l);
    const st = ceHere(); ts.edit.loops[i] = { label: `Loop ${i + 1}`, start: st, end: st + ML.loopLen * beat(ts), color: COLORS[i] }; changed(ts);
  }
  /** Loop mit fester Länge in den nächsten freien Platz und gleich abspielen */
  function ceNewLoop(beats) {
    const ts = CE.ts; if (!ts) return;
    ML.loopLen = beats; $('#ml-looplen').value = String(beats);
    const i = ts.edit.loops.indexOf(null); if (i < 0) return toast('Alle 8 Loop-Plätze belegt (Rechtsklick auf einen Platz löscht ihn)');
    const st = ceHere(); ts.edit.loops[i] = { label: `Loop ${i + 1}`, start: st, end: st + beats * beat(ts), color: COLORS[i] }; changed(ts);
    soloPlay(ts, st, ts.edit.loops[i]);
  }
  async function ceAuto(what) {
    const ts = CE.ts; if (!ts) return;
    if (!ts.perf.auto) return toast('Kein Beatgrid – bitte erst in Engine DJ analysieren');
    const kinds = what === 'both' ? ['cues', 'loops'] : [what];
    const has = kinds.some((k) => ts.edit[k].some(Boolean));
    const replace = !has || confirm('Es gibt schon Einträge.\n\nOK = alle durch die Auto-Erkennung ersetzen\nAbbrechen = nur freie Plätze füllen');
    const keep = { mixIn: ts.edit.mixIn, mixOut: ts.edit.mixOut, cues: ts.edit.cues.slice(), loops: ts.edit.loops.slice() };
    await applyAuto(ts, replace ? 'all' : 'fill');
    ts.edit.mixIn = keep.mixIn; ts.edit.mixOut = keep.mixOut; // Mix-Punkte gehören ins Mix-Lab
    for (const k of ['cues', 'loops']) if (!kinds.includes(k)) ts.edit[k] = keep[k];
    changed(ts);
  }
  let ceT; $('#ce-q').oninput = (e) => { clearTimeout(ceT); ceT = setTimeout(() => { CE.q = e.target.value; ceFilter(); }, 150); };
  $('#ce-list').onclick = (e) => {
    const r = e.target.closest('.ce-row'); if (!r) return;
    if (e.target.matches('input')) { e.target.checked ? CE.sel.add(r.dataset.uid) : CE.sel.delete(r.dataset.uid); e.target.blur(); return ceBatchUi(); }
    openCues(r.dataset.uid);
  };
  $('#ce-snap').innerHTML = $('#ml-snap').innerHTML;
  $('#ce-snap').onchange = (e) => { $('#ml-snap').value = e.target.value; $('#ml-snap').dispatchEvent(new Event('change')); };
  $('#ce-looplen').innerHTML = '<span class="muted small">Loop (Beats):</span>' + CE_LOOPS.map(([b, n]) => `<button data-b="${b}">${n}</button>`).join('');
  $('#ce-looplen').onclick = (e) => { const b = e.target.dataset.b; if (b) ceNewLoop(+b); };
  $('#ce-play').onclick = () => { if (!CE.ts) return; if (solo.src) soloStop(); else soloPlay(CE.ts, ML.cueView.cursor || 0); };
  $('#ce-zin').onclick = () => CE.ts && ML.cueView.zoomTo(ceHere(), ML.cueView.spp * 0.5);
  $('#ce-zout').onclick = () => CE.ts && ML.cueView.zoomBy(2);
  $('#ce-fit').onclick = () => CE.ts && ML.cueView.fit();
  $('#ce-auto').onclick = () => ceAuto('both');
  $('#ce-auto-cues').onclick = () => ceAuto('cues');
  $('#ce-auto-loops').onclick = () => ceAuto('loops');
  $('#ce-revert').onclick = () => {
    const ts = CE.ts; if (!ts || !confirm('Cues und Loops dieses Tracks auf den Stand aus Engine zurücksetzen?')) return;
    const pad8 = (a) => Array.from({ length: 8 }, (_, i) => a?.[i] || null);
    ts.edit.cues = pad8(ts.perf.engineCues); ts.edit.loops = pad8(ts.perf.engineLoops); changed(ts);
    ts.edit.dirty = false; api('/api/edits', { uid: ts.uid, edit: ts.edit }); renderCuePads();
  };
  $('#ce-write').onclick = () => CE.ts && writeEngine([CE.ts.uid]);
  for (const [id, kind, use] of [['#ce-cues', 'cues', ceCue], ['#ce-loops', 'loops', ceLoop]]) {
    $(id).onclick = (e) => { const p = e.target.closest('.pad'); if (p && e.detail < 2) use(+p.dataset.i); };
    $(id).oncontextmenu = (e) => { const p = e.target.closest('.pad.on'); if (!p) return; e.preventDefault(); soloStop(); CE.ts.edit[kind][+p.dataset.i] = null; changed(CE.ts); };
    $(id).ondblclick = async (e) => {
      const p = e.target.closest('.pad.on'); if (!p) return;
      const item = CE.ts.edit[kind][+p.dataset.i]; soloStop();
      const name = await askText('Name:', item.label); if (name == null) return;
      item.label = name.slice(0, 40); changed(CE.ts);
    };
  }
  document.addEventListener('keydown', (e) => {
    if (!ceActive() || e.target.matches('input,select,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const done = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const n = /^Digit([1-8])$/.exec(e.code);
    if (e.code === 'Space') { done(); $('#ce-play').click(); }
    else if (n) { done(); (e.shiftKey ? ceLoop : ceCue)(+n[1] - 1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      done(); const t = CE.list[CE.list.findIndex((x) => x.uid === CE.ts?.uid) + (e.key === 'ArrowDown' ? 1 : -1)];
      if (t) openCues(t.uid).then(() => $(`.ce-row[data-uid="${CSS.escape(t.uid)}"]`)?.scrollIntoView({ block: 'nearest' }));
    }
  }, true);
  /** Nach einem Stapellauf: zwischengespeicherte Tracks neu von Engine laden (eigene offene Änderungen bleiben) */
  async function ceForget(uids) {
    soloStop();
    for (const u of uids) { const ts = ML.ts.get(u); if (ts && !ts.edit.dirty) ML.ts.delete(u); }
    TL.dirty();
    if (CE.ts && uids.includes(CE.ts.uid)) await openCues(CE.ts.uid);
  }
  window.CueEditor = { show: () => ceShow(), open: openCues, leave: () => soloStop(), _state: CE };

  H.ui();
  setBottom('transition');
  window.MixLab = { render, openPair, addTrack, TYPES, _clipRender: async (idx) => {
    const { clips, M } = await buildClips(), k = clips[idx]; await prepareClip(k);
    const sr = ac().sampleRate, len = Math.ceil((k.tm.W(k.end) - k.tm.W(k.start)) * sr) + 1, oc = new OfflineAudioContext(2, len, sr);
    scheduleClip(oc, k, -k.tm.W(k.start), oc.destination, null, M);
    return { buf: await oc.startRendering(), clip: k, M };
  }, _clipPeaks: async () => {
    const { clips, M } = await buildClips(), sr = ac().sampleRate, out = [];
    for (const k of clips) {
      await prepareClip(k);
      const len = Math.ceil((k.tm.W(k.end) - k.tm.W(k.start)) * sr) + 1, oc = new OfflineAudioContext(2, len, sr);
      scheduleClip(oc, k, -k.tm.W(k.start), oc.destination, null, M);
      const a = (await oc.startRendering()).getChannelData(0); let p = 0, at = 0, over = 0;
      for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) { p = v; at = i; } if (v > 1) over++; }
      let srcP = 0; const s = k.ts.buf.getChannelData(0); for (let i = 0; i < s.length; i += 1) if (Math.abs(s[i]) > srcP) srcP = Math.abs(s[i]);
      out.push({ i: k.i, gain: k.ts.edit.gainDb, tr: k.tr && k.tr.type + '+' + (k.tr.fx || []).join(), prev: k.prevTr && k.prevTr.type, srcPeak: +srcP.toFixed(2), peak: +p.toFixed(2), atRel: +(at / sr).toFixed(1), len: +(k.end - k.start).toFixed(1), T: k.T && +(k.T - k.start).toFixed(1), over: +(over / sr).toFixed(2) });
    }
    return out;
  }, _state: ML, _H: H, _anchors: anchorsOf, _midList: midCandidates, _mid: autoMid, _auto: runAutoMix, _openAuto: openAutoMix, _style: autoStyle, _styleList: styleCandidates, _drops: dropTargets, _scheduleSample: scheduleSample, _prepareSample: prepareSample, _prepare: prepareClip, _schedule: scheduleClip, _build: buildClips, _match: matchLoudness, _getTS: getTS, _renderRange: async (ts, from, len) => {
    await loadBuffer(ts); const sr = ac().sampleRate, oc = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
    scheduleClip(oc, { ts, rate: 1, start: 0, in: from, end: len, tr: null, prevTr: null, noStret: true, g: (p) => p - from }, 0, oc.destination, null, 60 / beat(ts));
    return oc.startRendering();
  }, _tl: TL, _exportSet: exportSet, _ac: () => AC };
})();
