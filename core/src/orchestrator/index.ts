/**
 * WOLFMAN — orchestrator.
 *
 * Executes a route plan against LIVE providers and returns an answer with full
 * provenance, or throws NoLiveSourceError. There is no third outcome. It will
 * not fabricate, will not substitute a cached answer, and will not emit
 * placeholder text to keep a UI looking busy.
 */

import {
  NoLiveSourceError,
  OFFLINE_INFORMATION_BANNER,
  type AttemptRecord,
  type AuditEntry,
  type Chunk,
  type Citation,
  type DeviceState,
  type Provenance,
  type Provider,
  type ToolCallRecord,
  type WolfmanSettings,
  type WolfRequest,
  type WolfResponse,
} from '@wolfman/protocol';
import { plan, type RoutePlan } from './router.js';
import type { PresenceStore } from '../presence/store.js';
import { enforceNoMock, redactForTier } from '../policy/index.js';
import type { AuditLog } from '../policy/audit.js';
import type { SettingsStore } from '../policy/settings.js';
import type { LearningProfile } from '../policy/profile.js';

const NO_ANSWER_SIGNAL = 'WOLFMAN_NO_ANSWER';

export interface OrchestratorDeps {
  providers: () => Provider[];
  deviceState: () => DeviceState;
  presence: PresenceStore;
  audit: AuditLog;
  settings: SettingsStore;
  /** local, incremental style learning — never a source of factual content */
  learning: LearningProfile;
  /** re-probe hook so a stale registry self-heals before a request runs */
  refresh: () => Promise<void>;
}

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async ask(req: WolfRequest): Promise<WolfResponse> {
    const attempts: AttemptRecord[] = [];
    this.deps.presence.set('thinking', { message: 'selecting provider' });

    await this.deps.refresh();
    const settings = await this.deps.settings.load();

    let route = plan(req, this.deps.providers(), this.deps.deviceState(), settings);
    route.ineligible.forEach((i) =>
      attempts.push({ providerId: i.providerId, reason: i.reason, at: new Date().toISOString() }),
    );

    if (!route.primary.length) {
      const err = new NoLiveSourceError(
        'no provider passed a live probe and satisfied this request’s privacy and modality constraints',
        attempts,
      );
      this.fail(req, route, attempts, err);
      throw err;
    }

    // A live-facts intent with no tool provider is a hard failure, not a
    // silent downgrade to model recall.
    if (route.requiresLiveTools && !route.toolProviders.length) {
      const err = new NoLiveSourceError(
        `intent "${req.intent}" requires a live tool or web source; none of the ${this.deps.providers().length} known providers expose one`,
        attempts,
      );
      this.fail(req, route, attempts, err);
      throw err;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), req.timeoutMs);

    try {
      const toolCalls: ToolCallRecord[] = [];
      let facts = '';

      if (route.mode === 'chain' || route.requiresLiveTools) {
        const gathered = await this.gatherLiveFacts(req, route, ac.signal, attempts);
        toolCalls.push(...gathered.calls);
        facts = gathered.text;
        if (route.requiresLiveTools && !facts.trim()) {
          const err = new NoLiveSourceError(
            'live tool calls returned no usable data for a public-info request',
            attempts,
          );
          this.fail(req, route, attempts, err);
          throw err;
        }
      }

      const results = await this.execute(req, route, facts, settings.learningEnabled, ac.signal, attempts);

      if (!results.length) {
        const err = new NoLiveSourceError('every selected provider failed at invocation time', attempts);
        this.fail(req, route, attempts, err);
        throw err;
      }

      const response = this.merge(req, results, toolCalls);

      // Offline degradation: an `information` answer with nothing live behind it
      // is allowed, but never presented as verified.
      if (req.intent === 'information' && settings.mode !== 'connected' && !toolCalls.length) {
        response.text = `${OFFLINE_INFORMATION_BANNER}\n\n${response.text}`;
      }

      enforceNoMock(response);

      // Learning happens only AFTER a real, verified answer exists — it observes
      // the outcome, it never produces one.
      if (settings.learningEnabled) await this.deps.learning.observe(req, response.provenance.map((p) => p.providerId));

      this.deps.audit.write(this.entry(req, route, attempts, response.provenance, 'ok'));
      this.deps.presence.set('idle');
      return response;
    } catch (e) {
      if (e instanceof NoLiveSourceError) throw e;
      if (ac.signal.aborted) {
        this.deps.presence.set('error', { message: 'timed out' });
        this.deps.audit.write(this.entry(req, route, attempts, [], 'aborted'));
        throw new NoLiveSourceError(`aborted after ${req.timeoutMs}ms`, attempts);
      }
      this.deps.presence.set('error', { message: String((e as any)?.message ?? e) });
      this.deps.audit.write(this.entry(req, route, attempts, [], 'error'));
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ─────────────────────── live fact gathering ─────────────────────── */

  private async gatherLiveFacts(
    req: WolfRequest,
    route: RoutePlan,
    signal: AbortSignal,
    attempts: AttemptRecord[],
  ): Promise<{ text: string; calls: ToolCallRecord[] }> {
    this.deps.presence.set('thinking', { message: 'fetching live sources' });

    const calls: ToolCallRecord[] = [];
    const parts: string[] = [];

    for (const p of route.toolProviders) {
      const startedAt = new Date().toISOString();
      try {
        const tools = await p.tools!(signal);
        const tool = pickTool(tools, req);
        if (!tool) {
          attempts.push({
            providerId: p.descriptor.id,
            reason: 'no tool matched the request',
            at: new Date().toISOString(),
          });
          continue;
        }
        const anyP = p as any;
        const result = await anyP.callTool(tool.name, { query: req.text }, signal);
        const text = extractText(result);
        const urls = extractUrls(result);
        calls.push({
          server: p.descriptor.id,
          tool: tool.name,
          args: { query: req.text },
          urls,
          startedAt,
          completedAt: new Date().toISOString(),
          ok: Boolean(text),
        });
        if (text) parts.push(`### source: ${p.descriptor.displayName} / ${tool.name}\n${text}`);
      } catch (e: any) {
        calls.push({
          server: p.descriptor.id,
          tool: 'unknown',
          args: { query: req.text },
          urls: [],
          startedAt,
          completedAt: new Date().toISOString(),
          ok: false,
          error: String(e?.message ?? e),
        });
        attempts.push({
          providerId: p.descriptor.id,
          reason: `tool call failed: ${e?.message ?? e}`,
          at: new Date().toISOString(),
        });
      }
    }

    return { text: parts.join('\n\n'), calls };
  }

  /* ───────────────────────────── execution ───────────────────────────── */

  private async execute(
    req: WolfRequest,
    route: RoutePlan,
    facts: string,
    learningEnabled: boolean,
    signal: AbortSignal,
    attempts: AttemptRecord[],
  ): Promise<{ text: string; provenance: Provenance }[]> {
    const targets = route.primary.map((s) => s.provider);
    this.deps.presence.set('rendering', {
      activeProvider: targets.map((t) => t.descriptor.displayName).join(' + '),
    });
    const styleHint = learningEnabled ? await this.deps.learning.styleHint() : '';

    const settled = await Promise.allSettled(
      targets.map((p) => this.invokeOne(p, req, facts, styleHint, signal)),
    );

    const ok: { text: string; provenance: Provenance }[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.text.trim()) {
        ok.push(r.value);
      } else {
        attempts.push({
          providerId: targets[i].descriptor.id,
          reason:
            r.status === 'rejected'
              ? String((r.reason as any)?.message ?? r.reason)
              : 'provider returned empty output',
          at: new Date().toISOString(),
        });
      }
    });

    // Nobody in `primary` answered — poll the rest of the ranked list one at a
    // time, in score order, until one resolves the request or the list is exhausted.
    if (!ok.length) {
      for (const s of route.fallback) {
        this.deps.presence.set('rendering', { activeProvider: s.provider.descriptor.displayName });
        try {
          const r = await this.invokeOne(s.provider, req, facts, styleHint, signal);
          if (r.text.trim()) return [r];
          attempts.push({
            providerId: s.provider.descriptor.id,
            reason: 'provider returned empty output',
            at: new Date().toISOString(),
          });
        } catch (e: any) {
          attempts.push({
            providerId: s.provider.descriptor.id,
            reason: String(e?.message ?? e),
            at: new Date().toISOString(),
          });
        }
      }
    }

    return ok;
  }

  private async invokeOne(
    p: Provider,
    req: WolfRequest,
    facts: string,
    styleHint: string,
    signal: AbortSignal,
  ): Promise<{ text: string; provenance: Provenance }> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    // Redact before anything leaves the device boundary.
    const { text: safeText, redacted } = redactForTier(req.text, p.descriptor.privacyTier);
    const prompt = [
      safeText,
      `If you cannot answer the request reliably, respond with exactly ${NO_ANSWER_SIGNAL} so Wolfman can hand off to another live provider.`,
      facts ? `Answer strictly from the live sources below. If they do not contain the answer, say so explicitly — do not fill gaps from memory.\n\n${facts}` : '',
      styleHint,
    ].filter(Boolean).join('\n\n');

    const toolCalls: ToolCallRecord[] = [];
    let text = '';

    for await (const chunk of p.invoke({ ...req, text: prompt }, signal) as AsyncIterable<Chunk>) {
      if (chunk.type === 'delta') {
        text += chunk.text;
        this.deps.presence.stream(chunk.text);
      } else if (chunk.type === 'tool-call') {
        toolCalls.push(chunk.call);
      } else if (chunk.type === 'error') {
        throw new Error(`${chunk.code}: ${chunk.message}`);
      }
    }

    if (redacted.length) {
      this.deps.audit.egress(p.descriptor, redacted);
    }

    if (text.trim() === NO_ANSWER_SIGNAL) {
      throw new Error('provider reported that it could not answer');
    }

    return {
      text,
      provenance: {
        providerId: p.descriptor.id,
        displayName: p.descriptor.displayName,
        deviceId: p.descriptor.device.id,
        model: p.descriptor.lastProbe?.models[0]?.id ?? null,
        privacyTier: p.descriptor.privacyTier,
        startedAt,
        completedAt: new Date().toISOString(),
        latencyMs: Date.now() - t0,
        toolCalls,
        servedFromCache: false,
      },
    };
  }

  /* ────────────────────────────── merging ────────────────────────────── */

  private merge(
    req: WolfRequest,
    results: { text: string; provenance: Provenance }[],
    toolCalls: ToolCallRecord[],
  ): WolfResponse {
    const citations: Citation[] = dedupeCitations([
      ...toolCalls.flatMap((c) =>
        c.urls.map((u) => ({ url: u, title: null, fetchedAt: c.completedAt })),
      ),
      ...results.flatMap((r) =>
        r.provenance.toolCalls.flatMap((c) =>
          c.urls.map((u) => ({ url: u, title: null, fetchedAt: c.completedAt })),
        ),
      ),
    ]);

    if (results.length === 1) {
      return {
        requestId: req.id,
        text: results[0].text,
        provenance: [results[0].provenance, ...(toolCalls.length ? [] : [])],
        citations,
      };
    }

    // Fan-out: present the strongest answer, then surface where the models
    // disagree. Divergence is signal, not noise — never averaged away.
    const primary = results[0];
    const divergences = results.slice(1).map((r) => ({
      providerId: r.provenance.providerId,
      claim: firstDivergentSentence(primary.text, r.text),
    }));

    const body =
      primary.text +
      '\n\n---\n**Cross-checked against ' +
      results.length +
      ' providers.** ' +
      (divergences.some((d) => d.claim)
        ? 'Points of disagreement are listed below.'
        : 'No material disagreement detected.');

    return {
      requestId: req.id,
      text: body,
      provenance: results.map((r) => r.provenance),
      consensus: { agreements: [], divergences: divergences.filter((d) => d.claim) },
      citations,
    };
  }

  /* ─────────────────────────────── audit ─────────────────────────────── */

  private fail(req: WolfRequest, route: RoutePlan, attempts: AttemptRecord[], err: NoLiveSourceError) {
    this.deps.presence.set('error', { message: err.message });
    this.deps.audit.write(this.entry(req, route, attempts, [], 'no-live-source'));
  }

  private entry(
    req: WolfRequest,
    route: RoutePlan,
    attempts: AttemptRecord[],
    used: Provenance[],
    outcome: AuditEntry['outcome'],
  ): AuditEntry {
    return {
      requestId: req.id,
      at: new Date().toISOString(),
      text: req.text,
      intent: req.intent,
      sensitivity: req.sensitivity,
      routeMode: route.mode,
      attempted: attempts,
      used,
      egress: used
        .filter((p) => p.privacyTier === 'cloud')
        .map((p) => ({ host: p.providerId, privacyTier: p.privacyTier, redactedFields: [] })),
      outcome,
    };
  }
}

/* ────────────────────────────── helpers ────────────────────────────── */

function pickTool(tools: { name: string; description: string }[], req: WolfRequest) {
  const t = req.text.toLowerCase();
  const wants = (re: RegExp) => tools.find((x) => re.test(x.name) || re.test(x.description));

  if (req.intent === 'public-info') {
    if (/direction|route|navigate|how do i get/.test(t)) return wants(/direction|route|maps?|navigat/i) ?? wants(/search|web|fetch/i);
    if (/phone|number|call/.test(t)) return wants(/place|business|phone|directory|search/i);
    if (/hours|open/.test(t)) return wants(/place|business|hours|search/i);
    return wants(/search|web|fetch|browse/i);
  }
  return wants(/search|web|fetch|query|browse/i) ?? tools[0];
}

function extractText(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    return result.content.map((c: any) => c.text ?? '').filter(Boolean).join('\n');
  }
  return typeof result.text === 'string' ? result.text : '';
}

function extractUrls(result: any): string[] {
  const blob = JSON.stringify(result ?? '');
  return [...new Set(blob.match(/https?:\/\/[^\s"'\\)]+/g) ?? [])];
}

function dedupeCitations(list: Citation[]): Citation[] {
  const m = new Map<string, Citation>();
  for (const c of list) if (!m.has(c.url)) m.set(c.url, c);
  return [...m.values()];
}

function firstDivergentSentence(a: string, b: string): string {
  const as = new Set(a.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()));
  for (const s of b.split(/(?<=[.!?])\s+/)) {
    const k = s.trim();
    if (k.length > 40 && !as.has(k.toLowerCase())) return k;
  }
  return '';
}
