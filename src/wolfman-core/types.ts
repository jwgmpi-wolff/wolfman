export type Source = 'local' | 'microsoft-mail' | 'microsoft-chat' | 'microsoft-files' | 'sms' | 'market-data' | 'web'

export type ToolResult<T> =
  | { ok: true; source: Source; retrievedAt: string; data: T }
  | { ok: false; source: Source; retrievedAt: string; error: ProviderError }

export type ProviderError = {
  status: number
  publicMessage: string
  code?: 'unauthorized' | 'rate-limited' | 'unavailable' | 'not-found' | 'invalid-request' | 'timeout'
}

export function success<T>(source: Source, data: T): ToolResult<T> {
  return { ok: true, source, retrievedAt: new Date().toISOString(), data }
}

export function failure<T>(source: Source, error: ProviderError): ToolResult<T> {
  return { ok: false, source, retrievedAt: new Date().toISOString(), error }
}
