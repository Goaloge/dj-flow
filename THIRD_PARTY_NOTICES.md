# Drittanbieter

## ffmpeg (LGPL)

Die Pakete (DMG, EXE, ZIP) enthalten ein eigenständiges `ffmpeg`-Programm. DJ FLOW startet es nur als externen Prozess zum Dekodieren von Audio und zum Umschreiben von FLAC-Tags und bindet es nicht in den eigenen Code ein. Alle Builds in den Releases sind **ohne** `--enable-gpl` und ohne `--enable-nonfree` gebaut und stehen unter der LGPL (v2.1 oder später). Der Workflow bricht ab, falls die Konfiguration eines dieser Flags enthält.

- **macOS:** schlanker Eigenbau aus dem unveränderten Quellcode von ffmpeg 6.1.1 (https://github.com/FFmpeg/FFmpeg/tree/n6.1.1), nur mit Decodern, ohne Encoder außer PCM. Das Build-Skript mit allen Optionen liegt in `build/ffmpeg-lgpl/build-mac.sh` in diesem Repository.
- **Windows:** LGPL-Build aus https://github.com/BtbN/FFmpeg-Builds (Release `autobuild-2026-11-21-12-37`, ffmpeg n8.1.3). Quellcode und Build-Skripte dort.
- Lizenztext der LGPL: https://www.gnu.org/licenses/lgpl-2.1.html, ffmpeg-Projekt: https://ffmpeg.org

Du kannst das mitgelieferte ffmpeg durch ein eigenes ersetzen (Datei `ffmpeg` im Ordner `Resources` der App bzw. `ffmpeg.exe` im Ressourcenordner).

DJ FLOW selbst steht unter der MIT-Lizenz (siehe LICENSE). Das gilt nicht für das mitgelieferte ffmpeg. Selbst gebaute Pakete mit einem anderen ffmpeg unterliegen dessen Lizenzen; ein Build mit `--enable-nonfree` darf nicht weitergegeben werden.

## npm-Pakete

`music-metadata`, `node-id3`, `@breezystack/lamejs` (LAME-Encoder, LGPL) sowie Electron (MIT) und deren Abhängigkeiten, jeweils unter ihren eigenen Lizenzen.
