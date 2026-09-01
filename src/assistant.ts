import type { WolfmanData } from './domain'
import { answerMicrosoftRequest, readRequestedUrl } from './microsoft'
import { answerStockRequest } from './stocks'

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

function spentByCategory(data: WolfmanData, category: string) {
  return data.transactions
    .filter((transaction) => transaction.category === category)
    .reduce((total, transaction) => total + transaction.amount, 0)
}

function dailyBriefing(data: WolfmanData) {
  if (!data.tasks.length && !data.transactions.length) return 'No local tasks or financial records are available.'
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date())
  const tasks = data.tasks.filter((task) => !task.completed).slice(0, 3)
  const spent = data.transactions.reduce((total, transaction) => total + transaction.amount, 0)
  return `**${date} · Daily briefing**\n\n**Must do**\n${tasks.map((task, index) => `${index + 1}. ${task.title} — ${task.due}`).join('\n')}\n\n**Calendar**\nProtect 90 minutes for the first task. Your next scheduled item is ${tasks[0]?.due ?? 'open'}.\n\n**Financial snapshot**\nRecorded spending is ${money.format(spent)} this month. Savings contributions are ${money.format(spentByCategory(data, 'Savings'))}.`
}

function weeklyReview(data: WolfmanData) {
  if (!data.budgets.length && !data.tasks.length && !data.habits.length) return 'No local budget, task, or habit records are available.'
  const budgetRows = data.budgets.map((budget) => {
    const spent = spentByCategory(data, budget.category)
    return `| ${budget.category} | ${money.format(spent)} | ${money.format(budget.limit)} | ${Math.round((spent / budget.limit) * 100)}% |`
  })
  const completed = data.tasks.filter((task) => task.completed).length
  const habits = data.habits.length
    ? data.habits.reduce((total, habit) => total + (habit.targetDays ? habit.completedDays / habit.targetDays : 0), 0) / data.habits.length
    : 0
  return `**Weekly review**\n\n| Category | Spent | Budget | Used |\n|---|---:|---:|---:|\n${budgetRows.join('\n')}\n\n**Personal**\n${completed} of ${data.tasks.length} tasks completed. Habit consistency is ${Math.round(habits * 100)}%.\n\n**Next week**\nPrioritize ${data.tasks.find((task) => !task.completed)?.title ?? 'planning the next milestone'} and protect the emergency-fund contribution.`
}

function purchaseReview(data: WolfmanData, input: string) {
  const priceMatch = input.replace(/,/g, '').match(/\$?([0-9]+(?:\.[0-9]{1,2})?)/)
  const price = priceMatch ? Number(priceMatch[1]) : 0
  if (!price) return 'What is the item price? I will compare it with your work hours, budget pace, and savings goals.'
  if (!data.hourlyWage) return 'Add your hourly wage before asking for a work-hour purchase comparison.'
  const wantsBudget = data.budgets.find((budget) => budget.category === 'Wants')?.limit ?? 0
  const wantsSpent = spentByCategory(data, 'Wants')
  const hours = price / data.hourlyWage
  const annualOpportunity = price * 1.07 ** 10
  return `**Purchase check · ${money.format(price)}**\n\n- **Work equivalent:** ${hours.toFixed(1)} hours at ${money.format(data.hourlyWage)}/hour\n- **Wants budget:** ${money.format(wantsSpent)} of ${money.format(wantsBudget)} used\n- **10-year opportunity cost:** about ${money.format(annualOpportunity)} at a hypothetical 7% annual return\n\nWhich long-term goal does this purchase support, and what would you delay to fund it? This is educational analysis, not financial advice.`
}

export async function respondAsWolfman(input: string, data: WolfmanData) {
  const stockResponse = await answerStockRequest(input)
  if (stockResponse) return stockResponse
  const microsoftResponse = await answerMicrosoftRequest(input)
  if (microsoftResponse) return microsoftResponse
  const webResponse = await readRequestedUrl(input)
  if (webResponse) return webResponse
  const normalized = input.toLowerCase().trim()
  if (normalized === 'good morning' || normalized.includes('daily briefing')) return dailyBriefing(data)
  if (normalized.includes('weekly review')) return weeklyReview(data)
  if (normalized.includes('buy') || normalized.includes('purchase')) return purchaseReview(data, input)
  if (normalized.includes('budget')) {
    if (!data.budgets.length) return 'No local budget records are available.'
    return `**Budget pacing**\n\n${data.budgets.map((budget) => `- **${budget.category}:** ${money.format(spentByCategory(data, budget.category))} of ${money.format(budget.limit)}`).join('\n')}\n\nYour current framework follows 50/30/20 across needs, wants, and savings.`
  }
  return 'I do not have information for that request. Enter the relevant details, connect a Microsoft account in Settings, or include a public URL for me to read.'
}