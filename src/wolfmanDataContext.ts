import { createContext, useContext, type Dispatch, type SetStateAction } from 'react'
import type { WolfmanData, Transaction } from './domain'

export type WolfmanDataContextValue = {
  data: WolfmanData
  setData: Dispatch<SetStateAction<WolfmanData>>
  addTransaction: (transaction: Omit<Transaction, 'id'>) => void
  toggleTask: (id: string) => void
  incrementHabit: (id: string) => void
}

export const WolfmanDataContext = createContext<WolfmanDataContextValue | null>(null)

export function useWolfmanData() {
  const context = useContext(WolfmanDataContext)
  if (!context) throw new Error('useWolfmanData must be used within WolfmanDataProvider')
  return context
}