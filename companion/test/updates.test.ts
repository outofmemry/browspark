import { afterAll, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { Bridge } from '../src/bridge.ts';
import { Updater, unpackedExtensionId, unpackedExtensionIdForPath, unzip } from '../src/updates.ts';
import { compareVersions, type UpdateEvent } from '../../shared/protocol.ts';

const temp: string[] = [];
const tempDir = (name: string) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), `browspark-${name}-`))); temp.push(dir); return dir; };
afterAll(() => { for (const dir of temp) rmSync(dir, { recursive: true, force: true }); });

/** Small zip writer for fixtures: stored or deflated entries, any names (including hostile ones). */
function zip(files: Record<string, string | Buffer>, deflate = true): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content), packed = deflate ? deflateRawSync(data) : data, nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(deflate ? 8 : 0, 10);
    dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed); central.push(dir, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const chromiumManifest = (version: string) => JSON.stringify({ manifest_version: 3, name: 'Browspark', version, background: { service_worker: 'dist/background.js' } });
const firefoxManifest = (version: string) => JSON.stringify({ manifest_version: 3, name: 'Browspark', version, browser_specific_settings: { gecko: { id: 'browspark@krishm.dev' } } });
function extension(dir: string, manifest: string) {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), manifest);
  writeFileSync(join(dir, 'dist/app.js'), 'old');
  return dir;
}

/** Serves a GitHub-style "latest release" document and its two archives. */
async function releaseServer(version: string, archives: { chromium?: Buffer; firefox?: Buffer }) {
  let releaseHits = 0;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    if (req.url === '/latest') {
      releaseHits++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tag_name: `v${version}`, html_url: `https://github.com/outofmemry/browspark/releases/tag/v${version}`, body: '## What\'s Changed\n* Things', published_at: '2026-10-05T00:00:00Z', assets: [
        ...(archives.chromium ? [{ name: 'browspark-chrome-extension.zip', browser_download_url: `${base}chrome.zip` }] : []),
        ...(archives.firefox ? [{ name: 'browspark-firefox-extension.zip', browser_download_url: `${base}firefox.zip` }] : []),
      ] }));
      return;
    }
    const archive = req.url === '/chrome.zip' ? archives.chromium : req.url === '/firefox.zip' ? archives.firefox : undefined;
    if (archive) { res.setHeader('content-length', String(archive.length)); res.end(archive); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`, hits: () => releaseHits, stop: () => server.close() };
}

test('versions compare by semver, prereleases first', () => {
  assert.ok(compareVersions('0.8.0', '0.7.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('v1.0.0', '1.0.0') === 0);
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.ok(compareVersions('0.6.6', '0.7.0') < 0);
});

test('unpacked Chromium ids follow the folder path', () => {
  // Captured from Brave: Extensions.loadUnpacked on /tmp/browspark-id-vector/browspark-extension (realpath /private/tmp/…).
  assert.equal(unpackedExtensionIdForPath('/private/tmp/browspark-id-vector/browspark-extension', 'darwin'), 'mnjjbbnpfgbbbbaincdkmmgmjkbcoakj');
  const home = tempDir('id');
  const folder = extension(join(home, 'browspark-extension'), chromiumManifest('0.7.0'));
  symlinkSync(folder, join(home, 'link'));
  assert.equal(unpackedExtensionId(join(home, 'link')), unpackedExtensionId(folder), 'symlinks resolve to the folder Chromium hashed');
});

test('unzip reads stored and deflated entries and refuses escaping names', () => {
  for (const deflate of [true, false]) {
    const files = unzip(zip({ 'manifest.json': '{"name":"Browspark"}', 'dist/app.js': 'x'.repeat(5000) }, deflate));
    assert.equal(files.get('manifest.json')?.toString(), '{"name":"Browspark"}');
    assert.equal(files.get('dist/app.js')?.length, 5000);
  }
  // One wrapping folder is unwrapped.
  assert.ok(unzip(zip({ 'browspark-chrome-extension/manifest.json': '{}', 'browspark-chrome-extension/app.html': '' })).has('manifest.json'));
  for (const name of ['../evil.js', '/etc/passwd', 'dist/../../evil', 'C:/evil', 'a//b']) assert.throws(() => unzip(zip({ [name]: 'x' })), /unsafe path/);
  assert.throws(() => unzip(Buffer.from('not a zip')), /not a zip/);
});

test('locate finds the folder this extension runs from', () => {
  const home = tempDir('home');
  const setup = extension(join(home, 'browspark-extension'), chromiumManifest('0.7.0'));
  const unzipped = extension(join(home, 'Downloads/browspark-chrome-extension/browspark-chrome-extension'), chromiumManifest('0.7.0'));
  const firefox = extension(join(home, 'browspark-firefox-extension'), firefoxManifest('0.7.0'));
  // A build output inside a source checkout is never a target.
  mkdirSync(join(home, 'browspark-src/.git'), { recursive: true });
  writeFileSync(join(home, 'browspark-src/package.json'), JSON.stringify({ name: 'browspark-mcp' }));
  const source = extension(join(home, 'browspark-src/browspark-build'), chromiumManifest('0.7.0')); // scanned by name, then excluded
  const updater = new Updater({ companionVersion: '0.7.0', home, firefoxProfiles: [] });

  assert.deepEqual(updater.candidates().sort(), [setup, unzipped, firefox].sort());
  assert.equal(updater.locate('chromium', unpackedExtensionId(setup)!).target?.path, setup, 'installer folder');
  assert.equal(updater.locate('chromium', unpackedExtensionId(unzipped)!).target?.path, unzipped, 'double-unzipped archive folder');
  assert.equal(updater.locate('chromium', unpackedExtensionId(unzipped)!).target?.display, '~/Downloads/browspark-chrome-extension/browspark-chrome-extension');
  assert.equal(updater.locate('chromium', unpackedExtensionId(source)!).target, undefined, 'source checkouts are not updated from releases');
  assert.equal(updater.locate('chromium', 'a'.repeat(32)).target, undefined);
  assert.equal(updater.locate('firefox', 'browspark@krishm.dev').target?.path, firefox, 'one Firefox build: that one');

  const second = extension(join(home, 'Desktop/browspark-firefox-extension'), firefoxManifest('0.7.0'));
  const located = updater.locate('firefox', 'browspark@krishm.dev');
  assert.equal(located.target, undefined);
  assert.deepEqual(located.candidates?.map((c) => c.path).sort(), [firefox, second].sort(), 'several Firefox builds: the user chooses');

  // Firefox records temporary add-ons with their source; that wins over guessing.
  const profiles = join(home, 'profiles');
  mkdirSync(join(profiles, 'abc.default'), { recursive: true });
  writeFileSync(join(profiles, 'abc.default/extensions.json'), JSON.stringify({ addons: [{ id: 'browspark@krishm.dev', location: 'app-temporary', path: second }] }));
  assert.equal(new Updater({ companionVersion: '0.7.0', home, firefoxProfiles: [profiles] }).locate('firefox', 'browspark@krishm.dev').target?.path, second);
});

test('install swaps the release into the same folder and keeps its id', async () => {
  const home = tempDir('install');
  const folder = extension(join(home, 'browspark-extension'), chromiumManifest('0.7.0'));
  writeFileSync(join(folder, 'stale.js'), 'removed by the update');
  const id = unpackedExtensionId(folder)!;
  const release = await releaseServer('0.8.0', {
    chromium: zip({ 'manifest.json': chromiumManifest('0.8.0'), 'dist/app.js': 'new', 'app.html': '<html>' }),
    firefox: zip({ 'manifest.json': firefoxManifest('0.8.0') }),
  });
  try {
    const updater = new Updater({ companionVersion: '0.7.0', home, api: release.api, firefoxProfiles: [] });
    const status = await updater.status({ type: 'check', engine: 'chromium', id, version: '0.7.0' });
    assert.equal(status.available, true);
    assert.equal(status.installable, true);
    assert.equal(status.latest, '0.8.0');
    assert.equal(status.target?.display, '~/browspark-extension');
    await updater.status({ type: 'check', engine: 'chromium', id, version: '0.7.0' });
    assert.equal(release.hits(), 1, 'release metadata is cached');

    const events: UpdateEvent[] = [];
    const done = await updater.install({ type: 'install', engine: 'chromium', id, version: '0.7.0' }, (e) => events.push(e));
    assert.equal(done.version, '0.8.0');
    assert.deepEqual([...new Set(events.map((e) => e.type === 'progress' && e.stage))], ['download', 'verify', 'install']);
    assert.equal(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).version, '0.8.0');
    assert.equal(readFileSync(join(folder, 'dist/app.js'), 'utf8'), 'new');
    assert.throws(() => readFileSync(join(folder, 'stale.js')), 'files from the old version are gone');
    assert.equal(unpackedExtensionId(folder), id, 'same path, same extension id');
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.browspark/extensions.json'), 'utf8')).chromium, [folder], 'remembered for next time');
    assert.deepEqual(new Updater({ companionVersion: '0.7.0', home, firefoxProfiles: [] }).candidates(), [folder]);

    await assert.rejects(updater.install({ type: 'install', engine: 'chromium', id, version: '0.8.0' }), /already up to date/);
    // A chosen folder must be the one this browser loaded.
    const other = extension(join(home, 'elsewhere'), chromiumManifest('0.7.0'));
    await assert.rejects(updater.install({ type: 'install', engine: 'chromium', id, version: '0.7.0', path: other }), /did not load the extension from/);
    await assert.rejects(updater.install({ type: 'install', engine: 'chromium', id: unpackedExtensionId(other)!, version: '0.7.0', path: join(home, 'missing') }), /does not exist/);
    await assert.rejects(updater.install({ type: 'install', engine: 'firefox', id: 'browspark@krishm.dev', version: '0.7.0', path: other }), /holds the Chromium build/);
  } finally { release.stop(); }
});

test('install refuses an archive that is not the expected build', async () => {
  const home = tempDir('mismatch');
  const folder = extension(join(home, 'browspark-extension'), chromiumManifest('0.7.0'));
  const release = await releaseServer('0.8.0', { chromium: zip({ 'manifest.json': chromiumManifest('0.7.5') }) });
  try {
    const updater = new Updater({ companionVersion: '0.7.0', home, api: release.api, firefoxProfiles: [] });
    await assert.rejects(updater.install({ type: 'install', engine: 'chromium', id: unpackedExtensionId(folder)!, version: '0.7.0' }), /not the Chromium build of Browspark 0\.8\.0/);
    assert.equal(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).version, '0.7.0', 'the folder is untouched');
  } finally { release.stop(); }
});

test('the /update socket checks for anyone local and installs only for the extension itself', async () => {
  const home = tempDir('socket');
  const folder = extension(join(home, 'browspark-extension'), chromiumManifest('0.7.0'));
  const id = unpackedExtensionId(folder)!;
  const release = await releaseServer('0.8.0', { chromium: zip({ 'manifest.json': chromiumManifest('0.8.0') }) });
  const bridge = new Bridge(0);
  const updater = new Updater({ companionVersion: '0.7.0', home, api: release.api, firefoxProfiles: [] });
  bridge.updateHandler = (ws, origin) => updater.handleSocket(ws, origin);
  await bridge.listen();
  const ask = (request: unknown, origin?: string) => new Promise<UpdateEvent[]>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/update`, origin ? { headers: { origin } } : {});
    const events: UpdateEvent[] = [];
    ws.on('open', () => ws.send(JSON.stringify(request)));
    ws.on('message', (data) => { const e = JSON.parse(data.toString()); events.push(e); if (e.type !== 'progress') { ws.close(); resolve(events); } });
    ws.on('close', (code) => { if (!events.length) reject(new Error(`closed ${code}`)); });
    ws.on('error', reject);
  });
  try {
    const [status] = await ask({ type: 'check', engine: 'chromium', id, version: '0.7.0' });
    assert.equal(status?.type === 'status' && status.installable, true);
    await assert.rejects(ask({ type: 'check', engine: 'chromium', id: 'not-an-id', version: '0.7.0' }), /closed 1003/);
    const refused = await ask({ type: 'install', engine: 'chromium', id, version: '0.7.0' }, `chrome-extension://${'b'.repeat(32)}`);
    assert.deepEqual(refused.at(-1), { type: 'error', message: 'Updates can only be installed from the Browspark dashboard.' });
    const page = new WebSocket(`ws://127.0.0.1:${bridge.port}/update`, { headers: { origin: 'https://evil.example' } });
    await new Promise<void>((r) => { page.on('error', () => r()); page.on('close', () => r()); page.on('open', () => r()); });
    assert.notEqual(page.readyState, WebSocket.OPEN, 'web pages cannot reach the updater');
    const installed = await ask({ type: 'install', engine: 'chromium', id, version: '0.7.0' }, `chrome-extension://${id}`);
    assert.equal(installed.at(-1)?.type, 'done');
    assert.equal(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).version, '0.8.0');
  } finally { bridge.close(); release.stop(); }
});

test('disabled or offline updaters say so instead of failing', async () => {
  const off = new Updater({ companionVersion: '0.7.0', home: tempDir('off'), enabled: false });
  assert.equal((await off.status({ type: 'check', engine: 'chromium', id: 'a'.repeat(32), version: '0.7.0' })).reason, 'disabled');
  const offline = new Updater({ companionVersion: '0.7.0', home: tempDir('offline'), api: 'http://127.0.0.1:9/latest', firefoxProfiles: [] });
  const status = await offline.status({ type: 'check', engine: 'chromium', id: 'a'.repeat(32), version: '0.7.0' });
  assert.equal(status.reason, 'offline');
  assert.equal(status.available, false);
});
