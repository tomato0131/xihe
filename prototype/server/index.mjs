import http from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { Pool } from 'pg'
import { z } from 'zod'
import { issueToken, tokenFromRequest, verifyToken } from './auth.mjs'
import { configuredChannels, defaultReminderChannels, sendNotification } from './notifiers.mjs'

const PORT = Number(process.env.API_PORT || 8787)
const HOST = process.env.API_HOST || '127.0.0.1'
const DATABASE_URL = process.env.DATABASE_URL
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || 'http://127.0.0.1:5175').split(','))
const BACKUP_DIR = process.env.BACKUP_DIR || path.resolve(process.cwd(), '.local/backups')
const WECHAT_MINIPROGRAM_APPID = process.env.WECHAT_MINIPROGRAM_APPID?.trim()
const WECHAT_MINIPROGRAM_SECRET = process.env.WECHAT_MINIPROGRAM_SECRET?.trim()
if (!DATABASE_URL) throw new Error('DATABASE_URL is required')

const pool = new Pool({ connectionString: DATABASE_URL, max: 5, idleTimeoutMillis: 10_000 })
const personSchema = z.object({
  name: z.string().trim().min(1).max(100), relation: z.string().trim().max(50).default(''),
  group: z.string().trim().min(1).max(50).optional(), birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  groups: z.array(z.string().trim().min(1).max(50)).max(8).optional(),
  gender: z.enum(['female', 'male', 'unknown']).optional().default('unknown'),
  avatarPath: z.string().trim().max(1_000_000).optional().default(''),
  calendarType: z.enum(['solar', 'lunar']), birthYearKnown: z.boolean().optional().default(true),
  isLeapMonth: z.boolean().optional().default(false), note: z.string().trim().max(2000).optional().default(''),
})
const loginSchema = z.object({
  email: z.string().trim().min(3).max(255),
  password: z.string().min(10).max(128)
})
const wechatLoginSchema = z.object({ code: z.string().trim().min(1).max(256) })
const updatePersonSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(), relation: z.string().trim().max(50).optional(),
  group: z.string().trim().min(1).max(50).optional(), birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  groups: z.array(z.string().trim().min(1).max(50)).max(8).optional(),
  gender: z.enum(['female', 'male', 'unknown']).optional(),
  avatarPath: z.string().trim().max(1_000_000).optional(),
  calendarType: z.enum(['solar','lunar']).optional(), birthYearKnown: z.boolean().optional(),
  isLeapMonth: z.boolean().optional(), note: z.string().trim().max(2000).optional(),
}).refine(value => Object.keys(value).length > 0)
const runReminderSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  now: z.string().datetime({ offset: true }).optional(),
}).optional().default({})
const updateReminderJobSchema = z.object({
  action: z.enum(['snooze', 'complete']),
  minutes: z.number().int().min(5).max(1440).optional().default(120),
})
const careRecordSchema = z.object({
  personId: z.string().uuid(),
  actionType: z.enum(['blessing', 'contact', 'gift', 'completed']),
  content: z.string().trim().max(2000).optional().default(''),
})
const groupSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z.string().trim().max(50).optional().default(''),
})
const updateGroupSchema = groupSchema.refine(value => Object.keys(value).length > 0)
const importPreviewSchema = z.object({ backup: z.unknown() })
const importRestoreSchema = z.object({
  backup: z.unknown(),
  mode: z.enum(['append']).optional().default('append'),
  confirmed: z.literal(true),
})

const DAY_MS = 24 * 60 * 60 * 1000
const lunarFormatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'long', day: 'numeric' })
const chineseMonthMap = new Map([['正',1],['一',1],['二',2],['三',3],['四',4],['五',5],['六',6],['七',7],['八',8],['九',9],['十',10],['十一',11],['十二',12],['腊',12]])

function json(res, status, body, origin) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...(origin && ALLOWED_ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  })
  res.end(payload)
}

function attachmentJson(res, filename, body, origin) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(origin && ALLOWED_ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  })
  res.end(payload)
}

function csvEscape(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function attachmentCsv(res, filename, rows, origin) {
  const payload = '\uFEFF' + rows.map(row => row.map(csvEscape).join(',')).join('\n')
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(origin && ALLOWED_ORIGINS.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  })
  res.end(payload)
}

async function readJson(req, maxBytes = 32768) {
  const chunks = []; let total = 0
  for await (const chunk of req) { total += chunk.length; if (total > maxBytes) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk) }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new Error('INVALID_JSON') }
}

async function ensureRuntimeSchema() {
  await pool.query("alter table public.people add column if not exists gender text not null default 'unknown'")
  await pool.query("alter table public.people drop constraint if exists people_gender_check")
  await pool.query("alter table public.people add constraint people_gender_check check (gender in ('female','male','unknown'))")
}

async function asUser(userId, callback) {
  const client = await pool.connect()
  try {
    await client.query('begin'); await client.query('set local role authenticated')
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId])
    const result = await callback(client); await client.query('commit'); return result
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}

async function listPeople(userId) {
  return asUser(userId, async client => (await client.query(`
    select p.id, p.name, p.relationship, p.gender, p.avatar_path, p.notes,
           b.calendar_type, b.birth_year, b.birth_month, b.birth_day, b.is_leap_month,
           coalesce(array_agg(g.name order by g.sort_order) filter (where g.name is not null), '{}') as groups
    from public.people p join public.birthdays b on b.person_id = p.id
    left join public.person_groups pg on pg.person_id = p.id left join public.groups g on g.id = pg.group_id
    where p.archived_at is null group by p.id, b.id order by b.birth_month, b.birth_day, p.name
  `)).rows)
}
async function listGroups(userId) { return asUser(userId, async client => (await client.query('select id, name, color, sort_order from public.groups order by sort_order, name')).rows) }

function inputGroupNames(input) {
  const names = [...(Array.isArray(input.groups) ? input.groups : []), input.group, input.relation].filter(Boolean)
  const uniqueNames = [...new Set(names.map(name => String(name).trim()).filter(Boolean))].slice(0, 8)
  return uniqueNames.length ? uniqueNames : ['未分组']
}

async function replacePersonGroups(client, userId, personId, names) {
  await client.query('delete from public.person_groups where person_id=$1', [personId])
  const linked = []
  for (const name of names) {
    const group = (await client.query(`
      insert into public.groups (user_id,name,sort_order)
      values ($1,$2,99)
      on conflict (user_id,name) do update set name=excluded.name
      returning id,name
    `, [userId, name])).rows[0]
    await client.query('insert into public.person_groups (person_id,group_id) values ($1,$2) on conflict do nothing', [personId, group.id])
    linked.push(group.name)
  }
  return linked
}

async function createGroup(userId, input) {
  return asUser(userId, async client => {
    const { rows } = await client.query(`
      insert into public.groups (user_id, name, color, sort_order)
      values ($1, $2, $3, 99)
      on conflict (user_id, name) do update set name=excluded.name
      returning id, name, color, sort_order
    `, [userId, input.name, input.color || null])
    return rows[0]
  })
}

async function updateGroup(userId, id, input) {
  return asUser(userId, async client => {
    const { rows } = await client.query(`
      update public.groups
      set name=$3, color=$4
      where id=$1 and user_id=$2
      returning id, name, color, sort_order
    `, [id, userId, input.name, input.color || null])
    return rows[0] ?? null
  })
}

async function deleteGroup(userId, id) {
  return asUser(userId, async client => {
    const existing = await client.query('select id from public.groups where id=$1 and user_id=$2', [id, userId])
    if (!existing.rows[0]) return false
    await client.query('delete from public.person_groups where group_id=$1', [id])
    await client.query('delete from public.groups where id=$1 and user_id=$2', [id, userId])
    return true
  })
}

function startOfLocalDay(date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()) }
function localDateFromParts(year, month, day) { return new Date(year, month - 1, day) }
function daysBetween(from, to) { return Math.round((startOfLocalDay(to).getTime() - startOfLocalDay(from).getTime()) / DAY_MS) }
function parseLunarParts(date) {
  const parts = lunarFormatter.formatToParts(date)
  const rawMonth = parts.find(part => part.type === 'month')?.value ?? ''
  const rawDay = Number(parts.find(part => part.type === 'day')?.value)
  const month = chineseMonthMap.get(rawMonth.replace('月','').replace(/^闰/,''))
  if (!month || !rawDay) return null
  return { month, day: rawDay, leap: rawMonth.startsWith('闰') }
}
function findLunarDateInGregorianYear(year, month, day, isLeapMonth = false) {
  const end = localDateFromParts(year + 1, 3, 1)
  for (let cursor = localDateFromParts(year, 1, 1); cursor < end; cursor = localDateFromParts(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate() + 1)) {
    const lunar = parseLunarParts(cursor)
    if (lunar?.month === month && lunar.day === day && lunar.leap === isLeapMonth) return cursor
  }
  return null
}
function nextSolarBirthday(month, day, today) {
  let candidate = localDateFromParts(today.getFullYear(), month, day)
  if (daysBetween(today, candidate) < 0) candidate = localDateFromParts(today.getFullYear() + 1, month, day)
  return candidate
}
function nextBirthday(row, today = new Date()) {
  const date = row.calendar_type === 'lunar'
    ? ([today.getFullYear(), today.getFullYear() + 1].map(year => findLunarDateInGregorianYear(year, row.birth_month, row.birth_day, row.is_leap_month)).filter(Boolean).sort((a,b)=>a-b).find(date => daysBetween(today, date) >= 0) ?? nextSolarBirthday(row.birth_month, row.birth_day, today))
    : nextSolarBirthday(row.birth_month, row.birth_day, today)
  return { date, days: daysBetween(today, date) }
}

async function listReminderPreview(userId) {
  const rows = await listPeople(userId)
  return rows.map(row => {
    const next = nextBirthday(row)
    return { person_id: row.id, name: row.name, relationship: row.relationship, calendar_type: row.calendar_type, next_date: next.date.toISOString().slice(0,10), days: next.days, should_notify: next.days >= 0 && next.days <= 3 }
  }).filter(item => item.should_notify).sort((a,b) => a.days - b.days || a.name.localeCompare(b.name, 'zh-CN'))
}

async function generateReminderJobs(userId) {
  const preview = await listReminderPreview(userId)
  return asUser(userId, async client => {
    for (const item of preview) {
      const { rows: rules } = await client.query(`
        select unnest(channels) as channel
        from public.reminder_rules
        where person_id = $1 and enabled = true
      `, [item.person_id])
      const channels = rules.length ? rules.map(rule => rule.channel) : ['in_app']
      const scheduledAt = `${item.next_date}T09:00:00+08:00`
      for (const channel of channels) {
        await client.query(`
          insert into public.notification_jobs (user_id, person_id, scheduled_at, channel, dedupe_key)
          values ($1,$2,$3,$4,$5)
          on conflict (dedupe_key) do nothing
        `, [userId, item.person_id, scheduledAt, channel, `${userId}:${item.person_id}:${item.next_date}:${channel}`])
      }
    }
    const { rows } = await client.query(`
      select j.id, j.person_id, p.name, j.scheduled_at, j.channel, j.status
      from public.notification_jobs j join public.people p on p.id = j.person_id
      where j.user_id = $1 and j.status = 'pending'
      order by j.scheduled_at, p.name
    `, [userId])
    return { generatedFrom: preview.length, pending: rows }
  })
}

async function listReminderJobs(userId) {
  return asUser(userId, async client => {
    const { rows } = await client.query(`
      select j.id, j.person_id, p.name, p.relationship, j.scheduled_at, j.channel, j.status, j.attempts, j.last_error, j.sent_at
      from public.notification_jobs j
      join public.people p on p.id = j.person_id
      where j.user_id = $1 and p.archived_at is null and j.created_at >= now() - interval '30 days'
      order by
        case j.status when 'pending' then 0 when 'processing' then 1 when 'failed' then 2 when 'sent' then 3 else 4 end,
        j.scheduled_at,
        p.name
      limit 50
    `, [userId])
    return rows
  })
}

async function updateReminderJob(userId, id, input) {
  return asUser(userId, async client => {
    const { rows } = await client.query(`
      select j.id, j.person_id, j.scheduled_at, j.channel, j.status, p.name
      from public.notification_jobs j
      join public.people p on p.id = j.person_id
      where j.id = $1 and j.user_id = $2 and p.archived_at is null
      for update of j
    `, [id, userId])
    const job = rows[0]
    if (!job) return null
    if (input.action === 'snooze') {
      const { rows: updated } = await client.query(`
        update public.notification_jobs
        set scheduled_at = now() + ($2::text || ' minutes')::interval,
            status = 'pending',
            last_error = null
        where id = $1
        returning id, person_id, scheduled_at, channel, status, attempts, last_error, sent_at
      `, [id, input.minutes])
      return { ...updated[0], name: job.name, action: 'snoozed' }
    }
    await client.query(`
      insert into public.care_records (user_id, person_id, action_type, content)
      values ($1, $2, 'completed', $3)
    `, [userId, job.person_id, `已在羲和页面处理 ${job.channel} 提醒`])
    const { rows: updated } = await client.query(`
      update public.notification_jobs
      set status = 'cancelled',
          last_error = null
      where id = $1
      returning id, person_id, scheduled_at, channel, status, attempts, last_error, sent_at
    `, [id])
    return { ...updated[0], name: job.name, action: 'completed' }
  })
}

async function listCareRecords(userId, personId) {
  return asUser(userId, async client => {
    const params = personId ? [userId, personId] : [userId]
    const { rows } = await client.query(`
      select c.id, c.person_id, p.name, c.action_type, c.content, c.completed_at
      from public.care_records c
      join public.people p on p.id = c.person_id
      where c.user_id = $1
        and p.archived_at is null
        ${personId ? 'and c.person_id = $2' : ''}
      order by c.completed_at desc
      limit 50
    `, params)
    return rows
  })
}

async function createCareRecord(userId, input) {
  return asUser(userId, async client => {
    const { rows: people } = await client.query('select id from public.people where id = $1 and user_id = $2 and archived_at is null', [input.personId, userId])
    if (!people[0]) return null
    const { rows } = await client.query(`
      insert into public.care_records (user_id, person_id, action_type, content)
      values ($1, $2, $3, $4)
      returning id, person_id, action_type, content, completed_at
    `, [userId, input.personId, input.actionType, input.content])
    return rows[0]
  })
}

async function exportUserData(userId) {
  return asUser(userId, async client => {
    const [profile, people, birthdays, groups, personGroups, reminderRules, notificationJobs, careRecords] = await Promise.all([
      client.query('select id, display_name, timezone, locale, created_at, updated_at from public.profiles where id=$1', [userId]),
      client.query('select id, name, relationship, gender, avatar_path, notes, archived_at, created_at, updated_at from public.people where user_id=$1 order by created_at, name', [userId]),
      client.query(`select b.* from public.birthdays b join public.people p on p.id=b.person_id where p.user_id=$1 order by b.created_at`, [userId]),
      client.query('select id, name, color, sort_order, created_at from public.groups where user_id=$1 order by sort_order, name', [userId]),
      client.query(`select pg.person_id, pg.group_id from public.person_groups pg join public.people p on p.id=pg.person_id where p.user_id=$1 order by pg.person_id`, [userId]),
      client.query(`select r.* from public.reminder_rules r join public.people p on p.id=r.person_id where p.user_id=$1 order by r.created_at`, [userId]),
      client.query('select id, person_id, scheduled_at, channel, status, attempts, dedupe_key, last_error, sent_at, created_at from public.notification_jobs where user_id=$1 order by created_at desc limit 500', [userId]),
      client.query('select id, person_id, action_type, content, completed_at from public.care_records where user_id=$1 order by completed_at desc limit 1000', [userId]),
    ])
    return {
      product: '羲和',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      userId,
      profile: profile.rows[0] ?? null,
      people: people.rows,
      birthdays: birthdays.rows,
      groups: groups.rows,
      personGroups: personGroups.rows,
      reminderRules: reminderRules.rows,
      notificationJobs: notificationJobs.rows,
      careRecords: careRecords.rows,
    }
  })
}

async function createJsonBackup(userId) {
  const data = await exportUserData(userId)
  await mkdir(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `xihe-backup-${stamp}.json`
  const filePath = path.join(BACKUP_DIR, filename)
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
  return { filename, path: filePath, exportedAt: data.exportedAt, people: data.people.length, careRecords: data.careRecords.length }
}

async function exportPeopleCsvRows(userId) {
  return asUser(userId, async client => {
    const { rows } = await client.query(`
      select p.name, p.relationship, p.notes, p.created_at,
             b.calendar_type, b.birth_year, b.birth_month, b.birth_day, b.is_leap_month,
             coalesce(string_agg(g.name, '、' order by g.sort_order, g.name), '') as groups
      from public.people p
      join public.birthdays b on b.person_id = p.id
      left join public.person_groups pg on pg.person_id = p.id
      left join public.groups g on g.id = pg.group_id
      where p.user_id = $1 and p.archived_at is null
      group by p.id, b.id
      order by b.birth_month, b.birth_day, p.name
    `, [userId])
    const header = ['姓名','关系','主分组','全部分组','历法','出生年份','生日月','生日日','是否闰月','备注','创建时间']
    return [
      header,
      ...rows.map(row => [
        row.name,
        row.relationship || '',
        row.groups ? row.groups.split('、')[0] : '',
        row.groups || '',
        row.calendar_type === 'lunar' ? '农历' : '公历',
        row.birth_year ?? '',
        row.birth_month,
        row.birth_day,
        row.is_leap_month ? '是' : '否',
        row.notes || '',
        row.created_at ? new Date(row.created_at).toISOString() : '',
      ]),
    ]
  })
}

function backupArray(backup, key) {
  return Array.isArray(backup?.[key]) ? backup[key] : []
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function backupBirthdayByPerson(backup) {
  const map = new Map()
  for (const birthday of backupArray(backup, 'birthdays')) {
    if (birthday?.person_id && !map.has(birthday.person_id)) map.set(birthday.person_id, birthday)
  }
  return map
}

function assertSupportedBackup(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    const error = new Error('INVALID_BACKUP')
    error.statusCode = 400
    throw error
  }
  if (backup.product !== '羲和') {
    const error = new Error('UNSUPPORTED_BACKUP_PRODUCT')
    error.statusCode = 400
    throw error
  }
  if (backup.schemaVersion !== 1) {
    const error = new Error('UNSUPPORTED_BACKUP_SCHEMA')
    error.statusCode = 400
    throw error
  }
}

function previewJsonImport(userId, backup) {
  assertSupportedBackup(backup)
  const people = backupArray(backup, 'people')
  const birthdays = backupArray(backup, 'birthdays')
  const groups = backupArray(backup, 'groups')
  const personGroups = backupArray(backup, 'personGroups')
  const reminderRules = backupArray(backup, 'reminderRules')
  const notificationJobs = backupArray(backup, 'notificationJobs')
  const careRecords = backupArray(backup, 'careRecords')
  const warnings = []
  if (backup.userId && backup.userId !== userId) warnings.push('备份来自另一个账号，后续恢复前需要再次确认。')
  if (!backup.exportedAt) warnings.push('备份缺少导出时间。')
  if (people.length === 0) warnings.push('备份中没有人物数据。')
  if (birthdays.length < people.length) warnings.push('生日记录数量少于人物数量，部分人物可能缺少生日。')
  const archivedPeople = people.filter(person => person?.archived_at).length
  if (archivedPeople > 0) warnings.push(`包含 ${archivedPeople} 位已归档人物。`)
  return {
    product: backup.product,
    schemaVersion: backup.schemaVersion,
    exportedAt: backup.exportedAt ?? null,
    sourceUserId: backup.userId ?? null,
    targetUserId: userId,
    counts: {
      people: people.length,
      birthdays: birthdays.length,
      groups: groups.length,
      personGroups: personGroups.length,
      reminderRules: reminderRules.length,
      notificationJobs: notificationJobs.length,
      careRecords: careRecords.length,
    },
    warnings,
    canRestore: warnings.length === 0 || warnings.every(text => !text.includes('没有人物数据')),
  }
}

async function restoreJsonImport(userId, backup) {
  const preview = previewJsonImport(userId, backup)
  if (!preview.canRestore) {
    const error = new Error('BACKUP_NOT_RESTORABLE')
    error.statusCode = 400
    throw error
  }
  const people = backupArray(backup, 'people')
  const groups = backupArray(backup, 'groups')
  const personGroups = backupArray(backup, 'personGroups')
  const reminderRules = backupArray(backup, 'reminderRules')
  const careRecords = backupArray(backup, 'careRecords')
  const birthdaysByPerson = backupBirthdayByPerson(backup)
  return asUser(userId, async client => {
    const oldToNewPersonId = new Map()
    const oldToNewGroupId = new Map()
    const restored = { people: 0, groups: 0, personGroups: 0, reminderRules: 0, careRecords: 0 }
    const skipped = { people: 0, groups: 0, personGroups: 0, reminderRules: 0, careRecords: 0, notificationJobs: preview.counts.notificationJobs }

    for (const group of groups) {
      const name = cleanText(group?.name)
      if (!name) { skipped.groups += 1; continue }
      const existing = await client.query('select id from public.groups where user_id=$1 and name=$2', [userId, name])
      if (existing.rows[0]) {
        oldToNewGroupId.set(group.id, existing.rows[0].id)
        skipped.groups += 1
        continue
      }
      const inserted = await client.query(
        'insert into public.groups (user_id, name, color, sort_order) values ($1,$2,$3,$4) returning id',
        [userId, name, cleanText(group?.color) || null, Number.isInteger(group?.sort_order) ? group.sort_order : 99]
      )
      oldToNewGroupId.set(group.id, inserted.rows[0].id)
      restored.groups += 1
    }

    for (const person of people) {
      const birthday = birthdaysByPerson.get(person?.id)
      const name = cleanText(person?.name)
      const month = Number(birthday?.birth_month)
      const day = Number(birthday?.birth_day)
      const calendarType = birthday?.calendar_type === 'lunar' ? 'lunar' : 'solar'
      const isLeapMonth = Boolean(birthday?.is_leap_month)
      const birthYear = birthday?.birth_year === null || birthday?.birth_year === undefined ? null : Number(birthday.birth_year)
      if (!name || !birthday || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) {
        skipped.people += 1
        continue
      }
      const existing = await client.query(`
        select p.id
        from public.people p
        join public.birthdays b on b.person_id = p.id
        where p.user_id=$1 and p.name=$2 and b.calendar_type=$3 and b.birth_month=$4 and b.birth_day=$5 and b.is_leap_month=$6
        limit 1
      `, [userId, name, calendarType, month, day, isLeapMonth])
      if (existing.rows[0]) {
        oldToNewPersonId.set(person.id, existing.rows[0].id)
        skipped.people += 1
        continue
      }
      const insertedPerson = await client.query(`
        insert into public.people (user_id, name, relationship, gender, avatar_path, notes, archived_at)
        values ($1,$2,$3,$4,$5,$6,$7)
        returning id
      `, [
        userId,
        name,
        cleanText(person?.relationship) || null,
        ['female','male','unknown'].includes(person?.gender) ? person.gender : 'unknown',
        cleanText(person?.avatar_path) || null,
        cleanText(person?.notes) || null,
        person?.archived_at ? new Date(person.archived_at).toISOString() : null,
      ])
      const newPersonId = insertedPerson.rows[0].id
      oldToNewPersonId.set(person.id, newPersonId)
      await client.query(`
        insert into public.birthdays (person_id, calendar_type, birth_year, birth_month, birth_day, is_leap_month)
        values ($1,$2,$3,$4,$5,$6)
      `, [newPersonId, calendarType, Number.isInteger(birthYear) ? birthYear : null, month, day, isLeapMonth])
      restored.people += 1
    }

    for (const link of personGroups) {
      const personId = oldToNewPersonId.get(link?.person_id)
      const groupId = oldToNewGroupId.get(link?.group_id)
      if (!personId || !groupId) { skipped.personGroups += 1; continue }
      const inserted = await client.query(`
        insert into public.person_groups (person_id, group_id)
        values ($1,$2)
        on conflict do nothing
      `, [personId, groupId])
      inserted.rowCount ? restored.personGroups += 1 : skipped.personGroups += 1
    }

    for (const rule of reminderRules) {
      const personId = oldToNewPersonId.get(rule?.person_id)
      if (!personId) { skipped.reminderRules += 1; continue }
      const daysBefore = Number.isInteger(rule?.days_before) ? rule.days_before : 3
      const sendTime = typeof rule?.send_time === 'string' ? rule.send_time : '09:00'
      const channels = Array.isArray(rule?.channels) && rule.channels.length ? rule.channels.filter(channel => typeof channel === 'string') : defaultReminderChannels()
      const inserted = await client.query(`
        insert into public.reminder_rules (person_id, days_before, send_time, channels, enabled)
        values ($1,$2,$3,$4,$5)
        on conflict (person_id, days_before, send_time) do nothing
      `, [personId, daysBefore, sendTime, channels, rule?.enabled !== false])
      inserted.rowCount ? restored.reminderRules += 1 : skipped.reminderRules += 1
    }

    for (const record of careRecords) {
      const personId = oldToNewPersonId.get(record?.person_id)
      const actionType = ['blessing', 'contact', 'gift', 'completed'].includes(record?.action_type) ? record.action_type : null
      if (!personId || !actionType) { skipped.careRecords += 1; continue }
      const content = cleanText(record?.content)
      const completedAt = record?.completed_at ? new Date(record.completed_at).toISOString() : new Date().toISOString()
      const existing = await client.query(`
        select id from public.care_records
        where user_id=$1 and person_id=$2 and action_type=$3 and coalesce(content,'')=$4 and completed_at=$5
        limit 1
      `, [userId, personId, actionType, content, completedAt])
      if (existing.rows[0]) { skipped.careRecords += 1; continue }
      await client.query(`
        insert into public.care_records (user_id, person_id, action_type, content, completed_at)
        values ($1,$2,$3,$4,$5)
      `, [userId, personId, actionType, content || null, completedAt])
      restored.careRecords += 1
    }

    return {
      mode: 'append',
      restored,
      skipped,
      warnings: [...preview.warnings, preview.counts.notificationJobs ? '提醒任务未直接恢复，请在页面中刷新提醒内容重新生成。' : null].filter(Boolean),
    }
  })
}

async function currentImportTargetStats(userId) {
  return asUser(userId, async client => {
    const [people, groups, careRecords] = await Promise.all([
      client.query('select count(*)::int as total, count(*) filter (where archived_at is null)::int as active from public.people where user_id=$1', [userId]),
      client.query('select count(*)::int as total from public.groups where user_id=$1', [userId]),
      client.query('select count(*)::int as total from public.care_records where user_id=$1', [userId]),
    ])
    return { people: people.rows[0], groups: groups.rows[0].total, careRecords: careRecords.rows[0].total }
  })
}

async function runDueReminderJobs(userId, input = {}) {
  const now = input.now ? new Date(input.now) : new Date()
  if (Number.isNaN(now.getTime())) throw new Error('INVALID_NOW')
  return asUser(userId, async client => {
    const { rows: dueJobs } = await client.query(`
      select j.id, j.person_id, j.scheduled_at, j.channel, j.attempts, p.name, p.relationship
      from public.notification_jobs j
      join public.people p on p.id = j.person_id
      where j.user_id = $1 and j.status = 'pending' and j.scheduled_at <= $2 and p.archived_at is null
      order by j.scheduled_at, j.created_at
      limit $3
      for update of j skip locked
    `, [userId, now.toISOString(), input.limit ?? 20])
    const sent = []
    const failed = []
    for (const job of dueJobs) {
      await client.query(`update public.notification_jobs set status='processing', attempts=attempts+1 where id=$1`, [job.id])
      try {
        const delivery = await sendNotification(job)
        await client.query(`
          update public.notification_jobs
          set status='sent', sent_at=$2, last_error=null
          where id=$1
        `, [job.id, now.toISOString()])
        sent.push({ ...job, message: delivery.message, provider: delivery.provider, providerMessageId: delivery.providerMessageId })
      } catch (error) {
        await client.query(`
          update public.notification_jobs
          set status='failed', last_error=$2
          where id=$1
        `, [job.id, error?.message ?? 'SEND_FAILED'])
        failed.push({ ...job, error: error?.message ?? 'SEND_FAILED' })
      }
    }
    return { checkedAt: now.toISOString(), sent, failed, processed: sent.length + failed.length }
  })
}

function avatarHash(value = '') {
  let hash = 2166136261
  for (const char of String(value)) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function svgText(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function pickByHash(list, hash, shift = 0) {
  return list[((hash >>> shift) % list.length)] || list[0]
}

const avatarPalettes = [
  ['#f8d58a', '#f6efe2', '#9f6a3d', '#fff8ea'],
  ['#e8c7a7', '#f6eadc', '#8b5e48', '#fff6ef'],
  ['#d5e4c3', '#f7f0df', '#5c7854', '#fffaf1'],
  ['#c9d7ee', '#f4ead8', '#596f9f', '#fff8ea'],
  ['#edd0d0', '#f8efe1', '#9b5d60', '#fff8f4'],
  ['#e9d8a6', '#f8f1dc', '#85683a', '#fffbea']
]

function avatarMotif(note = '') {
  const text = String(note).toLowerCase()
  if (/咖啡|茶|奶茶|拿铁|饮品/.test(text)) return 'cup'
  if (/旅行|旅游|徒步|山|户外|露营|摄影/.test(text)) return 'mountain'
  if (/书|阅读|历史|学习|写作|诗/.test(text)) return 'book'
  if (/音乐|唱歌|钢琴|吉他|乐队|演唱会/.test(text)) return 'music'
  if (/花|植物|园艺|自然|猫|宠物/.test(text)) return 'leaf'
  if (/代码|研发|技术|产品|设计|数据|ai|算法/.test(text)) return 'nodes'
  if (/礼物|生日|蛋糕|惊喜/.test(text)) return 'gift'
  return 'sun'
}

function avatarMotifSvg(type, accent) {
  const stroke = `stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity=".5"`
  if (type === 'cup') return `<path ${stroke} d="M70 136h48c0 24-9 38-24 38s-24-14-24-38Z"/><path ${stroke} d="M118 142h12c9 0 9 20-2 22h-8"/><path ${stroke} d="M76 116c-5-9 6-13 1-22M96 116c-5-9 6-13 1-22M114 116c-5-9 6-13 1-22"/>`
  if (type === 'mountain') return `<path ${stroke} d="M48 164l43-55 28 33 17-20 32 42"/><path ${stroke} d="M76 164c21-12 44-12 70 0"/><circle cx="142" cy="82" r="14" fill="${accent}" opacity=".18"/>`
  if (type === 'book') return `<path ${stroke} d="M58 92c22-8 35-4 48 8v70c-13-12-26-16-48-8V92Z"/><path ${stroke} d="M106 100c13-12 26-16 48-8v70c-22-8-35-4-48 8v-70Z"/><path ${stroke} d="M76 116h14M76 136h16M122 116h14M122 136h16"/>`
  if (type === 'music') return `<path ${stroke} d="M88 150V84l56-12v66"/><circle cx="74" cy="154" r="17" fill="${accent}" opacity=".18"/><circle cx="130" cy="142" r="17" fill="${accent}" opacity=".18"/><path ${stroke} d="M88 102l56-12"/>`
  if (type === 'leaf') return `<path ${stroke} d="M104 170c5-42 28-66 64-76-3 43-24 67-64 76Z"/><path ${stroke} d="M104 170c-14-31-33-47-62-52 5 33 24 49 62 52Z"/><path ${stroke} d="M104 170c10-28 30-48 58-67"/>`
  if (type === 'nodes') return `<circle cx="72" cy="102" r="14" fill="${accent}" opacity=".2"/><circle cx="136" cy="92" r="14" fill="${accent}" opacity=".2"/><circle cx="112" cy="154" r="16" fill="${accent}" opacity=".2"/><path ${stroke} d="M84 106l40-10M80 114l22 29M130 104l-14 36"/>`
  if (type === 'gift') return `<rect x="62" y="112" width="92" height="58" rx="10" fill="${accent}" opacity=".16"/><path ${stroke} d="M108 112v58M62 136h92M82 100c-16-18 14-30 26 12M134 100c16-18-14-30-26 12"/>`
  return `<circle cx="108" cy="125" r="42" fill="${accent}" opacity=".12"/><path ${stroke} d="M108 62v18M108 170v18M45 125h18M153 125h18M63 80l13 13M140 157l13 13M153 80l-13 13M76 157l-13 13"/>`
}

function generateAvatarDataUrl(input) {
  const seed = `${input.name}|${input.relation}|${input.note || ''}`
  const hash = avatarHash(seed)
  const [sun, paper, accent, glow] = pickByHash(avatarPalettes, hash)
  const motif = avatarMotif(input.note)
  const initial = svgText(String(input.name || '羲').trim().slice(0, 1) || '羲')
  const relation = svgText(String(input.relation || '重要的人').slice(0, 8))
  const ringOffset = 38 + (hash % 28)
  const text = `${input.name || ''}${input.relation || ''}${input.note || ''}`.toLowerCase()
  const isChild = /孩子|宝宝|女儿|儿子|小朋友|学生/.test(text)
  const isElder = /爸爸|妈妈|父亲|母亲|爷爷|奶奶|外公|外婆|长辈/.test(text)
  const isFemale = input.gender === 'female' || (input.gender !== 'male' && /她|妈妈|母亲|姐姐|妹妹|女|女士|奶奶|外婆|闺蜜/.test(text))
  const skinColors = ['#f2c9a8', '#e8b990', '#f5d6bb', '#dca276']
  const hairColors = ['#2f2924', '#47352a', '#6d4a34', '#3c3b35']
  const clothesColors = ['#a94a3d', '#7a8f68', '#6d7fa5', '#b28a42', '#8f6b58']
  const skin = pickByHash(skinColors, hash, 3)
  const hair = pickByHash(hairColors, hash, 5)
  const clothes = pickByHash(clothesColors, hash, 7)
  const eyeY = isChild ? 105 : 104
  const faceHeight = isChild ? 58 : isElder ? 66 : 62
  const hairPath = isFemale
    ? 'M61 109c-5-43 17-74 48-74s53 30 48 74c-4 32-20 51-48 51s-44-19-48-51Z'
    : 'M64 98c1-35 18-60 45-60s43 22 45 60c-16-11-31-16-45-16s-29 5-45 16Z'
  const smilePath = isElder ? 'M91 129c9 8 25 8 34 0' : 'M91 128c10 10 25 10 35 0'
  const accessory = motif === 'book'
    ? `<path d="M155 146c13-5 22-3 31 4v24c-9-7-18-9-31-4v-24Z" fill="#fff8ea" opacity=".86"/><path d="M155 146v24M170 148v19" stroke="${accent}" stroke-width="2" opacity=".55"/>`
    : motif === 'cup'
      ? `<path d="M156 145h24c0 13-5 21-12 21s-12-8-12-21Z" fill="#fff8ea" opacity=".9"/><path d="M180 149h7c5 0 5 12-2 13h-5" stroke="${accent}" stroke-width="3" fill="none" opacity=".55"/>`
      : motif === 'music'
        ? `<path d="M166 133v28" stroke="${accent}" stroke-width="4" stroke-linecap="round" opacity=".55"/><path d="M166 135l18-4v12l-18 4" fill="${accent}" opacity=".28"/><circle cx="158" cy="164" r="8" fill="${accent}" opacity=".22"/>`
        : motif === 'leaf'
          ? `<path d="M158 164c5-23 18-36 39-43-2 24-16 38-39 43Z" fill="${accent}" opacity=".18"/><path d="M158 164c8-17 20-29 35-40" stroke="${accent}" stroke-width="3" fill="none" opacity=".42"/>`
          : motif === 'mountain'
            ? `<path d="M149 166l19-25 13 16 8-10 15 19" stroke="${accent}" stroke-width="3" fill="none" opacity=".42"/>`
            : `<circle cx="179" cy="145" r="15" fill="${accent}" opacity=".13"/><path d="M179 124v8M179 158v8M158 145h8M192 145h8" stroke="${accent}" stroke-width="3" stroke-linecap="round" opacity=".36"/>`
  const ageLines = isElder ? `<path d="M83 116c5-3 11-3 16 0M117 116c5-3 11-3 16 0" stroke="${accent}" stroke-width="2" opacity=".22" fill="none"/>` : ''
  const childCheek = isChild ? `<circle cx="83" cy="119" r="7" fill="#d87568" opacity=".18"/><circle cx="134" cy="119" r="7" fill="#d87568" opacity=".18"/>` : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 216 216"><defs><radialGradient id="bg" cx="34%" cy="22%" r="84%"><stop offset="0" stop-color="${glow}"/><stop offset=".5" stop-color="${paper}"/><stop offset="1" stop-color="${sun}"/></radialGradient><filter id="soft"><feGaussianBlur stdDeviation="6"/></filter><clipPath id="faceClip"><rect x="0" y="0" width="216" height="216" rx="64"/></clipPath></defs><rect width="216" height="216" rx="64" fill="url(#bg)"/><g clip-path="url(#faceClip)"><circle cx="48" cy="42" r="34" fill="${sun}" opacity=".36" filter="url(#soft)"/><circle cx="108" cy="108" r="77" fill="none" stroke="${accent}" stroke-width="1.5" stroke-dasharray="4 10" opacity=".28" transform="rotate(${ringOffset} 108 108)"/><path d="M49 205c8-38 31-61 59-61s52 23 60 61H49Z" fill="${clothes}" opacity=".9"/><path d="M77 156c9 17 52 17 62 0v22c-14 13-47 13-62 0v-22Z" fill="${skin}"/><path d="${hairPath}" fill="${hair}"/><ellipse cx="108" cy="101" rx="42" ry="${faceHeight}" fill="${skin}"/><path d="M67 101c-9 7-8 25 4 30M149 101c9 7 8 25-4 30" stroke="${skin}" stroke-width="12" stroke-linecap="round"/><path d="M75 80c12-14 26-21 43-21 12 0 25 5 37 16-10-28-26-42-48-42-25 0-43 17-49 51 6 0 11-1 17-4Z" fill="${hair}"/><circle cx="91" cy="${eyeY}" r="4" fill="#3a2d26" opacity=".82"/><circle cx="125" cy="${eyeY}" r="4" fill="#3a2d26" opacity=".82"/>${ageLines}${childCheek}<path d="${smilePath}" stroke="#8b5140" stroke-width="4" stroke-linecap="round" fill="none" opacity=".62"/><path d="M107 107c-3 7-5 13-2 18" stroke="#9d6751" stroke-width="2.6" stroke-linecap="round" fill="none" opacity=".34"/><path d="M64 162c23 20 66 20 89 0" stroke="#fff8ea" stroke-width="5" stroke-linecap="round" opacity=".35"/>${accessory}<text x="28" y="190" font-family="PingFang SC, Noto Serif SC, serif" font-size="24" font-weight="700" fill="${accent}" opacity=".84">${initial}</text><text x="108" y="199" text-anchor="middle" font-family="PingFang SC, system-ui, sans-serif" font-size="14" letter-spacing="2" fill="${accent}" opacity=".72">${relation}</text></g></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const avatarRules = [
  ['bald-glasses', /光头.*眼镜|眼镜.*光头/],
  ['elder-bald-grandpa', /光头|秃头|秃顶/],
  ['receding-office', /发际线|脱发|头发少/],
  ['white-beard', /白胡子|大胡子|胡子|络腮胡/],
  ['elder-grandpa', /爷爷|外公|姥爷|祖父|老人|老年/],
  ['elder-grandma', /奶奶|外婆|姥姥|祖母|老人|老年/],
  ['middle-father', /爸爸|父亲|中年|叔叔|伯伯|舅舅|姨父|姑父/],
  ['middle-mother', /妈妈|母亲|阿姨|姨妈|姑姑|舅妈|中年/],
  ['fitness', /健身|运动|撸铁|健美|锻炼|瑜伽/],
  ['sporty-runner', /跑步|跑者|马拉松/],
  ['muscular', /肌肉|强壮|壮|力量|健硕/],
  ['tall-confident', /高大|高个|很高|高挑/],
  ['travel-scarf', /旅游|旅行|出差|看世界|攻略/],
  ['coffee-cup', /咖啡|拿铁|美式|手冲|奶茶|饮品/],
  ['middle-tea-calm', /喝茶|茶|茶艺/],
  ['round-glasses', /眼镜|戴镜|近视/],
  ['chubby-auntie', /胖|胖子|圆润|可爱胖|肉肉|微胖/],
  ['slim-quiet', /瘦|瘦子|苗条|清瘦/],
  ['scholar-glasses', /书生|学霸|学习|学术|研究|老师|教授/],
  ['middle-teacher', /老师|教师|班主任|导师/],
  ['bookish-nerd', /书呆|宅|程序员|代码|技术|电脑|游戏|二次元/],
  ['programmer', /程序员|代码|研发|技术|算法|ai|数据/],
  ['reader', /读书|阅读|书|历史|文学|写作|诗/],
  ['cheerful-jokester', /开心果|幽默|搞笑|爱笑|快乐|活泼|开朗/],
  ['mature-business', /社会|社交|人脉|外向|江湖|成熟|应酬|商务|西装|职场|老板|领导|经理|客户/],
  ['mature-drink', /酒量|喝酒|白酒|啤酒|红酒|酒/],
  ['hiking-hat', /徒步|远足|露营|户外|背包/],
  ['climber', /爬山|登山|山|攀岩/],
  ['cycling-helmet', /骑行|自行车|单车/],
  ['photographer', /摄影|拍照|相机/],
  ['musician', /音乐|唱歌|吉他|钢琴|乐队/],
  ['foodie-chef', /美食|做饭|厨艺|厨师|吃货/],
  ['engineer-helmet', /工程|施工|工地|安全帽|项目经理/],
  ['doctor-gentle', /医生|护士|医疗|医院/],
  ['warmhearted-volunteer', /热心|善良|帮忙|温柔|暖心|贴心|靠谱|志愿/],
  ['long-hair-elegant', /长发|长头发/],
  ['short-hair-energetic', /短发|短头发/],
  ['introvert-calm', /安静|沉稳|内向|冷静|佛系|慢热/],
]

const avatarCatalog = {
  male: {
    young: ['male-v2-crew-cut','male-v2-sporty-runner','male-v2-cycling-helmet','male-v2-musician','male-v2-photographer','male-v2-programmer','male-v2-introvert-calm','male-v2-sunny-helper','male-v2-artistic-longhair','male-v2-hiking-hat'],
    middle: ['male-v2-middle-father','male-v2-receding-office','male-v2-bearded-uncle','male-v2-chubby-uncle','male-v2-thin-office','male-v2-dependable-square','male-v2-mature-business','male-v2-middle-teacher','male-v2-doctor-gentle','male-v2-engineer-helmet','male-v2-mature-drink','male-v2-middle-tea-calm'],
    elder: ['male-v2-elder-grandpa','male-v2-elder-bald-grandpa','male-v2-white-beard','male-v2-elder-fishing'],
  },
  female: {
    young: ['female-v2-short-hair-energetic','female-v2-long-hair-elegant','female-v2-fitness','female-v2-hiking-hat','female-v2-climber','female-v2-coffee-cup','female-v2-travel-scarf','female-v2-bookish-nerd','female-v2-photographer','female-v2-programmer-glasses','female-v2-introvert-calm','female-v2-sunny-helper'],
    middle: ['female-v2-middle-mother','female-v2-middle-bob','female-v2-mature-glasses','female-v2-chubby-auntie','female-v2-slim-office','female-v2-dependable-square','female-v2-mature-business','female-v2-middle-teacher','female-v2-doctor-gentle','female-v2-engineer-helmet','female-v2-mature-wine','female-v2-middle-tea-calm','female-v2-artistic-curly'],
    elder: ['female-v2-elder-grandma','female-v2-elder-short-white','female-v2-silver-elegant','female-v2-elder-gardening'],
  },
}

const avatarKeyMap = {
  male: {
    'elder-bald-grandpa': 'male-v2-elder-bald-grandpa', 'bald-glasses': 'male-v2-bald-glasses', 'receding-office': 'male-v2-receding-office', 'white-beard': 'male-v2-white-beard',
    'elder-grandpa': 'male-v2-elder-grandpa', 'middle-father': 'male-v2-middle-father', fitness: 'male-v2-sporty-runner', 'sporty-runner': 'male-v2-sporty-runner',
    muscular: 'male-v2-muscular', strong: 'male-v2-muscular', 'tall-confident': 'male-v2-tall-confident', 'travel-scarf': 'male-v2-travel-scarf',
    'coffee-cup': 'male-v2-coffee-cup', 'middle-tea-calm': 'male-v2-middle-tea-calm', 'round-glasses': 'male-v2-scholar-glasses',
    'chubby-auntie': 'male-v2-chubby-uncle', 'slim-quiet': 'male-v2-slim-quiet', 'scholar-glasses': 'male-v2-scholar-glasses',
    'middle-teacher': 'male-v2-middle-teacher', 'bookish-nerd': 'male-v2-bookish-nerd', programmer: 'male-v2-programmer', reader: 'male-reader',
    'cheerful-jokester': 'male-v2-cheerful-jokester', 'mature-business': 'male-v2-mature-business', 'mature-drink': 'male-v2-mature-drink',
    'hiking-hat': 'male-v2-hiking-hat', climber: 'male-v2-climber', 'cycling-helmet': 'male-v2-cycling-helmet', photographer: 'male-v2-photographer',
    musician: 'male-v2-musician', 'foodie-chef': 'male-v2-foodie-chef', 'engineer-helmet': 'male-v2-engineer-helmet', 'doctor-gentle': 'male-v2-doctor-gentle',
    'warmhearted-volunteer': 'male-v2-warmhearted-volunteer', 'long-hair-elegant': 'male-v2-artistic-longhair', 'short-hair-energetic': 'male-v2-crew-cut',
    'introvert-calm': 'male-v2-introvert-calm',
  },
  female: {
    'elder-grandma': 'female-v2-elder-grandma', 'elder-bald-grandpa': 'female-v2-elder-short-white', 'bald-glasses': 'female-v2-mature-glasses',
    'white-beard': 'female-v2-elder-short-white', 'middle-mother': 'female-v2-middle-mother', fitness: 'female-v2-fitness', 'sporty-runner': 'female-v2-sporty-runner',
    muscular: 'female-v2-fitness', strong: 'female-v2-fitness', 'tall-confident': 'female-v2-tall-confident', 'travel-scarf': 'female-v2-travel-scarf',
    'coffee-cup': 'female-v2-coffee-cup', 'middle-tea-calm': 'female-v2-middle-tea-calm', 'round-glasses': 'female-v2-round-glasses',
    'chubby-auntie': 'female-v2-chubby-auntie', 'slim-quiet': 'female-v2-slim-quiet', 'scholar-glasses': 'female-v2-scholar',
    'middle-teacher': 'female-v2-middle-teacher', 'bookish-nerd': 'female-v2-bookish-nerd', programmer: 'female-v2-programmer-glasses', reader: 'female-v2-scholar',
    'cheerful-jokester': 'female-v2-cheerful-jokester', 'mature-business': 'female-v2-mature-business', 'mature-drink': 'female-v2-mature-wine',
    'hiking-hat': 'female-v2-hiking-hat', climber: 'female-v2-climber', 'cycling-helmet': 'female-v2-cycling-helmet', photographer: 'female-v2-photographer',
    musician: 'female-v2-musician', 'foodie-chef': 'female-v2-foodie-chef', 'engineer-helmet': 'female-v2-engineer-helmet', 'doctor-gentle': 'female-v2-doctor-gentle',
    'warmhearted-volunteer': 'female-v2-warmhearted-volunteer', 'long-hair-elegant': 'female-v2-long-hair-elegant', 'short-hair-energetic': 'female-v2-short-hair-energetic',
    'introvert-calm': 'female-v2-introvert-calm',
  },
}

function avatarGender(input) {
  const text = `${input.name || ''}${input.relation || ''}${input.note || ''}`
  if (input.gender === 'female' || /她|女|女士|妈妈|母亲|姐姐|妹妹|奶奶|外婆|闺蜜/.test(text)) return 'female'
  if (input.gender === 'male' || /他|男|先生|爸爸|父亲|哥哥|弟弟|爷爷|外公|兄弟/.test(text)) return 'male'
  return avatarHash(text) % 2 === 0 ? 'female' : 'male'
}

function avatarAgeBucket(input) {
  const text = `${input.name || ''}${input.relation || ''}${input.note || ''}`
  const birthdayYear = Number(String(input.birthday || '').slice(0, 4))
  if (Number.isInteger(birthdayYear) && birthdayYear >= 1900) {
    const age = new Date().getFullYear() - birthdayYear
    if (age >= 60) return 'elder'
    if (age >= 45) return 'middle'
    return 'young'
  }
  if (/爷爷|奶奶|外公|外婆|姥姥|姥爷|祖父|祖母|老人|老年|退休/.test(text)) return 'elder'
  if (/爸爸|妈妈|父亲|母亲|叔叔|阿姨|伯伯|姑姑|舅舅|中年|领导|老板/.test(text)) return 'middle'
  return 'young'
}

function avatarKeyBucket(gender, key) {
  for (const bucket of ['young', 'middle', 'elder']) {
    if (avatarCatalog[gender][bucket].includes(key)) return bucket
  }
  return null
}

function closestAgeSafeAvatar(gender, ageBucket, key) {
  if (!key) return null
  const bucket = avatarKeyBucket(gender, key)
  if (!bucket || bucket === ageBucket) return key
  const allowedOrder = ageBucket === 'elder' ? ['elder', 'middle'] : ageBucket === 'middle' ? ['middle', 'elder'] : ['young', 'middle']
  return allowedOrder.includes(bucket) ? key : null
}

function selectPrebuiltAvatarPath(input) {
  const gender = avatarGender(input)
  const ageBucket = avatarAgeBucket(input)
  const text = `${input.name || ''} ${input.relation || ''} ${input.note || ''}`.toLowerCase()
  const matchedRule = avatarRules.find(([, pattern]) => pattern.test(text))?.[0]
  const mapped = matchedRule ? avatarKeyMap[gender][matchedRule] : null
  const ageSafeMatched = closestAgeSafeAvatar(gender, ageBucket, mapped)
  const fallbackKeys = avatarCatalog[gender][ageBucket]
  const key = ageSafeMatched || fallbackKeys[avatarHash(text) % fallbackKeys.length]
  return `/assets/ai-avatars/${key}.jpg`
}

async function createPerson(userId, input) {
  return asUser(userId, async client => {
    const [year, month, day] = input.birthday.split('-').map(Number)
    const birthYear = input.birthYearKnown ? year : null
    const isLeapMonth = input.calendarType === 'lunar' ? input.isLeapMonth : false
    const avatarPath = input.avatarPath || selectPrebuiltAvatarPath(input) || generateAvatarDataUrl(input)
    const person = (await client.query(
      'insert into public.people (user_id, name, relationship, gender, avatar_path, notes) values ($1,$2,$3,$4,$5,$6) returning id,name,relationship,gender,avatar_path,notes',
      [userId, input.name, input.relation, input.gender, avatarPath, input.note])).rows[0]
    await client.query('insert into public.birthdays (person_id,calendar_type,birth_year,birth_month,birth_day,is_leap_month) values ($1,$2,$3,$4,$5,$6)', [person.id,input.calendarType,birthYear,month,day,isLeapMonth])
    const groups = await replacePersonGroups(client, userId, person.id, inputGroupNames(input))
    await client.query("insert into public.reminder_rules (person_id,days_before,send_time,channels) values ($1,3,'09:00',$2)", [person.id, defaultReminderChannels()])
    return { ...person, groups, group: groups[0], calendar_type: input.calendarType, birth_year: birthYear, birth_month: month, birth_day: day, is_leap_month: isLeapMonth }
  })
}

async function updatePerson(userId, id, input) {
  return asUser(userId, async client => {
    const current = (await client.query(`select p.id,p.name,p.relationship,p.gender,p.avatar_path,p.notes,b.calendar_type,b.birth_year,b.birth_month,b.birth_day,b.is_leap_month
      from public.people p join public.birthdays b on b.person_id=p.id where p.id=$1`, [id])).rows[0]
    if (!current) return null
    const birthday = input.birthday ? input.birthday.split('-').map(Number) : [current.birth_year,current.birth_month,current.birth_day]
    const birthYear = input.birthYearKnown === undefined ? birthday[0] : input.birthYearKnown ? birthday[0] : null
    const calendarType = input.calendarType ?? current.calendar_type
    const isLeapMonth = calendarType === 'lunar' ? input.isLeapMonth ?? current.is_leap_month : false
    const nextName = input.name ?? current.name
    const nextRelation = input.relation ?? current.relationship
    const nextGender = input.gender ?? current.gender ?? 'unknown'
    const nextNote = input.note ?? current.notes
    const shouldRegenerateAvatar = input.name !== undefined || input.relation !== undefined || input.gender !== undefined || input.note !== undefined || !current.avatar_path
    const avatarPath = input.avatarPath || (shouldRegenerateAvatar
      ? selectPrebuiltAvatarPath({ name: nextName, relation: nextRelation, gender: nextGender, note: nextNote })
      : current.avatar_path)
    const person = (await client.query(`update public.people set name=$2,relationship=$3,gender=$4,notes=$5,avatar_path=$6,updated_at=now() where id=$1
      returning id,name,relationship,gender,avatar_path,notes`, [id,nextName,nextRelation,nextGender,nextNote,avatarPath])).rows[0]
    await client.query(`update public.birthdays set calendar_type=$2,birth_year=$3,birth_month=$4,birth_day=$5,is_leap_month=$6,updated_at=now() where person_id=$1`,
      [id,calendarType,birthYear,birthday[1],birthday[2],isLeapMonth])
    let groups
    if (input.group || input.groups) groups = await replacePersonGroups(client, userId, id, inputGroupNames(input))
    else groups = (await client.query(`
      select coalesce(array_agg(g.name order by g.sort_order) filter (where g.name is not null), '{}') as groups
      from public.person_groups pg join public.groups g on g.id=pg.group_id where pg.person_id=$1
    `, [id])).rows[0].groups
    return {...person,calendar_type:calendarType,birth_year:birthYear,birth_month:birthday[1],birth_day:birthday[2],is_leap_month:isLeapMonth,groups,group:groups?.[0]}
  })
}

async function archivePerson(userId, id) {
  return asUser(userId, async client => (await client.query('update public.people set archived_at=now() where id=$1 returning id',[id])).rowCount === 1)
}

async function deletePerson(userId, id) {
  return asUser(userId, async client => (await client.query('delete from public.people where id=$1 and user_id=$2 returning id',[id, userId])).rowCount === 1)
}

async function login(input) {
  const identifier = input.email.trim().toLowerCase()
  const { rows } = await pool.query(`
    select c.user_id, c.email, c.username, c.password_salt, c.password_hash, p.role
    from auth.local_credentials c
    left join public.profiles p on p.id = c.user_id
    where lower(c.email)=lower($1) or lower(c.username)=lower($1)
    limit 1
  `,[identifier])
  const credential = rows[0]
  if (!credential) return null
  const computed = Buffer.from(scryptSync(input.password,credential.password_salt,64).toString('hex'))
  const expected = Buffer.from(credential.password_hash)
  if (computed.length !== expected.length || !timingSafeEqual(computed,expected)) return null
  return { token: issueToken({id:credential.user_id,email:credential.email}), user:{id:credential.user_id,email:credential.email,username:credential.username,role:credential.role ?? 'user'} }
}

function hashWechatSessionKey(sessionKey) {
  return sessionKey ? createHash('sha256').update(`${process.env.SESSION_SECRET}:${sessionKey}`).digest('hex') : null
}

async function fetchWechatSession(code) {
  if (!WECHAT_MINIPROGRAM_APPID || !WECHAT_MINIPROGRAM_SECRET) {
    const error = new Error('WECHAT_MINIPROGRAM_NOT_CONFIGURED')
    error.statusCode = 503
    throw error
  }
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
  url.searchParams.set('appid', WECHAT_MINIPROGRAM_APPID)
  url.searchParams.set('secret', WECHAT_MINIPROGRAM_SECRET)
  url.searchParams.set('js_code', code)
  url.searchParams.set('grant_type', 'authorization_code')
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.errcode) {
    const error = new Error(`WECHAT_CODE2SESSION_FAILED:${body.errcode || response.status}`)
    error.statusCode = 401
    throw error
  }
  if (!body.openid) {
    const error = new Error('WECHAT_OPENID_MISSING')
    error.statusCode = 401
    throw error
  }
  return body
}

async function loginWithWechatMiniProgram(input) {
  const session = await fetchWechatSession(input.code)
  const appid = WECHAT_MINIPROGRAM_APPID
  const openid = session.openid
  const unionid = session.unionid || null
  const sessionKeyHash = hashWechatSessionKey(session.session_key)

  const client = await pool.connect()
  try {
    await client.query('begin')
    const existing = await client.query(`
      select u.id, u.email
      from auth.wechat_identities w
      join auth.users u on u.id = w.user_id
      where w.appid = $1 and w.openid = $2
    `, [appid, openid])

    let user = existing.rows[0]
    if (!user) {
      const userId = randomUUID()
      const email = `wx_${openid}@wechat.local`
      await client.query('insert into auth.users (id,email) values ($1,$2)', [userId, email])
      await client.query('insert into public.profiles (id,display_name) values ($1,$2)', [userId, '微信用户'])
      await client.query(`
        insert into auth.wechat_identities (user_id, appid, openid, unionid, session_key_hash)
        values ($1,$2,$3,$4,$5)
      `, [userId, appid, openid, unionid, sessionKeyHash])
      user = { id: userId, email }
    } else {
      await client.query(`
        update auth.wechat_identities
        set unionid = coalesce($3, unionid), session_key_hash = $4, updated_at = now()
        where appid = $1 and openid = $2
      `, [appid, openid, unionid, sessionKeyHash])
    }

    await client.query('commit')
    return {
      token: issueToken({ id: user.id, email: user.email }),
      user: { id: user.id, email: user.email, provider: 'wechat_miniprogram' },
    }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  if (req.method === 'OPTIONS') {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return json(res,403,{error:'Origin not allowed'})
    res.writeHead(204, {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET,POST,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Max-Age':'600',Vary:'Origin'}); return res.end()
  }
  try {
    if (req.method === 'GET' && req.url === '/health') { await pool.query('select 1'); return json(res,200,{status:'ok',database:'connected'},origin) }
    if (req.method === 'POST' && req.url === '/api/auth/login') {
      const parsed=loginSchema.safeParse(await readJson(req)); if(!parsed.success) return json(res,400,{error:'VALIDATION_ERROR'},origin)
      const session=await login(parsed.data); return session ? json(res,200,{data:session},origin) : json(res,401,{error:'INVALID_CREDENTIALS'},origin)
    }
    if (req.method === 'POST' && req.url === '/api/auth/wechat-login') {
      const parsed = wechatLoginSchema.safeParse(await readJson(req))
      if (!parsed.success) return json(res,400,{error:'VALIDATION_ERROR'},origin)
      return json(res,200,{data:await loginWithWechatMiniProgram(parsed.data)},origin)
    }
    const auth = verifyToken(tokenFromRequest(req))
    if (!auth) return json(res,401,{error:'UNAUTHORIZED'},origin)
    if (req.method === 'GET' && req.url === '/api/session') return json(res,200,{data:{user:{id:auth.sub,email:auth.email}}},origin)
    if (req.method === 'GET' && req.url === '/api/people') return json(res,200,{data:await listPeople(auth.sub)},origin)
    if (req.method === 'GET' && req.url === '/api/groups') return json(res,200,{data:await listGroups(auth.sub)},origin)
    if (req.method === 'POST' && req.url === '/api/groups') {
      const parsed = groupSchema.safeParse(await readJson(req))
      if (!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      return json(res,201,{data:await createGroup(auth.sub, parsed.data)},origin)
    }
    if (req.method === 'GET' && req.url === '/api/notifications/channels') return json(res,200,{data:configuredChannels()},origin)
    if (req.method === 'GET' && req.url === '/api/reminders/preview') return json(res,200,{data:await listReminderPreview(auth.sub)},origin)
    if (req.method === 'GET' && req.url === '/api/reminders/jobs') return json(res,200,{data:await listReminderJobs(auth.sub)},origin)
    if (req.method === 'GET' && req.url === '/api/care-records') return json(res,200,{data:await listCareRecords(auth.sub)},origin)
    if (req.method === 'GET' && req.url === '/api/export/json') return attachmentJson(res, `xihe-export-${new Date().toISOString().slice(0,10)}.json`, await exportUserData(auth.sub), origin)
    if (req.method === 'GET' && req.url === '/api/export/people.csv') return attachmentCsv(res, `xihe-people-${new Date().toISOString().slice(0,10)}.csv`, await exportPeopleCsvRows(auth.sub), origin)
    if (req.method === 'POST' && req.url === '/api/backups/json') return json(res,201,{data:await createJsonBackup(auth.sub)},origin)
    if (req.method === 'POST' && req.url === '/api/import/json/preview') {
      const parsed = importPreviewSchema.safeParse(await readJson(req, 5 * 1024 * 1024))
      if (!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      return json(res,200,{data:{preview:previewJsonImport(auth.sub, parsed.data.backup), current:await currentImportTargetStats(auth.sub)}},origin)
    }
    if (req.method === 'POST' && req.url === '/api/import/json/restore') {
      const parsed = importRestoreSchema.safeParse(await readJson(req, 5 * 1024 * 1024))
      if (!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      return json(res,201,{data:await restoreJsonImport(auth.sub, parsed.data.backup)},origin)
    }
    if (req.method === 'POST' && req.url === '/api/reminders/generate') return json(res,200,{data:await generateReminderJobs(auth.sub)},origin)
    if (req.method === 'POST' && req.url === '/api/reminders/run') {
      const parsed = runReminderSchema.safeParse(await readJson(req))
      if (!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      return json(res,200,{data:await runDueReminderJobs(auth.sub, parsed.data)},origin)
    }
    const reminderJobMatch = req.url?.match(/^\/api\/reminders\/jobs\/([0-9a-f-]{36})$/i)
    if (reminderJobMatch && req.method === 'PATCH') {
      const parsed = updateReminderJobSchema.safeParse(await readJson(req))
      if (!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      const updated = await updateReminderJob(auth.sub, reminderJobMatch[1], parsed.data)
      return updated ? json(res,200,{data:updated},origin) : json(res,404,{error:'NOT_FOUND'},origin)
    }
    if (req.method === 'POST' && req.url === '/api/care-records') {
      const parsed = careRecordSchema.safeParse(await readJson(req))
      if (!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      const created = await createCareRecord(auth.sub, parsed.data)
      return created ? json(res,201,{data:created},origin) : json(res,404,{error:'NOT_FOUND'},origin)
    }
    if (req.method === 'POST' && req.url === '/api/people') {
      const parsed = personSchema.safeParse(await readJson(req, 1_200_000))
      if (!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      return json(res,201,{data:await createPerson(auth.sub,parsed.data)},origin)
    }
    const groupMatch=req.url?.match(/^\/api\/groups\/([0-9a-f-]{36})$/i)
    if (groupMatch && req.method === 'PATCH') {
      const parsed=updateGroupSchema.safeParse(await readJson(req)); if(!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      const updated=await updateGroup(auth.sub, groupMatch[1], parsed.data); return updated ? json(res,200,{data:updated},origin) : json(res,404,{error:'NOT_FOUND'},origin)
    }
    if (groupMatch && req.method === 'DELETE') return (await deleteGroup(auth.sub, groupMatch[1])) ? json(res,200,{data:{deleted:true}},origin) : json(res,404,{error:'NOT_FOUND'},origin)
    const match=req.url?.match(/^\/api\/people\/([0-9a-f-]{36})$/i)
    const personCareMatch=req.url?.match(/^\/api\/people\/([0-9a-f-]{36})\/care-records$/i)
    if (personCareMatch && req.method === 'GET') return json(res,200,{data:await listCareRecords(auth.sub, personCareMatch[1])},origin)
    if (match && req.method === 'PATCH') {
      const parsed=updatePersonSchema.safeParse(await readJson(req, 1_200_000)); if(!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      const updated=await updatePerson(auth.sub,match[1],parsed.data); return updated ? json(res,200,{data:updated},origin) : json(res,404,{error:'NOT_FOUND'},origin)
    }
    if (match && req.method === 'DELETE') return (await deletePerson(auth.sub,match[1])) ? json(res,200,{data:{deleted:true}},origin) : json(res,404,{error:'NOT_FOUND'},origin)
    return json(res,404,{error:'NOT_FOUND'},origin)
  } catch (error) {
    const code = error?.statusCode || (error?.message === 'BODY_TOO_LARGE' ? 413 : error?.message === 'INVALID_JSON' ? 400 : 500)
    if (code === 500) console.error('[xihe-api]', error?.message)
    return json(res,code,{error:code === 500 ? 'INTERNAL_ERROR' : error.message},origin)
  }
})
await ensureRuntimeSchema()
server.listen(PORT,HOST,()=>console.log(`Xihe API listening on http://${HOST}:${PORT}`))
async function shutdown(){server.close(async()=>{await pool.end();process.exit(0)})}
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown)
