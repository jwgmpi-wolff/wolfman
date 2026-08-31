export type Transaction = {
  id: string
  date: string
  merchant: string
  category: string
  amount: number
}

export type Budget = {
  category: string
  limit: number
}

export type Goal = {
  id: string
  name: string
  current: number
  target: number
  due: string
}

export type Task = {
  id: string
  title: string
  quadrant: 'Do now' | 'Schedule' | 'Delegate' | 'Eliminate'
  due: string
  completed: boolean
}

export type Habit = {
  id: string
  name: string
  completedDays: number
  targetDays: number
}

export type JarvisData = {
  monthlyIncome: number
  hourlyWage: number
  transactions: Transaction[]
  budgets: Budget[]
  goals: Goal[]
  tasks: Task[]
  habits: Habit[]
}

export type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  content: string
}
