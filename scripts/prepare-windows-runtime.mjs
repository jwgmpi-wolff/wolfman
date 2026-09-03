import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const runtime = path.resolve('apps/windows/runtime');
const keytarBinary = path.join(runtime, 'node_modules', 'keytar', 'build', 'Release', 'keytar.node');
if (!existsSync(keytarBinary)) {
  console.error(`Missing protected-cache native binary: ${keytarBinary}`);
  process.exit(1);
}

rmSync(path.join(runtime, 'node_modules', '.bin'), { recursive: true, force: true });
console.log('Windows runtime prepared for Tauri bundling.');
