import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyIdentity, identifyProcess, peerPid, requestStopAll, stopAllAgents } from '../src/agents.ts';
import { clients, type ClientState } from '../src/context.ts';

const unix = process.platform !== 'win32';
// A binary under an agent's name, so `ps` reports e.g. ".../opencode 30".
const fake = (name: string, target: string) => { const dir = mkdtempSync(join(tmpdir(), 'bsp-agent-')); symlinkSync(target, join(dir, name)); return join(dir, name); };
const exited = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

describe.skipIf(!unix)('agent processes', () => {
  test('a generic client name is replaced by the agent found in its process tree', async () => {
    const child = spawn(fake('opencode', '/bin/sleep'), ['30'], { stdio: 'ignore' });
    try {
      const id = await identifyProcess(child.pid!);
      assert.equal(id?.app, 'OpenCode');
      assert.equal(id?.pid, child.pid);
      const client: ClientState = { id: 'x', name: 'cli', ownedTabs: new Set() };
      applyIdentity(client, id);
      assert.equal(client.name, 'OpenCode');
      // A specific, different name keeps its name and is never killed through an ancestor match.
      const other: ClientState = { id: 'y', name: 'my-script', ownedTabs: new Set() };
      applyIdentity(other, id);
      assert.equal(other.name, 'my-script');
      assert.equal(other.process?.pid, 0);
    } finally { child.kill(); }
  });

  test('the walk passes through launchers but stops at an unrelated parent', async () => {
    // The walk starts at the companion's client: here `sh -c`, launched by opencode.
    const launched = spawn(fake('opencode', '/bin/sh'), ['-c', 'sh -c "sleep 30; true"; true'], { stdio: 'ignore' });
    // A script with its own name, run from opencode's shell, is not taken for opencode.
    const script = spawn(fake('opencode', '/bin/sh'), ['-c', `${fake('my-agent', '/bin/sleep')} 30; true`], { stdio: 'ignore' });
    const child = (parent: number) => Number(execFileSync('pgrep', ['-n', '-P', String(parent)]).toString().trim());
    try {
      await new Promise((r) => setTimeout(r, 200));
      assert.equal((await identifyProcess(child(launched.pid!)))?.app, 'OpenCode');
      assert.equal(await identifyProcess(child(script.pid!)), undefined);
    } finally { launched.kill('SIGKILL'); script.kill('SIGKILL'); }
  });

  test('an HTTP peer is found by its port and Stop all agents ends it', async () => {
    const sockets: Socket[] = [];
    const server = createServer((s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const child = spawn(fake('hermes', '/usr/bin/nc'), ['127.0.0.1', String(port)], { stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      while (!sockets.length) await new Promise((r) => setTimeout(r, 20));
      const pid = await peerPid(sockets[0]!.remotePort!);
      assert.equal(pid, child.pid);
      const client: ClientState = { id: 'agents-test', name: 'mcp', ownedTabs: new Set(), initialized: true };
      applyIdentity(client, await identifyProcess(pid!));
      assert.equal(client.name, 'Hermes');
      clients.set(client.id, client);
      const { killed } = await stopAllAgents();
      assert.deepEqual(killed, [`Hermes (pid ${child.pid})`]);
      for (let i = 0; i < 50 && !exited(child.pid!); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(exited(child.pid!) || child.signalCode === 'SIGTERM');
    } finally { clients.delete('agents-test'); child.kill('SIGKILL'); server.close(); for (const s of sockets) s.destroy(); }
  });
  test('a stop request ends nothing unless the user confirms it', async () => {
    const child = spawn(fake('opencode', '/bin/sleep'), ['30'], { stdio: 'ignore' });
    const client: ClientState = { id: 'agents-confirm', name: 'cli', ownedTabs: new Set(), initialized: true };
    try {
      applyIdentity(client, await identifyProcess(child.pid!));
      clients.set(client.id, client);
      let asked = 0;
      assert.equal(await requestStopAll(async (n) => { asked = n; return false; }), undefined);
      assert.equal(asked, 1);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(!exited(child.pid!), 'declined: the agent keeps running');
      const r = await requestStopAll(async () => true);
      assert.deepEqual(r?.killed, [`OpenCode (pid ${child.pid})`]);
    } finally { clients.delete(client.id); child.kill('SIGKILL'); }
  });
  test('Stop all agents waits for a pending lookup and survives a failed one', async () => {
    const child = spawn(fake('opencode', '/bin/sleep'), ['30'], { stdio: 'ignore' });
    // Still in its handshake: the lookup has not been applied yet.
    const pending: ClientState = { id: 'agents-pending', name: 'http', ownedTabs: new Set(), identify: identifyProcess(child.pid!) };
    const failed: ClientState = { id: 'agents-failed', name: 'http', ownedTabs: new Set(), identify: Promise.reject(new Error('lsof failed')) };
    failed.identify!.catch(() => {});
    let closed = false;
    failed.disconnect = async () => { closed = true; };
    try {
      clients.set(pending.id, pending); clients.set(failed.id, failed);
      const r = await stopAllAgents();
      assert.deepEqual(r.killed, [`OpenCode (pid ${child.pid})`]);
      assert.deepEqual(r.disconnected, ['http']);
      assert.ok(closed);
    } finally { clients.delete(pending.id); clients.delete(failed.id); child.kill('SIGKILL'); }
  });
});
