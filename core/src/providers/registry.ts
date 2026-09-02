/**
 * WOLFMAN — provider registry + adapters.
 *
 * Adapters self-register. Adding support for a new AI app must require ZERO
 * changes to the orchestrator or the router.
 */

import type {
  Candidate,
} from '../discovery/index.js';
import type {
  Chunk,
  DeviceRef,
  McpTool,
  ModelRef,
  ProbeResult,
  Provider,
  ProviderDescriptor,
  WolfRequest,
} from '@wolfman/protocol';
import { NoLiveSourceError } from '@wolfman/protocol';

/* ─────────────────────────── adapter factory ─────────────────────────── */

export interface AdapterFactory {
  /** cheap, synchronous — decides whether this adapter wants the candidate */
  claims(c: Candidate): boolean;
  create(c: Candidate, device: DeviceRef): Provider;
  priority: number; // higher wins when several adapters claim
}

const ADAPTERS: AdapterFactory[] = [];

export function registerAdapter(f: AdapterFactory): void {
  ADAPTERS.push(f);
  ADAPTERS.sort((a, b) => b.priority - a.priority);
}

export function buildProvider(c: Candidate, device: DeviceRef): Provider | null {
  const f = ADAPTERS.find((a) => a.claims(c));
  return f ? f.create(c, device) : null;
}

/* ────────────────────────────── registry ────────────────────────────── */

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  all(): Provider[] {
    return [...this.providers.values()];
  }

  available(): Provider[] {
    return this.all().filter((p) => p.descriptor.lastProbe?.status === 'available');
  }

  /**
   * Registers candidates ONLY after a successful live handshake. Candidates that
   * fail are still recorded so the UI and audit log can explain their absence.
   */
  async registerAll(
    candidates: Candidate[],
    device: DeviceRef,
    timeoutMs = 6000,
  ): Promise<{ registered: ProviderDescriptor[]; rejected: { candidate: Candidate; probe: ProbeResult }[] }> {
    const registered: ProviderDescriptor[] = [];
    const rejected: { candidate: Candidate; probe: ProbeResult }[] = [];

    await Promise.all(
      candidates.map(async (c) => {
        const provider = buildProvider(c, device);
        if (!provider) {
          rejected.push({
            candidate: c,
            probe: failedProbe('NO_ADAPTER', `no adapter claims transport ${c.transport}`),
          });
          return;
        }
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const probe = await provider.probe(ac.signal);
          provider.descriptor.lastProbe = probe;
          if (probe.status === 'available') {
            this.providers.set(provider.descriptor.id, provider);
            registered.push(provider.descriptor);
          } else {
            this.providers.set(provider.descriptor.id, provider); // keep for UI
            rejected.push({ candidate: c, probe });
          }
        } catch (e: any) {
          rejected.push({ candidate: c, probe: failedProbe('PROBE_THREW', String(e?.message ?? e)) });
        } finally {
          clearTimeout(t);
        }
      }),
    );

    return { registered, rejected };
  }

  /**
   * Directly registers an already-constructed provider after a live probe —
   * for statically-configured peers (e.g. a cloud endpoint reached via env
   * config) that never go through local candidate discovery.
   */
  async registerDirect(provider: Provider, timeoutMs = 6000): Promise<ProviderDescriptor> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      provider.descriptor.lastProbe = await provider.probe(ac.signal);
    } catch (e: any) {
      provider.descriptor.lastProbe = failedProbe('PROBE_THREW', String(e?.message ?? e));
    } finally {
      clearTimeout(t);
    }
    this.providers.set(provider.descriptor.id, provider);
    return provider.descriptor;
  }

  /** Re-probes everything. Called on a timer and before high-stakes requests. */
  async refresh(timeoutMs = 6000): Promise<void> {
    await Promise.all(
      this.all().map(async (p) => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        try {
          p.descriptor.lastProbe = await p.probe(ac.signal);
        } catch (e: any) {
          p.descriptor.lastProbe = failedProbe('PROBE_THREW', String(e?.message ?? e));
        } finally {
          clearTimeout(t);
        }
      }),
    );
  }

  async dispose(): Promise<void> {
    await Promise.all(this.all().map((p) => p.dispose?.() ?? Promise.resolve()));
    this.providers.clear();
  }
}

export function failedProbe(code: string, message: string): ProbeResult {
  return {
    status: 'unavailable',
    probedAt: new Date().toISOString(),
    latencyMs: null,
    models: [],
    supportsStreaming: false,
    toolCount: 0,
    failure: { code, message },
  };
}

/* ══════════════════════════════════════════════════════════════════════
   ADAPTER 1 — OpenAI-compatible local runtimes
   Covers Ollama, LM Studio, llama.cpp server, vLLM, LocalAI, Jan, GPT4All …
   ══════════════════════════════════════════════════════════════════════ */

class OpenAICompatibleProvider implements Provider {
  descriptor: ProviderDescriptor;
  private base: string;

  constructor(c: Candidate, device: DeviceRef) {
    this.base = (c.endpoint ?? '').replace(/\/$/, '');
    this.descriptor = {
      id: c.id,
      displayName: c.displayName,
      device,
      transport: 'openai-compatible',
      privacyTier: c.privacyTier,
      modalities: ['text'],
      costClass: c.privacyTier === 'on-device' ? 'free-local' : c.privacyTier === 'lan' ? 'lan' : 'metered-cloud',
      pinned: false,
      lastProbe: null,
    };
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();
    const at = new Date().toISOString();

    // Try the two conventions in order; whichever answers first defines reality.
    for (const p of ['/v1/models', '/api/tags']) {
      try {
        const res = await fetch(this.base + p, { signal });
        if (!res.ok) continue;
        const json: any = await res.json();
        const models: ModelRef[] = (json.data ?? json.models ?? [])
          .map((m: any) => ({
            id: m.id ?? m.name ?? m.model,
            contextWindow: m.context_length ?? m.details?.context_length ?? null,
            modalities: inferModalities(m),
          }))
          .filter((m: ModelRef) => Boolean(m.id));

        if (!models.length) continue;

        this.descriptor.modalities = uniq(models.flatMap((m) => m.modalities));
        return {
          status: 'available',
          probedAt: at,
          latencyMs: Date.now() - started,
          models,
          supportsStreaming: true,
          toolCount: 0,
        };
      } catch (e: any) {
        if (signal.aborted) break;
      }
    }
    return failedProbe('HANDSHAKE_FAILED', `no model list from ${this.base}`);
  }

  async *invoke(req: WolfRequest, signal: AbortSignal): AsyncIterable<Chunk> {
    const model = this.descriptor.lastProbe?.models[0]?.id;
    if (!model) {
      throw new NoLiveSourceError('provider has no live model list', [
        { providerId: this.descriptor.id, reason: 'probe returned zero models', at: new Date().toISOString() },
      ]);
    }

    const res = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: req.text }],
      }),
    });

    if (!res.ok || !res.body) {
      throw new NoLiveSourceError(`HTTP ${res.status} from ${this.descriptor.displayName}`, [
        { providerId: this.descriptor.id, reason: `status ${res.status}`, at: new Date().toISOString() },
      ]);
    }

    yield* parseSse(res.body, (payload) => {
      const delta = payload?.choices?.[0]?.delta?.content;
      return typeof delta === 'string' && delta.length ? { type: 'delta', text: delta } : null;
    });

    yield { type: 'done' };
  }
}

registerAdapter({
  priority: 50,
  claims: (c) => c.transport === 'openai-compatible' && Boolean(c.endpoint),
  create: (c, d) => new OpenAICompatibleProvider(c, d),
});

/* ══════════════════════════════════════════════════════════════════════
   ADAPTER 2 — MCP over HTTP/SSE (peers, remote MCP servers)
   ══════════════════════════════════════════════════════════════════════ */

class McpHttpProvider implements Provider {
  descriptor: ProviderDescriptor;
  private url: string;
  private headers: Record<string, string>;
  private cachedTools: McpTool[] = [];

  constructor(c: Candidate, device: DeviceRef) {
    this.url = (c.endpoint ?? '').replace(/\/$/, '');
    this.headers = { 'content-type': 'application/json' };
    this.descriptor = {
      id: c.id,
      displayName: c.displayName,
      device,
      transport: 'mcp-http',
      privacyTier: c.privacyTier,
      modalities: ['text', 'tools'],
      costClass: c.privacyTier === 'on-device' ? 'free-local' : c.privacyTier === 'lan' ? 'lan' : 'metered-cloud',
      pinned: false,
      lastProbe: null,
    };
  }

  private async rpc(method: string, params: unknown, signal: AbortSignal): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      signal,
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: cryptoId(), method, params }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json: any = await res.json();
    if (json.error) throw new Error(json.error.message ?? 'rpc error');
    return json.result;
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();
    const at = new Date().toISOString();
    try {
      await this.rpc(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'wolfman', version: '1.0.0' },
          capabilities: { tools: {}, sampling: {} },
        },
        signal,
      );
      const tools = await this.rpc('tools/list', {}, signal).catch(() => ({ tools: [] }));
      this.cachedTools = (tools.tools ?? []).map((t: any) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
        server: this.descriptor.id,
      }));
      return {
        status: 'available',
        probedAt: at,
        latencyMs: Date.now() - started,
        models: [],
        supportsStreaming: true,
        toolCount: this.cachedTools.length,
      };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/401|403/.test(msg)) return { ...failedProbe('UNAUTHORIZED', msg), status: 'unauthorized' };
      return failedProbe('MCP_INITIALIZE_FAILED', msg);
    }
  }

  async tools(signal: AbortSignal): Promise<McpTool[]> {
    const r = await this.rpc('tools/list', {}, signal);
    this.cachedTools = (r.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? {},
      server: this.descriptor.id,
    }));
    return this.cachedTools;
  }

  async *invoke(req: WolfRequest, signal: AbortSignal): AsyncIterable<Chunk> {
    // Peer Wolfman nodes expose a `wolfman.ask` tool; generic MCP servers do not.
    const hasAsk = this.cachedTools.some((t) => t.name === 'wolfman.ask');
    if (!hasAsk) {
      throw new NoLiveSourceError(`${this.descriptor.displayName} exposes tools but no completion surface`, [
        { providerId: this.descriptor.id, reason: 'no wolfman.ask tool', at: new Date().toISOString() },
      ]);
    }
    const started = new Date().toISOString();
    const result = await this.rpc(
      'tools/call',
      { name: 'wolfman.ask', arguments: { text: req.text, intent: req.intent, allowStale: req.allowStale } },
      signal,
    );
    yield {
      type: 'tool-call',
      call: {
        server: this.descriptor.id,
        tool: 'wolfman.ask',
        args: { text: req.text },
        urls: result?.urls ?? [],
        startedAt: started,
        completedAt: new Date().toISOString(),
        ok: true,
      },
    };
    const text = result?.content?.map((c: any) => c.text).join('') ?? '';
    if (!text) {
      throw new NoLiveSourceError('peer returned an empty result', [
        { providerId: this.descriptor.id, reason: 'empty tool result', at: new Date().toISOString() },
      ]);
    }
    yield { type: 'delta', text };
    yield { type: 'done' };
  }
}

registerAdapter({
  priority: 60,
  claims: (c) => c.transport === 'mcp-http' && Boolean(c.endpoint),
  create: (c, d) => new McpHttpProvider(c, d),
});

/* ══════════════════════════════════════════════════════════════════════
   ADAPTER 3 — MCP over stdio (local tool servers from existing configs)
   ══════════════════════════════════════════════════════════════════════ */

class McpStdioProvider implements Provider {
  descriptor: ProviderDescriptor;
  private proc: any = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buffer = '';
  private cachedTools: McpTool[] = [];

  constructor(private c: Candidate, device: DeviceRef) {
    this.descriptor = {
      id: c.id,
      displayName: c.displayName,
      device,
      transport: 'mcp-stdio',
      privacyTier: c.privacyTier,
      modalities: ['tools'],
      costClass: 'free-local',
      pinned: false,
      lastProbe: null,
    };
  }

  private async start(): Promise<void> {
    if (this.proc) return;
    const { spawn } = await import('node:child_process');
    this.proc = spawn(this.c.command!, this.c.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (b: Buffer) => this.onData(b.toString()));
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('mcp server exited'));
      this.pending.clear();
      this.proc = null;
    });
  }

  private onData(s: string) {
    this.buffer += s;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const p = this.pending.get(String(msg.id));
        if (p) {
          this.pending.delete(String(msg.id));
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
      } catch {
        /* non-JSON stdout noise from the server */
      }
    }
  }

  private async rpc(method: string, params: unknown, signal: AbortSignal): Promise<any> {
    await this.start();
    const id = cryptoId();
    const promise = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      signal.addEventListener('abort', () => {
        this.pending.delete(id);
        reject(new Error('aborted'));
      });
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return promise;
  }

  async probe(signal: AbortSignal): Promise<ProbeResult> {
    const started = Date.now();
    const at = new Date().toISOString();
    try {
      await this.rpc(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'wolfman', version: '1.0.0' },
          capabilities: { tools: {} },
        },
        signal,
      );
      const r = await this.rpc('tools/list', {}, signal).catch(() => ({ tools: [] }));
      this.cachedTools = (r.tools ?? []).map((t: any) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
        server: this.descriptor.id,
      }));
      return {
        status: 'available',
        probedAt: at,
        latencyMs: Date.now() - started,
        models: [],
        supportsStreaming: false,
        toolCount: this.cachedTools.length,
      };
    } catch (e: any) {
      return failedProbe('MCP_STDIO_FAILED', String(e?.message ?? e));
    }
  }

  async tools(): Promise<McpTool[]> {
    return this.cachedTools;
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<any> {
    return this.rpc('tools/call', { name, arguments: args }, signal);
  }

  async *invoke(): AsyncIterable<Chunk> {
    // A tool server is not a completion surface. The orchestrator chains it with
    // a reasoning provider instead of calling invoke() directly.
    throw new NoLiveSourceError('MCP stdio server is tool-only, not a completion provider', [
      { providerId: this.descriptor.id, reason: 'tool-only surface', at: new Date().toISOString() },
    ]);
  }

  async dispose(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
  }
}

registerAdapter({
  priority: 55,
  claims: (c) => c.transport === 'mcp-stdio' && Boolean(c.command),
  create: (c, d) => new McpStdioProvider(c, d),
});

/* ────────────────────────────── shared helpers ────────────────────────────── */

function cryptoId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function uniq<T>(list: T[]): T[] {
  return [...new Set(list)];
}

function inferModalities(m: any): ('text' | 'vision' | 'audio-in' | 'audio-out' | 'tools')[] {
  const id = String(m.id ?? m.name ?? '').toLowerCase();
  const modalities: ('text' | 'vision' | 'audio-in' | 'audio-out' | 'tools')[] = ['text'];
  if (/vision|vl|image|llava/.test(id)) modalities.push('vision');
  return modalities;
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  extract: (payload: any) => { type: 'delta'; text: string } | null,
): AsyncIterable<Chunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const chunk = extract(JSON.parse(data));
        if (chunk) yield chunk;
      } catch {
        /* partial/non-JSON SSE frame */
      }
    }
  }
}
