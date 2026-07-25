const api = require('../../utils/api')

function firstChar(text) {
  return text ? String(text).trim().slice(0, 1) : '羲'
}

function careActionLabel(actionType) {
  const map = {
    blessing: '祝福',
    contact: '联系',
    gift: '礼物',
    completed: '完成'
  }
  return map[actionType] || '关怀'
}

function shortDate(value) {
  if (!value) return ''
  return String(value).slice(0, 10)
}

function decoratePerson(person) {
  const groups = Array.isArray(person.groups) ? person.groups : []
  return {
    ...person,
    nameInitial: firstChar(person.name),
    groupsText: groups.slice(0, 2).join('、')
  }
}

function decorateCareRecord(record) {
  return {
    ...record,
    actionLabel: careActionLabel(record.action_type),
    dateText: shortDate(record.completed_at)
  }
}

Page({
  data: {
    loading: false,
    people: [],
    visiblePeople: [],
    reminders: [],
    careRecords: [],
    visibleCareRecords: [],
    todayText: ''
  },

  onLoad() {
    this.ensureSession()
    this.setData({ todayText: new Date().toISOString().slice(0, 10) })
  },

  onShow() {
    this.loadDashboard()
  },

  ensureSession() {
    if (!api.session() || !api.session().token) {
      wx.redirectTo({ url: '/pages/login/login' })
    }
  },

  async loadDashboard() {
    if (!api.session() || !api.session().token || this.data.loading) return
    this.setData({ loading: true })
    wx.showNavigationBarLoading()

    try {
      const results = await Promise.all([
        api.listPeople(),
        api.listReminderPreview(),
        api.listCareRecords()
      ])
      const people = (results[0] || []).map(decoratePerson)
      const reminders = results[1] || []
      const careRecords = (results[2] || []).map(decorateCareRecord)
      this.setData({
        people,
        visiblePeople: people.slice(0, 8),
        reminders,
        careRecords,
        visibleCareRecords: careRecords.slice(0, 3)
      })
    } catch (error) {
      if (error && error.statusCode === 401) {
        api.clearSession()
        wx.redirectTo({ url: '/pages/login/login' })
        return
      }
      wx.showToast({
        title: '数据加载失败',
        icon: 'none'
      })
    } finally {
      this.setData({ loading: false })
      wx.hideNavigationBarLoading()
    }
  },

  handleLogout() {
    api.clearSession()
    wx.redirectTo({ url: '/pages/login/login' })
  }
})
