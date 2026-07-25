App({
  globalData: {
    session: null
  },

  onLaunch() {
    const session = wx.getStorageSync('xihe.session')
    if (session && session.token) {
      this.globalData.session = session
    }
  }
})
