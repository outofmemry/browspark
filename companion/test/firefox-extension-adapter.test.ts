import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { createFirefoxDebugger } from '../../extension/shared/src/firefox-debugger.ts';

test('Firefox extension evaluates in API-free worlds and scopes live objects to their tab, world and document', async () => {
  const shared = new Set([1, 2]);
  const worlds = new Map<string, ReturnType<typeof createContext>>();
  const configurations: any[] = [], injections: any[] = [], native: any[] = [], events: any[] = [];
  let updated!: (tabId: number, change: any) => void, removed!: (tabId: number) => void;
  const api = {
    storage: { secret: 'must never reach evaluated code' },
    runtime: { sendMessage: () => { throw new Error('Extension messaging must never be exposed'); } },
    userScripts: {
      configureWorld: async (details: any) => { configurations.push(details); },
      execute: async (injection: any) => {
        injections.push(injection);
        const id = `${injection.target.tabId}:${injection.worldId}`;
        let world = worlds.get(id);
        if (!world) { world = createContext({ Node: class Node {} }); runInContext('globalThis.window = globalThis', world); worlds.set(id, world); }
        return [{ frameId: 0, result: await runInContext(injection.js[0].code, world) }];
      },
    },
    tabs: {
      get: async (tabId: number) => ({ id: tabId, url: 'about:blank', windowId: 1 }),
      update: async (tabId: number, details: any) => { native.push(['update', tabId, details]); return { windowId: 1 }; },
      captureTab: async (tabId: number, details: any) => { native.push(['capture', tabId, details]); return 'data:image/png;base64,aGVsbG8='; },
      goBack: async (tabId: number) => { native.push(['back', tabId]); },
      goForward: async (tabId: number) => { native.push(['forward', tabId]); },
      onUpdated: { addListener: (fn: typeof updated) => { updated = fn; } },
      onRemoved: { addListener: (fn: typeof removed) => { removed = fn; } },
    },
  };
  const debuggerAPI = createFirefoxDebugger(api, id => shared.has(id));
  const cdp = (tabId: number, method: string, params?: any) => debuggerAPI.sendCommand({ tabId }, method, params);
  debuggerAPI.onEvent.addListener((target, method, params) => events.push({ target, method, params }));
  await debuggerAPI.attach({ tabId: 1 }); await debuggerAPI.attach({ tabId: 2 });
  await cdp(1, 'Runtime.enable'); await cdp(1, 'Page.enable'); await cdp(1, 'Page.getFrameTree');
  assert.equal(injections.length, 0, 'blank tabs must be navigable before scripts can run');
  await cdp(1, 'Page.navigate', { url: 'https://example.test/' });
  assert.deepEqual(native[0], ['update', 1, { url: 'https://example.test/' }]);
  await assert.rejects(cdp(1, 'Page.navigate', { url: 'javascript:alert(1)' }), /Not allowed/);
  await assert.rejects(cdp(1, 'Page.navigate', { url: 'file:///tmp/private' }), /Not allowed/);
  for (const params of [{ type: 'mouseWheel' }, { type: 'mousePressed', button: 'right' }, { type: 'mouseReleased', clickCount: 2 }, { type: 'mouseMoved', buttons: 1 }]) await assert.rejects(cdp(1, 'Input.dispatchMouseEvent', { x: 1, y: 1, ...params }), /unsupported/);
  const result = await cdp(1, 'Runtime.evaluate', { expression: `({ browser: typeof browser, chrome: typeof chrome, constructorBrowser: Function('return typeof browser')() })`, returnByValue: true });
  assert.deepEqual(result.result.value, { browser: 'undefined', chrome: 'undefined', constructorBrowser: 'undefined' });
  assert.ok(configurations.every(config => config.messaging === false));
  assert.ok(injections.every(injection => injection.world === 'USER_SCRIPT' && injection.target.frameIds.length === 1 && injection.target.frameIds[0] === 0));
  const first = await cdp(1, 'Runtime.evaluate', { expression: '({count: 2})' });
  const call = await cdp(1, 'Runtime.callFunctionOn', { objectId: first.result.objectId, functionDeclaration: 'function(value) { this.count += value; return this.count; }', arguments: [{ value: 3 }], returnByValue: true });
  assert.equal(call.result.value, 5);
  assert.match((await cdp(2, 'Runtime.getProperties', { objectId: first.result.objectId })).exceptionDetails.text, /stale/);
  const isolated = await cdp(1, 'Page.createIsolatedWorld', { frameId: '1', worldName: 'test' });
  const second = await cdp(1, 'Runtime.evaluate', { contextId: isolated.executionContextId, expression: '({count: 7})' });
  assert.notEqual(first.result.objectId, second.result.objectId);
  assert.equal((await cdp(1, 'Runtime.callFunctionOn', { objectId: second.result.objectId, functionDeclaration: 'function() { return this.count; }', returnByValue: true })).result.value, 7);
  await cdp(1, 'Runtime.releaseObject', { objectId: first.result.objectId });
  assert.match((await cdp(1, 'Runtime.getProperties', { objectId: first.result.objectId })).exceptionDetails.text, /stale/);
  updated(1, { status: 'loading', url: 'https://example.test/next' });
  assert.match((await cdp(1, 'Runtime.getProperties', { objectId: second.result.objectId })).exceptionDetails.text, /stale/);
  updated(1, { status: 'complete' });
  assert.ok(events.some(event => event.method === 'Page.loadEventFired'));
  await cdp(1, 'Runtime.evaluate', { expression: 'window.__bmcp = {marker: 1}' });
  const detachEvents: any[] = [];
  debuggerAPI.onDetach.addListener((target, reason) => detachEvents.push({ target, reason }));
  await debuggerAPI.detach({ tabId: 1 }); await debuggerAPI.attach({ tabId: 1 });
  assert.equal(detachEvents.length, 0);
  assert.equal((await cdp(1, 'Runtime.evaluate', { expression: 'window.__bmcp.marker', returnByValue: true })).result.value, 1, 'idle reattachment preserves refs');
  await debuggerAPI.detach({ tabId: 1 }); updated(1, { status: 'loading' }); updated(1, { status: 'complete' }); await debuggerAPI.attach({ tabId: 1 });
  assert.equal((await cdp(1, 'Runtime.evaluate', { expression: 'typeof window.__bmcp', returnByValue: true })).result.value, 'undefined', 'BFCache navigation while detached invalidates refs');
  const screenshot = await cdp(1, 'Page.captureScreenshot', { clip: { x: 1, y: 2, width: 20, height: 30, scale: 1 } });
  assert.equal(screenshot.data, 'aGVsbG8=');
  assert.deepEqual(native.at(-1), ['capture', 1, { format: 'png', rect: { x: 1, y: 2, width: 20, height: 30 }, scale: 1 }]);
  await cdp(1, 'Page.traverseHistory', { delta: -1 }); assert.deepEqual(native.at(-1), ['back', 1]);
  for (const method of ['Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument', 'Network.enable', 'Page.handleJavaScriptDialog', 'DOM.setFileInputFiles']) await assert.rejects(cdp(1, method), /unsupported/);
  const injectionCount = injections.length;
  const pendingEvaluation = cdp(1, 'Runtime.evaluate', { expression: 'globalThis.unwanted = true' });
  await debuggerAPI.detach({ tabId: 1 });
  await assert.rejects(pendingEvaluation, /attachment changed/);
  assert.equal(injections.length, injectionCount, 'detach while awaiting world readiness must prevent script injection');
  await debuggerAPI.attach({ tabId: 1 });
  let finishCapture!: (dataUrl: string) => void;
  api.tabs.captureTab = () => new Promise(resolve => { finishCapture = resolve; });
  const pendingScreenshot = cdp(1, 'Page.captureScreenshot');
  await debuggerAPI.detach({ tabId: 1 }); await debuggerAPI.attach({ tabId: 1 });
  finishCapture('data:image/png;base64,cHJpdmF0ZQ==');
  await assert.rejects(pendingScreenshot, /attachment changed/);
  shared.delete(1);
  await assert.rejects(cdp(1, 'Runtime.evaluate', { expression: '1' }), /Not allowed/);
  await assert.rejects(debuggerAPI.attach({ tabId: 1 }), /Not allowed/);
  removed(2); await assert.rejects(cdp(2, 'Page.enable'), /not attached/);
  assert.equal(detachEvents.length, 1);
});
