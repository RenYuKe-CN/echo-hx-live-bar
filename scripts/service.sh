#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/data/echo-hx-api.pid"
LOG_FILE="$ROOT_DIR/logs/api.log"
ENV_FILE="$ROOT_DIR/.env"

load_env() { [[ -f "$ENV_FILE" ]] && set -a && source "$ENV_FILE" && set +a; }
status() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }
start() {
  if status; then echo "服务已运行，PID $(cat "$PID_FILE")"; return; fi
  mkdir -p "$ROOT_DIR/data" "$ROOT_DIR/logs"
  load_env
  cd "$ROOT_DIR"
  nohup node server/index.js >>"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 1
  if ! status; then echo "服务启动失败，请查看 $LOG_FILE" >&2; rm -f "$PID_FILE"; exit 1; fi
  echo "服务已启动，PID $(cat "$PID_FILE")"
}
stop() {
  if ! status; then rm -f "$PID_FILE"; echo "服务未运行"; return; fi
  kill "$(cat "$PID_FILE")"
  for _ in {1..20}; do status || break; sleep 0.25; done
  if status; then kill -9 "$(cat "$PID_FILE")"; fi
  rm -f "$PID_FILE"
  echo "服务已停止"
}
case "${1:-status}" in
  start) start ;; stop) stop ;; restart) stop; start ;; status) status && echo "运行中，PID $(cat "$PID_FILE")" || echo "未运行" ;; *) echo "用法: $0 {start|stop|restart|status}"; exit 2 ;; esac
