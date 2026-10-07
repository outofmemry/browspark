#!/usr/bin/env bun
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge, type BridgeConnection } from './bridge.ts';
import { Sessions } from './session.ts';
import { Page } from './page.ts';
import { Capture } from './devtools/capture.ts';
import { installLiveView } from './live.ts';
import { installConnectionGraph } from './graph.ts';
import { updaterFromEnv } from './updates.ts';
import { applyIdentity, identifyProcess, peerPid, stopAllAgents } from './agents.ts';
import { type Ctx, type ClientState, clients, toolCatalog, setDisabledTools, disabledTools, devGate, combinedPolicy } from './context.ts';
import { version as VERSION } from '../../package.json';
import type { ToolPolicy } from '../../shared/protocol.ts';
import { registerBrowserTools } from './tools.ts';
import { registerSessionTools } from './devtools/session.ts';
import { registerConsoleTools } from './devtools/console.ts';
import { registerNetworkTools, installFetchHandler } from './devtools/network.ts';
import { registerSourcesTools } from './devtools/sources.ts';
import { registerDebuggerTools } from './devtools/debugger.ts';
import { registerElementsTools } from './devtools/elements.ts';
import { registerProfilingTools } from './devtools/profiling.ts';
import { registerApplicationTools } from './devtools/application.ts';
import { registerEnvironmentTools } from './devtools/environment.ts';
import { registerLighthouseTools } from './devtools/lighthouse.ts';
import { registerRecorderTools } from './devtools/recorder.ts';
import { registerAuditTools } from './devtools/audit.ts';
import { DEFAULT_PORT } from '../../shared/protocol.ts';

const portArg = process.argv.indexOf('--port');
const port = portArg > -1 ? Number(process.argv[portArg + 1]) : Number(process.env.BROWSPARK_PORT ?? DEFAULT_PORT);

const bridge = new Bridge(port);
const httpOnly = process.argv.includes('--http-only');
const upstreamUrl = `http://127.0.0.1:${port}/mcp`;
const portTaken = (e: any) => e?.code === 'EADDRINUSE' || /in use|EADDRINUSE/i.test(String(e?.message));
// false: another companion already owns the port (another agent launched it). We become a thin stdio relay to it, so
// every client shares one companion and its connected browsers; see relayTo() at the bottom.
const owner = await bridge.listen().then(() => true, (e) => { if (!portTaken(e)) { console.error(`browspark: cannot listen on 127.0.0.1:${port}: ${e.message}`); process.exit(1); } return false; });

const sendCatalog = (browserId: string) => bridge.request('tools.catalog', { tools: toolCatalog, version: VERSION }, undefined, browserId).catch((e) => console.error(`browspark: could not send tool catalog: ${e.message}`));
const updatePolicy = () => {
  const connections = bridge.connections();
  if (!connections.length) return; // Retain the last saved restrictions until an extension reconnects.
  const p = combinedPolicy(connections.map(c => c.policy ?? { disabled: [...disabledTools], devMode: 'auto' }));
  setDisabledTools(p.disabled); devGate.policy = p.devMode ?? 'auto'; page.overlay.enabled = p.overlay !== false;
};
bridge.on('connected', (c: BridgeConnection) => { updatePolicy(); console.error(`browspark: extension connected: ${c.id} (${c.browser})`); sendCatalog(c.id); });
bridge.on('tools.policy', (p: ToolPolicy, c: BridgeConnection) => { updatePolicy(); if (!p.haveCatalog) sendCatalog(c.id); });
bridge.on('agents.stop', (c: BridgeConnection) => {
  console.error(`browspark: ${c.id} asked to stop all agents`);
  void stopAllAgents().then(({ killed, disconnected }) => console.error(`browspark: stopped ${killed.length ? killed.join(', ') : 'no agent processes'}${disconnected.length ? `; disconnected ${disconnected.join(', ')}` : ''}`));
});
bridge.on('disconnected', (c: BridgeConnection) => { updatePolicy(); console.error(`browspark: extension disconnected: ${c.id}`); });

const sessions = new Sessions(bridge);
const page = new Page(sessions), capture = new Capture(sessions);
/** Each MCP transport gets its own McpServer; browser state, capture buffers, and the tool registry are shared. */
let clientSeq = 0;
const serverClients = new WeakMap<McpServer, ClientState>();
/**
 * Create an unconnected MCP server and register its client and tools, using `label` until client identification.
 * Initialization waits for any process lookup to settle; closing removes the client and starts inspection cleanup.
 */
function buildServer(label: string): McpServer {
  const server = new McpServer({ name: 'browspark', version: VERSION }, { instructions: 'Prefer background-tab interaction. Keep the assigned tabId and pass it to subsequent tools; do not activate tabs or focus windows just to interact. Work in background is ON by default in the extension. Never bypass it with window.focus(), popups, or raw protocol commands. Verify input effects with a fresh snapshot. If an operation cannot work in the background, ask the user to select the agent tab or temporarily disable Settings → Work in background. Check page state before retrying to avoid duplicate actions.' });
  const client: ClientState = { id: `c${++clientSeq}`, name: label, ownedTabs: new Set() };
  clients.set(client.id, client);
  serverClients.set(server, client);
  const ctx: Ctx = { server, sessions, page, capture, client, registry: new Map() };
  for (const reg of [registerBrowserTools, registerSessionTools, registerConsoleTools, registerNetworkTools, registerSourcesTools, registerDebuggerTools, registerElementsTools, registerProfilingTools, registerApplicationTools, registerEnvironmentTools, registerLighthouseTools, registerRecorderTools, registerAuditTools]) reg(ctx);
  // Name the agent after what the MCP client calls itself (opencode, claude-code, gemini…); a relay passes the real name through.
  // Generic names (cli, mcp) are replaced by the product found in the client's process tree before the graph shows it.
  server.server.oninitialized = () => {
    const v = server.server.getClientVersion(); if (v?.name) client.name = v.name.replace(/^relay:/, '');
    void (client.identify ?? Promise.resolve(undefined)).then((id) => applyIdentity(client, id), () => {}).finally(() => {
      client.initialized = true;
      console.error(`browspark: agent connected: ${client.name}${client.process?.app ? ` (pid ${client.process.pid})` : ''}`);
    });
  };
  server.server.onclose = () => { clients.delete(client.id); void capture.release(client.id).catch((e) => console.error(`browspark: inspection cleanup failed for ${client.name}: ${e.message}`)); console.error(`browspark: agent disconnected: ${client.name}`); };
  return server;
}
installFetchHandler({ sessions, capture });
const updater = updaterFromEnv(VERSION);
bridge.updateHandler = (ws, origin) => updater.handleSocket(ws, origin);
installLiveView(bridge, sessions);
const stopGraph = installConnectionGraph(bridge, sessions);

// MCP over Streamable HTTP for clients that take a URL (web agents, hosted assistants). Localhost only; the bridge
// refuses requests that carry a web page's Origin.
const httpSessions = new Map<string, StreamableHTTPServerTransport>();
// A client that dies without DELETE would stay in the graph forever: SDK clients hold a GET event stream open, so
// treat that stream dropping (and not returning within the grace period) as the client having gone away. Once a
// session has had a stream, its POSTs count too, so a client that keeps calling tools without a stream stays alive.
const httpStreams = new Map<string, { open: number; gone?: ReturnType<typeof setTimeout> }>();
const HTTP_STREAM_GRACE_MS = Number(process.env.BROWSPARK_HTTP_GRACE_MS ?? 60_000);
// Populate the extension's catalog before any agent connects; reuse this server for the first HTTP client.
let firstHttpServer = owner && httpOnly ? buildServer('http') : undefined;
/**
 * Route MCP HTTP requests. Without a known session, create a transport on POST or reply 400 for other methods.
 * Start peer identification for new clients and expire inactive sessions after their event stream has closed.
 * Connection and request-handling rejections propagate to the bridge's HTTP error handler.
 */
bridge.mcpHandler = async (req, res) => {
  const sid = req.headers['mcp-session-id'];
  let transport = typeof sid === 'string' ? httpSessions.get(sid) : undefined;
  if (!transport) {
    if (req.method !== 'POST') { res.statusCode = 400; res.end('no MCP session; initialize with a POST first'); return; }
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { httpSessions.set(id, t); console.error(`browspark: http client session ${id.slice(0, 8)}`); } });
    t.onclose = () => { if (t.sessionId) { httpSessions.delete(t.sessionId); clearTimeout(httpStreams.get(t.sessionId)?.gone); httpStreams.delete(t.sessionId); } };
    const server = firstHttpServer ?? buildServer('http');
    firstHttpServer = undefined;
    const client = serverClients.get(server)!;
    // Look the peer up now, while its socket is certainly open.
    const remotePort = req.socket.remotePort;
    client.identify = peerPid(remotePort ?? 0).then((pid) => pid ? identifyProcess(pid) : undefined);
    client.disconnect = () => t.close();
    await server.connect(t);
    transport = t;
  }
  if (typeof sid === 'string' && (req.method === 'GET' || httpStreams.has(sid))) {
    const s = httpStreams.get(sid) ?? { open: 0 }; httpStreams.set(sid, s); s.open++; clearTimeout(s.gone);
    // The identity check skips re-arming after the session closed (DELETE, or the grace timer itself).
    const t = transport; res.once('close', () => { if (--s.open === 0 && httpStreams.get(sid) === s) s.gone = setTimeout(() => { console.error(`browspark: http client session ${sid.slice(0, 8)} went away`); void t.close(); }, HTTP_STREAM_GRACE_MS); });
  }
  await transport.handleRequest(req, res);
};

let relayTransport: StreamableHTTPClientTransport | undefined;
let closing = false;
const shutdown = async () => {
  if (closing) return; closing = true;
  setTimeout(() => process.exit(0), 5000).unref();
  await relayTransport?.terminateSession().catch(() => {});
  stopGraph(); bridge.close(); await sessions.closeAll();
  process.exit(0);
};
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
if (!httpOnly) process.stdin.on('close', shutdown);

if (owner) {
  if (!httpOnly) {
    const server = buildServer('stdio');
    serverClients.get(server)!.identify = identifyProcess(process.ppid);
    await server.connect(new StdioServerTransport());
  }
  console.error(`browspark: ready on ws://127.0.0.1:${bridge.port}; MCP over HTTP at ${upstreamUrl}`);
} else await relayTo();

/**
 * Attach a stdio relay that forwards tool requests to the existing companion and can take over its port.
 * Resolve when the stdio transport connects; upstream connection failures surface through tool requests.
 * Stdio connection failures reject this call.
 */
async function relayTo() {
  const relay = new Server({ name: 'browspark', version: VERSION }, { capabilities: { tools: {} } });
  // Connect upstream only once we know who the downstream client is, so the owner can name this agent correctly.
  const who = () => relay.getClientVersion()?.name ?? 'relay';
  let upstream: Promise<Client> | undefined, tookOver = false;
  /**
   * Return an upstream client, taking over the port locally if the companion is unavailable and the port is free.
   * Try up to 10 times with 500 ms pauses; throw if exhausted or if an in-process connection fails after takeover.
   */
  const connect = async (): Promise<Client> => {
    let last: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      const c = new Client({ name: `relay:${who()}`, version: '0' });
      const t = new StreamableHTTPClientTransport(new URL(upstreamUrl));
      try { await c.connect(t); relayTransport = t; return c; } catch (e) { last = e; }
      // Nobody answers: the owner's client quit and released the port. Take it over and serve in-process, so this
      // agent keeps working and later clients relay to us. While the owner is still shutting down, listen() fails; retry.
      if (await bridge.listen().then(() => true, () => false)) {
        tookOver = true; relayTransport = undefined;
        const [a, b] = InMemoryTransport.createLinkedPair();
        const server = buildServer(who());
        serverClients.get(server)!.identify = identifyProcess(process.ppid);
        await server.connect(b);
        await c.connect(a);
        console.error(`browspark: the companion on port ${port} went away; took the port over. Ready on ws://127.0.0.1:${port}`);
        return c;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`port ${port} is in use but the companion there did not answer (${(last as Error)?.message}). Stop the other process or use --port.`);
  };
  const forward = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    upstream ??= connect().catch((e) => { upstream = undefined; throw e; });
    try { return await fn(await upstream); } catch (e) {
      if (tookOver || !/socket|connect|closed|fetch|ECONN/i.test(String((e as Error)?.message))) throw e;
      console.error(`browspark: the companion on port ${port} stopped answering; reconnecting`);
      void upstream.then((c) => c.close()).catch(() => {});
      upstream = connect().catch((err) => { upstream = undefined; throw err; });
      return fn(await upstream);
    }
  };
  relay.oninitialized = () => { void forward(async () => {}).catch(() => {}); };
  relay.setRequestHandler(ListToolsRequestSchema, () => forward((c) => c.listTools()));
  relay.setRequestHandler(CallToolRequestSchema, (req) => forward((c) => c.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }) as any));
  relay.onclose = shutdown;
  await relay.connect(new StdioServerTransport());
  console.error(`browspark: relaying stdio to the companion already running on port ${port}`);
}
