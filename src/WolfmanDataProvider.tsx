import { useEffect, useState, type ReactNode } from 'react'
import { WolfmanDataContext } from './wolfmanDataContext'
import type { WolfmanData, Transaction } from './domain'
import { seedData } from './seed'

const STORAGE_KEY = 'wolfman:data:v2'
const PREVIOUS_STORAGE_KEY = 'wolfman:data:v1'
const LEGACY_STORAGE_KEY = 'openjarvis:data:v1'

const sampleIds = new Set(['t1', 't2', 't3', 't4', 't5', 'g1', 'g2', 'k1', 'k2', 'k3', 'h1', 'h2', 'h3'])

function removeSampleData(data: WolfmanData): WolfmanData {
  return {
    ...data,
    monthlyIncome: data.monthlyIncome === 7200 ? 0 : data.monthlyIncome,
    hourlyWage: data.hourlyWage === 46 ? 0 : data.hourlyWage,
    transactions: data.transactions.filter((item) => !sampleIds.has(item.id)),
    budgets: data.budgets.filter((item) => !['Needs', 'Wants', 'Savings'].includes(item.category)),
    goals: data.goals.filter((item) => !sampleIds.has(item.id)),
    tasks: data.tasks.filter((item) => !sampleIds.has(item.id)),
    habits: data.habits.filter((item) => !sampleIds.has(item.id)),
  }
}

function readData(): WolfmanData {
  try {
    const current = localStorage.getItem(STORAGE_KEY)
    // Filter unconditionally: earlier builds could have already saved sample data under this key.
    if (current) return removeSampleData(JSON.parse(current) as WolfmanData)
    const previous = localStorage.getItem(PREVIOUS_STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    return previous ? removeSampleData(JSON.parse(previous) as WolfmanData) : seedData
  } catch {
    return seedData
  }
}

function useWolfmanDataState() {
  const [data, setData] = useState<WolfmanData>(readData)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }, [data])

  const addTransaction = (transaction: Omit<Transaction, 'id'>) => {
    setData((current) => ({
      ...current,
      transactions: [{ ...transaction, id: crypto.randomUUID() }, ...current.transactions],
    }))
  }

  const toggleTask = (id: string) => {
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) =>
        task.id === id ? { ...task, completed: !task.completed } : task,
      ),
    }))
  }

  const incrementHabit = (id: string) => {
    setData((current) => ({
      ...current,
      habits: current.habits.map((habit) =>
        habit.id === id
          ? { ...habit, completedDays: Math.min(habit.targetDays, habit.completedDays + 1) }
          : habit,
      ),
    }))
  }

  return { data, setData, addTransaction, toggleTask, incrementHabit }
}

export function WolfmanDataProvider({ children }: { children: ReactNode }) {
  const value = useWolfmanDataState()
  return <WolfmanDataContext.Provider value={value}>{children}</WolfmanDataContext.Provider>
}
