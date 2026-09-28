# Echo HX Live Bar

Echo HX Live Bar 全栈项目，包含顾客点单端、管理后台和 Node.js API。

## 本地运行

```bash
npm install
npm run dev
```

- 顾客端：<http://localhost:5173/>
- 管理后台：<http://localhost:5173/admin>
- API 健康检查：<http://localhost:3001/api/health>

本地数据库和上传文件在 `data/`，不会提交到版本库。后台默认使用环境变量
`ADMIN_INITIAL_PASSWORD` 创建超级管理员；未设置时会在 API 启动日志打印一次随机密码。

## 部署方式

### 服务器一键安装与进程管理

服务器要求 Node.js 20+、npm、Git；备份脚本另外需要 `sqlite3` 命令。

```bash
git clone <你的 GitHub 仓库地址> /var/www/echo-hx-live-bar
cd /var/www/echo-hx-live-bar
./scripts/install.sh
vi .env
./scripts/service.sh start
curl http://127.0.0.1:3001/api/health
```

常用命令：

```bash
./scripts/service.sh status
./scripts/service.sh stop
./scripts/service.sh restart
./scripts/update.sh
./scripts/backup.sh
```

生产环境建议用 Nginx 托管 `dist/` 并反向代理 `/api/`，配置模板在
`deploy/nginx.conf.example`。小程序的 `miniprogram/utils/api.js` 必须改成正式 HTTPS API 域名，
并在微信公众平台配置 request、uploadFile 和 downloadFile 合法域名。

### 第三方接口配置

管理后台“接口配置”支持保存并实时读取微信登录、微信支付、美团和抖音配置；服务器 `.env` 中的同名环境变量优先于后台配置，适合生产密钥管理。保存后可点击“检查配置”，检查的是字段完整性。

真正上线还必须使用商户资质完成微信支付回调验签、微信登录 code 换取 openid、以及美团/抖音的授权和真实券核销联调。配置项本身不能替代平台授权，也不能在没有真实商户参数时模拟成功支付。

管理后台已经具备账号权限、SQLite 持久化和配置管理；顾客端当前仍保留演示用户身份和第三方支付占位流程，正式发布前必须完成真实登录、支付回调和团购平台适配器联调。
