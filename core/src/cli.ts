#!/usr/bin/env node
/**
 * WOLFMAN CLI — `wolfman "what time does the Everett DMV close"`
 *
 * Prints the answer plus provenance, or the NO_LIVE_SOURCE report showing every
 * provider that was attempted and exactly why it failed.
 */

import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { discover } from './discovery/index.js';
import { ProviderRegistry } from './providers/registry.js';
import { Orchestrator } from './orchestrator/index.js';
import { preClassify } from './orchestrator/router.js';
import { PresenceStore } from './presence/store.js';
import { AuditLog } from './policy/audit.js';
import { SettingsStore } from './policy/settings.js';
import { LearningProfile } from './policy/profile.js';
import { createNativeTts } from '../../packages/voice/src/nativeTts.js';
import { NoLiveSourceError, type DeviceRef, type WolfRequest } from '@wolfman/protocol';

const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes('--json');
const args = rawArgs.filter((a) => a !== '--json');
const cmd = args[0];
const microsoftAuthRecordFile = path.join(os.homedir(), '.wolfman', 'microsoft-365-copilot-auth.json');

async function loadMicrosoftAuthRecord(): Promise<string | undefined> {
  try {
    const record = JSON.parse(await fs.readFile(microsoftAuthRecordFile, 'utf8')) as { authenticationRecord?: unknown };
    return typeof record.authenticationRecord === 'string' ? record.authenticationRecord : undefined;
  } catch {
    return undefined;
  }
}

async function saveMicrosoftAuthRecord(authenticationRecord: string): Promise<void> {
  await fs.mkdir(path.dirname(microsoftAuthRecordFile), { recursive: true });
  await fs.writeFile(microsoftAuthRecordFile, JSON.stringify({ authenticationRecord }), 'utf8');
}

const device: DeviceRef = {
  id: 'cli',
  name: os.hostname(),
  platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
  formFactor: 'desktop',
  endpoint: null,
  lastSeen: new Date().toISOString(),
};

async function boot() {
  const registry = new ProviderRegistry();
  const candidates = await discover(device);
  const report = await registry.registerAll(candidates, device);
  if (process.env.WOLFMAN_M365_CLIENT_ID && process.env.WOLFMAN_M365_TENANT_ID) {
    const candidate = {
      id: 'microsoft-365-copilot@graph',
      displayName: 'Microsoft 365 Copilot',
      transport: 'native-sdk' as const,
      privacyTier: 'cloud' as const,
      evidence: 'configured Microsoft Entra delegated application',
    };
    candidates.push(candidate);
    const { Microsoft365CopilotProvider } = await import('../../packages/m365-copilot/src/index.js');
    const descriptor = await registry.registerDirect(
      new Microsoft365CopilotProvider(device, await loadMicrosoftAuthRecord()),
      10000,
    );
    if (descriptor.lastProbe?.status === 'available') {
      report.registered.push(descriptor);
    } else {
      report.rejected.push({ candidate, probe: descriptor.lastProbe! });
    }
  }
  return { registry, candidates, report };
}

async function providerOptions() {
  const registry = new ProviderRegistry();
  const candidates = await discover(device);
  const report = await registry.registerAll(candidates, device);
  const options = report.registered.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
  }));
  if (process.env.WOLFMAN_M365_CLIENT_ID && process.env.WOLFMAN_M365_TENANT_ID) {
    options.push({ id: 'microsoft-365-copilot@graph', displayName: 'Microsoft 365 Copilot' });
  }
  return { options, settings: await new SettingsStore(path.join(os.homedir(), '.wolfman', 'settings.json')).load() };
}

async function main() {
  const settingsFile = path.join(os.homedir(), '.wolfman', 'settings.json');

  if (cmd === 'microsoft-auth') {
    if (!process.env.WOLFMAN_M365_CLIENT_ID || !process.env.WOLFMAN_M365_TENANT_ID) {
      throw new Error('Microsoft 365 Copilot is not configured for this Windows user');
    }
    const { Microsoft365CopilotProvider } = await import('../../packages/m365-copilot/src/index.js');
    const authenticationRecord = await new Microsoft365CopilotProvider(device).authenticate(AbortSignal.timeout(120000));
    await saveMicrosoftAuthRecord(authenticationRecord);
    console.log(JSON.stringify({ ok: true }));
    return;
  }

  if (cmd === 'voice') {
    const store = new SettingsStore(settingsFile);
    const settings = await store.load();
    if (args[1] === 'on' || args[1] === 'off') {
      settings.speakRepliesEnabled = args[1] === 'on';
      await store.save(settings);
    }
    console.log(`Speak replies aloud: ${settings.speakRepliesEnabled ? 'on' : 'off'}`);
    return;
  }

  if (cmd === 'silent') {
    const store = new SettingsStore(settingsFile);
    const settings = await store.load();
    if (args[1] === 'on' || args[1] === 'off') {
      settings.silentMode = args[1] === 'on';
      await store.save(settings);
    }
    console.log(jsonMode ? JSON.stringify(settings) : `Silent mode: ${settings.silentMode ? 'on' : 'off'}`);
    return;
  }

  if (cmd === 'settings') {
    const store = new SettingsStore(settingsFile);
    const settings = await store.load();
    if (args[1] === 'provider-routing') {
      const maxProviderAttempts = args[2] === 'all' ? 'all' : Number(args[2]);
      if (maxProviderAttempts !== 'all' && maxProviderAttempts !== 1 && maxProviderAttempts !== 2) {
        throw new Error('provider polling depth must be 1, 2, or all');
      }
      const mode = args[3];
      if (mode !== 'standalone' && mode !== 'mesh' && mode !== 'connected') {
        throw new Error('operating mode must be standalone, mesh, or connected');
      }
      settings.maxProviderAttempts = maxProviderAttempts;
      settings.mode = mode;
      settings.preferredProviderIds = [...new Set(args.slice(4).filter(Boolean))];
      await store.save(settings);
    }
    console.log(jsonMode ? JSON.stringify(settings) : JSON.stringify(settings, null, 2));
    return;
  }

  if (cmd === 'providers') {
    if (args[1] === '--options') {
      console.log(JSON.stringify(await providerOptions()));
      return;
    }
    const { candidates, report } = await boot();
    const settings = await new SettingsStore(settingsFile).load();
    console.log(JSON.stringify({ candidates, ...report, settings }));
    return;
  }

  if (cmd === 'discover' || !cmd) {
    const { candidates, report } = await boot();
    console.log(`\nCandidates found: ${candidates.length}\n`);
    for (const c of candidates) console.log(`  · ${c.displayName}  [${c.transport}]  ${c.evidence}`);
    console.log(`\nLive providers: ${report.registered.length}\n`);
    for (const r of report.registered)
      console.log(`  ✓ ${r.displayName} — ${r.lastProbe?.latencyMs}ms, ${r.lastProbe?.models.length} models, ${r.lastProbe?.toolCount} tools`);
    console.log(`\nRejected: ${report.rejected.length}\n`);
    for (const r of report.rejected)
      console.log(`  ✗ ${r.candidate.displayName} — ${r.probe.failure?.code}: ${r.probe.failure?.message}`);
    return;
  }

  const text = args.join(' ');
  const { registry } = await boot();
  const presence = new PresenceStore();
  presence.subscribe((s) => process.stderr.write(`\r[${s.state}${s.activeProvider ? ' · ' + s.activeProvider : ''}]        `));

  const settingsStore = new SettingsStore(settingsFile);
  const orch = new Orchestrator({
    providers: () => registry.all(),
    deviceState: () => ({ batteryPct: null, onBattery: false, thermalPressure: 'unknown', networkMetered: false }),
    presence,
    audit: new AuditLog(path.join(os.homedir(), '.wolfman', 'audit.jsonl')),
    settings: settingsStore,
    learning: new LearningProfile(path.join(os.homedir(), '.wolfman', 'profile.json')),
    refresh: () => registry.refresh(),
  });

  const cls = preClassify(text);
  const req: WolfRequest = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    text,
    intent: cls.intent,
    sensitivity: cls.sensitivity,
    requiredModalities: ['text'],
    allowStale: false,
    timeoutMs: 90000,
    origin: { device, invocation: 'typed' },
  };

  try {
    const res = await orch.ask(req);
    process.stderr.write('\r' + ' '.repeat(60) + '\r');

    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, text: res.text, provenance: res.provenance, citations: res.citations }));
    } else {
      console.log('\n' + res.text + '\n');
      console.log('— provenance —');
      for (const p of res.provenance)
        console.log(`  ${p.displayName} (${p.model ?? 'n/a'}) ${p.privacyTier} ${p.latencyMs}ms @ ${p.completedAt}`);
      for (const c of res.citations) console.log(`  source: ${c.url} (fetched ${c.fetchedAt})`);
    }

    const settings = await settingsStore.load();
    if (settings.speakRepliesEnabled && !settings.silentMode) {
      try {
        await createNativeTts().speak(res.text, AbortSignal.timeout(60000));
      } catch (speakError) {
        console.error(`(could not speak the reply: ${speakError instanceof Error ? speakError.message : speakError})`);
      }
    }
  } catch (e) {
    process.stderr.write('\r' + ' '.repeat(60) + '\r');
    if (e instanceof NoLiveSourceError) {
      if (jsonMode) {
        console.log(JSON.stringify({ ok: false, ...e.toWire() }));
        return;
      }
      console.error(`\n${e.message}\n\nProviders attempted:`);
      for (const a of e.attempts) console.error(`  ✗ ${a.providerId}: ${a.reason}`);
      process.exit(2);
    }
    throw e;
  }
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
