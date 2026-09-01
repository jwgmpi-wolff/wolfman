import { app, HttpRequest, HttpResponseInit } from '@azure/functions'

export async function placesSearch(request: HttpRequest): Promise<HttpResponseInit> {
  const key = process.env.AZURE_MAPS_KEY
  if (!key) return { status: 503, jsonBody: { error: 'Places search is not configured on this server' } }

  const query = request.query.get('query')?.trim()
  const lat = request.query.get('lat')
  const lon = request.query.get('lon')
  if (!query) return { status: 400, jsonBody: { error: 'A search query is required' } }

  const params = new URLSearchParams({ 'api-version': '1.0', 'subscription-key': key, query, limit: '5' })
  if (lat && lon) { params.set('lat', lat); params.set('lon', lon); params.set('radius', '16000') }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6000)
    const response = await fetch(`https://atlas.microsoft.com/search/fuzzy/json?${params}`, { signal: controller.signal }).finally(() => clearTimeout(timeout))
    if (!response.ok) return { status: 502, jsonBody: { error: `Places provider returned ${response.status}` } }
    const body = await response.json() as { results?: Array<{ poi?: { name?: string; phone?: string }; address?: { freeformAddress?: string } }> }
    const places = (body.results ?? []).map((result) => ({
      name: result.poi?.name ?? 'Unknown',
      phone: result.poi?.phone ?? null,
      address: result.address?.freeformAddress ?? null,
    }))
    return { status: 200, jsonBody: { places } }
  } catch {
    return { status: 502, jsonBody: { error: 'Places request failed or timed out' } }
  }
}

app.http('placesSearch', {
  route: 'places/search',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: placesSearch,
})
