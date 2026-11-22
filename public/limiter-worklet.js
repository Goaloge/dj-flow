// Summen-Limiter im Audio-Thread, gleicher Code wie im Export
class DjfLimiter extends AudioWorkletProcessor {
  constructor() {
    super(); this.lim = new DSP.Limiter(sampleRate); this.on = true; this.n = 0; this.peak = 1;
    this.port.onmessage = (e) => { this.on = e.data.on; };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0], l = out[0], r = out[1] || out[0];
    if (inp.length) { l.set(inp[0]); r.set(inp[1] || inp[0]); } else { l.fill(0); r.fill(0); }
    if (this.on) { this.lim.process(l, r); this.peak = Math.min(this.peak, this.lim.gain); }
    if (++this.n >= 12) { this.port.postMessage({ gain: this.on ? this.peak : 1 }); this.n = 0; this.peak = 1; }
    return true;
  }
}
registerProcessor('djf-limiter', DjfLimiter);
