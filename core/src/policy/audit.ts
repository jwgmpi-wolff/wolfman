/**
 * WOLFMAN — local audit log. Append-only JSONL on device. Never uploaded.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuditEntry, ProviderDescriptor } from '@wolfman/protocol';

export class AuditLog {
  private queue: string[] = [];
  private flushing = false;

  constructor(private file: string) {}

  write(entry: AuditEntry): void {
    this.queue.push(JSON.stringify(entry));
    void this.flush();
  }

  egress(provider: ProviderDescriptor, redactedFields: string[]): void {
    this.queue.push(
      JSON.stringify({
        kind: 'egress',
        at: new Date().toISOString(),
        providerId: provider.id,
        privacyTier: provider.privacyTier,
        redactedFields,
      }),
    );
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.queue.length) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length).join('\n') + '\n';
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, batch, 'utf8');
    } finally {
      this.flushing = false;
      if (this.queue.length) void this.flush();
    }
  }

  async read(limit = 200): Promise<unknown[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      return raw.trim().split('\n').slice(-limit).map((l: string) => JSON.parse(l));
    } catch {
      return [];
    }
  }
}
