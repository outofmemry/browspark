// Fetch-domain interception shared by network mocks, sources overrides, and the navigation policy (allowed/blocked domains).
import type { Sessions } from '../session.ts';

export interface Policy { allow?: string[]; block?: string[] }
export const policies = new Map<number, Policy>();
/** Applied automatically to tabs the agent opens (browser_tabs new, browser_fetch). */
export let defaultPolicy: Policy | undefined;
export const setDefaultPolicy = (p?: Policy) => { defaultPolicy = p; };

const fetchOn = new Set<number>();
const lastPatterns = new Map<number, string[]>();
/** Tabs whose debugger detached while rules were active: interception is re-armed before their next command. */
const needsRestore = new Set<number>();
const norm = (d: string) => d.trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
const matches = (host: string, d: string) => { const n = norm(d); return !!n && (host === n || host.endsWith('.' + n)); };

/** true when the policy lets this URL through. Non-http(s) schemes (data:, blob:, about:) are always allowed. */
export function allowedByPolicy(url: string, p: Policy): boolean {
  let host: string; try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) return true; host = u.hostname.toLowerCase(); } catch { return true; }
  if (p.block?.some((d) => matches(host, d))) return false;
  if (p.allow?.length) return p.allow.some((d) => matches(host, d));
  return true;
}

/** (Re)apply Fetch interception for a tab from its override patterns plus the policy. Disables Fetch when nothing needs it. */
export async function applyFetch(sessions: Sessions, tabId: number, overridePatterns: string[]): Promise<boolean> {
  lastPatterns.set(tabId, overridePatterns);
  const patterns = overridePatterns.map((urlPattern) => ({ urlPattern, requestStage: 'Request' }));
  if (policies.get(tabId)) patterns.push({ urlPattern: '*', requestStage: 'Request' });
  if (!patterns.length) { if (fetchOn.has(tabId)) { await sessions.cdp(tabId, 'Fetch.disable').catch(() => {}); fetchOn.delete(tabId); } return false; }
  await sessions.cdp(tabId, 'Fetch.enable', { patterns });
  fetchOn.add(tabId);
  return true;
}
/** Re-apply whatever interception this tab had, e.g. after a probe disabled Fetch or the debugger re-attached. */
export const restoreFetch = (sessions: Sessions, tabId: number) => {
  needsRestore.delete(tabId);
  const p = lastPatterns.get(tabId);
  if (!p && !policies.has(tabId)) return Promise.resolve(false);
  fetchOn.delete(tabId);
  return applyFetch(sessions, tabId, p ?? []);
};
/** Set or clear a tab's domain policy. A policy only protects while the debugger is attached, so the tab is held against idle detach. */
export async function setPolicy(sessions: Sessions, tabId: number, policy: Policy | undefined) {
  if (policy) policies.set(tabId, policy); else policies.delete(tabId);
  await sessions.hold(tabId, 'policy', !!policy);
  await applyFetch(sessions, tabId, lastPatterns.get(tabId) ?? []);
}
/** Called from the session layer when a tab's debugger detached: a re-attach must re-arm interception before other commands. */
export const onDetached = (tabId: number) => { fetchOn.delete(tabId); if (policies.has(tabId) || lastPatterns.get(tabId)?.length) needsRestore.add(tabId); };
export const pendingRestore = (tabId: number) => needsRestore.has(tabId);
export const forgetTab = (tabId: number) => { fetchOn.delete(tabId); policies.delete(tabId); lastPatterns.delete(tabId); needsRestore.delete(tabId); };
