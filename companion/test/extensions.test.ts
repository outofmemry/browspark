import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Bridge } from '../src/bridge.ts';
import { PROTOCOL_VERSION, isExtensionId, isExtensionPage, unsupportedReason, type Req } from '../../shared/protocol.ts';
import { assertTarget, getExtension, listExtensions, messageExtension, setExtensionEnabled, uninstallExtension } from '../../extension/shared/src/extensions.ts';

const SELF = 'a'.repeat(32), OTHER = 'abcdefghijklmnopabcdefghijklmnop';
const raw = (id: string, extra = {}) => ({ id, name: `ext ${id.slice(0, 3)}`, version: '1.0', enabled: true, type: 'extension', permissions: ['tabs'], hostPermissions: ['<all_urls>'], mayDisable: true, ...extra });

function fakeApi(overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  const mgmt = {
    getAll: async () => [raw(SELF), raw(OTHER)],
    get: async (id: string) => { if (id !== OTHER && id !== SELF) throw new Error('not found'); return raw(id); },
    setEnabled: async (id: string, enabled: boolean) => { calls.push(['setEnabled', id, enabled]); },
    uninstall: async (id: string, opts: unknown) => { calls.push(['uninstall', id, opts]); },
    getPermissionWarningsById: async () => ['Read your browsing history'],
    ...overrides.management,
  };
  return { api: { runtime: { id: SELF, sendMessage: overrides.sendMessage ?? (async (id: string, m: unknown) => { calls.push(['send', id, m]); return { pong: true }; }) }, management: overrides.noManagement ? undefined : mgmt } as any, calls };
}

test('extension ids and pages are validated', () => {
  assert.ok(isExtensionId(OTHER));
  assert.ok(isExtensionId('browspark@krishm.dev'));
  assert.ok(isExtensionId('{8f2c3a10-0b1d-4e6e-9a55-5a1a7d6a4c11}'));
  for (const bad of ['', 'ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP', 'abc', 'q'.repeat(32), '../x', 42, undefined]) assert.equal(isExtensionId(bad), false, String(bad));
  assert.ok(isExtensionPage(`chrome-extension://${OTHER}/options.html`));
  assert.ok(isExtensionPage('moz-extension://uuid/options.html'));
  assert.equal(isExtensionPage('https://example.com/chrome-extension://x'), false);
});

test('extension pages and extension stores stay blocked by default', () => {
  assert.ok(unsupportedReason(`chrome-extension://${OTHER}/options.html`));
  assert.ok(unsupportedReason('chrome://extensions'));
  assert.ok(unsupportedReason('https://chromewebstore.google.com/detail/x'));
  assert.ok(unsupportedReason('https://addons.mozilla.org/en-US/firefox/', 'firefox'));
  assert.ok(unsupportedReason('moz-extension://uuid/options.html', 'firefox'));
});

test('management wrapper lists, inspects and flags Browspark itself', async () => {
  const { api } = fakeApi();
  const list = await listExtensions(api);
  assert.equal(list.length, 2);
  assert.equal(list.find((e) => e.id === SELF)?.self, true);
  assert.equal(list.find((e) => e.id === OTHER)?.self, undefined);
  const info = await getExtension(api, OTHER, true);
  assert.deepEqual(info.permissionWarnings, ['Read your browsing history']);
  await assert.rejects(getExtension(api, 'b'.repeat(32)), /No installed extension/);
});

test('self-management and invalid ids are refused; missing permission explains how to grant it', async () => {
  const { api } = fakeApi();
  assert.throws(() => assertTarget(api, SELF), /cannot manage, message or open itself/);
  assert.throws(() => assertTarget(api, 'nope'), /valid extension id/);
  assert.equal(assertTarget(api, OTHER), OTHER);
  await assert.rejects(listExtensions(fakeApi({ noManagement: true }).api), /management permission has not been granted/);
});

test('enable, disable and uninstall use the browser APIs; uninstall always asks the user to confirm', async () => {
  const { api, calls } = fakeApi();
  await setExtensionEnabled(api, OTHER, false);
  assert.deepEqual(await uninstallExtension(api, OTHER), { uninstalled: true, name: 'ext abc' });
  assert.deepEqual(calls, [['setEnabled', OTHER, false], ['uninstall', OTHER, { showConfirmDialog: true }]]);
  const locked = fakeApi({ management: { get: async (id: string) => raw(id, { mayDisable: false }) } });
  await assert.rejects(setExtensionEnabled(locked.api, OTHER, false), /managed by policy/);
  await assert.rejects(uninstallExtension(locked.api, OTHER), /managed by policy/);
  const declined = fakeApi({ management: { uninstall: async () => { throw new Error('User cancelled uninstall'); } } });
  await assert.rejects(uninstallExtension(declined.api, OTHER), /was not uninstalled: User cancelled/);
});

test('messages are JSON-only, size limited, and unreachable targets get a helpful error', async () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(await messageExtension(api, OTHER, { type: 'ping' }), { pong: true });
  assert.deepEqual(calls, [['send', OTHER, { type: 'ping' }]]);
  await assert.rejects(messageExtension(api, OTHER, 'x'.repeat(1_000_001)), /larger than/);
  const cyclic: any = {}; cyclic.self = cyclic;
  await assert.rejects(messageExtension(api, OTHER, cyclic), /JSON-serializable/);
  await assert.rejects(messageExtension(api, OTHER, undefined), /JSON-serializable/);
  const gone = fakeApi({ sendMessage: async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); } });
  await assert.rejects(messageExtension(gone.api, OTHER, {}), /externally_connectable/);
  const big = fakeApi({ sendMessage: async () => 'y'.repeat(1_000_001) });
  await assert.rejects(messageExtension(big.api, OTHER, {}), /reply is larger/);
  // undefined and non-JSON replies are cloned to plain JSON
  const odd = fakeApi({ sendMessage: async () => undefined });
  assert.equal(await messageExtension(odd.api, OTHER, {}), null);
});

test('bridge validates extension replies and maps the options tab like tabs.create', async () => {
  const bridge = new Bridge(0);
  await bridge.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  await new Promise<void>((r) => ws.once('open', () => r()));
  const connected = new Promise<void>((r) => bridge.once('connected', r));
  ws.send(JSON.stringify({ event: 'hello', params: { version: PROTOCOL_VERSION, extensionVersion: 't' } }));
  await connected;
  let bad = false;
  ws.on('message', (d) => {
    const req = JSON.parse(d.toString()) as Req;
    const reply = (result: unknown) => ws.send(JSON.stringify({ id: req.id, result }));
    if (req.method === 'extensions.list') reply(bad ? [{ id: 'nope' }] : [raw(OTHER)]);
    else if (req.method === 'extensions.options') reply({ id: 7, windowId: 1, url: `chrome-extension://${OTHER}/o.html`, extensionId: OTHER, name: 'x', automatable: false });
    else if (req.method === 'extensions.message') reply(bad ? 'no reply field' : { reply: { ok: 1 } });
    else if (req.method === 'extensions.uninstall') reply({ uninstalled: true, name: 'x' });
  });
  assert.equal((await bridge.request<any[]>('extensions.list'))[0].id, OTHER);
  const opened = await bridge.request<any>('extensions.options', { id: OTHER });
  assert.notEqual(opened.id, 7, 'native tab id must be translated');
  assert.ok(opened.browserId);
  assert.deepEqual(await bridge.request('extensions.message', { id: OTHER, message: {} }), { reply: { ok: 1 } });
  assert.deepEqual(await bridge.request('extensions.uninstall', { id: OTHER }), { uninstalled: true, name: 'x' });
  bad = true;
  await assert.rejects(bridge.request('extensions.list'), /invalid extension list/);
  await assert.rejects(bridge.request('extensions.message', { id: OTHER }), /invalid extension message reply/);
  ws.close();
  bridge.close();
});

test('an extension speaking protocol 2 is refused', async () => {
  const bridge = new Bridge(0);
  await bridge.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  await new Promise<void>((r) => ws.once('open', () => r()));
  const code = new Promise<number>((r) => ws.once('close', (c) => r(c)));
  ws.send(JSON.stringify({ event: 'hello', params: { version: 2, extensionVersion: 't' } }));
  assert.equal(await code, 4002);
  bridge.close();
});
