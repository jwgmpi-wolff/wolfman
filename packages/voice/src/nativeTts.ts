/**
 * WOLFMAN — native on-device text-to-speech.
 *
 * Shells out to the OS's own built-in speech engine (Windows SAPI via
 * PowerShell, macOS `say`, Linux `spd-say`/`espeak`). No cloud SDK, no
 * network call, no synthesised audio cached to disk — every utterance is a
 * live process invocation of the real text at speak time.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { TtsEngine } from './index.js';

/** Strips markdown down to something a speech engine won't stumble over. */
export function markdownToSpeech(markdown: string): string {
  return markdown
    .replace(/\|/g, ' ')
    .replace(/^[-#]+\s*/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function platformCommand(): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'win32':
      return {
        cmd: 'powershell',
        args: [
          '-NoProfile', '-NonInteractive', '-Command',
          'Add-Type -AssemblyName System.Speech; ' +
            '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
            '$s.Speak([Console]::In.ReadToEnd())',
        ],
      };
    case 'darwin':
      return { cmd: 'say', args: ['-f', '-'] };
    default:
      // Prefer speech-dispatcher when present; espeak is the near-universal Linux fallback.
      return { cmd: 'spd-say', args: ['--wait', '-e'] };
  }
}

export function createNativeTts(): TtsEngine {
  let current: ChildProcess | null = null;

  return {
    async speak(text: string, signal: AbortSignal): Promise<void> {
      const clean = markdownToSpeech(text);
      if (!clean) return;

      const { cmd, args } = platformCommand();
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        current = proc;

        const onAbort = () => proc.kill();
        signal.addEventListener('abort', onAbort, { once: true });

        proc.on('error', (err) => {
          signal.removeEventListener('abort', onAbort);
          current = null;
          reject(err);
        });
        proc.on('exit', () => {
          signal.removeEventListener('abort', onAbort);
          current = null;
          resolve();
        });

        proc.stdin?.write(clean);
        proc.stdin?.end();
      });
    },
    cancel(): void {
      current?.kill();
      current = null;
    },
  };
}
