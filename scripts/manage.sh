#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'HELP'
用法: bash scripts/manage.sh <命令>
  install   首次安装依赖、构建前端并生成 .env（不覆盖已有配置）
  update    备份数据库、从 origin/main 快进更新、安装依赖并构建
  version   查看当前版本与远程版本
  history   查看最近 10 次提交
  status    查看服务状态及 API 健康状态
  start     启动 API（仅 script 或 pm2 模式）
  stop      停止 API（仅 script 或 pm2 模式）
  restart   重启 API（仅 script 或 pm2 模式）

服务模式: MANAGE_SERVICE=panel（默认，宝塔面板手动重启）|script|pm2
PM2 项目名: MANAGE_PM2_NAME=echo-hx-live-bar-api
HELP
}

require_node() {
  command -v node >/dev/null || { echo '请先安装 Node.js 20 或更高版本' >&2; exit 1; }
  node scripts/check-node.mjs
  command -v npm >/dev/null || { echo '未找到 npm，请检查宝塔终端使用的 Node 版本' >&2; exit 1; }
}

npm_install() {
  local registry="${NPM_REGISTRY:-https://registry.npmmirror.com}"
  echo "使用 npm 源：$registry"
  npm ci --include=dev --registry="$registry"
}

service_mode() {
  case "${MANAGE_SERVICE:-panel}" in
    panel|script|pm2) ;;
    *) echo 'MANAGE_SERVICE 仅支持 panel、script 或 pm2' >&2; exit 2 ;;
  esac
}

service_action() {
  local action="$1" name="${MANAGE_PM2_NAME:-echo-hx-live-bar-api}"
  service_mode
  case "${MANAGE_SERVICE:-panel}" in
    panel)
      if [[ "$action" == status ]]; then
        echo '服务由宝塔 Node 项目管理器托管；请在宝塔查看进程状态。'
      else
        echo '服务由宝塔托管，请到「网站 -> Node 项目」手动启动/停止/重启。不要同时使用脚本启动。'
      fi
      ;;
    script) bash scripts/service.sh "$action" ;;
    pm2)
      command -v pm2 >/dev/null || { echo '未找到 pm2，请在宝塔终端安装或改用 panel 模式' >&2; exit 1; }
      case "$action" in
        start)
          if pm2 describe "$name" >/dev/null 2>&1; then pm2 start "$name";
          else pm2 start server/index.js --name "$name" --node-args="--env-file=.env"; fi
          ;;
        *) pm2 "$action" "$name" ;;
      esac
      ;;
  esac
}

health() {
  local port="${PORT:-3001}"
  if [[ -f .env ]]; then
    local configured
    configured="$(sed -nE 's/^[[:space:]]*PORT=([0-9]+)[[:space:]]*$/\1/p' .env | tail -1)"
    port="${configured:-$port}"
  fi
  curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${port}/api/health" || return 1
  echo
}

case "${1:-help}" in
  install)
    require_node
    mkdir -p data logs
    if [[ ! -f .env ]]; then cp .env.example .env; echo '已创建 .env，请检查并填写正式配置。'; fi
    npm_install
    npm run build
    echo "安装完成，前端目录：$ROOT_DIR/dist"
    echo '请在宝塔创建 Node 项目和静态网站，参见 docs/BAOTA_DEPLOY.md。'
    ;;
  update)
    require_node
    command -v git >/dev/null || { echo '未找到 git' >&2; exit 1; }
    git fetch origin main
    if [[ -n "$(git status --porcelain)" ]]; then
      if git diff --quiet origin/main -- . && git diff --cached --quiet; then
        git reset --hard origin/main >/dev/null
        echo '服务器存在与 origin/main 内容一致的残留改动，已自动同步清理。'
      else
        echo '项目含未提交改动；为保护服务器本地修改，更新已停止。请先检查 git status。' >&2
        exit 1
      fi
    fi
    current_branch="$(git branch --show-current)"
    if [[ "$current_branch" != main ]]; then
      if git show-ref --verify --quiet refs/heads/main; then
        git switch main
      else
        git switch --create main --track origin/main
      fi
      echo "已将当前分支${current_branch:+ $current_branch}切换为 main"
    fi
    echo "更新前版本：$(git rev-parse --short HEAD)"
    if [[ -f data/echo-hx.sqlite ]]; then
      command -v sqlite3 >/dev/null || { echo '请先安装 sqlite3 以备份营业数据库' >&2; exit 1; }
      bash scripts/backup.sh
    fi
    git merge --ff-only origin/main
    npm_install
    npm run build
    echo "更新后版本：$(git rev-parse --short HEAD)"
    service_action restart
    if [[ "${MANAGE_SERVICE:-panel}" != panel ]]; then health; fi
    echo '数据与配置位于 data/ 和 .env，更新不会覆盖。数据库升级可能不可逆，回退代码前请先备份数据。'
    ;;
  version)
    git log -1 --format='当前版本：%h %s (%ci)'
    if git rev-parse --verify refs/remotes/origin/main >/dev/null 2>&1; then
      echo "本地记录的远程版本：$(git rev-parse --short origin/main)（执行 update 时才会刷新）"
    fi
    ;;
  history) git log -10 --date=short --pretty=format:'%h %ad %s%n' ;;
  status)
    service_action status
    health || echo 'API 暂不可访问；请查看宝塔 Node 项目日志和反向代理配置。' >&2
    ;;
  start|stop|restart)
    service_action "$1"
    ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
