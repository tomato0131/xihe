const base = 'http://127.0.0.1:8787'
const password = process.env.DEMO_PASSWORD
if (!password) throw new Error('DEMO_PASSWORD missing')

async function call(path, options = {}) {
  const response = await fetch(base + path, options)
  const body = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body.error}`)
  return body.data
}
async function login(email) {
  return call('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})})
}
function auth(token) { return { 'Content-Type':'application/json', Authorization:`Bearer ${token}` } }

const primary = await login('demo@xihe.local')
const second = await login('second@xihe.local')
const primaryPeople = await call('/api/people',{headers:auth(primary.token)})
const secondBefore = await call('/api/people',{headers:auth(second.token)})
if (primaryPeople.length < 4) throw new Error('Primary account seed data missing')
if (secondBefore.length !== 0) throw new Error('RLS isolation failed before create')

const created = await call('/api/people',{method:'POST',headers:auth(second.token),body:JSON.stringify({name:'API隔离测试',relation:'测试',group:'测试组',birthday:'1990-08-16',calendarType:'solar',note:'自动验收'})})
const updated = await call(`/api/people/${created.id}`,{method:'PATCH',headers:auth(second.token),body:JSON.stringify({name:'API隔离测试-已更新'})})
if (updated.name !== 'API隔离测试-已更新') throw new Error('Update failed')
if (updated.notes !== '自动验收') throw new Error('Partial update erased untouched fields')
await call(`/api/people/${created.id}`,{method:'DELETE',headers:auth(second.token)})
const secondAfter = await call('/api/people',{headers:auth(second.token)})
if (secondAfter.length !== 0) throw new Error('Archive failed')

console.log(JSON.stringify({login:'passed',primaryCount:primaryPeople.length,isolation:'passed',create:'passed',update:'passed',archive:'passed'}))
