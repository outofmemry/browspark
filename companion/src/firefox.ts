// Firefox developer browsers use native WebDriver BiDi; user-owned tabs stay behind the extension.
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { allocateDevTabId, type DevTab, type Download, type LaunchOptions } from './cdp.ts';
import { FirefoxNetwork } from './firefox-network.ts';
import { FirefoxDOM } from '../../shared/firefox-dom.ts';
import { findBrowser } from './browsers.ts';

export const findFirefox = (explicit?: string): string => findBrowser('firefox', explicit);

export function firefoxProxy(value: string): Record<string, unknown> {
  const url = new URL(value.includes('://') ? value : `http://${value}`);
  if (url.username || url.password || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) throw new Error('Firefox proxy must be a host and port without credentials or a path');
  const host = `${url.hostname}:${url.port || (url.protocol === 'http:' ? 80 : url.protocol === 'https:' ? 443 : 1080)}`;
  if (url.protocol === 'http:') return { proxyType: 'manual', httpProxy: host, sslProxy: host };
  if (url.protocol === 'socks5:' || url.protocol === 'socks4:') return { proxyType: 'manual', socksProxy: host, socksVersion: url.protocol === 'socks5:' ? 5 : 4 };
  throw new Error('Firefox proxy supports http://, socks4:// and socks5:// servers');
}

/** Decode BiDi's tagged values without losing arrays, nested objects, null, or special numbers. */
export function decodeBiDiValue(v: any): any {
  const references = new Map<string, any>(), active = new Set<string>();
  const decode = (value: any): any => {
    if (!value) return undefined;
    const id = value.internalId;
    if (id && active.has(id)) throw new Error('Firefox cannot serialize a cyclic object by value; use devtools_evaluate with returnByValue:false to inspect a live object.');
    if (id && references.has(id)) return references.get(id);
    if (id) active.add(id);
    let result: any;
    switch (value.type) {
      case 'undefined': case 'node': case 'window': case 'function': result = undefined; break;
      case 'null': result = null; break;
      case 'number': result = typeof value.value === 'string' ? ({ NaN, Infinity, '-Infinity': -Infinity, '-0': -0 } as Record<string, number>)[value.value] : value.value; break;
      case 'array': case 'set': result = (value.value ?? []).map(decode); break;
      case 'object': case 'map': result = Object.fromEntries((value.value ?? []).map(([key, entry]: any[]) => [typeof key === 'string' ? key : String(decode(key)), decode(entry)])); break;
      default: result = value.value;
    }
    if (id) { active.delete(id); references.set(id, result); }
    return result;
  };
  return decode(v);
}

const localValue = (value: any): any => {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null' };
  if (typeof value === 'number') return { type: 'number', value: Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value) };
  if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
  if (Array.isArray(value)) return { type: 'array', value: value.map(localValue) };
  if (typeof value === 'object') return { type: 'object', value: Object.entries(value).map(([k, v]) => [k, localValue(v)]) };
  return { type: typeof value, value };
};
const KEY: Record<string, string> = { Backspace: '\uE003', Tab: '\uE004', Enter: '\uE007', Shift: '\uE008', Control: '\uE009', Alt: '\uE00A', Escape: '\uE00C', PageUp: '\uE00E', PageDown: '\uE00F', End: '\uE010', Home: '\uE011', ArrowLeft: '\uE012', ArrowUp: '\uE013', ArrowRight: '\uE014', ArrowDown: '\uE015', Insert: '\uE016', Delete: '\uE017', Meta: '\uE03D' };
const MODIFIERS: [number, string][] = [[1, KEY.Alt], [2, KEY.Control], [4, KEY.Meta], [8, KEY.Shift]];
type FirefoxTab = DevTab & { clientWindow?: string };
type RemoteRef = { tabId: number; realm: string; value: any };

export class DirectFirefox extends EventEmitter {
  readonly browserType = 'firefox' as const;
  readonly profileDir: string;
  readonly name: string;
  readonly browserName: 'firefox' | 'zen';
  port = 0;
  version?: string;
  wsEndpoint?: string;
  headless = false;
  proxy?: string;
  downloadDir = '';
  downloadsSupported = false;
  readonly downloads = new Map<string, Download>();
  readonly loadedExtensions: { id: string; path: string }[] = [];
  private proc?: ChildProcess;
  private ws?: WebSocket;
  private nextId = 1;
  private nextObject = 1;
  private nextRealm = 1;
  private launching = false;
  private launchCancelled = false;
  private closing?: Promise<void>;
  private stopping?: Promise<void>;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private tabs = new Map<number, FirefoxTab>();
  private contexts = new Map<string, { tabId: number; parent?: string }>();
  private realms = new Map<number, { realm: string; context: string; sandbox?: string; tabId: number }>();
  private objects = new Map<string, RemoteRef>();
  private modifiers = new Map<number, number>();
  private windowBounds = new Map<string, any>();
  private readonly network = new FirefoxNetwork((method, params) => this.bidi(method, params), (tabId, method, params) => this.event(tabId, method, params));
  private readonly dom = new FirefoxDOM((tabId, method, params) => this.cdp(tabId, method, params));

  constructor(profileDir = join(homedir(), '.browspark', 'firefox-profile'), name = 'default', browserName: 'firefox' | 'zen' = 'firefox') { super(); this.profileDir = profileDir; this.name = name; this.browserName = browserName; }
  get running(): boolean { return this.ws?.readyState === WebSocket.OPEN; }
  get busy(): boolean { return this.running || this.launching || !!this.proc || !!this.closing || !!this.stopping; }
  get pid(): number | undefined { return this.proc?.pid; }

  async launch(opts: LaunchOptions = {}): Promise<void> {
    if (this.busy) throw new Error('Development browser already running or changing state');
    if (opts.extensions?.length) throw this.unsupported('Loading unpacked extensions');
    if (opts.devtools) throw this.unsupported('Automatically opening DevTools');
    if (opts.args?.some((a) => /^--?(?:profile(?:=|$)|P(?:=|$)|remote-debugging-port(?:=|$))/.test(a))) throw new Error('Firefox profile and debugging-port arguments are managed by Browspark');
    const executable = findBrowser(this.browserName, opts.browserPath ?? opts.firefoxPath);
    const proxy = opts.proxy ? firefoxProxy(opts.proxy) : undefined;
    this.launching = true; this.launchCancelled = false;
    this.headless = !!opts.headless; this.proxy = opts.proxy;
    this.downloadDir = opts.downloadDir ?? join(homedir(), '.browspark', 'downloads', this.browserName, this.name);
    try {
      mkdirSync(this.profileDir, { recursive: true }); mkdirSync(this.downloadDir, { recursive: true });
      // Keep Firefox's startup metadata isolated too; macOS 27 protects the user's default app-data directory.
      const profile = realpathSync(this.profileDir), appData = join(profile, '.app-data');
      mkdirSync(appData, { recursive: true });
      const serverFile = join(this.profileDir, 'WebDriverBiDiServer.json');
      rmSync(serverFile, { force: true });
      const prefs: Record<string, unknown> = { 'remote.active-protocols': 1, 'browser.shell.checkDefaultBrowser': false, 'browser.aboutwelcome.enabled': false, 'browser.download.folderList': 2, 'browser.download.dir': this.downloadDir, 'browser.download.useDownloadDir': true };
      const prefFile = join(this.profileDir, 'user.js');
      const existing = existsSync(prefFile) ? readFileSync(prefFile, 'utf8') : '';
      writeFileSync(prefFile, existing.replace(/\n?\/\/ Browspark preferences begin[\s\S]*?\/\/ Browspark preferences end\n?/g, '') + '\n// Browspark preferences begin\n' + Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n') + '\n// Browspark preferences end\n');
      const size = opts.windowSize?.split(',').map(Number);
      const proc = spawn(executable, ['--no-remote', '--profile', profile, '--remote-debugging-port=0', ...(opts.headless ? ['--headless'] : []), ...(size?.length === 2 && size.every((n) => Number.isInteger(n) && n > 0) ? ['--width', String(size[0]), '--height', String(size[1])] : []), ...(opts.args ?? []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MOZ_APP_DATA: appData } });
      this.proc = proc;
      let stderr = '', endpoint: string | undefined, processError: Error | undefined;
      proc.stderr?.on('data', (data) => { stderr = (stderr + data.toString()).slice(-8192); const match = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(stderr); if (match) endpoint = match[1].replace(/\/$/, '') + '/session'; });
      proc.once('error', (error) => { processError = error; if (!proc.pid && this.proc === proc) this.proc = undefined; });
      proc.once('exit', () => { if (this.proc === proc) { this.proc = undefined; this.ws?.terminate(); } });
      for (let i = 0; i < 150 && !endpoint; i++) {
        if (this.launchCancelled) throw new Error('Development browser launch cancelled');
        if (processError) throw processError;
        if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`Firefox exited before opening WebDriver BiDi${stderr ? `: ${stderr.trim().slice(-1000)}` : ''}`);
        try { const { ws_host, ws_port } = JSON.parse(readFileSync(serverFile, 'utf8')); if (Number.isInteger(ws_port) && ws_port > 0 && ws_port <= 65535 && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(ws_host)) endpoint = `ws://${ws_host === '::1' ? '[::1]' : ws_host}:${ws_port}/session`; } catch {}
        if (!endpoint) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.launchCancelled) throw new Error('Development browser launch cancelled');
      if (!endpoint) throw new Error(`Firefox started but never exposed its WebDriver BiDi endpoint${stderr ? `: ${stderr.trim().slice(-1000)}` : ''}`);
      const address = new URL(endpoint);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) throw new Error('Firefox debugging endpoint must be on loopback');
      this.port = Number(address.port); this.wsEndpoint = endpoint;
      await this.connect(endpoint);
      if (this.launchCancelled) throw new Error('Development browser launch cancelled');
      const session = await this.bidi('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: 'ignore', ...(proxy && { proxy }) } } });
      // Zen reports Firefox capabilities; keep the requested brand so the graph shows the Zen logo.
      const reported = this.browserName === 'zen' ? 'Zen' : session.capabilities.browserName ?? 'Firefox';
      this.version = `${reported}/${session.capabilities.browserVersion ?? 'unknown'}`;
      await this.bidi('session.subscribe', { events: ['browsingContext.contextCreated', 'browsingContext.contextDestroyed', 'browsingContext.navigationStarted', 'browsingContext.domContentLoaded', 'browsingContext.load', 'browsingContext.fragmentNavigated', 'browsingContext.userPromptOpened', 'browsingContext.userPromptClosed', 'log.entryAdded', 'script.realmCreated', 'script.realmDestroyed'] });
      const tree = await this.bidi('browsingContext.getTree', {});
      for (const context of tree.contexts) this.addContext(context);
      this.downloadsSupported = false;
      try {
        await this.bidi('browser.setDownloadBehavior', { downloadBehavior: { type: 'allowed', destinationFolder: this.downloadDir } });
        await this.bidi('session.subscribe', { events: ['browsingContext.downloadWillBegin', 'browsingContext.downloadEnd'] });
        this.downloadsSupported = true;
      } catch (e) { this.emit('warning', `Download tracking is unsupported in this Firefox build: ${(e as Error).message}`); }
      if (opts.url && opts.url !== 'about:blank') {
        const first = this.listTabs()[0];
        if (first) await this.cdp(first.id, 'Page.navigate', { url: opts.url }); else await this.newTab(opts.url);
      }
      if (this.launchCancelled) throw new Error('Development browser launch cancelled');
    } catch (error) { await this.close(); throw error; }
    finally { this.launching = false; }
  }

  private async connect(endpoint: string) {
    const ws = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024, handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on('message', (data) => { try { this.onMessage(JSON.parse(data.toString())); } catch (e) { this.emit('warning', `Invalid Firefox protocol message: ${(e as Error).message}`); } });
    ws.on('error', () => {}); // handshake rejects below; later failures are followed by close
    ws.on('close', () => { if (this.ws === ws) this.disconnected(); });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('close', () => reject(new Error('Firefox disconnected during connection'))); });
  }

  private disconnected() {
    this.ws = undefined;
    void this.stopProcess();
    for (const pending of this.pending.values()) pending.reject(new Error('Firefox development browser disconnected'));
    this.pending.clear();
    for (const tab of this.tabs.values()) { void this.network.clear(tab.id); this.dom.clear(tab.id); this.emit('detached', { tabId: tab.id, reason: 'browser closed' }); }
    this.tabs.clear(); this.contexts.clear(); this.realms.clear(); this.objects.clear(); this.modifiers.clear(); this.windowBounds.clear();
    this.emit('closed');
  }

  /** Native transport is exposed for protocol tests; the public MCP raw-CDP tool remains Chromium-only. */
  bidi<T = any>(method: string, params: any = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.running) return Promise.reject(new Error('Firefox development browser is not running; call browser_session launch'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs}ms`)); }, timeoutMs);
      const fail = (error: Error) => { clearTimeout(timer); this.pending.delete(id); reject(error); };
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: fail });
      try { this.ws!.send(JSON.stringify({ id, method, params }), (error) => { if (error) fail(error); }); } catch (e) { fail(e as Error); }
    });
  }

  private addContext(info: any, parent?: string): FirefoxTab | undefined {
    const ancestor = parent ?? info.parent;
    let tab: FirefoxTab | undefined;
    if (ancestor) { const owner = this.contexts.get(ancestor); if (owner) { this.contexts.set(info.context, { tabId: owner.tabId, parent: ancestor }); tab = this.tabs.get(owner.tabId); } }
    else {
      tab = this.listTabs().find((t) => t.targetId === info.context);
      if (!tab) { tab = { id: allocateDevTabId(), targetId: info.context, type: 'page', url: info.url ?? 'about:blank', title: '', sessionId: info.context, clientWindow: info.clientWindow }; this.tabs.set(tab.id, tab); }
      else { tab.url = info.url ?? tab.url; tab.clientWindow = info.clientWindow ?? tab.clientWindow; }
      this.contexts.set(info.context, { tabId: tab.id });
    }
    for (const child of info.children ?? []) this.addContext(child, info.context);
    return tab;
  }

  private event(tabId: number, method: string, params: any) { this.emit('cdp.event', { tabId, method, params }); }
  private realmId(info: any, replay = false): number | undefined {
    const owner = this.contexts.get(info.context);
    if (!owner) return undefined;
    const existing = [...this.realms].find(([, realm]) => realm.realm === info.realm);
    if (existing && !replay) return existing[0];
    const id = existing?.[0] ?? this.nextRealm++;
    if (!existing) this.realms.set(id, { realm: info.realm, context: info.context, sandbox: info.sandbox, tabId: owner.tabId });
    this.event(owner.tabId, 'Runtime.executionContextCreated', { context: { id, origin: info.origin ?? '', name: info.sandbox ?? '', uniqueId: info.realm, auxData: { frameId: info.context, isDefault: !info.sandbox, name: info.sandbox, type: info.sandbox ? 'isolated' : 'default' } } });
    return id;
  }

  private onMessage(message: any) {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === 'error' || message.error) pending.reject(new Error(`${message.error}: ${message.message ?? ''}${/unknown command|unsupported operation/.test(message.error ?? '') ? ' (unsupported in Firefox)' : ''}`));
      else pending.resolve(message.result);
      return;
    }
    const { method, params: p = {} } = message;
    if (method === 'browsingContext.contextCreated') { this.addContext(p); return; }
    if (method === 'script.realmCreated') { this.realmId(p); return; }
    if (method === 'script.realmDestroyed') {
      for (const [id, realm] of this.realms) if (realm.realm === p.realm) { this.realms.delete(id); this.event(realm.tabId, 'Runtime.executionContextDestroyed', { executionContextId: id }); }
      for (const [id, object] of this.objects) if (object.realm === p.realm) this.objects.delete(id);
      return;
    }
    const context = p.context ?? p.source?.context;
    const owner = this.contexts.get(context);
    const tab = owner && this.tabs.get(owner.tabId);
    if (!tab) return;
    if (method === 'browsingContext.contextDestroyed') {
      const removed = new Set<string>([context]);
      for (const [id, info] of this.contexts) {
        if (info.tabId !== tab.id) continue;
        let ancestor: string | undefined = id;
        while (ancestor) { if (ancestor === context) { removed.add(id); break; } ancestor = this.contexts.get(ancestor)?.parent; }
      }
      const removedRealms = new Set<string>();
      for (const [id, realm] of this.realms) if (removed.has(realm.context)) { this.realms.delete(id); removedRealms.add(realm.realm); this.event(tab.id, 'Runtime.executionContextDestroyed', { executionContextId: id }); }
      for (const [id, object] of this.objects) if (removedRealms.has(object.realm)) this.objects.delete(id);
      for (const id of removed) { this.contexts.delete(id); if (owner?.parent) this.event(tab.id, 'Page.frameDetached', { frameId: id, reason: 'remove' }); }
      if (!owner?.parent) { this.tabs.delete(tab.id); void this.network.clear(tab.id); this.dom.clear(tab.id); this.modifiers.delete(tab.id); for (const [id, object] of this.objects) if (object.tabId === tab.id) this.objects.delete(id); this.emit('detached', { tabId: tab.id, reason: 'target closed' }); }
      return;
    }
    if (typeof method !== 'string') return;
    if (method.startsWith('network.')) { this.network.onEvent(tab.id, method, p); return; }
    if (method === 'browsingContext.downloadWillBegin') {
      this.downloads.set(p.download, { guid: p.download, tabId: tab.id, url: p.url, filename: p.suggestedFilename, state: 'inProgress', receivedBytes: 0, totalBytes: 0, startedAt: p.timestamp });
    } else if (method === 'browsingContext.downloadEnd') {
      const download = this.downloads.get(p.download);
      if (download) { download.state = p.status === 'complete' ? 'completed' : 'canceled'; if (p.filepath) { download.path = p.filepath; try { download.receivedBytes = download.totalBytes = statSync(p.filepath).size; } catch {} } }
    } else if (method === 'browsingContext.navigationStarted') {
      if (!owner?.parent) { tab.url = p.url; this.dom.clear(tab.id); this.event(tab.id, 'Runtime.executionContextsCleared', {}); }
    } else if (method === 'browsingContext.load') {
      this.event(tab.id, 'Page.frameNavigated', { frame: { id: context, parentId: owner?.parent, url: p.url } });
      if (!owner?.parent) { tab.url = p.url; this.event(tab.id, 'Page.loadEventFired', { timestamp: p.timestamp / 1000 }); void this.bidi('script.evaluate', { expression: 'document.title', target: { context }, awaitPromise: false }).then((r) => { if (r.type === 'success') tab.title = r.result.value ?? ''; }).catch(() => {}); }
    } else if (method === 'browsingContext.domContentLoaded') { if (!owner?.parent) this.event(tab.id, 'Page.domContentEventFired', { timestamp: p.timestamp / 1000 }); }
    else if (method === 'browsingContext.fragmentNavigated') { if (!owner?.parent) { tab.url = p.url; this.event(tab.id, 'Page.navigatedWithinDocument', { frameId: context, url: p.url }); } }
    else if (method === 'browsingContext.userPromptOpened') this.event(tab.id, 'Page.javascriptDialogOpening', { type: p.type, message: p.message, defaultPrompt: p.defaultValue });
    else if (method === 'browsingContext.userPromptClosed') this.event(tab.id, 'Page.javascriptDialogClosed', { result: p.accepted, userInput: p.userText });
    else if (method === 'log.entryAdded') {
      const stackTrace = p.stackTrace && { callFrames: p.stackTrace.callFrames.map((f: any) => ({ ...f, scriptId: '' })) };
      const realm = [...this.realms].find(([, r]) => r.realm === p.source?.realm)?.[0];
      if (p.type === 'console') this.event(tab.id, 'Runtime.consoleAPICalled', { type: p.method ?? p.level, args: (p.args ?? []).map((value: any) => this.remoteObject(tab.id, value, p.source?.realm, false)), stackTrace, executionContextId: realm, timestamp: p.timestamp });
      else if (p.type === 'javascript') this.event(tab.id, 'Runtime.exceptionThrown', { timestamp: p.timestamp, exceptionDetails: { text: p.text, exception: { type: 'object', subtype: 'error', description: p.text }, stackTrace, executionContextId: realm, lineNumber: p.stackTrace?.callFrames?.[0]?.lineNumber ?? 0, columnNumber: p.stackTrace?.callFrames?.[0]?.columnNumber ?? 0 } });
      else this.event(tab.id, 'Log.entryAdded', { entry: { level: p.level, text: p.text, source: p.type, timestamp: p.timestamp, stackTrace } });
    }
  }

  private unsupported(method: string): Error { return new Error(`${method} is unsupported in Firefox. This operation requires a Chromium developer browser.`); }
  private requireTab(tabId: number): FirefoxTab { const tab = this.tabs.get(tabId); if (!tab) throw new Error(`Dev tab ${tabId} does not exist`); return tab; }
  private target(tab: FirefoxTab, contextId?: number): any { if (contextId === undefined) return { context: tab.targetId }; const realm = this.realms.get(contextId); if (!realm || realm.tabId !== tab.id) throw new Error('Cannot find context; refresh the page execution contexts'); return { realm: realm.realm }; }
  private object(tabId: number, id: string): RemoteRef { const object = this.objects.get(id); if (!object || object.tabId !== tabId) throw new Error('Stale or unknown Firefox object; evaluate or snapshot the page again'); return object; }
  private reference(object: RemoteRef): any { return object.value.handle ? { handle: object.value.handle } : { sharedId: object.value.sharedId }; }

  private remoteObject(tabId: number, value: any, realm: string, byValue: boolean): any {
    const primitive = ['undefined', 'string', 'number', 'boolean', 'bigint'].includes(value.type);
    const result: any = { type: primitive ? value.type : value.type === 'function' ? 'function' : 'object' };
    if (value.type === 'null') { result.subtype = 'null'; result.value = null; return result; }
    if (value.type === 'number' && typeof value.value === 'string') result.unserializableValue = value.value;
    else if (value.type === 'bigint') result.unserializableValue = `${value.value}n`;
    else if (primitive && value.type !== 'undefined') result.value = value.value;
    else if (byValue && !primitive) result.value = decodeBiDiValue(value);
    if (!primitive) {
      if (value.type !== 'object' && value.type !== 'function') result.subtype = value.type;
      result.className = value.type === 'array' ? 'Array' : value.type === 'node' ? value.value?.localName ?? 'Node' : value.type === 'function' ? 'Function' : 'Object';
      result.description = value.type === 'array' ? `Array(${value.value?.length ?? 0})` : value.type === 'node' ? `<${value.value?.localName ?? 'node'}>` : result.className;
      // Console events carry serialized snapshots, usually without live handles. Keep their contents searchable.
      if (['object', 'array'].includes(value.type) && Array.isArray(value.value)) {
        const describe = (v: any, depth = 2): string => {
          if (v.type === 'null' || v.type === 'undefined') return v.type;
          if (['string', 'number', 'boolean', 'bigint'].includes(v.type)) return String(v.value).slice(0, 160) + (v.type === 'bigint' ? 'n' : '');
          if (!depth || !Array.isArray(v.value)) return v.type;
          const entries = v.type === 'array' ? v.value.map((item: any, index: number) => [String(index), item]) : v.value;
          if (v.type !== 'array' && v.type !== 'object') return v.type;
          const text = entries.slice(0, 8).map(([key, item]: any[]) => (v.type === 'array' ? '' : `${key}: `) + describe(item, depth - 1)).join(', ') + (entries.length > 8 ? ', …' : '');
          return v.type === 'array' ? `[${text}]` : `{${text}}`;
        };
        const entries = value.type === 'array' ? value.value.map((item: any, index: number) => [String(index), item]) : value.value;
        result.preview = { type: 'object', subtype: result.subtype, overflow: entries.length > 8, properties: entries.slice(0, 8).map(([name, item]: any[]) => ({ name, type: item.type, value: describe(item) })) };
      }
      if (!byValue && (value.handle || value.sharedId)) { const objectId = `firefox:${this.nextObject++}`; this.objects.set(objectId, { tabId, realm, value }); result.objectId = objectId; }
    }
    return result;
  }

  private evaluation(tabId: number, result: any, byValue: boolean): any {
    if (result.type === 'exception') { const d = result.exceptionDetails; return { exceptionDetails: { ...d, exception: { ...this.remoteObject(tabId, d.exception, result.realm, byValue), description: d.text } } }; }
    return { result: this.remoteObject(tabId, result.result, result.realm, byValue) };
  }

  private async setModifiers(tab: FirefoxTab, mask: number) {
    const before = this.modifiers.get(tab.id) ?? 0;
    const actions = MODIFIERS.filter(([bit]) => !!(before & bit) !== !!(mask & bit)).map(([bit, value]) => ({ type: mask & bit ? 'keyDown' : 'keyUp', value }));
    if (actions.length) await this.bidi('input.performActions', { context: tab.targetId, actions: [{ type: 'key', id: `keyboard-${tab.id}`, actions }] });
    this.modifiers.set(tab.id, mask);
  }

  private async input(tab: FirefoxTab, method: string, p: any) {
    if (method === 'Input.insertText') {
      if (/[\uE000-\uE05D]/.test(p.text)) throw new Error('Literal WebDriver special-key code points are unsupported in Firefox text insertion');
      if (/[\r\n]/.test(p.text)) {
        // BiDi has key actions but no insertText; an Enter handler can submit even a textarea.
        throw new Error('Literal multiline text insertion is unsupported in Firefox. Use browser_key with key:"Enter" only to intentionally press Enter.');
      }
    }
    try {
      await this.setModifiers(tab, p.modifiers ?? 0);
      let source: any;
      if (method === 'Input.insertText') {
        source = { type: 'key', id: `keyboard-${tab.id}`, actions: [...p.text].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) };
      } else if (method === 'Input.dispatchKeyEvent') {
        if (!['keyDown', 'rawKeyDown', 'keyUp'].includes(p.type)) throw this.unsupported(`${method} type ${p.type}`);
        const value = KEY[p.key] ?? p.key;
        if (!value || [...value].length !== 1) throw new Error(`Unsupported Firefox key: ${p.key}`);
        source = { type: 'key', id: `keyboard-${tab.id}`, actions: [{ type: p.type === 'keyUp' ? 'keyUp' : 'keyDown', value }] };
      } else {
        const move = { type: 'pointerMove', x: Math.round(p.x), y: Math.round(p.y), duration: 0, origin: 'viewport' };
        if (p.type === 'mouseWheel') source = { type: 'wheel', id: `wheel-${tab.id}`, actions: [{ type: 'scroll', x: move.x, y: move.y, deltaX: Math.round(p.deltaX ?? 0), deltaY: Math.round(p.deltaY ?? 0), duration: 0 }] };
        else {
          if (!['mouseMoved', 'mousePressed', 'mouseReleased'].includes(p.type)) throw this.unsupported(`${method} type ${p.type}`);
          const button = ({ left: 0, middle: 1, right: 2, back: 3, forward: 4 } as Record<string, number>)[p.button ?? 'left'];
          if (button === undefined) throw new Error(`Unsupported Firefox mouse button: ${p.button}`);
          source = { type: 'pointer', id: `pointer-${tab.id}`, parameters: { pointerType: 'mouse' }, actions: [move, ...(p.type === 'mouseMoved' ? [] : [{ type: p.type === 'mousePressed' ? 'pointerDown' : 'pointerUp', button }])] };
        }
      }
      if (source.actions.length) await this.bidi('input.performActions', { context: tab.targetId, actions: [source] });
      if (p.type === 'keyUp' || p.type === 'mouseReleased' || method === 'Input.insertText') await this.setModifiers(tab, 0);
      return {};
    } catch (error) { await this.bidi('input.releaseActions', { context: tab.targetId }, 3000).catch(() => {}); this.modifiers.delete(tab.id); throw error; }
  }

  async cdp<T = any>(tabId: number, method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const tab = this.requireTab(tabId), p = (params ?? {}) as any, context = tab.targetId;
    if (!tab.attachedAt) tab.attachedAt = Date.now();
    if (this.network.handles(method)) return this.network.handle(tabId, context, method, p) as Promise<T>;
    if (method.startsWith('DOM.') && method !== 'DOM.setFileInputFiles' || method === 'CSS.getComputedStyleForNode') return this.dom.handle(tabId, method, p) as Promise<T>;
    const run = async (): Promise<any> => {
      switch (method) {
        // These domains are subscribed for this BiDi session; Capture controls whether events are retained.
        case 'Page.enable': case 'Page.disable': case 'Runtime.disable': case 'Log.enable': case 'Log.disable': return {};
        case 'Runtime.enable': {
          const { realms } = await this.bidi('script.getRealms', {});
          // A restarted inspection retains old IDs but missed navigation events while stopped.
          this.event(tabId, 'Runtime.executionContextsCleared', {});
          for (const realm of realms) if (this.contexts.get(realm.context)?.tabId === tabId) this.realmId(realm, true);
          return {};
        }
        case 'Runtime.evaluate': return this.evaluation(tabId, await this.bidi('script.evaluate', { expression: p.expression, target: this.target(tab, p.contextId), awaitPromise: p.awaitPromise ?? false, resultOwnership: p.returnByValue ? 'none' : 'root', serializationOptions: { maxObjectDepth: p.returnByValue ? null : 1 }, userActivation: !!p.userGesture }, timeoutMs), !!p.returnByValue);
        case 'Runtime.callFunctionOn': {
          const object = p.objectId ? this.object(tabId, p.objectId) : undefined;
          const args = (p.arguments ?? []).map((arg: any) => arg.objectId ? this.reference(this.object(tabId, arg.objectId)) : arg.unserializableValue ? { type: arg.unserializableValue.endsWith('n') ? 'bigint' : 'number', value: arg.unserializableValue.replace(/n$/, '') } : localValue(arg.value));
          return this.evaluation(tabId, await this.bidi('script.callFunction', { functionDeclaration: p.functionDeclaration, target: object ? { realm: object.realm } : this.target(tab, p.executionContextId), ...(object && { this: this.reference(object) }), arguments: args, awaitPromise: p.awaitPromise ?? false, resultOwnership: p.returnByValue ? 'none' : 'root', serializationOptions: { maxObjectDepth: p.returnByValue ? null : 1 }, userActivation: !!p.userGesture }, timeoutMs), !!p.returnByValue);
        }
        case 'Runtime.getProperties': {
          const object = this.object(tabId, p.objectId);
          const base = { target: { realm: object.realm }, this: this.reference(object), awaitPromise: false };
          const descriptors = await this.bidi('script.callFunction', { ...base, functionDeclaration: 'function(){return Object.entries(Object.getOwnPropertyDescriptors(this)).map(([name,d])=>({name,enumerable:d.enumerable,configurable:d.configurable,writable:d.writable,keys:["value","get","set"].filter(k=>k in d)}))}' });
          if (descriptors.type === 'exception') return this.evaluation(tabId, descriptors, true);
          const result = await Promise.all(decodeBiDiValue(descriptors.result).map(async (descriptor: any) => {
            const row: any = { name: descriptor.name, enumerable: descriptor.enumerable, configurable: descriptor.configurable, writable: descriptor.writable, isOwn: true };
            for (const key of descriptor.keys) { const value = await this.bidi('script.callFunction', { ...base, functionDeclaration: 'function(name,key){return Object.getOwnPropertyDescriptor(this,name)?.[key]}', arguments: [localValue(descriptor.name), localValue(key)], resultOwnership: 'root', serializationOptions: { maxObjectDepth: 1 } }); if (value.type === 'success') row[key] = this.remoteObject(tabId, value.result, value.realm, false); }
            return row;
          }));
          return { result };
        }
        case 'Runtime.releaseObject': { const object = this.object(tabId, p.objectId); if (object.value.handle) await this.bidi('script.disown', { target: { realm: object.realm }, handles: [object.value.handle] }); this.objects.delete(p.objectId); return {}; }
        case 'Page.navigate': { const r = await this.bidi('browsingContext.navigate', { context, url: p.url, wait: 'none' }, timeoutMs); tab.url = r.url; return { frameId: context, loaderId: r.navigation }; }
        case 'Page.reload': return this.bidi('browsingContext.reload', { context, ...(p.ignoreCache && { ignoreCache: true }), wait: 'none' }, timeoutMs);
        case 'Page.traverseHistory': return this.bidi('browsingContext.traverseHistory', { context, delta: p.delta }, timeoutMs);
        case 'Page.handleJavaScriptDialog': return this.bidi('browsingContext.handleUserPrompt', { context, accept: p.accept, ...(p.promptText !== undefined && { userText: p.promptText }) });
        case 'Page.bringToFront': return this.bidi('browsingContext.activate', { context });
        case 'Page.getFrameTree': {
          const { contexts } = await this.bidi('browsingContext.getTree', { root: context });
          const tree = (item: any, parentId?: string): any => ({ frame: { id: item.context, url: item.url, parentId }, childFrames: (item.children ?? []).map((child: any) => tree(child, item.context)) });
          if (!contexts[0]) throw new Error('Firefox tab no longer exists'); this.addContext(contexts[0]); return { frameTree: tree(contexts[0]) };
        }
        case 'Page.addScriptToEvaluateOnNewDocument': { const result = await this.bidi('script.addPreloadScript', { functionDeclaration: `() => {\n${p.source}\n}`, contexts: [context], ...(p.worldName && { sandbox: p.worldName }) }); return { identifier: result.script }; }
        case 'Page.removeScriptToEvaluateOnNewDocument': return this.bidi('script.removePreloadScript', { script: p.identifier });
        case 'Page.createIsolatedWorld': {
          const frame = p.frameId ?? context;
          if (this.contexts.get(frame)?.tabId !== tabId) throw new Error('Frame is not part of this Firefox tab');
          const r = await this.bidi('script.evaluate', { expression: 'undefined', target: { context: frame, sandbox: p.worldName }, awaitPromise: false });
          return { executionContextId: this.realmId({ realm: r.realm, context: frame, sandbox: p.worldName }) };
        }
        case 'Page.getLayoutMetrics': { const result = await this.cdp(tabId, 'Runtime.evaluate', { expression: '({x:0,y:0,width:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0),height:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)})', returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return { cssContentSize: result.result.value, contentSize: result.result.value }; }
        case 'Page.captureScreenshot': return this.bidi('browsingContext.captureScreenshot', { context, origin: p.captureBeyondViewport || p.clip ? 'document' : 'viewport', format: { type: `image/${p.format ?? 'png'}`, ...(p.quality !== undefined && { quality: p.quality / 100 }) }, ...(p.clip && { clip: { type: 'box', x: p.clip.x, y: p.clip.y, width: p.clip.width, height: p.clip.height } }) }, timeoutMs);
        case 'Page.printToPDF': return this.bidi('browsingContext.print', { context, background: p.printBackground ?? false, orientation: p.landscape ? 'landscape' : 'portrait', page: { width: (p.paperWidth ?? 8.5) * 2.54, height: (p.paperHeight ?? 11) * 2.54 }, margin: { top: (p.marginTop ?? 0.4) * 2.54, bottom: (p.marginBottom ?? 0.4) * 2.54, left: (p.marginLeft ?? 0.4) * 2.54, right: (p.marginRight ?? 0.4) * 2.54 }, scale: p.scale ?? 1, shrinkToFit: true }, timeoutMs);
        case 'DOM.setFileInputFiles': { const object = this.object(tabId, p.objectId); if (!object.value.sharedId) throw new Error('File upload requires a DOM element from a fresh snapshot'); return this.bidi('input.setFiles', { context, element: { sharedId: object.value.sharedId }, files: p.files }); }
        case 'Input.dispatchMouseEvent': case 'Input.dispatchKeyEvent': case 'Input.insertText': return this.input(tab, method, p);
        default: throw this.unsupported(method);
      }
    };
    return run() as Promise<T>;
  }

  browser<T = any>(method: string, _params?: unknown, timeoutMs?: number): Promise<T> {
    if (method === 'Browser.close') return this.bidi('browser.close', {}, timeoutMs);
    return Promise.reject(this.unsupported(method));
  }
  session<T = any>(_sessionId: string, method: string, _params?: unknown): Promise<T> { return Promise.reject(this.unsupported(method)); }
  listTabs(): FirefoxTab[] { return [...this.tabs.values()]; }
  tab(tabId: number): FirefoxTab | undefined { return this.tabs.get(tabId); }
  async newTab(url = 'about:blank'): Promise<number> {
    const result = await this.bidi('browsingContext.create', { type: 'tab', background: true });
    const tab = this.addContext({ context: result.context, url: 'about:blank' })!;
    if (url !== 'about:blank') await this.cdp(tab.id, 'Page.navigate', { url });
    return tab.id;
  }
  async closeTab(tabId: number) { const tab = this.requireTab(tabId); await this.bidi('browsingContext.close', { context: tab.targetId, promptUnload: false }); this.onMessage({ method: 'browsingContext.contextDestroyed', params: { context: tab.targetId } }); }
  async activate(tabId: number) { await this.bidi('browsingContext.activate', { context: this.requireTab(tabId).targetId }); }
  async windowSize(tabId: number, width?: number, height?: number) {
    const tab = this.requireTab(tabId);
    if (!tab.clientWindow) { const tree = await this.bidi('browsingContext.getTree', { root: tab.targetId, maxDepth: 0 }); tab.clientWindow = tree.contexts[0]?.clientWindow; }
    if (!tab.clientWindow) throw this.unsupported('Resizing the browser window in this build');
    const clientWindow = tab.clientWindow;
    if (width && height) {
      if (!this.windowBounds.has(clientWindow)) { const { clientWindows } = await this.bidi('browser.getClientWindows'); const bounds = clientWindows.find((w: any) => w.clientWindow === clientWindow); if (!bounds) throw new Error('Firefox window no longer exists'); this.windowBounds.set(clientWindow, bounds); }
      await this.bidi('browser.setClientWindowState', { clientWindow, state: 'normal', width, height }); return { width, height };
    }
    const original = this.windowBounds.get(clientWindow);
    if (original) { const { state, width, height, x, y } = original; await this.bidi('browser.setClientWindowState', { clientWindow, state, ...(state === 'normal' && { width, height, x, y }) }); this.windowBounds.delete(clientWindow); }
    return { restored: !!original };
  }
  close(): Promise<void> {
    this.launchCancelled = true;
    if (this.closing) return this.closing;
    this.closing = (async () => {
      const ws = this.ws;
      if (this.running) await this.bidi('browser.close', {}, 3000).catch(() => {});
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
      if (this.ws === ws && ws) this.disconnected();
      await this.stopProcess();
    })().finally(() => { this.closing = undefined; });
    return this.closing;
  }
  private stopProcess(): Promise<void> {
    if (this.stopping) return this.stopping;
    const proc = this.proc;
    if (!proc) return Promise.resolve();
    if (proc.exitCode !== null || proc.signalCode !== null) { this.proc = undefined; return Promise.resolve(); }
    this.stopping = new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(force); clearTimeout(deadline); if (this.proc === proc) this.proc = undefined; resolve(); };
      const force = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 2000);
      const deadline = setTimeout(finish, 5000);
      proc.once('exit', finish);
      proc.kill();
    }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
}
