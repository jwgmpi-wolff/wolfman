/**
 * WOLFMAN — persisted device settings (operating mode + lock-to-device).
 * Stored locally, never uploaded, and survives process restarts.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_WOLFMAN_SETTINGS, type WolfmanSettings } from '@wolfman/protocol';

export class SettingsStore {
  private cached: WolfmanSettings | null = null;

  constructor(private file: string) {}

  async load(): Promise<WolfmanSettings> {
    if (this.cached) return this.cached;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.cached = { ...DEFAULT_WOLFMAN_SETTINGS, ...(JSON.parse(raw) as Partial<WolfmanSettings>) };
    } catch {
      this.cached = { ...DEFAULT_WOLFMAN_SETTINGS };
    }
    return this.cached;
  }

  async save(settings: WolfmanSettings): Promise<void> {
    this.cached = settings;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(settings, null, 2), 'utf8');
  }
}
