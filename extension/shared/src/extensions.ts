// Other installed extensions: chrome.management / browser.management plus cross-extension messaging.
// Everything here is consent-gated by background.ts; this module only wraps the browser differences.
import { MESSAGE_LIMIT_BYTES, isExtensionId, type ExtensionInfo } from '../../../shared/protocol.ts';

export const MANAGEMENT_PERMISSION = { permissions: ['management' as const] };
export const MESSAGE_TIMEOUT_MS = 30_000;

// Minimal shapes: this module is also type-checked by the companion's tests, which do not load the chrome.* typings.
interface Raw { id: string; name: string; version: string; enabled: boolean; type: string; description?: string; homepageUrl?: string; optionsUrl?: string; installType?: string; mayDisable?: boolean; permissions?: string[]; hostPermissions?: string[] }
interface Management { getAll(): Promise<Raw[]>; get(id: string): Promise<Raw>; setEnabled(id: string, enabled: boolean): Promise<void>; uninstall(id: string, options: { showConfirmDialog: boolean }): Promise<void>; getPermissionWarningsById?(id: string): Promise<string[]> }
export interface ExtensionsApi { runtime: { id: string; sendMessage: unknown } }

/** The management namespace only exists once the optional permission is granted. */
const management = (api: ExtensionsApi): Management => {
  const m = (api as any).management;
  if (!m) throw new Error('The management permission has not been granted. Ask the user to allow it in the Browspark dashboard (Settings → Other extensions).');
  return m;
};

const toInfo = (e: Raw, selfId: string): ExtensionInfo => ({
  id: e.id, name: e.name, version: e.version, enabled: e.enabled, type: e.type,
  description: e.description?.slice(0, 500) || undefined, homepageUrl: e.homepageUrl || undefined, optionsUrl: e.optionsUrl || undefined,
  installType: e.installType, mayDisable: e.mayDisable,
  permissions: e.permissions ?? [], hostPermissions: e.hostPermissions ?? [],
  self: e.id === selfId || undefined,
});

/** Browspark must never manage, message or open the pages of itself: that would let an agent reach its own consent settings. */
export const assertTarget = (api: ExtensionsApi, id: unknown): string => {
  if (!isExtensionId(id)) throw new Error('A valid extension id is required; call browser_extensions with action "list" to see ids.');
  if (id === api.runtime.id) throw new Error('Browspark cannot manage, message or open itself.');
  return id;
};

export async function listExtensions(api: ExtensionsApi): Promise<ExtensionInfo[]> {
  return (await management(api).getAll()).map((e) => toInfo(e, api.runtime.id));
}

export async function getExtension(api: ExtensionsApi, id: string, withWarnings = false): Promise<ExtensionInfo> {
  const m = management(api);
  let raw: Raw;
  try { raw = await m.get(id); }
  catch { throw new Error(`No installed extension has id ${id}; call browser_extensions with action "list".`); }
  const info = toInfo(raw, api.runtime.id);
  if (withWarnings && m.getPermissionWarningsById) {
    try { info.permissionWarnings = await m.getPermissionWarningsById(id); } catch {}
  }
  return info;
}

export async function setExtensionEnabled(api: ExtensionsApi, id: string, enabled: boolean): Promise<ExtensionInfo> {
  const info = await getExtension(api, id);
  if (info.mayDisable === false) throw new Error(`${info.name} is managed by policy and cannot be ${enabled ? 'enabled' : 'disabled'}.`);
  try { await management(api).setEnabled(id, enabled); }
  catch (e) { throw new Error(`Could not ${enabled ? 'enable' : 'disable'} ${info.name}: ${(e as Error).message || e}. Enabling an extension the user turned off may need their confirmation in the browser.`); }
  return getExtension(api, id);
}

export async function uninstallExtension(api: ExtensionsApi, id: string): Promise<{ uninstalled: true; name: string }> {
  const info = await getExtension(api, id);
  if (info.mayDisable === false) throw new Error(`${info.name} is managed by policy and cannot be uninstalled.`);
  // The browser shows its own confirmation dialog; the user declining rejects this call.
  try { await management(api).uninstall(id, { showConfirmDialog: true }); }
  catch (e) { throw new Error(`${info.name} was not uninstalled: ${(e as Error).message || e}`); }
  return { uninstalled: true, name: info.name };
}

/** runtime.sendMessage(extensionId, message): reaches only extensions that accept Browspark in externally_connectable / onMessageExternal. */
export async function messageExtension(api: ExtensionsApi, id: string, message: unknown): Promise<unknown> {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(message); } catch { throw new Error('message must be JSON-serializable'); }
  if (encoded === undefined) throw new Error('message must be JSON-serializable');
  if (encoded.length > MESSAGE_LIMIT_BYTES) throw new Error(`message is larger than ${MESSAGE_LIMIT_BYTES} bytes`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`No reply from ${id} within ${MESSAGE_TIMEOUT_MS / 1000}s`)), MESSAGE_TIMEOUT_MS); });
  try {
    const reply = await Promise.race([(api.runtime.sendMessage as any)(id, JSON.parse(encoded)) as Promise<unknown>, timeout]);
    const out = JSON.stringify(reply ?? null);
    if (out.length > MESSAGE_LIMIT_BYTES) throw new Error(`reply is larger than ${MESSAGE_LIMIT_BYTES} bytes`);
    return JSON.parse(out); // JSON-cloneable data only: no functions, DOM nodes or prototypes cross the bridge
  } catch (e) {
    const m = (e as Error).message || String(e);
    if (/receiving end|could not establish|no (?:matching )?(?:listener|receiver)|not (?:permitted|allowed)|externally_connectable|extension.*invalid/i.test(m)) {
      throw new Error(`Could not reach ${id}: it is not installed or enabled, or it does not accept messages from Browspark (it must list this extension's id in externally_connectable and answer in runtime.onMessageExternal). Original error: ${m}`);
    }
    throw e;
  } finally { clearTimeout(timer); }
}
