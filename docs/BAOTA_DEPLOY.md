# Echo HX Live Bar 宝塔面板部署教程

本文适用于宝塔 Linux 面板。推荐使用宝塔 Node 项目管理器运行 API，Nginx 托管前端并反向代理 `/api`。

## 1. 安装软件

在宝塔“软件商店”安装 Nginx、Node.js 20+、Node 项目管理器或 PM2、Git、SQLite/sqlite3。服务器建议至少 2 GB 内存，域名应已解析到服务器公网 IP。

## 2. 克隆项目

打开宝塔终端执行：

```bash
mkdir -p /www/wwwroot
cd /www/wwwroot
git clone https://github.com/RenYuKe-CN/echo-hx-live-bar.git echo-hx-live-bar
cd /www/wwwroot/echo-hx-live-bar
bash scripts/manage.sh install
```

`install` 会检查 Node.js 版本、创建 `.env`（已存在则保留）、安装依赖并生成 `dist/`。请先按下文安装 Node.js 20+，再运行此命令；如果已经克隆了项目，直接进入项目目录运行即可。也可以使用宝塔 Git 管理器克隆：仓库为 `https://github.com/RenYuKe-CN/echo-hx-live-bar.git`，分支为 `main`，目录为 `/www/wwwroot/echo-hx-live-bar`。

## 3. 配置环境变量

```bash
cd /www/wwwroot/echo-hx-live-bar
cp .env.example .env
vi .env
```

至少填写：

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
DATA_DIR=./data
ADMIN_INITIAL_PASSWORD=设置一个至少10位的强密码
MINIPROGRAM_API_BASE_URL=https://bar.example.com/api
```

第三方配置可以写在 `.env`，也可以登录超级管理员后台填写。环境变量优先于后台配置。不要将 `.env`、私钥、数据库或上传图片提交到 GitHub。

## 4. 确认 Node.js 版本

在宝塔“软件商店 -> Node.js 版本管理”中安装并启用 Node.js 20、22 或更高版本。不要使用系统自带的 Node.js 12、14、16 或 18；本项目使用 ES 模块、可选链、`||=` 和 Node.js 内置 `fetch`，旧版本会在启动时出现 `Unexpected token '||='` 等语法错误。

在宝塔终端确认当前命令行版本：

```bash
node --version
which node
```

必须看到 `v20.x`、`v22.x` 或更高版本。如果宝塔 Node 项目管理器和终端使用的 Node 版本不同，应以 Node 项目管理器中选择的版本为准。

## 5. 添加 Node 项目

进入“网站 -> Node 项目 -> 添加 Node 项目”：

| 配置项 | 内容 |
| --- | --- |
| 项目名称 | `echo-hx-live-bar-api` |
| 项目路径 | `/www/wwwroot/echo-hx-live-bar` |
| 启动文件 | `server/index.js` |
| Node 版本 | 20 或更高 |
| 端口 | `3001` |
| 运行用户 | 通常为 `www` |

启动命令为 `node --env-file=.env server/index.js`（Node.js 20.6+），工作目录必须是项目根目录。宝塔面板不会自动读取 `.env`；如果所用 Node 版本或项目管理器不支持 `--env-file`，请在面板“环境变量”中逐项填写，并使用 `node server/index.js`。启动后执行：

```bash
curl http://127.0.0.1:3001/api/health
```

不要同时使用宝塔 Node 项目管理器和 PM2 管理同一个 API，否则会造成端口冲突。如果没有 Node 项目管理器，才使用 PM2：

```bash
cd /www/wwwroot/echo-hx-live-bar
npm install -g pm2
pm2 start server/index.js --name echo-hx-live-bar-api --node-args="--env-file=.env"
pm2 save
pm2 startup
```

## 6. 创建网站

进入“网站 -> 添加站点”：

| 配置项 | 内容 |
| --- | --- |
| 域名 | `bar.example.com` |
| 根目录 | `/www/wwwroot/echo-hx-live-bar/dist` |
| PHP | 不需要 |
| 数据库 | 不需要 MySQL，本项目使用 SQLite |

## 7. 配置反向代理

在网站设置的“反向代理”中将 `/api` 代理到 `http://127.0.0.1:3001`。如果面板版本配置不稳定，在 Nginx `server {}` 中加入：

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

保存后点击“重载配置”。

## 8. 开启 HTTPS

在“网站 -> 设置 -> SSL”中选择 Let’s Encrypt，选择 `bar.example.com`，申请证书并开启“强制 HTTPS”。验证：

```bash
curl https://bar.example.com/api/health
```

必须返回 JSON，不能返回首页 HTML。

## 9. 设置目录权限

```bash
cd /www/wwwroot/echo-hx-live-bar
mkdir -p data logs backups
chown -R www:www data logs backups
chmod 750 data logs backups
```

如果宝塔 Node 项目运行用户不是 `www`，将命令中的 `www:www` 换成实际用户。不要删除 `data/`，其中包含营业数据库和商品图片。

## 10. 首次登录后台

打开 `https://bar.example.com/admin`。账号是 `admin`，密码是 `.env` 中的 `ADMIN_INITIAL_PASSWORD`。首次登录后立即修改密码，然后配置商品、库存、会员、储值、桌台二维码、管理员和店员权限。

在“超级管理员后台 → 小程序页面”可以修改小程序内显示名称、首页欢迎标题和会员页入口名称/图标。保存后小程序下次打开会从服务端读取，无需重新上传审核；微信公众平台的主体名称仍需在微信官方后台维护。

## 11. 微信小程序配置

在微信公众平台配置 request 合法域名：

```text
https://bar.example.com
```

**首次正式发布必须修改一次小程序固定引导地址**：将 `miniprogram/utils/api.js` 中的 `BOOTSTRAP_API_URL` 从 `http://localhost:3001/api` 改为 `https://bar.example.com/api`，然后在微信开发者工具重新上传并提交审核。后台的 `public_api_base_url` 只控制启动后获取的目标 API 地址，不能改变已发布代码中的固定引导地址。以后切换目标地址可在后台修改，但引导域名必须持续可用，新旧域名都必须加入微信合法域名。`localhost` 只能用于开发工具本地调试。小程序启动后会调用微信登录接口，生产环境不再使用演示用户 ID。

“桌台管理”中的“预览 / 下载”会调用微信官方 `wxa/getwxacodeunlimit` 接口生成桌台专属小程序码。先在“接口配置”填写微信小程序 AppID、AppSecret，并确认小程序已经发布 `pages/menu/menu` 页面；配置 HTTPS 合法域名后即可下载 PNG 打印。二维码绑定桌台 ID，桌号改名后原二维码仍可使用。微信接口未配置或返回错误时，后台会显示具体错误，不会生成假二维码。

微信支付回调必须公网可访问：`https://bar.example.com/api/payments/wechat/notify`。后台接口配置中需要填写商户号、API v3 Key、商户证书序列号、商户私钥、平台证书或平台公钥和这个回调地址；只填写 AppID 不能完成支付。

## 12. 宝塔计划任务

在“计划任务”添加每天 04:15 执行的 Shell 任务：

```bash
cd /www/wwwroot/echo-hx-live-bar && ./scripts/backup.sh >> logs/backup.log 2>&1
```

备份文件位于 `backups/`。以后更新只需在宝塔终端运行：

```bash
cd /www/wwwroot/echo-hx-live-bar
bash scripts/manage.sh update
```

更新命令先备份数据库，再检查本地改动、快进获取 `origin/main`、安装依赖并重建 `dist/`。`.env`、`data/` 和图片不会被覆盖。默认按宝塔 Node 项目管理器托管处理，**更新完成后仍需到「网站 -> Node 项目」点击一次“重启”**；脚本不会另起一个 API 进程。若更新时提示有未提交改动，请先检查 `git status`，不要直接强制覆盖；若备份失败则会停止更新。

常用命令：

```bash
bash scripts/manage.sh version  # 当前提交版本
bash scripts/manage.sh history  # 最近 10 次提交
bash scripts/manage.sh status   # 面板模式提示 + API 健康检查
bash scripts/manage.sh --help   # 查看全部命令
```

如果 API **确实由 PM2 托管**，可以改用 `MANAGE_SERVICE=pm2 bash scripts/manage.sh update`，更新完成后脚本会重启已有的 `echo-hx-live-bar-api` 并检查健康状态；如果由项目自带 `scripts/service.sh` 托管，则使用 `MANAGE_SERVICE=script bash scripts/manage.sh update`。同一台服务器只能选择一种托管方式，不要同时用宝塔、PM2 和脚本启动 API。数据库结构升级可能不可逆，回退代码前应保存 `backups/` 中的数据库备份。

## 13. 常见问题

页面 502：执行 `curl http://127.0.0.1:3001/api/health`，确认 Node 项目运行、端口为 3001、代理目标正确。

出现 `Unexpected token '<'`：通常是 `/api` 被返回成前端 HTML。确认 Nginx 包含 `location /api/`，并执行 `curl https://bar.example.com/api/health`。

图片上传失败或数据库无法写入：检查 Node 项目运行用户对 `data/`、`data/uploads/`、`logs/` 有写权限，并确认没有启动两个 API 进程。

小程序提示合法域名错误：确认域名使用 HTTPS、已加入微信后台合法域名，并且公网访问 `/api/health` 返回 200。

## 14. 上线验收

- [ ] `https://bar.example.com/api/health` 返回 200 JSON
- [ ] `/admin` 可以登录，超级管理员密码已修改
- [ ] 商品图片上传、库存和下架正常
- [ ] 会员价、积分、储值和赠金计算正常
- [ ] 存酒登记和取酒正常
- [ ] 管理员和店员权限正常
- [ ] 宝塔自动备份任务执行成功
- [ ] 小程序合法域名已配置
- [ ] 微信登录、微信支付、美团和抖音核销已用真实资质联调
