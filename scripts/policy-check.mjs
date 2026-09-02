#!/usr/bin/env node
/**
 * WOLFMAN build gate.
 *
 * Fails the build if any purged concept or mock-answer path has been
 * reintroduced. This is the mechanical enforcement of the no-mock rule — it is
 * not advisory and it is not skippable in CI.
 *
 * Scope: this gate polices the Wolfman core project only (packages/, core/,
 * daemon/, apps/, types/) — the pre-existing legacy app under src/, electron/,
 * android/, functions/ and supabase/ is a separate product being phased out
 * and is not subject to the no-cloud-SDK rule below.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const WOLFMAN_ROOTS = ['packages', 'core', 'daemon', 'apps', 'types'];
const SKIP = new Set(['node_modules', 'dist', '.git', 'build', '.gradle']);
const EXT = /\.(ts|tsx|js|mjs|kt|swift|json)$/;

const FORBIDDEN = [
  { re: /\bmockResponse\b|\bfakeResponse\b|\bstubAnswer\b|\bdummyAnswer\b/, why: 'mocked answer path' },
  { re: /\bSAMPLE_(ANSWERS?|DATA|RESPONSES?)\b/, why: 'sample answer table' },
  { re: /\bCANNED_[A-Z_]+/, why: 'canned response constant' },
  { re: /\bseedDatabase\b|\bloadFixtures\b|\bfixtures?\.json\b/, why: 'seed/fixture data' },
  { re: /\bbudgetTracker?\b|\btransactionLedger\b|\bexpenseCategor\w*/i, why: 'purged finance domain' },
  { re: /lorem ipsum|placeholder answer|TODO: return real/i, why: 'placeholder content' },
  { re: /\bprecanned\b|\bpre-canned\b/i, why: 'pre-canned content' },
  { re: /\banswerFrom(Profile|History|Cache)\b|\bcachedAnswer\b|\bgetCachedAnswer\b/i, why: 'the learned profile/audit log may never itself supply an answer' },
];

// Cloud/identity SDK and telemetry-exporter package names banned from the standalone
// core so `standalone` mode is a structural guarantee, not a convention.
const FORBIDDEN_CLOUD_PACKAGES = [
  { re: /^@azure\//, why: 'Azure SDK' },
  { re: /^azure-/, why: 'Azure SDK' },
  { re: /^@azure-rest\//, why: 'Azure SDK' },
  { re: /^msal\b/, why: 'identity/Graph SDK' },
  { re: /^@microsoft\/microsoft-graph/, why: 'identity/Graph SDK' },
  { re: /^aws-sdk$/, why: 'cloud provider SDK' },
  { re: /^@aws-sdk\//, why: 'cloud provider SDK' },
  { re: /^@google-cloud\//, why: 'cloud provider SDK' },
  { re: /^googleapis$/, why: 'cloud provider SDK' },
  { re: /^firebase/, why: 'cloud provider SDK' },
  { re: /^@supabase\//, why: 'cloud backend' },
  { re: /^@opentelemetry\/exporter/, why: 'remote telemetry exporter' },
];

// Files that legitimately name the forbidden patterns in order to ban them.
const ALLOWLIST = [
  /scripts[\/\\]policy-check\.mjs$/,
  /core[\/\\]src[\/\\]policy[\/\\]index\.ts$/,
  /\.md$/,
];

let violations = 0;

/** Module specifier scan: `import x from '...'` / `require('...')`, ESM and CJS alike. */
function importSpecifiers(line) {
  const specs = [];
  for (const m of line.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of line.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

function walkSource(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walkSource(p); continue; }
    if (!EXT.test(name)) continue;
    const rel = path.relative(ROOT, p);
    if (ALLOWLIST.some((r) => r.test(rel))) continue;

    const src = readFileSync(p, 'utf8');
    const underCore = /^core[\/\\]/.test(rel);
    src.split('\n').forEach((line, i) => {
      for (const f of FORBIDDEN) {
        if (f.re.test(line)) {
          console.error(`POLICY VIOLATION  ${rel}:${i + 1}  ${f.why}\n    ${line.trim()}`);
          violations++;
        }
      }
      // The no-cloud-SDK rule applies to imports inside core/ specifically —
      // that is the standalone orchestration path that must never phone home.
      if (underCore) {
        for (const spec of importSpecifiers(line)) {
          const hit = FORBIDDEN_CLOUD_PACKAGES.find((f) => f.re.test(spec));
          if (hit) {
            console.error(`POLICY VIOLATION  ${rel}:${i + 1}  ${hit.why} imported in core/ (breaks standalone mode)\n    ${line.trim()}`);
            violations++;
          }
        }
      }
    });
  }
}

/** Every package.json in the Wolfman core project must be free of cloud-SDK dependencies. */
function walkManifests(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walkManifests(p); continue; }
    if (name !== 'package.json') continue;
    const rel = path.relative(ROOT, p);

    let json;
    try {
      json = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    const deps = {
      ...json.dependencies, ...json.devDependencies, ...json.peerDependencies, ...json.optionalDependencies,
    };
    for (const name of Object.keys(deps)) {
      const hit = FORBIDDEN_CLOUD_PACKAGES.find((f) => f.re.test(name));
      if (hit) {
        console.error(`POLICY VIOLATION  ${rel}  ${hit.why} declared as a dependency (${name}) — breaks standalone mode`);
        violations++;
      }
    }
  }
}

for (const root of WOLFMAN_ROOTS) {
  const full = path.join(ROOT, root);
  try {
    statSync(full);
  } catch {
    continue; // platform host not scaffolded yet
  }
  walkSource(full);
  walkManifests(full);
}

if (violations) {
  console.error(`\n✗ ${violations} policy violation(s). The no-mock rule is non-negotiable — remove them or wire a real provider.`);
  process.exit(1);
}
console.log('✓ policy check passed — no mock, sample, canned, purged-domain or cloud-SDK paths found');

