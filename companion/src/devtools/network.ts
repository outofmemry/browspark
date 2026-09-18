// devtools_network: search, inspect, bodies, HAR, throttling, blocking, mocks, replay. Also the shared Fetch-interception
// rule engine that sources overrides reuse.
import { z } from 'zod';
import { type Ctx, tool, tabArg, matcher, paginate, pageArgs, clip } from '../context.ts';
import { saveArtifact } from '../artifacts.ts';
import type { NetReq, TabState } from './capture.ts';
import { applyFetch, policies, allowedByPolicy } from './intercept.ts';
import { version as VERSION } from '../../../package.json';

export const globToRegex = (glob: string) => new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

const PRESETS: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  slow3g: { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  fast3g: { offline: false, latency: 563, downloadThroughput: 180_000, uploadThroughput: 84_000 },
  '4g': { offline: false, latency: 170, downloadThroughput: 1_100_000, uploadThroughput: 700_000 },
};

/** (Re)apply Fetch interception for a tab from st.overrides (plus any navigation policy). */
export async function applyFetchRules(ctx: Ctx, tabId: number, st: TabState) {
  st.fetchEnabled = await applyFetch(ctx.sessions, tabId, [...st.overrides.keys()]);
}

export function installFetchHandler(ctx: Pick<Ctx, 'sessions' | 'capture'>) {
  ctx.sessions.on('cdp.event', async ({ tabId, method, params }) => {
    if (method !== 'Fetch.requestPaused') return;
    const st = ctx.capture.get(tabId);
    const url: string = params.request.url;
    const policy = policies.get(tabId);
    if (policy && !allowedByPolicy(url, policy)) {
      await ctx.sessions.cdp(tabId, 'Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      if (st) ctx.capture.push(st, 'policy.blocked', `blocked by domain policy: ${url}`, { url });
      return;
    }
    const rule = st && [...st.overrides.entries()].find(([pat]) => globToRegex(pat).test(url))?.[1];
    try {
      if (!rule || !st?.active) return await ctx.sessions.cdp(tabId, 'Fetch.continueRequest', { requestId: params.requestId });
      const headers = Object.entries({ 'content-type': rule.contentType ?? 'text/plain; charset=utf-8', 'access-control-allow-origin': '*', ...(rule.headers ?? {}) }).map(([name, value]) => ({ name, value }));
      await ctx.sessions.cdp(tabId, 'Fetch.fulfillRequest', { requestId: params.requestId, responseCode: rule.status ?? 200, responseHeaders: headers, body: Buffer.from(rule.body).toString('base64') });
      const r = params.networkId && st.netIndex.get(params.networkId);
      if (r) { r.mocked = rule.kind === 'mock'; r.overridden = rule.kind; }
      ctx.capture.push(st, 'Fetch.fulfilled', `${rule.kind} served for ${url}`, { url, kind: rule.kind });
    } catch (e) { if (st) ctx.capture.push(st, 'Fetch.error', `${(e as Error).message} for ${url}`); }
  });
}

const statusMatch = (spec: string | undefined, status?: number) => {
  if (!spec) return true; if (status === undefined) return false;
  return spec.split(',').some((s) => { s = s.trim(); if (/^\dxx$/i.test(s)) return Math.floor(status / 100) === Number(s[0]); if (s.includes('-')) { const [a, b] = s.split('-').map(Number); return status >= a && status <= b; } return status === Number(s); });
};
const summary = (r: NetReq) => ({
  id: r.id, ts: new Date(r.ts).toISOString(), method: r.method, url: clip(r.url, 300), status: r.status, type: r.type, mimeType: r.mimeType, bytes: r.encodedLength ?? r.dataLength, durationMs: r.durationMs,
  ...(r.fromCache && { fromCache: true }), ...(r.fromServiceWorker && { fromServiceWorker: true }), ...(r.failed && { failed: r.failed }), ...(r.blockedReason && { blockedReason: r.blockedReason }),
  ...(r.redirects.length && { redirects: r.redirects.length }), ...(r.mocked && { mocked: true }), ...(r.overridden && { overridden: r.overridden }),
  ...(r.ws && { wsFrames: r.ws.length }), ...(r.sse && { sseMessages: r.sse.length }), ...(r.initiator?.url && { initiator: `${r.initiator.url}:${r.initiator.line ?? ''}` }),
  ...(r.body?.missing && !r.body.text && { body: r.body.missing }),
});

export function registerNetworkTools(ctx: Ctx) {
  const { sessions, capture, page } = ctx;
  const tab = (id?: number) => sessions.resolve(id);

  tool(ctx, 'devtools_network', 'Inspect network activity collected in the session (preserved across reloads). Actions: search (filters below; searchIn picks url/headers/body/postData), get (one request: headers, timing, initiator stack, redirects, security), body (response body, JSON pretty-printed; fetched on demand if not captured), frames (WebSocket frames or SSE messages), har (export HAR artifact), throttle, cache, block/unblock, mock/unmock/rules, replay, clear.', {
    tabId: tabArg, action: z.enum(['search', 'get', 'body', 'frames', 'har', 'throttle', 'cache', 'block', 'unblock', 'mock', 'unmock', 'rules', 'replay', 'clear']).default('search'),
    query: z.string().optional().describe('Text or regex'), regex: z.boolean().optional(), searchIn: z.array(z.enum(['url', 'headers', 'body', 'postData'])).optional().describe('Default url'),
    method: z.string().optional(), status: z.string().optional().describe('e.g. "404", "4xx,5xx", "500-599"'), domain: z.string().optional(), type: z.array(z.string()).optional().describe('Resource types: Document, XHR, Fetch, Script, Stylesheet, Image, Font, WebSocket, Other…'),
    minDurationMs: z.number().optional(), failed: z.boolean().optional(), since: z.string().optional(), until: z.string().optional(),
    requestId: z.string().optional(), maxChars: z.number().int().optional().describe('Body chars to return, default 20000'), bodyOffset: z.number().int().optional(),
    preset: z.enum(['none', 'offline', 'slow3g', 'fast3g', '4g']).optional(), latencyMs: z.number().optional(), downloadKbps: z.number().optional(), uploadKbps: z.number().optional(),
    disabled: z.boolean().optional().describe('For cache: true disables the cache'), patterns: z.array(z.string()).optional().describe('URL globs for block/unblock, e.g. "*analytics*"'),
    pattern: z.string().optional().describe('URL glob for mock/unmock'), response: z.object({ status: z.number().int().optional(), body: z.string().optional(), json: z.unknown().optional(), contentType: z.string().optional(), headers: z.record(z.string(), z.string()).optional() }).optional(),
    overrides: z.object({ method: z.string().optional(), headers: z.record(z.string(), z.string()).optional(), body: z.string().optional(), url: z.string().optional() }).optional().describe('For replay'),
    ...pageArgs,
  }, async (a) => {
    const id = await tab(a.tabId);
    const st = capture.require(id);
    const req = (rid?: string) => { const r = rid && st.netIndex.get(rid); if (!r) throw new Error(`Unknown requestId ${rid}. Use search to find ids.`); return r; };
    switch (a.action) {
      case 'clear': capture.clear(id, 'network'); return 'Network log cleared';
      case 'get': {
        const r = req(a.requestId);
        return { ...summary(r), url: r.url, documentURL: r.documentURL, frameId: r.frameId, protocol: r.protocol, remoteIP: r.remoteIP, statusText: r.statusText, requestHeaders: r.requestHeaders, responseHeaders: r.responseHeaders,
          postData: r.postData ? clip(r.postData, 5000) : r.hasPostData ? '(present, not captured)' : undefined, redirects: r.redirects, timing: r.timing && Object.fromEntries(Object.entries(r.timing).filter(([, v]) => typeof v === 'number' && v >= 0).map(([k, v]) => [k, Math.round(v as number * 100) / 100])),
          initiator: r.initiator && { type: r.initiator.type, url: r.initiator.url, line: r.initiator.line, stack: r.initiator.stack?.slice(0, 15).map((f) => `${f.functionName} (${f.url}:${f.line}:${f.col})`) },
          securityState: r.securityState, securityDetails: r.securityDetails, body: r.body ? (r.body.text !== undefined ? { bytes: r.body.bytes, truncated: r.body.truncated, base64: r.body.base64, preview: clip(r.body.text, 500) } : r.body) : undefined };
      }
      case 'body': {
        const r = req(a.requestId);
        if (!r.body?.text && !r.body?.missing?.startsWith('unavailable')) await capture.fetchBody(st, r);
        if (!r.body?.text) return { requestId: r.id, url: r.url, status: 'missing', reason: r.body?.missing ?? 'no body' };
        let t = r.body.text;
        if (r.body.base64 && !/^(text|application\/(json|xml|javascript))/.test(r.mimeType ?? '')) return { requestId: r.id, url: r.url, mimeType: r.mimeType, bytes: r.body.bytes, note: 'binary body; base64 shown', base64: clip(t, a.maxChars ?? 20000) };
        if (r.body.base64) t = Buffer.from(t, 'base64').toString('utf8');
        let pretty = t;
        if (/json/.test(r.mimeType ?? '') || /^[\[{]/.test(t.trim())) { try { pretty = JSON.stringify(JSON.parse(t), null, 1); } catch {} }
        const off = a.bodyOffset ?? 0, max = a.maxChars ?? 20000;
        return { requestId: r.id, url: r.url, mimeType: r.mimeType, bytes: r.body.bytes, truncated: r.body.truncated, offset: off, returned: Math.min(max, pretty.length - off), totalChars: pretty.length, text: pretty.slice(off, off + max) };
      }
      case 'frames': {
        const r = req(a.requestId);
        const items = r.ws ? r.ws.map((f) => ({ ts: new Date(f.ts).toISOString(), dir: f.dir, opcode: f.opcode, payload: clip(f.payload, 2000) })) : (r.sse ?? []).map((m) => ({ ts: new Date(m.ts).toISOString(), event: m.event, id: m.eventId, data: clip(m.data, 2000) }));
        const qm = matcher(a.query, a.regex);
        return { requestId: r.id, url: r.url, kind: r.ws ? 'websocket' : 'sse', ...paginate(items.filter((x: any) => qm(x.payload ?? x.data)), a.offset, a.limit) };
      }
      case 'har': {
        const entries = st.network.filter((r) => r.status !== undefined || r.failed).map((r) => harEntry(r));
        const art = saveArtifact('har', 'har', JSON.stringify({ log: { version: '1.2', creator: { name: 'browspark', version: VERSION }, pages: [], entries } }, null, 1), new URL(st.network[0]?.url ?? 'http://x').host);
        return `Wrote ${entries.length} entries to ${art.path} (${art.bytes} bytes). Opens in Chrome DevTools > Network > import.`;
      }
      case 'throttle': {
        const cond = a.preset ? PRESETS[a.preset] : { offline: false, latency: a.latencyMs ?? 0, downloadThroughput: a.downloadKbps ? a.downloadKbps * 1024 / 8 : -1, uploadThroughput: a.uploadKbps ? a.uploadKbps * 1024 / 8 : -1 };
        await sessions.cdp(id, 'Network.emulateNetworkConditions', cond);
        if (a.preset !== 'none') st.cleanups.push(() => sessions.cdp(id, 'Network.emulateNetworkConditions', PRESETS.none));
        return `Network conditions: ${a.preset ?? JSON.stringify(cond)}`;
      }
      case 'cache': { await sessions.cdp(id, 'Network.setCacheDisabled', { cacheDisabled: !!a.disabled }); if (a.disabled) st.cleanups.push(() => sessions.cdp(id, 'Network.setCacheDisabled', { cacheDisabled: false })); return `Cache ${a.disabled ? 'disabled' : 'enabled'}`; }
      case 'block': case 'unblock': {
        const pats = a.patterns ?? (a.pattern ? [a.pattern] : []);
        if (!pats.length && a.action === 'block') throw new Error('patterns required');
        st.blocked = a.action === 'block' ? [...new Set([...st.blocked, ...pats])] : pats.length ? st.blocked.filter((p) => !pats.includes(p)) : [];
        await sessions.cdp(id, 'Network.setBlockedURLs', { urls: st.blocked });
        return `Blocked patterns: ${st.blocked.length ? st.blocked.join(', ') : '(none)'}`;
      }
      case 'mock': {
        if (!a.pattern) throw new Error('pattern required');
        const body = a.response?.json !== undefined ? JSON.stringify(a.response.json) : a.response?.body ?? '';
        st.overrides.set(a.pattern, { kind: 'mock', body, status: a.response?.status, contentType: a.response?.contentType ?? (a.response?.json !== undefined ? 'application/json' : undefined), headers: a.response?.headers });
        await applyFetchRules(ctx, id, st);
        return `Mock installed for ${a.pattern} → ${a.response?.status ?? 200} (${body.length} bytes). ${st.overrides.size} rule(s) active. Requests matching it never reach the server.`;
      }
      case 'unmock': { if (a.pattern) st.overrides.delete(a.pattern); else for (const [k, v] of st.overrides) if (v.kind === 'mock') st.overrides.delete(k); await applyFetchRules(ctx, id, st); return `${st.overrides.size} rule(s) remain`; }
      case 'rules': return { blocked: st.blocked, rules: [...st.overrides.entries()].map(([pattern, r]) => ({ pattern, kind: r.kind, status: r.status ?? 200, contentType: r.contentType, bytes: r.body.length })) };
      case 'replay': {
        const r = req(a.requestId);
        if (!/^https?:/.test(r.url)) throw new Error('Only http(s) requests can be replayed');
        const o = a.overrides ?? {};
        if (r.hasPostData && r.postData === undefined && o.body === undefined) throw new Error('The original request body was not captured; provide overrides.body to replay it.');
        const headers = Object.fromEntries(Object.entries({ ...r.requestHeaders, ...(o.headers ?? {}) }).filter(([k]) => !/^(:|host$|content-length$|cookie$|origin$|referer$|accept-encoding$|connection$|sec-|user-agent$)/i.test(k)));
        const bodyExpr = o.body !== undefined ? JSON.stringify(o.body) : r.postData !== undefined ? JSON.stringify(r.postData) : 'undefined';
        const res = await page.evaluate(id, `fetch(${JSON.stringify(o.url ?? r.url)}, { method: ${JSON.stringify(o.method ?? r.method)}, headers: ${JSON.stringify(headers)}, body: ${bodyExpr}, credentials: 'include' }).then(async (res) => ({ status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()), body: (await res.text()).slice(0, ${a.maxChars ?? 20000}) }))`);
        return { replayed: r.url, ...res };
      }
      default: {
        const qm = matcher(a.query, a.regex), dm = matcher(a.domain), where = a.searchIn ?? ['url'];
        const t0 = a.since ? new Date(isNaN(Number(a.since)) ? a.since : Number(a.since)).getTime() : 0, t1 = a.until ? new Date(isNaN(Number(a.until)) ? a.until : Number(a.until)).getTime() : Infinity;
        const hit = (r: NetReq) => !a.query || where.some((w) => w === 'url' ? qm(r.url) : w === 'headers' ? qm(JSON.stringify({ ...r.requestHeaders, ...r.responseHeaders })) : w === 'postData' ? qm(r.postData) : qm(r.body?.text));
        const items = st.network.filter((r) => hit(r) && (!a.method || r.method.toUpperCase() === a.method.toUpperCase()) && statusMatch(a.status, r.status) && (!a.domain || dm(safeHost(r.url))) && (!a.type || a.type.some((t) => t.toLowerCase() === r.type.toLowerCase())) && (a.minDurationMs === undefined || (r.durationMs ?? 0) >= a.minDurationMs) && (a.failed === undefined || !!r.failed === a.failed) && r.ts >= t0 && r.ts <= t1);
        const pg = paginate(items, a.offset, a.limit);
        const bodyNote = where.includes('body') ? { bodyCoverage: `${st.network.filter((r) => r.body?.text).length}/${st.network.length} requests have captured bodies${st.opts.bodies ? '' : ' (start the session with bodies:true to capture all)'}` } : {};
        return { collectionStart: new Date(st.startedAt).toISOString(), dropped: st.dropped.network, ...bodyNote, ...pg, items: pg.items.map(summary) };
      }
    }
  });
}

const safeHost = (u: string) => { try { return new URL(u).host; } catch { return ''; } };
function harEntry(r: NetReq) {
  const t = r.timing ?? {} as Record<string, number>;
  const d = (a: string, b: string) => (t[a] >= 0 && t[b] >= 0 ? Math.max(0, t[b] - t[a]) : -1);
  const hdr = (h?: Record<string, string>) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value }));
  const u = (() => { try { return new URL(r.url); } catch { return undefined; } })();
  return {
    startedDateTime: new Date(r.ts).toISOString(), time: r.durationMs ?? -1,
    request: { method: r.method, url: r.url, httpVersion: r.protocol ?? 'HTTP/1.1', cookies: [], headers: hdr(r.requestHeaders), queryString: u ? [...u.searchParams].map(([name, value]) => ({ name, value })) : [], headersSize: -1, bodySize: r.postData?.length ?? -1, ...(r.postData && { postData: { mimeType: r.requestHeaders['content-type'] ?? '', text: r.postData } }) },
    response: { status: r.status ?? 0, statusText: r.statusText ?? (r.failed ?? ''), httpVersion: r.protocol ?? 'HTTP/1.1', cookies: [], headers: hdr(r.responseHeaders), content: { size: r.dataLength, mimeType: r.mimeType ?? '', ...(r.body?.text && { text: r.body.text, ...(r.body.base64 && { encoding: 'base64' }) }) }, redirectURL: r.responseHeaders?.location ?? '', headersSize: -1, bodySize: r.encodedLength ?? -1, _error: r.failed },
    cache: {}, timings: { blocked: t.dnsStart > 0 ? t.dnsStart : -1, dns: d('dnsStart', 'dnsEnd'), connect: d('connectStart', 'connectEnd'), ssl: d('sslStart', 'sslEnd'), send: d('sendStart', 'sendEnd'), wait: d('sendEnd', 'receiveHeadersEnd'), receive: r.durationMs !== undefined && t.receiveHeadersEnd >= 0 ? Math.max(0, r.durationMs - t.receiveHeadersEnd) : -1 },
    serverIPAddress: r.remoteIP, _resourceType: r.type, _initiator: r.initiator?.url, _fromCache: r.fromCache, _mocked: r.mocked,
  };
}
