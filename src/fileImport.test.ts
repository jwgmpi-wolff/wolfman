import { describe, expect, it } from 'vitest'
import { analyzeDataset, parseImportFile } from './fileImport'

describe('parseImportFile', () => {
  it('imports an arbitrary CSV as a dataset', async () => {
    const file = new File([
      'Symbol,Value,Quantity,Range\nMSFT,"$1,200.50",2,100 - 120\nAAPL,$300.25,1,40 - 50',
    ], 'positions.csv', { type: 'text/csv' })

    const result = await parseImportFile(file)

    expect(result.kind).toBe('dataset')
    if (result.kind !== 'dataset') return
    expect(result.dataset.name).toBe('positions')
    expect(result.dataset.rows).toHaveLength(2)
  })

  it('rejects JSON arrays containing scalar rows', async () => {
    const file = new File(['[1, 2, 3]'], 'values.json', { type: 'application/json' })

    await expect(parseImportFile(file)).rejects.toThrow('array of objects')
  })
})

describe('analyzeDataset', () => {
  it('sums currency and quantity fields without treating ranges as numeric', () => {
    const result = analyzeDataset({
      id: 'positions',
      name: 'Positions',
      importedAt: '2026-09-01T00:00:00.000Z',
      columns: ['Symbol', 'Value', 'Quantity', 'Range'],
      rows: [
        { Symbol: 'MSFT', Value: '$1,200.50', Quantity: '2', Range: '100 - 120' },
        { Symbol: 'AAPL', Value: '$300.25', Quantity: '1', Range: '40 - 50' },
      ],
    })

    expect(result.identifierColumn).toBe('Symbol')
    expect(result.numericColumns).toEqual(['Value', 'Quantity'])
    expect(result.totals).toEqual([
      { column: 'Value', sum: 1500.75, average: 750.375, count: 2 },
      { column: 'Quantity', sum: 3, average: 1.5, count: 2 },
    ])
  })
})