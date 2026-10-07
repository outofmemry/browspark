import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { runInThisContext } from 'node:vm';
import ts from 'typescript';
import type { AgentIdentity } from '../src/agents.ts';
import type { ClientState } from '../src/context.ts';

// Load the real module with private OS boundaries: no process is spawned or signalled,
// and neither global mocks nor delayed kill timers can leak into other test files.
const source = ts.transpileModule(readFileSync(new URL('../src/agents.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
type Command = { command: string; args: string[]; options: { timeout: number } };
type Signal = NodeJS.Signals | 0;
function fixture(platform = 'linux') {
  const clients = new Map<string, ClientState>();
  const commands: Command[] = [], signals: [number, Signal][] = [];
  const timers: { callback: () => void; delay: number; unref: boolean }[] = [];
  const processes = new Map<number, string | Error>();
  const os = {
    lsof: '' as string | Error,
    kill: (_pid: number, _signal: Signal) => {},
  };
  const run = async (command: string, args: string[], options: { timeout: number }) => {
    commands.push({ command, args, options });
    assert.ok(command === 'ps' || command === 'lsof', `Unexpected command: ${command}`);
    const stdout = command === 'ps' ? processes.get(Number(args.at(-1))) : os.lsof;
    if (stdout instanceof Error) throw stdout;
    return { stdout: stdout ?? '', stderr: '' };
  };
  const execFile = Object.assign(() => { throw new Error('Expected promisified execFile'); }, { [promisify.custom]: run });
  const dependencies: Record<string, unknown> = {
    'node:child_process': { execFile }, 'node:util': { promisify }, './context.ts': { clients },
  };
  const module = { exports: {} };
  const load = runInThisContext(`(function(require, module, exports, process, setTimeout) { ${source}\n})`);
  load((name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports, {
    platform, pid: 999,
    kill: (pid: number, signal: Signal) => { signals.push([pid, signal]); os.kill(pid, signal); },
  }, (callback: () => void, delay: number) => {
    const timer = { callback, delay, unref: false }; timers.push(timer);
    return { unref: () => { timer.unref = true; } };
  });
  return { agents: module.exports as typeof import('../src/agents.ts'), clients, commands, signals, timers, processes, os };
}
const identity = (overrides: Partial<AgentIdentity> = {}): AgentIdentity => ({ app: 'OpenCode', pid: 42, gui: false, peer: 43, relay: false, ...overrides });
const client = (name: string, process?: AgentIdentity): ClientState => ({ id: name, name, ownedTabs: new Set(), process });

describe('agent process identification', () => {
  const executables = [
    ['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'OpenCode'],
    ['hermes-agent', 'Hermes'], ['hermes_agent', 'Hermes'], ['openclaw', 'OpenClaw'],
    ['cursor-agent', 'Cursor'], ['antigravity', 'Antigravity'], ['cline', 'Cline'],
    ['kilo', 'Kilo Code'], ['kilocode', 'Kilo Code'], ['pi', 'Pi'],
    ['command-code', 'Command Code'], ['commandcode', 'Command Code'], ['cmd', 'Command Code'],
  ];
  for (const [exe, app] of executables) test(`recognizes ${exe} as ${app}`, async () => {
    const f = fixture(); f.processes.set(42, `  1 /opt/bin/${exe} --serve\n`);
    assert.deepEqual(await f.agents.identifyProcess(42), identity({ app, peer: 42 }));
    assert.deepEqual(f.commands, [{ command: 'ps', args: ['-o', 'ppid=,args=', '-p', '42'], options: { timeout: 2000 } }]);
  });

  for (const args of ['/opt/bin/CLAUDE.EXE', 'node /opt/bin/claude.js', 'bun /opt/bin/claude.ts', 'python3.12 /opt/bin/claude.py']) {
    test(`recognizes interpreter scripts and executable suffixes: ${args}`, async () => {
      const f = fixture(); f.processes.set(42, `1 ${args}`);
      assert.equal((await f.agents.identifyProcess(42))?.app, 'Claude Code');
    });
  }

  const packages = [
    ['@anthropic-ai/claude-code', 'Claude Code'], ['@openai/codex', 'Codex'],
    ['opencode-ai', 'OpenCode'], ['openclaw', 'OpenClaw'], ['cline', 'Cline'],
    ['@kilocode/cli', 'Kilo Code'], ['@mariozechner/pi-coding-agent', 'Pi'], ['command-code', 'Command Code'],
  ];
  for (const [pkg, app] of packages) test(`recognizes the ${pkg} install path`, async () => {
    const f = fixture(); f.processes.set(42, `1 node /opt/node_modules/${pkg}/bin/cli.js --serve`);
    assert.deepEqual(await f.agents.identifyProcess(42), identity({ app, peer: 42 }));
  });
  for (const args of ['python /home/user/.hermes/hermes-agent/main.py', 'python -m hermes_cli']) {
    test(`recognizes Hermes launched by Python: ${args}`, async () => {
      const f = fixture(); f.processes.set(42, `1 ${args}`);
      assert.equal((await f.agents.identifyProcess(42))?.app, 'Hermes');
    });
  }

  for (const app of ['Claude', 'Cursor', 'Antigravity', 'Hermes']) test(`identifies ${app} desktop without making it killable`, async () => {
    const f = fixture('darwin'); f.processes.set(42, `1 /Applications/${app}.app/Contents/MacOS/${app}`);
    assert.deepEqual(await f.agents.identifyProcess(42), identity({ app, gui: true, peer: 42 }));
  });

  for (const args of ['npx browspark-mcp', 'bunx browspark', 'node companion/src/index.ts', 'npm exec server', 'pnpm dlx server', 'yarn run server', 'uvx server', 'sh -c server']) {
    test(`walks through a launcher: ${args}`, async () => {
      const f = fixture(); f.processes.set(43, `42 ${args}`); f.processes.set(42, '1 opencode serve');
      const id = await f.agents.identifyProcess(43);
      assert.equal(id?.app, 'OpenCode'); assert.equal(id?.pid, 42); assert.equal(id?.peer, 43);
    });
  }
  test('selects the nearest agent, retaining the relay peer', async () => {
    const f = fixture();
    f.processes.set(43, '42 bun companion/src/index.ts');
    f.processes.set(42, '41 cline'); f.processes.set(41, '1 opencode');
    assert.deepEqual(await f.agents.identifyProcess(43), identity({ app: 'Cline', relay: true }));
    assert.equal(f.commands.length, 2);
  });
  for (const args of ['my-agent', 'bash', 'node -e "opencode"', 'pixel', 'clines', 'claude-helper']) {
    test(`does not attribute an unrelated process to its agent ancestor: ${args}`, async () => {
      const f = fixture(); f.processes.set(43, `42 ${args}`); f.processes.set(42, '1 opencode');
      assert.equal(await f.agents.identifyProcess(43), undefined);
      assert.equal(f.commands.length, 1);
    });
  }
  test('retains an unidentified relay without targeting its unrelated parent', async () => {
    const f = fixture(); f.processes.set(43, '42 bun browspark'); f.processes.set(42, '1 my-agent');
    assert.deepEqual(await f.agents.identifyProcess(43), identity({ app: '', pid: 0, relay: true }));
  });
  test('bounds cyclic ancestry and never queries init', async () => {
    const f = fixture(); f.processes.set(42, '42 npx server');
    assert.equal(await f.agents.identifyProcess(42), undefined);
    assert.equal(f.commands.length, 12);
    f.commands.length = 0; f.processes.set(42, '1 npx server');
    assert.equal(await f.agents.identifyProcess(42), undefined);
    assert.equal(f.commands.length, 1);
  });
  for (const output of ['', 'not a process row', new Error('ps unavailable')]) test(`handles failed process lookup: ${output}`, async () => {
    const f = fixture(); f.processes.set(42, output);
    assert.equal(await f.agents.identifyProcess(42), undefined);
  });
  test('does not invoke OS commands on Windows or for invalid process IDs', async () => {
    const windows = fixture('win32'); assert.equal(await windows.agents.identifyProcess(42), undefined);
    assert.deepEqual(windows.commands, []);
    const f = fixture();
    for (const pid of [-1, 0, 1, NaN]) assert.equal(await f.agents.identifyProcess(pid), undefined);
    assert.deepEqual(f.commands, []);
  });
});

describe('HTTP peer identification', () => {
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) test(`finds the owner of the local ${host} port`, async () => {
    const f = fixture();
    f.os.lsof = `p999\nn127.0.0.1:9223->127.0.0.1:54321\np42\nn${host}:54321->${host}:9223\n`;
    assert.equal(await f.agents.peerPid(54321), 42);
    assert.deepEqual(f.commands, [{ command: 'lsof', args: ['-nP', '-iTCP:54321', '-sTCP:ESTABLISHED', '-Fpn'], options: { timeout: 3000 } }]);
  });
  for (const output of [
    '', 'n127.0.0.1:54321->127.0.0.1:9223',
    'p999\nn127.0.0.1:54321->127.0.0.1:9223',
    'p1\nn127.0.0.1:54321->127.0.0.1:9223',
    'pbad\nn127.0.0.1:54321->127.0.0.1:9223',
    'p42\nn127.0.0.1:9223->127.0.0.1:54321',
    'p42\nn127.0.0.1:543210->127.0.0.1:9223',
    'p42\nn192.0.2.1:54321->127.0.0.1:9223',
    new Error('lsof unavailable'),
  ]) test(`ignores non-peer socket records: ${JSON.stringify(String(output))}`, async () => {
    const f = fixture(); f.os.lsof = output;
    assert.equal(await f.agents.peerPid(54321), undefined);
  });
  test('tracks socket ownership across multiple records and ignores the companion itself', async () => {
    const f = fixture();
    f.os.lsof = 'p999\nn127.0.0.1:54321->127.0.0.1:9223\np41\nn127.0.0.1:60000->127.0.0.1:9223\np42\nn127.0.0.1:60001->127.0.0.1:9223\nn127.0.0.1:54321->127.0.0.1:9223';
    assert.equal(await f.agents.peerPid(54321), 42);
  });
  test('skips lookup without a port or on Windows', async () => {
    for (const [platform, port] of [['linux', 0], ['win32', 54321]] as const) {
      const f = fixture(platform); assert.equal(await f.agents.peerPid(port), undefined);
      assert.deepEqual(f.commands, []);
    }
  });
});

describe('client identity', () => {
  for (const name of [' CLI ', 'mcp', 'client', 'mcp-client', 'AI SDK MCP Client', 'http', 'stdio', 'relay', 'probe', 'unknown', 'python', 'node', 'sdk']) {
    test(`replaces the generic name ${JSON.stringify(name)}`, () => {
      const f = fixture(), c = client(name), id = identity(); f.agents.applyIdentity(c, id);
      assert.equal(c.name, 'OpenCode'); assert.equal(c.process, id);
    });
  }
  test('preserves a specific matching product name and its process', () => {
    const f = fixture(), c = client('open-code-custom-client'), id = identity();
    f.agents.applyIdentity(c, id);
    assert.equal(c.name, 'open-code-custom-client'); assert.equal(c.process, id);
  });
  test('discards a mismatched ancestor while preserving its relay for disconnection', () => {
    const f = fixture(), c = client('my-script'), id = identity({ relay: true });
    f.agents.applyIdentity(c, id);
    assert.equal(c.name, 'my-script');
    assert.deepEqual(c.process, identity({ app: '', pid: 0, relay: true }));
    assert.equal(id.pid, 42, 'the supplied identity must not be mutated');
  });
  test('an absent lookup leaves existing identity intact and a relay-only lookup keeps the name', () => {
    const f = fixture(), c = client('cli', identity()), previous = c.process;
    f.agents.applyIdentity(c, undefined); assert.equal(c.process, previous); assert.equal(c.name, 'cli');
    const relay = identity({ app: '', pid: 0, relay: true });
    f.agents.applyIdentity(c, relay); assert.equal(c.process, relay); assert.equal(c.name, 'cli');
  });
});

describe('Stop all agents', () => {
  test('is a no-op with no clients', async () => {
    const f = fixture(); assert.deepEqual(await f.agents.stopAllAgents(), { killed: [], disconnected: [] });
    assert.deepEqual(f.signals, []); assert.deepEqual(f.timers, []);
  });
  test('terminates an agent once, closes every transport, and escalates only after a grace period', async () => {
    const f = fixture(), closed: string[] = [];
    for (const name of ['first', 'second']) {
      const c = client(name, identity()); c.disconnect = async () => { closed.push(name); }; f.clients.set(c.id, c);
    }
    assert.deepEqual(await f.agents.stopAllAgents(), { killed: ['first (pid 42)'], disconnected: ['second'] });
    assert.deepEqual(closed, ['first', 'second']); assert.deepEqual(f.signals, [[42, 'SIGTERM']]);
    assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 3000); assert.equal(f.timers[0].unref, true);
    f.timers[0].callback();
    assert.deepEqual(f.signals, [[42, 'SIGTERM'], [42, 0], [42, 'SIGKILL']]);
  });
  test('does not escalate when the agent has already exited', async () => {
    const f = fixture(); f.clients.set('agent', client('agent', identity()));
    await f.agents.stopAllAgents();
    f.os.kill = () => { throw new Error('ESRCH'); }; f.timers[0].callback();
    assert.deepEqual(f.signals, [[42, 'SIGTERM'], [42, 0]]);
  });
  test('survives signal failures and failed transport cleanup, then stops remaining clients', async () => {
    const f = fixture(), closed: string[] = [];
    f.os.kill = (pid) => { if (pid === 42) throw new Error('ESRCH'); };
    const first = client('gone', identity()); first.disconnect = async () => { closed.push('gone'); throw new Error('closed'); };
    const second = client('live', identity({ pid: 44 })); second.disconnect = async () => { closed.push('live'); };
    f.clients.set(first.id, first); f.clients.set(second.id, second);
    assert.deepEqual(await f.agents.stopAllAgents(), { killed: ['live (pid 44)'], disconnected: [] });
    assert.deepEqual(closed, ['gone', 'live']); assert.deepEqual(f.signals, [[42, 'SIGTERM'], [44, 'SIGTERM']]);
    f.os.kill = () => { throw new Error('EPERM'); };
    for (const timer of f.timers) assert.doesNotThrow(timer.callback);
  });
  for (const [name, id] of [
    ['desktop', identity({ gui: true })], ['unidentified', undefined], ['no-product', identity({ app: '' })],
    ['init', identity({ pid: 1 })], ['zero', identity({ pid: 0 })], ['negative', identity({ pid: -1 })],
    ['companion', identity({ pid: 999 })],
  ] as const) test(`only disconnects ${name}`, async () => {
    const f = fixture(), c = client(name, id); let closed = 0;
    c.disconnect = async () => { closed++; }; f.clients.set(c.id, c);
    assert.deepEqual(await f.agents.stopAllAgents(), { killed: [], disconnected: [name] });
    assert.equal(closed, 1); assert.deepEqual(f.signals, []); assert.deepEqual(f.timers, []);
  });
  for (const id of [identity({ relay: true, gui: true }), identity({ relay: true, app: '', pid: 0 })]) {
    test(`ends only the relay for ${id.gui ? 'desktop' : 'unidentified'} clients`, async () => {
      const f = fixture(); f.clients.set('relay', client('relay', id));
      assert.deepEqual(await f.agents.stopAllAgents(), { killed: ['relay (pid 43)'], disconnected: [] });
      assert.deepEqual(f.signals, [[43, 'SIGTERM']]);
    });
  }
  test('targets the identified agent behind a relay and handles absent disconnect callbacks', async () => {
    const f = fixture(); f.clients.set('agent', client('agent', identity({ relay: true })));
    await f.agents.stopAllAgents(); assert.deepEqual(f.signals, [[42, 'SIGTERM']]);
  });
  test('disconnect callbacks can remove clients without skipping the original targets', async () => {
    const f = fixture(), closed: string[] = [];
    for (const name of ['first', 'second']) {
      const c = client(name); c.disconnect = async () => { closed.push(name); f.clients.clear(); }; f.clients.set(name, c);
    }
    assert.deepEqual(await f.agents.stopAllAgents(), { killed: [], disconnected: ['first', 'second'] });
    assert.deepEqual(closed, ['first', 'second']);
  });
});
