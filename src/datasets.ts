import type { WolfmanData } from './domain'
import { analyzeDataset } from './fileImport'

const money = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

export function answerDatasetRequest(input: string, data: WolfmanData) {
  const normalized = input.toLowerCase()
  if (!/\b(import|dataset|portfolio|holdings|positions|spreadsheet|uploaded file)\b/.test(normalized)) return null
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

  return `**${dataset.name}** (imported ${new Date(dataset.importedAt).toLocaleString()})\n\n${dataset.rows.length} rows across ${dataset.columns.length} columns: ${dataset.columns.join(', ')}\n\n**Totals**\n\n${totalsText}\n\n**By ${identifierColumn} (top ${ranked.length})**\n\n${rankedText}`
}
