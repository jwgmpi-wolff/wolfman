/**
 * WOLFMAN — routing.
 *
 * Scores every AVAILABLE provider per request. There is no hardcoded favourite
 * and no static preference list. A provider that has not passed a live probe
 * within the freshness window is not eligible.
 */

import type {
  DeviceState,
  IntentClass,
  PrivacyTier,
  Provider,
  RouteMode,
  Sensitivity,
  WolfmanSettings,
  WolfRequest,
} from '@wolfman/protocol';

export interface ScoredProvider {
  provider: Provider;
  score: number;
  reasons: string[];
}

export interface RoutePlan {
  mode: RouteMode;
  primary: ScoredProvider[];
  /** every remaining eligible provider, ranked, tried one at a time if primary fails */
  fallback: ScoredProvider[];
  /** tool-capable providers used to fetch live facts before synthesis */
  toolProviders: Provider[];
  ineligible: { providerId: string; reason: string }[];
  requiresLiveTools: boolean;
}

const PROBE_FRESHNESS_MS = 5 * 60 * 1000;

/** Minimum privacy tier a given sensitivity is allowed to touch. */
const TIER_RANK: Record<PrivacyTier, number> = { 'on-device': 0, lan: 1, cloud: 2 };

const MAX_TIER_FOR_SENSITIVITY: Record<Sensitivity, PrivacyTier> = {
  public: 'cloud',
  personal: 'lan',
  confidential: 'on-device',
};

/**
 * Intents that MUST be answered from a live tool/web call, never from model
 * weights. Directions, phone numbers, hours and addresses go stale silently,
 * which is exactly the failure mode we refuse to ship.
 */
const TOOL_MANDATORY_INTENTS: IntentClass[] = ['public-info'];

/** Intents that benefit from multiple independent opinions. */
const FANOUT_INTENTS: IntentClass[] = ['analysis', 'strategy', 'advice'];

/** Highest privacy tier a given operating mode is allowed to reach out to. */
const MAX_TIER_FOR_MODE: Record<WolfmanSettings['mode'], PrivacyTier> = {
  standalone: 'on-device',
  mesh: 'lan',
  connected: 'cloud',
};

export function plan(
  req: WolfRequest,
  providers: Provider[],
  deviceState: DeviceState,
  settings: WolfmanSettings,
): RoutePlan {
  const ineligible: { providerId: string; reason: string }[] = [];
  const now = Date.now();
  const maxTier = MAX_TIER_FOR_SENSITIVITY[req.sensitivity];

  const eligible: Provider[] = [];

  for (const p of providers) {
    const d = p.descriptor;
    const probe = d.lastProbe;

    // Mode is applied BEFORE scoring: in standalone mode a cloud provider is
    // not a low-scoring option, it is not an option, full stop.
    if (settings.lockToDevice && d.privacyTier !== 'on-device') {
      ineligible.push({ providerId: d.id, reason: 'locked to this device — lockToDevice is enabled' });
      continue;
    }
    if (!settings.lockToDevice && TIER_RANK[d.privacyTier] > TIER_RANK[MAX_TIER_FOR_MODE[settings.mode]]) {
      ineligible.push({ providerId: d.id, reason: `excluded by ${settings.mode} mode (${d.privacyTier} is disabled)` });
      continue;
    }

    if (!probe || probe.status !== 'available') {
      ineligible.push({
        providerId: d.id,
        reason: probe?.failure?.message ?? `status=${probe?.status ?? 'never probed'}`,
      });
      continue;
    }
    if (now - Date.parse(probe.probedAt) > PROBE_FRESHNESS_MS) {
      ineligible.push({ providerId: d.id, reason: 'probe stale — re-probe required before use' });
      continue;
    }
    if (TIER_RANK[d.privacyTier] > TIER_RANK[maxTier]) {
      ineligible.push({
        providerId: d.id,
        reason: `privacy tier ${d.privacyTier} exceeds ${maxTier} allowed for ${req.sensitivity} request`,
      });
      continue;
    }
    const missing = req.requiredModalities.filter((m) => !d.modalities.includes(m));
    if (missing.length) {
      ineligible.push({ providerId: d.id, reason: `missing modality: ${missing.join(', ')}` });
      continue;
    }
    if (req.routeHint?.providerIds?.length && !req.routeHint.providerIds.includes(d.id)) {
      ineligible.push({ providerId: d.id, reason: 'excluded by explicit provider pin' });
      continue;
    }
    eligible.push(p);
  }

  const preferredRank = new Map(settings.preferredProviderIds.map((id, index) => [id, index]));
  const scored = eligible
    .map((p) => score(p, req, deviceState))
    .sort((a, b) => {
      const aRank = preferredRank.get(a.provider.descriptor.id);
      const bRank = preferredRank.get(b.provider.descriptor.id);
      if (aRank !== undefined || bRank !== undefined) {
        if (aRank === undefined) return 1;
        if (bRank === undefined) return -1;
        return aRank - bRank;
      }
      return b.score - a.score;
    });

  for (const item of scored) {
    const rank = preferredRank.get(item.provider.descriptor.id);
    if (rank !== undefined) item.reasons.unshift(`user provider order #${rank + 1}`);
  }

  const attemptLimit = settings.maxProviderAttempts === 'all' ? scored.length : settings.maxProviderAttempts;
  const pollingPool = scored.slice(0, attemptLimit);

  const toolProviders = eligible.filter(
    (p) => (p.descriptor.lastProbe?.toolCount ?? 0) > 0 && Boolean(p.tools),
  );

  const requiresLiveTools = TOOL_MANDATORY_INTENTS.includes(req.intent);

  let mode: RouteMode =
    req.routeHint?.mode ??
    (settings.preferredProviderIds.length
      ? 'single'
      : requiresLiveTools && toolProviders.length
        ? 'chain'
        : FANOUT_INTENTS.includes(req.intent) && scored.length > 1
          ? 'fanout'
          : 'single');

  const primary =
    mode === 'fanout' ? pollingPool.slice(0, Math.min(3, pollingPool.length)) : pollingPool.slice(0, 1);
  // The rest of the ranked list — polled one at a time if every primary choice fails.
  const fallback = pollingPool.slice(primary.length);

  return { mode, primary, fallback, toolProviders, ineligible, requiresLiveTools };
}

/* ────────────────────────────── scoring ────────────────────────────── */

function score(p: Provider, req: WolfRequest, dev: DeviceState): ScoredProvider {
  const d = p.descriptor;
  const probe = d.lastProbe!;
  const reasons: string[] = [];
  let s = 0;

  // Pinning is an explicit user override and dominates everything else.
  if (d.pinned || req.routeHint?.providerIds?.includes(d.id)) {
    s += 1000;
    reasons.push('pinned by user (+1000)');
  }

  // Privacy: prefer keeping data closest to the user.
  const privacyPoints = { 'on-device': 120, lan: 70, cloud: 20 }[d.privacyTier];
  s += privacyPoints;
  reasons.push(`privacy tier ${d.privacyTier} (+${privacyPoints})`);

  // Measured latency — real numbers from the last probe, never estimates.
  if (probe.latencyMs != null) {
    const pts = Math.max(0, 100 - probe.latencyMs / 20);
    s += pts;
    reasons.push(`measured latency ${probe.latencyMs}ms (+${pts.toFixed(0)})`);
  }

  // Context window fit against the actual prompt size.
  const approxTokens = Math.ceil(req.text.length / 4);
  const ctx = probe.models[0]?.contextWindow ?? null;
  if (ctx != null) {
    if (ctx < approxTokens * 1.3) {
      s -= 200;
      reasons.push(`context ${ctx} too small for ~${approxTokens} tokens (-200)`);
    } else {
      s += 30;
      reasons.push(`context ${ctx} fits (+30)`);
    }
  }

  // Tool availability matters most for live-fact intents.
  if (probe.toolCount > 0) {
    const pts = TOOL_MANDATORY_INTENTS.includes(req.intent) ? 150 : 40;
    s += pts;
    reasons.push(`${probe.toolCount} live tools (+${pts})`);
  } else if (TOOL_MANDATORY_INTENTS.includes(req.intent)) {
    s -= 250;
    reasons.push('no tools for a live-facts intent (-250)');
  }

  // Streaming keeps the presence layer responsive.
  if (probe.supportsStreaming) {
    s += 25;
    reasons.push('streaming (+25)');
  }

  // Device conditions — do not cook the laptop or burn a metered link.
  if (dev.onBattery && d.privacyTier === 'on-device' && d.device.formFactor !== 'desktop') {
    s -= 40;
    reasons.push('local inference on battery (-40)');
  }
  if (dev.thermalPressure === 'serious' || dev.thermalPressure === 'critical') {
    if (d.privacyTier === 'on-device') {
      s -= 80;
      reasons.push(`thermal ${dev.thermalPressure} (-80)`);
    }
  }
  if (dev.networkMetered && d.privacyTier === 'cloud') {
    s -= 60;
    reasons.push('metered network + cloud provider (-60)');
  }
  if (d.costClass === 'metered-cloud') {
    s -= 15;
    reasons.push('metered cost class (-15)');
  }

  // Reasoning-heavy intents favour larger context windows.
  if ((req.intent === 'analysis' || req.intent === 'strategy') && ctx && ctx >= 100_000) {
    s += 50;
    reasons.push('large context for deep reasoning (+50)');
  }

  return { provider: p, score: s, reasons };
}

/* ─────────────────────── intent classification ─────────────────────── */
/**
 * Deterministic pre-classifier. It only ever ROUTES; it never answers. When it
 * is unsure it returns 'unknown', and the orchestrator asks the top provider to
 * classify — a live call, not a lookup table.
 */
export function preClassify(text: string): { intent: IntentClass; sensitivity: Sensitivity } {
  const t = text.toLowerCase();

  const publicInfo =
    /\b(directions?|how do i get to|navigate|route to|phone number|call\b.*\bnumber|address of|hours|open (now|today|until)|near me|nearest|zip code|store locator)\b/.test(
      t,
    );
  const analysis = /\b(analy[sz]e|compare|break ?down|evaluate|assess|pros and cons|trade-?offs?)\b/.test(t);
  const strategy = /\b(strategy|strategi[sz]e|plan for|roadmap|approach to|how should i .*(handle|tackle))\b/.test(t);
  const advice = /\b(should i|advise|recommend|what would you do|is it worth)\b/.test(t);
  const action = /\b(open|launch|set a|remind me|turn (on|off)|play|send|schedule)\b/.test(t);

  const intent: IntentClass = publicInfo
    ? 'public-info'
    : strategy
      ? 'strategy'
      : analysis
        ? 'analysis'
        : advice
          ? 'advice'
          : action
            ? 'device-action'
            : /\b(what|who|when|where|why|how|define|explain)\b/.test(t)
              ? 'information'
              : 'unknown';

  const confidential =
    /\b(salary|password|ssn|social security|medical|diagnosis|contract|nda|confidential|proprietary|internal only)\b/.test(
      t,
    );
  const personal = /\b(my |mine|our )\b/.test(t);

  return {
    intent,
    sensitivity: confidential ? 'confidential' : personal ? 'personal' : 'public',
  };
}
