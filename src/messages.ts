import { smsProvider } from './wolfman-core/providers/messages/AcsSmsMessageProvider'
import { confirmAction, cancelAction } from './wolfman-core/services/ConfirmationService'
import { recordAudit } from './wolfman-core/services/AuditService'

const SEND_TEXT = /\b(?:text|message|sms)\s+(\+\d{8,15})\s*(?:saying|that says|:)?\s*(.+)/i

let pendingToken: string | null = null
let pendingTarget: string | null = null

export async function answerMessageRequest(input: string) {
  const normalized = input.trim().toLowerCase()
  if (pendingToken && (normalized === 'confirm' || normalized === 'yes')) {
    const token = pendingToken
    pendingToken = null
    pendingTarget = null
    return confirmAction(token)
  }
  if (pendingToken && (normalized === 'cancel' || normalized === 'no')) {
    cancelAction(pendingToken)
    recordAudit({ action: 'send-sms', target: pendingTarget ?? 'unknown', outcome: 'cancelled' })
    pendingToken = null
    pendingTarget = null
    return 'Cancelled. Nothing was sent.'
  }

  const match = input.match(SEND_TEXT)
  if (!match) return null
  const [, to, body] = match
  try {
    const { token, summary, expiresInSeconds } = smsProvider.prepareSend(to, body.trim())
    pendingToken = token
    pendingTarget = to
    return `**Confirm before sending**\n\n${summary}\n\nReply **confirm** to send, or **cancel**. This expires in ${expiresInSeconds} seconds.`
  } catch (error) {
    return error instanceof Error ? error.message : 'Could not prepare that message.'
  }
}
