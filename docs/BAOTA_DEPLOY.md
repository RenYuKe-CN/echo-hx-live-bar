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
npm ci
npm run build
```

也可以使用宝塔 Git 管理器克隆：仓库为 `https://github.com/RenYuKe-CN/echo-hx-live-bar.git`，分支为 `main`，目录为 `/www/wwwroot/echo-hx-live-bar`。

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

## 4. 添加 Node 项目

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

## 5. 创建网站

进入“网站 -> 添加站点”：

| 配置项 | 内容 |
| --- | --- |
| 域名 | `bar.example.com` |
| 根目录 | `/www/wwwroot/echo-hx-live-bar/dist` |
| PHP | 不需要 |
| 数据库 | 不需要 MySQL，本项目使用 SQLite |

## 6. 配置反向代理

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

## 7. 开启 HTTPS

在“网站 -> 设置 -> SSL”中选择 Let’s Encrypt，选择 `bar.example.com`，申请证书并开启“强制 HTTPS”。验证：

```bash
curl https://bar.example.com/api/health
```

必须返回 JSON，不能返回首页 HTML。

## 8. 设置目录权限

```bash
cd /www/wwwroot/echo-hx-live-bar
mkdir -p data logs backups
chown -R www:www data logs backups
chmod 750 data logs backups
```

如果宝塔 Node 项目运行用户不是 `www`，将命令中的 `www:www` 换成实际用户。不要删除 `data/`，其中包含营业数据库和商品图片。

## 9. 首次登录后台

打开 `https://bar.example.com/admin`。账号是 `admin`，密码是 `.env` 中的 `ADMIN_INITIAL_PASSWORD`。首次登录后立即修改密码，然后配置商品、库存、会员、储值、桌台二维码、管理员和店员权限。

## 10. 微信小程序配置

在微信公众平台配置 request、uploadFile、downloadFile 合法域名，均填写：

```text
https://bar.example.com
```

**首次正式发布必须修改一次小程序固定引导地址**：将 `miniprogram/utils/api.js` 中的 `BOOTSTRAP_API_URL` 从 `http://localhost:3001/api` 改为 `https://bar.example.com/api`，然后在微信开发者工具重新上传并提交审核。后台的 `public_api_base_url` 只控制启动后获取的目标 API 地址，不能改变已发布代码中的固定引导地址。以后切换目标地址可在后台修改，但引导域名必须持续可用，新旧域名都必须加入微信合法域名。`localhost` 只能用于开发工具本地调试。

“桌台管理”中的“预览 / 下载”会调用微信官方 `wxa/getwxacodeunlimit` 接口生成桌台专属小程序码。先在“接口配置”填写微信小程序 AppID、AppSecret，并确认小程序已经发布 `pages/menu/menu` 页面；配置 HTTPS 合法域名后即可下载 PNG 打印。二维码绑定桌台 ID，桌号改名后原二维码仍可使用。微信接口未配置或返回错误时，后台会显示具体错误，不会生成假二维码。

## 11. 宝塔计划任务

在“计划任务”添加每天 04:15 执行的 Shell 任务：

```bash
cd /www/wwwroot/echo-hx-live-bar && ./scripts/backup.sh >> logs/backup.log 2>&1
```

备份文件位于 `backups/`。上线后手动更新：

```bash
cd /www/wwwroot/echo-hx-live-bar
git pull --ff-only
npm ci
npm run build
```

然后在宝塔 Node 项目页面点击“重启”；如果使用 PM2，则执行 `pm2 restart echo-hx-live-bar-api`。

## 12. 常见问题

页面 502：执行 `curl http://127.0.0.1:3001/api/health`，确认 Node 项目运行、端口为 3001、代理目标正确。

出现 `Unexpected token '<'`：通常是 `/api` 被返回成前端 HTML。确认 Nginx 包含 `location /api/`，并执行 `curl https://bar.example.com/api/health`。

图片上传失败或数据库无法写入：检查 Node 项目运行用户对 `data/`、`data/uploads/`、`logs/` 有写权限，并确认没有启动两个 API 进程。

小程序提示合法域名错误：确认域名使用 HTTPS、已加入微信后台合法域名，并且公网访问 `/api/health` 返回 200。

## 13. 上线验收

- [ ] `https://bar.example.com/api/health` 返回 200 JSON
- [ ] `/admin` 可以登录，超级管理员密码已修改
- [ ] 商品图片上传、库存和下架正常
- [ ] 会员价、积分、储值和赠金计算正常
- [ ] 存酒登记和取酒正常
- [ ] 管理员和店员权限正常
- [ ] 宝塔自动备份任务执行成功
- [ ] 小程序合法域名已配置
- [ ] 微信登录、微信支付、美团和抖音核销已用真实资质联调
