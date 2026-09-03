import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const runtime = path.resolve('apps/windows/runtime');
const keytarBinary = path.join(runtime, 'node_modules', 'keytar', 'build', 'Release', 'keytar.node');
if (!existsSync(keytarBinary)) {
  console.error(`Missing protected-cache native binary: ${keytarBinary}`);
  process.exit(1);
}

rmSync(path.join(runtime, 'node_modules', '.bin'), { recursive: true, force: true });
const resources = path.resolve('apps/windows/src-tauri/resources');
rmSync(resources, { recursive: true, force: true });
mkdirSync(path.join(resources, 'node_modules', '@wolfman', 'protocol'), { recursive: true });
cpSync(path.resolve('wolfman-dist'), path.join(resources, 'wolfman-dist'), { recursive: true });
cpSync(path.join(runtime, 'node_modules'), path.join(resources, 'node_modules'), { recursive: true });
cpSync(path.resolve('packages/protocol/dist'), path.join(resources, 'node_modules', '@wolfman', 'protocol', 'dist'), { recursive: true });
cpSync(path.resolve('packages/protocol/package.json'), path.join(resources, 'node_modules', '@wolfman', 'protocol', 'package.json'));
console.log('Windows runtime prepared for Tauri bundling.');
