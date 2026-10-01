import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function dryRun(env: Record<string, string>, home: string): string {
  const result = Bun.spawnSync(['bash', 'setup.sh', '--test'], {
    cwd: ROOT,
    env: { ...process.env, ...env, HOME: home },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  assert.equal(result.exitCode, 0, `setup.sh --test failed: ${result.stderr?.toString()}`);
  return (result.stdout?.toString() ?? '') + (result.stderr?.toString() ?? '');
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'browspark-setup-test-'));
}

test('setup defaults to the Chromium extension without Firefox', () => {
  const out = dryRun({}, tempHome());
  assert.match(out, /browspark-chrome-extension\.zip/);
  assert.doesNotMatch(out, /browspark-firefox-extension\.zip/);
});

test('setup installs both extensions when chosen', () => {
  const out = dryRun({ BROWSPARK_BROWSERS: '3' }, tempHome());
  assert.match(out, /browspark-chrome-extension\.zip/);
  assert.match(out, /browspark-firefox-extension\.zip/);
});

test('setup installs only the Firefox extension when chosen', () => {
  const out = dryRun({ BROWSPARK_BROWSERS: '2' }, tempHome());
  assert.doesNotMatch(out, /browspark-chrome-extension\.zip/);
  assert.match(out, /browspark-firefox-extension\.zip/);
  assert.match(out, /about:debugging/);
});

test('setup offers Hermes without writing anything in dry-run mode', () => {
  const home = tempHome();
  const out = dryRun({ BROWSPARK_BROWSERS: '1', BROWSPARK_AGENTS: '7' }, home);
  assert.match(out, /7\) hermes/);
  assert.match(out, new RegExp(`Hermes \\(${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.hermes/config\\.yaml\\)`));
  assert.ok(!existsSync(join(home, '.hermes')), 'dry run must not create ~/.hermes');
});

test('setup prints the server command for an unlisted agent', () => {
  const out = dryRun({ BROWSPARK_BROWSERS: '1', BROWSPARK_AGENTS: '8' }, tempHome());
  assert.match(out, /8\) other/);
  assert.match(out, /Other: add to your client's MCP config/);
  assert.match(out, /bunx browspark-mcp@latest/);
});

test('setup prints Other with the selected companion, not bunx', () => {
  const out = dryRun(
    { BROWSPARK_BROWSERS: '1', BROWSPARK_PKG: '2', BROWSPARK_AGENTS: '8' },
    tempHome(),
  );
  assert.match(out, /pnpm dlx browspark-mcp@latest/);
});

test('setup leaves an existing Hermes browspark entry unchanged', () => {
  const home = tempHome();
  mkdirSync(join(home, '.hermes'), { recursive: true });
  writeFileSync(
    join(home, '.hermes', 'config.yaml'),
    'mcp_servers:\n  browspark:\n    command: "bunx"\n    args: ["browspark-mcp@latest"]\n',
  );
  const out = dryRun({ BROWSPARK_BROWSERS: '1', BROWSPARK_AGENTS: '7' }, home);
  assert.match(out, /already in .*config\.yaml, left unchanged/);
});
