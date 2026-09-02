# Standalone operation

**Wolfman is a complete product on a single device with the radios off.** No Azure subscription, no tenant, no account, no sign-in, no paired desktop, no internet. Put a phone in airplane mode and it still wakes, discovers, routes and answers.

This is enforced, not aspirational: `scripts/policy-check.mjs` fails the build if any Azure SDK, identity/Graph SDK, cloud provider SDK, remote telemetry exporter or cloud backend appears as an import in `core/` or as a hard dependency in any manifest.

## "Live" means *now*, not *cloud*

The no-mock rule and offline operation are not in tension. Live means **executed at request time**, not **executed remotely**. An on-device model inference performed the moment you ask is a live call. A cached string is not — and never becomes one.

## Operating modes

Wolfman ships **closed**. You opt in to leaving the device, not out of it.

| Mode | Eligible providers | Network |
|---|---|---|
| `standalone` *(default)* | this device only | none |
| `mesh` | this device + paired LAN peers | LAN only |
| `connected` | everything, including internet tools | full |

`lockToDevice` is a master kill switch that pins you to `on-device` regardless of mode, pinning, or per-request consent, and survives restarts.

Mode is applied **before** scoring. In standalone mode a cloud provider isn't a low-scoring option — it isn't an option at all, and it appears in the ineligible list with the reason.

## What actually works offline

| Intent | Offline | Why |
|---|---|---|
| Advice | **Full** | Reasoning over what you supply needs no network |
| Analysis | **Full** | Same |
| Strategy | **Full** | Same |
| Device action | **Full** | Local control needs no network |
| Information | **Degraded** | Answered from the local model's training data, and **banner-labelled as unverified** |
| Public info | **Unavailable** | Directions, phone numbers, addresses and hours change — offline, Wolfman returns `NO_LIVE_SOURCE` rather than guessing from stale weights |

That last row is the deliberate one. Answering "what's the number for the Everett DMV" from model weights is exactly the failure this project exists to prevent, and going offline doesn't earn an exemption. You get an honest refusal that names the mode.

When an `information` request runs with nothing to verify against, the answer is prefixed with:

> ⚠︎ Offline — answered from the on-device model's own knowledge with no live source to verify it against. Treat anything time-sensitive as unconfirmed.

## Making a handset self-sufficient

`apps/android/OnDeviceRuntime.kt` is the fallback of last resort: llama.cpp via JNI, bundled as a native lib, running GGUF weights from app storage. If the phone has no other AI app installed and no peer is reachable, this answers.

- Drop a `.gguf` into `Android/data/com.wolfman/files/models/`.
- `canRun()` checks real RAM and storage headroom before loading — refusing up front beats an OOM kill mid-answer.
- `probe()` loads the model and confirms it emits a token, returning a **measured** latency. Same contract as every desktop provider.
- GPU offload via OpenCL/Vulkan on Android 12+, CPU path otherwise.

`assessStandalone()` answers the only question that matters in a dead zone — *can this device do anything useful right now?* — and lists concrete blockers if not.

## Voice offline

Wake word (openWakeWord/Porcupine), STT (Whisper.cpp) and TTS all run on-device. Voice invocation never requires a network service, and `assessStandalone()` flags it as a blocker if any of the three would.

## Peer devices are a bonus, never a requirement

Mesh mode lets your phone borrow the desktop's larger model over mTLS on the LAN. When the desktop is asleep or you're away from home, it is simply absent from the provider pool. Nothing queues, nothing degrades silently, and nothing fails except the specific capability that genuinely needed it.
