import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Bridge, type BridgeConnection } from '../src/bridge.ts';
import { PROTOCOL_VERSION, isNewTab, unsupportedReason, type Req } from '../../shared/protocol.ts';

const hello = (params = {}) => JSON.stringify({ event: 'hello', params: { version: PROTOCOL_VERSION, extensionVersion: 't', ...params } });
const open = (ws: WebSocket) => new Promise<void>((r) => ws.once('open', () => r()));
const closed = (ws: WebSocket) => new Promise<number>((r) => ws.once('close', (c) => r(c)));

test('bridge connects, routes requests, rejects pending on disconnect', async () => {
  const bridge = new Bridge(0);
  await bridge.listen();
  const port = bridge.port;
  assert.notEqual(port, 0);

  // a web page (browser Origin) is refused on every route; extensions and native clients pass
  const refused = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin: 'https://evil.example' } });
  await new Promise<void>((r) => { refused.on('error', () => r()); refused.on('close', () => r()); refused.on('open', () => r()); }); // Bun's ws shim may emit error more than once
  assert.notEqual(refused.readyState, WebSocket.OPEN, 'browser origin must not get a socket');
  assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: 'chrome-extension://abc' } })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: 'moz-extension://abc' } })).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: 'https://moz-extension.example' } })).status, 403);

  // hello connects; request/response round-trips; tab events land
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await open(ws);
  const connected = new Promise<void>((r) => bridge.once('connected', r));
  ws.send(hello());
  await connected;
  assert.equal(bridge.connected, true);

  ws.on('message', (d) => {
    const req = JSON.parse(d.toString()) as Req;
    if (req.method === 'cdp' && (req.params as any).method === 'Page.enable') ws.send(JSON.stringify({ id: req.id, result: { ok: (req.params as any).method } }));
    if (req.method === 'tabs.list') ws.send(JSON.stringify({ id: req.id, error: 'boom' }));
  });
  ws.send(JSON.stringify({ event: 'tabs', params: [{ id: 1, url: 'https://x', title: 'x', shared: true, attached: false, windowId: 1 }] }));
  await new Promise((r) => bridge.once('tabs', r));
  assert.equal(bridge.tabs.length, 1);
  const tabId = bridge.tabs[0].id;
  assert.notEqual(tabId, 1);
  assert.deepEqual(await bridge.cdp(tabId, 'Page.enable'), { ok: 'Page.enable' });
  await assert.rejects(bridge.request('tabs.list'), /boom/);

  // in-flight request fails when the extension drops; nothing is retried
  const inflight = bridge.cdp(tabId, 'Runtime.evaluate');
  ws.close();
  await assert.rejects(inflight, /disconnected/);
  assert.equal(bridge.connected, false);
  bridge.close();
});

test('bridge rejects non-object JSON without crashing', async () => {
  const bridge = new Bridge(0);
  await bridge.listen();
  for (const payload of ['null', '42', '"hi"', '[1]']) {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    await open(ws); ws.send(payload);
    assert.equal(await closed(ws), 1003, payload);
  }
  assert.equal(bridge.connected, false);
  bridge.close();
});

test('unsupportedReason flags internal pages', () => {
  assert.ok(unsupportedReason('chrome://extensions'));
  assert.ok(unsupportedReason('https://chromewebstore.google.com/detail/x'));
  assert.equal(unsupportedReason('https://example.com'), undefined);
  assert.equal(unsupportedReason('about:blank'), undefined);
  assert.ok(unsupportedReason('chrome://newtab/'));
  assert.ok(unsupportedReason('vivaldi://newtab/'));
  assert.ok(unsupportedReason('vivaldi://settings/'));
  assert.ok(unsupportedReason('moz-extension://example/app.html', 'firefox'));
  assert.ok(unsupportedReason('https://addons.mozilla.org/firefox/', 'firefox'));
  assert.ok(unsupportedReason('file:///private/example.html', 'firefox'));
  assert.equal(unsupportedReason('https://example.com', 'firefox'), undefined);
});

test('isNewTab recognizes native Chromium and Firefox New Tab URLs', () => {
  for (const host of ['newtab', 'new-tab-page']) {
    for (const suffix of ['', '/', '?source=test', '/?source=test#section', '#section']) {
      const url = `chrome://${host}${suffix}`;
      assert.equal(isNewTab(url), true, url);
      assert.ok(unsupportedReason(url), 'New Tab is still unavailable for direct CDP inspection');
    }
  }
  for (const url of ['about:newtab', 'about:home', 'about:newtab#section', 'brave://newtab/', 'edge://newtab/', 'vivaldi://newtab/', 'vivaldi://newtab/?source=test']) assert.equal(isNewTab(url), true, url);
  for (const url of ['', 'newtab', 'chrome:newtab', 'chrome:/newtab', 'about:newtab/path', 'about:newtab-extra', 'about:blank', 'https://newtab/', 'chrome://settings/', 'chrome://newtab.example/', 'chrome://newtab-extra/', 'chrome://newtab/path', 'chrome://newtab//', 'chrome://new-tab-page-extra/', 'chrome://new-tab-page/path', 'chrome://user@newtab/', 'chrome://newtab:123/', 'chrome://settings/?next=chrome://newtab/', 'vivaldi://settings/', 'vivaldi://startpage/']) {
    assert.equal(isNewTab(url), false, url);
  }
});

test('bridge answers malformed request targets with 400 instead of crashing', async () => {
  const { connect } = await import('node:net');
  const bridge = new Bridge(0);
  await bridge.listen();
  const raw = (target: string, upgrade = false) => new Promise<string>((resolve) => {
    const s = connect(bridge.port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\n${upgrade ? 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' : ''}\r\n`));
    let out = ''; s.on('data', (d) => { out += d.toString(); }); s.on('close', () => resolve(out)); s.on('error', () => resolve(out));
    setTimeout(() => s.destroy(), 500);
  });
  assert.match(await raw('//['), /^HTTP\/1\.1 400/);
  await raw('//[', true); // upgrade path: socket is dropped, server keeps running
  const ok = await fetch(`http://127.0.0.1:${bridge.port}/`);
  assert.equal(ok.status, 200);
  bridge.close();
});

const nativeTab = (id = 1) => ({ id, url: 'https://example.com', title: 'Example', shared: true, attached: false, windowId: 1 });
async function connectBrowser(bridge: Bridge, instanceId: string, browserSessionId = 'session', browser = instanceId) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
  await open(ws);
  const connected = new Promise<BridgeConnection>((resolve) => bridge.once('connected', resolve));
  ws.send(hello({ instanceId, browserSessionId, browser }));
  return { ws, info: await connected };
}
async function publishTabs(bridge: Bridge, ws: WebSocket, tabs = [nativeTab()]) {
  const changed = new Promise<void>((resolve) => bridge.once('tabs', () => resolve()));
  ws.send(JSON.stringify({ event: 'tabs', params: tabs }));
  await changed;
}
const nextRequest = (ws: WebSocket) => new Promise<Req>((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));

test('multiple browser extensions isolate colliding tab ids, commands, events, downloads and policies', async () => {
  const bridge = new Bridge(0); await bridge.listen();
  try {
    const a = await connectBrowser(bridge, 'chrome'), b = await connectBrowser(bridge, 'brave');
    await publishTabs(bridge, a.ws); await publishTabs(bridge, b.ws);
    const aTab = a.info.tabs[0].id, bTab = b.info.tabs[0].id;
    assert.equal(bridge.connections().length, 2);
    assert.notEqual(aTab, bTab);
    assert.equal(bridge.connectionForTab(aTab)?.id, a.info.id);
    assert.equal(bridge.connectionForTab(bTab)?.id, b.info.id);
    assert.equal(a.info.tabs[0].browserName, 'chrome');
    assert.equal(b.info.tabs[0].browserId, b.info.id);
    await assert.rejects(bridge.cdp(1, 'Page.enable'), /wasn't found/);
    await assert.rejects(bridge.request('tabs.create', { url: 'about:blank' }), /browserId is required/);
    await assert.rejects(bridge.request('tabs.close', { tabId: aTab }, undefined, b.info.id), /belongs to browser/);

    const received = nextRequest(a.ws), response = bridge.cdp(aTab, 'Runtime.evaluate', { expression: '1' });
    const req = await received;
    assert.equal((req.params as any).tabId, 1);
    b.ws.send(JSON.stringify({ id: req.id, result: { source: 'foreign' } }));
    a.ws.send(JSON.stringify({ id: req.id, result: { source: 'chrome' } }));
    assert.deepEqual(await response, { source: 'chrome' });

    const event = new Promise<any>((resolve) => bridge.once('cdp.event', resolve));
    b.ws.send(JSON.stringify({ event: 'cdp.event', params: { tabId: 1, method: 'Page.loadEventFired', params: {} } }));
    assert.equal((await event).tabId, bTab);
    const events: number[] = [];
    bridge.on('cdp.event', (e) => events.push(e.tabId));
    b.ws.send(JSON.stringify({ event: 'cdp.event', params: { tabId: aTab, method: 'Page.loadEventFired', params: {} } }));

    const policy = new Promise<any>((resolve) => bridge.once('tools.policy', (p, connection) => resolve({ p, connection })));
    b.ws.send(JSON.stringify({ event: 'tools.policy', params: { disabled: ['browser_click'], overlay: false, browserId: a.info.id } }));
    const changed = await policy;
    assert.equal(changed.connection.id, b.info.id);
    assert.deepEqual(b.info.policy?.disabled, ['browser_click']);
    assert.equal(a.info.policy, undefined);
    assert.deepEqual(events, []);

    const downloadRequest = nextRequest(b.ws), downloads = bridge.request<any[]>('downloads.list', { tabId: bTab });
    const downloadReq = await downloadRequest;
    b.ws.send(JSON.stringify({ id: downloadReq.id, result: [{ guid: 'download', tabId: 1 }] }));
    assert.equal((await downloads)[0].tabId, bTab);

    const createRequest = nextRequest(b.ws), created = bridge.request<any>('tabs.create', { url: 'about:blank' }, undefined, b.info.id);
    const createReq = await createRequest;
    b.ws.send(JSON.stringify({ id: createReq.id, result: { id: 2, windowId: 1 } }));
    const newTab = await created;
    assert.notEqual(newTab.id, 2);
    assert.equal(bridge.connectionForTab(newTab.id)?.id, b.info.id);
    const detached: number[] = []; bridge.on('detached', (e) => detached.push(e.tabId));
    const disconnected = new Promise<void>((resolve) => bridge.once('disconnected', () => resolve()));
    b.ws.close(); await disconnected;
    assert.deepEqual(detached, [bTab, newTab.id], 'created tabs detach even before a tabs event or refresh');
    assert.equal(bridge.connectionForTab(aTab)?.id, a.info.id);
  } finally { bridge.close(); }
});

test('refresh and disconnect of one extension leave other browsers and pending requests intact', async () => {
  const bridge = new Bridge(0); await bridge.listen();
  try {
    const a = await connectBrowser(bridge, 'chrome'), b = await connectBrowser(bridge, 'brave');
    a.ws.on('message', (data) => { const req = JSON.parse(data.toString()); if (req.method === 'tabs.list') a.ws.send(JSON.stringify({ id: req.id, result: [nativeTab()] })); });
    b.ws.on('message', (data) => { const req = JSON.parse(data.toString()); if (req.method === 'tabs.list') b.ws.send(JSON.stringify({ id: req.id, result: [nativeTab()] })); });
    assert.equal((await bridge.listTabs()).length, 2);
    const aTab = a.info.tabs[0].id, bTab = b.info.tabs[0].id;
    const aMessage = nextRequest(a.ws), aPending = bridge.cdp(aTab, 'Page.enable');
    const bMessage = nextRequest(b.ws), bPending = bridge.cdp(bTab, 'Page.enable');
    const rejected = assert.rejects(bPending, /extension disconnected/);
    const aReq = await aMessage; await bMessage;
    const detached: number[] = []; bridge.on('detached', (e) => detached.push(e.tabId));
    b.ws.close(); await rejected;
    assert.equal(bridge.connected, true);
    assert.equal(bridge.browser, 'chrome');
    assert.deepEqual(detached, [bTab]);
    assert.deepEqual(bridge.tabs.map((t) => t.id), [aTab]);
    a.ws.send(JSON.stringify({ id: aReq.id, result: { ok: true } }));
    assert.deepEqual(await aPending, { ok: true });
    assert.equal((await bridge.listTabs(true)).length, 1);
  } finally { bridge.close(); }
});

test('copied installation identities keep separate browser sessions connected through reconnects', async () => {
  const bridge = new Bridge(0); await bridge.listen();
  try {
    const a = await connectBrowser(bridge, 'copied-profile', 'chrome-session', 'Chrome');
    await publishTabs(bridge, a.ws);
    const aTab = a.info.tabs[0].id;
    const b = await connectBrowser(bridge, 'copied-profile', 'brave-session', 'Brave');
    await publishTabs(bridge, b.ws);
    const bTab = b.info.tabs[0].id;
    assert.equal(bridge.connections().length, 2, 'a copied installation ID must not evict the other browser session');
    assert.notEqual(a.info.id, b.info.id);
    assert.notEqual(aTab, bTab);

    const received = nextRequest(a.ws), pending = bridge.cdp(aTab, 'Page.enable');
    const request = await received;
    const replacement = await connectBrowser(bridge, 'copied-profile', 'brave-session', 'Brave');
    await publishTabs(bridge, replacement.ws);
    assert.equal(replacement.info.id, b.info.id);
    assert.equal(replacement.info.tabs[0].id, bTab);
    assert.equal(bridge.connections().length, 2);
    a.ws.send(JSON.stringify({ id: request.id, result: { source: 'Chrome' } }));
    assert.deepEqual(await pending, { source: 'Chrome' }, 'the other session keeps its in-flight commands');

    const aReplacement = await connectBrowser(bridge, 'copied-profile', 'chrome-session', 'Chrome');
    await publishTabs(bridge, aReplacement.ws);
    assert.equal(aReplacement.info.id, a.info.id);
    assert.equal(aReplacement.info.tabs[0].id, aTab);
    assert.equal(bridge.connectionForTab(bTab)?.id, b.info.id);
    assert.equal(bridge.connections().length, 2);
  } finally { bridge.close(); }
});

test('reconnect replaces only its browser, preserves session ids, and ignores stale sockets', async () => {
  const bridge = new Bridge(0); await bridge.listen();
  try {
    const a = await connectBrowser(bridge, 'chrome'), b = await connectBrowser(bridge, 'brave');
    await publishTabs(bridge, a.ws); await publishTabs(bridge, b.ws);
    const aTab = a.info.tabs[0].id, bTab = b.info.tabs[0].id;
    const oldSocket = (bridge as any).active.get(a.info.id).ws as WebSocket;
    const oldRequest = nextRequest(a.ws), oldPending = bridge.cdp(aTab, 'Page.enable');
    const oldRejected = assert.rejects(oldPending, /connection replaced/);
    await oldRequest;
    const replacement = await connectBrowser(bridge, 'chrome');
    await oldRejected;
    await publishTabs(bridge, replacement.ws);
    assert.equal(replacement.info.id, a.info.id);
    assert.equal(replacement.info.tabs[0].id, aTab);
    assert.equal(bridge.connections().length, 2);
    assert.equal(bridge.connectionForTab(bTab)?.id, b.info.id);

    const message = nextRequest(replacement.ws), pending = bridge.cdp(aTab, 'Page.enable');
    const req = await message;
    // A late transport callback must not answer a request on the replacement socket or publish stale events.
    oldSocket.emit('message', Buffer.from(JSON.stringify({ id: req.id, result: { stale: true } })));
    oldSocket.emit('message', Buffer.from(JSON.stringify({ event: 'tabs', params: [nativeTab(99)] })));
    replacement.ws.send(JSON.stringify({ id: req.id, result: { fresh: true } }));
    assert.deepEqual(await pending, { fresh: true });
    assert.equal(replacement.info.tabs[0].id, aTab);

    const disconnected = new Promise<void>((resolve) => bridge.once('disconnected', () => resolve()));
    replacement.ws.close(); await disconnected;
    const restarted = await connectBrowser(bridge, 'chrome', 'new-browser-session');
    await publishTabs(bridge, restarted.ws);
    assert.notEqual(restarted.info.id, a.info.id);
    assert.notEqual(restarted.info.tabs[0].id, aTab);
    assert.equal(bridge.connectionForTab(aTab), undefined);
    assert.equal(bridge.connectionForTab(bTab)?.id, b.info.id);
  } finally { bridge.close(); }
});

test('bridge rejects malformed identities, tabs, and policies without affecting another browser', async () => {
  const bridge = new Bridge(0); await bridge.listen();
  try {
    const healthy = await connectBrowser(bridge, 'healthy'); await publishTabs(bridge, healthy.ws);
    for (const params of [{ instanceId: {} }, { instanceId: '../escape' }, { browserSessionId: 'orphan' }, { browser: [] }]) {
      const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`); await open(ws);
      const closing = closed(ws); ws.send(hello(params)); assert.equal(await closing, 1003);
    }
    const badTabs = await connectBrowser(bridge, 'bad-tabs');
    const tabsClosed = closed(badTabs.ws);
    badTabs.ws.send(JSON.stringify({ event: 'tabs', params: [{ ...nativeTab(), id: '1' }] }));
    assert.equal(await tabsClosed, 1003);
    const badPolicy = await connectBrowser(bridge, 'bad-policy');
    const policyClosed = closed(badPolicy.ws);
    badPolicy.ws.send(JSON.stringify({ event: 'tools.policy', params: { disabled: [null] } }));
    assert.equal(await policyClosed, 1003);
    assert.equal(bridge.connections().length, 1);
    assert.equal(bridge.connectionForTab(healthy.info.tabs[0].id)?.id, healthy.info.id);
  } finally { bridge.close(); }
});
