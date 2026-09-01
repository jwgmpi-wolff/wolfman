import type { Task } from '../../../domain'

export type TaskFilter = 'today' | 'week' | 'overdue' | 'high-priority' | 'all'

export type TaskProvider = {
  getOpenTasks(tasks: Task[], filter: TaskFilter): Task[]
}
