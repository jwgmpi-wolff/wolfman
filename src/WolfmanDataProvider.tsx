import { useEffect, useState, type ReactNode } from 'react'
import { WolfmanDataContext } from './wolfmanDataContext'
import type { WolfmanData, Transaction } from './domain'
import { seedData } from './seed'

const STORAGE_KEY = 'wolfman:data:v1'
const LEGACY_STORAGE_KEY = 'openjarvis:data:v1'

function readData(): WolfmanData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    return saved ? (JSON.parse(saved) as WolfmanData) : seedData
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
