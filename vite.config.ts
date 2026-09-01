import type { IncomingMessage, ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const projectRoot = process.cwd().replaceAll('\\', '/')

const SYMBOL = /^[A-Z0-9.-]{1,10}$/

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

export default defineConfig({
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
})
