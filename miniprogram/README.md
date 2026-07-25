# 羲和微信小程序

这是羲和的小程序端最小可联调骨架，当前用于打通：

- 微信小程序登录：`wx.login` -> `/api/auth/wechat-login`
- 读取羲和后端数据：人物、未来三天提醒、最近关怀记录
- 在微信开发者工具中快速预览移动端体验

## 目录

```text
miniprogram/
  app.js
  app.json
  app.wxss
  project.config.json
  sitemap.json
  utils/
    api.js
    config.js
  pages/
    login/
    home/
```

## 本地联调

1. 打开微信开发者工具。
2. 选择“导入项目”，项目目录选择本目录 `miniprogram`。
3. `project.config.json` 里当前使用测试占位 `touristappid`，正式联调时替换成真实小程序 AppID。
4. 修改 `utils/config.js` 中的 `apiBaseUrl`，默认是：

```js
apiBaseUrl: 'http://SERVER_IP:8080'
```

5. 开发工具里如使用 HTTP 或内网地址，需要临时勾选“不校验合法域名、web-view、TLS 版本以及 HTTPS 证书”。

## 服务端配置

服务器需要在 `/data/xihe/config/.env.production` 中配置：

```env
WECHAT_MINIPROGRAM_APPID=小程序AppID
WECHAT_MINIPROGRAM_SECRET=小程序AppSecret
```

配置后重启 API 服务。未配置时，小程序登录会提示“服务端还未配置微信小程序 AppID/Secret”，这是预期状态。

## 正式发布前必须补齐

- 使用 HTTPS 域名访问羲和 API。
- 在微信小程序后台配置 request 合法域名。
- 替换真实 AppID。
- 评估是否增加手机号绑定、订阅消息、Web 账号与微信账号合并。

## 参考

- 微信小程序登录 wx.login：https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html
- 服务端 code2Session：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html
