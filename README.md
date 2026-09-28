# Echo HX Live Bar

使用宝塔面板部署请阅读：[宝塔面板部署教程](docs/BAOTA_DEPLOY.md)。

酒吧点单、会员、储值、存酒和运营管理系统，包含顾客端、微信小程序、管理后台、收银点单、库存、报表、SQLite 数据库和 GitHub 部署脚本。

> 本文以 Ubuntu 22.04/24.04 为例。微信支付、微信登录、美团/抖音核销仍需真实商户资质和平台联调。

## 一、服务器要求

需要公网服务器、域名、HTTPS 证书、Node.js 20+、npm、Git、Nginx、sqlite3。建议至少 2 GB 内存。开放 22、80、443 端口，3001 只允许本机访问。

## 二、安装服务器

```bash
ssh root@你的服务器公网IP
apt update
apt install -y git nginx sqlite3 curl ca-certificates build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version
npm --version
```

推荐使用独立用户：

```bash
adduser --system --group --home /var/www/echo-hx-live-bar echohx
mkdir -p /var/www
chown -R echohx:echohx /var/www
su -s /bin/bash echohx
```

## 三、获取代码并安装

```bash
git clone https://github.com/RenYuKe-CN/echo-hx-live-bar.git /var/www/echo-hx-live-bar
cd /var/www/echo-hx-live-bar
./scripts/install.sh
```

安装脚本会检查 Node.js、创建 `data/` 和 `logs/`、生成 `.env`、执行 `npm ci` 和 `npm run build`。

## 四、配置环境变量

```bash
nano /var/www/echo-hx-live-bar/.env
```

至少设置：

```env
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
DATA_DIR=./data
ADMIN_INITIAL_PASSWORD=设置一个至少10位的强密码
MINIPROGRAM_API_BASE_URL=https://api.example.com/api
```

第三方密钥可以放在 `.env`，也可以在超级管理员后台填写。环境变量优先于后台配置：

```env
WECHAT_APP_ID=
WECHAT_APP_SECRET=
WECHAT_MCH_ID=
WECHAT_API_V3_KEY=
WECHAT_MERCHANT_SERIAL=
WECHAT_PRIVATE_KEY=
WECHAT_NOTIFY_URL=https://api.example.com/api/wechat/pay/notify
MEITUAN_CLIENT_ID=
MEITUAN_CLIENT_SECRET=
DOUYIN_CLIENT_KEY=
DOUYIN_CLIENT_SECRET=
```

微信私钥可以填写 PEM 内容（换行使用 `\\n`），也可以填写服务器上的私钥文件路径。不要把 `.env`、私钥、数据库或上传文件提交到 GitHub。

## 五、启动 API

```bash
cd /var/www/echo-hx-live-bar
./scripts/service.sh start
./scripts/service.sh status
curl http://127.0.0.1:3001/api/health
```

服务管理：

```bash
./scripts/service.sh start
./scripts/service.sh stop
./scripts/service.sh restart
./scripts/service.sh status
tail -f logs/api.log
```

## 六、Nginx 和 HTTPS

先将域名 A 记录指向服务器公网 IP，例如 `api.example.com -> 服务器公网 IP`。

```bash
cp deploy/nginx.conf.example /etc/nginx/sites-available/echo-hx-live-bar
nano /etc/nginx/sites-available/echo-hx-live-bar
ln -s /etc/nginx/sites-available/echo-hx-live-bar /etc/nginx/sites-enabled/echo-hx-live-bar
nginx -t
systemctl reload nginx
apt install -y certbot python3-certbot-nginx
certbot --nginx -d api.example.com
curl https://api.example.com/api/health
```

把模板中的 `server_name example.com` 改成实际域名。Nginx 托管 `dist/`，并把 `/api/` 代理到 `http://127.0.0.1:3001`。不要把 3001 暴露到公网。

## 七、后台首次配置

打开 `https://api.example.com/admin`。首次账号为 `admin`，密码为 `.env` 中的 `ADMIN_INITIAL_PASSWORD`。如果没有设置，首次启动时会在 `logs/api.log` 打印随机密码。

登录后立即修改超级管理员密码，然后完成：

1. 在“接口配置”填写或检查小程序 API 正式 HTTPS 地址。
2. 点击“检查配置”。
3. 设置商品、库存、图片、会员等级、积分规则和储值活动。
4. 配置桌台二维码。
5. 创建管理员、店员账号并分配权限。
6. 使用测试会员验证点单、余额、赠金、存酒和取酒流程。

## 八、微信小程序配置

在微信公众平台配置 request、uploadFile、downloadFile 合法域名：

```text
https://api.example.com
```

小程序启动时会访问 `GET /api/runtime-config`，读取后台配置的 `public_api_base_url` 并缓存。因此调整 API 域名时不需要手动编辑 `miniprogram/utils/api.js`，但旧引导地址仍必须可访问，新旧地址都必须加入微信合法域名。`localhost` 只能用于开发工具本地调试。

使用微信开发者工具打开仓库中的 `miniprogram/` 目录；正式发布前将 `miniprogram/project.config.json` 的 AppID 换成真实 AppID，然后上传、审核、发布。

## 九、第三方接口上线边界

微信登录需要完成 `wx.login`、服务端 code 换 openid、登录 token、手机号授权和会员绑定。生产环境不能使用演示用户 ID，否则存在冒用余额风险。

微信支付需要完成统一下单、`wx.requestPayment`、回调验签解密、重复回调幂等、支付取消/超时、库存结算、积分结算和退款处理。支付金额必须由服务端重新计算。

美团和抖音需要完成商户授权、门店绑定、券码查询、核销、重复核销拦截、撤销/退款、套餐映射和日志联调。后台配置项只保存凭证，不等于真实核销已接通。

## 十、日常更新和备份

```bash
cd /var/www/echo-hx-live-bar
./scripts/backup.sh
./scripts/update.sh
```

更新脚本会执行 `git pull --ff-only`、`npm ci`、`npm run build`、重启服务并检查 API 健康状态。数据库是 `data/echo-hx.sqlite`，图片在 `data/uploads/`，备份在 `backups/`。

每天凌晨自动备份：

```bash
crontab -e
```

```cron
15 4 * * * cd /var/www/echo-hx-live-bar && ./scripts/backup.sh >> logs/backup.log 2>&1
```

建议将重要备份同步到另一台服务器或对象存储。

## 十一、故障排查

```bash
tail -100 logs/api.log
./scripts/service.sh status
ss -lntp | grep 3001
curl http://127.0.0.1:3001/api/health
nginx -t
```

小程序提示合法域名错误时，确认 HTTPS、DNS、微信后台合法域名，以及公网访问 `https://你的域名/api/health`。数据库权限错误：

```bash
chown -R echohx:echohx /var/www/echo-hx-live-bar/data
chown -R echohx:echohx /var/www/echo-hx-live-bar/logs
```

## 十二、本地开发

```bash
npm install
npm run dev
```

- 顾客端：<http://localhost:5173/>
- 管理后台：<http://localhost:5173/admin>
- API 健康检查：<http://localhost:3001/api/health>
- 小程序目录：`miniprogram/`

## 十三、GitHub 版本管理

```bash
git pull --ff-only
git status
git add .
git commit -m "描述本次修改"
git push origin main
```

不要提交 `.env`、`data/`、`backups/`、`logs/`、生产数据库、微信支付私钥和其他密钥。

GitHub：<https://github.com/RenYuKe-CN/echo-hx-live-bar>
