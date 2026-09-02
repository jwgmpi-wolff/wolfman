/**
 * WOLFMAN — provider discovery engine.
 *
 * Discovery PROBES REALITY. It never assumes a provider exists because a package
 * name is known, and it never registers capabilities it has not observed on the
 * wire. A candidate that fails its live handshake is registered as `unavailable`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DeviceRef, Platform, PrivacyTier, ProbeResult, Transport } from '@wolfman/protocol';

const exec = promisify(execFile);

/* ───────────────────────── candidate model ───────────────────────── */

export interface Candidate {
  id: string;
  displayName: string;
  transport: Transport;
  privacyTier: PrivacyTier;
  /** how we found it — recorded in the audit log */
  evidence: string;
  endpoint?: string;      // http://127.0.0.1:11434
  command?: string;       // for mcp-stdio
  args?: string[];
  androidPackage?: string;
}

/* ─────────────────── well-known local inference ports ─────────────────── */
/* These are STARTING POINTS for probing only. Nothing is registered without a
   successful live handshake against the port. */
const LOCAL_PORT_HINTS: { port: number; name: string; transport: Transport }[] = [
  { port: 11434, name: 'Ollama', transport: 'openai-compatible' },
  { port: 1234, name: 'LM Studio', transport: 'openai-compatible' },
  { port: 8080, name: 'llama.cpp server', transport: 'openai-compatible' },
  { port: 5000, name: 'Text Generation WebUI', transport: 'openai-compatible' },
  { port: 8000, name: 'vLLM / local OpenAI shim', transport: 'openai-compatible' },
  { port: 4891, name: 'GPT4All', transport: 'openai-compatible' },
  { port: 3000, name: 'Local MCP / gateway', transport: 'mcp-http' },
];

const PORT_SCAN_RANGE_EXTRA = [11435, 1235, 8081, 8787, 9000];

/* ───────────────────────────── entry point ───────────────────────────── */

export async function discover(
  device: DeviceRef,
  opts: { timeoutMs?: number; extraEndpoints?: string[] } = {},
): Promise<Candidate[]> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const platform = device.platform;

  const tasks: Promise<Candidate[]>[] = [scanLoopbackPorts(timeoutMs)];

  if (platform === 'windows') tasks.push(discoverWindows());
  if (platform === 'macos') tasks.push(discoverMacos());
  if (platform === 'android') tasks.push(discoverAndroid());
  if (platform === 'linux') tasks.push(discoverLinux());

  tasks.push(discoverMdns(timeoutMs));
  tasks.push(discoverDeclared(opts.extraEndpoints ?? []));
  tasks.push(discoverMcpConfigFiles(platform));

  const results = await Promise.allSettled(tasks);
  const flat = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return dedupe(flat);
}

function dedupe(list: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const c of list) {
    const key = c.endpoint ?? c.command ?? c.androidPackage ?? c.id;
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}

/* ─────────────────────── channel: loopback ports ─────────────────────── */

async function scanLoopbackPorts(timeoutMs: number): Promise<Candidate[]> {
  const hints = [
    ...LOCAL_PORT_HINTS,
    ...PORT_SCAN_RANGE_EXTRA.map((port) => ({
      port,
      name: `Unknown local service :${port}`,
      transport: 'openai-compatible' as Transport,
    })),
  ];

  const open = await Promise.all(
    hints.map(async (h) => ({ h, open: await isPortOpen('127.0.0.1', h.port, Math.min(timeoutMs, 750)) })),
  );

  return open
    .filter((x) => x.open)
    .map(({ h }) => ({
      id: `${slug(h.name)}@local:${h.port}`,
      displayName: h.name,
      transport: h.transport,
      privacyTier: 'on-device' as PrivacyTier,
      evidence: `loopback tcp/${h.port} accepting connections`,
      endpoint: `http://127.0.0.1:${h.port}`,
    }));
}

function isPortOpen(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

/* ───────────────────────── channel: Windows ───────────────────────── */

async function discoverWindows(): Promise<Candidate[]> {
  const out: Candidate[] = [];

  // 1. Installed programs via the uninstall registry hives.
  const hives = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const hive of hives) {
    const text = await safeExec('reg', ['query', hive, '/s', '/v', 'DisplayName']);
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/DisplayName\s+REG_SZ\s+(.+)$/);
      if (!m) continue;
      const name = m[1].trim();
      if (looksLikeAiApp(name)) {
        out.push({
          id: `${slug(name)}@windows-installed`,
          displayName: name,
          transport: 'native-sdk',
          privacyTier: 'on-device',
          evidence: `registry uninstall key: ${hive}`,
        });
      }
    }
  }

  // 2. MSIX / AppX packages.
  const appx = await safeExec('powershell', [
    '-NoProfile',
    '-Command',
    'Get-AppxPackage | Select-Object -ExpandProperty Name',
  ]);
  for (const name of appx.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (looksLikeAiApp(name)) {
      out.push({
        id: `${slug(name)}@appx`,
        displayName: name,
        transport: 'native-sdk',
        privacyTier: 'on-device',
        evidence: 'AppX package manifest',
      });
    }
  }

  // 3. Running processes — catches portable installs with no registry entry.
  const procs = await safeExec('powershell', [
    '-NoProfile',
    '-Command',
    'Get-Process | Select-Object -ExpandProperty ProcessName -Unique',
  ]);
  for (const p of procs.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (looksLikeAiApp(p)) {
      out.push({
        id: `${slug(p)}@process`,
        displayName: p,
        transport: 'native-sdk',
        privacyTier: 'on-device',
        evidence: 'running process',
      });
    }
  }

  // 4. Program folders.
  out.push(
    ...(await scanDirsForAiApps([
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs'),
      process.env.ProgramFiles ?? '',
      process.env['ProgramFiles(x86)'] ?? '',
    ], 'windows filesystem scan')),
  );

  return out;
}

/* ────────────────────────── channel: macOS ────────────────────────── */

async function discoverMacos(): Promise<Candidate[]> {
  const out: Candidate[] = [];

  out.push(
    ...(await scanDirsForAiApps(
      ['/Applications', path.join(os.homedir(), 'Applications')],
      'macOS application bundle',
    )),
  );

  // Bundle identifiers via Spotlight — more reliable than display names.
  const ids = await safeExec('mdfind', ['kMDItemContentType == "com.apple.application-bundle"']);
  for (const p of ids.split('\n').map((s) => s.trim()).filter(Boolean)) {
    const base = path.basename(p, '.app');
    if (looksLikeAiApp(base)) {
      out.push({
        id: `${slug(base)}@macos`,
        displayName: base,
        transport: 'native-sdk',
        privacyTier: 'on-device',
        evidence: `spotlight: ${p}`,
      });
    }
  }

  // Homebrew formulae that ship local runtimes.
  const brew = await safeExec('brew', ['list', '--formula']);
  for (const f of brew.split(/\s+/).filter(Boolean)) {
    if (looksLikeAiApp(f)) {
      out.push({
        id: `${slug(f)}@brew`,
        displayName: f,
        transport: 'openai-compatible',
        privacyTier: 'on-device',
        evidence: 'homebrew formula',
      });
    }
  }

  // launchd services.
  const launch = await safeExec('launchctl', ['list']);
  for (const line of launch.split('\n')) {
    const label = line.trim().split(/\s+/).pop() ?? '';
    if (looksLikeAiApp(label)) {
      out.push({
        id: `${slug(label)}@launchd`,
        displayName: label,
        transport: 'native-sdk',
        privacyTier: 'on-device',
        evidence: 'launchctl service',
      });
    }
  }

  return out;
}

/* ───────────────────────── channel: Android ───────────────────────── */
/**
 * On-device this is implemented in Kotlin (apps/android). This Node path is used
 * when a desktop is driving a tethered device over adb during development.
 */
async function discoverAndroid(): Promise<Candidate[]> {
  const out: Candidate[] = [];

  const pkgs = await safeExec('pm', ['list', 'packages']);
  for (const line of pkgs.split('\n')) {
    const pkg = line.replace('package:', '').trim();
    if (!pkg) continue;
    if (looksLikeAiApp(pkg)) {
      out.push({
        id: `${slug(pkg)}@android`,
        displayName: pkg,
        transport: 'intent',
        privacyTier: 'on-device',
        evidence: 'PackageManager installed package',
        androidPackage: pkg,
      });
    }
  }

  // Assistant role holder.
  const assist = await safeExec('settings', ['get', 'secure', 'assistant']);
  const holder = assist.trim();
  if (holder && holder !== 'null') {
    out.push({
      id: `assistant-role@android`,
      displayName: `Default assistant (${holder})`,
      transport: 'intent',
      privacyTier: 'on-device',
      evidence: 'RoleManager.ROLE_ASSISTANT holder',
      androidPackage: holder.split('/')[0],
    });
  }

  return out;
}

async function discoverLinux(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const dirs = ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')];
  for (const d of dirs) {
    for (const f of await safeReaddir(d)) {
      if (f.endsWith('.desktop') && looksLikeAiApp(f)) {
        out.push({
          id: `${slug(f)}@linux`,
          displayName: f.replace('.desktop', ''),
          transport: 'native-sdk',
          privacyTier: 'on-device',
          evidence: `desktop entry ${path.join(d, f)}`,
        });
      }
    }
  }
  return out;
}

/* ────────────────────── channel: mDNS peer mesh ────────────────────── */

async function discoverMdns(timeoutMs: number): Promise<Candidate[]> {
  // Implemented with `bonjour-service` at runtime; kept dependency-light here.
  // Browses _wolfman._tcp (peer devices) and _mcp._tcp (standalone MCP servers).
  try {
    const { Bonjour } = await import('bonjour-service');
    const bonjour = new Bonjour();
    const found: Candidate[] = [];

    await Promise.all(
      (['wolfman', 'mcp'] as const).map(
        (type) =>
          new Promise<void>((resolve) => {
            const browser = bonjour.find({ type });
            browser.on('up', (svc: any) => {
              const host = svc.referer?.address ?? svc.host;
              found.push({
                id: `${slug(svc.name)}@${host}:${svc.port}`,
                displayName: svc.name,
                transport: type === 'mcp' ? 'mcp-http' : 'mcp-http',
                privacyTier: 'lan',
                evidence: `mDNS _${type}._tcp advertisement`,
                endpoint: `https://${host}:${svc.port}`,
              });
            });
            setTimeout(() => {
              browser.stop();
              resolve();
            }, Math.min(timeoutMs, 3000));
          }),
      ),
    );

    bonjour.destroy();
    return found;
  } catch {
    return [];
  }
}

/* ─────────────────── channel: user-declared endpoints ─────────────────── */

async function discoverDeclared(endpoints: string[]): Promise<Candidate[]> {
  return endpoints.map((url) => ({
    id: `declared@${url}`,
    displayName: `Declared endpoint ${url}`,
    transport: url.includes('/mcp') ? 'mcp-http' : 'openai-compatible',
    privacyTier: url.includes('127.0.0.1') || url.includes('localhost') ? 'on-device' : 'cloud',
    evidence: 'user configuration',
    endpoint: url,
  }));
}

/* ────────────────── channel: existing MCP config files ────────────────── */
/** Reuses MCP servers the user has already configured for other AI clients. */
async function discoverMcpConfigFiles(platform: Platform): Promise<Candidate[]> {
  const home = os.homedir();
  const paths: string[] = [
    path.join(home, '.config', 'mcp', 'servers.json'),
    path.join(home, '.mcp.json'),
    path.join(home, '.vscode', 'mcp.json'),
    path.join(home, '.cursor', 'mcp.json'),
  ];
  if (platform === 'windows' && process.env.APPDATA) {
    paths.push(path.join(process.env.APPDATA, 'Code', 'User', 'mcp.json'));
  }
  if (platform === 'macos') {
    paths.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'));
  }

  const out: Candidate[] = [];
  for (const p of paths) {
    const raw = await safeRead(p);
    if (!raw) continue;
    try {
      const json = JSON.parse(raw);
      const servers = json.mcpServers ?? json.servers ?? {};
      for (const [name, cfg] of Object.entries<any>(servers)) {
        out.push({
          id: `${slug(name)}@mcp-config`,
          displayName: `MCP: ${name}`,
          transport: cfg.url ? 'mcp-http' : 'mcp-stdio',
          privacyTier: cfg.url && !/127\.0\.0\.1|localhost/.test(cfg.url) ? 'cloud' : 'on-device',
          evidence: `mcp config ${p}`,
          endpoint: cfg.url,
          command: cfg.command,
          args: cfg.args,
        });
      }
    } catch {
      /* malformed config is not a provider */
    }
  }
  return out;
}

/* ───────────────────────────── heuristics ───────────────────────────── */
/**
 * Name matching only produces a CANDIDATE. Registration still requires a live
 * handshake, so a false positive here costs one failed probe and nothing more.
 */
const AI_NAME_PATTERNS: RegExp[] = [
  /ollama/i, /lm[\s_-]?studio/i, /llama/i, /gpt4all/i, /jan\.ai|(^|\W)jan(\W|$)/i,
  /copilot/i, /chatgpt|openai/i, /claude|anthropic/i, /gemini|bard/i,
  /perplexity/i, /mistral/i, /msty/i, /anythingllm/i, /openwebui|open-webui/i,
  /koboldcpp/i, /oobabooga|text-generation-webui/i, /localai/i, /vllm/i,
  /assistant/i, /\bmcp\b/i, /foundry/i, /pinokio/i, /faraday/i, /backyard/i,
];

function looksLikeAiApp(name: string): boolean {
  return AI_NAME_PATTERNS.some((r) => r.test(name));
}

async function scanDirsForAiApps(dirs: string[], evidence: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const d of dirs.filter(Boolean)) {
    for (const entry of await safeReaddir(d)) {
      if (looksLikeAiApp(entry)) {
        out.push({
          id: `${slug(entry)}@fs`,
          displayName: entry.replace(/\.(app|exe|desktop)$/i, ''),
          transport: 'native-sdk',
          privacyTier: 'on-device',
          evidence: `${evidence}: ${path.join(d, entry)}`,
        });
      }
    }
  }
  return out;
}

/* ────────────────────────────── utilities ────────────────────────────── */

async function safeExec(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec(cmd, args, { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function safeRead(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
