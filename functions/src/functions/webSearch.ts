import { app, HttpRequest, HttpResponseInit } from '@azure/functions'

export async function webSearch(request: HttpRequest): Promise<HttpResponseInit> {
  const query = request.query.get('q')?.trim()
  if (!query) return { status: 400, jsonBody: { error: 'A search query is required' } }
  const params = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' })
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6000)
    const response = await fetch(`https://api.duckduckgo.com/?${params}`, { signal: controller.signal }).finally(() => clearTimeout(timeout))
    if (!response.ok) return { status: 502, jsonBody: { error: `Search provider returned ${response.status}` } }
    const body = await response.json() as {
      AbstractText?: string; AbstractURL?: string; Heading?: string
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>
    }
    return {
      status: 200,
      jsonBody: {
        heading: body.Heading || null,
        summary: body.AbstractText || null,
        url: body.AbstractURL || null,
        related: (body.RelatedTopics ?? []).filter((topic) => topic.Text).slice(0, 5).map((topic) => ({ text: topic.Text, url: topic.FirstURL })),
      },
    }
  } catch {
    return { status: 502, jsonBody: { error: 'Search request failed or timed out' } }
  }
}

app.http('webSearch', {
  route: 'web/search',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: webSearch,
})
