// Messages between the dashboard page and the service worker.
import type { ConnectionGraph, TabInfo, ToolInfo } from '../../../shared/protocol.ts';

export interface OpLog { id: number; at: number; ms: number; tabId: number; tabLabel: string; method: string; ok: boolean; error?: string; client?: string }
export interface WindowInfo { id: number; incognito: boolean }
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
  port: number;
  lastError?: string;
  connectedAt?: number;
  extensionVersion: string;
  windows: WindowInfo[];
  tabs: TabInfo[];
  recent: OpLog[];
  totals: { ops: number; errors: number };
}
export type PopupMsg =
  | { type: 'getState' }
  | { type: 'setConfig'; port: number }
  | { type: 'setShared'; tabIds: number[]; shared: boolean }
  | { type: 'setShareAll'; on: boolean }
  | { type: 'setActivityLog'; on: boolean }
  | { type: 'setGraphEnabled'; on: boolean }
  | { type: 'setToolEnabled'; name: string; enabled: boolean }
  | { type: 'setDevMode'; mode: 'auto' | 'always' | 'never' }
  | { type: 'setBackgroundMode'; on: boolean }
  | { type: 'setOverlay'; on: boolean }
  | { type: 'setToolsEnabled'; names: string[]; enabled: boolean }
  | { type: 'connect' }
  | { type: 'stop' }
  | { type: 'clearLog' }
  | { type: 'focusTab'; tabId: number };
