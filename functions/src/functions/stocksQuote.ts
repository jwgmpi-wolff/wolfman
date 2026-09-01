import { app, HttpRequest, HttpResponseInit } from '@azure/functions'

const SYMBOL = /^[A-Z0-9.-]{1,10}$/

async function fetchQuote(symbol: string) {
  const finnhubKey = process.env.FINNHUB_API_KEY
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    if (finnhubKey) {
      const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${finnhubKey}`, { signal: controller.signal })
      if (!response.ok) return { symbol, error: `Provider returned ${response.status}` }
      const body = await response.json() as { c?: number; pc?: number; dp?: number; t?: number }
      if (!body.c) return { symbol, error: 'No quote available' }
      return {
        symbol,
        name: symbol,
        price: body.c,
        previousClose: body.pc,
        changePercent: body.dp ?? null,
        currency: 'USD',
        asOf: body.t ? new Date(body.t * 1000).toISOString() : null,
      }
    }
    const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    })
    if (!response.ok) return { symbol, error: `Provider returned ${response.status}` }
    const body = await response.json() as { chart?: { result?: Array<{ meta?: Record<string, unknown> }> } }
    const meta = body.chart?.result?.[0]?.meta
    if (!meta?.regularMarketPrice) return { symbol, error: 'No quote available' }
    return {
      symbol,
      name: meta.shortName ?? symbol,
      price: meta.regularMarketPrice,
      previousClose: meta.previousClose ?? meta.chartPreviousClose,
      changePercent: meta.regularMarketChangePercent ?? null,
      currency: meta.currency ?? 'USD',
      asOf: meta.regularMarketTime ? new Date((meta.regularMarketTime as number) * 1000).toISOString() : null,
    }
  } catch {
    return { symbol, error: 'Request failed or timed out' }
  } finally {
    clearTimeout(timeout)
  }
}

export async function stocksQuote(request: HttpRequest): Promise<HttpResponseInit> {
  const symbols = (request.query.get('symbols') ?? '')
    .split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => SYMBOL.test(symbol))

  const quotes = await Promise.all(symbols.map(fetchQuote))

  return { status: 200, jsonBody: { quotes } }
}

app.http('stocksQuote', {
  route: 'stocks/quote',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: stocksQuote,
})

