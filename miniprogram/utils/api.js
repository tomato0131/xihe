const config = require('./config')

function session() {
  return wx.getStorageSync('xihe.session') || null
}

function saveSession(value) {
  wx.setStorageSync('xihe.session', value)
  const app = getApp()
  if (app) app.globalData.session = value
}

function clearSession() {
  wx.removeStorageSync('xihe.session')
  const app = getApp()
  if (app) app.globalData.session = null
}

function request(options) {
  const token = session() && session().token
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${options.url}`,
      method: options.method || 'GET',
      data: options.data,
      header: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.header || {})
      },
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data ? res.data.data : null)
          return
        }
        const error = new Error((res.data && res.data.error) || `HTTP_${res.statusCode}`)
        error.statusCode = res.statusCode
        error.payload = res.data
        reject(error)
      },
      fail(error) {
        reject(error)
      }
    })
  })
}

function wechatLogin(code) {
  return request({
    url: '/api/auth/wechat-login',
    method: 'POST',
    data: { code }
  })
}

function getSession() {
  return request({ url: '/api/session' })
}

function listPeople() {
  return request({ url: '/api/people' })
}

function listReminderPreview() {
  return request({ url: '/api/reminders/preview' })
}

function listCareRecords() {
  return request({ url: '/api/care-records' })
}

module.exports = {
  clearSession,
  getSession,
  listCareRecords,
  listPeople,
  listReminderPreview,
  saveSession,
  session,
  wechatLogin
}
