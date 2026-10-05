import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startTestServer } from '../../test-apps/server.ts';
import { callers, launchExtensionChrome, pairAndShare, ROOT, startCompanion } from './harness.ts';

// Password managers inject their own extension iframe into login pages. Chromium then refuses chrome.debugger.attach for the whole tab,
// so the agent must get an explanation it can act on, not the raw browser error.
describe.skipIf(!process.env.E2E)('page containing another extension\'s frame', () => {
test('attach failure explains the cause and the way out', async () => {
  const { server, url } = await startTestServer(join(ROOT, 'test-apps'));
  const ext = await launchExtensionChrome();
  let client: Awaited<ReturnType<typeof startCompanion>> | undefined;
  try {
    await ext.cdp.send('Extensions.loadUnpacked', { path: join(ROOT, 'test-apps/target-extension') });
    client = await startCompanion();
    const { call, ok } = callers(client);
    const page = `${url}basic.html?inject-frame=1`;
    await ext.cdp.send('Target.createTarget', { url: page });
    await new Promise((r) => setTimeout(r, 2500)); // let the content script add its frame
    const tabId = await pairAndShare(ext, ok, page);
    const r = await call('browser_snapshot', { tabId });
    assert.ok(r.err);
    assert.match(r.txt, /another extension has put a frame into this page/);
    assert.match(r.txt, /site access/);
    assert.match(r.txt, /developer mode/);
  } finally { await client?.close(); await ext.cleanup(); server.close?.(); }
}, 90_000);
});
