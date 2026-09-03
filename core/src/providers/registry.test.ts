import assert from 'node:assert/strict';
import test from 'node:test';

import type { DeviceRef, Provider } from '@wolfman/protocol';
import { ProviderRegistry } from './registry.js';

const device: DeviceRef = {
  id: 'test-device',
  name: 'Test Device',
  platform: 'windows',
  formFactor: 'desktop',
  endpoint: null,
  lastSeen: new Date().toISOString(),
};

test('registerDirect enforces its deadline when a provider ignores abort', async () => {
  let signal: AbortSignal | undefined;
  const provider: Provider = {
    descriptor: {
      id: 'stalled-provider',
      displayName: 'Stalled Provider',
      device,
      transport: 'native-sdk',
      privacyTier: 'cloud',
      modalities: ['text'],
      costClass: 'metered-cloud',
      pinned: false,
      lastProbe: null,
    },
    probe: async (probeSignal) => {
      signal = probeSignal;
      return await new Promise(() => {});
    },
    async *invoke() {
      yield { type: 'done' };
    },
  };

  const started = Date.now();
  const descriptor = await new ProviderRegistry().registerDirect(provider, 20);

  assert.equal(descriptor.lastProbe?.failure?.code, 'PROBE_TIMEOUT');
  assert.equal(signal?.aborted, true);
  assert.ok(Date.now() - started < 500);
});