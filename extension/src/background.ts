import {
  DEFAULT_PORT, PROTOCOL_VERSION, STOP_BINDING, isReq, isNewTab, unsupportedReason, isConnectionGraph,
  type CdpParams, type ConnectionGraph, type Evt, type HelloParams, type Msg, type Req, type Res, type TabInfo, type ToolInfo,
} from '../../shared/protocol.ts';
import type { OpLog, PopupMsg, State } from './state.ts';
import { api, isFirefox, FIREFOX_PERMISSIONS } from './browser.ts';
import { createFirefoxDebugger } from './firefox-debugger.ts';

const shared = new Set<number>();
const excluded = new Set<number>(); // explicit per-tab revocations override Share everything
let shareAll = false; // user opted to share every tab, including ones opened later
let activityLog = false; // off by default: no per-command records are kept
let graphEnabled = true;
let graph: ConnectionGraph | undefined;
let toolCatalog: ToolInfo[] = [];
let disabledTools = new Set<string>();
let companionVersion: string | undefined;
const sendToolPolicy = () => evt('tools.policy', { disabled: [...disabledTools], haveCatalog: toolCatalog.length > 0 && !!companionVersion, devMode, overlay, graph: graphEnabled });
const isShared = (tabId: number) => !excluded.has(tabId) && (shareAll || shared.has(tabId));
const debuggerApi = isFirefox ? createFirefoxDebugger(api, isShared) : api.debugger;
const tabUnsupported = (url: string) => unsupportedReason(url, isFirefox ? 'firefox' : 'chromium');
const attached = new Set<number>();
const agentTabs = new Set<number>();     // ordinary browser tabs the agent opened
let devMode: 'auto' | 'always' | 'never' = 'auto';
let backgroundMode = true; // agent commands never activate user tabs by default
let overlay = true; // agent presence overlay on tabs while commands flow
const held = new Set<number>();          // tabs with an active inspection session: never idle-detach
const ownedDownloads = new Map<string, { guid: string; tabId: number; url: string; filename: string; state: string; receivedBytes: number; totalBytes: number; startedAt: number }>();
const windowBounds = new Map<number, { width?: number; height?: number; state?: string }>(); // originals, restored after emulation
const lastUsed = new Map<number, number>();
const IDLE_DETACH_MS_DEFAULT = 30_000;
let idleDetachMs = IDLE_DETACH_MS_DEFAULT;
const recent: OpLog[] = [];
const totals = { ops: 0, errors: 0 };
let opSeq = 0;
let connectedAt: number | undefined;
let connecting = false;
let connectionAttempt = 0;
let ws: WebSocket | undefined;
let stopped = false;
let lastError: string | undefined;
let backoff = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connectionTimer: ReturnType<typeof setTimeout> | undefined;
let instanceId: string;
let browserSessionId: string;

const cfg = async () => {
  const s = await api.storage.local.get(['port', 'shareAll', 'stopped', 'activityLog', 'toolCatalog', 'disabledTools', 'devMode', 'overlay', 'backgroundMode', 'graphEnabled', 'idleDetachMs']);
  const ss = await api.storage.session.get(['shared', 'excluded']); // per-tab grants must not outlive the browser session
  return { port: (s.port as number) || DEFAULT_PORT, shared: (ss.shared as number[]) || [], excluded: (ss.excluded as number[]) || [], shareAll: !!s.shareAll, stopped: !!s.stopped, activityLog: !!s.activityLog, toolCatalog: (s.toolCatalog as ToolInfo[]) || [], disabledTools: (s.disabledTools as string[]) || [], devMode: ((s.devMode as string) || 'auto') as 'auto' | 'always' | 'never', overlay: s.overlay !== false, backgroundMode: s.backgroundMode !== false, graphEnabled: s.graphEnabled !== false, idleDetachMs: (s.idleDetachMs as number) || IDLE_DETACH_MS_DEFAULT };
};
const send = (m: Msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const evt = (event: Evt['event'], params?: unknown) => send({ event, params });
const log = (e: Omit<OpLog, 'id'>) => { totals.ops++; if (!e.ok) totals.errors++; if (!activityLog) return; recent.unshift({ id: ++opSeq, ...e }); if (recent.length > 200) recent.pop(); };
const foregroundRequired = "Work in background is enabled. Keep using the assigned tabId without activating it. If foreground interaction is necessary, ask the user to select the agent tab or temporarily turn off Settings → Work in background, then retry after checking the page state.";
const APP_URL = api.runtime.getURL('app.html');

async function listTabs(): Promise<TabInfo[]> {
  const tabs = await api.tabs.query({});
  return tabs.filter((t) => t.id !== undefined).map((t) => ({
    id: t.id!, url: t.url || '', title: t.title || '', shared: isShared(t.id!) && (!tabUnsupported(t.url || '') || isNewTab(t.url || '')), attached: attached.has(t.id!),
    windowId: t.windowId, agent: agentTabs.has(t.id!) || undefined, favIconUrl: t.favIconUrl, unsupported: tabUnsupported(t.url || ''),
  }));
}
const tabLabel = async (tabId: number) => { try { const t = await api.tabs.get(tabId); return new URL(t.url || '').host || t.title || String(tabId); } catch { return String(tabId); } };

async function openApp() {
  const [existing] = await api.tabs.query({ url: APP_URL });
  if (existing?.id) { await api.tabs.update(existing.id, { active: true }); await api.windows.update(existing.windowId, { focused: true }); }
  else await api.tabs.create({ url: APP_URL });
}
api.action.onClicked.addListener(openApp);
if (isFirefox) api.runtime.onInstalled.addListener(({ reason }) => { if (reason === 'install') void openApp(); });
const pushTabs = async () => evt('tabs', await listTabs());

async function ensureAttached(tabId: number) {
  if (attached.has(tabId)) return;
  const tab = await api.tabs.get(tabId);
  const bad = tabUnsupported(tab.url || '');
  if (bad) throw new Error(`Cannot attach to ${bad} (${tab.url})`);
  try { await debuggerApi.attach({ tabId }, '1.3'); }
  catch (e) {
    const m = (e as Error).message || String(e);
    throw new Error(/already attached/i.test(m) ? `Another extension's debugger is attached to tab ${tabId}. Chrome DevTools itself can stay open; another debugging extension cannot. Disable it for this tab and retry.` : m);
  }
  attached.add(tabId);
  pushTabs();
}
async function detach(tabId: number) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await debuggerApi.detach({ tabId }); } catch {}
  evt('detached', { tabId, reason: 'unshared by user' }); // onDetach does not fire for our own detach
}

async function handle(req: Req): Promise<Res> {
  await ready;
  try {
    if (req.method === 'tabs.list') return { id: req.id, result: await listTabs() };
    if (req.method === 'graph.state') {
      if (!graphEnabled) return { id: req.id, result: { received: false } };
      if (!isConnectionGraph(req.params)) throw new Error('Invalid connection graph');
      graph = req.params;
      return { id: req.id, result: { received: true } };
    }
    if (isFirefox && !['tabs.list', 'tools.catalog'].includes(req.method) && !await api.permissions.contains(FIREFOX_PERMISSIONS)) throw new Error('Enable Firefox automation in the Browspark dashboard and grant website access before using this tab.');
    if (req.method === 'tabs.prepare') {
      const { tabId } = req.params as { tabId: number };
      if (!isShared(tabId)) throw new Error(`Tab ${tabId} is not shared by the user`);
      const tab = await api.tabs.get(tabId);
      if (!isNewTab(tab.url || '')) return { id: req.id, result: { prepared: false } };
      // Chrome blocks debugger attachment to its New Tab UI. Prepare the same tab
      // only for an explicit navigation; the destination still uses normal CDP.
      await api.tabs.update(tabId, { url: 'about:blank' });
      for (let i = 0; i < 100; i++) {
        const current = await api.tabs.get(tabId);
        if (!isShared(tabId)) throw new Error(`Tab ${tabId} was unshared by the user`);
        if (current.url === 'about:blank' && !current.pendingUrl && current.status === 'complete') {
          await pushTabs();
          return { id: req.id, result: { prepared: true } };
        }
        if (current.url && current.url !== 'about:blank' && !isNewTab(current.url)) throw new Error(`Tab ${tabId} navigated elsewhere while preparing; retry with its current state`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out preparing New Tab ${tabId} for navigation`);
    }
    if (req.method === 'tools.catalog') {
      const p = req.params as { tools: ToolInfo[]; version?: string };
      const version = /^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(p.version ?? '');
      const minimumMinor = isFirefox ? 6 : 5;
      if (!version || Number(version[1]) === 0 && Number(version[2]) < minimumMinor) {
        await stop(false);
        lastError = `The ${isFirefox ? 'Firefox' : 'Chromium'} extension needs companion 0.${minimumMinor}.0 or later. Run the companion from the same source build, then reconnect.`;
        throw new Error(lastError);
      }
      toolCatalog = p.tools; companionVersion = p.version;
      await api.storage.local.set({ toolCatalog });
      sendToolPolicy(); // the companion applies whatever the user had switched off
      return { id: req.id, result: { received: toolCatalog.length } };
    }
    if (req.method === 'tabs.create') {
      // Tabs the agent opens are ordinary Chrome tabs, shared automatically because it created them.
      const { url, active } = req.params as { url: string; active?: boolean };
      const t = await api.tabs.create({ url, active: backgroundMode ? false : active ?? true });
      agentTabs.add(t.id!); shared.add(t.id!); await api.storage.session.set({ shared: [...shared] }); pushTabs();
      return { id: req.id, result: { id: t.id, windowId: t.windowId } };
    }
    if (req.method === 'window.size') {
      // Shrink the window to a device size while emulating (so the emulated viewport fills it); omit width/height to restore.
      const { tabId, width, height } = req.params as { tabId: number; width?: number; height?: number };
      if (!isShared(tabId)) throw new Error(`Tab ${tabId} is not shared by the user`);
      const { windowId } = await api.tabs.get(tabId);
      if (width && height) {
        if (backgroundMode) throw new Error(foregroundRequired);
        if (!windowBounds.has(windowId)) { const w = await api.windows.get(windowId); windowBounds.set(windowId, { width: w.width, height: w.height, state: w.state }); }
        const w = await api.windows.update(windowId, { state: 'normal', width, height });
        return { id: req.id, result: { width: w.width, height: w.height } };
      }
      const orig = windowBounds.get(windowId);
      if (orig) { windowBounds.delete(windowId); await api.windows.update(windowId, orig.state === 'maximized' || orig.state === 'fullscreen' ? { state: orig.state as chrome.windows.WindowState } : { state: 'normal', width: orig.width, height: orig.height }); }
      return { id: req.id, result: { restored: !!orig } };
    }
    if (req.method === 'downloads.list') {
      // CDP identifies the originating tab. The downloads API has no tab id, so
      // matching its URLs/referrers can leak another tab's files on the same site.
      return { id: req.id, result: [...ownedDownloads.values()].filter((d) => isShared(d.tabId)).reverse() };
    }
    if (req.method === 'tabs.hold') {
      const { tabId, hold } = req.params as { tabId: number; hold: boolean };
      if (hold) held.add(tabId); else held.delete(tabId);
      return { id: req.id, result: {} };
    }
    if (req.method === 'tabs.close' || req.method === 'tabs.activate') {
      const { tabId } = req.params as { tabId: number };
      if (!isShared(tabId)) throw new Error(`Tab ${tabId} is not shared by the user`);
      if (req.method === 'tabs.close') await api.tabs.remove(tabId);
      else { if (backgroundMode) throw new Error(foregroundRequired); const t = await api.tabs.update(tabId, { active: true }); if (t?.windowId !== undefined) await api.windows.update(t.windowId, { focused: true }); }
      return { id: req.id, result: {} };
    }
    if (req.method === 'cdp') {
      const { tabId, method, params, sessionId, client } = req.params as CdpParams;
      // Trust boundary: only user-shared tabs may be driven, regardless of what the companion asks.
      if (!isShared(tabId)) throw new Error(`Tab ${tabId} is not shared by the user`);
      await ensureAttached(tabId);
      // The user may have unshared the tab while attachment was in flight: re-check before sending anything.
      if (!isShared(tabId)) { await detach(tabId); throw new Error(`Tab ${tabId} was unshared by the user`); }
      lastUsed.set(tabId, Date.now());
      // CDP targets the assigned tab directly; foreground mode retains the old fallback.
      if (backgroundMode && /^(Page\.bringToFront|Target\.activateTarget|Target\.createTarget|Browser\.setWindowBounds)$/.test(method)) throw new Error(foregroundRequired);
      if (!backgroundMode && /^(Input\.|Page\.captureScreenshot)/.test(method)) {
        const t = await api.tabs.get(tabId);
        if (!t.active) await api.tabs.update(tabId, { active: true });
      }
      const t0 = Date.now();
      try {
        const result = await debuggerApi.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params as Record<string, unknown> | undefined);
        log({ at: t0, ms: Date.now() - t0, tabId, tabLabel: await tabLabel(tabId), method, ok: true, client });
        return { id: req.id, result };
      } catch (e) {
        const error = (e as Error).message || String(e);
        log({ at: t0, ms: Date.now() - t0, tabId, tabLabel: await tabLabel(tabId), method, ok: false, error, client });
        return { id: req.id, error: backgroundMode && /^(Input\.|Page\.captureScreenshot)/.test(method) ? `${error}. ${foregroundRequired}` : error };
      }
    }
    throw new Error(`Unknown method ${(req as Req).method}`);
  } catch (e) {
    return { id: req.id, error: (e as Error).message || String(e) };
  }
}

async function connect(force = false) {
  if (stopped || (!force && (ws || connecting))) return;
  const attempt = ++connectionAttempt;
  clearTimeout(reconnectTimer);
  clearTimeout(connectionTimer);
  const previous = ws;
  ws = undefined; connecting = true; connectedAt = undefined; companionVersion = undefined; graph = undefined;
  if (force) { backoff = 1000; lastError = undefined; }
  // Finish closing the old connection before opening its replacement.
  if (previous && previous.readyState !== WebSocket.CLOSED) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      previous.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
      previous.close(1000, 'reconnecting');
    });
  }
  const { port } = await cfg();
  if (attempt !== connectionAttempt || stopped) return;
  let sock: WebSocket;
  try { sock = new WebSocket(`ws://127.0.0.1:${port}`); }
  catch { connecting = false; lastError = 'Invalid bridge address. Check the port in Settings.'; return; }
  ws = sock;
  const disconnected = (error?: string) => {
    if (ws !== sock) return;
    clearTimeout(connectionTimer);
    ws = undefined; connecting = false; connectedAt = undefined; companionVersion = undefined; graph = undefined; lastError = error;
    if (!stopped) { reconnectTimer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15_000); }
  };
  connectionTimer = setTimeout(() => {
    if (ws !== sock) return;
    disconnected('Companion did not respond. Check that the MCP server is running.');
    sock.close(1000, 'connection timed out');
  }, 10_000);
  sock.onopen = async () => {
    if (ws !== sock) return;
    const brands = ((navigator as any).userAgentData?.brands ?? []) as { brand: string; version: string }[];
    const named = brands.find((b) => !/Chromium|not.*brand/i.test(b.brand)) ?? brands.find((b) => /Chromium/.test(b.brand));
    const browserInfo = isFirefox ? await (api.runtime as any).getBrowserInfo() : undefined;
    if (ws !== sock) return;
    const hello: HelloParams = { version: PROTOCOL_VERSION, extensionVersion: api.runtime.getManifest().version, browser: browserInfo ? `${browserInfo.name} ${browserInfo.version}` : named ? `${named.brand} ${named.version}` : undefined, browserEngine: isFirefox ? 'firefox' : 'chromium', userAgent: navigator.userAgent, instanceId, browserSessionId };
    evt('hello', hello);
    pushTabs();
    sendToolPolicy();
  };
  sock.onmessage = async (m) => {
    if (ws !== sock) return;
    let msg: Msg;
    try { msg = JSON.parse(m.data as string); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (isReq(msg)) {
      // A response from the companion confirms readiness, not merely an open socket.
      if (connecting) { connecting = false; connectedAt = Date.now(); lastError = undefined; backoff = 1000; clearTimeout(connectionTimer); }
      const response = await handle(msg);
      if (ws === sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(response));
    }
  };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    if (e.code === 4002) { stopped = true; disconnected(e.reason || 'Protocol version mismatch; update the extension'); return; }
    disconnected(lastError ?? (e.code === 1000 ? 'Companion disconnected. Retrying automatically.' : `Disconnected (${e.code}). Retrying automatically.`));
  };
  sock.onerror = () => { if (ws === sock) lastError = 'Companion not reachable; is the MCP server running?'; };
}

async function stop(persist = true) {
  stopped = true;
  connectionAttempt++;
  clearTimeout(reconnectTimer);
  clearTimeout(connectionTimer);
  const previous = ws;
  ws = undefined; connecting = false; connectedAt = undefined; companionVersion = undefined; graph = undefined; lastError = undefined;
  previous?.close(1000, 'stopped by user');
  for (const id of [...attached]) await detach(id);
  if (persist) { shared.clear(); shareAll = false; await api.storage.session.set({ shared: [] }); await api.storage.local.set({ shareAll: false, stopped: true }); }
}

async function state(): Promise<State> {
  const { port } = await cfg();
  const windows = (await api.windows.getAll()).filter((w) => w.id !== undefined).map((w) => ({ id: w.id!, incognito: w.incognito }));
  return {
    graphEnabled, graph,
    connected: ws?.readyState === WebSocket.OPEN && connectedAt !== undefined, connecting: connecting && !lastError, stopped, shareAll, activityLog, toolCatalog, disabledTools: [...disabledTools], companionVersion, devMode, overlay, backgroundMode, port, lastError, connectedAt,
    browserEngine: isFirefox ? 'firefox' : 'chromium', firefoxHostAccess: !isFirefox || await api.permissions.contains({ origins: FIREFOX_PERMISSIONS.origins }), automationReady: !isFirefox || await api.permissions.contains(FIREFOX_PERMISSIONS),
    extensionVersion: api.runtime.getManifest().version, windows, tabs: await listTabs(), recent, totals,
  };
}

api.runtime.onMessage.addListener((msg: PopupMsg, sender, reply) => {
  // Only the packaged dashboard can change sharing or settings. Page scripts cannot grant themselves access.
  if (sender.id !== api.runtime.id || sender.url?.split('#')[0] !== APP_URL) return false;
  (async () => {
    await ready; // a suspended worker restarts on this message; settings must be loaded before answering
    switch (msg.type) {
      case 'setConfig': stopped = false; await api.storage.local.set({ port: msg.port, stopped: false }); await connect(true); break;
      case 'connect': stopped = false; await api.storage.local.set({ stopped: false }); await connect(true); break;
      case 'stop': await stop(); break;
      case 'clearLog': recent.length = 0; break;
      case 'setShared':
        for (const id of msg.tabIds) { if (msg.shared) { excluded.delete(id); shared.add(id); } else { excluded.add(id); shared.delete(id); held.delete(id); await detach(id); } }
        await api.storage.session.set({ shared: [...shared], excluded: [...excluded] });
        pushTabs(); break;
      case 'setDevMode': devMode = msg.mode; await api.storage.local.set({ devMode }); sendToolPolicy(); break;
      case 'setBackgroundMode':
        if (typeof msg.on !== 'boolean') throw new Error('backgroundMode must be a boolean');
        await api.storage.local.set({ backgroundMode: msg.on }); backgroundMode = msg.on; break;
      case 'setOverlay': overlay = msg.on; await api.storage.local.set({ overlay }); sendToolPolicy(); break;
      case 'setToolEnabled':
        if (msg.enabled) disabledTools.delete(msg.name); else disabledTools.add(msg.name);
        await api.storage.local.set({ disabledTools: [...disabledTools] }); sendToolPolicy(); break;
      case 'setToolsEnabled':
        for (const n of msg.names) { if (msg.enabled) disabledTools.delete(n); else disabledTools.add(n); }
        await api.storage.local.set({ disabledTools: [...disabledTools] }); sendToolPolicy(); break;
      case 'setActivityLog':
        activityLog = msg.on; if (!activityLog) recent.length = 0;
        await api.storage.local.set({ activityLog }); break;
      case 'setGraphEnabled':
        if (typeof msg.on !== 'boolean') throw new Error('graphEnabled must be a boolean');
        if (graphEnabled !== msg.on) graph = undefined;
        graphEnabled = msg.on;
        await api.storage.local.set({ graphEnabled }); sendToolPolicy(); break;
      case 'setShareAll':
        shareAll = msg.on;
        if (!shareAll) for (const id of [...attached]) if (!shared.has(id)) await detach(id);
        await api.storage.local.set({ shareAll });
        pushTabs(); break;
      case 'focusTab': {
        const t = await api.tabs.update(msg.tabId, { active: true });
        if (t?.windowId !== undefined) await api.windows.update(t.windowId, { focused: true });
        break;
      }
    }
    reply(await state());
  })().catch((error) => reply({ error: (error as Error).message }));
  return true;
});

debuggerApi.onEvent.addListener((source, method, params) => {
  const { tabId, sessionId } = source as { tabId?: number; sessionId?: string };
  if (tabId === undefined) return;
  if (method === 'Runtime.bindingCalled' && (params as { name?: string })?.name === STOP_BINDING) { stopTab(tabId); return; }
  if (method === 'Page.downloadWillBegin' && isShared(tabId)) {
    const p = params as { guid: string; url: string; suggestedFilename: string };
    ownedDownloads.set(p.guid, { guid: p.guid, tabId, url: p.url, filename: p.suggestedFilename, state: 'inProgress', receivedBytes: 0, totalBytes: 0, startedAt: Date.now() });
    if (ownedDownloads.size > 50) ownedDownloads.delete(ownedDownloads.keys().next().value!);
  } else if (method === 'Page.downloadProgress') {
    const p = params as { guid: string; state: string; receivedBytes: number; totalBytes: number };
    const download = ownedDownloads.get(p.guid);
    if (download?.tabId === tabId) Object.assign(download, { state: p.state, receivedBytes: p.receivedBytes, totalBytes: p.totalBytes });
  }
  evt('cdp.event', { tabId, method, params, sessionId });
});
/** The user pressed Stop on the overlay: revoke the tab exactly as unsharing it from the dashboard would. */
async function stopTab(tabId: number) {
  excluded.add(tabId); shared.delete(tabId); agentTabs.delete(tabId); held.delete(tabId);
  await api.storage.session.set({ shared: [...shared], excluded: [...excluded] });
  if (attached.has(tabId)) { attached.delete(tabId); try { await debuggerApi.detach({ tabId }); } catch {} evt('detached', { tabId, reason: 'stopped by user' }); }
  pushTabs();
}
debuggerApi.onDetach.addListener(({ tabId }, reason) => {
  if (tabId === undefined) return;
  attached.delete(tabId);
  evt('detached', { tabId, reason });
  pushTabs();
});
api.tabs.onRemoved.addListener((tabId) => {
  const wasShared = shared.delete(tabId), wasExcluded = excluded.delete(tabId);
  if (wasShared || wasExcluded) api.storage.session.set({ shared: [...shared], excluded: [...excluded] });
  attached.delete(tabId); agentTabs.delete(tabId); held.delete(tabId); lastUsed.delete(tabId);
  pushTabs();
});

api.windows.onRemoved.addListener((windowId) => { windowBounds.delete(windowId); });

// Idle detach: the debugger (and Chrome's "started debugging" bar) only stays on tabs the agent is actively using,
// unless an inspection session holds the tab.
setInterval(() => {
  for (const id of [...attached]) if (!held.has(id) && Date.now() - (lastUsed.get(id) ?? 0) > idleDetachMs) void detach(id);
}, 2000);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.idleDetachMs) idleDetachMs = (changes.idleDetachMs.newValue as number) || IDLE_DETACH_MS_DEFAULT;
});
api.tabs.onCreated.addListener(() => pushTabs());
api.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.title || info.status === 'complete') pushTabs(); });

// Keepalive: WebSocket traffic keeps the MV3 worker alive; the alarm retries when disconnected.
setInterval(() => evt('ping'), 20_000);
api.alarms.create('reconnect', { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener(() => { if (!ws && !stopped) connect(); });

const ready = cfg().then(async (c) => {
  const local = await api.storage.local.get('instanceId'), session = await api.storage.session.get('browserSessionId');
  instanceId = typeof local.instanceId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(local.instanceId) ? local.instanceId : crypto.randomUUID();
  browserSessionId = typeof session.browserSessionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(session.browserSessionId) ? session.browserSessionId : crypto.randomUUID();
  await api.storage.local.set({ instanceId }); await api.storage.session.set({ browserSessionId });
  for (const id of c.shared) shared.add(id); for (const id of c.excluded) excluded.add(id); shareAll = c.shareAll; activityLog = c.activityLog; toolCatalog = c.toolCatalog; disabledTools = new Set(c.disabledTools); devMode = c.devMode; stopped = c.stopped; overlay = c.overlay; backgroundMode = c.backgroundMode; graphEnabled = c.graphEnabled; idleDetachMs = c.idleDetachMs; if (!stopped) connect();
});
