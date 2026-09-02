# Writing a Wolfman adapter

Adapters are the only place that knows how to talk to a specific AI app. The
router, orchestrator and UI never change when you add one.

```ts
import { registerAdapter } from '../providers/registry.js';

registerAdapter({
  priority: 50,                                   // higher wins if several claim
  claims: (c) => /myapp/i.test(c.displayName),    // cheap + synchronous
  create: (c, device) => new MyProvider(c, device),
});
```

Your `Provider` must honour three contracts:

1. **`probe()` performs real I/O.** Return `available` only after the remote side
   answered. Return `failedProbe(code, message)` with a message the user can act
   on — "start the server", "enable API mode", "sign in" — not a generic error.
2. **`invoke()` streams, or throws `NoLiveSourceError`.** Never return a
   synthesised string. Never swallow an error and emit fallback text.
3. **Respect `AbortSignal`** on every network call.

Built-in adapters, in priority order:

| Priority | Adapter | Covers |
|---|---|---|
| 60 | `McpHttpProvider` | Peer Wolfman nodes, remote MCP servers |
| 55 | `McpStdioProvider` | Local MCP tool servers from existing `mcp.json` configs |
| 50 | `OpenAICompatibleProvider` | Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan, GPT4All |
| 40 | `AndroidIntentProvider` | OS assistant + intent-addressable apps |
| 10 | `InertNativeProvider` | Detected apps with no programmable surface — registered `unavailable` with the reason so the UI can tell the user what to enable |
