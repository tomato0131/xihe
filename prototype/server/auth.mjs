import { createHmac, timingSafeEqual } from 'node:crypto'

const secret = process.env.SESSION_SECRET
if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters')

function sign(value) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 8 * 3600 })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyToken(token) {
  if (!token) return null
  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null
  const expected = sign(payload)
  const givenBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (givenBuffer.length !== expectedBuffer.length || !timingSafeEqual(givenBuffer, expectedBuffer)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!parsed.sub || parsed.exp < Math.floor(Date.now() / 1000)) return null
    return parsed
  } catch { return null }
}

export function tokenFromRequest(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

