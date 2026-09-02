# WOLFMAN

A personal, cross-device AI orchestrator. It discovers the AI apps and model runtimes **already installed** on your Windows PC, Mac, Android phone and tablets, registers each one as a live provider, and becomes the single interface to all of them. Call it by name — **"wolfman"** — or use a hotkey.

It answers questions, gives advice, runs analysis, works through strategy, and looks up general public information (directions, phone numbers, hours, addresses).

## The two rules

**1. Everything is live.** Every answer comes from a call executed at request time — a model inference, an MCP tool call, or a web fetch. There are no canned answers, no sample data, no fixtures, no seeded records anywhere in this codebase. When nothing is reachable, Wolfman returns `NO_LIVE_SOURCE` with the full list of providers it tried and exactly why each one failed. It never fills the gap from memory.

**2. Nothing is assumed.** A provider is registered only after a real handshake succeeds. Detected-but-unusable apps are surfaced with the reason (`NO_PROGRAMMABLE_SURFACE`, `UNAUTHORIZED`, `MCP_INITIALIZE_FAILED`) so you know what to enable.

`npm run policy:check` enforces rule 1 mechanically and fails the build if a mock, sample, canned or purged-domain path is reintroduced — including any Azure/cloud SDK import inside `core/`, since [standalone operation](docs/STANDALONE.md) is a structural guarantee, not a convention.

## Quick start

```bash
npm install
npm run build      # policy gate, then compiles packages/protocol, then everything else
npm run discover    # prints what is ACTUALLY on this machine
npm run ask -- "what time does the Everett DMV close today"
npm run voice on    # read every answer aloud via the OS's built-in TTS
npm run daemon      # expose this device to your other devices
```

`npm run discover` prints three sections: candidates found, providers that passed a live probe, and providers that were rejected with the specific failure. Nothing is invented.

## Architecture

```
Wake layer      hotword "wolfman" | hotkey | tray | tile | bubble
Presence layer  listening indicator — parallel voice-ON / voice-OFF paths
Orchestrator    classify -> plan -> gather live facts -> execute -> poll fallback -> merge -> provenance
MCP host        stdio + HTTP/SSE clients, tool registry, ACLs
Adapters        local runtimes | installed apps | OS assistants | peer devices
Transport       loopback + LAN mesh over mTLS
```

| Path | What lives there |
|---|---|
| `packages/protocol/src/index.ts` | Wire types + the `Provider` contract. Everything depends on this and nothing else. |
| `packages/voice/src/` | Wake-word/VAD pipeline contract, plus the real on-device TTS engine (`nativeTts.ts`). |
| `core/src/discovery/index.ts` | Real OS probes: registry/AppX/processes (Windows), bundles/Spotlight/launchd/brew (macOS), PackageManager (Android), loopback port scan, mDNS, existing MCP config files. |
| `core/src/providers/registry.ts` | Self-registering adapters. Adding a new AI app touches zero router code. |
| `core/src/orchestrator/router.ts` | Per-request scoring: operating mode, privacy tier, measured latency, context fit, tools, battery/thermal/metered state. Exposes the full ranked fallback chain. |
| `core/src/orchestrator/index.ts` | Execution, live-fact chaining, polling the fallback chain until something answers, provenance, `NO_LIVE_SOURCE`. |
| `core/src/policy/` | No-mock enforcement, redaction, settings (mode/lockToDevice), the local learning profile, append-only audit log. |
| `core/src/presence/store.ts` | One state machine driving every platform's indicator. |
| `core/src/cli.ts` | `discover`, `ask`, and `voice on\|off`. |
| `daemon/`, `apps/` | LAN mesh node, per-platform hosts (Android on-device runtime scaffold under `apps/android/`). |

See [docs/BUILD_PROMPT.md](docs/BUILD_PROMPT.md), [docs/ADAPTERS.md](docs/ADAPTERS.md) and [docs/STANDALONE.md](docs/STANDALONE.md) for the full design.

## Provider discovery

| OS | Probe |
|---|---|
| Windows | Uninstall registry hives, AppX/MSIX manifests, running processes, `%LOCALAPPDATA%\Programs` + Program Files |
| macOS | `/Applications` + `~/Applications`, Spotlight bundle query, `launchctl list`, Homebrew formulae |
| Android | `RoleManager.ROLE_ASSISTANT`, assist/voice intent filters, `ACTION_PROCESS_TEXT` handlers, installed packages |
| All | Loopback ports (11434, 1234, 8080, 8000, 5000, 4891, 3000…), mDNS `_wolfman._tcp` / `_mcp._tcp`, existing `mcp.json` configs |

Name matching only produces a *candidate*. Registration requires a live handshake, so a false positive costs one failed probe and nothing more.

## Routing

Every eligible provider is scored per request. Operating mode (`standalone` default / `mesh` / `connected`) and `lockToDevice` are applied **before** scoring — see [docs/STANDALONE.md](docs/STANDALONE.md). If the top choice can't answer, Wolfman polls the rest of the ranked list one at a time until one resolves the request or every provider has been tried.

- **Privacy first** — `on-device` (+120) > `lan` (+70) > `cloud` (+20).
- **Measured latency**, not estimates — taken from the last real probe.
- **Context-window fit** against the actual prompt size.
- **Tool availability** — required for public-info intents (directions, phone numbers, hours, addresses), which are always forced through a live tool call and carry a source URL + fetch timestamp.

Modes: **single**, **fan-out** (parallel, disagreements surfaced rather than averaged away), **chain** (a tool provider fetches live facts, a reasoning provider synthesises them).

## Local learning

Wolfman adapts to you from real usage: recurring topics, typical request length, which providers you keep coming back to (`core/src/policy/profile.ts`). This is phrasing/preference guidance only — it can steer wording or provider order, but it is never a source of factual content and never substitutes for a live call. Disable it any time by setting `learningEnabled: false` in `~/.wolfman/settings.json`.

## Privacy

Pre-wake-word audio lives in a fixed-size ring buffer that is continuously overwritten, never persisted. Redaction (emails, phones, SSNs, cards, API keys, JWTs, GUIDs) runs before any cloud call; on-device providers get the text untouched. The audit log — request, providers attempted, tools called, timestamps, egress destinations — is append-only JSONL on your device (`~/.wolfman/audit.jsonl`) and is never uploaded.

## Cross-device mesh

Each device runs the daemon, exposing `wolfman.ask` and `wolfman.providers` over MCP. Peers are found via mDNS, paired once with a short code, then talk over mTLS with pinned certs. Offline devices are simply absent from the pool — nothing is queued and nothing is faked.

