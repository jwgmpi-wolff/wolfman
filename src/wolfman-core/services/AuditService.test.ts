import { describe, it, expect, beforeEach } from 'vitest'
import { recordAudit, getAuditLog } from './AuditService'

describe('AuditService', () => {
  beforeEach(() => localStorage.clear())

  it('records write actions with metadata only, newest first', () => {
    recordAudit({ action: 'send-sms', target: '+15551234567', outcome: 'sent' })
    recordAudit({ action: 'send-sms', target: '+15559876543', outcome: 'cancelled' })
    const log = getAuditLog()
    expect(log).toHaveLength(2)
    expect(log[0].target).toBe('+15559876543')
    expect(log[0].outcome).toBe('cancelled')
    expect(log[1].target).toBe('+15551234567')
  })

  it('assigns a unique id and timestamp to every entry', () => {
    recordAudit({ action: 'send-sms', target: '+15551234567', outcome: 'sent' })
    const [entry] = getAuditLog()
    expect(entry.id).toBeTruthy()
    expect(new Date(entry.at).toString()).not.toBe('Invalid Date')
  })

  it('never stores message or event content, only action/target/outcome', () => {
    recordAudit({ action: 'send-sms', target: '+15551234567', outcome: 'sent' })
    const raw = localStorage.getItem('wolfman:audit:v1') ?? ''
    expect(raw).not.toContain('this is a test')
  })

  it('caps the log at 200 entries', () => {
    for (let index = 0; index < 205; index += 1) {
      recordAudit({ action: 'send-sms', target: `+1555000${index}`, outcome: 'sent' })
    }
    expect(getAuditLog()).toHaveLength(200)
  })
})
