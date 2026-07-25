const api = require('../../utils/api')

Page({
  data: {
    loading: false
  },

  onLoad() {
    if (api.session() && api.session().token) {
      wx.redirectTo({ url: '/pages/home/home' })
    }
  },

  handleLogin() {
    if (this.data.loading) return
    this.setData({ loading: true })

    wx.login({
      success: async res => {
        try {
          if (!res.code) throw new Error('WX_LOGIN_NO_CODE')
          const result = await api.wechatLogin(res.code)
          api.saveSession({
            token: result.token,
            user: result.user,
            loggedAt: new Date().toISOString()
          })
          wx.redirectTo({ url: '/pages/home/home' })
        } catch (error) {
          this.showLoginError(error)
        } finally {
          this.setData({ loading: false })
        }
      },
      fail: error => {
        this.setData({ loading: false })
        this.showLoginError(error)
      }
    })
  },

  showLoginError(error) {
    const message = error && error.message === 'WECHAT_MINIPROGRAM_NOT_CONFIGURED'
      ? '服务端还未配置微信小程序 AppID/Secret。配置后重启 API 即可继续联调。'
      : '微信登录暂时未完成，请检查网络、AppID 或服务端配置。'

    wx.showModal({
      title: '登录未完成',
      content: message,
      showCancel: false
    })
  }
})
