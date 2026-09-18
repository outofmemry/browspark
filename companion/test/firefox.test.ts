import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sessions, profileDirFor } from '../src/session.ts';
import type { Bridge } from '../src/bridge.ts';
import { allocateDevTabId } from '../src/cdp.ts';
import { FirefoxDOM } from '../../shared/firefox-dom.ts';
import { firefoxUnsupportedTool } from '../src/firefox-support.ts';
import { decodeBiDiValue, firefoxProxy } from '../src/firefox.ts';

test('BiDi values preserve nested objects and special numbers, and proxy parsing rejects credentials', () => {
  const value = decodeBiDiValue({ type: 'object', value: [['items', { type: 'array', value: [{ type: 'null' }, { type: 'boolean', value: false }, { type: 'number', value: '-0' }] }], ['__proto__', { type: 'string', value: 'ordinary key' }]] });
  assert.deepEqual(value.items.slice(0, 2), [null, false]);
  assert.ok(Object.is(value.items[2], -0));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(value.__proto__, 'ordinary key');
  assert.ok(Number.isNaN(decodeBiDiValue({ type: 'number', value: 'NaN' })));
  assert.deepEqual(firefoxProxy('socks5://127.0.0.1:1080'), { proxyType: 'manual', socksProxy: '127.0.0.1:1080', socksVersion: 5 });
  assert.throws(() => firefoxProxy('http://user:password@localhost:8080'), /without credentials/);
  assert.throws(() => firefoxProxy('file:///tmp/proxy'), /without credentials|supports/);
});

test('Firefox contexts cannot reuse or delete Chromium profiles and retain engine identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browspark-profiles-test-'));
  const original = process.env.BROWSPARK_PROFILES;
  process.env.BROWSPARK_PROFILES = root;
  try {
    const sessions = new Sessions(new EventEmitter() as Bridge);
    const chrome = sessions.devFor('work', 'chromium'), firefox = sessions.devFor('work', 'firefox');
    assert.equal(firefox.browserType, 'firefox');
    assert.notEqual(chrome.profileDir, firefox.profileDir);
    assert.equal(sessions.devFor('work'), firefox);
    for (const browser of [chrome, firefox]) { mkdirSync(browser.profileDir, { recursive: true }); writeFileSync(join(browser.profileDir, 'preserve'), browser.browserType); }
    const contexts = sessions.listContexts().filter(c => c.name === 'work');
    assert.deepEqual(contexts.map(c => c.browser), ['chromium', 'firefox']);
    assert.ok(!sessions.listContexts().some(c => c.name === '.firefox'));
    await sessions.deleteContext('work', 'firefox');
    assert.equal(readFileSync(join(chrome.profileDir, 'preserve'), 'utf8'), 'chromium');
    assert.throws(() => profileDirFor('../work', 'firefox'), /context names/);
    await assert.rejects(sessions.launch('bad', { browser: 'firefox', chromePath: '/bin/false' }), /firefoxPath/);
    await assert.rejects(sessions.launch('bad', { browser: 'chromium', firefoxPath: '/bin/false' }), /requires browser/);
    Object.defineProperty(chrome, 'running', { get: () => true }); sessions.devs.set('work', chrome);
    assert.throws(() => sessions.devFor('work', 'firefox'), /running chromium/);
    assert.ok(allocateDevTabId() < allocateDevTabId());
    assert.ok(allocateDevTabId() >= 2 ** 31);
  } finally { if (original === undefined) delete process.env.BROWSPARK_PROFILES; else process.env.BROWSPARK_PROFILES = original; rmSync(root, { recursive: true, force: true }); }
});

test('Firefox DOM handles stay tab-scoped and become stale on navigation', async () => {
  const calls: any[] = [];
  const dom = new FirefoxDOM(async (tabId, method, params) => { calls.push({ tabId, method, params }); return {}; });
  const first = await dom.handle(1, 'DOM.requestNode', { objectId: 'element' });
  assert.equal((await dom.handle(1, 'DOM.requestNode', { objectId: 'element' })).nodeId, first.nodeId);
  assert.equal((await dom.handle(1, 'DOM.resolveNode', first)).object.objectId, 'element');
  await assert.rejects(dom.handle(2, 'DOM.resolveNode', first), /stale/);
  dom.clear(1);
  await assert.rejects(dom.handle(1, 'DOM.resolveNode', first), /stale/);
  assert.ok((await dom.handle(1, 'DOM.requestNode', { objectId: 'element' })).nodeId > first.nodeId);
  await assert.rejects(dom.handle(1, 'CSS.getMatchedStylesForNode', {}), /unsupported in Firefox/);
  assert.equal(calls.length, 0);
});

test('Firefox does not report empty unsupported debugger data as a successful result', () => {
  for (const name of ['devtools_debugger', 'devtools_memory', 'devtools_coverage', 'devtools_security']) assert.equal(firefoxUnsupportedTool(name, { action: 'list' }), true);
  assert.equal(firefoxUnsupportedTool('devtools_accessibility', { action: 'issues' }), true);
  assert.equal(firefoxUnsupportedTool('devtools_accessibility', { action: 'check' }), false);
  assert.equal(firefoxUnsupportedTool('devtools_sources', { action: 'list', kind: 'scripts' }), true);
  assert.equal(firefoxUnsupportedTool('devtools_sources', { action: 'list', kind: 'frames' }), false);
  assert.equal(firefoxUnsupportedTool('devtools_network', { action: 'search' }), false);
});
