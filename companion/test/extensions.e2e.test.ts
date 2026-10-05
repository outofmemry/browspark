import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callers, dashboard, launchExtensionChrome, pairAndShare, ROOT, startCompanion, type Ext } from './harness.ts';

// Real browser: manage a dummy target extension through browser_extensions. Chromium only (Firefox needs a signed or about:debugging install).
// The optional `management` permission needs a user gesture, so the test builds a copy of the extension that requests it up front.
describe.skipIf(!process.env.E2E)('browser_extensions e2e', () => {
test('lists, disables, messages and opens options pages of a target extension, behind user consent', async () => {
  const copy = mkdtempSync(join(tmpdir(), 'bmcp-ext-'));
  cpSync(join(ROOT, 'dist/chromium-extension'), copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
  manifest.permissions.push('management'); delete manifest.optional_permissions;
  writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest));
  let ext: Ext | undefined, client: Awaited<ReturnType<typeof startCompanion>> | undefined;
  try {
    ext = await launchExtensionChrome(undefined, copy);
    const { id: targetId } = await ext.cdp.send('Extensions.loadUnpacked', { path: join(ROOT, 'test-apps/target-extension') });
    client = await startCompanion();
    const { call, ok, okJson } = callers(client);
    await ext.cdp.send('Target.createTarget', { url: 'about:blank#e2e' });
    await pairAndShare(ext, ok, 'about:blank');
    const msg = await dashboard(ext);

    // Off by default: the tool is disabled until the user consents, and the extension refuses even if it were called.
    assert.match((await call('browser_extensions', { action: 'list' })).txt, /switched off/);
    await msg({ type: 'setExtensionsAccess', on: true });
    const list = await okJson<any[]>('browser_extensions', { action: 'list' });
    assert.ok(list.some((e) => e.id === targetId && e.enabled), JSON.stringify(list));
    assert.equal(list.find((e) => e.id === ext!.extId)?.self, true);

    const info = await okJson('browser_extensions', { action: 'info', extensionId: targetId });
    assert.ok(info.hostPermissions.some((p: string) => p.includes('example.com')) || info.permissions.length >= 0);
    assert.match((await call('browser_extensions', { action: 'disable', extensionId: ext.extId })).txt, /cannot manage, message or open itself/);
    assert.match((await call('browser_extensions', { action: 'info', extensionId: 'not-an-id' })).txt, /not an extension id/);

    assert.deepEqual((await okJson('browser_extensions', { action: 'message', extensionId: targetId, message: { hello: 'world' } })).reply, { echo: { hello: 'world' }, from: ext.extId });

    // Options page: opened but not automatable until the user allows it.
    assert.match(await ok('browser_extensions', { action: 'open', extensionId: targetId }), /cannot be automated/);
    await msg({ type: 'setExtensionPages', on: true });
    const opened = await ok('browser_extensions', { action: 'open', extensionId: targetId });
    const tabId = Number(/tab (\d+)/.exec(opened)![1]);
    assert.match(opened, /shared; drive it/);
    // Chromium may still refuse the debugger on another extension's page; either outcome must be explicit, never silent.
    const snap = await call('browser_snapshot', { tabId });
    assert.ok(!snap.err ? /Target options/.test(snap.txt) : /refused to attach|Another extension/.test(snap.txt), snap.txt);
    assert.match((await call('browser_navigate', { tabId, url: 'chrome://extensions' })).txt, /./);
    assert.match((await call('browser_snapshot', { tabId })).txt, /browser-internal page|unsupported|refused/i);

    await ok('browser_extensions', { action: 'disable', extensionId: targetId });
    assert.equal((await okJson<any[]>('browser_extensions', { action: 'list' })).find((e) => e.id === targetId).enabled, false);
    assert.match((await call('browser_extensions', { action: 'open', extensionId: targetId })).txt, /disabled/);
    await ok('browser_extensions', { action: 'enable', extensionId: targetId });

    // Audit trail
    await msg({ type: 'setActivityLog', on: true });
    await ok('browser_extensions', { action: 'list' });
    const state = await msg({ type: 'getState' });
    assert.ok(state.recent.some((r: any) => r.method === 'extensions.list'), 'extension operations are logged');

    // Revoking consent blocks the tool again
    await msg({ type: 'setExtensionsAccess', on: false });
    assert.match((await call('browser_extensions', { action: 'list' })).txt, /switched off/);
  } finally { await client?.close(); await ext?.cleanup(); rmSync(copy, { recursive: true, force: true }); }
}, 120_000);
});
