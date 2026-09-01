import { apiUrl } from './apiClient'

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

export async function fetchStockPerformance(symbols: string[] = []) {
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
  if (/\b(strategy|strategies|analysis|analyze|signal|trend|momentum|buy|sell|should i|technicals?|indicator)\b/.test(normalized)) {
    return analyzeStockPerformance()
  }
  if (!/\b(performance|price|prices|check|today|doing|up|down)\b/.test(normalized)) return null
  return fetchStockPerformance()
}

type StockAnalysis = {
  symbol: string
  name?: string
  price?: number
  currency?: string
  sma20?: number | null
  sma50?: number | null
  rsi14?: number | null
  week52Low?: number
  week52High?: number
  rangePercent?: number
  score?: number
  label?: string
  reasons?: string[]
  error?: string
}

export async function analyzeStockPerformance(symbols: string[] = []) {
  if (!symbols.length) return 'No stock watchlist is available. Add symbols to analyze.'
  const results: StockAnalysis[] = []
  for (let index = 0; index < symbols.length; index += 25) {
    const batch = symbols.slice(index, index + 25)
    let response: Response
    try {
      response = await fetch(apiUrl(`/api/stocks/analysis?symbols=${encodeURIComponent(batch.join(','))}`))
    } catch {
      return 'Live stock data is unavailable. This feature requires the local development proxy or a deployed market-data endpoint.'
    }
    if (!response.ok) return `Stock analysis request failed (${response.status}).`
    const body = (await response.json()) as { results: StockAnalysis[] }
    results.push(...body.results)
  }
  const sections = results.map((stock) => {
    if (stock.error || stock.price === undefined) return `### ${stock.symbol}\n${stock.error ?? 'No data available'}`
    const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: stock.currency ?? 'USD' }).format(stock.price)
    const reasons = (stock.reasons ?? []).map((reason) => `- ${reason}`).join('\n')
    return `### ${stock.symbol} (${stock.name ?? stock.symbol}) — ${stock.label} (score ${stock.score})\n${price} · derived from real 1-year daily price history\n\n${reasons}`
  })
  return `**Stock analysis**\n\nBased on real moving averages, RSI, and 52-week range from each symbol's own price history — not a fabricated opinion.\n\n${sections.join('\n\n')}`
}

