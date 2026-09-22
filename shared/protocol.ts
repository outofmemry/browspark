// Wire protocol between the companion (Node) and the extension, over a local WebSocket.
// Requests flow companion -> extension. Events flow extension -> companion.

export const DEFAULT_PORT = 9223;
export const PROTOCOL_VERSION = 2;

export interface Req { id: number; method: ReqMethod; params?: unknown }
export interface Res { id: number; result?: unknown; error?: string }
export interface Evt { event: EvtName; params?: unknown }
export type Msg = Req | Res | Evt;

export type ReqMethod = 'tabs.list' | 'tabs.create' | 'tabs.close' | 'tabs.activate' | 'tabs.hold' | 'tabs.prepare' | 'window.size' | 'downloads.list' | 'tools.catalog' | 'graph.state' | 'cdp';
export type EvtName = 'hello' | 'tabs' | 'cdp.event' | 'detached' | 'ping' | 'tools.policy';

export interface ToolInfo { name: string; description: string }
/** Dashboard connection metadata only: never page URLs, titles, contents or grants. */
export interface ConnectionGraph {
  thisBrowserId: string;
  agents: { id: string; name: string }[];
  browsers: { id: string; name: string; mode: 'extension' | 'dev'; sharedTabs: number; context?: string; browserEngine?: 'chromium' | 'firefox' }[];
}
export function isConnectionGraph(value: unknown): value is ConnectionGraph {
  const x = value as ConnectionGraph | null;
  const named = (n: any) => n && typeof n.id === 'string' && typeof n.name === 'string';
  return !!x && typeof x.thisBrowserId === 'string' && Array.isArray(x.agents) && x.agents.every(named)
    && Array.isArray(x.browsers) && x.browsers.every(b => named(b) && ['extension', 'dev'].includes(b.mode) && Number.isSafeInteger(b.sharedTabs) && b.sharedTabs >= 0 && (b.context === undefined || typeof b.context === 'string') && (b.browserEngine === undefined || b.browserEngine === 'chromium' || b.browserEngine === 'firefox'))
    && new Set(x.agents.map(a => a.id)).size === x.agents.length && new Set(x.browsers.map(b => b.id)).size === x.browsers.length
    && x.browsers.some(b => b.id === x.thisBrowserId && b.mode === 'extension');
}
/** Extension -> companion: tools the user switched off in the dashboard. */
export type DevModePolicy = 'auto' | 'always' | 'never';
export interface ToolPolicy { disabled: string[]; /** Extension already holds a catalog from this companion version. */ haveCatalog?: boolean; /** auto: developer browser only when a capability needed it; always: whenever the agent asks; never. */ devMode?: DevModePolicy; /** Draw the agent presence overlay (frame, cursor, Stop) on tabs while the agent works. Default on. */ overlay?: boolean; /** Receive connection metadata for this profile's Graph page. */ graph?: boolean }
/** Name of the Runtime binding the overlay's Stop button calls; the extension unshares the tab when it fires. */
export const STOP_BINDING = '__browsparkStop';

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  shared: boolean;
  attached: boolean;
  windowId: number;
  /** Opened by the agent and shared automatically. */
  agent?: boolean;
  favIconUrl?: string;
  /** Set when chrome.debugger cannot attach (chrome://, web store, etc.). */
  unsupported?: string;
  /** Companion-assigned identity of the extension connection; absent on the wire from the extension. */
  browserId?: string;
  browserName?: string;
  browserEngine?: 'chromium' | 'firefox';
}

export interface HelloParams {
  version: number; extensionVersion: string; browser?: string; userAgent?: string;
  /** Persistent per-installation identity; browsers and profiles connect independently. */
  instanceId?: string;
  /** Per-browser-session identity prevents reused native tab ids reviving stale companion ids after restart. */
  browserSessionId?: string;
  /** Firefox extensions use an isolated user-script adapter instead of chrome.debugger. */
  browserEngine?: 'chromium' | 'firefox';
}
export interface CdpParams { tabId: number; method: string; params?: unknown; sessionId?: string; /** Name of the agent issuing the command. */ client?: string }
export interface CdpEventParams { tabId: number; method: string; params: unknown; sessionId?: string }
export interface DetachedParams { tabId: number; reason: string }

export const isReq = (m: Msg): m is Req => 'method' in m && 'id' in m;
export const isRes = (m: Msg): m is Res => 'id' in m && !('method' in m);
export const isEvt = (m: Msg): m is Evt => 'event' in m;

/** Native New Tab pages can be shared for navigation, but not inspected directly. */
export const isNewTab = (url: string) => /^(?:(?:chrome|brave|edge|vivaldi):\/\/(?:newtab|new-tab-page)\/?|about:(?:newtab|home))(?:[?#][^\s]*)?$/i.test(url);

/** Pages chrome.debugger refuses to attach to. */
export function unsupportedReason(url: string, engine: 'chromium' | 'firefox' = 'chromium'): string | undefined {
  if (url === 'about:blank' || url === '') return undefined; // blank tabs can be automated
  if (/^(chrome|chrome-extension|moz-extension|devtools|edge|brave|vivaldi|about|view-source):/.test(url)) return 'browser-internal page';
  if (engine === 'firefox' && /^https:\/\/(?:addons\.mozilla\.org|accounts\.firefox\.com)(?:[/:]|$)/i.test(url)) return 'Firefox protected site';
  if (engine === 'firefox' && !/^https?:\/\//i.test(url)) return 'Firefox extension supports HTTP(S) pages only';
  if (/^https:\/\/chrome(web)?store\.google\.com/.test(url)) return 'Chrome Web Store';
  return undefined;
}
