import type { Person, PersonDraft } from '../domain/models'

export type GroupRecord = { id: string; name: string; color?: string | null; sort_order?: number }

function formatPerson(row: any): Person {
  const month = Number(row.birth_month), day = Number(row.birth_day)
  const birthYearKnown = row.birth_year !== null && row.birth_year !== undefined
  const groups = Array.isArray(row.groups) ? row.groups : row.group ? [row.group] : []
  return { id: row.id, name: row.name, relation: row.relationship || '重要的人', group: row.group || groups[0] || '未分组', groups,
    date: '待计算', fullDate: `${month}月${day}日`, days: 999, image: row.avatar_path || '/assets/avatar-zhou-ziheng.png',
    avatarPath: row.avatar_path || '', gender: row.gender || 'unknown',
    note: row.notes || '', calendarType: row.calendar_type,
    birthYearKnown, isLeapMonth: Boolean(row.is_leap_month),
    birthday: `${row.birth_year || 2000}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}` }
}
async function request(path: string, init?: RequestInit) {
  const token = localStorage.getItem('xihe.session')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(path,{...init,signal:controller.signal,headers:{'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {}),...init?.headers}})
    const body = await response.json(); if(!response.ok) throw new Error(body.error || 'API_ERROR'); return body.data
  } finally {
    window.clearTimeout(timeout)
  }
}
async function authenticatedFetch(path: string, init?: RequestInit) {
  const token = localStorage.getItem('xihe.session')
  return fetch(path,{...init,headers:{...(token ? {Authorization:`Bearer ${token}`} : {}),...init?.headers}})
}
export const api = {
  hasSession() { return Boolean(localStorage.getItem('xihe.session')) },
  async login(email: string, password: string) {
    const session = await request('/api/auth/login',{method:'POST',body:JSON.stringify({email,password})})
    localStorage.setItem('xihe.session',session.token); return session.user
  },
  logout() { localStorage.removeItem('xihe.session') },
  async listPeople(): Promise<Person[]> { return (await request('/api/people')).map(formatPerson) },
  async listGroups(): Promise<GroupRecord[]> { return await request('/api/groups') },
  async createGroup(name: string): Promise<GroupRecord> { return request('/api/groups',{method:'POST',body:JSON.stringify({name})}) },
  async updateGroup(id: string, name: string): Promise<GroupRecord> { return request(`/api/groups/${id}`,{method:'PATCH',body:JSON.stringify({name})}) },
  async deleteGroup(id: string): Promise<void> { await request(`/api/groups/${id}`,{method:'DELETE'}) },
  async createPerson(draft: PersonDraft): Promise<Person> { return formatPerson(await request('/api/people',{method:'POST',body:JSON.stringify(draft)})) },
  async updatePerson(id: string | number, draft: Partial<PersonDraft>): Promise<Person> { return formatPerson(await request(`/api/people/${id}`,{method:'PATCH',body:JSON.stringify(draft)})) },
  async deletePerson(id: string | number): Promise<void> { await request(`/api/people/${id}`,{method:'DELETE'}) },
  async previewReminders(): Promise<any[]> { return request('/api/reminders/preview') },
  async listReminderJobs(): Promise<any[]> { return request('/api/reminders/jobs') },
  async updateReminderJob(id: string, action: 'snooze' | 'complete', minutes = 120): Promise<any> {
    return request(`/api/reminders/jobs/${id}`,{method:'PATCH',body:JSON.stringify({action, minutes})})
  },
  async listCareRecords(personId?: string | number): Promise<any[]> {
    return request(personId ? `/api/people/${personId}/care-records` : '/api/care-records')
  },
  async createCareRecord(personId: string | number, actionType: 'blessing' | 'contact' | 'gift' | 'completed', content = ''): Promise<any> {
    return request('/api/care-records',{method:'POST',body:JSON.stringify({personId, actionType, content})})
  },
  async downloadJsonExport(): Promise<string> {
    const response = await authenticatedFetch('/api/export/json')
    if (!response.ok) throw new Error('EXPORT_FAILED')
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `xihe-export-${new Date().toISOString().slice(0,10)}.json`
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    return filename
  },
  async downloadPeopleCsv(): Promise<string> {
    const response = await authenticatedFetch('/api/export/people.csv')
    if (!response.ok) throw new Error('CSV_EXPORT_FAILED')
    const blob = await response.blob()
    const disposition = response.headers.get('Content-Disposition') || ''
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `xihe-people-${new Date().toISOString().slice(0,10)}.csv`
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    return filename
  },
  async createJsonBackup(): Promise<any> { return request('/api/backups/json',{method:'POST',body:JSON.stringify({})}) },
  async previewJsonImport(file: File): Promise<any> {
    const text = await file.text()
    let backup: unknown
    try { backup = JSON.parse(text) } catch { throw new Error('INVALID_JSON_FILE') }
    return request('/api/import/json/preview',{method:'POST',body:JSON.stringify({backup})})
  },
  async restoreJsonImport(file: File): Promise<any> {
    const text = await file.text()
    let backup: unknown
    try { backup = JSON.parse(text) } catch { throw new Error('INVALID_JSON_FILE') }
    return request('/api/import/json/restore',{method:'POST',body:JSON.stringify({backup, mode:'append', confirmed:true})})
  },
  async generateReminderJobs(): Promise<any> { return request('/api/reminders/generate',{method:'POST',body:JSON.stringify({})}) },
  async runDueReminderJobs(): Promise<any> { return request('/api/reminders/run',{method:'POST',body:JSON.stringify({})}) },
  async notificationChannels(): Promise<Record<string, { enabled: boolean; label: string }>> { return request('/api/notifications/channels') },
}
