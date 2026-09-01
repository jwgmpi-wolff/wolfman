import type { Transaction } from './domain'

// Minimal RFC 4180 parser: handles quoted fields, embedded commas, and escaped quotes ("").
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') inQuotes = false
      else field += char
    } else if (char === '"') inQuotes = true
    else if (char === ',') { row.push(field); field = '' }
    else if (char === '\r') continue
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else field += char
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((cells) => cells.some((cell) => cell.trim().length))
}

function findColumn(header: string[], candidates: string[]) {
  const lower = header.map((cell) => cell.trim().toLowerCase())
  for (const candidate of candidates) {
    const index = lower.indexOf(candidate)
    if (index !== -1) return index
  }
  return -1
}

function parseAmount(value: string) {
  const cleaned = value.replace(/[^0-9.\-()]/g, '')
  if (!cleaned) return NaN
  const negative = cleaned.startsWith('(') && cleaned.endsWith(')')
  const parsed = Number(cleaned.replace(/[()]/g, ''))
  return negative ? -Math.abs(parsed) : parsed
}

export function parseTransactionsCsv(text: string): Omit<Transaction, 'id'>[] {
  const rows = parseCsv(text.trim())
  if (!rows.length) return []
  const header = rows[0]
  const dateCol = findColumn(header, ['date', 'transaction date', 'posted date'])
  const merchantCol = findColumn(header, ['merchant', 'description', 'payee', 'name'])
  const categoryCol = findColumn(header, ['category', 'type'])
  const amountCol = findColumn(header, ['amount'])
  const debitCol = findColumn(header, ['debit', 'withdrawal'])
  const creditCol = findColumn(header, ['credit', 'deposit'])
  if (dateCol === -1 || merchantCol === -1 || (amountCol === -1 && debitCol === -1 && creditCol === -1)) {
    throw new Error('CSV must include Date, Merchant/Description, and Amount (or Debit/Credit) columns.')
  }
  return rows.slice(1).map((cells) => {
    let amount = amountCol !== -1 ? parseAmount(cells[amountCol] ?? '') : NaN
    if (Number.isNaN(amount)) {
      const debit = debitCol !== -1 ? parseAmount(cells[debitCol] ?? '') : 0
      const credit = creditCol !== -1 ? parseAmount(cells[creditCol] ?? '') : 0
      amount = (Number.isNaN(credit) ? 0 : credit) - (Number.isNaN(debit) ? 0 : debit)
    }
    return {
      date: (cells[dateCol] ?? '').trim(),
      merchant: (cells[merchantCol] ?? '').trim() || 'Unknown',
      category: categoryCol !== -1 ? (cells[categoryCol] ?? '').trim() || 'Needs' : (amount >= 0 ? 'Savings' : 'Needs'),
      amount: Math.abs(amount),
    }
  }).filter((transaction) => transaction.date && !Number.isNaN(transaction.amount))
}

function parseTransactionsJson(text: string): Omit<Transaction, 'id'>[] {
  const parsed = JSON.parse(text) as unknown
  const list = Array.isArray(parsed) ? parsed : (parsed as { transactions?: unknown[] }).transactions
  if (!Array.isArray(list)) throw new Error('JSON must be an array of transactions, or an object with a "transactions" array.')
  return list.map((item) => {
    const record = item as Record<string, unknown>
    return {
      date: String(record.date ?? ''),
      merchant: String(record.merchant ?? record.description ?? record.payee ?? 'Unknown'),
      category: String(record.category ?? 'Needs'),
      amount: Number(record.amount ?? 0),
    }
  }).filter((transaction) => transaction.date && !Number.isNaN(transaction.amount))
}

export async function parseTransactionsFile(file: File): Promise<Omit<Transaction, 'id'>[]> {
  const text = await file.text()
  if (file.name.toLowerCase().endsWith('.json')) return parseTransactionsJson(text)
  return parseTransactionsCsv(text)
}
