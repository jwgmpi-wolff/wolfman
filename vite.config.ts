import type { IncomingMessage, ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { SmsClient } from '@azure/communication-sms'

const projectRoot = process.cwd().replaceAll('\\', '/')

const SYMBOL = /^[A-Z0-9.-]{1,10}$/
const E164 = /^\+[1-9]\d{7,14}$/

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (error) { reject(error) } })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(value))
}

// Dev-only same-origin relay for Azure Maps place/business search (phone, address, hours). The subscription key
// is server-side only (no VITE_ prefix) and is read here from process.env, not the browser.
function placesSearchProxy(): Plugin {
  return {
    name: 'wolfman-places-search-proxy',
    configureServer(server) {
      server.middlewares.use('/api/places/search', async (req: IncomingMessage, res: ServerResponse) => {
        const key = process.env.AZURE_MAPS_KEY
        if (!key) return sendJson(res, 503, { error: 'Places search is not configured on this server' })
        const url = new URL(req.url ?? '', 'http://localhost')
        const query = url.searchParams.get('query')?.trim()
        const lat = url.searchParams.get('lat')
        const lon = url.searchParams.get('lon')
        if (!query) return sendJson(res, 400, { error: 'A search query is required' })
        const params = new URLSearchParams({ 'api-version': '1.0', 'subscription-key': key, query, limit: '5' })
        if (lat && lon) { params.set('lat', lat); params.set('lon', lon); params.set('radius', '16000') }
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 6000)
          const response = await fetch(`https://atlas.microsoft.com/search/fuzzy/json?${params}`, { signal: controller.signal }).finally(() => clearTimeout(timeout))
          if (!response.ok) return sendJson(res, 502, { error: `Places provider returned ${response.status}` })
          const body = await response.json() as { results?: Array<{ poi?: { name?: string; phone?: string }; address?: { freeformAddress?: string } }> }
          const places = (body.results ?? []).map((result) => ({
            name: result.poi?.name ?? 'Unknown',
            phone: result.poi?.phone ?? null,
            address: result.address?.freeformAddress ?? null,
          }))
          sendJson(res, 200, { places })
        } catch {
          sendJson(res, 502, { error: 'Places request failed or timed out' })
        }
      })
    },
  }
}

// Dev-only same-origin relay for DuckDuckGo's public Instant Answer API (keyless, official endpoint, not scraping).
function webSearchProxy(): Plugin {
  return {
    name: 'wolfman-web-search-proxy',
    configureServer(server) {
      server.middlewares.use('/api/web/search', async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        const query = url.searchParams.get('q')?.trim()
        if (!query) return sendJson(res, 400, { error: 'A search query is required' })
        const params = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' })
        try {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 6000)
          const response = await fetch(`https://api.duckduckgo.com/?${params}`, { signal: controller.signal }).finally(() => clearTimeout(timeout))
          if (!response.ok) return sendJson(res, 502, { error: `Search provider returned ${response.status}` })
          const body = await response.json() as {
            AbstractText?: string; AbstractURL?: string; Heading?: string
            RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
          }
          sendJson(res, 200, {
            heading: body.Heading || null,
            summary: body.AbstractText || null,
            url: body.AbstractURL || null,
            related: (body.RelatedTopics ?? []).filter((topic) => topic.Text).slice(0, 5).map((topic) => ({ text: topic.Text, url: topic.FirstURL })),
          })
        } catch {
          sendJson(res, 502, { error: 'Search request failed or timed out' })
        }
      })
    },
  }
}

// Dev-only same-origin relay for Azure Communication Services SMS: the connection string is server-side only
// (no VITE_ prefix, so Vite never bundles it into client JS) and is read here from process.env, not the browser.
function smsSendProxy(): Plugin {
  return {
    name: 'wolfman-sms-send-proxy',
    configureServer(server) {
      server.middlewares.use('/api/messages/sms/send', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') return sendJson(res, 404, { error: 'Not found' })
        const connectionString = process.env.ACS_SMS_CONNECTION_STRING
        const from = process.env.ACS_SMS_FROM_NUMBER
        if (!connectionString || !from) return sendJson(res, 503, { error: 'SMS relay is not configured on this server' })
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { error: 'Malformed request body' })
        }
        const to = typeof body.to === 'string' ? body.to : ''
        const message = typeof body.body === 'string' ? body.body : ''
        if (!E164.test(to) || !message.trim()) return sendJson(res, 400, { error: 'A valid destination number and message body are required' })
        try {
          const client = new SmsClient(connectionString)
          const [result] = await client.send({ from, to: [to], message })
          if (!result.successful) return sendJson(res, 502, { error: result.errorMessage ?? 'Provider rejected the message' })
          sendJson(res, 200, { messageId: result.messageId })
        } catch {
          sendJson(res, 502, { error: 'SMS provider request failed' })
        }
      })
    },
  }
}

// Dev-only same-origin relay for Yahoo Finance quotes: browsers cannot call it directly (no CORS header),
// but a same-process server-side fetch is not subject to that restriction. Not available in the static build.
function stockQuoteProxy(): Plugin {
  return {
    name: 'wolfman-stock-quote-proxy',
    configureServer(server) {
      server.middlewares.use('/api/stocks/quote', async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        const symbols = (url.searchParams.get('symbols') ?? '')
          .split(',')
          .map((symbol) => symbol.trim().toUpperCase())
          .filter((symbol) => SYMBOL.test(symbol))
        const quotes = await Promise.all(symbols.map(async (symbol) => {
          try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: controller.signal,
            }).finally(() => clearTimeout(timeout))
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
          }
        }))
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ quotes }))
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // loadEnv with an empty prefix reads every var in .env.local, including server-side-only ones
  // (no VITE_ prefix) that Vite would otherwise never populate onto process.env for this config file.
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['ACS_SMS_CONNECTION_STRING', 'ACS_SMS_FROM_NUMBER', 'AZURE_MAPS_KEY']) {
    if (env[key]) process.env[key] = env[key]
  }

  return {
    base: process.env.VITE_BASE_PATH || '/',
    server: {
      fs: {
        deny: [
          '.env',
          '.env.*',
          '*.{crt,pem,key,p12,pfx,cer,der}',
          '.npmrc',
          '.yarnrc.yml',
          `${projectRoot}/.git/**`,
        ],
      },
    },
    plugins: [
      react(),
    stockQuoteProxy(),
    smsSendProxy(),
    placesSearchProxy(),
    webSearchProxy(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['wolfman-icon.svg'],
      manifest: {
        name: 'Wolfman Financial & Personal Assistant',
        short_name: 'Wolfman',
        description: 'A private, analytical command center for money, goals, tasks, and habits.',
        theme_color: '#244d39',
        background_color: '#f1f3ee',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'wolfman-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'wolfman-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  }
})
