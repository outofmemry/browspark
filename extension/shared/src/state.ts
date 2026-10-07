// Messages between the dashboard page and the service worker.
import type { ConnectionGraph, ExtensionInfo, TabInfo, ToolInfo, UpdateStatus } from '../../../shared/protocol.ts';

export interface OpLog { id: number; at: number; ms: number; tabId: number; tabLabel: string; method: string; ok: boolean; error?: string; client?: string }
export interface WindowInfo { id: number; incognito: boolean }
export interface UpdateState {
  /** The companion's last answer. */
  status?: UpdateStatus;
  checking: boolean;
  /** Why the companion could not be asked (not running, or too old to install updates). */
  unreachable?: string;
  install?: { stage: 'download' | 'verify' | 'install' | 'reload'; version: string; received?: number; total?: number };
  installError?: string;
  /** Release the user chose to postpone; its prompt stays closed until the next release. */
  dismissed?: string;
}
export interface State {
  graphEnabled: boolean;
  graph?: ConnectionGraph;
  browserEngine?: 'chromium' | 'firefox';
  /** Firefox requires the user to grant script execution and website access in its dashboard. */
  automationReady?: boolean;
  firefoxHostAccess?: boolean;
  connected: boolean;
  /** Pending connection UI; background retries retain their disconnected error state. */
  connecting: boolean;
  stopped: boolean;
  /** Existing and newly opened tabs across all windows are shared. */
  shareAll: boolean;
  /** Record per-command activity (off by default: nothing is stored). */
  activityLog: boolean;
  /** Tools the companion offers (received on connect, cached) and the ones the user switched off. */
  toolCatalog: ToolInfo[];
  disabledTools: string[];
  /** Reported by the companion with its catalog; undefined means an old companion (or not connected yet). */
  companionVersion?: string;
  /** When the agent may launch the developer-mode browser. */
  devMode: 'auto' | 'always' | 'never';
  /** Cyan halo, cursor and Stop pill on tabs while the agent works. */
  overlay: boolean;
  backgroundMode: boolean;
  /** The optional `management` permission is granted (requested from the dashboard). */
  managementGranted: boolean;
  /** User consent for agents to use browser_extensions (inventory, enable/disable, messaging, options pages). */
  extensionsAccess: boolean;
  /** User consent to automate options pages the agent opens (Chromium only). */
  extensionPages: boolean;
  /** Installed extensions, present only while `management` is granted. */
  extensions?: ExtensionInfo[];
  /** Manual graph label for browsers that spoof client hints; blank means auto-detect. */
  customBrowser: string;
  port: number;
  lastError?: string;
  connectedAt?: number;
  extensionVersion: string;
  windows: WindowInfo[];
  tabs: TabInfo[];
  recent: OpLog[];
  totals: { ops: number; errors: number };
  /** Ask the companion for new releases (on connect and hourly). */
  updateCheck: boolean;
  update: UpdateState;
  /** Set after an update reloaded the extension, until the dashboard acknowledges it. */
  justUpdated?: { from: string; to: string };
}
export type PopupMsg =
  | { type: 'getState' }
  | { type: 'setConfig'; port: number }
  | { type: 'setCustomBrowser'; name: string }
  | { type: 'setShared'; tabIds: number[]; shared: boolean }
  | { type: 'setShareAll'; on: boolean }
  | { type: 'setActivityLog'; on: boolean }
  | { type: 'setGraphEnabled'; on: boolean }
  | { type: 'setToolEnabled'; name: string; enabled: boolean }
  | { type: 'setDevMode'; mode: 'auto' | 'always' | 'never' }
  | { type: 'setBackgroundMode'; on: boolean }
  | { type: 'setOverlay'; on: boolean }
  | { type: 'setExtensionsAccess'; on: boolean }
  | { type: 'setExtensionPages'; on: boolean }
  | { type: 'setExtensionEnabled'; id: string; enabled: boolean }
  | { type: 'setToolsEnabled'; names: string[]; enabled: boolean }
  | { type: 'connect' }
  | { type: 'stop' }
  /** End every agent process connected to the companion, background jobs included. */
  | { type: 'stopAgents' }
  | { type: 'clearLog' }
  | { type: 'focusTab'; tabId: number }
  | { type: 'checkUpdate' }
  | { type: 'installUpdate'; path?: string }
  | { type: 'dismissUpdate' }
  | { type: 'setUpdateCheck'; on: boolean }
  | { type: 'ackUpdated' };
