import { apiUrl } from './apiClient'

function getCurrentPosition(): Promise<GeolocationPosition | null> {
  if (!('geolocation' in navigator)) return Promise.resolve(null)
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      () => resolve(null),
      { timeout: 5000, maximumAge: 5 * 60 * 1000 },
    )
  })
}

type Place = { name: string; phone: string | null; address: string | null }

async function searchPlaces(query: string) {
  const position = await getCurrentPosition()
  const params = new URLSearchParams({ query })
  if (position) {
    params.set('lat', String(position.coords.latitude))
    params.set('lon', String(position.coords.longitude))
  }
  let response: Response
  try {
    response = await fetch(apiUrl(`/api/places/search?${params}`))
  } catch {
    return 'Local business search is unavailable. This feature requires the local development proxy or a deployed places-search endpoint.'
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    return `Local business search failed: ${detail?.error ?? `HTTP ${response.status}`}.`
  }
  const { places } = (await response.json()) as { places: Place[] }
  if (!places.length) return `No results found for "${query}".`
  const locationNote = position ? '' : ' (location permission was not granted, so results are not distance-sorted)'
  const rows = places.map((place) => {
    const details = [place.address, place.phone].filter(Boolean).join(' · ')
    return `- **${place.name}**${details ? `: ${details}` : ''}`
  })
  return `**Results for "${query}"${locationNote}**\n\n${rows.join('\n')}`
}

async function searchWeb(query: string) {
  let response: Response
  try {
    response = await fetch(apiUrl(`/api/web/search?q=${encodeURIComponent(query)}`))
  } catch {
    return 'Web search is unavailable. This feature requires the local development proxy or a deployed search endpoint.'
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { error?: string } | null
    return `Web search failed: ${detail?.error ?? `HTTP ${response.status}`}.`
  }
  const body = (await response.json()) as {
    heading: string | null; summary: string | null; url: string | null
    related: Array<{ text?: string; url?: string }>
  }
  if (!body.summary && !body.related.length) return `No summary result found for "${query}". Try a more specific phrase, or provide a direct URL.`
  const parts: string[] = []
  if (body.summary) parts.push(`**${body.heading ?? query}**\n\n${body.summary}${body.url ? ` ([source](${body.url}))` : ''}`)
  if (body.related.length) parts.push(`**Related**\n\n${body.related.map((item) => `- ${item.url ? `[${item.text}](${item.url})` : item.text}`).join('\n')}`)
  return parts.join('\n\n')
}

const PLACE_PATTERN = /\bnear me\b|\bnearby\b|\bphone number (?:for|to)\b|\blocal\b.*\b(store|shop|restaurant|costco|target|walmart|pharmacy)\b/i

export function extractPlaceQuery(input: string) {
  return input
    .replace(/^(?:what'?s|find|where(?:'?s| is)?|get me)\s+/i, '')
    .replace(/\bphone number (?:for|to|of)\s+(?:the\s+)?/i, '')
    .replace(/\b(?:the\s+)?(?:closest|nearest|nearby)\s+/i, '')
    .replace(/\blocal\s+/i, '')
    .replace(/\bnear me\b/i, '')
    .replace(/[?.!]+$/, '')
    .trim() || input
}
const OPEN_QUESTION_PATTERN = /\bwhere can i find\b|\bwhat is\b|\bwho is\b|\bwhen (?:is|does|did)\b|\bhow (?:do|to|far|many|much)\b|\bsearch for\b/i

export async function answerInternetRequest(input: string) {
  if (PLACE_PATTERN.test(input)) return searchPlaces(extractPlaceQuery(input))
  if (OPEN_QUESTION_PATTERN.test(input)) return searchWeb(input)
  return null
}
