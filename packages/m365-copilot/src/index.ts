import { InteractiveBrowserCredential, useIdentityPlugin } from '@azure/identity';
import { cachePersistencePlugin } from '@azure/identity-cache-persistence';
import {
  NoLiveSourceError,
  type Chunk,
  type DeviceRef,
  type ProbeResult,
  type Provider,
  type ProviderDescriptor,
  type WolfRequest,
} from '@wolfman/protocol';

useIdentityPlugin(cachePersistencePlugin);

const GRAPH_BASE = 'https://graph.microsoft.com/beta/copilot/conversations';
const SCOPES = [
  'https://graph.microsoft.com/Sites.Read.All',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/People.Read.All',
  'https://graph.microsoft.com/OnlineMeetingTranscript.Read.All',
  'https://graph.microsoft.com/Chat.Read',
  'https://graph.microsoft.com/ChannelMessage.Read.All',
  'https://graph.microsoft.com/ExternalItem.Read.All',
];

interface CopilotConversation {
  id?: string;
  messages?: { text?: string }[];
}

function unavailable(message: string): ProbeResult {
  return {
    status: 'unavailable',
    probedAt: new Date().toISOString(),
    latencyMs: null,
    models: [],
    supportsStreaming: false,
    toolCount: 0,
    failure: { code: 'COPILOT_PROBE_FAILED', message },
  };
}

export class Microsoft365CopilotProvider implements Provider {
  descriptor: ProviderDescriptor;
  private credential: InteractiveBrowserCredential;

  constructor(device: DeviceRef) {
    this.descriptor = {
      id: 'microsoft-365-copilot@graph',
      displayName: 'Microsoft 365 Copilot',
      device,
      transport: 'native-sdk',
      privacyTier: 'cloud',
      modalities: ['text'],
      costClass: 'metered-cloud',
      pinned: false,
      lastProbe: null,
    };
    this.credential = new InteractiveBrowserCredential({
      clientId: process.env.WOLFMAN_M365_CLIENT_ID,
      tenantId: process.env.WOLFMAN_M365_TENANT_ID,
      tokenCachePersistenceOptions: {
        enabled: true,
        name: 'wolfman-microsoft-365-copilot',
      },
    });
  }

  private async token(signal: AbortSignal): Promise<string> {
    const access = await this.credential.getToken(SCOPES, { abortSignal: signal });
    if (!access?.token) throw new Error('Microsoft Entra returned no delegated access token');
    return access.token;
  }

  private async createConversation(token: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(GRAPH_BASE, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) throw new Error(`Microsoft 365 Copilot conversation failed: HTTP ${response.status}`);
    const conversation = await response.json() as CopilotConversation;
    if (!conversation.id) throw new Error('Microsoft 365 Copilot returned no conversation ID');
    return conversation.id;
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();
    const probedAt = new Date().toISOString();
    try {
      const token = await this.token(signal);
      await this.createConversation(token, signal);
      return {
        status: 'available',
        probedAt,
        latencyMs: Date.now() - started,
        models: [{ id: 'microsoft-365-copilot', contextWindow: null, modalities: ['text'] }],
        supportsStreaming: false,
        toolCount: 0,
      };
    } catch (error) {
      return { ...unavailable(error instanceof Error ? error.message : String(error)), probedAt };
    }
  }

  async *invoke(req: WolfRequest, signal: AbortSignal): AsyncIterable<Chunk> {
    const token = await this.token(signal);
    const conversationId = await this.createConversation(token, signal);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const response = await fetch(`${GRAPH_BASE}/${encodeURIComponent(conversationId)}/chat`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { text: req.text }, locationHint: { timeZone } }),
    });
    if (!response.ok) {
      throw new NoLiveSourceError(`HTTP ${response.status} from Microsoft 365 Copilot`, [{
        providerId: this.descriptor.id,
        reason: `chat returned status ${response.status}`,
        at: new Date().toISOString(),
      }]);
    }
    const conversation = await response.json() as CopilotConversation;
    const text = [...(conversation.messages ?? [])].reverse().find((message) => message.text)?.text?.trim();
    if (!text) {
      throw new NoLiveSourceError('Microsoft 365 Copilot returned an empty response', [{
        providerId: this.descriptor.id,
        reason: 'chat response contained no message text',
        at: new Date().toISOString(),
      }]);
    }
    yield { type: 'delta', text };
    yield { type: 'done' };
  }
}
