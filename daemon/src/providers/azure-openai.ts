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

  async *invoke(req: WolfRequest, signal: AbortSignal): AsyncIterable<Chunk> {
    const token = await getManagedIdentityToken();
    const res = await fetch(this.chatUrl(), {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: req.text }], stream: false }),
    });
    if (!res.ok) {
      yield { type: 'error', code: `HTTP_${res.status}`, message: await res.text() };
      return;
    }
    const json: any = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (!text) {
      yield { type: 'error', code: 'EMPTY_RESPONSE', message: 'Azure OpenAI returned no content' };
      return;
    }
    yield { type: 'delta', text };
    yield { type: 'done' };
  }
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
