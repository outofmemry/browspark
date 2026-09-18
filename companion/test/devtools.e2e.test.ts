// End-to-end developer tooling scenarios, in extension mode plus a developer-mode block.
// Run with: E2E=1 bun test
import { describe, test, beforeAll, afterAll, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { startTestServer } from '../../test-apps/server.ts';
import { launchExtensionChrome, startCompanion, callers, pairAndShare, dashboard, ROOT, type Ext } from './harness.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const skip = !process.env.E2E;
let ext: Ext, http: Server, appUrl: string, tabId: number, nativeTabId: number;
let call: ReturnType<typeof callers>['call'], ok: ReturnType<typeof callers>['ok'], okJson: ReturnType<typeof callers>['okJson'];
let client: Awaited<ReturnType<typeof startCompanion>>;
const appSrc = readFileSync(join(ROOT, 'test-apps/src/app.ts'), 'utf8').split('\n');
const lineOf = (needle: string) => appSrc.findIndex((l) => l.includes(needle)) + 1;
const refOf = (snap: string, re: RegExp) => { const m = re.exec(snap); assert.ok(m, `no ref for ${re}`); return m![1]; };
const clickBtn = async (name: string) => { const snap = await ok('browser_snapshot', { tabId }); return ok('browser_click', { tabId, ref: refOf(snap, new RegExp(`button "${name}"[^\\n]*\\[ref=(e\\d+)\\]`)) }); };
const supported = async (domain: string) => { const caps = await okJson('devtools_capabilities', { tabId }); return String(caps.domains[domain]).startsWith('supported'); };

describe.skipIf(skip)('devtools e2e (extension mode)', () => {
  beforeAll(async () => {
    spawnSync('bun', ['build', 'test-apps/src/app.ts', '--outdir', 'test-apps/dist', '--sourcemap=linked', '--format=iife'], { cwd: ROOT });
    ({ server: http, url: appUrl } = await startTestServer(join(ROOT, 'test-apps')));
    ext = await launchExtensionChrome();
    client = await startCompanion();
    ({ call, ok, okJson } = callers(client));
    await ext.cdp.send('Target.createTarget', { url: appUrl + 'debug.html' });
    tabId = await pairAndShare(ext, ok, appUrl + 'debug.html');
    nativeTabId = (await (await dashboard(ext))({ type: 'getState' })).tabs.find((t: any) => t.url === appUrl + 'debug.html').id;
    await ok('devtools_session', { action: 'start', tabId, bodies: true });
  }, 120_000);
  afterAll(async () => { await call('devtools_session', { action: 'stop', tabId }).catch(() => {}); await client?.close().catch(() => {}); await ext?.cleanup(); http?.close(); }, 30_000);
  // never leave the page paused for the next test if an assertion fails mid-scenario
  afterEach(async () => { await call('devtools_debugger', { tabId, action: 'remove', all: true }).catch(() => {}); await call('devtools_debugger', { tabId, action: 'exceptions', state: 'none' }).catch(() => {}); await call('devtools_debugger', { tabId, action: 'resume' }).catch(() => {}); });

  test('capabilities and session status', async () => {
    const caps = await okJson('devtools_capabilities', { tabId });
    assert.equal(caps.mode, 'extension');
    assert.ok(caps.domains.Runtime.startsWith('supported') && caps.domains.Network.startsWith('supported') && caps.domains.Debugger.startsWith('supported'));
    const st = await okJson('devtools_session', { action: 'status', tabId });
    assert.equal(st.active, true); assert.equal(st.options.bodies, true);
  });

  test('scenario 1: console error with stack mapped to original source', async () => {
    await clickBtn('Log');
    const logs = await okJson('devtools_console', { tabId, query: 'hello from app' });
    assert.equal(logs.items.length, 1); assert.ok(logs.items[0].objects?.[0]?.objectId, 'logged object should be inspectable');
    const obj = await okJson('devtools_console', { tabId, action: 'inspect', objectId: logs.items[0].objects[0].objectId, depth: 2 });
    assert.equal(obj.user, 'ada', JSON.stringify(obj)); assert.deepEqual(obj.nested, { deep: 'true' }, JSON.stringify(obj)); assert.deepEqual(obj.tags, ['x', 'y'], JSON.stringify(obj));
    await clickBtn('Error');
    const errs = await okJson('devtools_console', { tabId, action: 'wait', level: ['error'], kind: ['exception'], query: 'Boom', timeoutMs: 5000 });
    assert.match(errs.text, /Boom: button/); assert.ok(errs.stack?.some((f: string) => /explode/.test(f) && /app\.js/.test(f)), JSON.stringify(errs.stack));
    const top = /app\.js:(\d+):(\d+)/.exec(errs.stack.find((f: string) => /explode/.test(f)))!;
    const orig = await okJson('devtools_sources', { tabId, action: 'map', url: 'dist/app.js', line: Number(top[1]), column: Number(top[2]) });
    assert.match(orig.source, /src\/app\.ts$/); assert.equal(orig.line, lineOf("throw new Error('Boom: '"));
    const warn = await okJson('devtools_console', { tabId, level: ['warning'] }); assert.ok(warn.items.some((m: any) => m.text === 'careful'));
  });

  test('capability probes preserve active profiling and emulation reset restores overrides', async () => {
    const timezone = (await okJson('devtools_evaluate', { tabId, expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone' })).value;
    const animations = await supported('Animation');
    try {
      await ok('devtools_emulation', { tabId, action: 'media', colorScheme: 'dark' });
      await ok('devtools_emulation', { tabId, action: 'locale', locale: 'fr-FR', timezone: 'Pacific/Honolulu' });
      if (animations) await ok('devtools_emulation', { tabId, action: 'animations', playbackRate: 0 });
      await ok('devtools_profile', { tabId, action: 'start' });
      await ok('devtools_capabilities', { tabId, refresh: true });
      assert.equal((await okJson('devtools_evaluate', { tabId, expression: 'matchMedia("(prefers-color-scheme: dark)").matches' })).value, true);
      assert.equal((await okJson('devtools_evaluate', { tabId, expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone' })).value, 'Pacific/Honolulu');
      const profile = await okJson('devtools_profile', { tabId, action: 'stop' });
      assert.ok(existsSync(profile.artifact), 'capability probes leave the active CPU profile intact');
      await ok('devtools_emulation', { tabId, action: 'reset' });
      if (animations) assert.equal((await okJson('devtools_emulation', { tabId, action: 'animations' })).playbackRate, 1);
      assert.equal((await okJson('devtools_evaluate', { tabId, expression: 'Intl.DateTimeFormat().resolvedOptions().timeZone' })).value, timezone);
      assert.deepEqual(await okJson('devtools_emulation', { tabId, action: 'status' }), {});
    } finally {
      await call('devtools_profile', { tabId, action: 'stop' });
      await call('devtools_emulation', { tabId, action: 'reset' });
    }
  });

  test('scenario 2: failing request, payload, body search, mock', async () => {
    await clickBtn('Fetch 404');
    await ok('browser_wait', { tabId, text: '404 {"error"' });
    const s = await okJson('devtools_network', { tabId, status: '4xx' });
    const miss = s.items.find((r: any) => r.url.includes('/api/missing')); assert.ok(miss, JSON.stringify(s));
    const full = await okJson('devtools_network', { tabId, action: 'get', requestId: miss.id });
    assert.equal(full.responseHeaders['content-type'], 'application/json'); assert.ok(full.timing);
    const body = await okJson('devtools_network', { tabId, action: 'body', requestId: miss.id });
    assert.match(body.text, /"error": "not found"/);
    const inBody = await okJson('devtools_network', { tabId, query: 'not found', searchIn: ['body'] }); assert.ok(inBody.items.some((r: any) => r.id === miss.id));
    await clickBtn('Fetch POST');
    await ok('browser_wait', { tabId, text: '"method":"POST"' });
    const post = (await okJson('devtools_network', { tabId, method: 'POST' })).items[0]; const pf = await okJson('devtools_network', { tabId, action: 'get', requestId: post.id }); assert.match(pf.postData, /"q":"hi"/);
    await ok('devtools_network', { tabId, action: 'mock', pattern: '*/api/missing*', response: { status: 200, json: { ok: true, mocked: true } } });
    await clickBtn('Fetch 404');
    await ok('browser_wait', { tabId, text: '200 {"ok":true,"mocked":true}' });
    const rules = await okJson('devtools_network', { tabId, action: 'rules' }); assert.equal(rules.rules.length, 1);
    const mocked = (await okJson('devtools_network', { tabId, query: '/api/missing' })).items.at(-1); assert.equal(mocked.mocked, true);
    await ok('devtools_network', { tabId, action: 'unmock' });
    const replay = await okJson('devtools_network', { tabId, action: 'replay', requestId: miss.id }); assert.equal(replay.status, 404);
    const har = await ok('devtools_network', { tabId, action: 'har' }); const harPath = /to (\S+\.har)/.exec(har)![1]; assert.ok(existsSync(harPath)); assert.ok(JSON.parse(readFileSync(harPath, 'utf8')).log.entries.length > 3);
    await clickBtn('WebSocket');
    await ok('browser_wait', { tabId, text: 'ws pong:ping' });
    const ws = (await okJson('devtools_network', { tabId, type: ['WebSocket'] })).items[0]; assert.ok(ws, 'websocket logged');
    const frames = await okJson('devtools_network', { tabId, action: 'frames', requestId: ws.id }); assert.ok(frames.items.some((f: any) => f.dir === 'sent' && f.payload === 'ping') && frames.items.some((f: any) => f.dir === 'received'));
    await ok('devtools_network', { tabId, action: 'block', patterns: ['*/api/slow*'] });
    const blocked = await ok('devtools_evaluate', { tabId, expression: "fetch('/api/slow').then(r => 'ok:' + r.status, e => 'blocked:' + e.message)" }); assert.match(blocked, /blocked/);
    await ok('devtools_network', { tabId, action: 'unblock' });
  });

  test('scenario 3: search source-mapped app, breakpoint in original code, inspect, step', async () => {
    const list = await okJson('devtools_sources', { tabId, action: 'list', kind: 'scripts', url: 'app.js' });
    assert.ok(list.scripts.items.some((s: any) => s.sourceMap));
    const found = await okJson('devtools_sources', { tabId, action: 'search', query: 'slowFunction', kind: 'scripts', original: true });
    assert.ok(found.items.some((h: any) => h.original?.includes('src/app.ts')), JSON.stringify(found.items.slice(0, 3)));
    const sm = await okJson('devtools_sources', { tabId, action: 'sourcemap', url: 'dist/app.js' }); assert.ok(sm.sources.some((s: string) => s.endsWith('src/app.ts')));
    const original = await okJson('devtools_sources', { tabId, action: 'get', original: true, source: 'src/app.ts', fromLine: 1, toLine: 12 }); assert.match(original.text, /export function slowFunction/);
    const bpLine = lineOf('while (performance.now() - start < iterations)');
    const bp = await okJson('devtools_debugger', { tabId, action: 'set', source: 'src/app.ts', line: bpLine });
    assert.ok(bp.breakpointId && bp.resolvedLocations.length, JSON.stringify(bp));
    const clicked = await clickBtn('Slow'); assert.match(clicked, /paused/);
    const stack = await okJson('devtools_debugger', { tabId, action: 'stack' });
    assert.equal(stack.paused, true); assert.equal(stack.frames[0].functionName, 'slowFunction'); assert.match(stack.frames[0].original, /src\/app\.ts:\d+/);
    const vars = await okJson('devtools_debugger', { tabId, action: 'variables' }); const scopeWithIt = Object.values(vars).find((v: any) => v && typeof v === 'object' && 'iterations' in v) as any; assert.ok(scopeWithIt, JSON.stringify(vars)); assert.equal(scopeWithIt.iterations, '300');
    const ev = await okJson('devtools_debugger', { tabId, action: 'evaluate', expression: 'iterations * 2' }); assert.equal(ev['iterations * 2'], '600');
    await ok('devtools_debugger', { tabId, action: 'setVariable', name: 'iterations', expression: '5' });
    const step = await okJson('devtools_debugger', { tabId, action: 'stepOver', timeoutMs: 10000 }); assert.equal(step.paused, true, JSON.stringify(step));
    await ok('devtools_debugger', { tabId, action: 'remove', all: true });
    await ok('devtools_debugger', { tabId, action: 'resume' });
    await ok('browser_wait', { tabId, text: 'slow done', timeoutMs: 5000 });
    await ok('devtools_debugger', { tabId, action: 'exceptions', state: 'all' });
    assert.match(await clickBtn('Error'), /paused/);
    const ex = await okJson('devtools_debugger', { tabId, action: 'stack' }); assert.equal(ex.reason, 'exception');
    await ok('devtools_debugger', { tabId, action: 'resume' }); await ok('devtools_debugger', { tabId, action: 'exceptions', state: 'none' });
    const paused = await okJson('devtools_events', { tabId, method: 'Debugger.paused' }); assert.ok(paused.events.length >= 2);
  });

  test('scenario 4: resource override, reload, verify, revert', async () => {
    const src = readFileSync(join(ROOT, 'test-apps/dist/app.js'), 'utf8').replace('app ready', 'app overridden');
    await ok('devtools_sources', { tabId, action: 'override', url: '*/dist/app.js', body: src, reload: true });
    const c1 = await okJson('devtools_console', { tabId, action: 'wait', query: 'app overridden', timeoutMs: 5000 }); assert.match(c1.text, /app overridden/);
    const ov = await okJson('devtools_sources', { tabId, action: 'overrides' }); assert.equal(ov.length, 1);
    const req = (await okJson('devtools_network', { tabId, query: 'dist/app.js' })).items.at(-1); assert.equal(req.overridden, 'override');
    await ok('devtools_sources', { tabId, action: 'revert', reload: true });
    await new Promise((r) => setTimeout(r, 300));
    const after = await okJson('devtools_console', { tabId, query: 'app ready' }); assert.ok(after.items.length >= 1);
    assert.equal((await okJson('devtools_sources', { tabId, action: 'overrides' })).length, 0);
  });

  test('scenario 8: elements, CSS edit, computed layout, mobile viewport', async () => {
    const s = await okJson('devtools_elements', { tabId, action: 'search', query: '#out' }); assert.equal(s.items.length, 1); const ref = s.items[0].ref;
    assert.equal((await okJson('devtools_elements', { tabId, action: 'computed', ref, properties: ['color'] })).color, 'rgb(0, 128, 0)');
    await ok('devtools_elements', { tabId, action: 'styles', ref, property: 'color', value: 'red' });
    assert.equal((await okJson('devtools_elements', { tabId, action: 'computed', ref, properties: ['color'] })).color, 'rgb(255, 0, 0)');
    const styles = await okJson('devtools_elements', { tabId, action: 'styles', ref }); assert.ok(styles.matched.some((r: any) => r.selector === '#out')); assert.ok(styles.inline.includes('color: red'));
    const box = await okJson('devtools_elements', { tabId, action: 'box', ref }); assert.ok(box.width > 0 && box.border.height > box.content.height);
    const btn = (await okJson('devtools_elements', { tabId, action: 'search', query: '#slow' })).items[0];
    const ls = await okJson('devtools_elements', { tabId, action: 'listeners', ref: btn.ref }); assert.ok(ls.some((l: any) => l.type === 'click' && /app\.js:\d+/.test(l.location)));
    await ok('devtools_elements', { tabId, action: 'attributes', ref, name: 'data-x', value: '1' }); assert.equal((await okJson('devtools_elements', { tabId, action: 'attributes', ref }))['data-x'], '1');
    assert.deepEqual((await okJson('devtools_elements', { tabId, action: 'classes', ref, add: ['hot'] })).classes, ['hot']);
    assert.match((await okJson('devtools_elements', { tabId, action: 'html', ref })).html, /^<p id="out"/);
    await ok('devtools_elements', { tabId, action: 'pseudo', ref: btn.ref, states: ['hover'] });
    assert.equal((await okJson('devtools_elements', { tabId, action: 'computed', ref: btn.ref, properties: ['outline-color'] }))['outline-color'], 'rgb(0, 0, 255)');
    await ok('devtools_elements', { tabId, action: 'pseudo', ref: btn.ref, states: [] });
    await ok('devtools_elements', { tabId, action: 'highlight', ref }); await ok('devtools_elements', { tabId, action: 'hide' });
    await ok('devtools_emulation', { tabId, action: 'device', preset: 'iphone-14' });
    assert.equal(await ok('devtools_evaluate', { tabId, expression: 'innerWidth' }).then((t) => JSON.parse(t).value), 390);
    assert.match(await ok('devtools_evaluate', { tabId, expression: 'navigator.userAgent' }), /iPhone/);
    await ok('devtools_emulation', { tabId, action: 'media', colorScheme: 'dark' });
    assert.equal(JSON.parse(await ok('devtools_evaluate', { tabId, expression: "matchMedia('(prefers-color-scheme: dark)').matches" })).value, true);
    await ok('devtools_emulation', { tabId, action: 'reset' });
    assert.notEqual(JSON.parse(await ok('devtools_evaluate', { tabId, expression: 'innerWidth' })).value, 390);
  });

  test('scenario 5: slow function via CPU profile and performance trace', async () => {
    await ok('devtools_profile', { tabId, action: 'start' });
    await clickBtn('Slow'); await ok('browser_wait', { tabId, text: 'slow done', timeoutMs: 5000 });
    const prof = await okJson('devtools_profile', { tabId, action: 'stop' });
    assert.ok(existsSync(prof.artifact)); assert.ok(prof.bottomUp.some((f: any) => f.function.startsWith('slowFunction')), JSON.stringify(prof.bottomUp.slice(0, 5)));
    if (!(await supported('Tracing'))) { console.log('  (Tracing unsupported in extension mode here; skipping trace part)'); return; }
    await ok('devtools_performance', { tabId, action: 'start' });
    await clickBtn('Slow'); await ok('browser_wait', { tabId, text: 'slow done', timeoutMs: 5000 });
    const perf = await okJson('devtools_performance', { tabId, action: 'stop' });
    assert.ok(existsSync(perf.artifact)); assert.ok(perf.longTasks.count >= 1, JSON.stringify(perf.longTasks)); assert.ok(perf.timeByCategoryMs.scripting > 100);
    const hits = await okJson('devtools_performance', { tabId, action: 'search', recordingId: perf.recordingId, query: 'FunctionCall', minDurationMs: 100 }); assert.ok(hits.total >= 1);
    const vitals = await okJson('devtools_performance', { tabId, action: 'vitals' }); assert.ok('longTasks' in vitals || 'FCP' in vitals);
  });

  test('scenario 6: retained objects in a memory-growth example, exported heap snapshot', async () => {
    if (!(await supported('HeapProfiler'))) { console.log('  (HeapProfiler unsupported; skipping)'); return; }
    const a = await okJson('devtools_memory', { tabId, action: 'snapshot' });
    await clickBtn('Leak'); await ok('browser_wait', { tabId, text: 'leaked 20000' });
    const b = await okJson('devtools_memory', { tabId, action: 'snapshot' });
    assert.ok(existsSync(b.artifact)); assert.ok(JSON.parse(readFileSync(b.artifact, 'utf8')).snapshot.meta, 'heapsnapshot parses');
    const diff = await okJson('devtools_memory', { tabId, action: 'compare', snapshotId: a.snapshotId, other: b.snapshotId });
    const leak = diff.grew.find((r: any) => r.name === 'LeakItem'); assert.ok(leak && leak.countDelta >= 20000, JSON.stringify(diff.grew.slice(0, 5)));
    const ret = await okJson('devtools_memory', { tabId, action: 'retainers', snapshotId: b.snapshotId, className: 'LeakItem' }); assert.ok(ret.instances >= 20000 && ret.retainedBy.length);
    const growth = await okJson('devtools_memory', { tabId, action: 'growth', seconds: 1 }); assert.ok('verdict' in growth);
  });

  test('scenario 7: application storage and service worker update', async () => {
    await clickBtn('Write storage'); await ok('browser_wait', { tabId, text: 'storage written' });
    assert.equal((await okJson('devtools_storage', { tabId, area: 'local' })).items.theme, 'dark');
    assert.equal((await okJson('devtools_storage', { tabId, area: 'session' })).items.visit, '1');
    await ok('devtools_storage', { tabId, area: 'local', action: 'set', key: 'theme', value: 'light' });
    assert.equal(JSON.parse(await ok('devtools_evaluate', { tabId, expression: "localStorage.getItem('theme')" })).value, 'light');
    assert.ok((await okJson('devtools_storage', { tabId, area: 'cookies' })).some((c: any) => c.name === 'session' && c.value === 'abc123'));
    assert.deepEqual((await okJson('devtools_storage', { tabId, area: 'indexeddb' })).databases, ['appdb']);
    const stores = await okJson('devtools_storage', { tabId, area: 'indexeddb', action: 'stores', database: 'appdb' }); assert.equal(stores.stores[0].name, 'todos');
    const data = await okJson('devtools_storage', { tabId, area: 'indexeddb', action: 'data', database: 'appdb', store: 'todos' }); assert.match(data.entries[0].value, /write tests/);
    await ok('devtools_storage', { tabId, area: 'indexeddb', action: 'put', database: 'appdb', store: 'todos', json: { id: 2, title: 'second' } });
    assert.equal((await okJson('devtools_storage', { tabId, area: 'indexeddb', action: 'data', database: 'appdb', store: 'todos' })).entries.length, 2);
    await ok('devtools_storage', { tabId, area: 'indexeddb', action: 'clearStore', database: 'appdb', store: 'todos' });
    assert.equal((await okJson('devtools_storage', { tabId, area: 'indexeddb', action: 'data', database: 'appdb', store: 'todos' })).entries.length, 0);
    assert.ok((await okJson('devtools_storage', { tabId, area: 'cache' })).some((c: any) => c.cacheName === 'v1'));
    assert.ok((await okJson('devtools_storage', { tabId, area: 'cache', action: 'entries', cacheName: 'v1' })).entries.some((e: any) => e.url.endsWith('/cached.txt')));
    const usage = await okJson('devtools_storage', { tabId, area: 'usage' }); assert.ok(usage.quotaBytes > 0);
    await ok('devtools_storage', { tabId, area: 'clear', types: ['local_storage'] });
    assert.deepEqual((await okJson('devtools_storage', { tabId, area: 'local' })).items, {});
    await clickBtn('Register SW'); await ok('browser_wait', { tabId, text: 'sw registered', timeoutMs: 10000 });
    await ok('devtools_events', { tabId, method: 'ServiceWorker.workerVersionUpdated', wait: true, timeoutMs: 5000 }).catch(() => {});
    const w = await okJson('devtools_workers', { tabId, action: 'list' }); assert.ok(w.registrations.length >= 1 && w.registrations[0].scopeURL, JSON.stringify(w));
    await ok('devtools_workers', { tabId, action: 'update' });
    const m = await okJson('devtools_workers', { tabId, action: 'manifest' }); assert.equal(m.manifest.name, 'Debug Test App');
    assert.equal(JSON.parse(await ok('devtools_evaluate', { tabId, expression: "fetch('/from-sw.txt').then(r => r.text())" })).value, 'served by sw');
    await ok('devtools_workers', { tabId, action: 'bypass', enabled: true });
    assert.notEqual(JSON.parse(await ok('devtools_evaluate', { tabId, expression: "fetch('/from-sw.txt').then(r => r.text())" })).value, 'served by sw');
    await ok('devtools_workers', { tabId, action: 'bypass', enabled: false });
    await ok('devtools_workers', { tabId, action: 'unregister' });
  });

  test('coverage, accessibility, security, issues, events paging', async () => {
    await ok('devtools_coverage', { tabId, action: 'start' }); await clickBtn('Log'); await ok('devtools_console', { tabId, action: 'wait', query: 'hello from app', timeoutMs: 5000 });
    const cov = await okJson('devtools_coverage', { tabId, action: 'stop' });
    const js = cov.files.find((f: any) => f.url.includes('dist/app.js')); assert.ok(js && js.unusedPct > 0 && js.unusedPct < 100, JSON.stringify(cov.files));
    const det = await okJson('devtools_coverage', { tabId, action: 'detail', url: 'dist/app.js' }); assert.ok(det.unusedRanges.length && det.unusedRanges[0].fromLine > 0);
    assert.ok(cov.files.some((f: any) => f.type === 'CSS'));
    const tree = await ok('devtools_accessibility', { tabId, action: 'tree' }); assert.match(tree, /button "Log"/); assert.match(tree, /heading "Debug App"/);
    const node = await okJson('devtools_accessibility', { tabId, action: 'node', selector: '#slow' }); assert.equal(node.role, 'button'); assert.equal(node.name, 'Slow');
    const check = await okJson('devtools_accessibility', { tabId, action: 'check' }); assert.ok(check.problems.some((p: any) => p.rule === 'form-label'));
    const issues = await okJson('devtools_accessibility', { tabId, action: 'issues' }); assert.ok('items' in issues);
    const sec = await okJson('devtools_security', { tabId, action: 'mixedContent' }); assert.equal(sec.secure, false);
    await ok('devtools_security', { tabId, action: 'certificate' });
    const e1 = await okJson('devtools_events', { tabId, limit: 5 }); assert.equal(e1.events.length, 5); assert.ok(e1.lastId > 0);
    const e2 = await okJson('devtools_events', { tabId, afterId: e1.events[4].id, method: 'Network', limit: 3 }); assert.ok(e2.events.every((e: any) => e.id > e1.events[4].id));
    const p = ok('devtools_events', { tabId, method: 'console', text: 'hello from app', wait: true, timeoutMs: 5000 }); await clickBtn('Log'); assert.match(JSON.parse(await p).event.summary, /hello from app/);
  });

  test('scenario 10: revoked access, unavailable capability, no duplicated actions', async () => {
    const msg = await dashboard(ext);
    await msg({ type: 'setShared', tabIds: [nativeTabId], shared: false });
    const denied = await call('browser_snapshot', { tabId }); assert.ok(denied.err && /not shared/.test(denied.txt), denied.txt);
    const evalDenied = await call('devtools_evaluate', { tabId, expression: '1' }); assert.ok(evalDenied.err && /not shared/.test(evalDenied.txt));
    const st = await okJson('devtools_session', { action: 'status', tabId }).catch(() => null); void st; // status reads companion state only
    await msg({ type: 'setShared', tabIds: [nativeTabId], shared: true });
    assert.match(await ok('browser_snapshot', { tabId }), /Debug App/);
    const before = JSON.parse(await ok('devtools_evaluate', { tabId, expression: "document.getElementById('out').textContent" })).value;
    const bad = await call('devtools_cdp', { tabId, method: 'Browser.getVersion' }); assert.ok(bad.err && /developer mode/.test(bad.txt));
    const unsup = await call('devtools_memory', { tabId, action: 'snapshot' });
    if (unsup.err) assert.match(unsup.txt, /HeapProfiler|wasn't found|not allowed/i);
    assert.equal(JSON.parse(await ok('devtools_evaluate', { tabId, expression: "document.getElementById('out').textContent" })).value, before, 'no action was repeated after failures');
  });

  test('agent tabs remain the default target and release the debugger when idle', async () => {
    const opened = await ok('browser_tabs', { action: 'new', url: appUrl + 'page2.html' }); const id2 = Number(/tab (\d+)/.exec(opened)![1]);
    const st = await (await dashboard(ext))({ type: 'getState' });
    const mine = st.tabs.find((t: any) => t.url === appUrl + 'page2.html');
    assert.ok(mine?.agent === true && mine.shared, 'the agent-created tab is shared');
    // developer browser is gated by the dashboard setting while the extension is connected
    await (await dashboard(ext))({ type: 'setDevMode', mode: 'never' }); await new Promise((r) => setTimeout(r, 300));
    const never = await call('browser_session', { action: 'launch', headless: true }); assert.ok(never.err && /disabled in the Browspark dashboard/.test(never.txt), never.txt);
    const neverAsked = await call('browser_session', { action: 'launch', headless: true, userRequested: true }); assert.ok(neverAsked.err && /disabled in the Browspark dashboard/.test(neverAsked.txt), neverAsked.txt);
    await (await dashboard(ext))({ type: 'setDevMode', mode: 'auto' }); await new Promise((r) => setTimeout(r, 300));
    const refused = await call('browser_session', { action: 'launch', headless: true }); assert.ok(refused.err && /nothing so far needed one/.test(refused.txt), refused.txt);
    const asked = await call('browser_session', { action: 'launch', headless: true, userRequested: true }); assert.ok(!asked.err && /Launched/.test(asked.txt), asked.txt);
    assert.match(await ok('browser_session', { action: 'close' }), /Closed/);
    await call('devtools_memory', { tabId, action: 'snapshot' }); // unsupported in extension mode: this is what justifies a launch in auto mode
    const allowed = await call('browser_session', { action: 'launch', headless: true }); assert.ok(!allowed.err && /Launched/.test(allowed.txt), allowed.txt);
    assert.match(await ok('browser_session', { action: 'close' }), /Closed/);
    assert.match(await ok('browser_tabs'), new RegExp(`\\[${id2}\\] extension \\(opened by you\\) shared`));
    assert.match(await ok('browser_read'), /Page Two/); // no tabId: defaults to the agent's tab, not the user's
    await ext.eval!('chrome.storage.local.set({ idleDetachMs: 1500 })');
    await new Promise((r) => setTimeout(r, 4500));
    const list = await ok('browser_tabs');
    assert.doesNotMatch(list.split('\n').find((l) => l.includes(`[${id2}]`))!, /debugging/, 'idle agent tab released the debugger');
    assert.match(list.split('\n').find((l) => l.includes(`[${tabId}]`))!, /debugging/, 'inspected tab stays attached');
    assert.match(await ok('browser_read', { tabId: id2 }), /Page Two/); // re-attaches transparently
    await ext.eval!('chrome.storage.local.remove("idleDetachMs")');
    await ok('browser_tabs', { action: 'close', tabId: id2 });
    // activity log is off by default: nothing stored; turning it on starts recording
    const msg = await dashboard(ext);
    const off = await msg({ type: 'getState' }); assert.equal(off.activityLog, false); assert.equal(off.recent.length, 0); assert.ok(off.totals.ops > 0);
    await msg({ type: 'setActivityLog', on: true }); await ok('browser_read', { tabId });
    const on = await msg({ type: 'getState' }); assert.ok(on.activityLog && on.recent.length > 0);
    await msg({ type: 'setActivityLog', on: false }); assert.equal((await msg({ type: 'getState' })).recent.length, 0);
  });

  test('markdown read, PDF, domain policy (extension mode)', async () => {
    const md = await ok('browser_read', { tabId, what: 'markdown' }); assert.match(md, /^# Debug App/m); assert.match(md, /idle/); assert.doesNotMatch(md, /Register SW/, 'buttons are UI, not content');
    const pdf = await call('browser_pdf', { tabId }); if (!pdf.err) { const p = /to (\S+\.pdf)/.exec(pdf.txt)![1]; assert.equal(readFileSync(p).subarray(0, 4).toString(), '%PDF'); } else console.log('  (PDF unavailable in extension mode: ' + pdf.txt.slice(0, 80) + ')');
    await ok('browser_policy', { action: 'set', tabId, allow: ['127.0.0.1'] });
    assert.match(await ok('devtools_evaluate', { tabId, expression: "fetch('https://example.com/').then(() => 'ok', e => 'blocked:' + e.message)" }), /blocked/);
    const allowed = await ok('devtools_evaluate', { tabId, expression: "fetch('/api/items').then(r => 'ok:' + r.status, e => 'ERR:' + e.message)" });
    assert.match(allowed, /ok:200/, allowed + '\nEVENTS: ' + await ok('devtools_events', { tabId, method: 'Fetch|policy', regex: true, limit: 8 }));
    const nav = await call('browser_navigate', { tabId, url: 'https://example.com/' }); assert.ok(nav.err && /BLOCKED|failed/i.test(nav.txt), nav.txt);
    await ok('browser_policy', { action: 'clear', tabId });
    await ok('browser_navigate', { tabId, url: appUrl + 'debug.html' }); // the blocked navigation left Chrome's error page
    assert.match(await ok('devtools_evaluate', { tabId, expression: "fetch('/api/items').then(r => 'ok:' + r.status)" }), /ok:200/);
  });

  test('tools catalog and per-tool enable/disable from the dashboard', async () => {
    const msg = await dashboard(ext);
    const st = await msg({ type: 'getState' });
    assert.ok(st.toolCatalog.length >= 40 && st.toolCatalog.some((t: any) => t.name === 'browser_tabs' && /tabs/i.test(t.description)), `catalog: ${st.toolCatalog.length}`);
    await msg({ type: 'setToolEnabled', name: 'browser_tabs', enabled: false });
    await new Promise((r) => setTimeout(r, 400));
    const denied = await call('browser_tabs', { action: 'new', url: appUrl + 'page2.html' });
    assert.ok(denied.err && /switched off/.test(denied.txt) && /Tools page/.test(denied.txt), denied.txt);
    assert.match(await ok('browser_read', { tabId }), /Debug App/, 'other tools keep working');
    await msg({ type: 'setToolsEnabled', names: ['browser_tabs'], enabled: true });
    await new Promise((r) => setTimeout(r, 400));
    assert.match(await ok('browser_tabs'), /extension/);
    assert.deepEqual((await msg({ type: 'getState' })).disabledTools, []);
  });

  test('refs are stable across snapshots, never reused, and boxless containers are traversed', async () => {
    await ok('browser_navigate', { tabId, url: appUrl + 'debug.html' });
    const s1 = await ok('browser_snapshot', { tabId });
    assert.match(s1, /button "Contents child"/, 'display: contents child is visible in the snapshot');
    const slow1 = refOf(s1, /button "Slow"[^\n]*\[ref=(e\d+)\]/), log1 = refOf(s1, /button "Log"[^\n]*\[ref=(e\d+)\]/);
    const s2 = await ok('browser_snapshot', { tabId });
    assert.equal(refOf(s2, /button "Slow"[^\n]*\[ref=(e\d+)\]/), slow1, 'same element keeps its ref');
    await ok('devtools_evaluate', { tabId, expression: "document.getElementById('log').remove()" });
    const s3 = await ok('browser_snapshot', { tabId });
    assert.doesNotMatch(s3, new RegExp(`\\[ref=${log1}\\]`), 'removed element\'s ref is not handed to another element');
    const stale = await call('browser_click', { tabId, ref: log1 }); assert.ok(stale.err && /removed|stale/i.test(stale.txt), stale.txt);
    assert.match(await ok('browser_click', { tabId, ref: slow1 }), /Clicked/);
    await ok('browser_navigate', { tabId, action: 'reload' });
  });

  test('saving the port reconnects', async () => {
    const msg = await dashboard(ext);
    const before = await msg({ type: 'getState' });
    const after = await msg({ type: 'setConfig', port: before.port });
    assert.equal(after.port, before.port);
    for (let i = 0; i < 30 && !(await msg({ type: 'getState' })).connected; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await msg({ type: 'getState' })).connected, true, 'reconnected');
    await msg({ type: 'setShared', tabIds: [nativeTabId], shared: true });
  });

  test('MCP over HTTP: the endpoint serves the same tools to a second client and refuses web pages', async () => {
    const status = await ok('browser_status'); const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)/.exec(status)![1]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}', headers: { origin: 'https://evil.example' } })).status, 403, 'web page origin -> 403');
    const http = new Client({ name: 'gemini-like', version: '0' });
    await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const tools = await http.listTools(); assert.ok(tools.tools.length >= 40 && tools.tools.some((t) => t.name === 'browser_snapshot'));
    const r = await http.callTool({ name: 'browser_read', arguments: { tabId } }) as any; assert.match(r.content[0].text, /Debug App/);
    await http.close();
  });

  test('two agents on one companion keep their own tabs, recordings, and shared inspection sessions', async () => {
    const status = await ok('browser_status'); const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)/.exec(status)![1]);
    const msg = await dashboard(ext);
    const b = new Client({ name: 'second-agent', version: '0' });
    await b.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const bText = async (name: string, args: Record<string, unknown> = {}) => { const r = await b.callTool({ name, arguments: args }) as any; return { txt: r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'), err: !!r.isError }; };
    assert.match((await bText('browser_status')).txt, /You are agent "second-agent"/);
    // each agent opens a tab; default targets do not cross
    const ta = Number(/tab (\d+)/.exec(await ok('browser_tabs', { action: 'new', url: appUrl + 'page2.html' }))![1]);
    const tb = Number(/tab (\d+)/.exec((await bText('browser_tabs', { action: 'new', url: appUrl + 'basic.html' })).txt)![1]);
    assert.match(await ok('browser_read'), /Page Two/, 'agent A defaults to its own tab');
    assert.match((await bText('browser_read')).txt, /Test App/, 'agent B defaults to its own tab');
    assert.match(await ok('browser_tabs'), new RegExp(`\\[${tb}\\] extension \\(opened by agent "second-agent"\\)`));
    // recordings are per agent
    await ok('devtools_recorder', { action: 'start', tabId: ta, name: 'a-flow' });
    assert.equal(JSON.parse((await bText('devtools_recorder', { action: 'status' })).txt).recording, false);
    await ok('devtools_recorder', { action: 'stop' });
    // inspection sessions are shared and survive until the last agent leaves
    assert.match((await bText('devtools_session', { action: 'start', tabId })).txt, /Shared with: e2e/);
    assert.match(await ok('devtools_session', { action: 'stop', tabId }), /session kept/);
    assert.equal((await okJson('devtools_session', { action: 'status', tabId })).active, true);
    assert.match((await bText('devtools_session', { action: 'stop', tabId })).txt, /Stopped inspecting/);
    await ok('devtools_session', { action: 'start', tabId, bodies: true });
    // the dashboard's activity log names the agent
    await msg({ type: 'setActivityLog', on: true }); await bText('browser_read', { tabId: tb }); await new Promise((r) => setTimeout(r, 300));
    const recent = (await msg({ type: 'getState' })).recent; assert.ok(recent.some((r: any) => r.client === 'second-agent'), JSON.stringify(recent.slice(0, 3)));
    await msg({ type: 'setActivityLog', on: false });
    await bText('browser_tabs', { action: 'close', tabId: tb }); await ok('browser_tabs', { action: 'close', tabId: ta });
    await b.close();
  });

  test('recorder, batch, richer automation, cleanup on stop', async () => {
    await ok('browser_navigate', { tabId, action: 'reload' });
    await ok('devtools_recorder', { action: 'start', tabId, name: 'flow1' });
    const snap = await ok('browser_snapshot', { tabId });
    await ok('browser_fill', { tabId, ref: refOf(snap, /textbox[^\n]*\[ref=(e\d+)\]/), text: 'typed' });
    await clickBtn('Fetch OK'); await ok('browser_wait', { tabId, text: '200 {"items"' });
    await ok('devtools_recorder', { action: 'add_assertion', assertion: { text: 'alpha' } });
    await ok('devtools_recorder', { action: 'parameterize', stepIndex: 1, field: 'text', paramName: 'name' });
    const saved = await ok('devtools_recorder', { action: 'stop' }); assert.match(saved, /flow1/);
    const flow = await okJson('devtools_recorder', { action: 'get', flowId: 'flow1' }); assert.deepEqual(flow.params, ['name']); assert.ok(flow.steps.some((s: any) => s.selector));
    await ok('browser_navigate', { tabId, action: 'reload' });
    const replay = await ok('devtools_recorder', { action: 'replay', flowId: 'flow1', tabId, params: { name: 'replayed' } });
    assert.doesNotMatch(replay, /✗/); assert.equal(JSON.parse(await ok('devtools_evaluate', { tabId, expression: "document.getElementById('unlabeled').value" })).value, 'replayed');
    const batch = await ok('browser_batch', { steps: [{ tool: 'browser_navigate', args: { tabId, action: 'reload' } }, { tool: 'browser_read', args: { tabId, what: 'text' } }] }); assert.match(batch, /2\. browser_read: .*Debug App/s);
    const full = await call('browser_screenshot', { tabId, fullPage: true }); assert.ok(full.img?.data.length > 1000);
    const el = await call('browser_screenshot', { tabId, ref: refOf(await ok('browser_snapshot', { tabId }), /button "Log"[^\n]*\[ref=(e\d+)\]/), format: 'jpeg' }); assert.equal(el.img?.mimeType, 'image/jpeg');
    const ex = await okJson('browser_extract', { tabId, items: 'button', fields: { label: '.', id: { attr: 'id' } } }); assert.ok(ex.length >= 10 && ex[0].id === 'log');
    const diff = await ok('browser_snapshot', { tabId, diff: true }); assert.match(diff, /no changes|^\+|^-/m);
    await ok('devtools_network', { tabId, action: 'mock', pattern: '*/api/items*', response: { json: { x: 1 } } });
    await ok('devtools_emulation', { tabId, action: 'cpu', rate: 2 });
    const stop = await ok('devtools_session', { action: 'stop', tabId }); assert.match(stop, /Cleanup done/);
    assert.equal((await okJson('devtools_session', { action: 'status', tabId })).active, false);
    await ok('devtools_session', { action: 'start', tabId });
    assert.equal((await okJson('devtools_network', { tabId, action: 'rules' })).rules.length, 0, 'mocks removed on stop');
  });
});

describe.skipIf(skip)('developer mode e2e', () => {
  let http2: Server, url2: string, client2: Awaited<ReturnType<typeof startCompanion>>, c: ReturnType<typeof callers>;
  beforeAll(async () => { ({ server: http2, url: url2 } = await startTestServer(join(ROOT, 'test-apps'))); client2 = await startCompanion(); c = callers(client2); }, 60_000);
  afterAll(async () => { await c.call('browser_session', { action: 'close' }).catch(() => {}); await client2?.close().catch(() => {}); http2?.close(); }, 30_000);

  test('launch dedicated Chrome, drive it, raw CDP, trace, lighthouse (optional), close', async () => {
    const r = await c.call('devtools_cdp', { method: 'Browser.getVersion', target: 'browser' }); assert.ok(r.err && /developer mode/.test(r.txt));
    const launched = await c.ok('browser_session', { action: 'launch', headless: true, url: url2 + 'debug.html' }); assert.match(launched, /Launched/);
    const tabs = await c.ok('browser_tabs'); const id = Number(/\[(\d+)\] dev/.exec(tabs)![1]);
    assert.match(await c.ok('browser_snapshot', { tabId: id }), /heading "Debug App"/);
    const v = await c.okJson('devtools_cdp', { method: 'Browser.getVersion', target: 'browser' }); assert.match(v.product, /Chrome/);
    const caps = await c.okJson('devtools_capabilities', { tabId: id }); assert.equal(caps.mode, 'dev'); assert.ok(caps.domains.Tracing.startsWith('supported') && caps.domains.HeapProfiler.startsWith('supported'));
    await c.ok('devtools_session', { action: 'start', tabId: id });
    await c.ok('devtools_emulation', { tabId: id, action: 'animations', playbackRate: 0 });
    await c.ok('devtools_capabilities', { tabId: id, refresh: true });
    assert.equal((await c.okJson('devtools_emulation', { tabId: id, action: 'animations' })).playbackRate, 0, 'capability probes preserve frozen animations');
    await c.ok('devtools_emulation', { tabId: id, action: 'reset' });
    assert.equal((await c.okJson('devtools_emulation', { tabId: id, action: 'animations' })).playbackRate, 1, 'reset restores animation playback');
    await c.ok('devtools_performance', { tabId: id, action: 'start', reload: true });
    const perf = await c.okJson('devtools_performance', { tabId: id, action: 'stop' }); assert.ok(perf.events > 100 && existsSync(perf.artifact));
    const heap = await c.okJson('devtools_memory', { tabId: id, action: 'snapshot' }); assert.ok(heap.nodes > 1000);
    const nt = await c.ok('browser_tabs', { action: 'new', url: url2 + 'page2.html' }); const id2 = Number(/tab (\d+)/.exec(nt)![1]); assert.match(await c.ok('browser_read', { tabId: id2 }), /Page Two/); await c.ok('browser_tabs', { action: 'close', tabId: id2 });
    if (process.env.E2E_LIGHTHOUSE) { const lh = await c.okJson('devtools_lighthouse', { tabId: id, categories: ['performance'], timeoutMs: 300_000 }); assert.ok(lh.scores.performance > 0 && existsSync(lh.reports.html)); }

    // second context in parallel, with our own extension loaded into it
    const w = await c.ok('browser_session', { action: 'launch', context: 'work', headless: true, url: url2 + 'debug.html', extensions: [join(ROOT, 'dist/chromium-extension')] });
    assert.match(w, /context "work"/); assert.match(w, /extensions: \w+/); assert.match(w, /CDP endpoint: ws:\/\//);
    const st = await c.ok('browser_session', { action: 'status' }); assert.match(st, /\[default\]/); assert.match(st, /\[work\]/);
    assert.ok((await c.okJson('browser_session', { action: 'contexts' })).some((x: any) => x.name === 'work' && x.running));
    const tabsNow = await c.ok('browser_tabs'); const idW = Number(/\[(\d+)\] dev:work/.exec(tabsNow)![1]); assert.notEqual(idW, id);
    assert.match(await c.ok('browser_read', { tabId: idW }), /Debug App/);
    // downloads land in the context's directory
    await c.ok('devtools_evaluate', { tabId: idW, expression: "(() => { const a = document.createElement('a'); a.href = '/download.txt'; a.download = 'hello.txt'; document.body.append(a); a.click(); return 'clicked'; })()" });
    const dl = await c.okJson('browser_download', { action: 'wait', tabId: idW, urlContains: 'download.txt', timeoutMs: 15000 });
    assert.equal(dl.state, 'completed'); assert.equal(readFileSync(dl.path, 'utf8'), 'hello download');
    // PDF
    const pdf = await c.ok('browser_pdf', { tabId: idW }); const pdfPath = /to (\S+\.pdf)/.exec(pdf)![1]; assert.equal(readFileSync(pdfPath).subarray(0, 4).toString(), '%PDF');
    // fetch to markdown leaves no tab behind
    const before = (await c.ok('browser_tabs')).split('\n').length;
    const f = await c.okJson('browser_fetch', { url: url2 + 'debug.html', context: 'work' }); assert.match(f.content, /^# Debug App/m); assert.equal(f.title, 'Debug Test App');
    assert.equal((await c.ok('browser_tabs')).split('\n').length, before);
    // recorder -> Playwright export
    await c.ok('devtools_recorder', { action: 'start', tabId: idW, name: 'exportme' });
    const snap = await c.ok('browser_snapshot', { tabId: idW }); await c.ok('browser_click', { tabId: idW, ref: /button "Log"[^\n]*\[ref=(e\d+)\]/.exec(snap)![1] });
    await c.ok('devtools_recorder', { action: 'add_assertion', assertion: { text: 'idle' } });
    await c.ok('devtools_recorder', { action: 'stop' });
    const exp = await c.ok('devtools_recorder', { action: 'export', flowId: 'exportme', format: 'playwright' }); const specPath = /to (\S+\.spec\.ts)/.exec(exp)![1];
    const spec = readFileSync(specPath, 'utf8'); assert.match(spec, /page\.goto\(/); assert.match(spec, /locator\("#log"\)\.click\(\)/); assert.match(spec, /getByText\("idle"\)/);
    // WebMCP probe on a page without it
    assert.equal((await c.okJson('browser_webmcp', { tabId: idW })).supported, false);
    // live view: page served, screencast frames arrive over the viewer socket; web pages are refused
    const status = await c.ok('browser_status'); const port = Number(/port:\s+(\d+)/.exec(status)![1]);
    const html = await fetch(`http://127.0.0.1:${port}/live/${idW}`); assert.equal(html.status, 200); assert.match(await html.text(), /live view/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/live/${idW}`, { headers: { origin: 'https://evil.example' } })).status, 403);
    const frame = await new Promise<any>((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/live-ws?tab=${idW}`); const t = setTimeout(() => rej(new Error('no frame')), 8000); ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'frame') { clearTimeout(t); ws.close(); res(m); } }); ws.on('error', rej); });
    assert.ok(frame.data.length > 1000 && frame.meta.deviceWidth > 0);
    assert.match(await c.ok('browser_session', { action: 'close', all: true }), /Closed default, work|Closed work, default/);
    const after = await c.call('browser_snapshot', { tabId: id }); assert.ok(after.err);
  }, 240_000);
});
