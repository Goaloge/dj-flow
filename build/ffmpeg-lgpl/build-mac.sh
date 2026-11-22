#!/usr/bin/env bash
# Schlankes ffmpeg nur zum Dekodieren und Tags schreiben, LGPL (kein --enable-gpl, kein --enable-nonfree).
# Aufruf: build-mac.sh <ffmpeg-Quellordner> <Ausgabedatei>
set -euo pipefail
SRC="$1"; OUT="$2"
cd "$SRC"
./configure --disable-everything --disable-autodetect --disable-doc --disable-network \
  --disable-ffplay --disable-ffprobe --enable-ffmpeg --enable-small \
  --arch="${FF_ARCH:-arm64}" \
  --enable-protocol=file,pipe \
  --enable-demuxer=mp3,flac,wav,aiff,mov,ogg,aac,matroska,ape,w64 \
  --enable-decoder=mp3,mp3float,flac,aac,aac_latm,alac,vorbis,opus,ape,wavpack,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_u8,mjpeg,png \
  --enable-parser=mpegaudio,flac,aac,aac_latm,vorbis,opus,mjpeg,png \
  --enable-muxer=wav,flac,pcm_f32le,null \
  --enable-encoder=pcm_f32le \
  --enable-filter=aresample,aformat,anull,atrim,asetpts,volume \
  --enable-bsf=null
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" ffmpeg
cp ffmpeg "$OUT"; strip "$OUT" || true
"$OUT" -version | head -3
