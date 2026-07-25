const base = process.env.XIHE_API_BASE || 'http://127.0.0.1:8787'
const email = process.env.REMINDER_EMAIL || 'demo@xihe.local'
const password = process.env.DEMO_PASSWORD

if (!password) throw new Error('DEMO_PASSWORD missing')

async function call(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body.error}`)
  return body.data
}

const session = await call('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email, password }),
})
const result = await call('/api/reminders/run', {
  method: 'POST',
  headers: { Authorization: `Bearer ${session.token}` },
  body: JSON.stringify({}),
})

console.log(JSON.stringify({
  email,
  checkedAt: result.checkedAt,
  processed: result.processed,
  sent: result.sent.map(job => ({ id: job.id, name: job.name, channel: job.channel, message: job.message })),
  failed: result.failed,
}, null, 2))
