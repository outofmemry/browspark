// Shared e2e plumbing: throwaway Chrome with the extension, companion over stdio, pairing, tool-call helpers.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const ROOT = resolve(import.meta.dirname, '../..');

export class Cdp {
  private id = 0; private pending = new Map<number, (r: any) => void>(); events: any[] = [];
  private ws: WebSocket;
  constructor(ws: WebSocket) { this.ws = ws; ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id) this.pending.get(m.id)?.(m); else this.events.push(m); }); }
  static async connect(profile: string) {
    for (let i = 0; i < 100; i++) {
      try { const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }); return new Cdp(ws); }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('Chrome did not start');
  }
  send(method: string, params?: unknown, sessionId?: string): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => this.pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))));
  }
  close() { this.ws.close(); }
}

export interface Ext { chrome: ChildProcess; cdp: Cdp; profile: string; extId: string; cleanup: () => Promise<void>; msg?: (m: unknown) => Promise<any>; eval?: (expr: string) => Promise<any> }

/** Launch a throwaway Chrome with the extension loaded via CDP (Chrome 137+ ignores --load-extension in branded builds). */
export async function launchExtensionChrome(executable = CHROME): Promise<Ext> {
  const profile = mkdtempSync(join(tmpdir(), 'bmcp-e2e-'));
  const chrome = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });
  let cdp: Cdp | undefined, spawnError: Error | undefined;
  chrome.once('error', (error) => { spawnError = error; });
  const cleanup = async () => {
    cdp?.close();
    if (chrome.pid && chrome.exitCode === null && chrome.signalCode === null) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { chrome.kill('SIGKILL'); resolve(); }, 1500);
      chrome.once('exit', () => { clearTimeout(timer); resolve(); }); chrome.kill();
    });
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    cdp = await Cdp.connect(profile);
    const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: join(ROOT, 'dist/chromium-extension') });
    return { chrome, cdp, profile, extId, cleanup };
  } catch (error) { await cleanup(); throw spawnError ?? error; }
}

export async function startCompanion(name = 'e2e'): Promise<Client> {
  const client = new Client({ name, version: '0' });
  await client.connect(new StdioClientTransport({ command: 'bun', args: [join(ROOT, 'companion/src/index.ts'), '--port', '0'], stderr: 'inherit', env: { ...process.env, BROWSPARK_ARTIFACTS: mkdtempSync(join(tmpdir(), 'bmcp-artifacts-')), BROWSPARK_PROFILE: mkdtempSync(join(tmpdir(), 'bmcp-devprofile-')), BROWSPARK_PROFILES: mkdtempSync(join(tmpdir(), 'bmcp-profiles-')) } }));
  return client;
}

export function callers(client: Client) {
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: any[]; isError?: boolean };
    const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { txt, img: r.content.find((c) => c.type === 'image'), err: !!r.isError };
  };
  const ok = async (name: string, args?: Record<string, unknown>) => { const r = await call(name, args); assert.ok(!r.err, `${name} ${JSON.stringify(args)} failed: ${r.txt}`); return r.txt; };
  const okJson = async <T = any>(name: string, args?: Record<string, unknown>): Promise<T> => JSON.parse(await ok(name, args));
  return { call, ok, okJson };
}

/** Talk to the extension worker the way the dashboard does (opens the dashboard page once). */
export async function dashboard(ext: Ext): Promise<(m: unknown) => Promise<any>> {
  if (ext.msg) return ext.msg;
  const app = await ext.cdp.send('Target.createTarget', { url: `chrome-extension://${ext.extId}/app.html` });
  const { sessionId } = await ext.cdp.send('Target.attachToTarget', { targetId: app.targetId, flatten: true });
  for (let i = 0; i < 50; i++) { const r = await ext.cdp.send('Runtime.evaluate', { expression: 'typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage', returnByValue: true }, sessionId); if (r.result.value) break; await new Promise((r) => setTimeout(r, 100)); }
  ext.msg = (m: unknown) => ext.cdp.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage(${JSON.stringify(m)})`, awaitPromise: true, returnByValue: true }, sessionId).then((r) => r.result.value);
  ext.eval = (expr: string) => ext.cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId).then((r) => r.result.value);
  return ext.msg;
}

/** Foreground a page tab via raw browser CDP (bypasses the product's background-mode gate:
 *  this simulates the user looking at the tab). Needed because Chrome 153 stops delivering
 *  debugger-driven synthetic input to hidden tabs after a navigation until they are activated. */
export async function foregroundTab(ext: Ext, urlSubstring: string): Promise<void> {
  const { targetInfos } = await ext.cdp.send('Target.getTargets');
  const t = targetInfos.find((x: any) => x.type === 'page' && String(x.url).includes(urlSubstring));
  assert.ok(t, `no page target for ${urlSubstring}`);
  await ext.cdp.send('Target.activateTarget', { targetId: t.targetId });
}

/** Resolve a tab's companion id; extension dashboard ids belong to the browser and must never go to MCP. */
export async function companionTab(ok: (n: string, a?: Record<string, unknown>) => Promise<string>, url: string, windowId?: number): Promise<{ id: number; browserId?: string; line: string }> {
  for (let i = 0; i < 50; i++) {
    const rows = (await ok('browser_tabs', { onlyUsable: false })).split('\n').filter((line) => (line.endsWith(` — ${url}`) || line.includes(` — ${url} `)) && (windowId === undefined || line.includes(`(window ${windowId})`)));
    assert.ok(rows.length <= 1, `Multiple companion tabs have URL ${url}; use unique fixture URLs`);
    const line = rows[0], id = line && /^\s*\[(\d+)\]/.exec(line)?.[1];
    if (id) return { id: Number(id), browserId: /ext:[a-f0-9-]+/i.exec(line)?.[0], line };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Companion did not list tab ${url}`);
}

/** Point the extension at a companion and share the matching native tab. Returns its companion id. */
export async function pairAndShare(ext: Ext, ok: (n: string, a?: Record<string, unknown>) => Promise<string>, urlPrefix: string, shareAll = false): Promise<number> {
  const status = await ok('browser_status');
  const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)/.exec(status)![1]);
  const msg = await dashboard(ext);
  await msg({ type: 'setConfig', port });
  let st: any;
  for (let i = 0; i < 50 && !(st = await msg({ type: 'getState' })).connected; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(st.connected, true, `extension did not connect: ${JSON.stringify({ ...st, tabs: undefined, recent: undefined })}`);
  const tab = st.tabs.find((t: any) => t.url.startsWith(urlPrefix));
  assert.ok(tab, `No native tab found for ${urlPrefix}`);
  if (shareAll) await msg({ type: 'setShareAll', on: true }); else await msg({ type: 'setShared', tabIds: [tab.id], shared: true });
  return (await companionTab(ok, tab.url, tab.windowId)).id;
}
