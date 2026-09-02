/**
 * WOLFMAN — presence state machine.
 *
 * ONE store drives the listening indicator on every platform so Windows, macOS
 * and Android behave identically. The voice-OFF path is a first-class citizen:
 * every state must be expressible with no audio hardware at all.
 */

import type { PresenceSnapshot, PresenceState } from '@wolfman/protocol';

type Listener = (s: PresenceSnapshot) => void;

const LEGAL: Record<PresenceState, PresenceState[]> = {
  idle:      ['armed', 'listening', 'thinking', 'error'],
  armed:     ['listening', 'idle', 'thinking', 'error'],
  listening: ['thinking', 'idle', 'error'],
  thinking:  ['rendering', 'speaking', 'idle', 'error'],
  rendering: ['speaking', 'idle', 'error'],
  speaking:  ['idle', 'error'],
  error:     ['idle', 'armed'],
};

export class PresenceStore {
  private snap: PresenceSnapshot = {
    state: 'idle',
    voiceEnabled: false,
    level: 0,
    activeProvider: null,
    message: null,
    since: new Date().toISOString(),
  };
  private listeners = new Set<Listener>();
  private streamBuf = '';

  get(): PresenceSnapshot {
    return { ...this.snap };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.get());
    return () => this.listeners.delete(fn);
  }

  setVoiceEnabled(on: boolean): void {
    this.snap.voiceEnabled = on;
    this.emit();
  }

  /** Mic level, 0..1. Only meaningful while listening with voice on. */
  setLevel(level: number): void {
    if (this.snap.state !== 'listening' || !this.snap.voiceEnabled) return;
    this.snap.level = Math.max(0, Math.min(1, level));
    this.emit();
  }

  set(
    state: PresenceState,
    extra: { message?: string; activeProvider?: string } = {},
  ): void {
    if (state !== this.snap.state && !LEGAL[this.snap.state].includes(state)) {
      // Illegal transitions are a bug, not something to paper over.
      throw new Error(`PRESENCE: illegal transition ${this.snap.state} -> ${state}`);
    }
    this.snap = {
      ...this.snap,
      state,
      message: extra.message ?? (state === 'idle' ? null : this.snap.message),
      activeProvider: extra.activeProvider ?? (state === 'idle' ? null : this.snap.activeProvider),
      level: state === 'listening' ? this.snap.level : 0,
      since: new Date().toISOString(),
    };
    if (state === 'idle' || state === 'error') this.streamBuf = '';
    this.emit();
  }

  stream(delta: string): void {
    this.streamBuf += delta;
    this.emit();
  }

  get streamed(): string {
    return this.streamBuf;
  }

  private emit(): void {
    const s = this.get();
    for (const l of this.listeners) l(s);
  }
}

/* ─────────────────── platform-agnostic indicator spec ─────────────────── */
/**
 * Every UI renders from this table. Voice OFF must never require audio, and
 * every cue has a screen-reader announcement.
 */
export interface IndicatorSpec {
  voiceOn: { visual: string; audio: string | null; haptic: string | null };
  voiceOff: { visual: string; audio: null; haptic: string | null };
  aria: string;
}

export const INDICATORS: Record<PresenceState, IndicatorSpec> = {
  idle: {
    voiceOn: { visual: 'tray icon at rest, ring hidden', audio: null, haptic: null },
    voiceOff: { visual: 'tray icon at rest', audio: null, haptic: null },
    aria: 'Wolfman idle',
  },
  armed: {
    voiceOn: { visual: 'dim static ring, mic glyph visible', audio: null, haptic: null },
    voiceOff: { visual: 'dim tray icon, hotkey hint in tooltip', audio: null, haptic: null },
    aria: 'Wolfman armed and ready',
  },
  listening: {
    voiceOn: {
      visual: 'pulsing accent ring + live waveform bound to level, OS mic indicator lit',
      audio: 'short ascending two-tone chime',
      haptic: 'single light tap',
    },
    voiceOff: {
      visual: 'pulsing border on the input field, animated caret, tray icon shifts to accent colour',
      audio: null,
      haptic: 'single light tap',
    },
    aria: 'Wolfman is listening',
  },
  thinking: {
    voiceOn: { visual: 'ring rotates, active provider name below', audio: null, haptic: null },
    voiceOff: { visual: 'inline spinner with active provider name', audio: null, haptic: null },
    aria: 'Wolfman is working',
  },
  rendering: {
    voiceOn: { visual: 'ring settles, tokens stream into the panel', audio: null, haptic: null },
    voiceOff: { visual: 'tokens stream into the panel', audio: null, haptic: null },
    aria: 'Wolfman is answering',
  },
  speaking: {
    voiceOn: { visual: 'waveform mirrors TTS output', audio: 'TTS playback', haptic: null },
    voiceOff: { visual: 'not reachable with voice off', audio: null, haptic: null },
    aria: 'Wolfman is speaking',
  },
  error: {
    voiceOn: { visual: 'ring turns amber, failure reason shown', audio: 'short descending tone', haptic: 'double tap' },
    voiceOff: { visual: 'amber tray icon, failure reason inline', audio: null, haptic: 'double tap' },
    aria: 'Wolfman could not complete the request',
  },
};
