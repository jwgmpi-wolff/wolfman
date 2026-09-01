import type { WolfmanData } from './domain'
import { localTaskProvider } from './wolfman-core/providers/tasks/LocalTaskProvider'
import type { TaskFilter } from './wolfman-core/providers/tasks/TaskProvider'

const TASK_PATTERN = /\b(open|my)\s+tasks?\b|\bdo i have\b.*\btasks?\b|\btasks?\s+(?:due|for)\b|\boverdue\b.*\btasks?\b|\bhigh.priority\b.*\btasks?\b/i

function pickFilter(input: string): TaskFilter {
  const normalized = input.toLowerCase()
  if (/\boverdue\b/.test(normalized)) return 'overdue'
  if (/\bhigh.priority\b/.test(normalized)) return 'high-priority'
  if (/\btoday\b/.test(normalized)) return 'today'
  if (/\bthis week\b|\bweek\b/.test(normalized)) return 'week'
  return 'all'
}

export function answerTaskRequest(input: string, data: WolfmanData) {
  if (!TASK_PATTERN.test(input)) return null
  if (!data.tasks.length) return 'No local tasks are available. Add one in Planner first.'
  const filter = pickFilter(input)
  const tasks = localTaskProvider.getOpenTasks(data.tasks, filter)
  if (!tasks.length) return `No open tasks match "${filter}".`
  const rows = tasks.map((task) => `- **${task.title}** (${task.quadrant}) — ${task.due}`)
  return `**Open tasks${filter === 'all' ? '' : ` · ${filter}`}**\n\n${rows.join('\n')}`
}
