/**
 * WOLFMAN — standalone capability assessment.
 *
 * Answers the only question that matters in a dead zone: can this device do
 * anything useful right now? Every blocker named here is concrete and
 * actionable, never a vague "something is wrong".
 */

import type { Provider, WolfmanSettings } from '@wolfman/protocol';

export interface VoiceReadiness {
  wakeWordOnDevice: boolean;
  sttOnDevice: boolean;
  ttsOnDevice: boolean;
}

export interface StandaloneAssessment {
  capable: boolean;
  blockers: string[];
}

/**
 * `providers` must already reflect the current live probe results — this
 * function performs no I/O of its own.
 */
export function assessStandalone(
  providers: Provider[],
  settings: WolfmanSettings,
  voice?: VoiceReadiness,
): StandaloneAssessment {
  const blockers: string[] = [];

  const onDevice = providers.filter(
    (p) => p.descriptor.privacyTier === 'on-device' && p.descriptor.lastProbe?.status === 'available',
  );
  if (!onDevice.length) {
    blockers.push(
      'no on-device provider passed a live probe — start a local model runtime (Ollama, LM Studio) or install the bundled on-device runtime',
    );
  }

  if (settings.mode === 'connected') {
    blockers.push('operating mode is "connected" — set it to "standalone" to guarantee no network egress');
  }

  if (voice) {
    if (!voice.wakeWordOnDevice) blockers.push('wake-word spotter requires network — voice invocation will not work offline');
    if (!voice.sttOnDevice) blockers.push('speech-to-text requires network — voice invocation will not work offline');
    if (!voice.ttsOnDevice) blockers.push('text-to-speech requires network — spoken replies will not work offline');
  }

  return { capable: onDevice.length > 0, blockers };
}
