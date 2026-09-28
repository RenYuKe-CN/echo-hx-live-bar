#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$ROOT_DIR/backups"
mkdir -p "$BACKUP_DIR"
if [[ -f "$ROOT_DIR/data/echo-hx.sqlite" ]]; then
  sqlite3 "$ROOT_DIR/data/echo-hx.sqlite" ".backup '$BACKUP_DIR/echo-hx-$STAMP.sqlite'"
else
  echo "数据库尚未创建，跳过备份"
fi
find "$BACKUP_DIR" -type f -name '*.sqlite' -mtime +30 -delete
echo "备份完成: $BACKUP_DIR/echo-hx-$STAMP.sqlite"
