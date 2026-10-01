# Echo HX Live Bar

使用宝塔面板部署请阅读：[宝塔面板部署教程](docs/BAOTA_DEPLOY.md)。

宝塔快速安装与更新：全新服务器先安装 Node.js 20/22、Nginx、Git、SQLite 和宝塔 Node 项目管理器，然后在项目目录执行 `bash scripts/manage.sh install`；以后只需执行 `bash scripts/manage.sh update`，再到宝塔 Node 项目页面点击“重启”。更新脚本会自动备份服务器本地代码改动，不会因为 Git 工作区不干净而直接中断；脚本默认使用 `https://registry.npmmirror.com` 安装 npm 依赖，自动保留 `.env` 和 `data/`。完整步骤见上面的宝塔教程。

酒吧点单、会员、储值、存酒和运营管理系统，包含顾客端、微信小程序、管理后台、收银点单、库存、报表、SQLite 数据库和 GitHub 部署脚本。

> 本文以 Ubuntu 22.04/24.04 为例。微信支付、微信登录、美团/抖音核销仍需真实商户资质和平台联调。

## 项目功能

Echo HX Live Bar 是面向酒吧、餐吧和 live house 场景的点单与会员运营系统，包含顾客端、微信小程序、收银与店员后台、超级管理员后台以及 Node.js API 服务。项目支持本地预览、服务器部署和后续通过 GitHub 更新。

### 顾客端与微信小程序

- **桌台扫码点单**：每个桌台生成专属微信小程序码，顾客扫码后自动绑定桌号；同一桌允许多人同时进入并加入同一桌台订单。
- **商品浏览**：按分类浏览商品，查看商品图片、简介、售价、会员折后价和剩余库存；库存为 0 的商品自动下架，前端和服务端同时限制超库存下单。
- **购物车与订单预览**：支持增加、减少和取消商品，支付前查看商品图片、名称、数量、原价、会员优惠、优惠金额、实付金额和订单备注。
- **同桌分次支付**：同桌商品可由任意一位顾客统一支付，也可以在订单清空后继续扫码购买；支付完成后订单进入“待送达”，由店员确认送达后完成。
- **待支付订单**：未支付订单支持继续支付或取消；订单创建后显示 10 分钟倒计时，超时自动取消并释放预占库存和冻结余额。
- **会员中心**：显示头像、昵称、手机号、会员等级、等级有效期、钱包余额、赠金余额和积分；普通会员不显示会员到期日。
- **会员优惠**：会员支付时根据等级应用对应折扣，页面同时显示划线原价、绿色会员价、优惠金额和实付金额；普通会员可以看到升级会员的提示，但不会误显示为已享受会员价。
- **订单记录**：订单状态使用中文展示，查看商品清单、桌号、支付方式、支付金额、优惠金额、备注和配送/送达状态。
- **钱包与充值**：查看储值余额和赠金余额，选择后台配置的储值套餐在线充值；套餐的实付金额、储值金额和赠金分别记录。
- **支付方式**：支持微信支付、余额支付及余额与微信支付组合支付，默认优先使用可用余额；扣款优先使用赠金，再使用储值余额。商品和套餐可分别配置是否允许赠金支付。
- **积分体系**：消费按规则获得积分，可进入兑换中心兑换现有商品或后台创建的自定义奖品；兑换奖品支持图标、名称、所需积分和库存配置。
- **存酒**：查看本人仍有存酒的商品、数量和到期时间；存酒取完后不再显示。后台登记时按商品和数量记录，不要求逐瓶扫码。
- **动态页面配置**：小程序名称、首页欢迎标题、会员页入口名称和图标可由超级管理员修改，配置从服务端读取，减少因修改运营文案而重新提交前端代码的需要。

### 管理后台

后台已按运营工作流整理为 6 组主入口，具体页面由账号权限控制：

- **经营概览**：实时查看今日营业额、净销售额、净利润、充值收款、线下收款、订单商品成本、赠酒报损成本、桌台总数、营业桌台和空闲桌台，并通过运营提醒跳转到待处理页面。
- **小程序页面**：配置小程序名称、首页标题、会员页入口的名称与图标等可运营内容。
- **收银点单**：管理员或获授权店员可按桌号和手机号点单，选择商品、会员价、备注和支付方式；支持现金、商家收款码人工确认、余额、微信支付及储值套餐充值。
- **订单管理**：接收新支付订单，查看顾客、桌号、商品清单、订单备注、支付明细和利润；店员处理送达，订单完成后进入历史记录。
- **桌台管理**：新增、编辑、删除桌台，查看桌台状态，生成和下载微信小程序码。删除有历史订单的桌台时保留历史关联，避免破坏历史数据。
- **会员管理**：按手机号搜索和管理会员，查看或调整头像、昵称、手机号、会员等级、等级有效期、储值余额、赠金余额、积分和消费记录，并处理储值、存酒等业务。
- **存酒管理**：按手机号查找会员，选择现有商品和数量登记存酒；填写存放天数后由服务端根据提交时间计算到期日；支持取酒，已全部取出的记录不再出现在当前列表。
- **团购核销**：保留团购套餐和核销记录管理入口，可记录门店线下核销结果；美团、抖音真实券码查询和核销需完成对应平台开放权限及接口联调后启用。
- **商品与库存**：统一管理商品名称、分类、图片、简介、售价、各会员等级折扣价、进货成本、库存、上下架状态及赠金支付规则；库存调整、售罄自动下架和补货提醒均有记录。
- **储值活动**：创建储值套餐，分别配置顾客实付金额、储值金额和赠金金额；充值后两类余额分账记录，赠金不作为营收，也不能参与不允许赠金的优惠或商品支付。
- **积分兑换**：绑定已有商品或创建自定义奖品，配置图标、名称、兑换积分、库存和上下架状态。
- **数据报表**：按当天、近 7 天、近 30 天、当月或自定义日期范围查看每日经营数据，展示净销售额、净利润、充值收款、线下收款、商品成本和赠酒报损成本；提供净销售额柱状图、净利润折线图和日期范围导出。
- **赠酒报损**：店员提交赠酒或报损申请并填写原因，系统按商品进货成本扣减库存和利润，超级管理员可审核和查看明细。
- **账号管理**：支持超级管理员、管理员和店员三级账号。超级管理员拥有全部权限，可配置管理员和店员可访问模块；管理员和店员只能操作被授权的页面与动作。
- **操作日志**：记录账号登录、商品库存、订单、支付、充值、存酒、取酒、赠酒报损、配置和账号权限等关键操作，超级管理员可查询审计。
- **接口配置**：配置小程序 AppID/AppSecret、微信支付商户参数、支付证书和回调地址，以及团购平台凭证和服务端正式 API 地址。敏感配置应优先使用服务器环境变量并妥善保管。

### 核心业务规则

- 价格由服务端根据商品、会员等级、优惠规则和支付余额重新计算，前端显示只用于预览，不能作为最终扣款依据。
- 余额分为**储值金额**和**赠金**两个账户。赠金使用时不计入营业收入；利润按实际计入营收的支付金额减去商品成本计算，赠酒/报损按成本计入成本。
- 待支付订单会冻结计划使用的余额，支付成功后正式扣除，取消或 10 分钟超时后释放；库存预占、支付回调和重复请求均由服务端处理，避免少扣、重复扣款和超卖。
- 线上支付完成后订单先进入待送达，不会直接标记为完成；店员确认送达后才完成订单并进入经营统计。
- 库存为 0 时服务端自动下架商品并生成补货提醒，后台处理补货后可重新上架。
- 手机号是会员业务的主要检索依据；微信登录获得的用户信息与手机号绑定到同一会员档案。

### 技术组成

- **顾客网页预览**：仅用于本地开发浏览器预览点单流程和会员界面；正式部署时网站根路径关闭，顾客只能从微信小程序点单。
- **微信小程序**：位于 `miniprogram/`，可使用微信开发者工具打开、预览和上传审核。
- **管理后台**：位于 `src/`，包含经营、收银、会员、库存、订单、报表和系统配置页面。
- **后端 API**：Node.js 服务，主要路由位于 `server/`，负责认证、权限、业务校验、支付、库存、报表和 SQLite 数据持久化。
- **数据与文件**：默认使用 SQLite 数据库；商品图片和上传文件位于 `data/uploads/`，生产环境应纳入备份策略。

### 已实现与上线前仍需完成

本项目已经提供微信登录和微信支付的基础官方 API 调用、支付回调验签解密、余额混合支付、桌台小程序码生成、后台配置和业务流程。正式上线前仍需使用真实小程序 AppID、微信支付商户号、证书和 HTTPS 域名完成联调，并按微信要求配置合法域名。

美团和抖音目前完成的是后台配置项、内部套餐/核销记录和业务入口，**尚未声称已完成真实平台券码查询与核销**。要正式使用，仍需申请对应生活服务开放平台权限、绑定门店、取得接口凭证，并根据平台审核结果完成签名、回调和生产环境联调。

## 一、服务器要求（非宝塔手工部署）

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

安装脚本会检查 Node.js、创建 `data/` 和 `logs/`、生成 `.env`、执行 `npm ci --include=dev` 和 `npm run build`。

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
WECHAT_NOTIFY_URL=https://api.example.com/api/payments/wechat/notify
MEITUAN_CLIENT_ID=
MEITUAN_CLIENT_SECRET=
DOUYIN_CLIENT_KEY=
DOUYIN_CLIENT_SECRET=
```

微信私钥可以填写 PEM 内容（换行使用 `\\n`），也可以填写服务器上的私钥文件路径。不要把 `.env`、私钥、数据库或上传文件提交到 GitHub。

### 文件上传与对象存储

未配置对象存储时默认使用 `local`，商品图片和会员头像保存到 `DATA_DIR/uploads/`，也就是默认的 `data/uploads/`。运行 Node 项目的账号必须拥有该目录的读写权限。超级管理员也可以在“接口配置”中填写对象存储参数，将**后续新上传**的图片切换到腾讯云 COS、MinIO、AWS S3 或其他 S3 兼容服务。为了允许后台切换，`.env` 中不要固定写 `STORAGE_PROVIDER=local`；留空即可：

```env
STORAGE_PROVIDER=
STORAGE_ENDPOINT=https://your-s3-endpoint
STORAGE_REGION=auto
STORAGE_BUCKET=your-bucket
STORAGE_ACCESS_KEY=
STORAGE_SECRET_KEY=
STORAGE_PUBLIC_BASE_URL=
STORAGE_PATH_PREFIX=uploads/
```

`STORAGE_ENDPOINT` 是服务端上传和私有读取使用的 S3 API 地址，`STORAGE_PUBLIC_BASE_URL` 是已经配置公开读权限的文件访问地址，可留空。留空时系统通过服务端签名代理读取对象，不要求 Bucket 公开。后台保存对象存储配置后，后续上传会立即使用新的 provider；如果同时在 `.env` 中填写了 endpoint、密钥等敏感项，环境变量仍优先。切换对象存储后请先上传一张测试图片；历史 `data/uploads/` 文件不会自动迁移，迁移前应先备份。

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

### 小程序名称和首页标题

进入“超级管理员后台 → 小程序页面”，可以直接修改小程序内显示名称、首页欢迎标题，以及会员页的“兑换中心、我的存酒、会员充值、我的订单”名称和图标。配置保存在服务端，顾客端下次打开时自动读取，不需要为改文案重新提交微信审核。微信公众平台中的小程序主体名称、认证名称仍需在微信官方后台修改。

### 桌台小程序码

进入“桌台管理”，每个桌台点击“预览 / 下载”。服务端会按微信官方接口 `wxa/getwxacodeunlimit` 生成 PNG，二维码场景使用桌台 ID（例如 `t_12`），小程序扫码后会调用服务端解析桌台并进入对应桌台点单。桌号后续改名不会让已打印的小程序码失效。

生成前需要在微信公众平台完成：小程序已绑定真实 AppID、AppSecret 有效、`pages/menu/menu` 已加入小程序页面，并把 API 域名配置为 HTTPS 合法域名。然后在超级管理员“接口配置”填写“微信小程序 AppID”和“微信小程序 AppSecret”，保存后即可生成。未配置或微信接口返回错误时，后台会显示具体错误，不会生成演示二维码。

小程序码正式使用前仍需上传并发布小程序。可以在超级管理员“接口配置”中设置“桌台二维码环境版本”：开发者工具中未发布的代码使用 `develop`，已上传但未正式发布的体验版使用 `trial`，正式线上版本使用 `release`。也可以通过环境变量 `WECHAT_MINIPROGRAM_ENV_VERSION` 设置；环境变量优先级高于后台配置。

微信小程序码接口业务失败时也可能返回 HTTP 200，判断标准是响应是否为有效 PNG，而不是只看 HTTP 状态码。服务端会把微信返回的错误码、错误消息、环境版本和页面路径显示在后台。若提示 `41030`，重点检查 `pages/menu/menu` 是否存在于对应版本；若提示凭证相关错误，检查 AppID 和 AppSecret 是否属于同一个小程序；开发版/体验版二维码则必须使用对应的 `develop`/`trial` 环境版本。

## 八、微信小程序配置

在微信公众平台配置 request、uploadFile、downloadFile 合法域名：

```text
https://api.example.com
```

小程序启动时会访问 `GET /api/runtime-config`，读取后台配置的 `public_api_base_url` 并缓存。因此调整 API 域名时不需要手动编辑 `miniprogram/utils/api.js`，但旧引导地址仍必须可访问，新旧地址都必须加入微信合法域名。`localhost` 只能用于开发工具本地调试。

首页首次进入时会在当前小程序页面显示官方授权弹层。头像昵称使用微信当前官方组件 `button open-type="chooseAvatar"` 和 `input type="nickname"`，手机号使用用户点击后的 `button open-type="getPhoneNumber"`；不会跳转到独立资料页，也不会在没有用户点击的情况下静默获取真实资料。`wx.login` 只负责换取登录凭证和 openid，不会直接返回头像、昵称或手机号。上述头像、昵称组件要求微信小程序基础库至少为 `2.21.2`，手机号授权也必须用按钮事件返回的一次性 `detail.code`，不能复用 `wx.login` 的 code。会员页的“资料设置”仅用于后续修改。线上必须把同一个 HTTPS API 主域名同时加入 request、uploadFile、downloadFile 三项，例如 `https://api.example.com`，不要填写 `https://api.example.com/api`，也不要填写具体接口路径。

小程序头像上传接口是 `POST /api/me/avatar`，后台商品图片上传接口是 `POST /api/admin/products/image`。上传域名必须配置到 uploadFile 合法域名；图片展示域名必须能通过 downloadFile 或 image 请求访问，因此 API 的 `/api/product-images/` 也必须由 HTTPS 反向代理转发到 Node 服务。

使用微信开发者工具打开仓库中的 `miniprogram/` 目录；正式发布前将 `miniprogram/project.config.json` 的 AppID 换成真实 AppID，然后上传、审核、发布。

## 九、第三方接口上线边界

微信登录需要完成 `wx.login`、服务端 code 换 openid、登录 token、手机号授权和会员绑定。生产环境不能使用演示用户 ID，否则存在冒用余额风险。

微信登录和支付已按官方接口接入：小程序启动时 `wx.login` 换服务端 token；下单调用微信支付 API v3 JSAPI 下单并拉起 `wx.requestPayment`；`POST /api/payments/wechat/notify` 验签、AES-GCM 解密并以回调作为最终支付事实，重复通知幂等，混合支付先冻结余额、成功后扣除，超时自动释放。上线前必须填写 AppID、AppSecret、商户号、API v3 Key、商户证书序列号、商户私钥、平台证书/公钥和 HTTPS 回调地址。支付金额始终由服务端重新计算。

美团和抖音后台字段目前只负责保存客户端凭证和配置完整性检查，真实券码查询/核销仍需向对应开放平台申请生活服务核销权限、门店绑定和接口签名资料后做商务联调；在此之前系统不会把本地录入显示为平台核销成功。

## 十、日常更新和备份

```bash
cd /var/www/echo-hx-live-bar
./scripts/backup.sh
./scripts/update.sh
```

更新脚本会自动备份本地代码改动和 SQLite 数据库，然后以 GitHub `main` 为准执行同步、`npm ci --include=dev` 和 `npm run build`。数据库是 `data/echo-hx.sqlite`，图片在 `data/uploads/`，备份在 `backups/`。

服务器如果存在直接修改过的源代码，代码改动会自动保存到 `backups/update-时间/`：已跟踪文件为 `local-changes.patch`，未跟踪文件为 `untracked-files.tar.gz`，清单为 `status.txt`。`.env`、`data/`、数据库和上传图片不会被覆盖。需要保留的业务改动应在开发电脑合并并推送，不建议继续直接修改生产代码。

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
