import { app, HttpRequest, HttpResponseInit } from '@azure/functions'

const SYMBOL = /^[A-Z0-9.-]{1,10}$/

function sma(closes: number[], period: number) {
  if (closes.length < period) return null
  const slice = closes.slice(-period)
  return slice.reduce((sum, value) => sum + value, 0) / period
}

// Wilder's RSI over the trailing `period` daily changes.
function rsi(closes: number[], period = 14) {
  if (closes.length < period + 1) return null
  const changes = closes.slice(-period - 1).map((value, index, arr) => (index === 0 ? 0 : value - arr[index - 1])).slice(1)
  const gains = changes.filter((change) => change > 0).reduce((sum, change) => sum + change, 0) / period
  const losses = changes.filter((change) => change < 0).reduce((sum, change) => sum - change, 0) / period
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

function analyze(symbol: string, name: string, price: number, currency: string, closes: number[]) {
  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)
  const rsi14 = rsi(closes, 14)
  const week52Low = closes.length ? Math.min(...closes, price) : price
  const week52High = closes.length ? Math.max(...closes, price) : price
  const rangePercent = week52High > week52Low ? ((price - week52Low) / (week52High - week52Low)) * 100 : 50

  let score = 0
  const reasons: string[] = []

  if (sma20 !== null) {
    const diff = ((price - sma20) / sma20) * 100
    score += diff >= 0 ? 15 : -15
    reasons.push(`Price is ${Math.abs(diff).toFixed(1)}% ${diff >= 0 ? 'above' : 'below'} its 20-day average (${diff >= 0 ? 'bullish' : 'bearish'}).`)
  }
  if (sma50 !== null) {
    const diff = ((price - sma50) / sma50) * 100
    score += diff >= 0 ? 10 : -10
    reasons.push(`Price is ${Math.abs(diff).toFixed(1)}% ${diff >= 0 ? 'above' : 'below'} its 50-day average.`)
  }
  if (sma20 !== null && sma50 !== null) {
    score += sma20 >= sma50 ? 10 : -10
    reasons.push(sma20 >= sma50 ? 'Short-term trend is above the long-term trend.' : 'Short-term trend is below the long-term trend.')
  }
  if (rsi14 !== null) {
    if (rsi14 > 70) { score -= 10; reasons.push(`RSI is ${rsi14.toFixed(0)} (overbought).`) }
    else if (rsi14 < 30) { score += 10; reasons.push(`RSI is ${rsi14.toFixed(0)} (oversold, potential rebound).`) }
    else { score += rsi14 >= 50 ? 5 : -5; reasons.push(`RSI is ${rsi14.toFixed(0)} (${rsi14 >= 50 ? 'positive' : 'negative'} momentum).`) }
  }
  if (rangePercent >= 80) { score += 10; reasons.push(`Trading near its 52-week high (${rangePercent.toFixed(0)}% of range).`) }
  else if (rangePercent <= 20) { score -= 10; reasons.push(`Trading near its 52-week low (${rangePercent.toFixed(0)}% of range).`) }

  score = Math.max(-100, Math.min(100, score))
  const label = score >= 30 ? 'Bullish' : score <= -30 ? 'Bearish' : 'Neutral'

  return { symbol, name, price, currency, sma20, sma50, rsi14, week52Low, week52High, rangePercent, score, label, reasons }
}

export async function stocksAnalysis(request: HttpRequest): Promise<HttpResponseInit> {
  const symbols = (request.query.get('symbols') ?? '')
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => SYMBOL.test(symbol))

  const results = await Promise.all(symbols.map(async (symbol) => {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout))
      if (!response.ok) return { symbol, error: `Provider returned ${response.status}` }
      const body = await response.json() as {
        chart?: { result?: Array<{ meta?: Record<string, unknown>; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> }
      }
      const result = body.chart?.result?.[0]
      const meta = result?.meta
      const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter((value): value is number => typeof value === 'number')
      if (!meta?.regularMarketPrice) return { symbol, error: 'No quote available' }
      return analyze(symbol, (meta.shortName as string) ?? symbol, meta.regularMarketPrice as number, (meta.currency as string) ?? 'USD', closes)
    } catch {
      return { symbol, error: 'Request failed or timed out' }
    }
  }))

  return { status: 200, jsonBody: { results } }
}

app.http('stocksAnalysis', {
  route: 'stocks/analysis',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: stocksAnalysis,
})
