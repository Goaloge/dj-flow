// Streaming-Encoder für den Set-Export: WAV (24 Bit), FLAC (24 Bit), MP3 (320 kBit/s). Eingabe: Float32 L/R.
'use strict';
const fs = require('fs');

const clamp = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);

class WavWriter {
  constructor(file, sr) { this.fd = fs.openSync(file, 'w'); this.sr = sr; this.bytes = 0; fs.writeSync(this.fd, Buffer.alloc(44)); }
  write(L, R) {
    const b = Buffer.alloc(L.length * 6);
    for (let i = 0, o = 0; i < L.length; i++, o += 6) {
      b.writeIntLE(Math.round(clamp(L[i]) * 8388607), o, 3); b.writeIntLE(Math.round(clamp(R[i]) * 8388607), o + 3, 3);
    }
    fs.writeSync(this.fd, b); this.bytes += b.length;
  }
  end() {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + this.bytes, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(this.sr, 24); h.writeUInt32LE(this.sr * 6, 28); h.writeUInt16LE(6, 32); h.writeUInt16LE(24, 34); h.write('data', 36); h.writeUInt32LE(this.bytes, 40);
    fs.writeSync(this.fd, h, 0, 44, 0); fs.closeSync(this.fd);
  }
}

class Mp3Writer {
  constructor(file, sr, Mp3Encoder) { this.fd = fs.openSync(file, 'w'); this.enc = new Mp3Encoder(2, sr, 320); }
  write(L, R) {
    const conv = (a) => { const o = new Int16Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.round(clamp(a[i]) * 32767); return o; };
    const l = conv(L), r = conv(R);
    for (let i = 0; i < l.length; i += 1152) {
      const d = this.enc.encodeBuffer(l.subarray(i, i + 1152), r.subarray(i, i + 1152));
      if (d.length) fs.writeSync(this.fd, Buffer.from(d));
    }
  }
  end() { const d = this.enc.flush(); if (d.length) fs.writeSync(this.fd, Buffer.from(d)); fs.closeSync(this.fd); }
}

// ---- FLAC: feste Prädiktoren + Rice-Codierung ----
const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i; for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; CRC8[i] = c;
  let d = i << 8; for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff; CRC16[i] = d;
}
class Bits {
  constructor(cap) { this.b = Buffer.alloc(cap); this.n = 0; this.cur = 0; this.k = 0; }
  put(v, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(v / 2 ** i) & 1);
      if (++this.k === 8) { this.b[this.n++] = this.cur; this.cur = 0; this.k = 0; }
    }
  }
  signed(v, bits) { this.put(v < 0 ? v + 2 ** bits : v, bits); }
  zeros(c) { for (; c >= 8 && this.k === 0; c -= 8) this.b[this.n++] = 0; this.put(0, c % 32); for (c -= c % 32; c > 0; c -= 32) this.put(0, 32); }
  align() { if (this.k) this.put(0, 8 - this.k); }
}
const BLOCK = 4096;
class FlacWriter {
  constructor(file, sr) {
    this.fd = fs.openSync(file, 'w'); this.sr = sr; this.frame = 0; this.total = 0; this.maxFrame = 0;
    this.L = new Int32Array(BLOCK); this.R = new Int32Array(BLOCK); this.fill = 0;
    fs.writeSync(this.fd, Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(38)]));
  }
  write(L, R) {
    for (let i = 0; i < L.length; i++) {
      this.L[this.fill] = Math.round(clamp(L[i]) * 8388607); this.R[this.fill] = Math.round(clamp(R[i]) * 8388607);
      if (++this.fill === BLOCK) { this.flushFrame(BLOCK); this.fill = 0; }
    }
  }
  subframe(w, s, n) {
    // beste Ordnung 0..4 nach Residuen-Summe
    const res = [Int32Array.from(s.subarray(0, n))];
    for (let o = 1; o <= 4; o++) { const p = res[o - 1], r = new Int32Array(n); for (let i = o; i < n; i++) r[i] = p[i] - p[i - 1]; res.push(r); }
    let order = 0, best = Infinity;
    for (let o = 0; o <= 4 && o < n; o++) { let sum = 0; for (let i = o; i < n; i++) sum += Math.abs(res[o][i]); if (sum < best) { best = sum; order = o; } }
    const r = res[order], m = Math.max(1, n - order);
    let k = 0; const mean = best / m; while (k < 29 && 2 ** (k + 1) < mean * 1.4 + 1) k++;
    w.put(0, 1); w.put(8 + order, 6); w.put(0, 1);
    for (let i = 0; i < order; i++) w.signed(s[i], 24);
    w.put(1, 2); w.put(0, 4); w.put(k, 5); // RICE2: 24-Bit-Residuen brauchen große Parameter
    for (let i = order; i < n; i++) {
      const u = r[i] >= 0 ? r[i] * 2 : -r[i] * 2 - 1, q = Math.floor(u / 2 ** k);
      w.zeros(q); w.put(1, 1); if (k) w.put(u % 2 ** k, k);
    }
  }
  flushFrame(n) {
    const w = new Bits(n * 16 + 64);
    w.put(0xfff8, 16);
    const srCode = this.sr === 44100 ? 9 : this.sr === 48000 ? 10 : this.sr === 96000 ? 11 : 0;
    w.put(n === BLOCK ? 12 : 7, 4); w.put(srCode, 4); w.put(1, 4); w.put(6, 3); w.put(0, 1);
    // Framenummer UTF-8-codiert
    const f = this.frame++;
    if (f < 0x80) w.put(f, 8);
    else if (f < 0x800) { w.put(0xc0 | (f >> 6), 8); w.put(0x80 | (f & 63), 8); }
    else if (f < 0x10000) { w.put(0xe0 | (f >> 12), 8); w.put(0x80 | ((f >> 6) & 63), 8); w.put(0x80 | (f & 63), 8); }
    else { w.put(0xf0 | (f >> 18), 8); w.put(0x80 | ((f >> 12) & 63), 8); w.put(0x80 | ((f >> 6) & 63), 8); w.put(0x80 | (f & 63), 8); }
    if (n !== BLOCK) w.put(n - 1, 16);
    let c8 = 0; for (let i = 0; i < w.n; i++) c8 = CRC8[c8 ^ w.b[i]];
    w.put(c8, 8);
    this.subframe(w, this.L, n); this.subframe(w, this.R, n);
    w.align();
    let c16 = 0; for (let i = 0; i < w.n; i++) c16 = ((c16 << 8) & 0xffff) ^ CRC16[(c16 >> 8) ^ w.b[i]];
    w.put(c16, 16);
    fs.writeSync(this.fd, w.b, 0, w.n);
    this.maxFrame = Math.max(this.maxFrame, w.n); this.total += n;
  }
  end() {
    if (this.fill) this.flushFrame(this.fill);
    const w = new Bits(38);
    w.put(0x80 | 0, 8); w.put(34, 24); // letzter Metadatenblock, STREAMINFO
    w.put(BLOCK, 16); w.put(BLOCK, 16); w.put(0, 24); w.put(this.maxFrame, 24);
    w.put(this.sr, 20); w.put(1, 3); w.put(23, 5); w.put(Math.floor(this.total / 2 ** 32), 4); w.put(this.total % 2 ** 32, 32);
    w.put(0, 32); w.put(0, 32); w.put(0, 32); w.put(0, 32); // MD5 nicht gesetzt (laut Format erlaubt)
    fs.writeSync(this.fd, w.b, 0, 38, 4); fs.closeSync(this.fd);
  }
}

const FORMATS = { wav: WavWriter, mp3: Mp3Writer, flac: FlacWriter };
async function create(format, file, sr) {
  if (format === 'mp3') { const { Mp3Encoder } = await import('@breezystack/lamejs'); return new Mp3Writer(file, sr, Mp3Encoder); }
  if (!FORMATS[format]) throw new Error('Unbekanntes Format');
  return new FORMATS[format](file, sr);
}
module.exports = { FORMATS, create };
