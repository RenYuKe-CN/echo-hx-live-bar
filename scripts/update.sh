#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
git pull --ff-only
npm ci
npm run build
scripts/service.sh restart
curl --fail --silent --show-error "http://127.0.0.1:${PORT:-3001}/api/health" >/dev/null
echo "更新完成"
