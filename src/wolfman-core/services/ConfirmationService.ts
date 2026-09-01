type PendingAction = {
  summary: string
  expiresAt: number
  run: () => Promise<string>
}

const TOKEN_TTL_MS = 2 * 60 * 1000
const pending = new Map<string, PendingAction>()

function sweepExpired() {
  const now = Date.now()
  for (const [token, action] of pending) if (action.expiresAt <= now) pending.delete(token)
}

// Registers a write action and returns a short-lived, single-use confirmation token plus the summary to show the user.
export function requestConfirmation(summary: string, run: () => Promise<string>) {
  sweepExpired()
  const token = crypto.randomUUID()
  pending.set(token, { summary, expiresAt: Date.now() + TOKEN_TTL_MS, run })
  return { token, summary, expiresInSeconds: TOKEN_TTL_MS / 1000 }
}

// Consumes the token exactly once; a missing or expired token cannot be replayed.
export async function confirmAction(token: string): Promise<string> {
  sweepExpired()
  const action = pending.get(token)
  pending.delete(token)
  if (!action) return 'This confirmation has expired or was already used. Ask again to get a new one.'
  return action.run()
}

export function cancelAction(token: string) {
  return pending.delete(token)
}
