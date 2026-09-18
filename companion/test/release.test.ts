import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// The release script is POSIX shell; Windows contributors have no /bin/sh.
describe.skipIf(process.platform === 'win32')('release script', () => {
test('release stops before publishing when npm authentication fails', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  // Shadow every Bun invocation so this check can never reach the registry.
  const result = spawnSync('/bin/sh', ['-c', `bun() { printf '%s\\n' "$*"; return 1; }; ${scripts.release}`], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'pm whoami\n');
});
});
