import type { CalendarType, Person } from './models'

const DAY_MS = 24 * 60 * 60 * 1000
const lunarFormatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  month: 'long',
  day: 'numeric',
})

const chineseMonthMap = new Map([
  ['正', 1], ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6],
  ['七', 7], ['八', 8], ['九', 9], ['十', 10], ['十一', 11], ['十二', 12], ['腊', 12],
])

export interface BirthdayOccurrence {
  calendarType: CalendarType
  birthdayLabel: string
  date: Date
  dateLabel: string
  days: number
  relativeLabel: string
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function localDateFromParts(year: number, month: number, day: number) {
  return new Date(year, month - 1, day)
}

function isoLocalDate(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function daysBetween(from: Date, to: Date) {
  return Math.round((startOfLocalDay(to).getTime() - startOfLocalDay(from).getTime()) / DAY_MS)
}

export function monthDayLabel(month: number, day: number, options?: { leap?: boolean }) {
  return `${options?.leap ? '闰' : ''}${month}月${day}日`
}

function relativeLabel(days: number) {
  if (days === 0) return '今天'
  if (days === 1) return '明天'
  if (days === 2) return '后天'
  if (days === 3) return '大后天'
  return `${days}天后`
}

function parseBirthday(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

function parseLunarParts(date: Date) {
  const parts = lunarFormatter.formatToParts(date)
  const rawMonth = parts.find(part => part.type === 'month')?.value ?? ''
  const rawDay = Number(parts.find(part => part.type === 'day')?.value)
  const normalizedMonth = rawMonth.replace('月', '').replace(/^闰/, '')
  const month = chineseMonthMap.get(normalizedMonth)
  if (!month || !rawDay) return null
  return { month, day: rawDay, leap: rawMonth.startsWith('闰') }
}

function findLunarDateInGregorianYear(year: number, month: number, day: number, isLeapMonth = false) {
  const start = localDateFromParts(year, 1, 1)
  const end = localDateFromParts(year + 1, 3, 1)
  for (let cursor = startOfLocalDay(start); cursor < end; cursor = localDateFromParts(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate() + 1)) {
    const lunar = parseLunarParts(cursor)
    if (lunar?.month === month && lunar.day === day && lunar.leap === isLeapMonth) return cursor
  }
  return null
}

function nextSolarBirthday(month: number, day: number, today: Date) {
  const currentYear = today.getFullYear()
  let candidate = localDateFromParts(currentYear, month, day)
  if (daysBetween(today, candidate) < 0) candidate = localDateFromParts(currentYear + 1, month, day)
  return candidate
}

function nextLunarBirthday(month: number, day: number, today: Date, isLeapMonth = false) {
  const year = today.getFullYear()
  const candidates = [year, year + 1]
    .map(candidateYear => findLunarDateInGregorianYear(candidateYear, month, day, isLeapMonth))
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime())
  return candidates.find(date => daysBetween(today, date) >= 0) ?? nextSolarBirthday(month, day, today)
}

export function getNextBirthday(person: Pick<Person, 'birthday' | 'calendarType' | 'isLeapMonth'>, today = new Date()): BirthdayOccurrence | null {
  const parsed = parseBirthday(person.birthday)
  if (!parsed) return null
  const date = person.calendarType === 'lunar'
    ? nextLunarBirthday(parsed.month, parsed.day, today, Boolean(person.isLeapMonth))
    : nextSolarBirthday(parsed.month, parsed.day, today)
  const days = daysBetween(today, date)
  return {
    calendarType: person.calendarType,
    birthdayLabel: `${person.calendarType === 'lunar' ? '农历' : '公历'}${monthDayLabel(parsed.month, parsed.day, { leap: person.calendarType === 'lunar' && Boolean(person.isLeapMonth) })}`,
    date,
    dateLabel: monthDayLabel(date.getMonth() + 1, date.getDate()),
    days,
    relativeLabel: relativeLabel(days),
  }
}

export function enrichPeopleWithBirthday(people: Person[], today = new Date()) {
  return people
    .map(person => {
      const occurrence = getNextBirthday(person, today)
      if (!occurrence) return person
      return {
        ...person,
        date: occurrence.relativeLabel,
        fullDate: occurrence.birthdayLabel,
        days: occurrence.days,
        nextDate: isoLocalDate(occurrence.date),
        nextDateLabel: occurrence.dateLabel,
        birthdayLabel: occurrence.birthdayLabel,
        isToday: occurrence.days === 0,
      }
    })
    .sort((a, b) => a.days - b.days || a.name.localeCompare(b.name, 'zh-CN'))
}

export function peopleInBirthdayWindow(people: Person[], days = 3) {
  return people.filter(person => person.days >= 0 && person.days <= days)
}

export function monthCounts(people: Person[]) {
  return people.reduce<Record<number, number>>((counts, person) => {
    const parsed = parseBirthday(person.birthday)
    if (!parsed) return counts
    counts[parsed.month] = (counts[parsed.month] ?? 0) + 1
    return counts
  }, {})
}
