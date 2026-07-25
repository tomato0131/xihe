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
const authHeaders = { Authorization: `Bearer ${session.token}` }
const channels = await call('/api/notifications/channels', { headers: authHeaders })
const generated = await call('/api/reminders/generate', {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({}),
})
const executed = await call('/api/reminders/run', {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({}),
})

console.log(JSON.stringify({
  email,
  checkedAt: executed.checkedAt,
  enabledChannels: Object.entries(channels)
    .filter(([, channel]) => channel.enabled)
    .map(([key, channel]) => ({ key, label: channel.label })),
  generatedFrom: generated.generatedFrom,
  pending: generated.pending.length,
  processed: executed.processed,
  sent: executed.sent.map(job => ({
    id: job.id,
    name: job.name,
    channel: job.channel,
    provider: job.provider,
  })),
  failed: executed.failed.map(job => ({
    id: job.id,
    name: job.name,
    channel: job.channel,
    error: job.error,
  })),
}, null, 2))
