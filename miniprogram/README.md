# Echo HX Live Bar 小程序

用微信开发者工具打开本目录：

```text
/Users/renyuke/Desktop/9bar/EchoHXLiveBar/miniprogram
```

如果打开的是上一级项目目录，也可以使用项目根目录的 `project.config.json`，两种打开方式都已配置。

开发 API 地址在 `utils/api.js`。电脑端预览使用 `http://localhost:3001/api`；真机调试请改为同一局域网的 HTTPS 或可访问 IP，并在正式发布前配置 request 合法域名。

当前支付按钮会创建待支付订单并返回微信支付适配层提示，不会伪造支付成功。真实微信支付需要补充商户号、AppID、API v3 密钥、证书和 HTTPS 回调。
