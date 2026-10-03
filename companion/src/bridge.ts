import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIVE_HTML } from './live.ts';
import { currentClient } from './context.ts';
import { allocateDevTabId } from './cdp.ts';
import {
  isEvt, isRes, isExtensionId, type CdpEventParams, type DetachedParams, type HelloParams, type Msg, type Req,
  type ReqMethod, type TabInfo, type ToolPolicy, PROTOCOL_VERSION,
} from '../../shared/protocol.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const identity = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const nativeId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const validExtension = (v: unknown) => object(v) && isExtensionId(v.id) && typeof v.name === 'string' && typeof v.version === 'string' && typeof v.enabled === 'boolean' && Array.isArray(v.permissions) && Array.isArray(v.hostPermissions);

export interface BridgeConnection { id: string; browser?: string; browserEngine?: 'chromium' | 'firefox'; extensionVersion?: string; tabs: TabInfo[]; policy?: ToolPolicy }
interface Identity { id: string; session?: string; nativeToGlobal: Map<number, number>; globalToNative: Map<number, number> }
interface Connection { info: BridgeConnection; identity: Identity; ws: WebSocket; fresh: boolean }

/**
 * Local WebSocket server for independent browser/profile extensions. Native tab ids never leave this boundary.
 * Emits: 'connected'/'disconnected' (BridgeConnection), 'tabs' (TabInfo[]), 'cdp.event', 'detached', 'tools.policy' (policy, connection).
 */
export class Bridge extends EventEmitter {
  private wss?: WebSocketServer;
  private http?: Server;
  /** Set by installLiveView: handles a browser viewer connection for a tab. */
  viewerHandler?: (ws: WebSocket, tabId: number) => void;
  /** Set by the entry point: MCP over Streamable HTTP at /mcp for URL-based clients (web agents, hosted assistants). */
  mcpHandler?: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
  private active = new Map<string, Connection>();
  private identities = new Map<string, Identity>();
  private nextId = 1;
  private pending = new Map<number, { connection: Connection; method: ReqMethod; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  get tabs(): TabInfo[] { return this.connections().flatMap((c) => c.tabs); }
  /** Existing page callers invalidate the cache after navigation; routing identities remain intact. */
  set tabs(tabs: TabInfo[]) { if (tabs.length) throw new Error('Use bridge.listTabs() to refresh extension tabs'); this.invalidateTabs(); }
  get extensionVersion(): string | undefined { return this.active.size === 1 ? this.connections()[0]?.extensionVersion : undefined; }
  /** Browser brand reported by the extension, e.g. "Brave 1.80" or "Google Chrome 152". */
  get browser(): string | undefined { return this.active.size === 1 ? this.connections()[0]?.browser : undefined; }

  /** Requested port; replaced by the bound port after listen() (relevant when 0 was requested). */
  port: number;
  constructor(port: number) { super(); this.port = port; }

  /**
   * No pairing token: the bridge is loopback-only, so the one thing to keep out is a web page in the user's browser
   * reaching 127.0.0.1. Browsers always send an Origin header; extensions and native clients pass, pages do not.
   */
  private originOk(origin?: string): boolean {
    return !origin || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://') || origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const parse = (target?: string) => { try { return new URL(target ?? '/', 'http://x'); } catch { return undefined; } };
      this.http = createServer((req, res) => {
        const u = parse(req.url);
        if (!u) { res.statusCode = 400; res.setHeader('content-type', 'text/plain'); res.end('bad request'); return; }
        if (!this.originOk(req.headers.origin)) { res.statusCode = 403; res.setHeader('content-type', 'text/plain'); res.end('forbidden: web pages cannot use the companion'); return; }
        if (u.pathname === '/mcp' && this.mcpHandler) { this.mcpHandler(req, res).catch((e) => { if (!res.headersSent) { res.statusCode = 500; res.end(String(e?.message ?? e)); } }); return; }
        const live = /^\/live\/(\d+)$/.exec(u.pathname);
        if (live) {
          res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(LIVE_HTML(Number(live[1]))); return;
        }
        res.statusCode = u.pathname === '/' ? 200 : 404; res.setHeader('content-type', 'text/plain'); res.end(u.pathname === '/' ? 'browspark companion' : 'not found');
      });
      this.wss = new WebSocketServer({ noServer: true });
      this.http.on('upgrade', (req, socket, head) => {
        const u = parse(req.url);
        if (!u || !this.originOk(req.headers.origin)) { socket.destroy(); return; }
        if (u.pathname === '/live-ws') {
          const tabId = Number(u.searchParams.get('tab'));
          if (!tabId || !this.viewerHandler) { socket.destroy(); return; }
          this.wss!.handleUpgrade(req, socket, head, (ws) => this.viewerHandler!(ws, tabId));
          return;
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
      });
      this.http.once('error', reject);
      this.http.listen(this.port, '127.0.0.1', () => { this.port = (this.http!.address() as { port: number }).port; resolve(); });
    });
  }

  get connected(): boolean { return this.connections().length > 0; }
  connections(): BridgeConnection[] { return [...this.active.values()].filter((c) => c.ws.readyState === 1).map((c) => c.info); }
  connectionForTab(tabId: number): BridgeConnection | undefined { return [...this.active.values()].find((c) => c.ws.readyState === 1 && c.identity.globalToNative.has(tabId))?.info; }
  invalidateTabs(browserId?: string) { for (const c of this.active.values()) if (!browserId || c.info.id === browserId) c.fresh = false; }
  async listTabs(refresh = false): Promise<TabInfo[]> {
    const connections = [...this.active.values()].filter((c) => c.ws.readyState === 1);
    const results = await Promise.allSettled(connections.map((c) => refresh || !c.fresh ? this.request('tabs.list', undefined, undefined, c.info.id) : Promise.resolve(c.info.tabs)));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed?.status === 'rejected' && results.every((r) => r.status === 'rejected')) throw failed.reason;
    return this.tabs;
  }

  private tabId(c: Connection, id: number): number {
    let mapped = c.identity.nativeToGlobal.get(id);
    if (mapped === undefined) { mapped = allocateDevTabId(); c.identity.nativeToGlobal.set(id, mapped); c.identity.globalToNative.set(mapped, id); }
    return mapped;
  }

  private updateTabs(c: Connection, value: unknown): TabInfo[] {
    if (!Array.isArray(value) || value.some((t) => !object(t) || !nativeId(t.id) || typeof t.url !== 'string' || typeof t.title !== 'string' || typeof t.shared !== 'boolean' || typeof t.attached !== 'boolean' || !nativeId(t.windowId)) || new Set(value.map((t) => t.id)).size !== value.length) throw new Error('invalid extension tabs');
    c.info.tabs = value.map((t) => ({ id: this.tabId(c, t.id), url: t.url, title: t.title, shared: t.shared, attached: t.attached, windowId: t.windowId, agent: typeof t.agent === 'boolean' ? t.agent : undefined, favIconUrl: typeof t.favIconUrl === 'string' ? t.favIconUrl : undefined, unsupported: typeof t.unsupported === 'string' ? t.unsupported : undefined, browserId: c.info.id, browserName: c.info.browser, browserEngine: c.info.browserEngine }));
    c.fresh = true;
    this.emit('tabs', this.tabs);
    return c.info.tabs;
  }

  private disconnect(c: Connection, reason = 'extension disconnected') {
    if (this.active.get(c.info.id) !== c) return;
    this.active.delete(c.info.id);
    for (const [id, p] of this.pending) if (p.connection === c) { clearTimeout(p.timer); p.reject(new Error(reason)); this.pending.delete(id); }
    for (const tabId of c.identity.globalToNative.keys()) this.emit('detached', { tabId, reason });
    this.emit('disconnected', c.info);
    this.emit('tabs', this.tabs);
  }

  private accept(ws: WebSocket) {
    let connection: Connection | undefined;
    ws.on('message', (data) => {
      let msg: Msg;
      try { msg = JSON.parse(data.toString()); } catch { return ws.close(1003, 'bad json'); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return ws.close(1003, 'message must be a JSON object');
      if (!connection) {
        if (!isEvt(msg) || msg.event !== 'hello') return ws.close(4001, 'hello required');
        const p = msg.params as HelloParams;
        if (p?.version !== PROTOCOL_VERSION) return ws.close(4002, `protocol ${PROTOCOL_VERSION} required`);
        if ((p.browserEngine !== undefined && !['chromium', 'firefox'].includes(p.browserEngine)) || !object(p) || typeof p.extensionVersion !== 'string' || p.extensionVersion.length > 128 || (p.browser !== undefined && (typeof p.browser !== 'string' || p.browser.length > 256)) || (p.userAgent !== undefined && (typeof p.userAgent !== 'string' || p.userAgent.length > 4096)) || (p.instanceId !== undefined && !identity(p.instanceId)) || (p.browserSessionId !== undefined && (!identity(p.browserSessionId) || !p.instanceId))) return ws.close(1003, 'invalid hello');
        // Imported profiles can share local storage, but each running browser has its own session storage.
        const key = p.instanceId ? JSON.stringify([p.instanceId, p.browserSessionId]) : crypto.randomUUID();
        let known = this.identities.get(key);
        const previous = known && this.active.get(known.id);
        if (previous) { this.disconnect(previous, 'extension disconnected: connection replaced'); previous.ws.close(1000, 'replaced by same browser'); }
        if (!known) { known = { id: `ext:${crypto.randomUUID()}`, nativeToGlobal: new Map(), globalToNative: new Map() }; this.identities.set(key, known); }
        if (!p.browserSessionId || known.session !== p.browserSessionId) { known.nativeToGlobal.clear(); known.globalToNative.clear(); }
        known.session = p.browserSessionId;
        const browser = p.browser ?? (p.userAgent && /Chrome\/(\d+)/.exec(p.userAgent) ? `Chromium-based ${/Chrome\/(\d+)/.exec(p.userAgent)![1]}` : undefined);
        connection = { info: { id: known.id, browser, browserEngine: p.browserEngine ?? 'chromium', extensionVersion: p.extensionVersion, tabs: [] }, identity: known, ws, fresh: false };
        this.active.set(known.id, connection);
        this.emit('connected', connection.info);
        return;
      }
      if (this.active.get(connection.info.id) !== connection) return;
      try { this.handle(connection, msg); } catch { ws.close(1003, 'invalid extension message'); }
    });
    ws.on('close', () => {
      if (connection) this.disconnect(connection);
    });
  }

  private handle(c: Connection, msg: Msg) {
    if (isRes(msg)) {
      const p = this.pending.get(msg.id);
      if (!p || p.connection !== c) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) { p.reject(new Error(String(msg.error))); return; }
      try {
        let result = msg.result;
        if (p.method === 'tabs.list') result = this.updateTabs(c, result);
        if (p.method === 'tabs.create' || p.method === 'extensions.options') {
          if (!object(result) || !nativeId(result.id)) throw new Error('invalid created tab');
          result = { ...result, id: this.tabId(c, result.id), browserId: c.info.id, browserName: c.info.browser }; c.fresh = false;
        }
        if (p.method === 'extensions.list' && (!Array.isArray(result) || result.some((e) => !validExtension(e)))) throw new Error('invalid extension list');
        if ((p.method === 'extensions.info' || p.method === 'extensions.setEnabled') && !validExtension(result)) throw new Error('invalid extension info');
        if (p.method === 'extensions.message' && (!object(result) || !('reply' in result))) throw new Error('invalid extension message reply');
        if (p.method === 'extensions.uninstall' && (!object(result) || result.uninstalled !== true)) throw new Error('invalid uninstall result');
        if (p.method === 'downloads.list') {
          if (!Array.isArray(result) || result.some((d) => !object(d) || (d.tabId !== undefined && !nativeId(d.tabId)))) throw new Error('invalid extension downloads');
          result = result.map((d) => ({ ...d, ...(d.tabId === undefined ? {} : { tabId: this.tabId(c, d.tabId) }), browserId: c.info.id }));
        }
        p.resolve(result);
      } catch (e) { p.reject(e as Error); }
      return;
    }
    if (!isEvt(msg)) return;
    switch (msg.event) {
      case 'tabs': this.updateTabs(c, msg.params); break;
      case 'cdp.event': {
        const p = msg.params as CdpEventParams;
        if (!object(p) || !nativeId(p.tabId) || typeof p.method !== 'string' || (p.sessionId !== undefined && typeof p.sessionId !== 'string')) throw new Error('invalid CDP event');
        const tabId = c.identity.nativeToGlobal.get(p.tabId);
        if (tabId !== undefined) this.emit('cdp.event', { ...p, tabId });
        break;
      }
      case 'detached': {
        const p = msg.params as DetachedParams;
        if (!object(p) || !nativeId(p.tabId) || typeof p.reason !== 'string') throw new Error('invalid detached event');
        const tabId = c.identity.nativeToGlobal.get(p.tabId);
        if (tabId !== undefined) this.emit('detached', { tabId, reason: p.reason });
        break;
      }
      case 'ping': break;
      case 'tools.policy': {
        const p = msg.params;
        if (!object(p) || !Array.isArray(p.disabled) || p.disabled.some((n) => typeof n !== 'string') || (p.devMode !== undefined && !['auto', 'always', 'never'].includes(p.devMode)) || (p.overlay !== undefined && typeof p.overlay !== 'boolean') || (p.haveCatalog !== undefined && typeof p.haveCatalog !== 'boolean') || (p.graph !== undefined && typeof p.graph !== 'boolean')) throw new Error('invalid tool policy');
        c.info.policy = { disabled: p.disabled, devMode: p.devMode, overlay: p.overlay, haveCatalog: p.haveCatalog, graph: p.graph };
        this.emit('tools.policy', c.info.policy, c.info); break;
      }
    }
  }

  request<T = unknown>(method: ReqMethod, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS, browserId?: string): Promise<T> {
    const tabId = object(params) ? params.tabId : undefined;
    const owner = tabId === undefined ? undefined : this.connectionForTab(tabId);
    if (tabId !== undefined && !owner) return Promise.reject(new Error(`Tab ${tabId} wasn't found in any connected extension. Call browser_tabs.`));
    if (owner && browserId && owner.id !== browserId) return Promise.reject(new Error(`Tab ${tabId} belongs to browser ${owner.id}, not ${browserId}`));
    const selected = browserId ?? owner?.id;
    const c = selected !== undefined ? this.active.get(selected) : this.active.size === 1 ? this.active.values().next().value : undefined;
    if (!c || c.ws.readyState !== 1) return Promise.reject(new Error(selected !== undefined ? `Browser ${selected} is not connected` : this.connected ? `browserId is required; connected browsers: ${this.connections().map((c) => `${c.id} (${c.browser ?? 'Chromium'})`).join(', ')}` : 'extension not connected'));
    const nativeParams = tabId === undefined ? params : { ...params as object, tabId: c.identity.globalToNative.get(tabId) };
    const id = this.nextId++;
    const req: Req = { id, method, params: nativeParams };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.pending.set(id, { connection: c, method, resolve: resolve as (v: unknown) => void, reject, timer });
      try { c.ws.send(JSON.stringify(req)); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  cdp<T = unknown>(tabId: number, method: string, params?: unknown, timeoutMs?: number, sessionId?: string): Promise<T> {
    return this.request<T>('cdp', { tabId, method, params, sessionId, client: currentClient()?.name }, timeoutMs);
  }

  close() {
    for (const c of [...this.active.values()]) { this.disconnect(c, 'extension disconnected: companion shutting down'); c.ws.close(1000, 'companion shutting down'); }
    this.wss?.close();
    this.http?.close();
  }
}
