#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

command -v node >/dev/null || { echo "需要 Node.js 20 或更高版本" >&2; exit 1; }
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 20) process.exit(1)' || { echo "需要 Node.js 20 或更高版本" >&2; exit 1; }

mkdir -p data logs
[[ -f .env ]] || cp .env.example .env
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
echo "使用 npm 源：$NPM_REGISTRY"
npm ci --include=dev --registry="$NPM_REGISTRY"
npm run build
chmod +x scripts/*.sh
echo "安装完成。请编辑 $ROOT_DIR/.env，然后在宝塔「网站 -> Node 项目」中托管并启动 server/index.js。"
echo "宝塔部署完整教程：$ROOT_DIR/docs/BAOTA_DEPLOY.md"
