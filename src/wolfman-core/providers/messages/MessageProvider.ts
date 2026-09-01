export type MessageChannel = 'sms' | 'teams'

export type MessageProvider = {
  channel: MessageChannel
  // Presents exactly what will be sent and returns a confirmation token; no side effect happens yet.
  prepareSend(to: string, body: string): { token: string; summary: string; expiresInSeconds: number }
}
