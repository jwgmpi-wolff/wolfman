export type AuditEntry = {
  id: string
  at: string
  action: string
  target: string
  outcome: 'confirmed' | 'sent' | 'failed' | 'cancelled'
}

const STORAGE_KEY = 'wolfman:audit:v1'
const MAX_ENTRIES = 200

function readEntries(): AuditEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as AuditEntry[]
  } catch {
    return []
  }
}

// Records only the action/target metadata for write operations, never message or event content.
export function recordAudit(entry: Omit<AuditEntry, 'id' | 'at'>) {
  const entries = [{ ...entry, id: crypto.randomUUID(), at: new Date().toISOString() }, ...readEntries()].slice(0, MAX_ENTRIES)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
}

export function getAuditLog(): AuditEntry[] {
  return readEntries()
}
