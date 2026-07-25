export type CalendarType = 'solar' | 'lunar'

export interface Person {
  id: number
  name: string
  relation: string
  group: string
  groups?: string[]
  date: string
  fullDate: string
  days: number
  nextDate?: string
  nextDateLabel?: string
  birthdayLabel?: string
  isToday?: boolean
  image: string
  note: string
  calendarType: CalendarType
  birthYearKnown?: boolean
  isLeapMonth?: boolean
  birthday: string
}

export interface PersonDraft {
  name: string
  relation: string
  group: string
  groups?: string[]
  birthday: string
  calendarType: CalendarType
  birthYearKnown?: boolean
  isLeapMonth?: boolean
  note?: string
}

export const seedPeople: Person[] = [
  { id: 1, name: '林晓曦', relation: '姐姐', group: '亲人', date: '今天', fullDate: '5月18日', days: 0, image: '/assets/portrait-lin-xiaoxi.png', note: '喜欢手冲咖啡，最近在学陶艺。', calendarType: 'lunar', birthday: '1995-05-18' },
  { id: 2, name: '周子恒', relation: '好友', group: '朋友', date: '明天', fullDate: '5月19日', days: 1, image: '/assets/avatar-zhou-ziheng.png', note: '今年准备换工作，喜欢徒步。', calendarType: 'solar', birthday: '1996-05-19' },
  { id: 3, name: '妈妈', relation: '母亲', group: '亲人', date: '后天', fullDate: '5月20日', days: 2, image: '/assets/avatar-mother.png', note: '想去苏州旅行，少糖饮食。', calendarType: 'lunar', birthday: '1970-05-20' },
  { id: 4, name: '陈一航', relation: '同事', group: '同事', date: '大后天', fullDate: '5月21日', days: 3, image: '/assets/avatar-chen-yihang.png', note: '负责产品研发，喜欢读历史。', calendarType: 'solar', birthday: '1993-05-21' },
]
