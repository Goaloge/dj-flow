// ID3-/Tag-Bearbeitung: Lesen (alle Formate via music-metadata), Schreiben (MP3 via node-id3)
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const NodeID3 = require('node-id3');

let mm;
async function readTags(file) {
  mm ??= await import('music-metadata');
  const m = await mm.parseFile(file, { skipCovers: false, duration: false });
  const c = m.common;
  const pic = c.picture?.[0];
  return {
    title: c.title || null, artist: c.artist || null, album: c.album || null,
    genre: c.genre?.[0] || null, year: c.year || null, bpm: c.bpm || null,
    key: c.key || null, label: c.label?.[0] || null, comment: c.comment?.[0]?.text || c.comment?.[0] || null,
    remixer: c.remixer?.[0] || null, trackNo: c.track?.no || null,
    cover: pic ? `data:${pic.format};base64,${Buffer.from(pic.data).toString('base64')}` : null,
    format: m.format.container, codec: m.format.codec, bitrate: m.format.bitrate,
  };
}

const WRITABLE = ['title', 'artist', 'album', 'genre', 'year', 'bpm', 'key', 'label', 'comment', 'remixer'];

function id3Frames(t, base = {}) {
  const tags = { ...base };
  if (t.title != null) tags.title = String(t.title);
  if (t.artist != null) tags.artist = String(t.artist);
  if (t.album != null) tags.album = String(t.album);
  if (t.genre != null) tags.genre = String(t.genre);
  if (t.year != null) tags.year = String(t.year);
  if (t.bpm != null && t.bpm !== '') tags.bpm = String(Math.round(Number(t.bpm)));
  if (t.key != null) tags.initialKey = String(t.key);
  if (t.label != null) tags.publisher = String(t.label);
  if (t.remixer != null) tags.remixArtist = String(t.remixer);
  if (t.comment != null) tags.comment = { language: 'ger', text: String(t.comment) };
  return tags;
}

/** Datei über eine Kopie ersetzen: erst fertig schreiben, dann umbenennen */
function replaceVia(file, write) {
  const tmp = file + '.djflow-tmp' + path.extname(file);
  try { write(tmp); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/** WAV und AIFF: ID3-Block als eigener Chunk (RIFF: "id3 ", little endian; AIFF: "ID3 ", big endian) */
function writeChunkId3(file, t) {
  const buf = fs.readFileSync(file), riff = buf.toString('latin1', 0, 4) === 'RIFF', form = buf.toString('latin1', 0, 4) === 'FORM';
  if (!riff && !form) throw new Error('Unbekanntes Dateiformat');
  const rd = (o) => (riff ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const keep = []; let old = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('latin1', o, o + 4), size = rd(o + 4), end = Math.min(buf.length, o + 8 + size + (size & 1));
    if (id.toLowerCase() === 'id3 ') old = buf.subarray(o + 8, o + 8 + size); else keep.push(buf.subarray(o, end));
    o = end;
  }
  // vorhandenen Tag aktualisieren statt neu bauen: unbekannte Felder (z.B. TXXX von Mixed In Key) bleiben erhalten
  const tag = old ? NodeID3.update(id3Frames(t), Buffer.from(old)) : NodeID3.create(id3Frames(t));
  if (!Buffer.isBuffer(tag)) throw new Error('ID3 konnte nicht geschrieben werden');
  const head = Buffer.alloc(8);
  head.write(riff ? 'id3 ' : 'ID3 ', 0, 'latin1');
  if (riff) head.writeUInt32LE(tag.length, 4); else head.writeUInt32BE(tag.length, 4);
  const pad = tag.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  const body = Buffer.concat([buf.subarray(8, 12), ...keep, head, tag, pad]), top = Buffer.alloc(8);
  top.write(riff ? 'RIFF' : 'FORM', 0, 'latin1');
  if (riff) top.writeUInt32LE(body.length, 4); else top.writeUInt32BE(body.length, 4);
  replaceVia(file, (tmp) => fs.writeFileSync(tmp, Buffer.concat([top, body])));
}

/** FLAC über ffmpeg: Audio, Cover und alle vorhandenen Kommentare werden 1:1 übernommen */
function writeFfmpeg(file, t, ext) {
  const ff = require('./decode').find();
  if (!ff) throw new Error('ffmpeg nicht gefunden');
  const m = [];
  const put = (k, v) => { if (v != null && v !== '') m.push('-metadata', `${k}=${v}`); };
  put('title', t.title); put('artist', t.artist); put('album', t.album); put('genre', t.genre); put('date', t.year); put('comment', t.comment);
  const lost = [];
  if (ext === '.flac') { put('BPM', t.bpm != null && t.bpm !== '' ? Math.round(Number(t.bpm)) : null); put('INITIALKEY', t.key); put('KEY', t.key); /* beide Namen sind verbreitet */ put('LABEL', t.label); put('REMIXER', t.remixer); }
  replaceVia(file, (tmp) => execFileSync(ff, ['-v', 'error', '-nostdin', '-y', '-i', file, '-map', '0', '-c', 'copy', '-map_metadata', '0', ...m, tmp], { stdio: 'pipe' }));
  return lost;
}

// M4A bewusst nicht: ffmpeg verliert beim Umschreiben vorhandene Felder (gemessen: BPM, freie iTunes-Felder)
const WRITE_FORMATS = ['.mp3', '.wav', '.aif', '.aiff', '.flac'];
/** Schreibt Tags; gibt Felder zurück, die das Format nicht speichern kann */
function writeTags(file, t) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mp3') {
    const res = NodeID3.update(id3Frames(t), file);
    if (res !== true) throw res instanceof Error ? res : new Error('ID3 konnte nicht geschrieben werden');
    return [];
  }
  if (ext === '.wav' || ext === '.aif' || ext === '.aiff') { writeChunkId3(file, t); return []; }
  if (ext === '.flac') return writeFfmpeg(file, t, ext);
  throw new Error('Tags schreiben wird für ' + ext + ' nicht unterstützt');
}

/** Infos aus dem Dateinamen raten: "Artist - Title (Mix) - 11A - 128.mp3" / "01-artist_-_title-xyz.mp3" */
function guessFromFilename(filename) {
  let base = path.basename(filename, path.extname(filename)).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const out = {};
  const km = base.match(/\s-\s(\d{1,2}[AB])\s-\s(\d{2,3}(?:\.\d+)?)$/i);
  if (km) { out.key = km[1].toUpperCase(); out.bpm = Number(km[2]); base = base.slice(0, km.index); }
  base = base.replace(/^\d{1,3}\s*[-.]\s*/, '').replace(/-[a-z0-9]{2,6}$/i, '');
  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) { out.artist = parts[0].trim(); out.title = parts.slice(1).join(' - ').trim(); } else out.title = base;
  return out;
}

// Genre-Heuristik für elektronische Musik anhand BPM (als Vorschlag, wenn Genre fehlt)
function suggestGenre(bpm) {
  if (!bpm) return null;
  if (bpm < 100) return 'Downtempo';
  if (bpm < 118) return 'Deep House';
  if (bpm < 126) return 'House';
  if (bpm < 131) return 'Tech House';
  if (bpm < 136) return 'Techno';
  if (bpm < 141) return 'Trance';
  if (bpm < 150) return 'Psytrance';
  if (bpm < 165) return 'Hard Techno';
  return 'Drum & Bass';
}

module.exports = { WRITE_FORMATS, readTags, writeTags, guessFromFilename, suggestGenre, WRITABLE };
