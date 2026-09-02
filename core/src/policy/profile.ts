/**
 * WOLFMAN — local learning profile.
 *
 * Wolfman gets better at answering YOU by watching real requests as they
 * happen: recurring topics, typical phrasing length, which providers keep
 * resolving your requests. Nothing here is canned or seeded — the profile
 * starts empty and is updated incrementally, in place, after every real
 * request that actually resolved.
 *
 * HARD BOUNDARY: this store only ever produces phrasing/preference metadata.
 * It is never read as a source of factual content, never substituted for a
 * live provider call, and never cached as "the answer" — see
 * `styleHint()`, which returns guidance text only. `enforceNoMock` in
 * `policy/index.ts` is intentionally unaware of this module.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IntentClass, StyleProfileSnapshot, WolfRequest } from '@wolfman/protocol';

const MIN_INTERACTIONS_FOR_HINT = 3;
const MAX_TERMS_TRACKED = 400;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'for', 'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'my', 'me', 'i', 'you', 'your',
  'what', 'who', 'when', 'where', 'why', 'how', 'do', 'does', 'did', 'can', 'could', 'would', 'should',
  'will', 'have', 'has', 'had', 'not', 'so', 'if', 'about', 'into', 'than', 'then', 'there', 'their',
]);

interface RawProfile {
  interactionCount: number;
  termCounts: Record<string, number>;
  intentCounts: Partial<Record<IntentClass, number>>;
  providerCounts: Record<string, number>;
  totalLength: number;
  updatedAt: string | null;
}

function empty(): RawProfile {
  return { interactionCount: 0, termCounts: {}, intentCounts: {}, providerCounts: {}, totalLength: 0, updatedAt: null };
}

export class LearningProfile {
  private cached: RawProfile | null = null;

  constructor(private file: string) {}

  private async load(): Promise<RawProfile> {
    if (this.cached) return this.cached;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<RawProfile>;
      this.cached = { ...empty(), ...raw };
    } catch {
      this.cached = empty();
    }
    return this.cached;
  }

  private async persist(p: RawProfile): Promise<void> {
    this.cached = p;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(p, null, 2), 'utf8');
  }

  /** Called once per request that actually resolved. Real, incremental, in-place learning. */
  async observe(req: WolfRequest, usedProviderIds: string[]): Promise<void> {
    const p = await this.load();
    p.interactionCount += 1;
    p.totalLength += req.text.length;
    p.intentCounts[req.intent] = (p.intentCounts[req.intent] ?? 0) + 1;
    for (const term of extractTerms(req.text)) p.termCounts[term] = (p.termCounts[term] ?? 0) + 1;
    for (const id of usedProviderIds) p.providerCounts[id] = (p.providerCounts[id] ?? 0) + 1;

    // Bound the vocabulary so this file cannot grow without limit on a long-lived device.
    const terms = Object.entries(p.termCounts);
    if (terms.length > MAX_TERMS_TRACKED) {
      p.termCounts = Object.fromEntries(terms.sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS_TRACKED));
    }

    p.updatedAt = new Date().toISOString();
    await this.persist(p);
  }

  async snapshot(): Promise<StyleProfileSnapshot> {
    const p = await this.load();
    return {
      interactionCount: p.interactionCount,
      topTopics: rank(p.termCounts, 8),
      intentMix: p.intentCounts,
      preferredProviders: Object.entries(p.providerCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([providerId, uses]) => ({ providerId, uses })),
      avgRequestLength: p.interactionCount ? Math.round(p.totalLength / p.interactionCount) : 0,
      updatedAt: p.updatedAt,
    };
  }

  /**
   * Short, prompt-ready phrasing guidance derived live from real accumulated
   * signal. Returns '' until enough interactions exist to say anything real —
   * never a guess dressed up as a preference.
   */
  async styleHint(): Promise<string> {
    const snap = await this.snapshot();
    if (snap.interactionCount < MIN_INTERACTIONS_FOR_HINT) return '';

    const topics = snap.topTopics.map((t) => t.term).join(', ');
    const length = snap.avgRequestLength < 60 ? 'terse' : snap.avgRequestLength < 200 ? 'moderate-length' : 'detailed';
    return (
      `User style, learned from ${snap.interactionCount} prior requests on this device: ` +
      `recurring topics — ${topics || 'none yet'}; typical request length — ${length}. ` +
      `Match this style. This is phrasing guidance only, not a fact — never state it as information about the user.`
    );
  }

  /** Wipes all learned signal. The user must always be able to make this device forget them. */
  async reset(): Promise<void> {
    await this.persist(empty());
  }
}

function extractTerms(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z'-]{2,}/g)?.filter((w) => !STOPWORDS.has(w)) ?? [];
}

function rank(counts: Record<string, number>, n: number) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term, count]) => ({ term, count }));
}
