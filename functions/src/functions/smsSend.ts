import { app, HttpRequest, HttpResponseInit } from '@azure/functions'
import { SmsClient } from '@azure/communication-sms'

const E164 = /^\+[1-9]\d{7,14}$/

// Requires a shared client key (not the ACS key) since this is the one endpoint with real cost/abuse potential:
// unlike the read-only endpoints, an unauthenticated caller could otherwise send SMS at this account's expense.
export async function smsSend(request: HttpRequest): Promise<HttpResponseInit> {
  const requiredKey = process.env.WOLFMAN_API_KEY
  if (requiredKey && request.headers.get('x-wolfman-key') !== requiredKey) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } }
  }

  const connectionString = process.env.ACS_SMS_CONNECTION_STRING
  const from = process.env.ACS_SMS_FROM_NUMBER
  if (!connectionString || !from) return { status: 503, jsonBody: { error: 'SMS relay is not configured on this server' } }

  let body: { to?: unknown; body?: unknown }
  try {
    body = await request.json() as typeof body
  } catch {
    return { status: 400, jsonBody: { error: 'Malformed request body' } }
  }

  const to = typeof body.to === 'string' ? body.to : ''
  const message = typeof body.body === 'string' ? body.body : ''
  if (!E164.test(to) || !message.trim()) return { status: 400, jsonBody: { error: 'A valid destination number and message body are required' } }

  try {
    const client = new SmsClient(connectionString)
    const [result] = await client.send({ from, to: [to], message })
    if (!result.successful) return { status: 502, jsonBody: { error: result.errorMessage ?? 'Provider rejected the message' } }
    return { status: 200, jsonBody: { messageId: result.messageId } }
  } catch {
    return { status: 502, jsonBody: { error: 'SMS provider request failed' } }
  }
}

app.http('smsSend', {
  route: 'messages/sms/send',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: smsSend,
})
