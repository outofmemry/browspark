import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/bridge.ts';
import { allocateDevTabId } from '../src/cdp.ts';
import { Sessions, profileDirFor } from '../src/session.ts';
import { Page } from '../src/page.ts';
import { Capture } from '../src/devtools/capture.ts';
import { combinedPolicy, disabledTools, tabArg, tool, toolCatalog, type Ctx } from '../src/context.ts';
import { registerBrowserTools } from '../src/tools.ts';
import { recorder, registerRecorderTools } from '../src/devtools/recorder.ts';
import { z } from 'zod';
import { PROTOCOL_VERSION } from '../../shared/protocol.ts';

// Exercise the real bridge router without opening a port or starting a browser.
function extension(bridge: Bridge, brand: string, browserEngine: 'chromium' | 'firefox' = 'chromium') {
  const requests: any[] = [];
  const peer = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(raw: string) {
      const request = JSON.parse(raw); requests.push(request);
      peer.emit('message', JSON.stringify({ id: request.id, result: { id: 1 } }));
    },
    close() { peer.readyState = 3; peer.emit('close'); },
  });
  (bridge as any).accept(peer);
  peer.emit('message', JSON.stringify({ event: 'hello', params: { version: PROTOCOL_VERSION, extensionVersion: 'test', instanceId: brand, browserSessionId: 'session', browser: brand, browserEngine } }));
  const info = bridge.connections().find(connection => connection.browser === brand)!;
  const publishTabs = () => {
    peer.emit('message', JSON.stringify({ event: 'tabs', params: [{ id: 1, url: `https://${brand}.test`, title: brand, windowId: 1, shared: true, attached: false }] }));
    return info.tabs[0].id;
  };
  return { info, requests, peer, publishTabs };
}

test('Firefox extension capabilities reject unavailable collections without affecting Chromium tabs', async () => {
  const bridge = new Bridge(0), sessions = new Sessions(bridge), page = new Page(sessions);
  const firefox = extension(bridge, 'firefox', 'firefox'), chrome = extension(bridge, 'chrome');
  const firefoxId = firefox.publishTabs(), chromeId = chrome.publishTabs();
  const previousCatalog = [...toolCatalog];
  const ctx = { sessions, page, server: { registerTool() {} }, client: { id: 'firefox-support', name: 'test', ownedTabs: new Set() }, registry: new Map() } as unknown as Ctx;
  const called: number[] = [];
  try {
    assert.equal((await sessions.tabs()).find(t => t.id === firefoxId)?.browser, 'firefox');
    assert.equal(bridge.connectionForTab(firefoxId)?.browserEngine, 'firefox');
    assert.equal((page.overlay as any).enabledFor(firefoxId), true);
    assert.equal((page.overlay as any).isFirefoxExtension(firefoxId), true);
    assert.equal((page.overlay as any).isFirefoxExtension(chromeId), false);
    firefox.info.policy = { disabled: [], overlay: false };
    assert.equal((page.overlay as any).enabledFor(firefoxId), false);
    delete firefox.info.policy;
    for (const name of ['devtools_console', 'devtools_network', 'browser_upload', 'browser_click']) {
      tool(ctx, name, 'extension capability regression', { tabId: tabArg, hover: z.boolean().optional() }, async ({ tabId }) => { called.push(tabId!); return 'supported'; });
      const args = { tabId: firefoxId, ...(name === 'browser_click' && { hover: true }) };
      const result = await ctx.registry.get(name)!(args);
      assert.equal(result.isError, true);
      assert.match((result.content[0] as { text: string }).text, /unsupported in the Firefox extension/);
      assert.ok(!(await ctx.registry.get(name)!({ tabId: chromeId })).isError);
    }
    assert.deepEqual(called, [chromeId, chromeId, chromeId, chromeId]);
    assert.ok(!(await ctx.registry.get('browser_click')!({ tabId: firefoxId })).isError);
  } finally { bridge.close(); toolCatalog.splice(0, toolCatalog.length, ...previousCatalog); }
});

test('browser profiles isolate four brands while Chrome retains the Chromium profile alias', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browspark-multi-profiles-'));
  const oldProfiles = process.env.BROWSPARK_PROFILES, oldProfile = process.env.BROWSPARK_PROFILE;
  process.env.BROWSPARK_PROFILES = root; process.env.BROWSPARK_PROFILE = join(root, 'legacy-default');
  try {
    const sessions = new Sessions(new Bridge(0));
    const brands = ['chrome', 'brave', 'firefox', 'zen'] as const;
    assert.equal(profileDirFor('default', 'chrome'), process.env.BROWSPARK_PROFILE);
    assert.equal(profileDirFor('work', 'chrome'), profileDirFor('work', 'chromium'));
    assert.equal(new Set(brands.map(brand => profileDirFor('work', brand))).size, 4);
    for (const brand of brands) {
      const directory = profileDirFor('work', brand);
      mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'keep'), brand);
      assert.equal(sessions.devFor(`${brand}-work`, brand).browserName, brand);
    }
    const contexts = sessions.listContexts().filter(context => context.name === 'work');
    assert.deepEqual(contexts.map(context => context.browser), ['chromium', 'brave', 'firefox', 'zen']);
    assert.ok(!sessions.listContexts().some(context => context.name.startsWith('.')));
    await sessions.deleteContext('work', 'firefox');
    for (const brand of ['chrome', 'brave', 'zen'] as const) assert.equal(readFileSync(join(profileDirFor('work', brand), 'keep'), 'utf8'), brand);
    assert.throws(() => profileDirFor('../escape', 'zen'), /context names/);
  } finally {
    if (oldProfiles === undefined) delete process.env.BROWSPARK_PROFILES; else process.env.BROWSPARK_PROFILES = oldProfiles;
    if (oldProfile === undefined) delete process.env.BROWSPARK_PROFILE; else process.env.BROWSPARK_PROFILE = oldProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test('starting and stopping browsers reserve their context and shared profile alias', async () => {
  const sessions = new Sessions(new Bridge(0)), chrome = sessions.devFor('work', 'chrome');
  Object.defineProperty(chrome, 'busy', { get: () => true });
  assert.equal(chrome.running, false);
  assert.throws(() => sessions.devFor('work', 'firefox'), /close it first/);
  assert.throws(() => sessions.devFor('work', 'brave'), /close it first/);
  await assert.rejects(sessions.deleteContext('work', 'chrome'), /close it first/);
  await assert.rejects(sessions.deleteContext('work', 'chromium'), /close it first/);
  assert.equal(sessions.devs.get('work'), chrome);
  assert.equal(sessions.devFor('other', 'zen').browserName, 'zen');
});

test('tab creation routes explicit developer contexts and extension browsers, rejecting ambiguity', async () => {
  const bridge = new Bridge(0), sessions = new Sessions(bridge);
  const opened: string[] = [];
  const chrome = sessions.devFor('chrome-work', 'chrome'), zen = sessions.devFor('zen-work', 'zen');
  for (const browser of [chrome, zen]) {
    Object.defineProperty(browser, 'running', { get: () => true });
    browser.newTab = async (url = 'about:blank') => { opened.push(`${browser.name}:${url}`); return allocateDevTabId(); };
  }
  await assert.rejects(sessions.newTab('https://example.test', 'dev'), /context is required/);
  await assert.rejects(sessions.newTab('https://example.test'), /context is required/);
  const extChrome = extension(bridge, 'chrome'), extBrave = extension(bridge, 'brave');
  try {
    await sessions.newTab('https://zen.test', undefined, 'zen-work');
    assert.deepEqual(opened, ['zen-work:https://zen.test']);
    assert.equal(extChrome.requests.length + extBrave.requests.length, 0);
    const chromeId = await sessions.newTab('https://chrome.test', undefined, undefined, false, extChrome.info.id);
    const braveId = await sessions.newTab('https://brave.test', 'extension', undefined, true, extBrave.info.id);
    assert.notEqual(chromeId, braveId);
    assert.equal(bridge.connectionForTab(chromeId)?.id, extChrome.info.id);
    assert.equal(bridge.connectionForTab(braveId)?.id, extBrave.info.id);
    assert.deepEqual(extChrome.requests.map(request => request.params), [{ url: 'https://chrome.test', active: false }]);
    assert.deepEqual(extBrave.requests.map(request => request.params), [{ url: 'https://brave.test', active: true }]);
    await assert.rejects(sessions.newTab('https://example.test'), /browserId is required/);
    await assert.rejects(sessions.newTab('https://example.test', 'extension', 'zen-work'), /context requires/);
    await assert.rejects(sessions.newTab('https://example.test', 'dev', undefined, true, extBrave.info.id), /browserId requires/);
    await assert.rejects(sessions.newTab('https://example.test', undefined, 'zen-work', true, extBrave.info.id), /not both/);
    await assert.rejects(sessions.newTab('https://example.test', undefined, 'missing'), /not running/);
    await assert.rejects(sessions.newTab('https://example.test', undefined, undefined, true, 'ext:missing'), /not connected/);
    extChrome.peer.close();
    await assert.rejects(sessions.newTab('https://example.test', undefined, ''), /context names/);
    await assert.rejects(sessions.newTab('https://example.test', undefined, undefined, true, ''), /browserId must/);
    await assert.rejects(bridge.request('tabs.create', {}, undefined, ''), /not connected/);
    const remaining = await sessions.newTab('https://only-browser.test');
    assert.equal(bridge.connectionForTab(remaining)?.id, extBrave.info.id);
  } finally { bridge.close(); }
});

test('closeAll includes browsers still starting and continues after a shutdown failure', async () => {
  const sessions = new Sessions(new Bridge(0)), closed: string[] = [];
  for (const brand of ['brave', 'firefox', 'zen'] as const) {
    const browser = sessions.devFor(brand, brand);
    Object.defineProperty(browser, 'busy', { get: () => brand !== 'zen' });
    assert.equal(browser.running, false);
    browser.close = async () => { closed.push(brand); if (brand === 'brave') throw new Error('shutdown failed'); };
  }
  await sessions.closeAll();
  assert.deepEqual(closed, ['brave', 'firefox']);
});

test('disconnecting one browser clears only its dialogs, captures, and overlay state', async () => {
  const bridge = new Bridge(0), sessions = new Sessions(bridge), page = new Page(sessions), capture = new Capture(sessions);
  const chrome = extension(bridge, 'chrome'), brave = extension(bridge, 'brave');
  const chromeId = chrome.publishTabs(), braveId = brave.publishTabs(), zenId = allocateDevTabId();
  const zen = sessions.devFor('zen-work', 'zen');
  Object.defineProperty(zen, 'running', { get: () => true });
  (zen as any).tabs.set(zenId, { id: zenId, targetId: 'zen-context', url: 'https://zen.test', title: 'Zen', type: 'page' });
  zen.cdp = async () => ({}) as any;
  const pageState = page as any, overlay = page.overlay as any;
  try {
    for (const id of [chromeId, braveId, zenId]) {
      await capture.start(id);
      page.dialogs.set(id, { type: 'alert', message: String(id) });
      pageState.enabled.add(id); pageState.lastSnapshot.set(id, 'snapshot');
      overlay.installed.add(id); overlay.contexts.set(id, id); overlay.frames.set(id, `frame-${id}`); overlay.lastBeat.set(id, Date.now());
    }
    const retained = (id: number, value: boolean) => {
      assert.equal(page.dialogs.has(id), value); assert.equal(pageState.enabled.has(id), value); assert.equal(pageState.lastSnapshot.has(id), value);
      assert.equal(capture.require(id).active, value);
      for (const key of ['installed', 'contexts', 'frames', 'lastBeat']) assert.equal(overlay[key].has(id), value, `${key} for ${id}`);
    };
    chrome.peer.close();
    retained(chromeId, false); retained(braveId, true); retained(zenId, true);
    zen.emit('detached', { tabId: zenId, reason: 'browser closed' }); zen.emit('closed');
    retained(zenId, false); retained(braveId, true);
  } finally { bridge.close(); }
});

test('combined restrictions preserve stricter global settings and scope tools to the selected browser', async () => {
  const bridge = new Bridge(0), sessions = new Sessions(bridge), page = new Page(sessions), capture = new Capture(sessions);
  const chrome = extension(bridge, 'chrome'), brave = extension(bridge, 'brave');
  const chromeId = chrome.publishTabs(), braveId = brave.publishTabs();
  chrome.info.policy = { disabled: ['browser_click', 'browser_fetch', 'browser_status'], devMode: 'never', overlay: false };
  brave.info.policy = { disabled: [], devMode: 'always', overlay: true };
  const policy = combinedPolicy([chrome.info.policy, brave.info.policy]);
  assert.deepEqual(policy, { disabled: ['browser_click', 'browser_fetch', 'browser_status'], devMode: 'never', overlay: false });
  assert.equal(combinedPolicy([{ disabled: [], devMode: 'always' }, { disabled: [] }]).devMode, 'auto');
  assert.equal(combinedPolicy([{ disabled: [], devMode: 'always' }]).devMode, 'always');
  const previousDisabled = [...disabledTools], previousCatalog = [...toolCatalog];
  disabledTools.clear(); for (const name of policy.disabled) disabledTools.add(name);
  const ctx = { sessions, page, capture, server: { registerTool() {} }, client: { id: 'multi-session-policy', name: 'test', ownedTabs: new Set([braveId]) }, registry: new Map() } as unknown as Ctx;
  try {
    tool(ctx, 'browser_click', 'policy check', { tabId: tabArg }, async ({ tabId }) => ({ tabId: await sessions.resolve(tabId) }));
    tool(ctx, 'browser_fetch', 'policy check', { browserId: z.string().optional() }, async ({ browserId }) => ({ browserId }));
    tool(ctx, 'browser_status', 'policy check', {}, async () => 'status');
    const click = ctx.registry.get('browser_click')!;
    assert.equal((await click({ tabId: chromeId })).isError, true);
    assert.ok(!(await click({ tabId: braveId })).isError);
    const implicit = await click({});
    assert.ok(!implicit.isError, JSON.stringify(implicit));
    assert.deepEqual(JSON.parse((implicit.content[0] as { text: string }).text), { tabId: braveId });
    assert.equal((await ctx.registry.get('browser_fetch')!({ browserId: chrome.info.id })).isError, true);
    assert.ok(!(await ctx.registry.get('browser_fetch')!({ browserId: brave.info.id })).isError);
    assert.equal((await ctx.registry.get('browser_fetch')!({})).isError, true);
    assert.equal((await ctx.registry.get('browser_status')!({ browserId: brave.info.id })).isError, true);
    assert.equal((page.overlay as any).enabledFor(chromeId), false);
    page.overlay.enabled = false;
    assert.equal((page.overlay as any).enabledFor(braveId), true);
  } finally {
    disabledTools.clear(); for (const name of previousDisabled) disabledTools.add(name);
    toolCatalog.splice(0, toolCatalog.length, ...previousCatalog);
    bridge.close();
  }
});

test('global status and recorder export do not resolve a page before their early returns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browspark-global-tools-')), originalArtifacts = process.env.BROWSPARK_ARTIFACTS;
  const previousDisabled = [...disabledTools], previousCatalog = [...toolCatalog];
  const flowId = 'multi-session-export-check', previousFlow = recorder.flows.get(flowId);
  process.env.BROWSPARK_ARTIFACTS = root; disabledTools.clear();
  const sessions = new Sessions(new Bridge(0)), page = new Page(sessions), capture = new Capture(sessions);
  let resolutions = 0;
  sessions.resolve = async () => { resolutions++; throw new Error('No page should be needed'); };
  const ctx = { sessions, page, capture, server: { registerTool() {} }, client: { id: 'global-check', name: 'test', ownedTabs: new Set() }, registry: new Map() } as unknown as Ctx;
  try {
    registerBrowserTools(ctx); registerRecorderTools(ctx);
    recorder.flows.set(flowId, { id: flowId, name: flowId, createdAt: new Date().toISOString(), params: [], steps: [] });
    for (const [name, args] of [
      ['browser_status', {}], ['browser_session', { action: 'status' }], ['browser_session', { action: 'contexts' }],
      ['browser_policy', { action: 'status' }], ['devtools_recorder', { action: 'status' }],
      ['devtools_recorder', { action: 'get', flowId }], ['devtools_recorder', { action: 'export', flowId, format: 'playwright' }],
    ] as const) {
      const result = await ctx.registry.get(name)!({ ...args });
      assert.ok(!result.isError, `${name}: ${JSON.stringify(result)}`);
    }
    assert.equal(resolutions, 0);
  } finally {
    if (originalArtifacts === undefined) delete process.env.BROWSPARK_ARTIFACTS; else process.env.BROWSPARK_ARTIFACTS = originalArtifacts;
    disabledTools.clear(); for (const name of previousDisabled) disabledTools.add(name);
    toolCatalog.splice(0, toolCatalog.length, ...previousCatalog);
    if (previousFlow) recorder.flows.set(flowId, previousFlow); else recorder.flows.delete(flowId);
    rmSync(root, { recursive: true, force: true });
  }
});
