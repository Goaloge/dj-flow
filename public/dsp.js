// DJ FLOW – DSP-Helfer (Browser und Node-Tests)
'use strict';
(function (root) {
  /** Zeitdehnung ohne Tonhöhenänderung (WSOLA). rate > 1 = schneller. Ein Kanal-Array je Eingangskanal. */
  function wsola(channels, sr, rate, posFn = null, outLenArg = 0, planIn = null) {
    const plan = [];
    const N = Math.round(sr * 0.046), Hs = N >> 1, tol = Math.round(sr * 0.012);
    const len = channels[0].length, outLen = outLenArg || Math.floor(len / rate);
    const out = channels.map(() => new Float32Array(outLen + N)), norm = new Float32Array(outLen + N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const mono = channels.length > 1 ? channels[0].map((v, i) => v + channels[1][i]) : channels[0];
    let prev = 0; // Analyse-Position des letzten Frames
    for (let o = 0; o < outLen; o += Hs) {
      const target = Math.round(posFn ? posFn(o) : o * rate);
      let best = target;
      if (planIn) best = planIn[plan.length] ?? target;
      else if (o > 0) {
        // Rahmen suchen, der am besten an die natürliche Fortsetzung des vorigen anschließt
        let bestC = -Infinity; const nat = prev + Hs;
        for (let d = -tol; d <= tol; d += 4) {
          const p = target + d; if (p < 0 || p + N >= len) continue;
          let c = 0;
          for (let i = 0; i < Hs; i += 4) if (nat + i < len) c += mono[nat + i] * mono[p + i];
          if (c > bestC) { bestC = c; best = p; }
        }
      }
      best = Math.max(0, Math.min(len - N - 1, best)); plan.push(best);
      if (best < 0) break;
      channels.forEach((ch, c) => { const d = out[c]; for (let i = 0; i < N; i++) d[o + i] += ch[best + i] * win[i]; });
      for (let i = 0; i < N; i++) norm[o + i] += win[i];
      prev = best;
    }
    const res = out.map((d) => {
      const r = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? d[i] / norm[i] : 0;
      return r;
    });
    res.plan = plan; // gleiche Rahmen für alle Stems, sonst verschmieren sie gegeneinander
    return res;
  }

  /** Stärkster Einschwinger um `sec` (±winSec) in den 3-Band-Peaks */
  function onsetNear(p, rate, sec, winSec) {
    const c = Math.round(sec * rate), w = Math.max(1, Math.round(winSec * rate));
    const s = (i) => p.lo[i] * 1.5 + p.mi[i] + p.hi[i] * 0.7;
    let best = -1, bestF = 0;
    for (let i = Math.max(1, c - w); i <= Math.min(p.n - 1, c + w); i++) {
      const f = s(i) - s(i - 1) - (Math.abs(i - c) / w) * 0.05; // bei Gleichstand näher am Ziel
      if (f > bestF) { bestF = f; best = i; }
    }
    return best < 0 ? sec : best / rate;
  }

  /** Lookahead-Limiter (Stereo, in place). Spitzen können die Decke nicht überschreiten; Signal verzögert um look. */
  class Limiter {
    constructor(sr, { ceilDb = -0.3, look = 0.003, release = 0.12 } = {}) {
      this.c = Math.pow(10, ceilDb / 20); this.N = Math.max(2, Math.round(look * sr));
      this.coef = 1 - Math.exp(-1 / (release * sr)); this.enabled = true;
      const N = this.N; this.dl = new Float32Array(N - 1); this.dr = new Float32Array(N - 1); this.w = 0;
      this.qv = new Float32Array(N + 1); this.qi = new Float64Array(N + 1); this.qh = 0; this.qt = 0; this.i = 0;
      this.avg = new Float32Array(N).fill(1); this.ap = 0; this.sum = N; this.r = 1; this.gain = 1; this.minGain = 1; this.limited = 0;
    }
    process(L, R) {
      const { c, N, coef, dl, dr, qv, qi, avg } = this, Q = N + 1, D = N - 1;
      let { w, qh, qt, i, ap, sum, r, minGain, limited } = this, a = 1;
      for (let n = 0; n < L.length; n++, i++) {
        const xl = L[n], xr = R[n], pk = Math.max(Math.abs(xl), Math.abs(xr)), req = pk > c ? c / pk : 1;
        // gleitendes Minimum der benötigten Absenkung
        while (qh !== qt && qv[(qt + Q - 1) % Q] >= req) qt = (qt + Q - 1) % Q;
        qv[qt] = req; qi[qt] = i; qt = (qt + 1) % Q;
        while (qi[qh] <= i - N) qh = (qh + 1) % Q;
        const m = qv[qh];
        r = m < r ? m : r + (m - r) * coef;
        sum += r - avg[ap]; avg[ap] = r; ap = (ap + 1) % N;
        a = Math.min(1, sum / N);
        L[n] = dl[w] * a; R[n] = dr[w] * a; dl[w] = xl; dr[w] = xr; w = (w + 1) % D;
        if (a < minGain) minGain = a; if (a < 0.999) limited++;
      }
      Object.assign(this, { w, qh, qt, i, ap, sum, r, minGain, limited, gain: a });
    }
    /** restliche verzögerte Samples */
    flush() { const n = this.N - 1, L = new Float32Array(n), R = new Float32Array(n); this.process(L, R); return [L, R]; }
  }

  function biquad(x, b0, b1, b2, a1, a2) {
    const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = x[i], o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; y[i] = o; x2 = x1; x1 = v; y2 = y1; y1 = o; }
    return y;
  }
  /** Integrierte Lautheit nach ITU BS.1770 (LUFS), Koeffizienten für die jeweilige Samplerate berechnet */
  function loudness(channels, sr) {
    const shelf = (() => { const f = 1681.97, G = 3.99984, Q = 0.7071752, K = Math.tan((Math.PI * f) / sr), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416), a0 = 1 + K / Q + K * K; return [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]; })();
    const hp = (() => { const f = 38.13547, Q = 0.5003270, K = Math.tan((Math.PI * f) / sr), a0 = 1 + K / Q + K * K; return [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]; })();
    const w = channels.map((c) => biquad(biquad(c, ...shelf), ...hp));
    const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), n = w[0].length, E = [];
    // Präfixsumme statt Neuberechnung je Block
    const P = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { let s = 0; for (const ch of w) s += ch[i] * ch[i]; P[i + 1] = P[i] + s; }
    for (let i = 0; i + block <= n; i += hop) E.push((P[i + block] - P[i]) / block);
    const L = (e) => -0.691 + 10 * Math.log10(e + 1e-15), mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const g1 = E.filter((e) => L(e) > -70); if (!g1.length) return -70;
    const thr = L(mean(g1)) - 10;
    return L(mean(g1.filter((e) => L(e) > thr)));
  }

  const api = { wsola, onsetNear, Limiter, loudness };
  if (typeof module !== 'undefined') module.exports = api; else root.DSP = api;
})(typeof window !== 'undefined' ? window : globalThis);
