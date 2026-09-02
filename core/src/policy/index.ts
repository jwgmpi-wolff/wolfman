/**
 * WOLFMAN — policy gate.
 *
 * This module is the enforcement point for the two rules the product exists to
 * guarantee: (1) nothing is ever fabricated or served from canned content, and
 * (2) sensitive text is redacted before it crosses a device boundary.
 */

import type { PrivacyTier, WolfResponse } from '@wolfman/protocol';

/* ───────────────────────── no-mock enforcement ───────────────────────── */

/**
 * Runtime assertion that a response is backed by at least one real provider
 * call. Throws rather than returning a degraded answer.
 */
export function enforceNoMock(res: WolfResponse): void {
  if (!res.provenance.length) {
    throw new Error('POLICY_VIOLATION: response has no provenance — refusing to return it');
  }
  for (const p of res.provenance) {
    if (p.servedFromCache !== false) {
      throw new Error(`POLICY_VIOLATION: ${p.providerId} served cached content without allowStale`);
    }
    if (!p.startedAt || !p.completedAt) {
      throw new Error(`POLICY_VIOLATION: ${p.providerId} produced no execution timestamps`);
    }
    if (Date.parse(p.completedAt) < Date.parse(p.startedAt)) {
      throw new Error(`POLICY_VIOLATION: ${p.providerId} timestamps are incoherent`);
    }
  }
}

/**
 * Static guard used by the build. Fails CI if any mock/sample/canned response
 * path has been reintroduced into the codebase.
 */
export const FORBIDDEN_SOURCE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\bmockResponse\b|\bfakeResponse\b|\bstubAnswer\b/, why: 'mocked answer path' },
  { re: /\bSAMPLE_(ANSWERS?|DATA|RESPONSES?)\b/, why: 'sample answer table' },
  { re: /\bCANNED_/, why: 'canned response constant' },
  { re: /\bseedDatabase\b|\bloadFixtures\b/, why: 'seed/fixture data loader' },
  { re: /\bbudget|\btransactions?Ledger\b|\bexpenseCategor/i, why: 'purged finance domain' },
  { re: /placeholder answer|lorem ipsum/i, why: 'placeholder content' },
];

/* ───────────────────────────── redaction ───────────────────────────── */

interface RedactionRule {
  name: string;
  re: RegExp;
  mask: (m: string) => string;
}

const RULES: RedactionRule[] = [
  { name: 'email', re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, mask: () => '[email]' },
  { name: 'phone', re: /\+?\d[\d\s().-]{8,}\d/g, mask: () => '[phone]' },
  { name: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, mask: () => '[ssn]' },
  { name: 'card', re: /\b(?:\d[ -]*?){13,19}\b/g, mask: () => '[card]' },
  { name: 'ipv4', re: /\b\d{1,3}(\.\d{1,3}){3}\b/g, mask: () => '[ip]' },
  { name: 'apikey', re: /\b(sk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{16,}\b/g, mask: () => '[secret]' },
  { name: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g, mask: () => '[aws-key]' },
  { name: 'jwt', re: /\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, mask: () => '[jwt]' },
  { name: 'guid', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, mask: () => '[guid]' },
];

/** Nothing is redacted for on-device providers — the data never leaves. */
export function redactForTier(
  text: string,
  tier: PrivacyTier,
): { text: string; redacted: string[] } {
  if (tier === 'on-device') return { text, redacted: [] };

  const redacted: string[] = [];
  let out = text;
  for (const rule of RULES) {
    if (rule.re.test(out)) {
      redacted.push(rule.name);
      out = out.replace(rule.re, rule.mask);
    }
    rule.re.lastIndex = 0;
  }
  return { text: out, redacted };
}

/* ─────────────────────────── consent gate ─────────────────────────── */

export interface ConsentState {
  cloudEgressAllowedUntil: number | null;
  perProvider: Map<string, boolean>;
}

export function requiresConsent(tier: PrivacyTier, consent: ConsentState, providerId: string): boolean {
  if (tier !== 'cloud') return false;
  if (consent.perProvider.get(providerId)) return false;
  return !(consent.cloudEgressAllowedUntil && Date.now() < consent.cloudEgressAllowedUntil);
}
