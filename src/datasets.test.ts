import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WolfmanData } from './domain'
import { answerDatasetRequest, extractStockSymbols } from './datasets'

const data = {
  monthlyIncome: 0,
  hourlyWage: 0,
  transactions: [],
  budgets: [],
  goals: [],
  tasks: [],
  habits: [],
  datasets: [{
    id: 'portfolio',
    name: 'Portfolio',
    importedAt: '2026-09-01T00:00:00.000Z',
    columns: ['Symbol', 'Value'],
    rows: ['MSFT', 'AAPL', 'NVDA', 'GOOG', 'AMZN'].map((Symbol, index) => ({ Symbol, Value: String(index + 1) })),
  }],
} satisfies WolfmanData

afterEach(() => vi.unstubAllGlobals())

describe('imported stock analysis', () => {
  it('extracts every unique symbol from the imported dataset', () => {
    expect(extractStockSymbols(data.datasets[0])).toEqual(['MSFT', 'AAPL', 'NVDA', 'GOOG', 'AMZN'])
  })

  it('sends all imported symbols to real stock analysis', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      results: data.datasets[0].rows.map(({ Symbol }) => ({ symbol: Symbol, error: 'Test quote unavailable' })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await answerDatasetRequest('Check my imported csv file and analyze for best strategy based on what I have', data)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0][0])).toContain('MSFT%2CAAPL%2CNVDA%2CGOOG%2CAMZN')
    expect(response).toContain('Unique imported ticker symbols analyzed: 5')
    for (const symbol of ['MSFT', 'AAPL', 'NVDA', 'GOOG', 'AMZN']) expect(response).toContain(symbol)
  })
})