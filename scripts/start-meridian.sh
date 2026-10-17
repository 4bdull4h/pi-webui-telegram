#!/usr/bin/env bash
# تشغيل وسيط Meridian المحلي لمزوّد Anthropic في Pi
set -euo pipefail
DIR="${MERIDIAN_DIR:-$HOME/.cache/opencode/packages/opencode-with-claude@latest}"
if [ ! -d "$DIR" ]; then
  echo "لم يُعثر على حزمة Meridian في: $DIR" >&2
  echo "ثبّتها بـ: npm install -g opencode-with-claude" >&2
  exit 1
fi
cd "$DIR"
exec env MERIDIAN_PORT="${MERIDIAN_PORT:-3456}" node node_modules/@rynfar/meridian/dist/cli.js "$@"
