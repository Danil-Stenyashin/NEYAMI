#!/usr/bin/env sh
# NEYAMI для macOS / Linux: ./start.sh
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Не найден Node.js — установите LTS с https://nodejs.org"; exit 1; }
node scripts/check-node.js || exit 1
[ -f data/neyami.db ] || node --disable-warning=ExperimentalWarning scripts/seed.js
exec node --disable-warning=ExperimentalWarning src/main.js --open
