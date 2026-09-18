import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { disabledTools } from '../src/context.ts';
import { isConnectionGraph, PROTOCOL_VERSION, type ConnectionGraph, type Req, type ToolInfo } from '../../shared/protocol.ts';

test('HTTP-only startup serves the full catalog and graph before an agent connects', async () => {
  const companion = spawn(process.execPath, [fileURLToPath(new URL('../src/index.ts', import.meta.url)), '--http-only', '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, BROWSPARK_HTTP_GRACE_MS: '500' } });
  let ws: WebSocket | undefined;
  const client = new Client({ name: 'HTTP startup test', version: '0' });
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`Companion did not start: ${output}`)), 5000);
      companion.once('error', (error) => { clearTimeout(timer); reject(error); });
      companion.stderr!.on('data', (chunk) => {
        output += chunk.toString();
        const match = /ready on (ws:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    ws = new WebSocket(url);
    const catalogs: ToolInfo[][] = [];
    let graph: ConnectionGraph | undefined;
    const policy = (haveCatalog: boolean) => ws!.send(JSON.stringify({ event: 'tools.policy', params: { disabled: [...disabledTools], haveCatalog, graph: true } }));
    ws.on('message', (data) => {
      const req = JSON.parse(data.toString()) as Req;
      if (req.method === 'tools.catalog') {
        const { tools } = req.params as { tools: ToolInfo[] };
        catalogs.push(tools);
        // Match the real worker, but bound a broken empty-catalog feedback loop.
        if (catalogs.length < 10) policy(tools.length > 0);
      } else if (req.method === 'graph.state') graph = req.params as ConnectionGraph;
      ws!.send(JSON.stringify({ id: req.id, result: { received: true } }));
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ event: 'hello', params: { version: PROTOCOL_VERSION, extensionVersion: '0.6.0', instanceId: 'http-startup', browserSessionId: 'test', browser: 'Test browser' } }));
    policy(false);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(catalogs[0]?.length, 43, 'catalog must be ready without an initialized MCP client');
    assert.ok(catalogs.every(tools => tools.length === 43));
    assert.ok(catalogs.length <= 2, `catalog feedback loop sent ${catalogs.length} catalogs`);
    assert.ok(isConnectionGraph(graph));
    assert.equal(graph.agents.length, 0, 'an eager catalog must not create a visible agent');
    assert.equal(graph.browsers[0].name, 'Test browser');
    transport = new StreamableHTTPClientTransport(new URL(url.replace('ws:', 'http:') + '/mcp'));
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 43);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.deepEqual(graph.agents.map(agent => agent.name), ['HTTP startup test']);
    // A client that vanishes without DELETE (crash, killed test run) must leave the graph once its event stream is gone.
    const mcpUrl = url.replace('ws:', 'http:') + '/mcp', sessionId = transport.sessionId!;
    await transport.close(); transport = undefined;
    // ...but not while it keeps calling tools without a stream: POSTs outlasting the grace period keep it alive.
    for (let i = 0; i < 6; i++) {
      const r = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/list' }) });
      assert.equal(r.status, 200); await r.text();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(graph.agents.length, 1, 'a streamless client that keeps POSTing stays in the graph');
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(graph.agents.length, 0, 'a vanished HTTP client is removed after the grace period');
  } finally {
    await transport?.terminateSession().catch(() => {});
    await client.close();
    ws?.terminate();
    if (companion.pid && companion.exitCode === null && companion.signalCode === null) {
      const exited = once(companion, 'exit');
      companion.kill();
      await exited;
    }
  }
}, 15_000);
