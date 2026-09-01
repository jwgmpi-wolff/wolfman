// Empty base means same-origin (the local Vite dev proxy). A deployed app (static PWA,
// Capacitor, Electron) has no such proxy and must call the real cloud backend instead.
const base = import.meta.env.VITE_API_BASE_URL ?? ''

export function apiUrl(path: string) {
  return `${base}${path}`
}

export const apiKeyHeader: Record<string, string> = import.meta.env.VITE_WOLFMAN_API_KEY
  ? { 'x-wolfman-key': import.meta.env.VITE_WOLFMAN_API_KEY }
  : {}
