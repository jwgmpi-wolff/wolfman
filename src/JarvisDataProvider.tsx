import { useEffect, useState, type ReactNode } from 'react'
import { JarvisDataContext } from './jarvisDataContext'
import type { JarvisData, Transaction } from './domain'
import { seedData } from './seed'

const STORAGE_KEY = 'openjarvis:data:v1'

function readData(): JarvisData {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? (JSON.parse(saved) as JarvisData) : seedData
  } catch {
    return seedData
  }
}

function useJarvisDataState() {
  const [data, setData] = useState<JarvisData>(readData)

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

export function JarvisDataProvider({ children }: { children: ReactNode }) {
  const value = useJarvisDataState()
  return <JarvisDataContext.Provider value={value}>{children}</JarvisDataContext.Provider>
}
