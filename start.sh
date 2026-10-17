#!/usr/bin/env bash
# تشغيل مساعد Pi (واجهة ويب + تيليجرام)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules/@earendil-works/pi-coding-agent ]; then
  node scripts/setup.mjs
fi

exec node src/index.js "$@"
