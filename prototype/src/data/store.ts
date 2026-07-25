import { seedPeople, type Person, type PersonDraft } from '../domain/models'

const PEOPLE_KEY = 'xihe.people.v1'
const GROUPS_KEY = 'xihe.groups.v1'

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

export const dataStore = {
  loadPeople(): Person[] {
    return safeParse<Person[]>(localStorage.getItem(PEOPLE_KEY), seedPeople)
  },
  savePeople(people: Person[]) {
    localStorage.setItem(PEOPLE_KEY, JSON.stringify(people))
  },
  createPerson(people: Person[], draft: PersonDraft): Person[] {
    const [, month = '1', day = '1'] = draft.birthday.split('-')
    const person: Person = {
      ...draft,
      id: Date.now(),
      date: '待计算',
      days: 999,
      fullDate: `${Number(month)}月${Number(day)}日`,
      image: draft.avatarPath || '/assets/avatar-zhou-ziheng.png',
      avatarPath: draft.avatarPath,
      gender: draft.gender ?? 'unknown',
      note: draft.note ?? '',
      birthYearKnown: draft.birthYearKnown ?? true,
      isLeapMonth: draft.isLeapMonth ?? false,
    }
    const next = [...people, person]
    this.savePeople(next)
    return next
  },
  updatePerson(people: Person[], id: string | number, draft: Partial<PersonDraft>): Person[] {
    const next = people.map(person => person.id === id ? {
      ...person,
      ...draft,
      relation: draft.relation ?? person.relation,
      group: draft.group ?? person.group,
      groups: draft.groups ?? person.groups,
      gender: draft.gender ?? person.gender,
      image: draft.avatarPath ?? person.image,
      avatarPath: draft.avatarPath ?? person.avatarPath,
      note: draft.note ?? person.note,
      birthday: draft.birthday ?? person.birthday,
      calendarType: draft.calendarType ?? person.calendarType,
      birthYearKnown: draft.birthYearKnown ?? person.birthYearKnown,
      isLeapMonth: draft.isLeapMonth ?? person.isLeapMonth,
    } : person)
    this.savePeople(next)
    return next
  },
  loadGroups(): string[] {
    return safeParse<string[]>(localStorage.getItem(GROUPS_KEY), ['全部', '亲人', '朋友', '同事'])
  },
  saveGroups(groups: string[]) {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups))
  },
}
