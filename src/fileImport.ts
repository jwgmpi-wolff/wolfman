import type { Transaction, ImportedDataset } from './domain'

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

// Some exports (e.g. brokerage "Positions" reports) prefix the real header with title/timestamp
// lines that have a different column count. Find the first row whose column count matches most
// of what follows it, and treat that as the header.
function findHeaderRowIndex(rows: string[][]) {
  for (let i = 0; i < rows.length - 1; i++) {
    const width = rows[i].length
    if (width < 2) continue
    const following = rows.slice(i + 1, i + 6)
    const matches = following.filter((row) => row.length === width).length
    if (matches >= Math.min(2, following.length)) return i
  }
  return 0
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

// Strips thousands separators/currency/percent symbols; recognizes "--"/"" as not-a-number.
function parseNumericCell(value: string) {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '--' || trimmed === '-') return NaN
  return parseAmount(trimmed.replace(/,/g, ''))
}

function tryParseTransactionsCsv(rows: string[][]): Omit<Transaction, 'id'>[] | null {
  const headerIndex = findHeaderRowIndex(rows)
  const header = rows[headerIndex]
  const dateCol = findColumn(header, ['date', 'transaction date', 'posted date'])
  const merchantCol = findColumn(header, ['merchant', 'description', 'payee', 'name'])
  const categoryCol = findColumn(header, ['category', 'type'])
  const amountCol = findColumn(header, ['amount'])
  const debitCol = findColumn(header, ['debit', 'withdrawal'])
  const creditCol = findColumn(header, ['credit', 'deposit'])
  if (dateCol === -1 || merchantCol === -1 || (amountCol === -1 && debitCol === -1 && creditCol === -1)) return null
  return rows.slice(headerIndex + 1).map((cells) => {
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

function parseGenericCsv(text: string, name: string): ImportedDataset {
  const rows = parseCsv(text.trim())
  if (!rows.length) throw new Error('That file has no readable rows.')
  const headerIndex = findHeaderRowIndex(rows)
  const columns = rows[headerIndex].map((cell) => cell.trim() || 'Column')
  const records = rows.slice(headerIndex + 1)
    .filter((cells) => cells.length === columns.length)
    .map((cells) => Object.fromEntries(columns.map((column, index) => [column, (cells[index] ?? '').trim()])))
  if (!records.length) throw new Error('No data rows were found after the header.')
  return { id: crypto.randomUUID(), name, importedAt: new Date().toISOString(), columns, rows: records }
}

function transactionsFromJsonArray(list: unknown[]): Omit<Transaction, 'id'>[] | null {
  if (!list.length || typeof list[0] !== 'object' || list[0] === null) return null
  const sample = list[0] as Record<string, unknown>
  if (!('date' in sample) || !('amount' in sample)) return null
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

function datasetFromJson(parsed: unknown, name: string): ImportedDataset {
  const list = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown[] }).rows
  if (!Array.isArray(list) || !list.length || list.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))) {
    throw new Error('JSON must be a non-empty array of objects, or an object with a "rows" array.')
  }
  const columns = Array.from(new Set(list.flatMap((item) => Object.keys(item as Record<string, unknown>))))
  const rows = list.map((item) => {
    const record = item as Record<string, unknown>
    return Object.fromEntries(columns.map((column) => [column, record[column] === undefined ? '' : String(record[column])]))
  })
  return { id: crypto.randomUUID(), name, importedAt: new Date().toISOString(), columns, rows }
}

export type ImportResult =
  | { kind: 'transactions'; transactions: Omit<Transaction, 'id'>[] }
  | { kind: 'dataset'; dataset: ImportedDataset }

async function readFileText(file: File) {
  if (typeof file.text === 'function') return file.text()
  return new TextDecoder().decode(await file.arrayBuffer())
}

// Any CSV/JSON schema is accepted: recognized transaction-style files import as transactions,
// everything else is stored as a generic dataset (arbitrary columns) for analysis.
export async function parseImportFile(file: File): Promise<ImportResult> {
  const text = await readFileText(file)
  const name = file.name.replace(/\.(csv|json)$/i, '')
  if (file.name.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(text) as unknown
    const list = Array.isArray(parsed) ? parsed : (parsed as { transactions?: unknown[] }).transactions
    const transactions = Array.isArray(list) ? transactionsFromJsonArray(list) : null
    if (transactions) return { kind: 'transactions', transactions }
    return { kind: 'dataset', dataset: datasetFromJson(parsed, name) }
  }
  const rows = parseCsv(text.trim())
  const transactions = tryParseTransactionsCsv(rows)
  if (transactions?.length) return { kind: 'transactions', transactions }
  return { kind: 'dataset', dataset: parseGenericCsv(text, name) }
}

type NumericSummary = { column: string; sum: number; average: number; count: number }

// Groups by the first non-numeric ("identifier") column, summing every numeric column per group —
// works for arbitrary tabular exports (portfolio positions, inventories, expense reports, etc.).
export function analyzeDataset(dataset: ImportedDataset) {
  const numericColumns = dataset.columns.filter((column) =>
    dataset.rows.some((row) => !Number.isNaN(parseNumericCell(row[column] ?? ''))),
  )
  const identifierColumn = dataset.columns.find((column) => !numericColumns.includes(column)) ?? dataset.columns[0]

  const totals: NumericSummary[] = numericColumns.map((column) => {
    const values = dataset.rows.map((row) => parseNumericCell(row[column] ?? '')).filter((value) => !Number.isNaN(value))
    const sum = values.reduce((acc, value) => acc + value, 0)
    return { column, sum, average: values.length ? sum / values.length : 0, count: values.length }
  })

  const rankingColumn = totals.find((total) => /value|total|amount|balance/i.test(total.column))?.column ?? totals[0]?.column
  const groups = new Map<string, Record<string, number>>()
  for (const row of dataset.rows) {
    const key = row[identifierColumn]?.trim() || '(blank)'
    const bucket = groups.get(key) ?? {}
    for (const column of numericColumns) {
      const value = parseNumericCell(row[column] ?? '')
      if (!Number.isNaN(value)) bucket[column] = (bucket[column] ?? 0) + value
    }
    groups.set(key, bucket)
  }
  const ranked = Array.from(groups.entries())
    .sort((a, b) => (rankingColumn ? (b[1][rankingColumn] ?? 0) - (a[1][rankingColumn] ?? 0) : 0))
    .slice(0, 15)

  return { identifierColumn, numericColumns, totals, ranked }
}

