import { randomBytes, scryptSync } from 'node:crypto'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const password = process.env.DEMO_PASSWORD
if (!password || password.length < 10) throw new Error('DEMO_PASSWORD must contain at least 10 characters')

const accounts = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'demo@xihe.local', name: '羲和体验用户' },
  { id: '99999999-9999-4999-8999-999999999999', email: 'second@xihe.local', name: '隔离测试用户' },
]

for (const account of accounts) {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  await pool.query('insert into auth.users (id,email) values ($1,$2) on conflict (id) do update set email=excluded.email', [account.id, account.email])
  await pool.query('insert into public.profiles (id,display_name) values ($1,$2) on conflict (id) do update set display_name=excluded.display_name', [account.id, account.name])
  await pool.query(`insert into auth.local_credentials (user_id,email,password_salt,password_hash) values ($1,$2,$3,$4)
    on conflict (user_id) do update set email=excluded.email,password_salt=excluded.password_salt,password_hash=excluded.password_hash`, [account.id,account.email,salt,hash])
}
await pool.end()
console.log('Local accounts ready')

