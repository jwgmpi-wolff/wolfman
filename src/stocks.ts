// Symbols read from the connected Stock Movement Analyzer app's watchlist on this device.
import { apiUrl } from './apiClient'

export const importedWatchlist = ['MSFT', 'AAPL', 'NVDA']

type StockQuote = {
  symbol: string
  name?: string
  price?: number
  previousClose?: number
  changePercent?: number | null
  currency?: string
  asOf?: string | null
  error?: string
}

const percent = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 })

function formatPrice(quote: StockQuote) {
  if (quote.price === undefined) return 'unavailable'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: quote.currency ?? 'USD' }).format(quote.price)
}

export async function fetchStockPerformance(symbols: string[] = importedWatchlist) {
  if (!symbols.length) return 'No stock watchlist is available. Add symbols to check performance for.'
  let response: Response
  try {
    response = await fetch(apiUrl(`/api/stocks/quote?symbols=${encodeURIComponent(symbols.join(','))}`))
  } catch {
    return 'Live stock data is unavailable. This feature requires the local development proxy or a deployed market-data endpoint.'
  }
  if (!response.ok) return `Live stock data request failed (${response.status}).`
  const { quotes } = (await response.json()) as { quotes: StockQuote[] }
  const rows = quotes.map((quote) => {
    if (quote.error || quote.price === undefined) return `- **${quote.symbol}:** ${quote.error ?? 'No data available'}`
    const change = quote.changePercent ?? (quote.previousClose ? ((quote.price - quote.previousClose) / quote.previousClose) * 100 : null)
    const direction = change !== null && change < 0 ? 'down' : 'up'
    const changeText = change !== null ? `${direction} ${percent.format(Math.abs(change) / 100)}` : 'change unavailable'
    return `- **${quote.symbol}** (${quote.name ?? quote.symbol}): ${formatPrice(quote)} · ${changeText}`
  })
  return `**Stock performance today**\n\n${rows.join('\n')}`
}

export function answerStockRequest(input: string) {
  const normalized = input.toLowerCase()
  if (!/\b(stock|stocks|shares|ticker|portfolio|market)\b/.test(normalized)) return null
  if (!/\b(performance|price|prices|check|today|doing|up|down)\b/.test(normalized)) return null
  return fetchStockPerformance()
}
