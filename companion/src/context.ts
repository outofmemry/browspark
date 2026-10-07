// Shared plumbing for tool modules: result helpers, common argument schemas, and the objects tools operate on.
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolInfo, ToolPolicy } from '../../shared/protocol.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Sessions } from './session.ts';
import type { Page } from './page.ts';
import type { Capture } from './devtools/capture.ts';
import { firefoxUnsupportedTool, firefoxExtensionUnsupportedTool } from './firefox-support.ts';

export type Result = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
export const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });
export const image = (data: string, mimeType: string, caption?: string): Result => ({ content: [...(caption ? [{ type: 'text' as const, text: caption }] : []), { type: 'image', data, mimeType }] });
export const fail = (e: unknown): Result => ({ content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
export const json = (v: unknown): Result => text(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
export const run = (fn: () => Promise<Result | string | object | undefined | null | number | boolean>) =>
  fn().then((r) => (r === undefined || r === null ? text('(no result)') : typeof r !== 'object' ? text(String(r)) : 'content' in r && Array.isArray((r as Result).content) ? (r as Result) : json(r))).catch((e) => { noteUnsupported(e instanceof Error ? e.message : String(e)); return fail(e); });

export const tabArg = z.number().int().optional().describe('Target tab id from browser_tabs, which lists tabs across all windows. Defaults to the agent\'s most recently opened usable tab, or the only usable tab. Otherwise select a listed tabId.');
export const refArg = z.string().describe('Element ref from browser_snapshot, e.g. "e12"');
export const pageArgs = { offset: z.number().int().min(0).optional().describe('Pagination offset, default 0'), limit: z.number().int().min(1).max(500).optional().describe('Page size, default 50') };

/** One connected agent (one MCP transport). Everything that must not leak between agents hangs off this. */
export interface ClientState {
  id: string; name: string; initialized?: boolean; ownedTabs: Set<number>; recording?: { tabId: number; name: string; steps: import('./devtools/recorder.ts').Step[]; startedAt: number };
  /** The agent process behind this connection, when it could be found (see agents.ts). */
  process?: import('./agents.ts').AgentIdentity;
  /** Pending process lookup, started while the client's socket is still open. */
  identify?: Promise<import('./agents.ts').AgentIdentity | undefined>;
  /** Close this client's transport (HTTP sessions). */
  disconnect?: () => Promise<void>;
}
export const clients = new Map<string, ClientState>();
export const clientStore = new AsyncLocalStorage<ClientState>();
/** The agent whose tool call is currently executing (undefined outside a tool call). */
export const currentClient = () => clientStore.getStore();
export const ownerOf = (tabId: number) => [...clients.values()].find((c) => c.ownedTabs.has(tabId));

export interface Ctx { server: McpServer; sessions: Sessions; page: Page; capture: Capture; client: ClientState; registry: Map<string, (args: Record<string, unknown>) => Promise<Result>> }

export const toolCatalog: ToolInfo[] = [];

/** Developer-mode gate. The extension's setting (auto/always/never) applies while it is connected; without an extension
 *  there is nobody to ask, so launches are allowed. In auto mode a launch is allowed only shortly after a tool reported
 *  that an operation needs developer mode. */
export const devGate = { policy: 'auto' as 'auto' | 'always' | 'never', lastNeededAt: 0, lastReason: '' };
const NEED_DEV = /wasn't found|Not allowed|isn't allowed|developer mode|requires developer|needs developer/i;
export const noteUnsupported = (message: string) => { if (NEED_DEV.test(message)) { devGate.lastNeededAt = Date.now(); devGate.lastReason = message.slice(0, 160); } };

/** Tools the user switched off in the dashboard. Persisted so the policy holds even before the extension reconnects. */
const POLICY_FILE = join(homedir(), '.browspark', 'tools.json');
export const disabledTools = new Set<string>((() => { try { return JSON.parse(readFileSync(POLICY_FILE, 'utf8')).disabled as string[]; } catch { return []; } })());
export function setDisabledTools(names: string[]) {
  disabledTools.clear(); for (const n of names) disabledTools.add(n);
  try { if (!existsSync(join(homedir(), '.browspark'))) mkdirSync(join(homedir(), '.browspark'), { recursive: true }); writeFileSync(POLICY_FILE, JSON.stringify({ disabled: names })); } catch {}
}
export const combinedPolicy = (policies: ToolPolicy[]): ToolPolicy => ({
  disabled: [...new Set(policies.flatMap(p => p.disabled))],
  devMode: policies.some(p => p.devMode === 'never') ? 'never' : policies.some(p => p.devMode !== 'always') ? 'auto' : 'always',
  overlay: policies.every(p => p.overlay !== false),
});
const disabledResult = (name: string): Result => ({ content: [{ type: 'text', text: `The ${name} tool is switched off in the Browspark dashboard. Tell the user to turn it on under the Tools page of the extension, then try again.` }], isError: true });

export function tool<S extends z.ZodRawShape>(ctx: Ctx, name: string, description: string, schema: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result | string | object>) {
  const wrapped = (args: any) => clientStore.run(ctx.client, () => run(async () => {
    const browserSelection = name === 'browser_fetch' || name === 'browser_extensions' || name === 'browser_tabs' && ['list', 'new'].includes(args.action);
    const global = name === 'browser_status' || name === 'browser_session' || name === 'devtools_lighthouse' || name === 'browser_policy' && (args.default || args.action === 'status') || name === 'devtools_cdp' && args.target === 'browser' || name === 'devtools_recorder' && !['start', 'replay'].includes(args.action);
    if (!global && !browserSelection && 'tabId' in schema) args = { ...args, tabId: await ctx.sessions.resolve(args.tabId, name === 'browser_navigate' && args.action === 'goto') };
    const connection = global ? undefined : browserSelection ? ctx.sessions.bridge?.connections().find((c, _, all) => c.id === (args.browserId ?? (name === 'browser_extensions' && all.length === 1 ? c.id : undefined))) : ctx.sessions.bridge?.connectionForTab(args.tabId);
    if (connection?.policy ? connection.policy.disabled.includes(name) : disabledTools.has(name)) return disabledResult(name);
    if (firefoxExtensionUnsupportedTool(name, args) && ctx.sessions.bridge?.connectionForTab(args.tabId)?.browserEngine === 'firefox') throw new Error(`${name}${args.action ? ` action:${args.action}` : ''} is unsupported in the Firefox extension. See the Firefox support guide for extension capabilities and developer-session alternatives.`);
    if (firefoxUnsupportedTool(name, args)) {
      const id = await ctx.sessions.resolve(args.tabId);
      if (ctx.sessions.devOfTab(id)?.browserType === 'firefox') throw new Error(`${name}${args.action ? ` action:${args.action}` : ''} is unsupported in Firefox. See the Firefox support guide for available operations.`);
    }
    return handler(args);
  }));
  ctx.registry.set(name, (args) => wrapped(z.object(schema).parse(args)));
  if (!toolCatalog.some((t) => t.name === name)) toolCatalog.push({ name, description });
  ctx.server.registerTool(name, { description, inputSchema: schema }, wrapped as any);
}

/** Regex-or-substring matcher used by every search tool. */
export function matcher(q?: string, regex?: boolean, flags = 'i'): (s: string | undefined | null) => boolean {
  if (!q) return () => true;
  if (regex) { const re = new RegExp(q, flags); return (s) => !!s && re.test(s); }
  const needle = q.toLowerCase();
  return (s) => !!s && s.toLowerCase().includes(needle);
}

export function paginate<T>(items: T[], offset = 0, limit = 50) {
  const total = items.length;
  const slice = items.slice(offset, offset + limit);
  return { total, offset, limit, returned: slice.length, hasMore: offset + slice.length < total, items: slice };
}

export const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s);
