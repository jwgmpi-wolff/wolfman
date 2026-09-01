import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { requestConfirmation, confirmAction, cancelAction } from './ConfirmationService'

describe('ConfirmationService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs the action exactly once when confirmed', async () => {
    const run = vi.fn(async () => 'done')
    const { token } = requestConfirmation('do the thing', run)
    const result = await confirmAction(token)
    expect(result).toBe('done')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('cannot be replayed after being confirmed once', async () => {
    const run = vi.fn(async () => 'done')
    const { token } = requestConfirmation('do the thing', run)
    await confirmAction(token)
    const second = await confirmAction(token)
    expect(second).toMatch(/expired or was already used/i)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('expires after its TTL and cannot be confirmed', async () => {
    const run = vi.fn(async () => 'done')
    const { token, expiresInSeconds } = requestConfirmation('do the thing', run)
    vi.advanceTimersByTime((expiresInSeconds + 1) * 1000)
    const result = await confirmAction(token)
    expect(result).toMatch(/expired or was already used/i)
    expect(run).not.toHaveBeenCalled()
  })

  it('cancel prevents the action from ever running', async () => {
    const run = vi.fn(async () => 'done')
    const { token } = requestConfirmation('do the thing', run)
    expect(cancelAction(token)).toBe(true)
    const result = await confirmAction(token)
    expect(result).toMatch(/expired or was already used/i)
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects an unknown token without running anything', async () => {
    const result = await confirmAction('not-a-real-token')
    expect(result).toMatch(/expired or was already used/i)
  })
})
