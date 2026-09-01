import type { ImportedDataset, WolfmanData } from './domain'
import { analyzeDataset } from './fileImport'
import { analyzeStockPerformance } from './stocks'

const money = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const datasetPattern = /\b(import(?:ed|ing)?|upload(?:ed|ing)?|dataset|portfolio|holdings|positions|spreadsheet|csv|json)\b/
const analysisPattern = /\b(analy[sz]e|analysis|strategy|strategies|allocation|rebalance|buy|sell|hold)\b/

export function isDatasetRequest(input: string) {
  return datasetPattern.test(input.toLowerCase())
}

export function extractStockSymbols(dataset: ImportedDataset) {
  const symbolColumn = dataset.columns.find((column) => /^(symbol|ticker|ticker symbol|stock symbol)$/i.test(column.trim()))
  if (!symbolColumn) return []
  return Array.from(new Set(dataset.rows
    .map((row) => row[symbolColumn]?.trim().toUpperCase())
    .filter((symbol): symbol is string => Boolean(symbol && /^[A-Z0-9.-]{1,10}$/.test(symbol)))))
}

export async function answerDatasetRequest(input: string, data: WolfmanData) {
  const normalized = input.toLowerCase()
  if (!isDatasetRequest(normalized)) return null
  if (!data.datasets.length) return 'No imported datasets are available yet. Use "Import file" in the Money view.'

  const dataset = data.datasets[0]
  const { identifierColumn, totals, ranked } = analyzeDataset(dataset)
  if (!totals.length) {
    return `**${dataset.name}**\n\n${dataset.rows.length} rows, columns: ${dataset.columns.join(', ')}. No numeric columns were found to summarize.`
  }

  const totalsText = totals.map((total) => `- **${total.column}:** total ${money.format(total.sum)}, average ${money.format(total.average)} across ${total.count} rows`).join('\n')
  const rankedText = ranked.map(([key, values]) => {
    const parts = Object.entries(values).map(([column, value]) => `${column} ${money.format(value)}`).join(', ')
    return `- **${key}:** ${parts}`
  }).join('\n')

  const summary = `**${dataset.name}** (imported ${new Date(dataset.importedAt).toLocaleString()})\n\n${dataset.rows.length} rows across ${dataset.columns.length} columns: ${dataset.columns.join(', ')}\n\n**Totals**\n\n${totalsText}\n\n**By ${identifierColumn} (top ${ranked.length})**\n\n${rankedText}`
  const symbols = extractStockSymbols(dataset)
  if (!analysisPattern.test(normalized) || !symbols.length) return summary

  const analysis = await analyzeStockPerformance(symbols)
  return `${summary}\n\n**Unique imported ticker symbols analyzed: ${symbols.length}**\n\n${analysis}`
}
