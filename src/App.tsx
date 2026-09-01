import { useEffect, useState, type FormEvent } from 'react'
import {
  ArrowDownRight, ArrowUpRight, Bot, CalendarDays, Check, CheckCircle2,
  ChevronRight, CircleDollarSign, Cloud, Command, Droplets, Dumbbell, Home,
  ListTodo, Menu, MessageSquareText, Mic, MicOff, Plus, Send, Settings, Sparkles, Target,
  TrendingUp, WalletCards, X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { respondAsWolfman } from './assistant'
import { cloudEnabled, getSession, onSessionChange, requestMagicLink, restoreData, signOut, uploadData } from './cloud'
import type { ChatMessage, Task } from './domain'
import { connectMicrosoft, disconnectMicrosoft, getMicrosoftAccount, microsoftEnabled } from './microsoft'
import { useWolfmanData } from './wolfmanDataContext'
import { speak, useWakeWord } from './voice'
import './App.css'

type View = 'overview' | 'money' | 'planner' | 'assistant'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const navItems: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'overview', label: 'Overview', icon: Home },
  { id: 'money', label: 'Money', icon: WalletCards },
  { id: 'planner', label: 'Planner', icon: ListTodo },
  { id: 'assistant', label: 'Ask Wolfman', icon: MessageSquareText },
]

function Progress({ value, tone = 'green' }: { value: number; tone?: 'green' | 'amber' | 'blue' }) {
  return <div className={`progress ${tone}`} aria-label={`${Math.round(value)} percent`}><span style={{ width: `${Math.min(100, value)}%` }} /></div>
}

function Overview({ onNavigate }: { onNavigate: (view: View) => void }) {
  const { data, toggleTask, incrementHabit } = useWolfmanData()
  const totalSpent = data.transactions.reduce((total, item) => total + item.amount, 0)
  const saved = data.transactions.filter((item) => item.category === 'Savings').reduce((total, item) => total + item.amount, 0)
  const spendingBudget = data.budgets.reduce((total, budget) => total + budget.limit, 0)
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())
  const planPercent = spendingBudget ? Math.round((totalSpent / spendingBudget) * 100) : 0
  const savingsPercent = data.monthlyIncome ? Math.round((saved / data.monthlyIncome) * 100) : 0

  return (
    <div className="view overview-view">
      <header className="page-heading">
        <div><p className="eyebrow">{date}</p><h1>{greeting}.</h1><p>{data.transactions.length || data.tasks.length ? 'Your workspace is up to date.' : 'No activity yet.'}</p></div>
        <button className="primary-button" onClick={() => onNavigate('assistant')}><Sparkles size={17} /> Ask Wolfman</button>
      </header>
      <section className="metric-grid" aria-label="Financial snapshot">
        <article className="metric-card balance-card"><div className="metric-top"><span>Monthly cash flow</span><CircleDollarSign size={20} /></div><strong>{money.format(data.monthlyIncome - totalSpent)}</strong><small><ArrowUpRight size={14} /> {money.format(data.monthlyIncome)} income</small></article>
        <article className="metric-card"><div className="metric-top"><span>Spent this month</span><WalletCards size={20} /></div><strong>{money.format(totalSpent)}</strong><small><ArrowDownRight size={14} /> {planPercent}% of total plan</small></article>
        <article className="metric-card"><div className="metric-top"><span>Saved this month</span><TrendingUp size={20} /></div><strong>{money.format(saved)}</strong><small><ArrowUpRight size={14} /> {savingsPercent}% savings rate</small></article>
      </section>
      <div className="dashboard-grid">
        <section className="panel budget-panel">
          <div className="panel-heading"><div><p className="eyebrow">50 / 30 / 20</p><h2>Budget pacing</h2></div><button className="text-button" onClick={() => onNavigate('money')}>Details <ChevronRight size={16} /></button></div>
          <div className="budget-list">{data.budgets.map((budget, index) => {
            const spent = data.transactions.filter((item) => item.category === budget.category).reduce((sum, item) => sum + item.amount, 0)
            return <div className="budget-row" key={budget.category}><div className="row-copy"><strong>{budget.category}</strong><span>{money.format(spent)} / {money.format(budget.limit)}</span></div><Progress value={(spent / budget.limit) * 100} tone={index === 1 ? 'amber' : index === 2 ? 'blue' : 'green'} /></div>
          })}{!data.budgets.length && <p className="empty-state">No budgets yet.</p>}</div>
        </section>
        <section className="panel task-panel">
          <div className="panel-heading"><div><p className="eyebrow">Must do</p><h2>Today's priorities</h2></div><button className="icon-button" title="Open planner" onClick={() => onNavigate('planner')}><CalendarDays size={18} /></button></div>
          <div className="task-list">{data.tasks.slice(0, 3).map((task) => <button className={`task-row ${task.completed ? 'done' : ''}`} key={task.id} onClick={() => toggleTask(task.id)}><span className="check-circle">{task.completed && <Check size={14} />}</span><span><strong>{task.title}</strong><small>{task.quadrant} · {task.due}</small></span></button>)}{!data.tasks.length && <p className="empty-state">No priorities yet.</p>}</div>
        </section>
        <section className="panel goals-panel">
          <div className="panel-heading"><div><p className="eyebrow">Long term</p><h2>Savings goals</h2></div><Target size={19} /></div>
          {data.goals.map((goal) => { const percent = goal.target ? (goal.current / goal.target) * 100 : 0; return <div className="goal-row" key={goal.id}><div className="row-copy"><strong>{goal.name}</strong><span>{Math.round(percent)}%</span></div><Progress value={percent} tone="blue" /><small>{money.format(goal.current)} of {money.format(goal.target)}</small></div> })}{!data.goals.length && <p className="empty-state">No goals yet.</p>}
        </section>
        <section className="panel habits-panel">
          <div className="panel-heading"><div><p className="eyebrow">This week</p><h2>Habit rhythm</h2></div><CheckCircle2 size={19} /></div>
          <div className="habit-grid">{data.habits.map((habit, index) => { const HabitIcon = [Dumbbell, Command, Droplets][index] ?? CheckCircle2; return <button className="habit" key={habit.id} onClick={() => incrementHabit(habit.id)}><HabitIcon size={20} /><strong>{habit.completedDays}/{habit.targetDays}</strong><span>{habit.name}</span></button> })}</div>{!data.habits.length && <p className="empty-state">No habits yet.</p>}
        </section>
      </div>
    </div>
  )
}

function MoneyView() {
  const { data, addTransaction } = useWolfmanData()
  const [showForm, setShowForm] = useState(false)
  const submitTransaction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    addTransaction({ merchant: String(form.get('merchant')), amount: Number(form.get('amount')), category: String(form.get('category')), date: String(form.get('date')) })
    event.currentTarget.reset()
    setShowForm(false)
  }
  return (
    <div className="view">
      <header className="page-heading compact"><div><p className="eyebrow">Financial command center</p><h1>Money</h1><p>Track every dollar. Keep the plan honest.</p></div><button className="primary-button" onClick={() => setShowForm(true)}><Plus size={17} /> Add transaction</button></header>
      <div className="money-layout">
        <section className="panel transaction-panel"><div className="panel-heading"><h2>Recent activity</h2><span className="status"><span /> Up to date</span></div><div className="transaction-list">{data.transactions.map((transaction) => <div className="transaction-row" key={transaction.id}><span className="merchant-mark">{transaction.merchant.slice(0, 1)}</span><span><strong>{transaction.merchant}</strong><small>{transaction.date} · {transaction.category}</small></span><strong className={transaction.category === 'Savings' ? 'positive' : ''}>{transaction.category === 'Savings' ? '+' : '−'}{money.format(transaction.amount)}</strong></div>)}</div></section>
        <aside className="panel framework-panel"><p className="eyebrow">Your framework</p><h2>Budget plan</h2>{data.budgets.map((budget) => <div className="split-row" key={budget.category}><span>{budget.category}</span><strong>{data.monthlyIncome ? Math.round((budget.limit / data.monthlyIncome) * 100) : 0}%</strong></div>)}{!data.budgets.length && <p>No budgets yet.</p>}</aside>
      </div>
      {showForm && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowForm(false)}><form className="modal" onSubmit={submitTransaction} onMouseDown={(event) => event.stopPropagation()}><div className="panel-heading"><div><p className="eyebrow">New record</p><h2>Add transaction</h2></div><button type="button" className="icon-button" onClick={() => setShowForm(false)}><X size={18} /></button></div><label>Merchant<input name="merchant" required placeholder="Merchant name" /></label><div className="form-grid"><label>Amount<input name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00" /></label><label>Date<input name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label></div><label>Category<select name="category"><option>Needs</option><option>Wants</option><option>Savings</option></select></label><button className="primary-button full" type="submit">Add transaction</button></form></div>}
    </div>
  )
}

function PlannerView() {
  const { data, addTask, toggleTask, incrementHabit } = useWolfmanData()
  const [showForm, setShowForm] = useState(false)
  const quadrants = ['Do now', 'Schedule', 'Delegate', 'Eliminate'] as const
  const submitTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    addTask({ title: String(form.get('title')), quadrant: String(form.get('quadrant')) as Task['quadrant'], due: String(form.get('due')) })
    event.currentTarget.reset()
    setShowForm(false)
  }
  return <div className="view"><header className="page-heading compact"><div><p className="eyebrow">Eisenhower matrix</p><h1>Planner</h1><p>Put attention where it creates leverage.</p></div><button className="primary-button" onClick={() => setShowForm(true)}><Plus size={17} /> Add task</button></header><section className="matrix">{quadrants.map((quadrant) => <div className="matrix-column" key={quadrant}><div className="matrix-heading"><h2>{quadrant}</h2><span>{data.tasks.filter((task) => task.quadrant === quadrant).length}</span></div>{data.tasks.filter((task) => task.quadrant === quadrant).map((task) => <button key={task.id} className={`matrix-task ${task.completed ? 'done' : ''}`} onClick={() => toggleTask(task.id)}><span className="check-circle">{task.completed && <Check size={14} />}</span><span><strong>{task.title}</strong><small>{task.due}</small></span></button>)}{!data.tasks.some((task) => task.quadrant === quadrant) && <p className="empty-state">Nothing here. Keep it that way.</p>}</div>)}</section><section className="panel weekly-habits"><div className="panel-heading"><div><p className="eyebrow">Accountability</p><h2>Weekly habits</h2></div></div>{data.habits.map((habit) => <button key={habit.id} className="habit-line" onClick={() => incrementHabit(habit.id)}><span>{habit.name}</span><Progress value={(habit.completedDays / habit.targetDays) * 100} tone="green" /><strong>{habit.completedDays}/{habit.targetDays}</strong></button>)}</section>{showForm && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowForm(false)}><form className="modal" onSubmit={submitTask} onMouseDown={(event) => event.stopPropagation()}><div className="panel-heading"><div><p className="eyebrow">New record</p><h2>Add task</h2></div><button type="button" className="icon-button" onClick={() => setShowForm(false)}><X size={18} /></button></div><label>Title<input name="title" required placeholder="What needs to happen?" /></label><div className="form-grid"><label>Quadrant<select name="quadrant">{quadrants.map((quadrant) => <option key={quadrant}>{quadrant}</option>)}</select></label><label>Due<input name="due" required placeholder="Today, 4:00 PM" /></label></div><button className="primary-button full" type="submit">Add task</button></form></div>}</div>
}

function AssistantView() {
  const { data } = useWolfmanData()
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [busy, setBusy] = useState(false)
  const send = async (text: string, spoken = false) => {
    const value = text.trim()
    if (!value) return
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: value }])
    setInput('')
    setBusy(true)
    try {
      const response = await respondAsWolfman(value, data)
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: response }])
      if (spoken) speak(response)
    } catch (error) {
      const response = error instanceof Error ? error.message : 'The request failed.'
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: response }])
      if (spoken) speak(response)
    } finally {
      setBusy(false)
    }
  }
  const voice = useWakeWord((command) => void send(command, true))
  return <div className="view assistant-view"><header className="assistant-heading"><span className={`wolfman-orb ${voice.listening ? 'listening' : ''}`}><Bot size={22} /></span><div><h1>Wolfman</h1><p><span className="online-dot" /> {voice.enabled ? voice.status : busy ? 'Searching, retrieving, and forming a response...' : 'Ready'}</p></div><button className={`voice-button ${voice.enabled ? 'enabled' : ''}`} onClick={voice.toggle} disabled={!voice.supported} aria-pressed={voice.enabled} title={voice.supported ? 'Toggle Wolfman voice activation' : 'Voice recognition is unavailable'}>{voice.enabled ? <Mic size={18} /> : <MicOff size={18} />}<span>{voice.enabled ? 'Voice on' : 'Voice off'}</span></button></header><div className="chat-thread">{messages.map((message) => <div key={message.id} className={`message ${message.role}`}><ReactMarkdown>{message.content}</ReactMarkdown></div>)}{busy && <div className="message assistant thinking" aria-live="polite" aria-label="Wolfman is thinking"><span /><span /><span /></div>}</div><form className="composer" onSubmit={(event) => { event.preventDefault(); void send(input) }}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about money, priorities, or anything else..." aria-label="Message Wolfman" /><button className="send-button" type="submit" title="Send" disabled={busy}><Send size={18} /></button></form><p className="disclaimer">Wolfman answers from your data, connected accounts, and public sources — no extra input needed.</p></div>
}

function CloudSettings({ onClose }: { onClose: () => void }) {
  const { data, setData } = useWolfmanData()
  const [email, setEmail] = useState('')
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [microsoftAccount, setMicrosoftAccount] = useState<{ name?: string; username: string } | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void getSession().then((session) => setSessionEmail(session?.user.email ?? null))
    if (microsoftEnabled) void getMicrosoftAccount().then((account) => setMicrosoftAccount(account ? { name: account.name, username: account.username } : null))
    return onSessionChange((session) => setSessionEmail(session?.user.email ?? null))
  }, [])

  const run = async (action: () => Promise<void>, success: string) => {
    setBusy(true)
    setStatus('')
    try { await action(); setStatus(success) } catch (error) { setStatus(error instanceof Error ? error.message : 'The cloud action failed.') } finally { setBusy(false) }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section className="modal cloud-modal" onMouseDown={(event) => event.stopPropagation()}><div className="panel-heading"><div><p className="eyebrow">Private workspace</p><h2>Connections</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><div className="connection-section"><h3>Microsoft 365</h3>{!microsoftEnabled ? <div className="notice"><Cloud size={20} /><div><strong>Microsoft access is not configured</strong><p>Add the public Entra application ID to enable consented, read-only access.</p></div></div> : microsoftAccount ? <><div className="notice connected"><CheckCircle2 size={20} /><div><strong>{microsoftAccount.name || 'Microsoft account connected'}</strong><p>{microsoftAccount.username}</p></div></div><button className="text-button danger" onClick={() => void run(async () => { await disconnectMicrosoft(); setMicrosoftAccount(null) }, 'Microsoft account disconnected.')}>Disconnect Microsoft</button></> : <button disabled={busy} className="primary-button full" onClick={() => void run(async () => { const account = await connectMicrosoft(); setMicrosoftAccount({ name: account.name, username: account.username }) }, 'Microsoft account connected with read-only access.')}>Connect Microsoft</button>}</div><div className="connection-section"><h3>Cloud backup</h3>{!cloudEnabled ? <div className="notice"><Cloud size={20} /><div><strong>Local-only mode</strong><p>Add your Supabase public URL and anon key to enable authenticated sync. Your current records stay on this device.</p></div></div> : sessionEmail ? <><div className="notice connected"><CheckCircle2 size={20} /><div><strong>Signed in</strong><p>{sessionEmail}</p></div></div><div className="cloud-actions"><button disabled={busy} className="primary-button" onClick={() => void run(() => uploadData(data), 'This device is backed up.')}>Upload this device</button><button disabled={busy} className="secondary-button" onClick={() => void run(async () => setData(await restoreData()), 'Cloud data restored on this device.')}>Restore from cloud</button></div><button className="text-button danger" onClick={() => void run(signOut, 'Signed out.')}>Sign out</button></> : <form onSubmit={(event) => { event.preventDefault(); void run(() => requestMagicLink(email), 'Check your email for the secure sign-in link.') }}><label>Email<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label><button disabled={busy} className="primary-button full" type="submit">Email me a sign-in link</button></form>}</div>{status && <p className="cloud-status" role="status">{status}</p>}<p className="privacy-note">Microsoft access is delegated, read-only, and requested through its consent screen. Tokens remain in this browser session.</p></section></div>
}

function App() {
  const [view, setView] = useState<View>('overview')
  const [menuOpen, setMenuOpen] = useState(false)
  const [cloudOpen, setCloudOpen] = useState(false)
  const activeLabel = navItems.find((item) => item.id === view)?.label
  const navigate = (next: View) => { setView(next); setMenuOpen(false) }
  return <div className="app-shell"><aside className={`sidebar ${menuOpen ? 'open' : ''}`}><div className="brand"><span className="brand-mark">W</span><span>WOLFMAN</span></div><nav>{navItems.map((item) => { const Icon = item.icon; return <button className={view === item.id ? 'active' : ''} key={item.id} onClick={() => navigate(item.id)}><Icon size={19} /><span>{item.label}</span></button> })}</nav><div className="sidebar-footer"><button className="sync-state" onClick={() => setCloudOpen(true)}><Cloud size={17} /><span><strong>Connections</strong><small>{microsoftEnabled || cloudEnabled ? 'Available' : 'Not configured'}</small></span></button><button className="profile-button" title="Settings" onClick={() => setCloudOpen(true)}><span>W</span><span><strong>Local workspace</strong><small>Private on this device</small></span><Settings size={16} /></button></div></aside>{menuOpen && <button className="scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}<main><div className="mobile-header"><button className="icon-button" onClick={() => setMenuOpen(true)}><Menu size={20} /></button><strong>{activeLabel}</strong><button className="brand-mark small" onClick={() => setCloudOpen(true)}>W</button></div>{view === 'overview' && <Overview onNavigate={navigate} />}{view === 'money' && <MoneyView />}{view === 'planner' && <PlannerView />}{view === 'assistant' && <AssistantView />}</main><nav className="bottom-nav">{navItems.map((item) => { const Icon = item.icon; return <button className={view === item.id ? 'active' : ''} key={item.id} onClick={() => navigate(item.id)}><Icon size={20} /><span>{item.label}</span></button> })}</nav>{cloudOpen && <CloudSettings onClose={() => setCloudOpen(false)} />}</div>
}

export default App
