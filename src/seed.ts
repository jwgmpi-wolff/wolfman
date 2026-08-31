import type { WolfmanData } from './domain'

const today = new Date()
const isoDate = (offset: number) => {
  const date = new Date(today)
  date.setDate(date.getDate() + offset)
  return date.toISOString().slice(0, 10)
}

export const seedData: WolfmanData = {
  monthlyIncome: 7200,
  hourlyWage: 46,
  transactions: [
    { id: 't1', date: isoDate(-1), merchant: 'Whole Foods', category: 'Needs', amount: 86.42 },
    { id: 't2', date: isoDate(-2), merchant: 'City Electric', category: 'Needs', amount: 142.18 },
    { id: 't3', date: isoDate(-3), merchant: 'Morning Brew', category: 'Wants', amount: 7.5 },
    { id: 't4', date: isoDate(-5), merchant: 'Index fund', category: 'Savings', amount: 600 },
    { id: 't5', date: isoDate(-7), merchant: 'Metro pass', category: 'Needs', amount: 128 },
  ],
  budgets: [
    { category: 'Needs', limit: 3600 },
    { category: 'Wants', limit: 2160 },
    { category: 'Savings', limit: 1440 },
  ],
  goals: [
    { id: 'g1', name: 'Emergency fund', current: 12600, target: 18000, due: '2027-02-28' },
    { id: 'g2', name: 'Japan trip', current: 2800, target: 6000, due: '2027-06-01' },
  ],
  tasks: [
    { id: 'k1', title: 'Submit quarterly strategy', quadrant: 'Do now', due: 'Today, 11:00 AM', completed: false },
    { id: 'k2', title: 'Review retirement allocation', quadrant: 'Schedule', due: 'Today, 4:00 PM', completed: false },
    { id: 'k3', title: 'Confirm dentist appointment', quadrant: 'Delegate', due: 'Tomorrow', completed: false },
  ],
  habits: [
    { id: 'h1', name: 'Exercise', completedDays: 4, targetDays: 5 },
    { id: 'h2', name: 'Read', completedDays: 5, targetDays: 7 },
    { id: 'h3', name: 'Hydration', completedDays: 6, targetDays: 7 },
  ],
}
