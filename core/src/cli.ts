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

const args = process.argv.slice(2);
const cmd = args[0];

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
  return { registry, candidates, report };
}

async function main() {
  if (cmd === 'voice') {
    const settingsFile = path.join(os.homedir(), '.wolfman', 'settings.json');
    const store = new SettingsStore(settingsFile);
    const settings = await store.load();
    if (args[1] === 'on' || args[1] === 'off') {
      settings.speakRepliesEnabled = args[1] === 'on';
      await store.save(settings);
    }
    console.log(`Speak replies aloud: ${settings.speakRepliesEnabled ? 'on' : 'off'}`);
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

  const settingsStore = new SettingsStore(path.join(os.homedir(), '.wolfman', 'settings.json'));
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
    console.log('\n' + res.text + '\n');
    console.log('— provenance —');
    for (const p of res.provenance)
      console.log(`  ${p.displayName} (${p.model ?? 'n/a'}) ${p.privacyTier} ${p.latencyMs}ms @ ${p.completedAt}`);
    for (const c of res.citations) console.log(`  source: ${c.url} (fetched ${c.fetchedAt})`);

    const settings = await settingsStore.load();
    if (settings.speakRepliesEnabled) {
      try {
        await createNativeTts().speak(res.text, AbortSignal.timeout(60000));
      } catch (speakError) {
        console.error(`(could not speak the reply: ${speakError instanceof Error ? speakError.message : speakError})`);
      }
    }
  } catch (e) {
    process.stderr.write('\r' + ' '.repeat(60) + '\r');
    if (e instanceof NoLiveSourceError) {
      console.error(`\n${e.message}\n\nProviders attempted:`);
      for (const a of e.attempts) console.error(`  ✗ ${a.providerId}: ${a.reason}`);
      process.exit(2);
    }
    throw e;
  }
}

void main();
