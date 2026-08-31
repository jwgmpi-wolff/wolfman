import { createContext, useContext, type Dispatch, type SetStateAction } from 'react'
import type { JarvisData, Transaction } from './domain'

export type JarvisDataContextValue = {
  data: JarvisData
  setData: Dispatch<SetStateAction<JarvisData>>
  addTransaction: (transaction: Omit<Transaction, 'id'>) => void
  toggleTask: (id: string) => void
  incrementHabit: (id: string) => void
}

export const JarvisDataContext = createContext<JarvisDataContextValue | null>(null)

export function useJarvisData() {
  const context = useContext(JarvisDataContext)
  if (!context) throw new Error('useJarvisData must be used within JarvisDataProvider')
  return context
}