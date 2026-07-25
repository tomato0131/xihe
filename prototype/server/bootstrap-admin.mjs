import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { Pool } from 'pg'

const databaseUrl = process.env.DATABASE_URL
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase()
const username = process.env.ADMIN_USERNAME?.trim().toLowerCase() || 'admin'
const password = process.env.ADMIN_PASSWORD || process.env.DEMO_PASSWORD
const displayName = process.env.ADMIN_DISPLAY_NAME?.trim() || '羲和管理员'
const role = process.env.ADMIN_ROLE?.trim() || 'super_admin'
const configuredUserId = process.env.ADMIN_USER_ID?.trim()

if (!databaseUrl) throw new Error('DATABASE_URL is required')
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('ADMIN_EMAIL must be a valid email')
if (!/^[a-zA-Z][a-zA-Z0-9_]{2,31}$/.test(username)) throw new Error('ADMIN_USERNAME must start with a letter and contain 3-32 letters, numbers or underscores')
if (!password || password.length < 10) throw new Error('ADMIN_PASSWORD must contain at least 10 characters')
if (!['user', 'admin', 'super_admin'].includes(role)) throw new Error('ADMIN_ROLE must be user, admin or super_admin')

const pool = new Pool({ connectionString: databaseUrl })

try {
  await pool.query('begin')

  const existing = await pool.query('select id from auth.users where lower(email) = lower($1) limit 1', [email])
  const userId = existing.rows[0]?.id || configuredUserId || randomUUID()
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')

  await pool.query(
    'insert into auth.users (id,email) values ($1,$2) on conflict (id) do update set email=excluded.email',
    [userId, email],
  )

  await pool.query(
    'insert into public.profiles (id,display_name,role) values ($1,$2,$3) on conflict (id) do update set display_name=excluded.display_name, role=excluded.role',
    [userId, displayName, role],
  )

  await pool.query(
    `insert into auth.local_credentials (user_id,email,username,password_salt,password_hash) values ($1,$2,$3,$4,$5)
      on conflict (user_id) do update set email=excluded.email,username=excluded.username,password_salt=excluded.password_salt,password_hash=excluded.password_hash`,
    [userId, email, username, salt, hash],
  )

  await pool.query('commit')
  console.log(`Admin account ready: ${username} (${email})`)
} catch (error) {
  await pool.query('rollback').catch(() => {})
  throw error
} finally {
  await pool.end()
}
