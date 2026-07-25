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
  group: z.string().trim().min(1).max(50), birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  groups: z.array(z.string().trim().min(1).max(50)).max(8).optional(),
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
    select p.id, p.name, p.relationship, p.avatar_path, p.notes,
           b.calendar_type, b.birth_year, b.birth_month, b.birth_day, b.is_leap_month,
           coalesce(array_agg(g.name order by g.sort_order) filter (where g.name is not null), '{}') as groups
    from public.people p join public.birthdays b on b.person_id = p.id
    left join public.person_groups pg on pg.person_id = p.id left join public.groups g on g.id = pg.group_id
    where p.archived_at is null group by p.id, b.id order by b.birth_month, b.birth_day, p.name
  `)).rows)
}
async function listGroups(userId) { return asUser(userId, async client => (await client.query('select id, name, color, sort_order from public.groups order by sort_order, name')).rows) }

function inputGroupNames(input) {
  const names = [...(Array.isArray(input.groups) ? input.groups : []), input.group].filter(Boolean)
  return [...new Set(names.map(name => String(name).trim()).filter(Boolean))].slice(0, 8)
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
      client.query('select id, name, relationship, avatar_path, notes, archived_at, created_at, updated_at from public.people where user_id=$1 order by created_at, name', [userId]),
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
        insert into public.people (user_id, name, relationship, avatar_path, notes, archived_at)
        values ($1,$2,$3,$4,$5,$6)
        returning id
      `, [
        userId,
        name,
        cleanText(person?.relationship) || null,
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

async function createPerson(userId, input) {
  return asUser(userId, async client => {
    const [year, month, day] = input.birthday.split('-').map(Number)
    const birthYear = input.birthYearKnown ? year : null
    const isLeapMonth = input.calendarType === 'lunar' ? input.isLeapMonth : false
    const person = (await client.query(
      'insert into public.people (user_id, name, relationship, notes) values ($1,$2,$3,$4) returning id,name,relationship,notes',
      [userId, input.name, input.relation, input.note])).rows[0]
    await client.query('insert into public.birthdays (person_id,calendar_type,birth_year,birth_month,birth_day,is_leap_month) values ($1,$2,$3,$4,$5,$6)', [person.id,input.calendarType,birthYear,month,day,isLeapMonth])
    const groups = await replacePersonGroups(client, userId, person.id, inputGroupNames(input))
    await client.query("insert into public.reminder_rules (person_id,days_before,send_time,channels) values ($1,3,'09:00',$2)", [person.id, defaultReminderChannels()])
    return { ...person, groups, group: groups[0], calendar_type: input.calendarType, birth_year: birthYear, birth_month: month, birth_day: day, is_leap_month: isLeapMonth }
  })
}

async function updatePerson(userId, id, input) {
  return asUser(userId, async client => {
    const current = (await client.query(`select p.id,p.name,p.relationship,p.notes,b.calendar_type,b.birth_year,b.birth_month,b.birth_day,b.is_leap_month
      from public.people p join public.birthdays b on b.person_id=p.id where p.id=$1`, [id])).rows[0]
    if (!current) return null
    const birthday = input.birthday ? input.birthday.split('-').map(Number) : [current.birth_year,current.birth_month,current.birth_day]
    const birthYear = input.birthYearKnown === undefined ? birthday[0] : input.birthYearKnown ? birthday[0] : null
    const calendarType = input.calendarType ?? current.calendar_type
    const isLeapMonth = calendarType === 'lunar' ? input.isLeapMonth ?? current.is_leap_month : false
    const person = (await client.query(`update public.people set name=$2,relationship=$3,notes=$4,updated_at=now() where id=$1
      returning id,name,relationship,notes`, [id,input.name ?? current.name,input.relation ?? current.relationship,input.note ?? current.notes])).rows[0]
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
      const parsed = personSchema.safeParse(await readJson(req))
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
      const parsed=updatePersonSchema.safeParse(await readJson(req)); if(!parsed.success) return json(res,400,{error:'VALIDATION_ERROR',details:parsed.error.flatten()},origin)
      const updated=await updatePerson(auth.sub,match[1],parsed.data); return updated ? json(res,200,{data:updated},origin) : json(res,404,{error:'NOT_FOUND'},origin)
    }
    if (match && req.method === 'DELETE') return (await archivePerson(auth.sub,match[1])) ? json(res,200,{data:{archived:true}},origin) : json(res,404,{error:'NOT_FOUND'},origin)
    return json(res,404,{error:'NOT_FOUND'},origin)
  } catch (error) {
    const code = error?.statusCode || (error?.message === 'BODY_TOO_LARGE' ? 413 : error?.message === 'INVALID_JSON' ? 400 : 500)
    if (code === 500) console.error('[xihe-api]', error?.message)
    return json(res,code,{error:code === 500 ? 'INTERNAL_ERROR' : error.message},origin)
  }
})
server.listen(PORT,HOST,()=>console.log(`Xihe API listening on http://${HOST}:${PORT}`))
async function shutdown(){server.close(async()=>{await pool.end();process.exit(0)})}
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown)
