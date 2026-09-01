import type { Task } from '../../../domain'
import type { TaskFilter, TaskProvider } from './TaskProvider'

// The due field is freeform text entered by the user ("Today, 4:00 PM"), not a parseable date,
// so "today"/"week"/"overdue" are matched against that text rather than computed from a real Date.
export const localTaskProvider: TaskProvider = {
  getOpenTasks(tasks: Task[], filter: TaskFilter) {
    const open = tasks.filter((task) => !task.completed)
    switch (filter) {
      case 'today':
        return open.filter((task) => /\btoday\b/i.test(task.due))
      case 'week':
        return open.filter((task) => !/\boverdue\b/i.test(task.due))
      case 'overdue':
        return open.filter((task) => /\boverdue\b/i.test(task.due))
      case 'high-priority':
        return open.filter((task) => task.quadrant === 'Do now')
      default:
        return open
    }
  },
}
