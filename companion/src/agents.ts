import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

const base = (p: string) => p.replace(/\/+$/, '').split('/').pop()!.replace(/\.(?:js|mjs|cjs|ts|py|exe)$/i, '');

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

async function proc(pid: number): Promise<{ ppid: number; args: string } | undefined> {
  try {
    const { stdout } = await run('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { timeout: 2000 });
    const m = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trim());
    return m ? { ppid: Number(m[1]), args: m[2]! } : undefined;
  } catch { return undefined; }
}

/** Walk up from `pid`, through launchers only, to the nearest process that is a known agent. */
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

/** The process on the other end of a loopback connection to us, found by its local port. */
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

/** Name generic clients after their process, and remember which process to end on Stop all agents. */
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

/** When this process instance started: the PID plus this tells a reused PID apart. Undefined if it can't be read. */
async function startTime(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    // Field 22 (starttime, in clock ticks since boot); the fields before it follow the parenthesised command name.
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || undefined; } catch { return undefined; }
  }
  try { return (await run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2000 })).stdout.trim() || undefined; } catch { return undefined; }
}

/** End every agent connected to this companion. Desktop apps and unidentified clients are disconnected instead. */
export async function stopAllAgents(): Promise<{ killed: string[]; disconnected: string[] }> {
  const killed: string[] = [], disconnected: string[] = [];
  const targets = new Set<number>();
  for (const c of [...clients.values()]) {
    // A client still in its handshake may have a lookup in flight; a failed lookup leaves it disconnect-only.
    if (!c.process && c.identify) applyIdentity(c, await c.identify.catch(() => undefined));
    const p = c.process;
    const pid = p && p.app && !p.gui ? p.pid : p?.relay ? p.peer : 0;
    if (pid > 1 && pid !== process.pid && !targets.has(pid)) {
      targets.add(pid);
      const started = await startTime(pid);
      try { process.kill(pid, 'SIGTERM'); killed.push(`${c.name} (pid ${pid})`); } catch { /* already gone */ }
      // Escalate only if the same process instance is still there; a PID reused in the meantime is left alone.
      if (started) setTimeout(() => { void startTime(pid).then((now) => { if (now === started) try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }); }, 3000).unref();
    } else disconnected.push(c.name);
    await c.disconnect?.().catch(() => {});
  }
  return { killed, disconnected };
}

/**
 * The bridge can't tell Browspark from any other extension (or a local process) that connects, so a stop request is
 * authorized out of band: a native system dialog that no web page or extension can answer. Without one, refuse.
 */
export async function confirmWithUser(count: number): Promise<boolean> {
  const text = `Stop ${count === 1 ? 'the 1 agent' : `all ${count} agents`} connected to Browspark? Agent processes, including background jobs, will be ended. Desktop apps are only disconnected.`;
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('osascript', ['-e', `display dialog ${JSON.stringify(text)} with title "Browspark" buttons {"Cancel", "Stop agents"} default button "Cancel" cancel button "Cancel" with icon caution giving up after 60`], { timeout: 70_000 });
      return /button returned:Stop agents/.test(stdout) && !/gave up:true/.test(stdout);
    } catch { return false; }
  }
  if (process.platform === 'linux') {
    const dialogs: [string, string[]][] = [['zenity', ['--question', '--title=Browspark', `--text=${text}`, '--ok-label=Stop agents', '--timeout=60']], ['kdialog', ['--title', 'Browspark', '--warningcontinuecancel', text]]];
    for (const [cmd, args] of dialogs) {
      try { await run(cmd, args, { timeout: 70_000 }); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    }
  }
  return false;
}

let stopPending = false;
/** Handle a stop request from an extension: one confirmation at a time, nothing ends unless the user confirms it. */
export async function requestStopAll(confirm: (count: number) => Promise<boolean> = confirmWithUser): Promise<{ killed: string[]; disconnected: string[] } | undefined> {
  if (stopPending) return undefined;
  stopPending = true;
  try {
    const count = [...clients.values()].filter((c) => c.initialized).length;
    if (!count || !(await confirm(count))) return undefined;
    return await stopAllAgents();
  } finally { stopPending = false; }
}
