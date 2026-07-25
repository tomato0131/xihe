import { useEffect, useMemo, useRef, useState } from 'react'
import './styles.css'
import './icons.css'
import './reminders.css'
import { dataStore } from './data/store'
import { api } from './data/api'
import type { PersonDraft } from './domain/models'
import { enrichPeopleWithBirthday, monthCounts, peopleInBirthdayWindow } from './domain/birthday'

const makeIcon = (symbol) => function Icon({ className = '' }) {
  return <span className={`symbol-icon ${className}`} aria-hidden="true">{symbol}</span>
}
const Bell = makeIcon('铃')
const CalendarBlank = makeIcon('历')
const CaretRight = makeIcon('›')
const Check = makeIcon('✓')
const CheckCircle = makeIcon('✓')
const FileArrowUp = makeIcon('档')
const Gift = makeIcon('礼')
const House = makeIcon('今')
const MagnifyingGlass = makeIcon('寻')
const NotePencil = makeIcon('笺')
const Phone = makeIcon('联')
const Plus = makeIcon('+')
const SlidersHorizontal = makeIcon('筛')
const Sparkle = makeIcon('光')
const Sun = makeIcon('日')
const UploadSimple = makeIcon('存')
const User = makeIcon('我')
const Users = makeIcon('人')
const X = makeIcon('×')

const navItems = [
  { id: 'home', label: '今时', icon: House },
  { id: 'people', label: '故人', icon: Users },
  { id: 'calendar', label: '岁历', icon: CalendarBlank },
  { id: 'profile', label: '我的', icon: User },
]

function normalizeGroups(groups) {
  const remote = groups.map(group => typeof group === 'string' ? { id: group, name: group } : group)
  return [{ id: 'all', name: '全部' }, ...remote.filter(group => group?.name && group.name !== '全部')]
}

function groupNames(groups) {
  return normalizeGroups(groups).map(group => group.name)
}

function searchText(value) {
  return String(value ?? '').trim().toLowerCase()
}

function birthdaySearchTokens(person) {
  const match = String(person?.fullDate || '').match(/(\d+)月(\d+)日/)
  if (!match) return [person?.fullDate, person?.birthdayLabel, person?.birthday]
  const month = Number(match[1])
  const day = Number(match[2])
  return [
    `${month}月${day}日`,
    `${month}月`,
    `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    `${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`,
    person?.birthdayLabel,
    person?.birthday,
  ]
}

function birthdayMatchesQuery(person, query) {
  const normalizedQuery = searchText(query)
  if (!normalizedQuery) return false
  return birthdaySearchTokens(person).some(value => searchText(value).includes(normalizedQuery))
}

function birthdayMonth(person) {
  const labelMatch = String(person?.fullDate || person?.birthdayLabel || '').match(/闰?(\d+)月/)
  if (labelMatch) return Number(labelMatch[1])
  const birthdayMatch = String(person?.birthday || '').match(/^\d{4}-(\d{2})-\d{2}$/)
  return birthdayMatch ? Number(birthdayMatch[1]) : 0
}

function nextBirthdayDate(person) {
  if (!person?.nextDate) return null
  const date = new Date(`${person.nextDate}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function isSameYearMonth(date, target) {
  return date && date.getFullYear() === target.getFullYear() && date.getMonth() === target.getMonth()
}

function birthdayFilterLabel(filter) {
  if (filter === 'all') return ''
  if (filter === 'this-month') return '本月生日'
  if (filter === 'next-month') return '下月生日'
  if (filter === 'next-30') return '未来30天'
  if (String(filter).startsWith('month-')) return `${Number(String(filter).replace('month-', ''))}月生日`
  return ''
}

function matchesBirthdayFilter(person, filter, today = new Date()) {
  if (filter === 'all') return true
  const nextDate = nextBirthdayDate(person)
  if (filter === 'this-month') return isSameYearMonth(nextDate, today)
  if (filter === 'next-month') return isSameYearMonth(nextDate, new Date(today.getFullYear(), today.getMonth() + 1, 1))
  if (filter === 'next-30') return person.days >= 0 && person.days <= 30
  if (String(filter).startsWith('month-')) return birthdayMonth(person) === Number(String(filter).replace('month-', ''))
  return true
}

function Highlight({ text, query }) {
  const value = String(text ?? '')
  const needle = String(query ?? '').trim()
  if (!needle) return <>{value}</>
  const index = value.toLowerCase().indexOf(needle.toLowerCase())
  if (index < 0) return <>{value}</>
  return <>{value.slice(0, index)}<mark className="search-hit">{value.slice(index, index + needle.length)}</mark>{value.slice(index + needle.length)}</>
}

function noteSnippet(note, query) {
  const value = String(note ?? '')
  const needle = String(query ?? '').trim()
  if (!value || !needle || !searchText(value).includes(searchText(needle))) return ''
  const index = searchText(value).indexOf(searchText(needle))
  const start = Math.max(0, index - 10)
  const end = Math.min(value.length, index + needle.length + 22)
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`
}

function App() {
  const [authenticated, setAuthenticated] = useState(() => api.hasSession())
  const [people, setPeople] = useState(() => dataStore.loadPeople())
  const [view, setView] = useState('home')
  const [peopleGroupFilter, setPeopleGroupFilter] = useState('全部')
  const [peopleBirthdayFilter, setPeopleBirthdayFilter] = useState('all')
  const [peopleCareFilter, setPeopleCareFilter] = useState('all')
  const [modal, setModal] = useState(null)
  const [selected, setSelected] = useState(null)
  const [blessingPerson, setBlessingPerson] = useState(null)
  const [toast, setToast] = useState('')
  const [doneTasks, setDoneTasks] = useState([])
  const [groups, setGroups] = useState(() => dataStore.loadGroups())
  const [reminders, setReminders] = useState([])
  const [careRecords, setCareRecords] = useState([])
  const appRef = useRef(null)
  const scheduledPeople = useMemo(() => enrichPeopleWithBirthday(people), [people])

  useEffect(() => {
    if (!authenticated || !appRef.current) return
    const elements = [...appRef.current.querySelectorAll('.reveal')]
    const animations = elements.map((element, index) => element.animate(
      [{ transform: 'translateY(24px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
      { duration: 760, delay: index * 80, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' }
    ))
    return () => animations.forEach(animation => animation.cancel())
  }, [view, authenticated])

  useEffect(() => dataStore.saveGroups(groups), [groups])

  useEffect(() => {
    if (!authenticated) return
    Promise.all([api.listPeople(), api.listGroups()])
      .then(([remotePeople, remoteGroups]) => {
        if (remotePeople.length) setPeople(remotePeople)
        setGroups(normalizeGroups(remoteGroups))
      })
      .catch(() => notify('数据库暂不可用，已切换本地模式'))
  }, [authenticated])

  const refreshReminders = async (silent = false) => {
    try {
      await api.generateReminderJobs()
      const jobs = await api.listReminderJobs()
      setReminders(jobs)
      if (!silent) notify('提醒内容已刷新')
    } catch {
      if (!silent) notify('提醒刷新失败，请确认本地 API 正常')
    }
  }

  const refreshCareRecords = async () => {
    try {
      setCareRecords(await api.listCareRecords())
    } catch {
      // 关怀记录是增强信息，失败时不打断主流程
    }
  }

  const refreshCoreData = async () => {
    const [remotePeople, remoteGroups] = await Promise.all([api.listPeople(), api.listGroups()])
    setPeople(remotePeople)
    setGroups(normalizeGroups(remoteGroups))
    await refreshCareRecords()
  }

  const runReminderJobs = async () => {
    try {
      const result = await api.runDueReminderJobs()
      const jobs = await api.listReminderJobs()
      setReminders(jobs)
      notify(result.processed ? `已发送 ${result.processed} 条提醒` : '暂无到期提醒')
    } catch {
      notify('提醒执行失败，请确认本地 API 正常')
    }
  }

  const handleReminderJob = async (id, action) => {
    try {
      await api.updateReminderJob(id, action)
      const jobs = await api.listReminderJobs()
      setReminders(jobs)
      if (action === 'complete') await refreshCareRecords()
      notify(action === 'snooze' ? '已稍后提醒' : '已记录关怀')
    } catch {
      notify('提醒处理失败，请稍后再试')
    }
  }

  useEffect(() => {
    if (!authenticated) return
    refreshReminders(true)
    refreshCareRecords()
  }, [authenticated])

  const recordCare = async (personId, actionType, content) => {
    try {
      await api.createCareRecord(personId, actionType, content)
      await refreshCareRecords()
      notify('关怀记录已收好')
      return true
    } catch {
      notify('关怀记录保存失败')
      return false
    }
  }

  const createPerson = async (draft: PersonDraft) => {
    try {
      const created = await api.createPerson(draft)
      setPeople(current => [...current, created])
      if ((draft.groups || [draft.group]).some(group => !groupNames(groups).includes(group))) setGroups(normalizeGroups(await api.listGroups()))
      notify(`${draft.name}已保存到数据库`)
    } catch {
      setPeople(current => dataStore.createPerson(current, draft))
      notify(`${draft.name}已保存在本机，稍后同步`)
    }
  }

  const updatePerson = async (id, draft: Partial<PersonDraft>) => {
    const updated = await api.updatePerson(id, draft)
    setPeople(current => current.map(person => person.id === id ? {...person, ...updated} : person))
    if ((draft.groups || (draft.group ? [draft.group] : [])).some(group => !groupNames(groups).includes(group))) setGroups(normalizeGroups(await api.listGroups()))
    setSelected(updated); setModal(null); notify('人物资料已更新')
  }

  const archivePerson = async (id) => {
    await api.archivePerson(id)
    setPeople(current => current.filter(person => person.id !== id))
    setSelected(null); notify('人物已归档')
  }

  const openBlessing = (person) => {
    if (!person) { notify('先选择一位要祝福的人'); return }
    setBlessingPerson(person)
    setSelected(null)
    setModal('bless')
  }

  const openPeopleGroup = (group) => {
    setSelected(null)
    setModal(null)
    setPeopleGroupFilter(group || '全部')
    setView('people')
    notify(`已筛选：${group}`)
  }

  const openPeopleBirthdayMonth = (month) => {
    setSelected(null)
    setModal(null)
    setPeopleGroupFilter('全部')
    setPeopleBirthdayFilter(`month-${month}`)
    setView('people')
    notify(`已查看：${month}月生日`)
  }

  const openStaleCarePeople = () => {
    setSelected(null)
    setModal(null)
    setPeopleGroupFilter('全部')
    setPeopleBirthdayFilter('all')
    setPeopleCareFilter('stale')
    setView('people')
    notify('已查看：久未关怀')
  }

  if (!authenticated) return <LoginScreen onLogin={() => setAuthenticated(true)} />

  const notify = (message) => {
    setToast(message)
    window.setTimeout(() => setToast(''), 2200)
  }

  return (
    <div className="site-shell" ref={appRef}>
      <div className="ambient-light" aria-hidden="true" />
      <main className="app-frame">
        {view === 'home' && <Home people={scheduledPeople} reminders={reminders} careRecords={careRecords} onReminderAction={handleReminderJob} onRefreshReminders={refreshReminders} onRunReminders={runReminderJobs} onPerson={setSelected} onAdd={() => setModal('add')} onBless={openBlessing} onCare={recordCare} onOpenStaleCare={openStaleCarePeople} notify={notify} doneTasks={doneTasks} setDoneTasks={setDoneTasks} />}
        {view === 'people' && <People people={scheduledPeople} careRecords={careRecords} groups={groups} group={peopleGroupFilter} setGroup={setPeopleGroupFilter} birthdayFilter={peopleBirthdayFilter} setBirthdayFilter={setPeopleBirthdayFilter} careFilter={peopleCareFilter} setCareFilter={setPeopleCareFilter} setGroups={setGroups} onPerson={setSelected} onAdd={() => setModal('add')} />}
        {view === 'calendar' && <YearView people={scheduledPeople} onPerson={setSelected} onMonth={openPeopleBirthdayMonth} />}
        {view === 'profile' && <Profile reminders={reminders} onRefreshReminders={refreshReminders} onRunReminders={runReminderJobs} onImport={() => setModal('import')} onRestoreComplete={refreshCoreData} notify={notify} onLogout={() => { api.logout(); setAuthenticated(false) }} />}
        <BottomNav view={view} setView={setView} />
      </main>

      {modal === 'add' && <AddPerson groups={groups} initialGroup={view === 'people' && peopleGroupFilter !== '全部' ? peopleGroupFilter : undefined} onClose={() => setModal(null)} onImport={() => setModal('import')} onCreate={createPerson} />}
      {modal === 'edit' && selected && <EditPerson person={selected} groups={groups} onClose={() => setModal(null)} onSave={draft => updatePerson(selected.id, draft)} />}
      {modal === 'import' && <ImportFlow onClose={() => setModal(null)} notify={notify} />}
      {modal === 'bless' && blessingPerson && <Blessing person={blessingPerson} onCare={recordCare} onClose={() => { setModal(null); setBlessingPerson(null) }} notify={notify} />}
      {selected && modal !== 'edit' && modal !== 'bless' && <PersonDetail person={selected} careRecords={careRecords.filter(record => record.person_id === selected.id)} onBless={openBlessing} onCare={recordCare} onGroup={openPeopleGroup} onClose={() => setSelected(null)} notify={notify} onEdit={() => setModal('edit')} onArchive={() => archivePerson(selected.id)} />}
      {toast && <div className="toast"><CheckCircle weight="fill" />{toast}</div>}
    </div>
  )
}

function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  return <div className="login-shell"><div className="login-sun">日</div><section className="login-card"><p className="eyebrow">重要的人，值得被记住</p><h1>羲和<span>。</span></h1><p className="login-lead">登录后，生日、分组与提醒会安全保存在你的专属空间。</p><form className="form" onSubmit={async e=>{e.preventDefault();setLoading(true);setError('');try{await api.login(email,password);onLogin()}catch{setError('账号或密码不正确')}finally{setLoading(false)}}}><label>账号<input type="text" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="admin 或邮箱" /></label><label>密码<input type="password" required minLength={10} value={password} onChange={e=>setPassword(e.target.value)} placeholder="输入登录密码" /></label>{error&&<p className="form-error">{error}</p>}<button className="primary full" disabled={loading}>{loading?'正在登录…':'进入羲和'}</button></form><p className="login-note">本地开发环境 · 会话 8 小时后自动失效</p></section></div>
}

function formatTodayLine() {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()).replace('星期', '　星期')
}

function buildCareSuggestions(person) {
  if (!person) return []
  const when = person.isToday ? '今天' : person.days === 1 ? '明天' : `还剩${person.days}天`
  return [
    { id: `${person.id}-blessing`, action: 'blessing', label: `给${person.name}写一句生日祝福`, time: when },
    { id: `${person.id}-contact`, action: 'contact', label: `找个合适时间联系${person.name}`, time: person.isToday ? '今天' : '提前' },
    { id: `${person.id}-gift`, action: 'gift', label: `确认${person.name}今年的小心意`, time: person.days > 1 ? '明天' : '今天' },
  ]
}

function Home({ people, reminders, careRecords, onReminderAction, onRefreshReminders, onRunReminders, onPerson, onAdd, onBless, onCare, onOpenStaleCare, notify, doneTasks, setDoneTasks }) {
  const [settledCareIds, setSettledCareIds] = useState([])
  const windowPeople = peopleInBirthdayWindow(people)
  const todays = windowPeople.filter(person => person.isToday)
  const heroPerson = todays[0]
  const upcoming = windowPeople.filter(person => !person.isToday).slice(0, 3)
  const staleCarePeople = people
    .map(person => ({ person, latestCare: latestCareRecordForPerson(careRecords, person.id) }))
    .filter(item => matchesCareFilter(item.latestCare, 'stale'))
    .sort((a, b) => careRecordAgeDays(b.latestCare) - careRecordAgeDays(a.latestCare) || a.person.days - b.person.days)
    .slice(0, 3)
  const taskTarget = heroPerson ?? upcoming[0]
  const suggestions = buildCareSuggestions(taskTarget)
  const pendingReminderTasks = reminders.filter(job => job.status === 'pending').slice(0, 2).map(job => ({
    id: `reminder-${job.id}`,
    type: 'reminder',
    tag: '提醒',
    label: `处理 ${job.name} 的生日提醒`,
    time: '待提醒',
    job,
  }))
  const birthdayTasks = suggestions.slice(0, 1).map(suggestion => ({ ...suggestion, type: 'birthday', tag: '生日' }))
  const staleCareTasks = staleCarePeople.slice(0, 1).map(({ person }) => ({
    id: `stale-${person.id}`,
    type: 'stale-care',
    tag: '久未关怀',
    label: `主动联系${person.name}`,
    time: '久未关怀',
    person,
  }))
  const todayTasks = [...pendingReminderTasks, ...birthdayTasks, ...staleCareTasks].slice(0, 3)
  const completeSuggestion = async (suggestion) => {
    if (doneTasks.includes(suggestion.id)) {
      setDoneTasks(doneTasks.filter(id => id !== suggestion.id))
      return
    }
    if (suggestion.action === 'blessing') {
      onBless(taskTarget)
      return
    }
    await onCare(taskTarget.id, suggestion.action, suggestion.label)
    setDoneTasks([...doneTasks, suggestion.id])
  }
  const completeTodayTask = async (task) => {
    if (doneTasks.includes(task.id)) {
      setDoneTasks(doneTasks.filter(id => id !== task.id))
      return
    }
    if (task.type === 'reminder') {
      await onReminderAction(task.job.id, 'complete')
      setDoneTasks([...doneTasks, task.id])
      return
    }
    if (task.type === 'stale-care') {
      await completeCareNudge(task.person)
      setDoneTasks([...doneTasks, task.id])
      return
    }
    await completeSuggestion(task)
  }
  const completeCareNudge = async (person) => {
    setSettledCareIds(current => current.includes(person.id) ? current : [...current, person.id])
    const saved = await onCare(person.id, 'contact', `主动联系${person.name}`)
    if (!saved) {
      setSettledCareIds(current => current.filter(id => id !== person.id))
    }
  }
  return <div className="screen home-screen">
    <header className="home-header reveal">
      <div className="brand-row"><span className="brand">羲和<span>。</span></span><button className="icon-button" onClick={onAdd} aria-label="添加人物"><Plus /></button></div>
      <p className="date-line">{formatTodayLine()}</p>
      <h1>今日，<br />也别忘了<span>重要</span>的人</h1>
      <div className="sun-orb"><Sun weight="duotone" /></div>
    </header>

    {heroPerson ? <section className="birthday-hero reveal">
      <div className="hero-copy">
        <p className="section-kicker">今天生日</p>
        <h2>{heroPerson.name}</h2><p className="relation">{heroPerson.relation}</p>
        <div className="hero-actions">
          <button className="primary" onClick={() => onBless(heroPerson)}><NotePencil />写祝福</button>
          <button className="secondary" onClick={() => notify(`已准备联系${heroPerson.name}`)}><Phone />联系TA</button>
        </div>
      </div>
      <button className="hero-portrait" onClick={() => onPerson(heroPerson)} aria-label={`查看${heroPerson.name}详情`}><img src={heroPerson.image} alt={heroPerson.name} /></button>
    </section> : <section className="birthday-hero quiet reveal">
      <div className="hero-copy">
        <p className="section-kicker">今天无人生日</p>
        <h2>日轨安静</h2><p className="relation">未来三天如有生日，羲和会提前浮现</p>
        <div className="hero-actions"><button className="primary" onClick={onAdd}><Plus />新增生日</button></div>
      </div>
      <div className="hero-portrait empty-portrait"><Sun /></div>
    </section>}

    <ReminderCenter reminders={reminders} onAction={onReminderAction} onRefresh={onRefreshReminders} onRun={onRunReminders} />
    <RecentCareRecords records={careRecords.slice(0, 3)} />

    <section className="care-nudge reveal">
      <div className="section-title"><div><p className="section-kicker">久未关怀</p><p>{staleCarePeople.length ? '这些关系值得一点日光' : '最近的关怀节奏不错'}</p></div>{staleCarePeople.length ? <button onClick={onOpenStaleCare}>查看全部 <CaretRight /></button> : <Phone />}</div>
      <div className="care-nudge-list">
        {staleCarePeople.map(({ person, latestCare }) => <div className={`care-nudge-item ${settledCareIds.includes(person.id) ? 'done' : ''}`} key={person.id}>
          <button className="care-nudge-main" onClick={() => onPerson(person)}><img src={person.image} alt="" /><div><strong>{person.name}</strong><span>{careStatusText(latestCare)} · {person.relation}</span></div></button>
          <button className="care-nudge-action" disabled={settledCareIds.includes(person.id)} onClick={() => completeCareNudge(person)}>{settledCareIds.includes(person.id) ? '已记录' : '联系'}</button>
        </div>)}
        {!staleCarePeople.length && <p className="empty-line">暂时没有久未关怀的人。关系正在被好好照看。</p>}
      </div>
    </section>

    <section className="upcoming reveal">
      <div className="section-title"><div><p className="section-kicker">未来三日</p><p>{upcoming.length ? '给关心留一点准备时间' : '暂时没有临近生日'}</p></div>{upcoming[0] && <button onClick={() => onPerson(upcoming[0])}>查看最近 <CaretRight /></button>}</div>
      <div className="timeline">
        <div className="time-rail"><span className="rail-glow" /></div>
        {upcoming.map((person, index) => <button className="person-row" key={person.id} onClick={() => onPerson(person)}>
          <div className="day"><strong>{person.date}</strong><span>{person.nextDateLabel}</span><em>还剩{person.days}天</em></div>
          <span className={`time-dot dot-${index}`} />
          <img src={person.image} alt="" /><div className="person-meta"><strong>{person.name}</strong><span>{person.relation}</span></div><CaretRight className="row-arrow" />
        </button>)}
        {!upcoming.length && <div className="empty-line">未来三天没有生日，日光正好，可以慢慢补全重要的人。</div>}
      </div>
    </section>

    <section className="preparation reveal">
      <div className="section-title"><div><p className="section-kicker">今日关怀清单</p><p>{todayTasks.length ? `为你整理 ${todayTasks.length} 件小事` : '今天没有必须处理的关怀事项'}</p></div><Gift weight="duotone" /></div>
      {todayTasks.map(task => { const done = doneTasks.includes(task.id); return <button key={task.id} className={`task-row ${done ? 'done' : ''}`} onClick={() => completeTodayTask(task)}>
        <span className="check">{done && <Check weight="bold" />}</span><span><em className={`task-tag ${task.type}`}>{task.tag}</em>{task.label}</span><time className={done ? 'task-done-label' : ''}>{done ? '已完成' : task.time}</time>
      </button> })}
      {!todayTasks.length && <div className="task-empty"><Sun /><h3>今日清单已清爽</h3><p>没有待处理的生日、提醒或久未关怀。关系正在被好好照看。</p><button className="secondary" onClick={onAdd}><Plus />补充重要的人</button></div>}
    </section>
  </div>
}

function careActionLabel(actionType) {
  if (actionType === 'blessing') return '写祝福'
  if (actionType === 'contact') return '联系'
  if (actionType === 'gift') return '备礼物'
  if (actionType === 'completed') return '已关怀'
  return actionType
}

function formatCareTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatCareRelative(value) {
  if (!value) return '暂无记录'
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / (24 * 60 * 60 * 1000)))
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days}天前`
  if (days < 365) return `${Math.floor(days / 30)}个月前`
  return `${Math.floor(days / 365)}年前`
}

function careRhythm(person, careRecords) {
  const latest = [...careRecords].sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())[0]
  const days = Number(person.days ?? 999)
  const birthdayText = person.isToday ? '今天生日' : days <= 30 ? `生日还有 ${days} 天` : `生日还有 ${days} 天`
  const latestText = latest ? `${formatCareRelative(latest.completed_at)} · ${careActionLabel(latest.action_type)}` : '还没有留下关怀记录'
  const suggestion = person.isToday
    ? '今天适合发出祝福，也可以记下一次联系。'
    : days <= 3
      ? '生日临近，可以先准备祝福或小心意。'
      : days <= 30
        ? '可以提前想一句不敷衍的祝福。'
        : latest
          ? '保持轻轻想起，不必等生日才联系。'
          : '先留下一次联系或备注，让关系有第一道日光。'
  return { latest, birthdayText, latestText, suggestion }
}

function latestCareRecordForPerson(careRecords, personId) {
  return careRecords
    .filter(record => String(record.person_id) === String(personId))
    .sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())[0]
}

function careStatusText(record) {
  return record ? `${formatCareRelative(record.completed_at)} · ${careActionLabel(record.action_type)}` : '暂无关怀记录'
}

function careRecordAgeDays(record) {
  if (!record?.completed_at) return Infinity
  return Math.max(0, Math.floor((Date.now() - new Date(record.completed_at).getTime()) / (24 * 60 * 60 * 1000)))
}

function careFilterLabel(filter) {
  if (filter === 'stale') return '久未关怀'
  if (filter === 'none') return '暂无记录'
  if (filter === 'recent') return '30天内'
  return ''
}

function matchesCareFilter(record, filter) {
  if (filter === 'all') return true
  const age = careRecordAgeDays(record)
  if (filter === 'stale') return !record || age > 90
  if (filter === 'none') return !record
  if (filter === 'recent') return Boolean(record) && age <= 30
  return true
}

function RecentCareRecords({ records }) {
  if (!records.length) return null
  return <section className="care-echo reveal">
    <div className="section-title"><div><p className="section-kicker">最近关怀</p><p>那些已经照进关系里的日光</p></div><CheckCircle /></div>
    <div className="care-echo-list">{records.map(record => <div className="care-echo-item" key={record.id}>
      <span>{careActionLabel(record.action_type)}</span>
      <strong>{record.name}</strong>
      <time>{formatCareTime(record.completed_at)}</time>
    </div>)}</div>
  </section>
}

function formatReminderTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function channelLabel(channel) {
  if (channel === 'wecom_webhook') return '企业微信'
  if (channel === 'in_app') return '站内'
  return channel
}

function statusLabel(status) {
  if (status === 'pending') return '待提醒'
  if (status === 'sent') return '已提醒'
  if (status === 'cancelled') return '已关怀'
  if (status === 'failed') return '失败'
  if (status === 'processing') return '处理中'
  return status
}

function ReminderCenter({ reminders, onAction, onRefresh, onRun }) {
  const pending = reminders.filter(job => job.status === 'pending')
  const history = reminders.filter(job => job.status === 'sent' || job.status === 'cancelled')
  const visible = pending.length ? pending.slice(0, 4) : history.slice(0, 2)
  return <section className="reminder-center reveal">
    <div className="section-title"><div><p className="section-kicker">日光提醒</p><p>{pending.length ? `${pending.length} 条待提醒内容` : '暂无待提醒内容'}</p></div><Bell /></div>
    {visible.length ? <div className="reminder-list">{visible.map(job => <div className={`reminder-item ${job.status}`} key={job.id}>
      <div><strong>{job.name}</strong><span>{formatReminderTime(job.scheduled_at)} · {channelLabel(job.channel)}</span></div>
      <em>{statusLabel(job.status)}</em>
      {job.status === 'pending' && <div className="reminder-item-actions">
        <button onClick={() => onAction(job.id, 'snooze')}>稍后</button>
        <button onClick={() => onAction(job.id, 'complete')}>已关怀</button>
      </div>}
    </div>)}</div> : <p className="empty-line">打开羲和时会自动检查未来三天生日，需要提醒的人会出现在这里。</p>}
    <div className="reminder-actions">
      <button className="secondary" onClick={() => onRefresh(false)}><Sparkle />刷新提醒</button>
      <button className="primary" onClick={onRun}><Bell />执行到期提醒</button>
    </div>
  </section>
}

function People({ people, careRecords, groups, group, setGroup, birthdayFilter, setBirthdayFilter, careFilter, setCareFilter, setGroups, onPerson, onAdd }) {
  const normalizedGroups = normalizeGroups(groups)
  const [query, setQuery] = useState('')
  const [editingGroups, setEditingGroups] = useState(false)
  const normalizedQuery = searchText(query)
  const birthdayFilters = [
    { id: 'all', label: '全部生日' },
    { id: 'this-month', label: '本月' },
    { id: 'next-month', label: '下月' },
    { id: 'next-30', label: '未来30天' },
    ...Array.from({ length: 12 }, (_, index) => ({ id: `month-${index + 1}`, label: `${index + 1}月` })),
  ]
  const activeBirthdayFilter = birthdayFilterLabel(birthdayFilter)
  const activeCareFilter = careFilterLabel(careFilter)
  const careFilters = [
    { id: 'all', label: '全部关怀' },
    { id: 'stale', label: '久未关怀' },
    { id: 'none', label: '暂无记录' },
    { id: 'recent', label: '30天内' },
  ]
  const filtered = people.filter(p => {
    const inGroup = group === '全部' || p.group === group || p.groups?.includes(group)
    if (!inGroup) return false
    if (!matchesBirthdayFilter(p, birthdayFilter)) return false
    const latestCare = latestCareRecordForPerson(careRecords, p.id)
    if (!matchesCareFilter(latestCare, careFilter)) return false
    if (!normalizedQuery) return true
    return [p.name, p.relation, p.note, p.group, ...(p.groups || []), careStatusText(latestCare), latestCare?.content, ...birthdaySearchTokens(p)].some(value => searchText(value).includes(normalizedQuery))
  })
  return <div className="screen inner-screen">
    <header className="page-header reveal"><div><p className="eyebrow">故人如故</p><h1>重要的人</h1></div><button className="round-add" onClick={onAdd}><Plus /></button></header>
    <div className="search reveal"><MagnifyingGlass /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索姓名、关系、备注、分组或生日" /><SlidersHorizontal /></div>
    <div className="group-strip reveal">{normalizedGroups.map(g => <button className={g.name === group ? 'active' : ''} onClick={() => setGroup(g.name)} key={g.id}>{g.name}</button>)}<button onClick={() => setEditingGroups(true)}><Plus />分组</button></div>
    <div className="birthday-filter-strip reveal">{birthdayFilters.map(item => <button className={item.id === birthdayFilter ? 'active' : ''} onClick={() => setBirthdayFilter(item.id)} key={item.id}>{item.label}</button>)}</div>
    <div className="care-filter-strip reveal">{careFilters.map(item => <button className={item.id === careFilter ? 'active' : ''} onClick={() => setCareFilter(item.id)} key={item.id}>{item.label}</button>)}</div>
    {(group !== '全部' || birthdayFilter !== 'all' || careFilter !== 'all') && <div className="filter-status reveal"><span>正在查看：{[group !== '全部' ? group : '', activeBirthdayFilter, activeCareFilter].filter(Boolean).join(' · ')} · 共 {filtered.length} 人</span><div>{careFilter !== 'all' && <button onClick={() => setCareFilter('all')}>清除关怀筛选</button>}{birthdayFilter !== 'all' && <button onClick={() => setBirthdayFilter('all')}>清除生日筛选</button>}{group !== '全部' && <button onClick={() => setGroup('全部')}>查看全部</button>}</div></div>}
    <div className="people-list reveal">{filtered.map(p => { const snippet = noteSnippet(p.note, query); const birthdayMatched = birthdayMatchesQuery(p, query); const latestCare = latestCareRecordForPerson(careRecords, p.id); return <button key={p.id} onClick={() => onPerson(p)}><img src={p.image} alt="" /><div><strong><Highlight text={p.name} query={query} /></strong><span><Highlight text={p.groups?.length ? p.groups.join('、') : p.group} query={query} /> · <Highlight text={p.relation} query={query} /></span><em className={`care-status ${latestCare ? '' : 'empty'}`}><Highlight text={careStatusText(latestCare)} query={query} /></em>{snippet && <em className="note-snippet">备注：<Highlight text={snippet} query={query} /></em>}</div><div className={`birthday-date${birthdayMatched ? ' search-match' : ''}`}><strong>{p.fullDate}</strong><span>{p.date}</span></div><CaretRight /></button> })}</div>
    {!filtered.length && <section className="people-empty reveal"><Sun /><h3>{query ? '没有找到这个名字' : activeCareFilter ? `${activeCareFilter}暂无人物` : activeBirthdayFilter ? `${activeBirthdayFilter}暂无人物` : group === '全部' ? '还没有重要的人' : `“${group}”还没有人物`}</h3><p>{query ? '换个关键词试试，或清空搜索重新看看。' : activeCareFilter ? '可以换一个关怀状态，或查看全部人物。' : activeBirthdayFilter ? '可以换一个月份或查看全部生日。' : group === '全部' ? '先记下一位重要的人，羲和会在合适的时候提醒你。' : '可以新增人物并归入这个分组，或先查看全部人物。'}</p><div>{query && <button className="secondary" onClick={() => setQuery('')}>清空搜索</button>}{careFilter !== 'all' && <button className="secondary" onClick={() => setCareFilter('all')}>全部关怀</button>}{birthdayFilter !== 'all' && <button className="secondary" onClick={() => setBirthdayFilter('all')}>全部生日</button>}{group !== '全部' && <button className="secondary" onClick={() => setGroup('全部')}>查看全部</button>}<button className="primary" onClick={onAdd}><Plus />新增人物</button></div></section>}
    {editingGroups && <GroupEditor groups={normalizedGroups} setGroups={setGroups} onActiveGroupChange={setGroup} close={() => setEditingGroups(false)} />}
  </div>
}

function GroupEditor({ groups, setGroups, onActiveGroupChange, close }) {
  const [value, setValue] = useState('')
  const [renaming, setRenaming] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const userGroups = groups.filter(group => group.id !== 'all')
  const refreshGroups = async () => setGroups(normalizeGroups(await api.listGroups()))
  const create = async () => {
    const name = value.trim()
    if (!name) return
    await api.createGroup(name)
    await refreshGroups()
    setValue('')
  }
  const rename = async () => {
    const name = renameValue.trim()
    if (!renaming || !name) return
    await api.updateGroup(renaming.id, name)
    await refreshGroups()
    onActiveGroupChange(name)
    setRenaming(null); setRenameValue('')
  }
  const remove = async (group) => {
    if (!window.confirm(`删除分组“${group.name}”？人物不会被删除，只会解除分组关联。`)) return
    await api.deleteGroup(group.id)
    await refreshGroups()
    onActiveGroupChange('全部')
  }
  return <div className="mini-sheet"><div className="sheet-backdrop" onClick={close}/><div className="sheet-card"><div className="sheet-handle"/><div className="sheet-head"><h2>管理分组</h2><button onClick={close}><X /></button></div><div className="group-editor-list">{userGroups.map(group => <div className="group-editor-row" key={group.id}>{renaming?.id === group.id ? <input value={renameValue} onChange={e => setRenameValue(e.target.value)} autoFocus /> : <span>{group.name}</span>}<div>{renaming?.id === group.id ? <><button onClick={rename}>保存</button><button onClick={() => setRenaming(null)}>取消</button></> : <><button onClick={() => { setRenaming(group); setRenameValue(group.name) }}>改名</button><button onClick={() => remove(group)}>删除</button></>}</div></div>)}</div><label>新分组<input value={value} onChange={e => setValue(e.target.value)} placeholder="例如：大学同学" /></label><button className="primary full" onClick={create}>创建分组</button></div></div>
}

function YearView({ people, onPerson, onMonth }) {
  const months = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月']
  const currentMonth = new Date().getMonth()
  const [selectedMonth, setSelectedMonth] = useState(currentMonth)
  const counts = monthCounts(people)
  const next = people[0]
  const thisMonthCount = counts[currentMonth + 1] || 0
  const futureThirtyCount = people.filter(person => person.days >= 0 && person.days <= 30).length
  const selectedMonthPeople = people.filter(person => birthdayMonth(person) === selectedMonth + 1)
  return <div className="screen inner-screen year-screen"><header className="page-header reveal"><div><p className="eyebrow">岁时有序</p><h1>岁历</h1></div><button className="year-switch">{new Date().getFullYear()} <CaretRight /></button></header><div className="solar-arc reveal"><Sun weight="duotone" /><div><strong>下一位生日</strong><span>{next ? `${next.name} · ${next.date}` : '尚未录入生日'}</span></div></div><section className="year-overview reveal"><div><strong>{people.length}</strong><span>已记录</span></div><div><strong>{thisMonthCount}</strong><span>本月</span></div><div><strong>{futureThirtyCount}</strong><span>未来30天</span></div></section><div className="month-grid reveal">{months.map((m, i) => <button className={`${i === currentMonth ? 'current' : ''}${i === selectedMonth ? ' selected' : ''}`} key={m} onClick={() => setSelectedMonth(i)} aria-label={`预览${i + 1}月生日人物`}><strong>{m}</strong><span>{counts[i + 1] ? `${counts[i + 1]} 个生日` : '—'}</span>{i === currentMonth && <i />}</button>)}</div><section className="month-people reveal"><div className="section-title compact"><div><p className="section-kicker">{months[selectedMonth]} · {selectedMonthPeople.length || 0} 位故人</p><p>{selectedMonth === currentMonth ? '本月日光刻度' : '按录入生日月份归类'}</p></div><button onClick={() => onMonth(selectedMonth + 1)}>查看全部 <CaretRight /></button></div>{selectedMonthPeople.length ? selectedMonthPeople.slice(0, 4).map(p => <button onClick={() => onPerson(p)} key={p.id}><time>{(p.fullDate || p.nextDateLabel).replace('月',' / ').replace('日','')}</time><img src={p.image} alt=""/><strong>{p.name}</strong><span>{p.relation}</span></button>) : <p className="empty-line">这个月暂时没有生日记录。可以先去新增一位重要的人。</p>}</section></div>
}

function Profile({ reminders, onRefreshReminders, onRunReminders, onImport, onRestoreComplete, notify, onLogout }) {
  const restoreInputRef = useRef<HTMLInputElement | null>(null)
  const exportAndBackup = async () => {
    try {
      const filename = await api.downloadJsonExport()
      const backup = await api.createJsonBackup()
      notify(`已导出 ${filename}，本地备份已生成`)
    } catch {
      notify('导出失败，请确认本地 API 正常')
    }
  }
  const exportPeopleCsv = async () => {
    try {
      const filename = await api.downloadPeopleCsv()
      notify(`已导出 ${filename}`)
    } catch {
      notify('CSV 导出失败，请确认本地 API 正常')
    }
  }
  const previewJsonRestore = async (file?: File) => {
    if (!file) return
    try {
      const result = await api.previewJsonImport(file)
      const counts = result.preview.counts
      const warningText = result.preview.warnings.length ? `，提示 ${result.preview.warnings.length} 项` : ''
      notify(`预检通过：${counts.people} 人、${counts.groups} 组、${counts.careRecords} 条关怀记录${warningText}`)
      const shouldRestore = window.confirm(`预检通过。\n\n备份包含：${counts.people} 位人物、${counts.groups} 个分组、${counts.careRecords} 条关怀记录。\n当前账号已有：${result.current.people.active} 位在册人物。\n\n是否确认追加恢复？系统会跳过疑似重复人物，不会覆盖或删除现有数据。`)
      if (!shouldRestore) return
      const restored = await api.restoreJsonImport(file)
      await onRestoreComplete()
      notify(`恢复完成：新增 ${restored.restored.people} 人，跳过 ${restored.skipped.people} 人`)
    } catch {
      notify('JSON 备份恢复失败，请确认文件来自羲和导出')
    } finally {
      if (restoreInputRef.current) restoreInputRef.current.value = ''
    }
  }
  const generateJobs = async () => {
    try {
      await onRefreshReminders(false)
    } catch {
      notify('提醒任务生成失败，请确认本地 API 正常')
    }
  }
  const runJobs = async () => {
    try {
      await onRunReminders()
    } catch {
      notify('提醒执行失败，请确认本地 API 正常')
    }
  }
  const checkChannels = async () => {
    try {
      const channels = await api.notificationChannels()
      const enabled = Object.values(channels).filter(channel => channel.enabled).map(channel => channel.label)
      notify(`已启用：${enabled.join('、') || '无'}`)
    } catch {
      notify('通知通道检查失败')
    }
  }
  const pendingCount = reminders.filter(job => job.status === 'pending').length
  return <div className="screen inner-screen profile-screen"><header className="page-header reveal"><div><p className="eyebrow">羲和</p><h1>我的</h1></div><div className="profile-mark"><Sun weight="duotone" /></div></header><section className="reminder-status reveal"><Bell weight="duotone" /><div><strong>提醒运行正常</strong><span>打开页面自动检查未来三日，当前 {pendingCount} 条待提醒</span></div><span className="status-dot">已开启</span></section><section className="settings-group reveal"><p>数据</p><input ref={restoreInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={event => previewJsonRestore(event.target.files?.[0])} /><button onClick={onImport}><FileArrowUp /><div><strong>导入生日</strong><span>支持 CSV、XLSX 文件</span></div><CaretRight /></button><button onClick={exportAndBackup}><UploadSimple /><div><strong>导出 JSON 备份</strong><span>下载完整数据，同时生成本地备份</span></div><CaretRight /></button><button onClick={() => restoreInputRef.current?.click()}><CheckCircle /><div><strong>预检 JSON 备份</strong><span>只校验文件与数量，暂不写入数据库</span></div><CaretRight /></button><button onClick={exportPeopleCsv}><FileArrowUp /><div><strong>导出 CSV 表格</strong><span>人物生日表，可用 Excel/WPS 打开</span></div><CaretRight /></button></section><section className="settings-group reveal"><p>提醒</p><button onClick={() => notify('打开页面时自动检查；到期后可一键发送')}><Bell /><div><strong>提醒节奏</strong><span>提前 3 天 + 当天，页面内展示</span></div><CaretRight /></button><button onClick={generateJobs}><Sparkle /><div><strong>刷新提醒内容</strong><span>重新检查并显示未来三日提醒</span></div><CaretRight /></button><button onClick={runJobs}><Bell /><div><strong>执行到期提醒</strong><span>通过已配置通道发送</span></div><CaretRight /></button><button onClick={checkChannels}><CheckCircle /><div><strong>通知通道检查</strong><span>站内提醒默认开启，企业微信需配置 Webhook</span></div><CaretRight /></button></section><button className="logout-button" onClick={onLogout}>退出本地账号</button><p className="privacy-note">数据默认仅保存在本机。羲和不会读取与你的生日管理无关的信息。</p></div>
}

function BottomNav({ view, setView }) { return <nav className="bottom-nav">{navItems.map(item => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><Icon weight={view === item.id ? 'fill' : 'regular'} /><span>{item.label}</span></button> })}</nav> }

function Sheet({ children, onClose, tall = false }) { return <div className="modal-layer"><button className="modal-backdrop" aria-label="关闭" onClick={onClose}/><section className={`modal-sheet ${tall ? 'tall' : ''}`}><div className="sheet-handle"/><button className="sheet-close" onClick={onClose}><X /></button>{children}</section></div> }

function groupOptions(groups) {
  return normalizeGroups(groups).filter(group => group.id !== 'all').map(group => group.name)
}

function MultiGroupField({ groups, selectedGroups, setSelectedGroups }) {
  const options = groupOptions(groups)
  const [custom, setCustom] = useState('')
  const toggle = (name) => setSelectedGroups(selectedGroups.includes(name) ? selectedGroups.filter(group => group !== name) : [...selectedGroups, name])
  const addCustom = () => {
    const name = custom.trim()
    if (!name || selectedGroups.includes(name)) return
    setSelectedGroups([...selectedGroups, name])
    setCustom('')
  }
  return <label>分组<div className="multi-group-picker">{options.map(option => <button type="button" className={selectedGroups.includes(option) ? 'active' : ''} onClick={() => toggle(option)} key={option}>{option}</button>)}</div><div className="inline-create"><input maxLength={50} value={custom} onChange={e => setCustom(e.target.value)} placeholder="输入新分组名称" /><button type="button" onClick={addCustom}>添加</button></div>{selectedGroups.length > 0 && <p className="selected-groups">已选：{selectedGroups.join('、')}</p>}</label>
}

function AddPerson({ groups, initialGroup, onClose, onImport, onCreate }) {
  const [name, setName] = useState('')
  const [relation, setRelation] = useState('亲人')
  const [selectedGroups, setSelectedGroups] = useState(() => [initialGroup || groupOptions(groups)[0] || '亲人'])
  const [birthday, setBirthday] = useState('1995-05-18')
  const [calendarType, setCalendarType] = useState<'solar' | 'lunar'>('solar')
  const [birthYearKnown, setBirthYearKnown] = useState(true)
  const [isLeapMonth, setIsLeapMonth] = useState(false)
  const [note, setNote] = useState('')
  return <Sheet onClose={onClose} tall><div className="modal-heading"><p className="eyebrow">记住一个重要的人</p><h2>新增生日</h2></div><div className="method-switch"><button className="active">手动录入</button><button onClick={onImport}>文件导入</button></div><form className="form" onSubmit={e => { e.preventDefault(); const cleanGroups = selectedGroups.map(g => g.trim()).filter(Boolean); onCreate({ name, relation, group: cleanGroups[0], groups: cleanGroups, birthday, calendarType, birthYearKnown, isLeapMonth, note }); onClose() }}><label>姓名<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="怎么称呼 TA" /></label><div className="form-row"><label>关系<select value={relation} onChange={e => setRelation(e.target.value)}><option>亲人</option><option>朋友</option><option>同事</option></select></label><MultiGroupField groups={groups} selectedGroups={selectedGroups} setSelectedGroups={setSelectedGroups} /></div><div className="form-row"><label>生日<input type="date" required value={birthday} onChange={e => setBirthday(e.target.value)} /></label><label>历法<select value={calendarType} onChange={e => { setCalendarType(e.target.value as 'solar' | 'lunar'); if (e.target.value === 'solar') setIsLeapMonth(false) }}><option value="solar">公历</option><option value="lunar">农历</option></select></label></div><label className="option-row"><input type="checkbox" checked={!birthYearKnown} onChange={e => setBirthYearKnown(!e.target.checked)} /><span>不确定出生年份，只记月日</span></label>{calendarType === 'lunar' && <label className="option-row"><input type="checkbox" checked={isLeapMonth} onChange={e => setIsLeapMonth(e.target.checked)} /><span>这是农历闰月生日</span></label>}<label>备注<textarea maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="喜欢什么、最近在忙什么……" /></label><button className="primary full" type="submit">保存生日</button></form></Sheet>
}

function EditPerson({ person, groups, onClose, onSave }) {
  const [name,setName]=useState(person.name),[relation,setRelation]=useState(person.relation),[selectedGroups,setSelectedGroups]=useState(person.groups?.length ? person.groups : [person.group])
  const [birthday,setBirthday]=useState(person.birthday),[calendarType,setCalendarType]=useState(person.calendarType),[note,setNote]=useState(person.note)
  const [birthYearKnown,setBirthYearKnown]=useState(person.birthYearKnown ?? true),[isLeapMonth,setIsLeapMonth]=useState(person.isLeapMonth ?? false)
  return <Sheet onClose={onClose} tall><div className="modal-heading"><p className="eyebrow">更新关系记忆</p><h2>编辑人物</h2></div><form className="form edit-form" onSubmit={e=>{e.preventDefault(); const cleanGroups = selectedGroups.map(g => g.trim()).filter(Boolean); onSave({name,relation,group:cleanGroups[0],groups:cleanGroups,birthday,calendarType,birthYearKnown,isLeapMonth,note})}}><label>姓名<input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label><div className="form-row"><label>关系<input maxLength={50} value={relation} onChange={e=>setRelation(e.target.value)}/></label><MultiGroupField groups={groups} selectedGroups={selectedGroups} setSelectedGroups={setSelectedGroups} /></div><div className="form-row"><label>生日<input type="date" required value={birthday} onChange={e=>setBirthday(e.target.value)}/></label><label>历法<select value={calendarType} onChange={e=>{setCalendarType(e.target.value as 'solar' | 'lunar'); if(e.target.value==='solar') setIsLeapMonth(false)}}><option value="solar">公历</option><option value="lunar">农历</option></select></label></div><label className="option-row"><input type="checkbox" checked={!birthYearKnown} onChange={e=>setBirthYearKnown(!e.target.checked)} /><span>不确定出生年份，只记月日</span></label>{calendarType === 'lunar' && <label className="option-row"><input type="checkbox" checked={isLeapMonth} onChange={e=>setIsLeapMonth(e.target.checked)} /><span>这是农历闰月生日</span></label>}<label>备注<textarea maxLength={2000} value={note} onChange={e=>setNote(e.target.value)}/></label><button className="primary full">保存修改</button></form></Sheet>
}

function ImportFlow({ onClose, notify }) {
  const [step, setStep] = useState(1)
  return <Sheet onClose={onClose} tall><div className="modal-heading"><p className="eyebrow">批量录入</p><h2>导入生日</h2></div><div className="steps"><span className={step >= 1 ? 'active' : ''}>1 上传</span><i/><span className={step >= 2 ? 'active' : ''}>2 确认</span><i/><span className={step >= 3 ? 'active' : ''}>3 完成</span></div>{step === 1 && <><button className="upload-zone" onClick={() => setStep(2)}><FileArrowUp weight="duotone" /><strong>选择 CSV 或 XLSX 文件</strong><span>姓名、生日、分组、备注均可识别</span></button><p className="helper">还没有文件？<button>下载导入模板</button></p></>}{step === 2 && <><div className="import-summary"><strong>已识别 24 条数据</strong><span>22 条可导入 · 1 条重复 · 1 条需确认</span></div><div className="mapping"><p>字段对应</p><span>姓名 <CaretRight /> 姓名</span><span>出生日期 <CaretRight /> 生日</span><span>部门 <CaretRight /> 分组</span></div><button className="primary full" onClick={() => setStep(3)}>确认导入 22 人</button></>}{step === 3 && <div className="success-state"><CheckCircle weight="duotone" /><h3>生日已经收好</h3><p>成功导入 22 人，已自动跳过 1 条重复数据。</p><button className="primary full" onClick={() => { notify('22 位人物已导入'); onClose() }}>回到羲和</button></div>}</Sheet>
}

function blessingText(person, tone) {
  const name = person?.name || '你'
  const relation = person?.relation || '重要的人'
  const note = person?.note ? `也愿你继续拥有${person.note.slice(0, 28)}里的那份热爱。` : ''
  if (tone === '轻松') return `${name}，生日快乐！新的一岁继续闪闪发光，好运、好吃的和开心事都排着队来找你。${note}`
  if (tone === '正式') return `${name}，祝你生日快乐。愿新的一岁身体健康、工作顺遂、生活安然，所行皆坦途，所愿皆有回响。`
  if (tone === '诗意') return `${name}，生辰喜乐。愿今日的日光为你停一停，往后的风也温柔，路也明亮，心中所盼都慢慢开花。`
  const relationLine = relation.includes('同事') ? '愿工作有进展，也有从容的生活。' : relation.includes('亲') ? '愿家人常伴，烟火温暖。' : '愿身边有真诚的人，也有自在的时光。'
  return `${name}，生日快乐。愿新的一岁，平安喜乐，热爱不减，${relationLine}${note}`
}

function Blessing({ person, onCare, onClose, notify }) {
  const [tone, setTone] = useState('温暖')
  const text = useMemo(() => blessingText(person, tone), [person, tone])
  const copyBlessing = async () => {
    await navigator.clipboard?.writeText(text)
    await onCare(person.id, 'blessing', text)
    notify('祝福已复制，并已记录关怀')
    onClose()
  }
  return <Sheet onClose={onClose}><div className="modal-heading"><p className="eyebrow">给{person.name}</p><h2>写一句祝福</h2></div><div className="tone-tabs">{['温暖','轻松','正式','诗意'].map(t => <button className={tone === t ? 'active' : ''} onClick={() => setTone(t)} key={t}>{t}</button>)}</div><div className="blessing-copy"><Sparkle weight="duotone" /><p>{text}</p></div><p className="helper">根据姓名、关系与备注生成，内容只在本机处理。</p><button className="primary full" onClick={copyBlessing}>复制并记录关怀</button></Sheet>
}

function CareRecordComposer({ person, onCare }) {
  const [actionType, setActionType] = useState('completed')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async (event) => {
    event.preventDefault()
    const text = content.trim()
    if (!text) return
    setSaving(true)
    try {
      await onCare(person.id, actionType, text)
      setContent('')
      setActionType('completed')
    } finally {
      setSaving(false)
    }
  }
  return <form className="care-composer" onSubmit={save}>
    <div className="section-title compact"><div><p className="section-kicker">记一笔关系记忆</p><p>聊过的话、送过的礼物、TA 喜欢的小事</p></div></div>
    <div className="care-composer-types">
      {[['completed','普通关怀'],['contact','联系'],['gift','礼物'],['blessing','祝福']].map(([value, label]) => <button type="button" className={actionType === value ? 'active' : ''} onClick={() => setActionType(value)} key={value}>{label}</button>)}
    </div>
    <textarea maxLength={500} value={content} onChange={event => setContent(event.target.value)} placeholder={`例如：${person.name}最近在准备考试，喜欢桂花味的点心。`} />
    <button className="primary full" disabled={!content.trim() || saving}>{saving ? '正在保存…' : '保存关怀记录'}</button>
  </form>
}

function PersonDetail({ person, careRecords, onBless, onCare, onGroup, onClose, notify, onEdit, onArchive }) {
  const detailGroups = person.groups?.length ? person.groups : [person.group]
  const rhythm = careRhythm(person, careRecords)
  return <Sheet onClose={onClose} tall><div className="detail-portrait"><img src={person.image} alt={person.name}/><span>{person.date}</span></div><div className="detail-title"><p className="eyebrow">{person.relation}</p><h2>{person.name}</h2><div className="detail-group-tags">{detailGroups.filter(Boolean).map(group => <button type="button" onClick={() => onGroup(group)} key={group}>{group}</button>)}</div><p>{person.fullDate} · {person.nextDateLabel ? `下次 ${person.nextDateLabel}` : ''}{person.birthYearKnown === false ? ' · 年份未知' : ''}</p></div><div className="detail-actions"><button onClick={() => onBless(person)}><NotePencil /><span>写祝福</span></button><button onClick={() => onCare(person.id, 'contact', `联系${person.name}`)}><Phone /><span>联系TA</span></button><button onClick={() => onCare(person.id, 'gift', `为${person.name}准备礼物`)}><Gift /><span>备礼物</span></button></div><section className="care-rhythm"><div><p className="section-kicker">关怀节奏</p><strong>{rhythm.birthdayText}</strong><span>{rhythm.latestText}</span></div><p>{rhythm.suggestion}</p><button onClick={() => onCare(person.id, 'completed', `记录一次对${person.name}的关怀`)}><CheckCircle />记一次关怀</button></section><CareRecordComposer person={person} onCare={onCare} /><section className="memory-note"><p className="section-kicker">关于 TA</p><p>{person.note||'还没有备注'}</p></section><section className="care-timeline"><p className="section-kicker">关怀记录</p>{careRecords.length ? careRecords.slice(0, 6).map(record => <div className="care-timeline-item" key={record.id}><i /><div><strong>{careActionLabel(record.action_type)}</strong><span>{formatCareTime(record.completed_at)}</span>{record.content && <p>{record.content}</p>}</div></div>) : <p className="empty-line">还没有关怀记录。一次祝福、一次联系，都会在这里留下痕迹。</p>}</section><section className="reminder-card"><Bell weight="duotone"/><div><strong>提醒节奏</strong><span>提前 3 天 + 当天 09:00</span></div><CaretRight /></section><button className="secondary full" onClick={onEdit}>编辑资料</button><button className="archive-button" onClick={onArchive}>归档此人物</button></Sheet>
}

export { App }
