#!/usr/bin/env bash
# إعادة تشغيل مساعد Pi بعد تحديث الإعدادات أو الكود
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data

# استخدم نفس Node الذي يستخدمه Pi SDK (Node 22+). Node 20 لا يدعم globSync.
NODE_BIN="${PI_NODE_BIN:-/home/asus/.local/share/pi-node/current/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi
PORT_VALUE="${PORT:-8787}"

health_ok() {
  curl -fsS --max-time 2 "http://127.0.0.1:${PORT_VALUE}/health" >/dev/null 2>&1
}

# ابحث عن نسخة تعمل من هذا المجلد
current_pids=()
supervisor_pid=""
for pid in $(pgrep -f "src/index.js" || true); do
  cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
  if [ "${cwd}" != "${PWD}" ]; then
    continue
  fi
  comm="$(ps -o comm= -p "${pid}" 2>/dev/null | tr -d ' ' || true)"
  if [ "${comm}" != "node" ] && [ "${comm}" != "nodejs" ]; then
    continue
  fi
  current_pids+=("${pid}")
  ppid="$(ps -o ppid= -p "${pid}" 2>/dev/null | tr -d ' ' || true)"
  if [ -n "${ppid}" ]; then
    parent_cmd="$(ps -o cmd= -p "${ppid}" 2>/dev/null || true)"
    if echo "${parent_cmd}" | grep -q "PI_SUPERVISED"; then
      supervisor_pid="${ppid}"
    fi
  fi
done

if [ "${#current_pids[@]}" -gt 0 ]; then
  if [ -n "${supervisor_pid}" ]; then
    echo "إعادة التشغيل عبر المشرف (PID ${supervisor_pid})…"
    for pid in "${current_pids[@]}"; do
      kill -9 "${pid}" 2>/dev/null || true
    done
    for _ in $(seq 1 30); do
      sleep 1
      if health_ok; then
        echo "تمت إعادة التشغيل بنجاح."
        exit 0
      fi
    done
    echo "لم تعد الخدمة للعمل خلال 30 ثانية. راجع .run/server.log" >&2
    exit 1
  fi
  echo "إيقاف النسخة الحالية…"
  for pid in "${current_pids[@]}"; do
    kill "${pid}" 2>/dev/null || true
  done
  sleep 2
  for pid in "${current_pids[@]}"; do
    kill -9 "${pid}" 2>/dev/null || true
  done
fi

nohup "${NODE_BIN}" src/index.js "$@" > data/server.log 2>&1 &
echo $! > data/server.pid
sleep 1
if health_ok; then
  echo "تم التشغيل (PID $(cat data/server.pid)). السجل: data/server.log"
else
  echo "فشل التشغيل. راجع data/server.log" >&2
  exit 1
fi
