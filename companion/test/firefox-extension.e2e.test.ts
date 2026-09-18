// Native Firefox extension + real MCP. Build first; run separately from other browser suites:
// FIREFOX_EXTENSION_E2E=1 FIREFOX=/path/to/firefox bun test companion/test/firefox-extension.e2e.test.ts
import { afterAll, beforeAll, describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DirectFirefox, findFirefox } from '../src/firefox.ts';
import { startTestServer } from '../../test-apps/server.ts';
import { callers, companionTab, ROOT } from './harness.ts';

describe.skipIf(process.env.FIREFOX_EXTENSION_E2E !== '1')('Firefox shared-tab extension e2e', () => {
  let browser: DirectFirefox, client: Client, http: Server, temp: string, appUrl: string;
  let dashboardId: number, dashboardContext: string, nativeTabId: number, tabId: number;
  let privilegedInput = true;
  let call: ReturnType<typeof callers>['call'], ok: ReturnType<typeof callers>['ok'];
  const evaluate = async (expression: string) => {
    const result = await browser.cdp(dashboardId, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const message = (value: unknown) => evaluate(`browser.runtime.sendMessage(${JSON.stringify(value)})`);
  const waitFor = async (expression: string) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const state = await message({ type: 'getState' }).catch(() => undefined);
    assert.fail(`Firefox dashboard did not reach: ${expression}\n${JSON.stringify(state && { connected: state.connected, lastError: state.lastError, stopped: state.stopped, port: state.port, automationReady: state.automationReady, firefoxHostAccess: state.firefoxHostAccess })}`);
  };
  const clickDashboard = async (expression: string) => {
    const point = await evaluate(`(() => { const el = ${expression}; if (!el || el.disabled) throw new Error('Missing or disabled dashboard control'); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await browser.activate(dashboardId);
    for (const type of ['mousePressed', 'mouseReleased']) await browser.cdp(dashboardId, 'Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  const shareCheckbox = () => `document.querySelector('.tab[data-key="${nativeTabId}"] input[type="checkbox"]')`;
  const refOf = (snapshot: string, name: string) => {
    const row = snapshot.split('\n').find((line) => /^\s*- (button|textbox|combobox|checkbox|link|radio|slider)\b/.test(line) && line.includes(`"${name}"`) && /\[ref=e\d+\]/.test(line));
    assert.ok(row, `No ref for ${name}:\n${snapshot}`);
    return /\[ref=(e\d+)\]/.exec(row)![1];
  };

  beforeAll(async () => {
    const extension = join(ROOT, 'dist/firefox-extension');
    const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
    const extensionId = manifest.browser_specific_settings.gecko.id;
    const uuid = '96b0b388-cbc1-4d04-a4a7-123edc8aee2b';
    temp = mkdtempSync(join(realpathSync(tmpdir()), 'browspark-firefox-extension-'));
    const profile = join(temp, 'browser');
    mkdirSync(profile);
    // The native requests still validate permissions and require user gestures; only this
    // throwaway profile's browser-chrome confirmation prompts are auto-accepted.
    writeFileSync(join(profile, 'user.js'), `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [extensionId]: uuid }))});\nuser_pref("extensions.webextOptionalPermissionPrompts", false);\n`);
    ({ server: http, url: appUrl } = await startTestServer(join(ROOT, 'test-apps')));
    http.prependListener('request', (req, res) => { if (req.url?.includes('strict-csp')) res.setHeader('Content-Security-Policy', "script-src 'none'; object-src 'none'"); });
    browser = new DirectFirefox(profile, 'extension-e2e');
    // Recent Firefox builds gate privileged BiDi commands such as webExtension.install
    // behind system access; the flag is ignored by older builds.
    await browser.launch({ headless: true, browserPath: realpathSync(findFirefox(process.env.FIREFOX)), args: ['-remote-allow-system-access'], downloadDir: join(temp, 'downloads'), url: appUrl });
    const installed = await browser.bidi('webExtension.install', { extensionData: { type: 'path', path: extension } });
    assert.equal(installed.extension, extensionId);
    // Firefox blocks remote navigation to addon URLs and omits their navigation events.
    // Find the dashboard opened by onInstalled in the browser's current context tree.
    for (let i = 0; i < 100; i++) {
      const tree = await browser.bidi('browsingContext.getTree', {});
      const dashboard = tree.contexts.find((context: any) => context.url === `moz-extension://${uuid}/app.html`);
      const driverTab = dashboard && browser.listTabs().find((tab) => tab.targetId === dashboard.context);
      if (driverTab) { dashboardId = driverTab.id; dashboardContext = dashboard.context; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(dashboardId, `install opens the Firefox dashboard: ${JSON.stringify(await browser.bidi('browsingContext.getTree', {}))}`);
    // Recent Firefox builds reject synthetic input, element lookup, screenshots and
    // activation on privileged (moz-extension) pages. Dashboard gestures only work where allowed.
    try {
      await browser.bidi('input.performActions', { context: dashboardContext, actions: [{ type: 'none', id: 'probe', actions: [{ type: 'pause', duration: 0 }] }] });
    } catch { privilegedInput = false; }
    await waitFor('typeof browser !== "undefined" && !!browser.runtime?.sendMessage && !!document.querySelector("#main h1")');
    await evaluate('location.hash = "#/tabs"');
    await waitFor('document.querySelector("#main h1")?.textContent === "Tabs"');

    client = new Client({ name: 'firefox-extension-e2e', version: '0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'companion/src/index.ts'), '--port', '0'], stderr: 'inherit', env: { ...process.env, BROWSPARK_ARTIFACTS: join(temp, 'artifacts'), BROWSPARK_PROFILE: join(temp, 'chrome'), BROWSPARK_PROFILES: join(temp, 'profiles') } }));
    ({ call, ok } = callers(client));
    const status = await ok('browser_status');
    const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)/.exec(status)![1]);
    await message({ type: 'setConfig', port });
    await waitFor('browser.runtime.sendMessage({type:"getState"}).then(s => s.connected)');
    const state = await message({ type: 'getState' });
    nativeTabId = state.tabs.find((tab: any) => tab.url === appUrl).id;
    tabId = (await companionTab(ok, appUrl)).id;
  }, 120_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await browser?.close();
    if (http) { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); }
    if (temp) rmSync(temp, { recursive: true, force: true });
  }, 30_000);

  test('install, connect and report state without dashboard gestures', async () => {
    assert.equal((await client.listTools()).tools.length, 43);
    assert.match(await ok('browser_status'), /Firefox/i);
    const denied = await call('browser_snapshot', { tabId });
    assert.ok(denied.err && /shared|allowed|usable/i.test(denied.txt), denied.txt);
    assert.equal(await evaluate('browser.permissions.contains({permissions:["userScripts"]})'), false);
    await waitFor('browser.runtime.sendMessage({type:"getState"}).then(s => s.graph?.browsers.length === 1 && s.graph?.agents.length === 1)');
    const graphState = await message({ type: 'getState' });
    assert.equal(graphState.graphEnabled, true, 'connection graph works before Firefox automation permissions are granted');
    assert.equal(graphState.graph.browsers[0].id, graphState.graph.thisBrowserId);
    assert.match(graphState.graph.browsers[0].name, /Firefox/);
    assert.deepEqual(graphState.graph.agents.map((agent: any) => agent.name), ['firefox-extension-e2e']);
    assert.equal(graphState.automationReady, false, 'page automation stays off until the user grants it in the dashboard');
  });

  test('dashboard sharing enables normal page tools; unshare and Stop revoke access', async () => {
    if (!privilegedInput) { console.log('  (this Firefox blocks synthetic input on its privileged dashboard page; skipping dashboard-gesture coverage)'); return; }
    assert.equal((await client.listTools()).tools.length, 43);
    assert.match(await ok('browser_status'), /Firefox/i);
    const denied = await call('browser_snapshot', { tabId });
    assert.ok(denied.err && /shared|allowed|usable/i.test(denied.txt), denied.txt);

    assert.equal(await evaluate('browser.permissions.contains({permissions:["userScripts"]})'), false);
    await waitFor('browser.runtime.sendMessage({type:"getState"}).then(s => s.graph?.browsers.length === 1 && s.graph?.agents.length === 1)');
    const graphState = await message({ type: 'getState' });
    assert.equal(graphState.graphEnabled, true, 'connection graph works before Firefox automation permissions are granted');
    assert.equal(graphState.graph.browsers[0].id, graphState.graph.thisBrowserId);
    assert.match(graphState.graph.browsers[0].name, /Firefox/);
    assert.deepEqual(graphState.graph.agents.map((agent: any) => agent.name), ['firefox-extension-e2e']);
    await evaluate('location.hash = "#/graph"');
    await waitFor(`document.querySelector('.graph-browser[data-current-browser="true"]')?.dataset.browserId === ${JSON.stringify(graphState.graph.thisBrowserId)} && document.querySelector(".graph-browser img.graph-brand-logo")?.naturalWidth > 0`);
    assert.ok(await evaluate('document.querySelector(".graph-browser img.graph-brand-logo").src.includes("/firefox.")'));
    const graphWidth = await evaluate('document.querySelector(".graph-browser").getBoundingClientRect().width');
    await clickDashboard('document.querySelector("#graph-zoom-in")');
    await waitFor(`document.querySelector(".graph-browser").getBoundingClientRect().width > ${graphWidth}`);
    const nodePoint = () => evaluate('(() => { const r = document.querySelector(".graph-browser").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
    const beforeDrag = await nodePoint();
    const connectionPath = () => evaluate('document.querySelector(".browser-edge path").getAttribute("d")');
    const beforePath = await connectionPath();
    await browser.cdp(dashboardId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...beforeDrag, button: 'left', clickCount: 1 });
    await browser.cdp(dashboardId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: beforeDrag.x - 45, y: beforeDrag.y + 30, button: 'left' });
    await browser.cdp(dashboardId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: beforeDrag.x - 45, y: beforeDrag.y + 30, button: 'left', clickCount: 1 });
    await waitFor(`Math.abs(document.querySelector(".graph-browser").getBoundingClientRect().x + document.querySelector(".graph-browser").getBoundingClientRect().width/2 - ${beforeDrag.x - 45}) < 2`);
    assert.ok(Math.abs((await nodePoint()).y - beforeDrag.y - 30) < 2, 'Firefox nodes follow the pointer in both axes');
    assert.notEqual(await connectionPath(), beforePath, 'Firefox redraws the dragged node connection');
    await evaluate('location.hash = "#/tabs"');
    await waitFor('document.querySelector("#main h1")?.textContent === "Tabs"');
    await message({ type: 'setShared', tabIds: [nativeTabId], shared: true });
    assert.ok((await message({ type: 'getState' })).tabs.some((tab: any) => tab.id === nativeTabId && tab.shared));
    const missingPermission = await call('browser_snapshot', { tabId });
    assert.ok(missingPermission.err && /permission|enable|allow|shared/i.test(missingPermission.txt), missingPermission.txt);
    await message({ type: 'setShared', tabIds: [nativeTabId], shared: false });
    for (let step = 0; step < 2; step++) {
      const state = await message({ type: 'getState' });
      if (state.automationReady) break;
      await waitFor('document.querySelector("#enable-firefox") && !document.querySelector("#enable-firefox").disabled');
      await clickDashboard('document.querySelector("#enable-firefox")');
      await waitFor(`browser.runtime.sendMessage({type:"getState"}).then(s => s.${state.firefoxHostAccess ? 'automationReady' : 'firefoxHostAccess'})`);
    }
    assert.equal(await evaluate('browser.permissions.contains({permissions:["userScripts"],origins:["<all_urls>"]})'), true);
    await waitFor(`${shareCheckbox()} && !${shareCheckbox()}.disabled && !${shareCheckbox()}.checked`);

    await clickDashboard(shareCheckbox());
    await waitFor(`browser.runtime.sendMessage({type:"getState"}).then(s => s.tabs.some(t => t.id === ${nativeTabId} && t.shared))`);
    const snapshot = await ok('browser_snapshot', { tabId });
    assert.match(snapshot, /heading "Test App"/);
    const capabilities = JSON.parse(await ok('devtools_capabilities', { tabId }));
    assert.equal(capabilities.mode, 'extension');
    assert.equal(capabilities.protocol, 'firefox-webextension');
    for (const [tool, args] of [
      ['devtools_network', { tabId, action: 'search' }],
      ['devtools_console', { tabId, action: 'search' }],
      ['devtools_cdp', { tabId, method: 'Page.getNavigationHistory' }],
      ['browser_pdf', { tabId }],
    ] as const) {
      const result = await call(tool, args);
      assert.ok(result.err && /unsupported/i.test(result.txt), `${tool}: ${result.txt}`);
    }
    const name = refOf(snapshot, 'Name');
    assert.equal(refOf(await ok('browser_snapshot', { tabId }), 'Name'), name, 'refs survive repeated snapshots');
    await ok('browser_fill', { tabId, ref: name, text: 'Firefox extension' });
    await ok('browser_select', { tabId, ref: refOf(snapshot, 'Color'), values: ['Blue'] });
    await ok('browser_click', { tabId, ref: refOf(snapshot, 'Agree') });
    await ok('browser_click', { tabId, ref: refOf(snapshot, 'Submit') });
    assert.match(await ok('browser_read', { tabId, what: 'text' }), /submitted:Firefox extension:b:true/);
    await ok('browser_click', { tabId, ref: refOf(snapshot, 'Load later') });
    await ok('browser_wait', { tabId, text: 'Loaded!', timeoutMs: 5000 });
    const shot = await call('browser_screenshot', { tabId });
    assert.ok(!shot.err && shot.img?.mimeType === 'image/png', shot.txt);
    const viewport = Buffer.from(shot.img.data, 'base64');
    assert.deepEqual([...viewport.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const fullPage = await call('browser_screenshot', { tabId, fullPage: true });
    assert.ok(!fullPage.err && fullPage.img?.mimeType === 'image/png', fullPage.txt);
    assert.ok(Buffer.from(fullPage.img.data, 'base64').readUInt32BE(20) > viewport.readUInt32BE(20), 'full-page screenshot includes the document below the viewport');
    const element = await call('browser_screenshot', { tabId, ref: name });
    assert.ok(!element.err && element.img?.mimeType === 'image/png', element.txt);
    assert.ok(Buffer.from(element.img.data, 'base64').readUInt32BE(20) < viewport.readUInt32BE(20), 'element screenshot is cropped');
    const jpeg = await call('browser_screenshot', { tabId, format: 'jpeg', quality: 60 });
    assert.ok(!jpeg.err && jpeg.img?.mimeType === 'image/jpeg', jpeg.txt);
    assert.equal(Buffer.from(jpeg.img.data, 'base64').readUInt16BE(0), 0xffd8);
    await ok('browser_navigate', { tabId, url: appUrl + 'page2.html' });
    assert.match(await ok('browser_snapshot', { tabId }), /Page Two/);
    await ok('browser_navigate', { tabId, url: appUrl + '?strict-csp' });
    assert.match(await ok('browser_snapshot', { tabId }), /Test App/, 'page CSP does not block the user-script world');
    const isolation = JSON.parse(await ok('devtools_evaluate', { tabId, expression: '({browser:typeof browser,chrome:typeof chrome,constructorBrowser:Function("return typeof browser")()})' }));
    assert.deepEqual(isolation.value, { browser: 'undefined', chrome: 'undefined', constructorBrowser: 'undefined' }, 'page evaluation has no extension API privileges');
    await ok('browser_navigate', { tabId, url: appUrl });
    assert.match(await ok('browser_snapshot', { tabId }), /Test App/);

    await waitFor(`${shareCheckbox()}?.checked`);
    await clickDashboard(shareCheckbox());
    await waitFor(`browser.runtime.sendMessage({type:"getState"}).then(s => !s.tabs.find(t => t.id === ${nativeTabId})?.shared)`);
    assert.equal((await call('browser_snapshot', { tabId })).err, true, 'unsharing revokes MCP access');
    await clickDashboard(shareCheckbox());
    await waitFor(`browser.runtime.sendMessage({type:"getState"}).then(s => s.tabs.some(t => t.id === ${nativeTabId} && t.shared))`);
    assert.match(await ok('browser_snapshot', { tabId }), /Test App/);
    const dashboardShot = await browser.cdp(dashboardId, 'Page.captureScreenshot', { format: 'png' });
    writeFileSync('/tmp/browspark-firefox-dashboard.png', Buffer.from(dashboardShot.data, 'base64'));
    await clickDashboard('[...document.querySelectorAll("#main button")].find(b => b.textContent.trim() === "Stop access")');
    await waitFor('browser.runtime.sendMessage({type:"getState"}).then(s => s.stopped && !s.connected && !s.tabs.some(t => t.shared))');
    assert.equal((await call('browser_snapshot', { tabId })).err, true, 'Stop revokes MCP access');
    await waitFor('[...document.querySelectorAll("#main button")].some(b => b.textContent.trim() === "Resume access" && !b.disabled)');
    await clickDashboard('[...document.querySelectorAll("#main button")].find(b => b.textContent.trim() === "Resume access")');
    await waitFor('browser.runtime.sendMessage({type:"getState"}).then(s => s.connected && !s.stopped)');
    assert.equal((await call('browser_snapshot', { tabId })).err, true, 'resuming does not silently re-share tabs');
    const profiles = JSON.parse(await ok('browser_session', { action: 'contexts' }));
    assert.ok(profiles.every((profile: any) => !profile.running), 'extension calls did not launch a developer browser');
  }, 120_000);
});
