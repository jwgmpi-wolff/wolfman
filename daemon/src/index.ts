/**
 * WOLFMAN daemon — one per device.
 *
 * Exposes this device's providers to peer devices as an MCP server over mTLS,
 * and advertises itself on the LAN via mDNS (_wolfman._tcp). Offline peers are
 * simply absent from the provider pool; nothing is queued and nothing is faked.
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { discover } from '../../core/src/discovery/index.js';
import { ProviderRegistry } from '../../core/src/providers/registry.js';
import { Orchestrator } from '../../core/src/orchestrator/index.js';
import { PresenceStore } from '../../core/src/presence/store.js';
import { AuditLog } from '../../core/src/policy/audit.js';
import { SettingsStore } from '../../core/src/policy/settings.js';
import { LearningProfile } from '../../core/src/policy/profile.js';
import { preClassify } from '../../core/src/orchestrator/router.js';
import { AzureOpenAIProvider } from './providers/azure-openai.js';
import { NoLiveSourceError, type DeviceRef, type DeviceState, type WolfmanSettings, type WolfRequest } from '@wolfman/protocol';

const DATA_DIR = path.join(os.homedir(), '.wolfman');
const PORT = Number(process.env.WOLFMAN_PORT ?? 8791);

async function deviceRef(): Promise<DeviceRef> {
  const idFile = path.join(DATA_DIR, 'device-id');
  let id: string;
  try {
    id = (await fs.readFile(idFile, 'utf8')).trim();
  } catch {
    id = randomUUID();
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(idFile, id);
  }
  const platform =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return {
    id,
    name: os.hostname(),
    platform,
    formFactor: 'desktop',
    endpoint: null,
    lastSeen: new Date().toISOString(),
  };
}

function deviceState(): DeviceState {
  return {
    batteryPct: null,
    onBattery: false,
    thermalPressure: 'unknown',
    networkMetered: false,
  };
}

export async function main() {
  const device = await deviceRef();
  const presence = new PresenceStore();
  const audit = new AuditLog(path.join(DATA_DIR, 'audit.jsonl'));
  const registry = new ProviderRegistry();

  console.log(`[wolfman] device ${device.name} (${device.platform}) — discovering providers…`);
  const candidates = await discover(device);
  const { registered, rejected } = await registry.registerAll(candidates, device);

  console.log(`[wolfman] ${candidates.length} candidates, ${registered.length} live providers:`);
  for (const r of registered) {
    console.log(`  ✓ ${r.displayName.padEnd(28)} ${r.transport.padEnd(20)} ${r.privacyTier.padEnd(10)} ${r.lastProbe?.latencyMs ?? '?'}ms  models=${r.lastProbe?.models.length ?? 0} tools=${r.lastProbe?.toolCount ?? 0}`);
  }
  for (const r of rejected) {
    console.log(`  ✗ ${r.candidate.displayName.padEnd(28)} ${r.probe.failure?.code}: ${r.probe.failure?.message}`);
  }

  if (AzureOpenAIProvider.isConfigured()) {
    const descriptor = await registry.registerDirect(new AzureOpenAIProvider(device));
    const status = descriptor.lastProbe?.status === 'available' ? '✓' : '✗';
    console.log(`  ${status} ${descriptor.displayName.padEnd(28)} ${descriptor.transport.padEnd(20)} ${descriptor.privacyTier.padEnd(10)} ${descriptor.lastProbe?.latencyMs ?? '?'}ms`);
  }

  const settings = new SettingsStore(path.join(DATA_DIR, 'settings.json'));
  // Operator-set floor for this host's mode (e.g. WOLFMAN_MODE=connected on the
  // hosted Azure daemon so its cloud provider is reachable) — never changes the
  // library default, only this process's persisted settings file.
  if (process.env.WOLFMAN_MODE) {
    const current = await settings.load();
    if (current.mode !== process.env.WOLFMAN_MODE) {
      await settings.save({ ...current, mode: process.env.WOLFMAN_MODE as WolfmanSettings['mode'] });
    }
  }

  const orch = new Orchestrator({
    providers: () => registry.all(),
    deviceState,
    presence,
    audit,
    settings,
    learning: new LearningProfile(path.join(DATA_DIR, 'profile.json')),
    refresh: () => registry.refresh(),
  });

  // MCP surface for peer devices: exposes `wolfman.ask`.
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readBody(req);
    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const reply = (result: unknown, error?: unknown) =>
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) }));

    try {
      if (msg.method === 'initialize') {
        return reply({
          protocolVersion: '2024-11-05',
          serverInfo: { name: `wolfman@${device.name}`, version: '1.0.0' },
          capabilities: { tools: {} },
        });
      }
      if (msg.method === 'tools/list') {
        return reply({
          tools: [
            {
              name: 'wolfman.ask',
              description: `Route a request to the live AI providers on ${device.name}. Returns live output with provenance, or NO_LIVE_SOURCE.`,
              inputSchema: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  intent: { type: 'string' },
                  allowStale: { type: 'boolean' },
                },
                required: ['text'],
              },
            },
            {
              name: 'wolfman.providers',
              description: 'List live providers on this device with their last probe result.',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      }
      if (msg.method === 'tools/call') {
        const { name, arguments: args } = msg.params ?? {};
        if (name === 'wolfman.providers') {
          return reply({
            content: [{ type: 'text', text: JSON.stringify(registry.all().map((p) => p.descriptor), null, 2) }],
          });
        }
        if (name === 'wolfman.ask') {
          const cls = preClassify(args.text);
          const wreq: WolfRequest = {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            text: args.text,
            intent: args.intent ?? cls.intent,
            sensitivity: cls.sensitivity,
            requiredModalities: ['text'],
            allowStale: Boolean(args.allowStale),
            timeoutMs: 60000,
            origin: { device, invocation: 'api' },
          };
          const out = await orch.ask(wreq);
          return reply({
            content: [{ type: 'text', text: out.text }],
            urls: out.citations.map((c) => c.url),
            provenance: out.provenance,
          });
        }
        return reply(null, { code: -32601, message: `unknown tool ${name}` });
      }
      return reply(null, { code: -32601, message: `unknown method ${msg.method}` });
    } catch (e: any) {
      if (e instanceof NoLiveSourceError) {
        return reply(null, { code: -32000, message: e.message, data: e.toWire() });
      }
      return reply(null, { code: -32603, message: String(e?.message ?? e) });
    }
  });

  server.listen(PORT, () => console.log(`[wolfman] MCP endpoint on :${PORT}`));

  // Advertise on the LAN so peer devices can find this node.
  try {
    const { Bonjour } = await import('bonjour-service');
    new Bonjour().publish({ name: `wolfman-${device.name}`, type: 'wolfman', port: PORT });
    console.log('[wolfman] advertised as _wolfman._tcp');
  } catch {
    console.log('[wolfman] mDNS unavailable — peers must be configured manually');
  }

  setInterval(() => void registry.refresh(), 4 * 60 * 1000);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

// Raw string comparison breaks on Windows (backslash paths vs. a file:// URL) — compare real URLs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
