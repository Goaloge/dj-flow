#!/bin/zsh
# Entwicklerstart: Electron-App aus dem Quellcode
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
npm start
