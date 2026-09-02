/**
 * WOLFMAN — Azure OpenAI cloud provider.
 *
 * Only exists when AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_DEPLOYMENT are set on
 * this host (the hosted Azure daemon). Authenticates with the App Service's
 * own system-assigned managed identity via the platform's IDENTITY_ENDPOINT
 * metadata service — no client secret, no SDK, just a real Entra ID token
 * fetched over HTTP and a real chat-completions call. Same contract as every
 * other provider: `invoke` streams a live generation or throws; it never
 * returns cached or fabricated text. Router/mode gating (privacyTier: 'cloud')
 * still decides whether this provider is ever eligible for a given request.
 */
import type { Chunk, DeviceRef, ProbeResult, Provider, ProviderDescriptor, WolfRequest } from '@wolfman/protocol';

const API_VERSION = '2024-08-01-preview';

interface MsiTokenResponse {
  access_token: string;
}

async function getManagedIdentityToken(): Promise<string> {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) throw new Error('no managed identity available on this host');
  const url = `${endpoint}?resource=${encodeURIComponent('https://cognitiveservices.azure.com')}&api-version=2019-08-01`;
  const res = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } });
  if (!res.ok) throw new Error(`managed identity token request failed: HTTP ${res.status}`);
  const body = (await res.json()) as MsiTokenResponse;
  return body.access_token;
}

export class AzureOpenAIProvider implements Provider {
  descriptor: ProviderDescriptor;
  private endpoint: string;
  private deployment: string;

  constructor(device: DeviceRef) {
    this.endpoint = (process.env.AZURE_OPENAI_ENDPOINT ?? '').replace(/\/$/, '');
    this.deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? '';
    this.descriptor = {
      id: `azure-openai@${this.deployment || 'unconfigured'}`,
      displayName: `Azure OpenAI (${this.deployment})`,
      device,
      transport: 'openai-compatible',
      privacyTier: 'cloud',
      modalities: ['text'],
      costClass: 'metered-cloud',
      pinned: false,
      lastProbe: null,
    };
  }

  static isConfigured(): boolean {
    return Boolean(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_DEPLOYMENT);
  }

  private chatUrl(): string {
    return `${this.endpoint}/openai/deployments/${this.deployment}/chat/completions?api-version=${API_VERSION}`;
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    const startedAt = Date.now();
    try {
      const token = await getManagedIdentityToken();
      const res = await fetch(this.chatUrl(), {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      });
      if (!res.ok) {
        return failedProbe(startedAt, `HTTP_${res.status}`, await res.text());
      }
      return {
        status: 'available',
        probedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        models: [{ id: this.deployment, contextWindow: null, modalities: ['text'] }],
        supportsStreaming: false,
        toolCount: 0,
      };
    } catch (e: any) {
      return failedProbe(startedAt, 'PROBE_FAILED', String(e?.message ?? e));
    }
  }

  /**
   * Gives the model real tools instead of letting it guess: current-events
   * questions get routed to a live web search or stock quote, and the model
   * only answers directly once it has actually called one (or decided it
   * doesn't need to). Never invents data no tool actually returned.
   */
  async *invoke(req: WolfRequest, signal: AbortSignal): AsyncIterable<Chunk> {
    const messages: any[] = [
      {
        role: 'system',
        content:
          'You have no knowledge of anything after your training cutoff and no memory of real-time ' +
          'data. For current events, prices, scores, weather, or anything that changes over time, you ' +
          'MUST call web_search or get_stock_quote and answer only from what the tool actually returns. ' +
          'If the tool fails or returns nothing useful, say plainly that you could not find a live answer ' +
          '\u2014 never guess or make up a number, date, or fact.',
      },
      { role: 'user', content: req.text },
    ];

    for (let round = 0; round < 2; round++) {
      const token = await getManagedIdentityToken();
      const res = await fetch(this.chatUrl(), {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, tools: TOOLS, tool_choice: 'auto', stream: false }),
      });
      if (!res.ok) {
        yield { type: 'error', code: `HTTP_${res.status}`, message: await res.text() };
        return;
      }
      const json: any = await res.json();
      const message = json?.choices?.[0]?.message;
      const toolCalls: any[] | undefined = message?.tool_calls;

      if (toolCalls?.length && round === 0) {
        messages.push(message);
        for (const call of toolCalls) {
          const args = safeParseArgs(call.function?.arguments);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: await runTool(call.function?.name, args),
          });
        }
        continue;
      }

      const text = message?.content;
      if (!text) {
        yield { type: 'error', code: 'EMPTY_RESPONSE', message: 'Azure OpenAI returned no content' };
        return;
      }
      yield { type: 'delta', text };
      yield { type: 'done' };
      return;
    }
  }
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Live web search for current information (news, facts, prices, anything time-sensitive).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_quote',
      description: 'Live latest close price for a stock ticker symbol, e.g. MSFT, AAPL.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'Ticker symbol, e.g. MSFT' } },
        required: ['symbol'],
      },
    },
  },
];

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function runTool(name: string | undefined, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === 'get_stock_quote') return await getStockQuote(String(args.symbol ?? ''));
    if (name === 'web_search') return await webSearch(String(args.query ?? ''));
    return `no such tool: ${name}`;
  } catch (e: any) {
    return `tool error: ${e?.message ?? e}`;
  }
}

/** Real live web search \u2014 DuckDuckGo's HTML result page, not the weak Instant-Answer API. */
async function webSearch(query: string): Promise<string> {
  if (!query.trim()) throw new Error('empty search query');
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WolfmanBot/1.0; +https://wolfman-mcp.azurewebsites.net)' },
  });
  if (!res.ok) throw new Error(`web search HTTP ${res.status}`);
  const html = await res.text();
  const re = /class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < 4) {
    results.push(`${stripHtml(m[1])}: ${stripHtml(m[2])}`);
  }
  if (results.length === 0) throw new Error('no live web results for this query');
  return results.join('\n');
}

/** Real live quote, no key required \u2014 delayed-but-real end-of-day data from Stooq. */
async function getStockQuote(symbol: string): Promise<string> {
  const clean = symbol.trim();
  if (!clean) throw new Error('empty ticker symbol');
  const res = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(clean.toLowerCase())}.us&f=sd2t2c&h&e=csv`);
  if (!res.ok) throw new Error(`stock quote HTTP ${res.status}`);
  const rows = (await res.text()).trim().split('\n');
  const fields = rows[1]?.split(',');
  const [, date, time, close] = fields ?? [];
  if (!close || close === 'N/D') throw new Error(`no live quote available for ${clean.toUpperCase()}`);
  return `${clean.toUpperCase()} last close: $${close} on ${date} at ${time} UTC (live, Stooq).`;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function failedProbe(startedAt: number, code: string, message: string): ProbeResult {
  return {
    status: 'unavailable',
    probedAt: new Date().toISOString(),
    latencyMs: Date.now() - startedAt,
    models: [],
    supportsStreaming: false,
    toolCount: 0,
    failure: { code, message },
  };
}
