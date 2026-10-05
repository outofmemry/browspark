// Extension updates. The extension cannot write to its own folder, so the companion checks GitHub for the latest
// release, finds the folder the calling extension was loaded from, and swaps the matching zip into that same folder.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { WebSocket } from 'ws';
import { compareVersions, isVersion, type UpdateEngine, type UpdateEvent, type UpdateRequest, type UpdateStatus, type UpdateTarget } from '../../shared/protocol.ts';

export const RELEASES_API = 'https://api.github.com/repos/outofmemry/browspark/releases/latest';
export const ASSET_NAMES: Record<UpdateEngine, string> = { chromium: 'browspark-chrome-extension.zip', firefox: 'browspark-firefox-extension.zip' };
const GECKO_ID = 'browspark@krishm.dev';
const CACHE_MS = 6 * 60 * 60_000, FAILURE_CACHE_MS = 10 * 60_000, FORCE_MIN_AGE_MS = 60_000;
const MAX_ZIP_BYTES = 50 * 1024 * 1024, MAX_FILES = 2000, MAX_UNZIPPED_BYTES = 150 * 1024 * 1024;

export interface Release { version: string; url: string; notes?: string; publishedAt?: string; assets: Partial<Record<UpdateEngine, string>> }
export interface UpdaterOptions {
  companionVersion: string;
  /** Release metadata endpoint; BROWSPARK_RELEASES_URL overrides it (tests, mirrors). */
  api?: string;
  home?: string;
  /** BROWSPARK_UPDATE_CHECK=0 turns every network check off. */
  enabled?: boolean;
  /** Extra folders to consider, e.g. from BROWSPARK_EXTENSION_DIR. */
  extraDirs?: string[];
  /** Firefox profile roots holding extensions.json; defaults per platform. */
  firefoxProfiles?: string[];
  fetch?: typeof fetch;
}

// ---------- versions and identities ----------
/** Chromium names an unpacked extension after its folder: SHA-256 of the absolute real path, first 16 bytes, hex digits mapped to a-p. */
export function unpackedExtensionIdForPath(absolutePath: string, platform = process.platform): string {
  const bytes = platform === 'win32' ? Buffer.from(absolutePath.replace(/^[a-z]:/, (d) => d.toUpperCase()), 'utf16le') : Buffer.from(absolutePath, 'utf8');
  return [...createHash('sha256').update(bytes).digest().subarray(0, 16).toString('hex')].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
const real = (p: string) => { try { return realpathSync(p); } catch { return undefined; } };
export const unpackedExtensionId = (folder: string) => { const r = real(folder); return r ? unpackedExtensionIdForPath(r) : undefined; };

interface Manifest { name?: string; version?: string; browser_specific_settings?: { gecko?: { id?: string } } }
const engineOf = (m: Manifest): UpdateEngine => (m.browser_specific_settings?.gecko ? 'firefox' : 'chromium');
const isBrowspark = (m: unknown): m is Manifest => !!m && typeof m === 'object' && (m as Manifest).name === 'Browspark' && isVersion((m as Manifest).version);
function folderManifest(dir: string): Manifest | undefined {
  try { const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); return isBrowspark(m) ? m : undefined; } catch { return undefined; }
}
function zipManifest(file: string): Manifest | undefined {
  try { const m = JSON.parse(unzip(readFileSync(file)).get('manifest.json')!.toString('utf8')); return isBrowspark(m) ? m : undefined; } catch { return undefined; }
}
const manifestAt = (p: string) => (p.toLowerCase().endsWith('.zip') || p.toLowerCase().endsWith('.xpi') ? zipManifest(p) : folderManifest(p));

/** A build output inside a source checkout is updated with git and `bun run build`, never from a release zip. */
function inSourceCheckout(path: string): boolean {
  let dir = dirname(path);
  for (let i = 0; i < 4; i++) {
    try { if (existsSync(join(dir, '.git')) && JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'browspark-mcp') return true; } catch {}
    const up = dirname(dir); if (up === dir) break; dir = up;
  }
  return false;
}

// ---------- zip ----------
/** Minimal reader for the release archives (stored and deflated entries). Rejects absolute or escaping names. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count > MAX_FILES) throw new Error('archive has too many entries');
  const files = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt zip directory');
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20), length = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength).replace(/\\/g, '/');
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('encrypted archives are not supported');
    if (!name || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').some((part) => part === '..' || part === '')) throw new Error(`unsafe path in archive: ${name}`);
    if ((total += length) > MAX_UNZIPPED_BYTES) throw new Error('archive is too large');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, length) }) : undefined;
    if (!data) throw new Error(`unsupported compression in ${name}`);
    if (data.length !== length) throw new Error(`corrupt data in ${name}`);
    files.set(name, data);
  }
  // Accept archives that wrap everything in one top-level folder.
  if (!files.has('manifest.json')) {
    const tops = new Set([...files.keys()].map((name) => name.split('/')[0]));
    const [top] = tops;
    if (tops.size === 1 && files.has(`${top}/manifest.json`)) return new Map([...files].map(([name, data]) => [name.slice(top!.length + 1), data]));
  }
  return files;
}

// ---------- discovery ----------
export class Updater {
  private release?: { value?: Release; error?: string; at: number };
  private inflight?: Promise<Release | undefined>;
  private installing = new Set<string>();
  readonly api: string;
  readonly home: string;
  readonly enabled: boolean;
  private readonly fetch: typeof fetch;
  private readonly options: UpdaterOptions;
  constructor(options: UpdaterOptions) {
    this.options = options;
    this.api = options.api ?? RELEASES_API;
    this.home = options.home ?? homedir();
    this.enabled = options.enabled ?? true;
    this.fetch = options.fetch ?? fetch;
  }

  private get rememberFile() { return join(this.home, '.browspark', 'extensions.json'); }
  private remembered(): string[] {
    try { const v = JSON.parse(readFileSync(this.rememberFile, 'utf8')); return [...(v.chromium ?? []), ...(v.firefox ?? [])].filter((p): p is string => typeof p === 'string'); } catch { return []; }
  }
  private async remember(engine: UpdateEngine, path: string) {
    let v: Record<string, string[]> = {};
    try { v = JSON.parse(await readFile(this.rememberFile, 'utf8')); } catch {}
    v[engine] = [path, ...(Array.isArray(v[engine]) ? v[engine] : []).filter((p) => p !== path)].slice(0, 10);
    await mkdir(dirname(this.rememberFile), { recursive: true });
    await writeFile(this.rememberFile, JSON.stringify(v, null, 2) + '\n');
  }
  display(path: string) { return path === this.home || path.startsWith(this.home + sep) ? `~${path.slice(this.home.length)}` : path; }
  private target(path: string): UpdateTarget { return { path, display: this.display(path), kind: /\.(zip|xpi)$/i.test(path) ? 'zip' : 'folder' }; }

  /** Installer folders, unzipped release archives and remembered locations; source checkouts are left out. */
  candidates(): string[] {
    const out = new Map<string, string>();
    const add = (p: string) => { const r = real(p); if (r && !out.has(r) && manifestAt(r) && !inSourceCheckout(r)) out.set(r, r); };
    for (const p of this.remembered()) add(p);
    for (const p of this.options.extraDirs ?? []) add(p);
    for (const parent of ['', 'Downloads', 'Desktop', 'Documents'].map((d) => join(this.home, d))) {
      let entries: string[] = [];
      try { entries = readdirSync(parent).filter((name) => /browspark/i.test(name)); } catch { continue; }
      for (const name of entries) {
        const path = join(parent, name);
        add(path);
        // A double-clicked archive can unpack into a folder of the same name.
        try { if (statSync(path).isDirectory()) for (const child of readdirSync(path)) if (/browspark/i.test(child)) add(join(path, child)); } catch {}
      }
    }
    return [...out.values()];
  }

  /** Firefox keeps temporary add-ons in each profile's extensions.json, with the folder or archive they came from. */
  private firefoxRecorded(): string[] {
    const roots = this.options.firefoxProfiles ?? (process.platform === 'darwin'
      ? ['Firefox/Profiles', 'zen/Profiles'].map((p) => join(this.home, 'Library/Application Support', p))
      : process.platform === 'win32'
        ? ['Mozilla/Firefox/Profiles', 'zen/Profiles'].map((p) => join(process.env.APPDATA ?? join(this.home, 'AppData/Roaming'), p))
        : [join(this.home, '.mozilla/firefox'), join(this.home, '.zen')]);
    const found: { path: string; at: number }[] = [];
    for (const root of roots) {
      let profiles: string[] = [];
      try { profiles = readdirSync(root); } catch { continue; }
      for (const profile of profiles) {
        const file = join(root, profile, 'extensions.json');
        try {
          const db = JSON.parse(readFileSync(file, 'utf8'));
          for (const addon of db.addons ?? []) if (addon?.id === GECKO_ID && typeof addon.path === 'string') found.push({ path: addon.path, at: statSync(file).mtimeMs });
        } catch {}
      }
    }
    return found.sort((a, b) => b.at - a.at).map((f) => f.path);
  }

  /** The folder (or Firefox archive) this extension runs from, or the candidates when that cannot be decided. */
  locate(engine: UpdateEngine, id: string): { target?: UpdateTarget; candidates?: UpdateTarget[] } {
    const matching = this.candidates().filter((p) => engineOf(manifestAt(p)!) === engine);
    if (engine === 'chromium') {
      const hit = matching.find((p) => unpackedExtensionIdForPath(p) === id);
      return hit ? { target: this.target(hit) } : {};
    }
    for (const p of this.firefoxRecorded()) {
      const r = real(p), m = r && manifestAt(r);
      if (r && m && engineOf(m) === 'firefox' && !inSourceCheckout(r)) return { target: this.target(r) };
    }
    if (matching.length === 1) return { target: this.target(matching[0]!) };
    return matching.length ? { candidates: matching.map((p) => this.target(p)) } : {};
  }

  /** A folder the user chose: it must hold this browser's Browspark build and, on Chromium, be the one this extension runs from. */
  private chosen(engine: UpdateEngine, id: string, path: string): UpdateTarget {
    const expanded = path.trim().replace(/^~(?=$|\/|\\)/, this.home);
    if (!isAbsolute(expanded) || expanded.length > 4096) throw new Error('Enter the full path of the extension folder, for example ~/browspark-extension.');
    const r = real(expanded);
    if (!r) throw new Error(`${path} does not exist.`);
    const m = manifestAt(r);
    if (!m) throw new Error(`${this.display(r)} does not contain the Browspark extension (no manifest.json for Browspark).`);
    if (engineOf(m) !== engine) throw new Error(`${this.display(r)} holds the ${engineOf(m) === 'firefox' ? 'Firefox' : 'Chromium'} build, not the one this browser uses.`);
    if (inSourceCheckout(r)) throw new Error(`${this.display(r)} is a build output in a source checkout. Update it with git pull and bun run build instead.`);
    if (engine === 'chromium' && unpackedExtensionIdForPath(r) !== id) throw new Error(`This browser did not load the extension from ${this.display(r)}. Choose the folder shown for Browspark in your browser's extensions page.`);
    return this.target(r);
  }

  // ---------- releases ----------
  async latest(force = false): Promise<Release | undefined> {
    if (!this.enabled) return undefined;
    const age = this.release ? Date.now() - this.release.at : Infinity;
    if (this.release && (force ? age < FORCE_MIN_AGE_MS : age < (this.release.value ? CACHE_MS : FAILURE_CACHE_MS))) return this.release.value;
    return this.inflight ??= (async () => {
      try {
        const res = await this.fetch(this.api, { headers: { accept: 'application/vnd.github+json', 'user-agent': `browspark-mcp/${this.options.companionVersion}` }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        const r = await res.json() as { tag_name?: string; html_url?: string; body?: string; published_at?: string; assets?: { name?: string; browser_download_url?: string }[] };
        const version = String(r.tag_name ?? '').replace(/^v/, '');
        if (!isVersion(version)) throw new Error('the latest release has no version tag');
        const assets: Release['assets'] = {};
        for (const engine of ['chromium', 'firefox'] as const) {
          const url = r.assets?.find((a) => a.name === ASSET_NAMES[engine])?.browser_download_url;
          if (url && /^https?:\/\//.test(url)) assets[engine] = url;
        }
        const value: Release = { version, url: typeof r.html_url === 'string' ? r.html_url : 'https://github.com/outofmemry/browspark/releases/latest', notes: typeof r.body === 'string' ? r.body.slice(0, 4000) : undefined, publishedAt: r.published_at, assets };
        this.release = { value, at: Date.now() };
        return value;
      } catch (e) {
        this.release = { error: (e as Error).message, at: Date.now() };
        return undefined;
      } finally { this.inflight = undefined; }
    })();
  }

  async status(req: Extract<UpdateRequest, { type: 'check' }>): Promise<UpdateStatus> {
    const base = { type: 'status' as const, current: req.version, companion: this.options.companionVersion, checkedAt: Date.now() };
    if (!this.enabled) return { ...base, available: false, installable: false, reason: 'disabled' };
    const release = await this.latest(req.force);
    if (!release) return { ...base, available: false, installable: false, reason: 'offline', error: `Could not check GitHub for updates${this.release?.error ? `: ${this.release.error}` : ''}.` };
    const available = compareVersions(release.version, req.version) > 0;
    const located = this.locate(req.engine, req.id);
    const reason = !available ? undefined : !release.assets[req.engine] ? 'no-asset' : located.target ? undefined : located.candidates ? 'ambiguous' : 'not-found';
    return { ...base, latest: release.version, available, releaseUrl: release.url, notes: release.notes, publishedAt: release.publishedAt, ...located, installable: available && !reason, reason };
  }

  // ---------- install ----------
  async install(req: Extract<UpdateRequest, { type: 'install' }>, progress: (e: UpdateEvent) => void = () => {}): Promise<{ version: string; target: UpdateTarget }> {
    if (!this.enabled) throw new Error('Updates are turned off on the companion (BROWSPARK_UPDATE_CHECK).');
    const release = await this.latest(true);
    if (!release) throw new Error(`Could not reach GitHub to find the latest release${this.release?.error ? ` (${this.release.error})` : ''}.`);
    if (compareVersions(release.version, req.version) <= 0) throw new Error(`Browspark ${req.version} is already up to date.`);
    const url = release.assets[req.engine];
    if (!url) throw new Error(`Release ${release.version} has no ${ASSET_NAMES[req.engine]}.`);
    const target = req.path ? this.chosen(req.engine, req.id, req.path) : this.locate(req.engine, req.id).target;
    if (!target) throw new Error('Could not find the folder this extension was loaded from. Choose it in the dashboard.');
    if (this.installing.has(target.path)) throw new Error('An update to this folder is already running.');
    this.installing.add(target.path);
    try {
      progress({ type: 'progress', stage: 'download', received: 0 });
      const zip = await this.download(url, (received, total) => progress({ type: 'progress', stage: 'download', received, total }));
      progress({ type: 'progress', stage: 'verify' });
      const files = unzip(zip);
      let manifest: Manifest;
      try { manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')); } catch { throw new Error('The downloaded archive has no valid manifest.json.'); }
      if (!isBrowspark(manifest) || manifest.version !== release.version || engineOf(manifest) !== req.engine) throw new Error(`The downloaded archive is not the ${req.engine === 'firefox' ? 'Firefox' : 'Chromium'} build of Browspark ${release.version}.`);
      progress({ type: 'progress', stage: 'install' });
      if (target.kind === 'zip') await this.replaceFile(target.path, zip);
      else await this.replaceFolder(target.path, files);
      await this.remember(req.engine, target.path).catch(() => {});
      return { version: release.version, target };
    } finally { this.installing.delete(target.path); }
  }

  private async download(url: string, onProgress: (received: number, total?: number) => void): Promise<Buffer> {
    const res = await this.fetch(url, { headers: { 'user-agent': `browspark-mcp/${this.options.companionVersion}` }, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`);
    const total = Number(res.headers.get('content-length')) || undefined;
    if (total && total > MAX_ZIP_BYTES) throw new Error('The release archive is unexpectedly large.');
    const chunks: Uint8Array[] = [];
    let received = 0, reported = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk); received += chunk.length;
      if (received > MAX_ZIP_BYTES) throw new Error('The release archive is unexpectedly large.');
      if (received - reported > 64 * 1024) { reported = received; onProgress(received, total); }
    }
    onProgress(received, total);
    return Buffer.concat(chunks);
  }

  /** Unpack beside the folder, then swap it in with two renames so the path (and the Chromium extension id) never changes. */
  private async replaceFolder(folder: string, files: Map<string, Buffer>) {
    const parent = dirname(folder), name = basename(folder);
    const staging = await mkdtemp(join(parent, `.${name}.update-`));
    const previous = join(parent, `.${name}.previous-${Date.now()}`);
    try {
      for (const [file, data] of files) {
        const out = normalize(join(staging, file));
        if (relative(staging, out).startsWith('..')) throw new Error(`unsafe path in archive: ${file}`);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, data);
      }
      await rename(folder, previous);
      try { await rename(staging, folder); }
      catch (e) { await rename(previous, folder).catch(() => {}); throw e; }
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
    await rm(previous, { recursive: true, force: true }).catch(() => {});
  }

  private async replaceFile(file: string, zip: Buffer) {
    const temp = `${file}.update-${Date.now()}`;
    await writeFile(temp, zip);
    try { await rename(temp, file); } catch (e) { await rm(temp, { force: true }); throw e; }
  }

  /** One short-lived socket per request: check, or install with progress events. */
  handleSocket(ws: WebSocket, origin?: string) {
    const send = (e: UpdateEvent) => { if (ws.readyState === 1) ws.send(JSON.stringify(e)); };
    ws.on('message', async (data) => {
      let req: UpdateRequest;
      try { req = JSON.parse(data.toString()); } catch { return ws.close(1003, 'bad json'); }
      const valid = !!req && typeof req === 'object' && (req.type === 'check' || req.type === 'install') && (req.engine === 'chromium' || req.engine === 'firefox')
        && typeof req.id === 'string' && (req.engine === 'chromium' ? /^[a-p]{32}$/.test(req.id) : req.id.length <= 128) && isVersion(req.version)
        && (req.type === 'check' ? req.force === undefined || typeof req.force === 'boolean' : req.path === undefined || typeof req.path === 'string');
      if (!valid) return ws.close(1003, 'invalid update request');
      if (req.type === 'check') { send(await this.status(req)); return; }
      // Only the extension's own pages may install, and a Chromium extension only into the folder it was loaded from.
      const allowed = req.engine === 'chromium' ? origin === `chrome-extension://${req.id}` : !!origin?.startsWith('moz-extension://');
      if (!allowed) { send({ type: 'error', message: 'Updates can only be installed from the Browspark dashboard.' }); return; }
      try {
        const done = await this.install(req, send);
        console.error(`browspark: updated the ${req.engine} extension in ${done.target.display} to ${done.version}`);
        send({ type: 'done', ...done });
      } catch (e) { send({ type: 'error', message: (e as Error).message || String(e) }); }
    });
  }
}

/** Environment: BROWSPARK_UPDATE_CHECK=0 disables checks, BROWSPARK_RELEASES_URL replaces the GitHub endpoint, BROWSPARK_EXTENSION_DIR adds folders. */
export function updaterFromEnv(companionVersion: string): Updater {
  return new Updater({
    companionVersion,
    enabled: !/^(0|false|off|no)$/i.test(process.env.BROWSPARK_UPDATE_CHECK ?? ''),
    api: process.env.BROWSPARK_RELEASES_URL || undefined,
    extraDirs: process.env.BROWSPARK_EXTENSION_DIR?.split(delimiter).filter(Boolean),
  });
}
