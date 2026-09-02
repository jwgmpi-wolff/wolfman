/**
 * WOLFMAN — wake word + voice pipeline.
 *
 * Audio before the wake word NEVER leaves the device and is NEVER persisted.
 * The rolling buffer is overwritten continuously and zeroed on trigger handoff.
 */

import { WAKE_WORD } from '@wolfman/protocol';
import type { PresenceStore } from '../../../core/src/presence/store.js';

export interface WakeWordEngine {
  /** e.g. porcupine | openwakeword | platform-native */
  readonly name: string;
  start(onDetect: () => void, onLevel: (l: number) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface SttEngine {
  transcribe(pcm: Int16Array, signal: AbortSignal): Promise<string>;
  readonly onDevice: boolean;
}

export interface TtsEngine {
  speak(text: string, signal: AbortSignal): Promise<void>;
  cancel(): void;
}

export interface VoiceConfig {
  enabled: boolean;
  keyword: string;              // "wolfman"
  sensitivity: number;          // 0..1
  vadSilenceMs: number;         // end-of-utterance
  maxUtteranceMs: number;
  speakReplies: boolean;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  enabled: false,               // opt-in. Wolfman is fully usable silent.
  keyword: WAKE_WORD,
  sensitivity: 0.6,
  vadSilenceMs: 900,
  maxUtteranceMs: 20000,
  speakReplies: true,
};

/** Fixed-size ring buffer. Pre-trigger audio is overwritten, never written to disk. */
export class RollingAudioBuffer {
  private buf: Int16Array;
  private w = 0;
  private filled = false;

  constructor(sampleRate = 16000, seconds = 3) {
    this.buf = new Int16Array(sampleRate * seconds);
  }

  push(frame: Int16Array): void {
    for (const s of frame) {
      this.buf[this.w] = s;
      this.w = (this.w + 1) % this.buf.length;
      if (this.w === 0) this.filled = true;
    }
  }

  /** Only called AFTER a wake-word trigger, to recover the leading syllables. */
  drain(): Int16Array {
    const out = this.filled
      ? Int16Array.from([...this.buf.subarray(this.w), ...this.buf.subarray(0, this.w)])
      : this.buf.slice(0, this.w);
    this.zero();
    return out;
  }

  zero(): void {
    this.buf.fill(0);
    this.w = 0;
    this.filled = false;
  }
}

export class VoicePipeline {
  private buffer = new RollingAudioBuffer();
  private listening = false;

  constructor(
    private cfg: VoiceConfig,
    private wake: WakeWordEngine,
    private stt: SttEngine,
    private tts: TtsEngine,
    private presence: PresenceStore,
    private onUtterance: (text: string) => Promise<void>,
  ) {}

  async arm(): Promise<void> {
    this.presence.setVoiceEnabled(this.cfg.enabled);
    if (!this.cfg.enabled) return;
    this.presence.set('armed');
    await this.wake.start(
      () => void this.onWake(),
      (l) => this.presence.setLevel(l),
    );
  }

  private async onWake(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.presence.set('listening');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.maxUtteranceMs);
    try {
      const pcm = this.buffer.drain();
      const text = await this.stt.transcribe(pcm, ac.signal);
      if (!text.trim()) {
        this.presence.set('error', { message: 'nothing heard' });
        return;
      }
      await this.onUtterance(text);
    } finally {
      clearTimeout(timer);
      this.buffer.zero();
      this.listening = false;
    }
  }

  async disarm(): Promise<void> {
    await this.wake.stop();
    this.buffer.zero();
    this.presence.set('idle');
  }
}
