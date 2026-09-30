# Echo HX Live Bar 宝塔部署教程

本文按“全新服务器 + 宝塔面板”编写。整套服务只使用一种托管方式：

- 宝塔 Node 项目管理器运行 API
- 宝塔网站的 Nginx 托管 `dist/` 并反向代理 `/api/`
- SQLite 保存业务数据

不要再同时使用 PM2、`scripts/service.sh` 和宝塔 Node 项目启动同一个 API，否则会出现端口冲突。

## 一、宝塔安装软件

在“软件商店”安装：

1. Nginx
2. Node.js 版本管理器或 Node.js 项目管理器
3. Git
4. SQLite 或 `sqlite3`

在 Node.js 版本管理器中安装并启用 **Node.js 20 LTS 或 22 LTS**。本项目要求 Node.js 20 及以上，Node.js 12、14、16、18 都不能使用。

服务器需要一个已经解析到服务器 IP 的域名，并开放 80、443 端口。API 的 3001 端口只允许本机访问，不需要对公网开放。

## 二、首次安装项目

打开宝塔“终端”，复制执行以下命令：

```bash
cd /www/wwwroot
git clone https://github.com/RenYuKe-CN/echo-hx-live-bar.git echo-hx-live-bar
cd /www/wwwroot/echo-hx-live-bar

# 防止宝塔遗留的错误 npm 源影响安装
npm config set registry https://registry.npmmirror.com --global
npm config delete init.module --global 2>/dev/null || true

# 安装依赖、创建 .env、构建前端
bash scripts/manage.sh install
```

安装成功后必须存在以下文件：

```text
/www/wwwroot/echo-hx-live-bar/dist/index.html
/www/wwwroot/echo-hx-live-bar/dist/assets/
```

如果要使用 npm 官方源，可以把安装命令替换为：

```bash
NPM_REGISTRY=https://registry.npmjs.org bash scripts/manage.sh install
```

不要把 `https://mirrors.tuna.tsinghua.edu.cn/nodejs-release` 或其他 Node.js 下载镜像地址配置成 npm registry。npm registry 必须是 npm 包仓库地址。

## 三、填写服务器配置

安装脚本会自动创建 `.env`，没有创建时可手动执行：

```bash
cd /www/wwwroot/echo-hx-live-bar
cp .env.example .env
```

打开 `.env`，至少确认这些内容：

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
DATA_DIR=./data
ADMIN_INITIAL_PASSWORD=请替换成至少10位的强密码
MINIPROGRAM_API_BASE_URL=https://你的域名/api
```

保存后不要把 `.env` 提交到 GitHub。微信支付、微信登录、美团、抖音等密钥可以在超级管理员后台填写；密钥只保存在服务器，不要写进小程序代码。

## 四、在宝塔添加 Node 项目

进入“网站 -> Node 项目 -> 添加 Node 项目”，填写：

| 配置项 | 内容 |
| --- | --- |
| 项目名称 | `echo-hx-live-bar-api` |
| 项目路径 | `/www/wwwroot/echo-hx-live-bar` |
| 启动文件 | `server/index.js` |
| Node 版本 | 20 或 22 |
| 端口 | `3001` |
| 运行用户 | 通常为 `www` |

工作目录必须是项目根目录。Node 项目管理器若支持启动参数，可使用：

```text
node --env-file=.env server/index.js
```

如果面板不支持 `--env-file`，就在 Node 项目的“环境变量”中逐项填写 `.env` 内容，启动文件仍填 `server/index.js`。

点击启动后，在宝塔终端检查 API：

```bash
curl http://127.0.0.1:3001/api/health
```

应返回 JSON。若返回连接失败，先看“网站 -> Node 项目”的运行日志；若返回 HTML，说明请求没有到 API 进程。

## 五、创建前端网站

进入“网站 -> 添加站点”，填写：

| 配置项 | 内容 |
| --- | --- |
| 域名 | 你的正式域名，例如 `bar.example.com` |
| 根目录 | `/www/wwwroot/echo-hx-live-bar/dist` |
| PHP | 不需要 |
| 数据库 | 不需要 MySQL，项目使用 SQLite |

如果找不到 `dist` 目录，说明第二步没有成功执行 `npm run build`。回到项目目录重新运行：

```bash
cd /www/wwwroot/echo-hx-live-bar
bash scripts/manage.sh install
```

## 六、配置 Nginx 反向代理

进入这个网站的“设置 -> 配置文件”，在 `server {}` 内确认有以下配置。已有同名配置时保留一份即可：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
}

location / {
    try_files $uri $uri/ /index.html;
}
```

保存并重载 Nginx。`/api/` 必须使用更具体的匹配，避免 API 请求被返回前端首页。

## 七、开启 HTTPS

进入“网站 -> 设置 -> SSL”，申请 Let’s Encrypt 证书并开启强制 HTTPS。然后检查：

```bash
curl https://你的域名/api/health
```

必须返回 200 JSON，不能返回 `index.html` 内容。

给 API 数据目录设置权限。以下以 Node 项目运行用户 `www` 为例：

```bash
cd /www/wwwroot/echo-hx-live-bar
mkdir -p data logs backups
chown -R www:www data logs backups
chmod 750 data logs backups
```

如果 Node 项目运行用户不是 `www`，将命令中的 `www:www` 换成面板实际运行用户。

## 八、首次登录和微信配置

打开：

```text
https://你的域名/admin
```

账号为 `admin`，初始密码是 `.env` 中的 `ADMIN_INITIAL_PASSWORD`。首次登录后立即修改密码。

然后在超级管理员后台配置商品、库存、会员、储值、桌台、账号权限和第三方接口。

微信小程序还需要：

1. 在微信公众平台把 `你的域名` 加入 request 合法域名。
2. 将 `miniprogram/utils/api.js` 中的 `BOOTSTRAP_API_URL` 改为 `https://你的域名/api`。
3. 在微信开发者工具重新上传小程序代码。
4. 在后台填写微信小程序 AppID、AppSecret、微信支付商户号、API v3 Key、证书和回调配置。

只填写 AppID 不能完成微信登录或微信支付。桌台二维码使用微信官方接口生成，也需要有效的 AppID 和 AppSecret。

微信支付回调地址为：

```text
https://你的域名/api/payments/wechat/notify
```

美团、抖音核销也必须在后台填写对应平台分配的正式应用信息，并按照平台后台要求配置回调或白名单。

## 九、日常更新：只需要一条命令

发布新版本后，在宝塔终端执行：

```bash
cd /www/wwwroot/echo-hx-live-bar
bash scripts/manage.sh update
```

脚本会自动：

- 备份 SQLite 数据库
- 从 GitHub 获取 `main` 分支最新代码
- 安装锁定版本依赖和开发依赖
- 重新构建 `dist/`
- 保留 `.env`、`data/` 和上传图片

命令完成后，进入“网站 -> Node 项目”，点击 `echo-hx-live-bar-api` 的“重启”。前端文件已经更新，API 需要这一次重启加载新代码。

更新前不要在服务器直接改项目源代码。如果提示工作区有未提交改动，先查看：

```bash
git status
```

脚本会停止更新以保护本地改动，不要直接执行强制覆盖命令。

## 十、数据库备份和恢复

手动备份：

```bash
cd /www/wwwroot/echo-hx-live-bar
bash scripts/backup.sh
```

备份文件位于 `backups/`。可以在宝塔“计划任务”添加每天一次的 Shell 任务：

```bash
cd /www/wwwroot/echo-hx-live-bar && bash scripts/backup.sh >> logs/backup.log 2>&1
```

不要删除 `data/`，其中包含营业数据库和商品图片。

## 十一、常见问题

### `vite: command not found`

通常是没有安装开发依赖，或使用了错误的 Node/npm 环境。确认 Node.js 为 20 或 22，然后执行：

```bash
cd /www/wwwroot/echo-hx-live-bar
npm config set registry https://registry.npmmirror.com --global
npm ci --include=dev
npm run build
```

### `npm ci` 提示缺少 lockfile

当前仓库已包含 `package-lock.json`。如果服务器目录不是通过 Git 克隆的完整仓库，请重新克隆；不要在生产机删除 lockfile 后随意安装。

### npm 报 `404 ... nodejs-release ... vite`

这是 npm 源配置错误。修复：

```bash
npm config set registry https://registry.npmmirror.com --global
npm config delete init.module --global 2>/dev/null || true
npm ci --include=dev
```

### `Unexpected token '||='`

运行的仍是旧 Node.js。切换宝塔 Node.js 版本到 20 或 22，并确认终端和 Node 项目管理器使用的是同一个版本。

### 更新提示“更新仅支持 main 分支”

新版更新脚本会在服务器工作区干净时自动把 `master` 或 detached HEAD 切换到 `main`。如果服务器使用的是旧版脚本，或者目录中有本地改动，请先检查：

```bash
cd /www/wwwroot/echo-hx-live-bar
git status
git branch --show-current
```

确认没有需要保留的本地代码改动后，可以执行一次：

```bash
git fetch origin main
git switch --create main --track origin/main
bash scripts/manage.sh update
```

如果 `git status` 显示有改动，不要直接删除或强制切换；先备份 `.env`、`data/` 和本地改动，再处理。`.env` 和 `data/` 不应通过 Git 管理。

### 页面 502

执行：

```bash
curl http://127.0.0.1:3001/api/health
```

若失败，查看 Node 项目日志；若成功，检查 Nginx 的 `/api/` 代理、端口和 SSL 配置。

### 出现 `Unexpected token '<'`

这表示前端把 HTML 当作 API JSON 解析。优先检查：

```bash
curl -i https://你的域名/api/health
```

如果响应是 HTML，修正 Nginx `/api/` 反向代理，不要修改前端 JSON 解析逻辑。

## 十二、上线检查清单

- [ ] Node 项目使用 Node.js 20 或 22
- [ ] `https://你的域名/api/health` 返回 JSON
- [ ] `/admin` 可以登录并已修改初始密码
- [ ] 商品图片上传、库存和自动下架正常
- [ ] 会员价、积分、储值和赠金计算正常
- [ ] 存酒登记、取酒和过期规则正常
- [ ] 管理员、店员和操作日志权限正常
- [ ] 小程序 request 合法域名已配置
- [ ] 小程序代码中的 `BOOTSTRAP_API_URL` 已改为 HTTPS
- [ ] 微信登录、微信支付、美团、抖音已使用真实资质联调
- [ ] 宝塔计划任务能够生成数据库备份
