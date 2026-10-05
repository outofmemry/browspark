import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from '../../test-apps/server.ts';
import { unpackedExtensionId } from '../src/updates.ts';
import { CHROME, callers, companionTab, enableDeveloperMode, launchExtensionChrome, pairAndShare, ROOT, startCompanion } from './harness.ts';

describe.skipIf(!process.env.E2E)('extension update e2e', () => {
test('an outdated unpacked extension updates itself in place from the dashboard and keeps its shared tab', async () => {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'bmcp-update-home-')));
  // The installer's folder, holding an older build of the same code.
  const folder = join(home, 'browspark-extension');
  cpSync(join(ROOT, 'dist/chromium-extension'), folder, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ ...manifest, version: '0.0.1' }));
  // The "release": the current build, packaged the way `bun run package` does.
  const archive = join(home, 'browspark-chrome-extension.zip');
  assert.equal(spawnSync('zip', ['-qr', archive, 'manifest.json', 'app.html', 'app.css', 'assets', 'dist'], { cwd: join(ROOT, 'dist/chromium-extension') }).status, 0, 'zip is required');
  const releases = createServer((req, res) => {
    const base = `http://127.0.0.1:${(releases.address() as AddressInfo).port}`;
    if (req.url === '/latest') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tag_name: `v${version}`, html_url: `${base}/release`, body: '* Updated build', assets: [{ name: 'browspark-chrome-extension.zip', browser_download_url: `${base}/chrome.zip` }] })); return; }
    if (req.url === '/chrome.zip') { res.end(readFileSync(archive)); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => releases.listen(0, '127.0.0.1', resolve));
  const { server, url } = await startTestServer(join(ROOT, 'test-apps'));
  const ext = await launchExtensionChrome(CHROME, folder);
  await enableDeveloperMode(ext);
  const client = await startCompanion('Updater', { HOME: home, BROWSPARK_UPDATE_CHECK: '1', BROWSPARK_RELEASES_URL: `http://127.0.0.1:${(releases.address() as AddressInfo).port}/latest` });
  const waitFor = async <T>(check: () => Promise<T>, description: string, tries = 150): Promise<T> => {
    for (let i = 0; i < tries; i++) { try { const v = await check(); if (v) return v; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    assert.fail(description);
  };
  try {
    assert.equal(ext.extId, unpackedExtensionId(folder), 'Chromium named the extension after its folder');
    const { ok } = callers(client);
    const pageUrl = `${url}basic.html?update-fixture`;
    await ext.cdp.send('Target.createTarget', { url: pageUrl });
    const tabId = await pairAndShare(ext, ok, pageUrl);

    // The companion finds the release and the folder; the dashboard prompts.
    const state = await waitFor(async () => { const s = await ext.msg!({ type: 'getState' }); return s.update?.status?.installable && s; }, 'dashboard learns about the update');
    assert.equal(state.update.status.latest, version);
    assert.equal(state.update.status.target.path, folder);
    assert.equal(state.update.status.target.display, '~/browspark-extension');
    await waitFor(() => ext.eval!(`document.querySelector('#update-title')?.textContent === 'Update available' && document.querySelector('.update-where code')?.textContent === '~/browspark-extension'`), 'update dialog opens on its own');
    assert.equal(await ext.eval!(`chrome.action.getBadgeText({})`), 'NEW', 'toolbar badge');

    await ext.eval!(`document.querySelector('#update-go').click()`);
    const progress: unknown[] = [];
    for (let i = 0; i < 20; i++) { try { progress.push((await ext.msg!({ type: 'getState' }))?.update); } catch (e) { progress.push(String(e)); break; } await new Promise((r) => setTimeout(r, 100)); }
    const diagnose = async () => JSON.stringify({ folderVersion: JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).version, targets: (await ext.cdp.send('Target.getTargets')).targetInfos.map((t: any) => `${t.type} ${t.url}`), progress: progress.slice(-4) }, null, 1);
    // The extension reloads from the same folder; its dashboard comes back on the new version with a confirmation.
    const dashboard = await waitFor<((expression: string) => Promise<any>) | undefined>(async () => {
      const { targetInfos } = await ext.cdp.send('Target.getTargets');
      for (const t of targetInfos.filter((x: any) => x.type === 'page' && x.url.startsWith(`chrome-extension://${ext.extId}/app.html`))) {
        const { sessionId } = await ext.cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        const evaluate = (expression: string) => ext.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId).then((r: any) => r.result.value);
        if (await evaluate(`chrome.runtime.getManifest().version === ${JSON.stringify(version)} && document.body.textContent.includes('Browspark is now v${version} (was v0.0.1)')`)) return evaluate;
      }
      return undefined;
    }, 'reloaded dashboard shows the new version', 300).catch(async (e) => { console.error(await diagnose()); throw e; }) as (expression: string) => Promise<any>;
    assert.equal(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).version, version, 'folder holds the release');
    assert.equal(unpackedExtensionId(folder), ext.extId, 'same folder, same extension id');
    assert.equal(await dashboard(`chrome.action.getBadgeText({})`), '', 'badge cleared');

    // Sharing and the companion's tab id survive the reload.
    await waitFor(async () => (await dashboard(`chrome.runtime.sendMessage({type:'getState'})`))?.connected, 'extension reconnects');
    const after = await dashboard(`chrome.runtime.sendMessage({type:'getState'})`);
    assert.ok(after.tabs.find((t: any) => t.url === pageUrl)?.shared, 'shared tab stays shared');
    assert.equal((await companionTab(ok, pageUrl)).id, tabId, 'companion tab id is unchanged');
    assert.match(await ok('browser_snapshot', { tabId }), /Test App/);
  } finally {
    await client.close().catch(() => {});
    await ext.cleanup();
    server.close(); releases.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);
});
