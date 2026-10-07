// Wire protocol between the companion (Node) and the extension, over a local WebSocket.
// Requests flow companion -> extension. Events flow extension -> companion.

export const DEFAULT_PORT = 9223;
export const PROTOCOL_VERSION = 3;

export interface Req { id: number; method: ReqMethod; params?: unknown }
export interface Res { id: number; result?: unknown; error?: string }
export interface Evt { event: EvtName; params?: unknown }
export type Msg = Req | Res | Evt;

export type ReqMethod = 'tabs.list' | 'tabs.create' | 'tabs.close' | 'tabs.activate' | 'tabs.hold' | 'tabs.prepare' | 'window.size' | 'downloads.list' | 'tools.catalog' | 'graph.state' | 'extensions.list' | 'extensions.info' | 'extensions.setEnabled' | 'extensions.uninstall' | 'extensions.options' | 'extensions.message' | 'cdp';
/** `agents.stop`: the user asked to end every agent process connected to the companion (older companions ignore it). */
export type EvtName = 'hello' | 'tabs' | 'cdp.event' | 'detached' | 'ping' | 'tools.policy' | 'agents.stop';

/** Other installed extensions, as reported by chrome.management / browser.management. */
export interface ExtensionInfo {
  id: string; name: string; version: string; enabled: boolean; type: string; description?: string; homepageUrl?: string; optionsUrl?: string; installType?: string;
  mayDisable?: boolean; permissions: string[]; hostPermissions: string[]; permissionWarnings?: string[];
  /** This is Browspark itself: it can be listed but never managed, messaged or opened. */
  self?: boolean;
}
/** Chromium ids are 32 letters a-p; Firefox ids are `name@host` or `{uuid}`. Validated before any id reaches an extension API. */
export const isExtensionId = (v: unknown): v is string => typeof v === 'string' && (/^[a-p]{32}$/.test(v) || /^(?:\{[0-9a-fA-F-]{36}\}|[\w.+-]{1,64}@[\w.-]{1,64})$/.test(v));
/** chrome-extension:// and moz-extension:// pages: only reachable through the explicit options flow. */
export const isExtensionPage = (url: string) => /^(?:chrome-extension|moz-extension):\/\/[^/?#]+(?:[/?#]|$)/i.test(url);
export const MESSAGE_LIMIT_BYTES = 1_000_000;

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

// Extension updates: a separate WebSocket at /update on the companion port. It never depends on PROTOCOL_VERSION,
// so an extension too old for the bridge handshake can still ask a newer companion to install the current release.
export const UPDATE_PATH = '/update';
export type UpdateEngine = 'chromium' | 'firefox';
/** Extension -> companion. `id` is chrome.runtime.id; it identifies an unpacked Chromium folder by its path hash. */
export type UpdateRequest =
  | { type: 'check'; engine: UpdateEngine; id: string; version: string; force?: boolean }
  | { type: 'install'; engine: UpdateEngine; id: string; version: string; path?: string };
export interface UpdateTarget { path: string; display: string; kind: 'folder' | 'zip' }
/** Companion -> extension answer to `check`. */
export interface UpdateStatus {
  type: 'status';
  current: string;
  companion: string;
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  notes?: string;
  publishedAt?: string;
  /** Where `install` writes; absent when the folder is unknown or ambiguous. */
  target?: UpdateTarget;
  /** Several matching Firefox folders: the user picks one. */
  candidates?: UpdateTarget[];
  installable: boolean;
  /** Why `installable` is false: not-found, ambiguous, disabled, no-asset, offline. */
  reason?: 'not-found' | 'ambiguous' | 'disabled' | 'no-asset' | 'offline';
  error?: string;
  checkedAt: number;
}
export type UpdateEvent =
  | UpdateStatus
  | { type: 'progress'; stage: 'download' | 'verify' | 'install'; received?: number; total?: number }
  | { type: 'done'; version: string; target: UpdateTarget }
  | { type: 'error'; message: string };
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const isVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && SEMVER.test(v);
/** Semantic version order; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => { const [core, pre] = v.replace(/^v/, '').split('+')[0]!.split(/-(.*)/s); return { nums: core!.split('.').map(Number), pre }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}
