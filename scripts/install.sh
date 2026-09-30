#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v node >/dev/null || { echo "需要 Node.js 20 或更高版本" >&2; exit 1; }
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 20) process.exit(1)' || { echo "需要 Node.js 20 或更高版本" >&2; exit 1; }

mkdir -p data logs
[[ -f .env ]] || cp .env.example .env
npm ci --include=dev
npm run build
chmod +x scripts/*.sh
echo "安装完成。请编辑 $ROOT_DIR/.env，然后运行：sudo $ROOT_DIR/scripts/service.sh start"
