#!/usr/bin/env bash
# ============================================================
#  مدير خادم مساعد Pi
#  الاستخدام:
#    ./server.sh start [خيارات]   تشغيل في الخلفية (مع مشرف تلقائي)
#    ./server.sh stop             إيقاف
#    ./server.sh restart [خيارات] إعادة تشغيل
#    ./server.sh status           الحالة
#    ./server.sh logs             متابعة السجل
#    ./server.sh run [خيارات]     تشغيل في المقدمة (بدون مشرف)
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
HEALTH_URL="http://127.0.0.1:${PORT:-8787}/health"

mkdir -p "$RUN_DIR"

# حلقة المشرف: تعيد تشغيل Node عند الخروج برمز غير صفري
# (رمز 75 = إعادة تشغيل مطلوبة من الواجهة/تيليجرام، و0 = إيقاف طبيعي)
SUPERVISOR='
ROOT="$1"; LOG="$2"; NODE="$3"; shift 3
export PI_SUPERVISED=1
while true; do
  "$NODE" "$ROOT/src/index.js" "$@" >>"$LOG" 2>&1
  code=$?
  echo "[supervisor $(date +%F_%T)] node exited with code $code" >>"$LOG"
  if [ "$code" -eq 0 ]; then break; fi
  sleep 2
done
'

usage() {
  cat <<EOF
مدير خادم مساعد Pi

  ./server.sh start [--no-telegram]   تشغيل الخادم في الخلفية
  ./server.sh stop                    إيقاف الخادم
  ./server.sh restart                 إعادة التشغيل
  ./server.sh status                  عرض الحالة
  ./server.sh logs                    متابعة السجل (Ctrl+C للخروج)
  ./server.sh run                     تشغيل في المقدمة

الملفات: $RUN_DIR
EOF
}

pid_of() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || true
}

is_running() {
  local pid
  pid="$(pid_of)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

wait_health() {
  local tries="${1:-40}"
  for ((i = 0; i < tries; i++)); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

cmd_start() {
  if is_running; then
    echo "الخادم يعمل بالفعل (PID $(pid_of))."
    return 0
  fi
  if [ -z "$NODE_BIN" ]; then
    echo "خطأ: لم يتم العثور على node في PATH." >&2
    return 1
  fi
  rm -f "$PID_FILE"
  : >"$LOG_FILE"

  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c "$SUPERVISOR" _ "$ROOT" "$LOG_FILE" "$NODE_BIN" "$@" >>"$LOG_FILE" 2>&1 &
  else
    nohup bash -c "$SUPERVISOR" _ "$ROOT" "$LOG_FILE" "$NODE_BIN" "$@" >>"$LOG_FILE" 2>&1 &
  fi
  local pid=$!
  echo "$pid" >"$PID_FILE"
  echo "جارٍ التشغيل (PID $pid)…"

  if wait_health 60; then
    echo "✅ الخادم يعمل: http://localhost:${PORT:-8787}"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "❌ فشل التشغيل. راجع السجل: $LOG_FILE" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    return 1
  fi
  echo "⚠️  العملية تعمل لكن فحص الصحة لم يستجب بعد. راجع: ./server.sh logs"
  return 0
}

cmd_stop() {
  if ! is_running; then
    echo "الخادم متوقف بالفعل."
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(pid_of)"
  echo "جارٍ الإيقاف (PID $pid)…"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for ((i = 0; i < 30; i++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "إجبار الإيقاف…"
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  echo "✅ تم الإيقاف."
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start "$@"
}

cmd_status() {
  if is_running; then
    echo "الحالة   : يعمل ✅"
    echo "PID      : $(pid_of)"
    echo "الويب    : http://localhost:${PORT:-8787}"
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      echo "الصحة    : سليم"
    else
      echo "الصحة    : لا يستجيب بعد"
    fi
  else
    echo "الحالة   : متوقف ⛔"
  fi
  echo "السجل    : $LOG_FILE"
}

cmd_logs() {
  touch "$LOG_FILE"
  tail -n 100 -f "$LOG_FILE"
}

cmd_run() {
  exec "$NODE_BIN" "$ROOT/src/index.js" "$@"
}

cmd="${1:-start}"
shift || true
case "$cmd" in
  start) cmd_start "$@" ;;
  stop) cmd_stop ;;
  restart) cmd_restart "$@" ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  run | fg | foreground) cmd_run "$@" ;;
  -h | --help | help) usage ;;
  *) usage; exit 1 ;;
esac
