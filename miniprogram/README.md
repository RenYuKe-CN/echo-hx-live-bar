# Echo HX Live Bar 小程序

用微信开发者工具打开本目录：

```text
/Users/renyuke/Desktop/9bar/EchoHXLiveBar/miniprogram
```

如果打开的是上一级项目目录，也可以使用项目根目录的 `project.config.json`，两种打开方式都已配置。

开发 API 地址默认使用 `http://localhost:3001/api`。电脑端预览请在微信开发者工具中关闭“校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书”；真机调试需要改为可访问的 HTTPS 域名，并在正式发布前配置 request 合法域名。小程序启动时会优先读取后台的 `public_api_base_url`，配置不可用时在开发环境回退到本机 API。

微信登录流程已经接通：小程序调用 `wx.login` 获取临时 `code`，后端使用超级管理员后台配置的 AppID/AppSecret 调用微信 `jscode2session` 换取 openid，再创建登录会话。若登录失败，小程序会显示微信接口返回的错误信息，不会静默使用演示用户。

首次进入首页会在当前页面显示授权弹层，不会跳转到另一个资料页面。用户点击官方“授权头像和昵称”按钮后，小程序用 `wx.getUserProfile` 获取头像和昵称，再点击官方“授权手机号”按钮完成手机号授权；后端把三项信息保存到同一个会员账户的 `avatar_url`、`nickname` 和 `phone` 字段，后台“会员管理”可按手机号查看。小程序不会在用户没有点击官方按钮时静默读取这些资料。会员页仍保留“资料设置”入口，用于后续主动修改头像和昵称。手机号授权使用微信官方 `getuserphonenumber` 接口，因此线上必须配置正确的 AppID/AppSecret，并在小程序隐私设置中声明头像、昵称、手机号的用途。

头像上传使用 `wx.uploadFile` 请求 `/api/me/avatar`，商品图片上传使用后台的 `/api/admin/products/image`。两个接口会把文件默认保存到服务器 `data/uploads/`；如果超级管理员配置了 S3 兼容对象存储，则新文件会切换到对象存储。微信公众平台需要将 API 的同一个 HTTPS 主域名分别加入 request、uploadFile 和 downloadFile 合法域名，填写域名时不要带 `/api` 后缀。开发者工具本地调试可关闭合法域名校验，真机和正式版必须使用备案/证书正常的 HTTPS 域名。

本地验证步骤：

1. 启动 API：`npm run dev` 或 `node server/index.js`。
2. 用微信开发者工具打开本目录，确认 AppID 与 `miniprogram/project.config.json` 中的 AppID 一致。
3. 在工具设置中关闭合法域名校验，重新编译小程序。
4. 在超级管理员后台的“接口配置”填写 AppID 和 AppSecret；如只做本地开发，也可以暂时不填写正式 HTTPS API 地址。
5. 查看开发者工具 Console 和 Network。`POST /api/auth/wechat/login` 返回 `200` 且有 `token` 才表示登录成功。

如果返回 `40013`，通常是 AppID 或 AppSecret 不匹配；返回 `40029` 是 code 无效或重复使用；如果请求失败，则检查 API 服务、开发者工具合法域名校验和 `http://localhost:3001/api/health`。

当前支付按钮会创建待支付订单并返回微信支付适配层提示，不会伪造支付成功。真实微信支付需要补充商户号、AppID、API v3 密钥、证书和 HTTPS 回调。
