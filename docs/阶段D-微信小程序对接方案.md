# 羲和阶段 D：微信小程序对接方案

## 1. 当前目标

阶段 D 目标是让羲和支持微信小程序用户登录，并把每个用户的数据和个人微信身份绑定。

本阶段先完成后端对接基础：

- 小程序端通过 `wx.login` 获取临时 `code`。
- 羲和后端通过微信 `code2Session` 换取 `openid`。
- 羲和用 `openid` 创建或识别用户。
- 羲和继续签发自己的登录 token。
- 后续小程序所有业务接口仍复用当前 `/api/people`、`/api/groups`、`/api/reminders` 等接口。

## 2. 登录流程

```text
微信小程序
  -> wx.login 获取 code
  -> POST /api/auth/wechat-login { code }
羲和 API
  -> 调用微信 code2Session
  -> 获得 openid / session_key / unionid
  -> 创建或查找羲和用户
  -> 返回羲和 token
微信小程序
  -> 保存 token
  -> 带 Authorization: Bearer <token> 调用业务接口
```

## 3. 后端新增能力

已新增接口：

```http
POST /api/auth/wechat-login
Content-Type: application/json

{
  "code": "wx.login 返回的 code"
}
```

成功返回：

```json
{
  "data": {
    "token": "羲和自己的 session token",
    "user": {
      "id": "用户 ID",
      "email": "wx_xxx@wechat.local",
      "provider": "wechat_miniprogram"
    }
  }
}
```

如果服务器未配置小程序密钥，返回：

```json
{
  "error": "WECHAT_MINIPROGRAM_NOT_CONFIGURED"
}
```

## 4. 数据库新增表

新增：

```sql
auth.wechat_identities
```

核心字段：

- `user_id`
- `appid`
- `openid`
- `unionid`
- `session_key_hash`
- `bound_at`
- `updated_at`

设计原则：

- 不保存明文 `session_key`。
- `openid` 按 `appid` 唯一。
- 一个微信身份对应一个羲和用户。

## 5. 生产环境配置

需要在服务器 `/data/xihe/config/.env.production` 中配置：

```env
WECHAT_MINIPROGRAM_APPID=小程序AppID
WECHAT_MINIPROGRAM_SECRET=小程序AppSecret
```

如果暂时没有 AppID/Secret，Web 版和账号密码登录不受影响。

## 6. 小程序端需要做的事情

已新增原生微信小程序骨架：

```text
miniprogram/
```

微信开发者工具导入该目录即可预览。当前默认接口地址在 `miniprogram/utils/config.js` 中配置为 `http://SERVER_IP:8080`，用于内网开发联调；正式发布前需要替换为 HTTPS 域名，并在微信小程序后台配置 request 合法域名。

小程序首页或启动页：

```js
wx.login({
  success: async (res) => {
    const code = res.code
    // POST https://你的域名/api/auth/wechat-login
  }
})
```

小程序拿到羲和 token 后：

```js
wx.setStorageSync('xihe.session', token)
```

后续请求：

```js
header: {
  Authorization: `Bearer ${token}`
}
```

## 7. 后续能力

下一阶段可以继续补：

1. 小程序项目骨架。
2. 小程序登录页。
3. 手机号绑定。
4. 微信订阅消息模板。
5. HTTPS 域名和小程序合法域名配置。
6. Web 用户与微信用户合并/绑定。

## 8. 官方参考

- [微信小程序登录 wx.login](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)
- [服务端 code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)
- [手机号快速验证组件](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html)
- [订阅消息](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html)
