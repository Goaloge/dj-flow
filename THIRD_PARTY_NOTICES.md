# Drittanbieter

## ffmpeg

Die Pakete (DMG, EXE, ZIP) enthalten ein eigenständiges `ffmpeg`-Programm, das DJ FLOW nur als externen Prozess zum Dekodieren von Audio aufruft. Es wird nicht in den Code von DJ FLOW eingebunden.

- Die Releases auf GitHub nutzen die Binaries des npm-Pakets `ffmpeg-static` 5.2.0 (ffmpeg 6.1.1, Builds von eugeneware/ffmpeg-static). Diese Builds sind GPL-Builds (`--enable-gpl`).
- Lizenz: GPL v3 (bzw. v2 oder später je nach Build), Text: https://www.gnu.org/licenses/gpl-3.0.html
- Quellcode von ffmpeg: https://ffmpeg.org/download.html (Version 6.1.1) und https://github.com/eugeneware/ffmpeg-static
- Projektseite: https://ffmpeg.org

DJ FLOW selbst steht unter der MIT-Lizenz (siehe LICENSE). Das gilt nicht für das mitgelieferte ffmpeg.

Pakete, die du selbst mit einem eigenen ffmpeg baust, unterliegen den Lizenzen dieses ffmpeg. Ein Build mit `--enable-nonfree` darf nicht weitergegeben werden.

## npm-Pakete

`music-metadata`, `node-id3`, `@breezystack/lamejs` (LAME-Encoder, LGPL) sowie Electron (MIT) und deren Abhängigkeiten, jeweils unter ihren eigenen Lizenzen.
