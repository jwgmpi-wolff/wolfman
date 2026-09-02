/**
 * WOLFMAN — shared wire protocol & provider contract.
 * Everything in core/, daemon/ and apps/ depends on this package and nothing else.
 *
 * POLICY: no type in this file may describe a mocked, sampled, canned or seeded
 * response. Provenance is mandatory on every answer.
 */

export const WOLFMAN_PROTOCOL_VERSION = '1.0.0';
export const WAKE_WORD = 'wolfman';

/* ────────────────────────────── devices ────────────────────────────── */

export type Platform = 'windows' | 'macos' | 'android' | 'ipados' | 'linux';

export interface DeviceRef {
  /** stable uuid persisted in the device keystore */
  id: string;
  name: string;
  platform: Platform;
  formFactor: 'desktop' | 'laptop' | 'phone' | 'tablet';
  /** null when the device is this device */
  endpoint: string | null;
  lastSeen: string | null; // ISO-8601, null = never reached
}

export interface DeviceState {
  batteryPct: number | null;
  onBattery: boolean;
  thermalPressure: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
  networkMetered: boolean;
}

/* ───────────────────────────── operating mode ──────────────────────────── */
/**
 * Wolfman ships closed. `standalone` is the default and requires no network,
 * no account and no paired device at all. Mode is applied BEFORE scoring: in
 * `standalone` a cloud provider is not a low-scoring option, it is not an
 * option, full stop.
 */
export type OperatingMode = 'standalone' | 'mesh' | 'connected';

/** Persisted, device-local settings. Never uploaded, survives restarts. */
export interface WolfmanSettings {
  mode: OperatingMode;
  /** Master kill switch: pins every request to on-device regardless of mode, pinning, or per-request consent. */
  lockToDevice: boolean;
  /** Opt-out: local, incremental learning from real requests (topics, phrasing, provider choice). */
  learningEnabled: boolean;
  /** Opt-in: read every answer aloud through an on-device TTS engine as it's delivered. */
  speakRepliesEnabled: boolean;
}

export const DEFAULT_WOLFMAN_SETTINGS: WolfmanSettings = {
  mode: 'standalone',
  lockToDevice: false,
  learningEnabled: true,
  speakRepliesEnabled: false,
};

/** Prefixed onto an `information` answer with no live source to verify it against. */
export const OFFLINE_INFORMATION_BANNER =
  "\u26a0\ufe0e Offline — answered from the on-device model's own knowledge with no live source to verify it against. Treat anything time-sensitive as unconfirmed.";

/* ───────────────────────────── learned style profile ──────────────────────────── */
/**
 * Derived, incrementally, from real past requests on THIS device — never
 * uploaded, never seeded, never static. This is phrasing/preference metadata
 * ONLY: it may steer how an answer is worded or which provider is tried first,
 * and must NEVER be treated as a source of factual content or substituted for
 * a live provider call. `enforceNoMock` has no awareness of this type on
 * purpose — it cannot become an answer.
 */
export interface StyleProfileSnapshot {
  interactionCount: number;
  topTopics: { term: string; count: number }[];
  intentMix: Partial<Record<IntentClass, number>>;
  preferredProviders: { providerId: string; uses: number }[];
  avgRequestLength: number;
  updatedAt: string | null;
}

/* ───────────────────────────── providers ───────────────────────────── */

export type Transport =
  | 'mcp-stdio'
  | 'mcp-http'
  | 'openai-compatible'
  | 'intent'          // Android implicit intent / OS assistant handoff
  | 'accessibility'   // last resort UI automation bridge
  | 'native-sdk';

export type PrivacyTier = 'on-device' | 'lan' | 'cloud';

export type Modality = 'text' | 'vision' | 'audio-in' | 'audio-out' | 'tools';

export type ProviderStatus =
  | 'available'      // live handshake succeeded within the freshness window
  | 'unavailable'    // detected on disk but handshake failed
  | 'unauthorized'   // reachable, needs credentials
  | 'probing';

export interface ModelRef {
  id: string;
  contextWindow: number | null;
  modalities: Modality[];
}

/** Result of a REAL handshake. Never synthesised. */
export interface ProbeResult {
  status: ProviderStatus;
  probedAt: string;                 // ISO-8601, wall clock of the actual call
  latencyMs: number | null;         // measured, not estimated
  models: ModelRef[];
  supportsStreaming: boolean;
  toolCount: number;
  failure?: { code: string; message: string };
}

export interface ProviderDescriptor {
  id: string;                       // e.g. "ollama@desktop-01"
  displayName: string;
  device: DeviceRef;
  transport: Transport;
  privacyTier: PrivacyTier;
  modalities: Modality[];
  costClass: 'free-local' | 'lan' | 'metered-cloud';
  pinned: boolean;
  lastProbe: ProbeResult | null;
}

export interface Provider {
  readonly descriptor: ProviderDescriptor;
  /** Executes a live handshake. MUST perform I/O. MUST NOT return cached data. */
  probe(signal: AbortSignal): Promise<ProbeResult>;
  /** Streams a live completion. MUST throw NoLiveSourceError rather than fabricate. */
  invoke(req: WolfRequest, signal: AbortSignal): AsyncIterable<Chunk>;
  /** MCP tools exposed by this provider, fetched live. */
  tools?(signal: AbortSignal): Promise<McpTool[]>;
  dispose?(): Promise<void>;
}

/* ────────────────────────────── requests ───────────────────────────── */

export type IntentClass =
  | 'information'
  | 'advice'
  | 'analysis'
  | 'strategy'
  | 'public-info'    // directions, phone numbers, hours, addresses
  | 'device-action'
  | 'unknown';

export type Sensitivity = 'public' | 'personal' | 'confidential';

export type RouteMode = 'single' | 'fanout' | 'chain';

export interface WolfRequest {
  id: string;
  createdAt: string;
  text: string;
  attachments?: Attachment[];
  intent: IntentClass;
  sensitivity: Sensitivity;
  requiredModalities: Modality[];
  /** false = never return cached content. Default false. */
  allowStale: boolean;
  /** hard ceiling; the orchestrator aborts every in-flight call at this point */
  timeoutMs: number;
  routeHint?: { mode?: RouteMode; providerIds?: string[] };
  origin: { device: DeviceRef; invocation: InvocationSource };
}

export type InvocationSource =
  | 'wake-word'
  | 'hotkey'
  | 'tray'
  | 'tile'
  | 'bubble'
  | 'typed'
  | 'api';

export interface Attachment {
  kind: 'image' | 'audio' | 'file';
  mime: string;
  bytes?: Uint8Array;
  path?: string;
}

/* ────────────────────────────── responses ──────────────────────────── */

export type Chunk =
  | { type: 'delta'; text: string }
  | { type: 'tool-call'; call: ToolCallRecord }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; usage?: Usage };

export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Proof that the answer came from a live call. Required on every response. */
export interface Provenance {
  providerId: string;
  displayName: string;
  deviceId: string;
  model: string | null;
  privacyTier: PrivacyTier;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  toolCalls: ToolCallRecord[];
  /** true only when allowStale was explicitly enabled by the user */
  servedFromCache: false | { capturedAt: string };
}

export interface ToolCallRecord {
  server: string;
  tool: string;
  args: unknown;
  /** live URLs actually fetched — surfaced for public-info answers */
  urls: string[];
  startedAt: string;
  completedAt: string;
  ok: boolean;
  error?: string;
}

export interface WolfResponse {
  requestId: string;
  text: string;
  provenance: Provenance[];
  /** populated in fanout mode */
  consensus?: {
    agreements: string[];
    divergences: { providerId: string; claim: string }[];
  };
  citations: Citation[];
}

export interface Citation {
  url: string;
  title: string | null;
  fetchedAt: string;
}

/* ─────────────────────────── failure states ────────────────────────── */

export const NO_LIVE_SOURCE = 'NO_LIVE_SOURCE';

export interface AttemptRecord {
  providerId: string;
  reason: string;
  at: string;
}

export class NoLiveSourceError extends Error {
  readonly code = NO_LIVE_SOURCE;
  constructor(readonly reason: string, readonly attempts: AttemptRecord[]) {
    super(`${NO_LIVE_SOURCE}: ${reason}`);
    this.name = 'NoLiveSourceError';
  }
  toWire() {
    return { code: this.code, reason: this.reason, attempts: this.attempts };
  }
}

/* ───────────────────────────── MCP surface ─────────────────────────── */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: string;
}

export interface McpServerRef {
  id: string;
  transport: 'stdio' | 'http-sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  privacyTier: PrivacyTier;
}

/* ───────────────────────────── presence ────────────────────────────── */

export type PresenceState =
  | 'idle'
  | 'armed'
  | 'listening'
  | 'thinking'
  | 'rendering'
  | 'speaking'
  | 'error';

export interface PresenceSnapshot {
  state: PresenceState;
  voiceEnabled: boolean;
  /** 0..1 mic level, only meaningful while listening with voice on */
  level: number;
  activeProvider: string | null;
  message: string | null;
  since: string;
}

/* ───────────────────────────── audit log ──────────────────────────── */

export interface AuditEntry {
  requestId: string;
  at: string;
  text: string;
  intent: IntentClass;
  sensitivity: Sensitivity;
  routeMode: RouteMode;
  attempted: AttemptRecord[];
  used: Provenance[];
  egress: { host: string; privacyTier: PrivacyTier; redactedFields: string[] }[];
  outcome: 'ok' | 'no-live-source' | 'aborted' | 'error';
}
