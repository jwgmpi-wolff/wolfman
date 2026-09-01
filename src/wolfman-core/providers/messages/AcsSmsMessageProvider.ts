import { requestConfirmation } from '../../services/ConfirmationService'
import { recordAudit } from '../../services/AuditService'
import { apiUrl, apiKeyHeader } from '../../../apiClient'
import type { MessageProvider } from './MessageProvider'

const E164 = /^\+[1-9]\d{7,14}$/

export const smsProvider: MessageProvider = {
  channel: 'sms',
  prepareSend(to, body) {
    if (!E164.test(to)) throw new Error('Provide the destination phone number in +countrycode format, e.g. +15551234567.')
    if (!body.trim()) throw new Error('What should the message say?')
    return requestConfirmation(`Send SMS to ${to}: "${body}"`, () => sendSms(to, body))
  },
}

async function sendSms(to: string, body: string) {
  let response: Response
  try {
    response = await fetch(apiUrl('/api/messages/sms/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiKeyHeader },
      body: JSON.stringify({ to, body }),
    })
  } catch {
    recordAudit({ action: 'send-sms', target: to, outcome: 'failed' })
    return 'The SMS relay is unavailable. This requires the local development proxy or a deployed relay endpoint.'
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    recordAudit({ action: 'send-sms', target: to, outcome: 'failed' })
    return `Sending failed: ${detail?.error ?? `HTTP ${response.status}`}.`
  }
  recordAudit({ action: 'send-sms', target: to, outcome: 'sent' })
  return `Sent. Confirmed delivery request to ${to}.`
}
