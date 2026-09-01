import { createContext, useContext, type Dispatch, type SetStateAction } from 'react'
import type { WolfmanData, Transaction, Task, ImportedDataset } from './domain'

export type WolfmanDataContextValue = {
  data: WolfmanData
  setData: Dispatch<SetStateAction<WolfmanData>>
  addTransaction: (transaction: Omit<Transaction, 'id'>) => void
  addTask: (task: Omit<Task, 'id' | 'completed'>) => void
  importTransactions: (transactions: Omit<Transaction, 'id'>[]) => void
  importDataset: (dataset: ImportedDataset) => void
  toggleTask: (id: string) => void
  incrementHabit: (id: string) => void
}

export const WolfmanDataContext = createContext<WolfmanDataContextValue | null>(null)

export function useWolfmanData() {
  const context = useContext(WolfmanDataContext)
  if (!context) throw new Error('useWolfmanData must be used within WolfmanDataProvider')
  return context
}