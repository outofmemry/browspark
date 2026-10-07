import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clients, type ClientState } from './context.ts';

const run = promisify(execFile);

/** Names MCP SDKs report when the client never sets one (Python `mcp`, OpenCode 2 `cli`, the AI SDK …). */
const GENERIC = /^(?:cli|mcp|client|mcp[\s_-]?client|ai[\s_-]sdk[\s_-]mcp[\s_-]client|http|stdio|relay|probe|unknown|python|node|sdk)$/i;

// Executable or script basename → product. Matched against the process and its ancestors, nearest first.
const EXECUTABLES: [RegExp, string][] = [
  [/^claude$/i, 'Claude Code'],
  [/^codex$/i, 'Codex'],
  [/^opencode$/i, 'OpenCode'],
  [/^hermes(?:[-_]agent)?$/i, 'Hermes'],
  [/^openclaw$/i, 'OpenClaw'],
  [/^cursor(?:-agent)?$/i, 'Cursor'],
  [/^antigravity$/i, 'Antigravity'],
  [/^cline$/i, 'Cline'],
  [/^kilo(?:code)?$/i, 'Kilo Code'],
  [/^pi$/i, 'Pi'],
  [/^(?:command-?code|cmd)$/i, 'Command Code'],
];
// Install paths for agents launched through an interpreter, where the script name is generic (cli.js, python -c …).
const PACKAGES: [RegExp, string][] = [
  [/\/\.hermes\/hermes-agent\b|\bhermes_cli\b/, 'Hermes'],
  [/node_modules\/@anthropic-ai\/claude-code\//, 'Claude Code'],
  [/node_modules\/@openai\/codex\//, 'Codex'],
  [/node_modules\/opencode-ai\//, 'OpenCode'],
  [/node_modules\/openclaw\//, 'OpenClaw'],
  [/node_modules\/cline\//, 'Cline'],
  [/node_modules\/@kilocode\/cli\//, 'Kilo Code'],
  [/node_modules\/@mariozechner\/pi-coding-agent\//, 'Pi'],
  [/node_modules\/command-code\//, 'Command Code'],
];
// macOS app bundles: a desktop app is identified but only ever disconnected, never killed.
const APPS: [RegExp, string][] = [[/^claude$/i, 'Claude'], [/^cursor$/i, 'Cursor'], [/^antigravity$/i, 'Antigravity'], [/^hermes$/i, 'Hermes']];
const INTERPRETER = /^(?:node|bun|deno|tsx|npx|bunx|uv|uvx|python[\d.]*)$/i;
const RELAY = /browspark|companion\/src\/index\.ts/;
// Processes that merely launch an MCP server for an agent: the walk continues through these and stops at anything else,
// so an unrelated ancestor (a terminal, or the agent whose shell ran a script) is never taken for the client.
/** Whether a process command line is recognized as a launcher through which agent lookup may continue. */
function launcher(args: string): boolean {
  if (RELAY.test(args) || /\b(?:npx|npm)-cli\.js\b/.test(args)) return true;
  const [exe = '', sub = ''] = args.trim().split(/\s+/);
  const name = base(exe).replace(/^-/, '');
  if (/^(?:npx|bunx|pnpx|uvx)$/i.test(name)) return true;
  if (/^(?:npm|pnpm|yarn|bun|uv|deno)$/i.test(name) && /^(?:x|exec|dlx|run)$/i.test(sub)) return true;
  return /^(?:sh|bash|zsh|dash|fish)$/i.test(name) && /\s-\w*c\b/.test(args);
}

export interface AgentIdentity {
  /** Product name, e.g. "OpenCode". */
  app: string;
  /** Process that matched; the one to end when the user stops all agents. */
  pid: number;
  /** A desktop app bundle: disconnect it, never kill it. */
  gui: boolean;
  /** Process holding the connection (an agent, or a Browspark relay it launched). */
  peer: number;
  relay: boolean;
}

/** Take a slash-delimited basename, removing trailing slashes and a recognized script or executable extension. */
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop()!.replace(/\.(?:js|mjs|cjs|ts|py|exe)$/i, '');

/** Identify a product from a process command line, preferring known macOS app bundles; return undefined if none matches. */
function match(args: string): { app: string; gui: boolean } | undefined {
  const bundle = /\/([^/]+)\.app\/Contents\/MacOS\//.exec(args)?.[1];
  if (bundle) { const hit = APPS.find(([re]) => re.test(bundle)); if (hit) return { app: hit[1], gui: true }; }
  const pkg = PACKAGES.find(([re]) => re.test(args));
  if (pkg) return { app: pkg[1], gui: false };
  const [exe = '', script = ''] = args.trim().split(/\s+/);
  const names = [base(exe)];
  if (INTERPRETER.test(base(exe)) && script && !script.startsWith('-')) names.push(base(script));
  for (const name of names) { const hit = EXECUTABLES.find(([re]) => re.test(name)); if (hit) return { app: hit[1], gui: false }; }
  return undefined;
}

/** Read a process's parent PID and command line; return undefined on malformed output or lookup failure, including a 2-second timeout. */
async function proc(pid: number): Promise<{ ppid: number; args: string } | undefined> {
  try {
    const { stdout } = await run('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { timeout: 2000 });
    const m = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
    return m ? { ppid: Number(m[1]), args: m[2]! } : undefined;
  } catch { return undefined; }
}

/**
 * Walk up from `pid`, through launchers only, to the nearest known agent, inspecting at most 12 processes.
 * The returned `peer` is the starting PID. An unmatched relay returns an empty app and PID 0.
 * Return undefined on Windows, for PIDs <= 1, on any process lookup failure, or when no agent or relay is found.
 */
export async function identifyProcess(pid: number): Promise<AgentIdentity | undefined> {
  if (process.platform === 'win32' || !(pid > 1)) return undefined;
  let relay = false;
  for (let cur = pid, depth = 0; cur > 1 && depth < 12; depth++) {
    const p = await proc(cur);
    if (!p) return undefined;
    if (cur === pid) relay = RELAY.test(p.args);
    const hit = match(p.args);
    if (hit) return { ...hit, pid: cur, peer: pid, relay };
    if (!launcher(p.args)) break;
    cur = p.ppid;
  }
  return relay ? { app: '', pid: 0, gui: false, peer: pid, relay } : undefined;
}

/**
 * Find the process owning an established loopback socket whose local port is `remotePort`
 * (the remote port of the companion's accepted socket), excluding this process and PIDs <= 1.
 * Return undefined on Windows, for port 0, if no match exists, or if lsof fails or times out after 3 seconds.
 */
export async function peerPid(remotePort: number): Promise<number | undefined> {
  if (process.platform === 'win32' || !remotePort) return undefined;
  try {
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${remotePort}`, '-sTCP:ESTABLISHED', '-Fpn'], { timeout: 3000 });
    // -F prints "p<pid>" then one "n<local>-><remote>" per socket; the peer is whoever owns the local end of that port.
    let pid = 0;
    for (const line of stdout.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n' && new RegExp(`^n(?:127\\.0\\.0\\.1|\\[::1\\]|localhost):${remotePort}->`).test(line) && pid > 1 && pid !== process.pid) return pid;
    }
    return undefined;
  } catch { return undefined; }
}

/**
 * Store the identity on `client` and replace a generic client name with the identified product.
 * A conflicting specific name clears the stored app and PID but retains relay information.
 * An undefined identity leaves the client unchanged.
 */
export function applyIdentity(client: ClientState, id: AgentIdentity | undefined) {
  if (!id) return;
  client.process = id;
  if (!id.app) return;
  const reported = client.name.toLowerCase().replace(/[^a-z]/g, '');
  const product = id.app.toLowerCase().split(' ')[0]!;
  if (GENERIC.test(client.name.trim())) client.name = id.app;
  // A specific name that is not this product means the match was some ancestor (an agent's own shell, say).
  else if (!reported.includes(product)) client.process = { ...id, app: '', pid: 0 };
}

/**
 * Request termination of identified non-GUI agents, or their relay peers when no such agent is identified,
 * and await each available disconnect callback. Each eligible PID is targeted once; this process is excluded.
 * Send SIGTERM and schedule a SIGKILL check after 3 seconds without waiting for process exit.
 * `killed` lists names with PIDs successfully sent SIGTERM; `disconnected` lists names for which no new
 * signal attempt was made, including duplicate targets. Neither list confirms exit or disconnection.
 * Signal errors and rejected disconnect promises are ignored; synchronous disconnect errors reject this call.
 */
export async function stopAllAgents(): Promise<{ killed: string[]; disconnected: string[] }> {
  const killed: string[] = [], disconnected: string[] = [];
  const targets = new Set<number>();
  for (const c of [...clients.values()]) {
    const p = c.process;
    const pid = p && p.app && !p.gui ? p.pid : p?.relay ? p.peer : 0;
    if (pid > 1 && pid !== process.pid && !targets.has(pid)) {
      targets.add(pid);
      try { process.kill(pid, 'SIGTERM'); killed.push(`${c.name} (pid ${pid})`); } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }, 3000).unref();
    } else disconnected.push(c.name);
    await c.disconnect?.().catch(() => {});
  }
  return { killed, disconnected };
}
