import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_WOLFMAN_SETTINGS,
  type DeviceRef,
  type PrivacyTier,
  type Provider,
  type WolfRequest,
  type WolfmanSettings,
} from '@wolfman/protocol';
import { plan } from './router.js';

const device: DeviceRef = {
  id: 'test-device',
  name: 'Test Device',
  platform: 'windows',
  formFactor: 'desktop',
  endpoint: null,
  lastSeen: new Date().toISOString(),
};

function provider(id: string, privacyTier: PrivacyTier = 'cloud', available = true): Provider {
  const probe = {
    status: available ? 'available' as const : 'unavailable' as const,
    probedAt: new Date().toISOString(),
    latencyMs: id === 'local' ? 1 : 100,
    models: [],
    supportsStreaming: true,
    toolCount: 0,
  };
  return {
    descriptor: {
      id,
      displayName: id,
      device,
      transport: privacyTier === 'on-device' ? 'mcp-stdio' : 'openai-compatible',
      privacyTier,
      modalities: ['text'],
      costClass: privacyTier === 'cloud' ? 'metered-cloud' : 'free-local',
      pinned: false,
      lastProbe: probe,
    },
    probe: async () => probe,
    async *invoke() {
      yield { type: 'done' };
    },
  };
}

function request(sensitivity: WolfRequest['sensitivity'] = 'public'): WolfRequest {
  return {
    id: 'request',
    createdAt: new Date().toISOString(),
    text: 'answer this',
    intent: 'information',
    sensitivity,
    requiredModalities: ['text'],
    allowStale: false,
    timeoutMs: 1000,
    origin: { device, invocation: 'typed' },
  };
}

function settings(maxProviderAttempts: WolfmanSettings['maxProviderAttempts']): WolfmanSettings {
  return {
    ...DEFAULT_WOLFMAN_SETTINGS,
    mode: 'connected',
    preferredProviderIds: ['copilot', 'second'],
    maxProviderAttempts,
  };
}

const deviceState = {
  batteryPct: null,
  onBattery: false,
  thermalPressure: 'unknown' as const,
  networkMetered: false,
};

test('uses preferred order and honors attempt limits', () => {
  const providers = [provider('local', 'on-device'), provider('second'), provider('copilot')];

  const one = plan(request(), providers, deviceState, settings(1));
  assert.deepEqual(one.primary.map((item) => item.provider.descriptor.id), ['copilot']);
  assert.deepEqual(one.fallback, []);

  const two = plan(request(), providers, deviceState, settings(2));
  assert.deepEqual(two.primary.map((item) => item.provider.descriptor.id), ['copilot']);
  assert.deepEqual(two.fallback.map((item) => item.provider.descriptor.id), ['second']);

  const all = plan(request(), providers, deviceState, settings('all'));
  assert.deepEqual(all.fallback.map((item) => item.provider.descriptor.id), ['second', 'local']);
});

test('skips unavailable and privacy-ineligible preferred providers', () => {
  const unavailable = plan(
    request(),
    [provider('copilot', 'cloud', false), provider('second'), provider('local', 'on-device')],
    deviceState,
    settings('all'),
  );
  assert.equal(unavailable.primary[0]?.provider.descriptor.id, 'second');

  const confidential = plan(
    request('confidential'),
    [provider('copilot'), provider('second'), provider('local', 'on-device')],
    deviceState,
    settings('all'),
  );
  assert.equal(confidential.primary[0]?.provider.descriptor.id, 'local');
  assert.deepEqual(confidential.fallback, []);
  assert.deepEqual(confidential.ineligible.map((item) => item.providerId).sort(), ['copilot', 'second']);
});
