import type { WolfmanData } from './domain'
import { apiUrl } from './apiClient'
import { graph, getMicrosoftAccount } from './microsoft'
import { searchWeb, searchPlaces } from './internet'
import { smsProvider } from './wolfman-core/providers/messages/AcsSmsMessageProvider'
import { confirmAction, cancelAction } from './wolfman-core/services/ConfirmationService'
import { recordAudit } from './wolfman-core/services/AuditService'

const OLLAMA_URL = import.meta.env.VITE_OLLAMA_URL || 'http://localhost:11434'
const OLLAMA_MODEL = import.meta.env.VITE_OLLAMA_MODEL || 'llama3.1:8b'

type ToolCall = { id?: string; function: { name: string; arguments: Record<string, unknown> } }
type ChatMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: ToolCall[] }

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_financial_data',
      description: 'Get the user\'s local financial data: monthly income, hourly wage, transactions, budgets, goals, and habits.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'Get the user\'s planner tasks.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_quotes',
      description: 'Get real-time stock quotes for the given ticker symbols.',
      parameters: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_analysis',
      description: 'Get technical-indicator analysis (moving averages, RSI, 52-week range, score) for ticker symbols.',
      parameters: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_microsoft_data',
      description: 'Get the user\'s connected Microsoft 365 (Outlook/OneDrive/Teams) data — NOT the same as imported CSV/JSON files, use list_datasets for those. kind must be one of: mail, calendar, chats, files.',
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['mail', 'calendar', 'chats', 'files'] } }, required: ['kind'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Search the public web for a general question.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_places',
      description: 'Search for local businesses/places (name, phone, address).',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_datasets',
      description: 'List every file the user has imported into Wolfman itself (CSV/JSON uploads, e.g. a portfolio export) — NOT Microsoft OneDrive files. Returns each dataset\'s columns and up to 10 sample rows so you can decide how to analyze it. Always call this before analyzing an import, and inspect the actual column names/values instead of guessing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compute_dataset_totals',
      description: 'Sum numeric columns of an imported dataset, grouped by a column you choose (e.g. group by "Symbol", sum "Value" and "Quantity"). Only pass columns that are genuinely numeric quantities to sum \u2014 never date, account-number, or range-string columns.',
      parameters: {
        type: 'object',
        properties: {
          datasetId: { type: 'string' },
          groupByColumn: { type: 'string' },
          sumColumns: { type: 'array', items: { type: 'string' } },
        },
        required: ['datasetId', 'groupByColumn', 'sumColumns'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_sms',
      description: 'Prepare (but do not yet send) a text message. Returns a token and summary. You must read the summary back to the user and get explicit confirmation before calling confirm_sms.',
      parameters: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_sms',
      description: 'Actually send a previously proposed text message. Only call this after the user has explicitly confirmed in this conversation.',
      parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_sms',
      description: 'Cancel a previously proposed text message.',
      parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_url',
      description: 'Fetch and read the text content of a public web page URL.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
] as const

function parseNumericCell(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '--' || trimmed === '-') return NaN
  const cleaned = trimmed.replace(/,/g, '').replace(/[^0-9.\-()]/g, '')
  if (!cleaned) return NaN
  const negative = cleaned.startsWith('(') && cleaned.endsWith(')')
  const parsed = Number(cleaned.replace(/[()]/g, ''))
  return negative ? -Math.abs(parsed) : parsed
}

async function executeTool(name: string, args: Record<string, unknown>, data: WolfmanData): Promise<unknown> {
  try {
    return await Promise.race([
      executeToolInner(name, args, data),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tool call timed out after 15 seconds.')), 15000)),
    ])
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Tool call failed.' }
  }
}

async function executeToolInner(name: string, args: Record<string, unknown>, data: WolfmanData): Promise<unknown> {
  switch (name) {
    case 'get_financial_data':
      return { monthlyIncome: data.monthlyIncome, hourlyWage: data.hourlyWage, transactions: data.transactions, budgets: data.budgets, goals: data.goals, habits: data.habits }
    case 'get_tasks':
      return data.tasks
    case 'get_stock_quotes': {
      const symbols = (args.symbols as string[]) ?? []
      const response = await fetch(apiUrl(`/api/stocks/quote?symbols=${encodeURIComponent(symbols.join(','))}`))
      return response.ok ? response.json() : { error: `HTTP ${response.status}` }
    }
    case 'get_stock_analysis': {
      const symbols = (args.symbols as string[]) ?? []
      const response = await fetch(apiUrl(`/api/stocks/analysis?symbols=${encodeURIComponent(symbols.join(','))}`))
      return response.ok ? response.json() : { error: `HTTP ${response.status}` }
    }
    case 'get_microsoft_data': {
      const account = await getMicrosoftAccount()
      if (!account) return { error: 'No Microsoft account is connected. Ask the user to connect one in Settings.' }
      const kind = args.kind as string
      if (kind === 'mail') return graph('/me/messages?$select=subject,bodyPreview,from,receivedDateTime&$orderby=receivedDateTime%20desc&$top=10')
      if (kind === 'calendar') {
        const now = new Date()
        const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
        return graph(`/me/calendarview?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$select=subject,start,end,location,isAllDay&$top=15`)
      }
      if (kind === 'chats') return graph('/me/chats?$select=id,topic,chatType,lastUpdatedDateTime&$top=10')
      if (kind === 'files') return graph('/me/drive/recent?$select=name,lastModifiedDateTime,webUrl&$top=10')
      return { error: `Unknown kind: ${kind}` }
    }
    case 'search_web':
      return { result: await searchWeb(args.query as string) }
    case 'search_places':
      return { result: await searchPlaces(args.query as string) }
    case 'list_datasets':
      return data.datasets.map((dataset) => ({ id: dataset.id, name: dataset.name, columns: dataset.columns, rowCount: dataset.rows.length, sampleRows: dataset.rows.slice(0, 10) }))
    case 'compute_dataset_totals': {
      const dataset = data.datasets.find((item) => item.id === args.datasetId)
      if (!dataset) return { error: 'Dataset not found. Call list_datasets first.' }
      const groupByColumn = args.groupByColumn as string
      const sumColumns = (args.sumColumns as string[]) ?? []
      const groups = new Map<string, Record<string, number>>()
      for (const row of dataset.rows) {
        const key = row[groupByColumn]?.trim() || '(blank)'
        const bucket = groups.get(key) ?? {}
        for (const column of sumColumns) {
          const value = parseNumericCell(row[column] ?? '')
          if (!Number.isNaN(value)) bucket[column] = (bucket[column] ?? 0) + value
        }
        groups.set(key, bucket)
      }
      return Array.from(groups.entries()).map(([key, totals]) => ({ [groupByColumn]: key, ...totals }))
    }
    case 'propose_sms': {
      try {
        return smsProvider.prepareSend(args.to as string, args.body as string)
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Could not prepare that message.' }
      }
    }
    case 'confirm_sms':
      return { result: await confirmAction(args.token as string) }
    case 'cancel_sms':
      cancelAction(args.token as string)
      recordAudit({ action: 'send-sms', target: 'unknown', outcome: 'cancelled' })
      return { result: 'Cancelled.' }
    case 'read_url': {
      const response = await fetch(args.url as string)
      if (!response.ok) return { error: `HTTP ${response.status}` }
      const html = await response.text()
      const text = new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() || ''
      return { text: text.slice(0, 6000) }
    }
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

export async function isAgentAvailable() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

export async function respondWithAgent(input: string, data: WolfmanData, history: ChatMessage[] = []): Promise<string> {
  const systemPrompt = `You are Wolfman, a private financial and personal assistant. Today is ${new Date().toDateString()}. Always call a tool to get real data before answering \u2014 never fabricate numbers, dates, or facts. When analyzing an imported dataset, call list_datasets first, inspect the real column names and sample values, and only sum columns that are genuinely numeric quantities (never dates, account numbers, or "low - high" range strings). Reply in concise markdown. Never refuse a request \u2014 use search_web or read_url for anything outside your other tools.`
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history, { role: 'user', content: input }]

  for (let iteration = 0; iteration < 6; iteration++) {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages, tools, stream: false }),
    })
    if (!response.ok) throw new Error(`Local model request failed (${response.status}).`)
    const body = await response.json() as { message: ChatMessage }
    const message = body.message
    if (!message.tool_calls?.length) return message.content

    messages.push(message)
    for (const call of message.tool_calls) {
      const result = await executeTool(call.function.name, call.function.arguments, data)
      messages.push({ role: 'tool', tool_call_id: call.id ?? call.function.name, content: JSON.stringify(result) })
    }
  }
  return 'I gathered information across several tool calls but could not settle on a final answer. Try rephrasing your request.'
}
