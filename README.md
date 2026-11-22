# DJ FLOW

Set-Editor, Playlist-Generator, Tag-Editor und Mix-Analyzer für **Engine DJ**. Electron-App für macOS (Apple Silicon) und Windows x64, gebaut für elektronische Musik.

Version: **1.17.0** · Ausführliche Dokumentation: Obsidian-Vault, Ordner `DJ FLOW`.

## Starten und bauen

```bash
cd ~/"Claude Projekte/DJ Flow"
npm install        # nur beim ersten Mal
npm start          # App aus dem Quellcode
npm run serve      # ohne Electron, im Browser unter http://localhost:4747
npm test           # Kernlogik, DSP, Encoder
npm run dist:mac   # dist/DJ FLOW-<version>-arm64.dmg
npm run dist:win   # dist/DJ FLOW Setup <version>.exe und -win.zip
```

Die Pakete sind nicht signiert (nur Ad-hoc auf dem Mac). Beim ersten Start: Mac Rechtsklick → Öffnen, Windows „Weitere Informationen“ → „Trotzdem ausführen“. Windows ist gebaut, aber noch nie dort gestartet.

## Funktionen

| Bereich | Kurz |
|---|---|
| **Bibliothek** | Alle Engine Libraries auf allen Laufwerken, Smart Search (`8A 124-128 e>7`), „Passt danach“, Tag-Editor per ✎ oder `E` |
| **Playlist-Generator** | Genre, BPM, BPM-Rampe, Energiekurven, harmonischer Pfad |
| **Set-Builder** | Reihenfolge optimieren, Export als M3U8 oder Playlist direkt in Engine |
| **Mix-Lab** | Timeline mit zwei Decks und Sample-Spur, Übergänge (Mischart + mehrere Effekte, auch mitten im Song: Drop-Stile wie Drop-In, Double Drop, Echo/Roll/Spinback/Filter → Drop, ausgerichtet an Cues, Loops und Abschnitten), Stem-Mix, Effekte im Song, Automation, Tempo-Spur, Key Lock, EQ, Limiter, Lautstärke-Angleich, Undo/Redo, Export WAV/FLAC/MP3 |
| **Cues & Loops** | 8 + 8 je Track, Auto-Erkennung aus der Waveform, Zurückschreiben in die Engine-DB |
| **Stems** | Lokale Trennung mit Demucs in Drums, Bass, Melodie, Vocals |
| **Tag-Doktor** | Fehlende Tags, Auto-Fix, Tags schreiben für MP3, WAV, AIFF, FLAC, Duplikate in den Papierkorb legen und wieder aufnehmen |
| **Libraries** | Library wählen (auch die interne SSD eines Prime im Festplattenmodus), Playlists, Cue-/Loop-Status je Track, Auto-Cues & Loops für einzelne Tracks oder alle fehlenden, Ziel-Library frei wählbar |
| **Laufwerke** | Belegung, Engine Libraries, Tracks pro Laufwerk |

## Sicherheit der Daten

- Die Engine-DB wird nur lesend geöffnet, außer beim Schreiben von Playlists, Cues und Loops. Dann muss Engine DJ geschlossen sein, und vorher entsteht automatisch `m.db.djflow-backup-<Zeit>`.
- Tags werden in MP3, WAV, AIFF und FLAC geschrieben, immer über eine Kopie; das Audio bleibt unverändert. M4A wird nicht beschrieben. Danach in Engine „Reload Tags“.
- Gelöschte Duplikate landen im Papierkorb, nicht endgültig gelöscht.
- Gain, EQ, Fades, Effekte, Automation, Tempo und Übergänge gibt es nur in DJ FLOW und im Export, nicht in Engine.
- Die lokale API nimmt keine Anfragen fremder Webseiten an.

## Abhängigkeiten

- **Node ≥ 22.5** für das eingebaute `node:sqlite` (die App bringt Electron 45 mit Node 24 mit)
- **ffmpeg** zum Dekodieren: in den Paketen enthalten (`build/ffmpeg/`, ffmpeg-static b6.1.1). Im Entwicklungsstart wird ein installiertes ffmpeg genutzt. Ohne ffmpeg fällt die App auf den Browser zurück, der bei manchen MP3s den Anfang verliert und dann neben dem Engine-Beatgrid liegt. Lizenz vor einer Weitergabe klären.
- **Stems:** `uv` oder Python 3.10 bis 3.12 und Internet bei der Einrichtung (bis ca. 2 GB). Demucs 4.1.0, PyTorch 2.7.1, läuft auf dem Apple-Grafikchip, sonst auf der CPU.
- npm-Pakete: `music-metadata`, `node-id3`, `@breezystack/lamejs`

## Aufbau

| Datei | Inhalt |
|---|---|
| `electron/main.js` | App-Fenster, Datenordner, Server-Start |
| `server.js` | Lokaler HTTP-Server und API, Audio-Streaming, Export-Annahme |
| `lib/engine.js` | Engine-DB lesen, Waveform/Beatgrid decodieren, Playlists und Cues schreiben |
| `lib/cues.js` | Codec für Hot Cues und Loops, Auto-Erkennung |
| `lib/playlist.js` | Mix-Score, Generator, Optimierer, M3U |
| `lib/tags.js` | Tags lesen und schreiben |
| `lib/encoders.js` | WAV, FLAC, MP3 als Stream |
| `lib/decode.js` | Dekodierung mit ffmpeg |
| `lib/stems.js` | Demucs-Umgebung und Trenn-Warteschlange |
| `lib/libtools.js` | Playlists, Cue-Status, Auto-Cues für ganze Libraries |
| `lib/platform.js` | Unterschiede macOS/Windows |
| `public/app.js` | Bibliothek, Generator, Set-Builder, Tag-Doktor, Laufwerke |
| `public/mixlab.js` | Mix-Lab |
| `public/libraries.js` | Tab Libraries |
| `public/dsp.js`, `public/limiter-worklet.js` | Zeitdehnung, Transienten, Limiter, Lautheit |
| `test/` | `smoke.js`, `encoders.js`, `tags.js` |

## Datenorte

- **App:** macOS `~/Library/Application Support/dj-flow/data`, Windows `%APPDATA%\dj-flow\data`
- **Entwicklungsstart:** `data/` im Projektordner
- **Stems:** `DJ FLOW Stems/` auf dem Laufwerk des Tracks (auf der Systemplatte im Datenordner)
- **Exporte und M3U:** `~/Music/DJ FLOW Playlists/`

## Pakete selbst bauen

`dist/` und die ffmpeg-Programme (`build/ffmpeg/`) liegen nicht im Repository. Zum Bauen der Pakete mit `npm run dist:mac` bzw. `npm run dist:win` die ffmpeg-Programme (z.B. ffmpeg-static) hier ablegen: `build/ffmpeg/mac/ffmpeg` und `build/ffmpeg/win/ffmpeg.exe`. Zum Entwickeln mit `npm start` genügt ein installiertes ffmpeg.

## Lizenz

Noch nicht festgelegt (`UNLICENSED`): Alle Rechte liegen beim Autor. ffmpeg steht unter eigener Lizenz, die vor einer Weitergabe der Pakete zu beachten ist.
