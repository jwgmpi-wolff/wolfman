# WOLFMAN — VS Code / GitHub Copilot build prompt

> Paste into Copilot Chat, or save as `.github/copilot-instructions.md`, then say:
> **"Build the Wolfman project per this spec, starting with the repo scaffold."**

## 0. HARD RESET FROM THE PRIOR ATTEMPT

The previous attempt is void. Apply these before writing any code.

**PURGE — do not carry forward, do not re-suggest, do not scaffold:**
- Budget tracking, transaction ledgers, expense categorisation, receipts, account balances
- Any finance/personal-finance module, schema, table or UI tab
- Pre-canned forms, wizard screens, fixed-field input templates
- Sample data, seed data, demo records, fixture JSON, mock responses, `example_*` files
- Hardcoded canned answers, static FAQ maps, stubbed reply strings
- Onboarding surveys and profile questionnaires

**NO-MOCK RULE (non-negotiable):**
- Every answer returned to the user originates from a call executed at request time — a model inference, an MCP tool call, or a live web/API fetch.
- If no live source is reachable, return `NO_LIVE_SOURCE: <reason>` plus every provider attempted and why each failed. Never fabricate. Never fall back to cached filler. Never emit a placeholder.
- Cached data may only be returned when labelled with its capture timestamp AND the user has set `allow_stale=true`. Default is `false`.
- Tests hit real endpoints or are tagged `@integration` and skipped. Do not create fixtures to simulate answers.
- `scripts/policy-check.mjs` enforces this at build time and must stay in the `build` script.

**Structural break:** this is not a form-driven app. It is a conversational, wake-word-invoked orchestrator that owns no domain data of its own — a router and aggregator over whatever AI providers exist on the device.

## 1. WHAT WOLFMAN IS

- **Wake word / name:** `wolfman`
- **Devices:** Windows, macOS, Android, tablets
- **Role:** an MCP host that discovers the AI apps and runtimes present on each device, registers them as callable providers, and routes each request to the best one — or fans out and merges.
- **Request types:** information, advice, analysis, strategy, and general public info (directions, phone numbers, hours, addresses).

## 2. STACK & LAYOUT

TypeScript for `core/`, `daemon/`, desktop (Tauri). Kotlin for Android. Swift shims on macOS only where OS APIs demand it.

```
wolfman/
  packages/protocol/   # shared types + Provider contract
  packages/voice/      # wake word, VAD, STT/TTS
  core/src/{discovery,providers,mcp,orchestrator,presence,policy}
  daemon/              # per-device MCP node on the LAN
  apps/{windows,macos,android,tablet}
  scripts/policy-check.mjs
```

## 3. DISCOVERY — build this first, it is the differentiator

Probe reality; never assume. Windows: uninstall registry hives, AppX manifests, running processes, program folders. macOS: `/Applications` + `~/Applications`, Spotlight, `launchctl`, Homebrew. Android: `RoleManager.ROLE_ASSISTANT`, assist/voice intent filters, `ACTION_PROCESS_TEXT`, installed packages. All platforms: loopback port scan, mDNS `_wolfman._tcp` / `_mcp._tcp`, and reuse of existing `mcp.json` configs.

Every candidate gets a live handshake — MCP `initialize`, `/v1/models`, or intent resolution — recording transport, auth, models, streaming support, context window, modality, **measured** latency, cost class and privacy tier. A candidate that fails is registered `unavailable` with the reason, never with assumed capabilities.

```ts
interface Provider {
  readonly descriptor: ProviderDescriptor;
  probe(signal: AbortSignal): Promise<ProbeResult>;          // must perform I/O
  invoke(req: WolfRequest, signal: AbortSignal): AsyncIterable<Chunk>;
  tools?(signal: AbortSignal): Promise<McpTool[]>;
}
```

Adapters self-register into `core/src/providers/`. Adding a new AI app must require **zero** router changes.

## 4. ROUTING

Score every eligible provider per request on: intent class, required modality, privacy tier vs request sensitivity, measured latency, context-window fit, tool availability, battery/thermal/metered state, user pinning.

Modes — **single**, **fan-out** (parallel, merged, disagreements surfaced not averaged), **chain** (tools fetch live facts, a reasoning model synthesises).

Every response carries provenance: which providers, which models, which tools and URLs, and the wall-clock timestamp of each live call. Public-info intents must route through a live tool call and attach source URL + fetch time.

## 5. WAKE + PRESENCE

Voice ON: on-device wake-word spotter for "wolfman" (Porcupine / openWakeWord). Pre-trigger audio stays in a ring buffer, never persisted. Voice OFF: global hotkey, tray/menubar, Android quick-settings tile and floating bubble, typed input.

State machine `idle → armed → listening → thinking → rendering → speaking → idle`, driven by one shared `PresenceStore`.

| State | Voice ON | Voice OFF |
|---|---|---|
| armed | dim ring | dim tray icon |
| listening | pulsing ring + waveform + chime | pulsing input border, animated caret, tray colour shift, haptic |
| thinking | rotating ring + provider name | spinner + provider name |
| rendering | streaming tokens | streaming tokens |

Voice OFF must be fully usable with audio hardware disabled and screen-reader compatible.

## 6. MESH

Each device runs the daemon exposing `wolfman.ask` and `wolfman.providers` over MCP. mDNS discovery, one-time short-code pairing, then mTLS with pinned certs. Session state syncs via a CRDT log. Offline devices are absent from the pool — no queuing of fake results.

## 7. PRIVACY

Prefer `on-device > lan > cloud`. Cloud egress needs per-session consent. Redact before any cloud call and log what was redacted. All pre-wake audio is local and non-persistent. Append-only local audit log, never uploaded.

## 8. BUILD ORDER

protocol → discovery → MCP host + adapters → orchestrator → policy gate → presence + voice → Windows → macOS → daemon/mesh → Android → live integration tests + audit viewer.

## 9. RULES FOR YOU, THE CODING AGENT

- Never scaffold anything from the Section 0 purge list, even if it seems generically useful.
- Never write mock providers, fake latency or placeholder answers to make a UI demoable. Wire the real adapter or leave the surface empty with an explicit `NO_LIVE_SOURCE` state.
- Never assume a provider exists. Detect it, probe it, register it.
- Stream everywhere. Every network/model call takes an `AbortSignal` and a timeout.
- Ask before adding any dependency that phones home.
- Deliver working code per step, then stop and report what was actually detected and executed on the real machine.
