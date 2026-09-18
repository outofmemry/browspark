// Fast checks for the non-trivial pure logic: source-map decoding, glob matching, snapshot diff, artifacts.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSourceMap, toOriginal, toGenerated, decodeDataUrl, resolveMapUrl } from '../src/devtools/sourcemap.ts';
import { globToRegex } from '../src/devtools/network.ts';
import { lineDiff } from '../src/page.ts';
import { ROOT } from './harness.ts';
import { saveArtifact, readArtifact, listArtifacts } from '../src/artifacts.ts';
import { allowedByPolicy } from '../src/devtools/intercept.ts';
import { recorder, type Flow } from '../src/devtools/recorder.ts';

test('source map: generated <-> original round trip on the test app', () => {
  if (!existsSync(join(ROOT, 'test-apps/dist/app.js.map'))) spawnSync('bun', ['build', 'test-apps/src/app.ts', '--outdir', 'test-apps/dist', '--sourcemap=linked', '--format=iife'], { cwd: ROOT });
  const map = parseSourceMap(readFileSync(join(ROOT, 'test-apps/dist/app.js.map'), 'utf8'));
  assert.ok(map.sources.some((s) => s.endsWith('src/app.ts')));
  const src = readFileSync(join(ROOT, 'test-apps/src/app.ts'), 'utf8').split('\n');
  const origLine0 = src.findIndex((l) => l.includes("throw new Error('Boom: '"));
  const gen = toGenerated(map, 'src/app.ts', origLine0);
  assert.ok(gen, 'original line maps to generated code');
  const built = readFileSync(join(ROOT, 'test-apps/dist/app.js'), 'utf8').split('\n');
  assert.match(built[gen!.line], /Boom/);
  const back = toOriginal(map, gen!.line, gen!.column);
  assert.equal(back?.line, origLine0);
  assert.equal(decodeDataUrl('data:application/json;base64,' + Buffer.from('{"a":1}').toString('base64')), '{"a":1}');
  assert.equal(resolveMapUrl('https://x.test/js/app.js', 'app.js.map'), 'https://x.test/js/app.js.map');
});

test('glob matching for mocks and blocks', () => {
  assert.ok(globToRegex('*/api/missing*').test('http://h/api/missing?x=1'));
  assert.ok(!globToRegex('*/api/missing').test('http://h/api/missing?x=1'));
  assert.ok(globToRegex('https://cdn.example.com/*.js').test('https://cdn.example.com/a/b.js'));
});

test('snapshot line diff', () => {
  const d = lineDiff('- a\n- b\n- c', '- a\n- c\n- d');
  assert.equal(d, '- - b\n+ - d');
  assert.equal(lineDiff('x', 'x'), '(no changes)');
});

test('artifacts round trip and kind preservation', async () => {
  process.env.BROWSPARK_ARTIFACTS = join(ROOT, 'test-apps/dist/.artifacts-test');
  const a = saveArtifact('trace', 'json', '{"ok":1}', 'unit');
  const b = saveArtifact('heapsnapshot', 'heapsnapshot', '{}');
  assert.ok(existsSync(a.path) && a.bytes === 8);
  assert.equal(readArtifact(a.id), '{"ok":1}');
  assert.equal(readArtifact(a.path), '{"ok":1}');
  const listed = listArtifacts();
  const foundA = listed.find((x) => x.id === a.id);
  const foundB = listed.find((x) => x.id === b.id);
  assert.ok(foundA && foundA.kind === 'trace', `expected kind trace, got ${foundA?.kind}`);
  assert.ok(foundB && foundB.kind === 'heapsnapshot', `expected kind heapsnapshot, got ${foundB?.kind}`);
  rmSync(process.env.BROWSPARK_ARTIFACTS, { recursive: true, force: true });
});

test('domain policy matching handles ports and non-http schemes', () => {
  assert.equal(allowedByPolicy('http://localhost:3000/api', { block: ['localhost:3000'] }), false);
  assert.equal(allowedByPolicy('http://localhost:3000/api', { block: ['localhost'] }), false);
  assert.equal(allowedByPolicy('http://example.com/api', { allow: ['example.com:8080'] }), true);
  assert.equal(allowedByPolicy('http://sub.example.com', { allow: ['example.com'] }), true);
  assert.equal(allowedByPolicy('data:image/png;base64,...', { block: ['*'] }), true);
  assert.equal(allowedByPolicy('about:blank', { block: ['*'] }), true);
});

test('recorder flows are bounded in memory', () => {
  for (let i = 0; i < 60; i++) {
    const f: Flow = { id: `flow-${i}`, name: `flow-${i}`, createdAt: new Date().toISOString(), params: [], steps: [] };
    recorder.setFlow(f);
  }
  assert.ok(recorder.flows.size <= 50, `expected max 50 flows, got ${recorder.flows.size}`);
  assert.equal(recorder.flows.has('flow-0'), false, 'oldest flow should have been evicted');
  assert.equal(recorder.flows.has('flow-59'), true, 'newest flow should be present');
});
