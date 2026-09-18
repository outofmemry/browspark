// devtools_performance (tracing), devtools_profile (CPU sampling), devtools_memory (heap), devtools_coverage.
import { z } from 'zod';
import { type Ctx, tool, tabArg, matcher, paginate, pageArgs, clip } from '../context.ts';
import { saveArtifact, readArtifact, listArtifacts } from '../artifacts.ts';

interface Recording { chunks: any[]; done: boolean; startedAt: number; screenshots: boolean }
const buffers = new WeakMap<Ctx['sessions'], { tracing: Map<number, Recording>; heapChunks: Map<number, string[]> }>();
const MAX_SUMMARIES = 50;
const summaries = new Map<string, any>(); // artifact id -> summary (perf, profile, heap)
const setSummary = (id: string, s: any) => {
  if (summaries.size >= MAX_SUMMARIES) {
    const oldest = summaries.keys().next().value;
    if (oldest) summaries.delete(oldest);
  }
  summaries.set(id, s);
};

const TRACE_CATEGORIES = ['-*', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'v8.execute', 'blink.user_timing', 'loading', 'latencyInfo', 'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-v8.cpu_profiler'];
const CAT: Record<string, string> = { EvaluateScript: 'scripting', FunctionCall: 'scripting', TimerFire: 'scripting', EventDispatch: 'scripting', XHRLoad: 'scripting', XHRReadyStateChange: 'scripting', 'v8.compile': 'scripting', 'V8.GCScavenger': 'gc', MajorGC: 'gc', MinorGC: 'gc', GCEvent: 'gc', RunMicrotasks: 'scripting', Layout: 'rendering', UpdateLayoutTree: 'rendering', RecalculateStyles: 'rendering', HitTest: 'rendering', PrePaint: 'rendering', 'ScheduleStyleRecalculation': 'rendering', Paint: 'painting', CompositeLayers: 'painting', RasterTask: 'painting', PaintImage: 'painting', 'Decode Image': 'painting', ParseHTML: 'loading', ParseAuthorStyleSheet: 'loading', ResourceSendRequest: 'network', ResourceReceiveResponse: 'network', ResourceFinish: 'network', ResourceReceivedData: 'network' };

function summarizeTrace(events: any[]) {
  const byCat: Record<string, number> = {}, byName: Record<string, { total: number; count: number }> = {};
  const longTasks: any[] = [], vitals: Record<string, unknown> = {}, marks: string[] = [];
  let t0 = Infinity, t1 = 0; const urls = new Map<string, number>();
  for (const e of events) {
    if (typeof e.ts === 'number' && e.ph !== 'M') { t0 = Math.min(t0, e.ts); t1 = Math.max(t1, e.ts + (e.dur ?? 0)); }
    if (e.ph === 'X' && e.dur) {
      const cat = CAT[e.name]; if (cat) byCat[cat] = (byCat[cat] ?? 0) + e.dur;
      const n = byName[e.name] ??= { total: 0, count: 0 }; n.total += e.dur; n.count++;
      if (e.name === 'RunTask' && e.dur > 50_000) longTasks.push(e);
      if (e.name === 'FunctionCall' || e.name === 'EvaluateScript') { const u = e.args?.data?.url; if (u) urls.set(u, (urls.get(u) ?? 0) + e.dur); }
    }
    if (e.name === 'largestContentfulPaint::Candidate') vitals.LCP = { ms: Math.round((e.ts - t0) / 1000), size: e.args?.data?.size, type: e.args?.data?.type };
    if (e.name === 'firstContentfulPaint') vitals.FCP = { ms: Math.round((e.ts - t0) / 1000) };
    if (e.name === 'LayoutShift' && e.args?.data && !e.args.data.had_recent_input) vitals.CLS = { value: Math.round((((vitals.CLS as any)?.value ?? 0) + e.args.data.score) * 1000) / 1000 };
    if (e.cat?.includes('blink.user_timing') && (e.ph === 'R' || e.ph === 'I' || e.ph === 'b')) marks.push(`${e.name} @${Math.round((e.ts - t0) / 1000)}ms`);
  }
  const ms = (us: number) => Math.round(us / 100) / 10;
  const durationMs = t1 > t0 ? ms(t1 - t0) : 0;
  const children = (task: any) => events.filter((x) => x.ph === 'X' && x.ts >= task.ts && x.ts + (x.dur ?? 0) <= task.ts + task.dur && x !== task && CAT[x.name]).sort((a, b) => b.dur - a.dur).slice(0, 3).map((x) => `${x.name}${x.args?.data?.functionName ? ' ' + x.args.data.functionName : ''}${x.args?.data?.url ? ' (' + clip(x.args.data.url, 60) + ')' : ''} ${ms(x.dur)}ms`);
  return {
    durationMs, events: events.length, timeByCategoryMs: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, ms(v)])),
    topEvents: Object.entries(byName).sort((a, b) => b[1].total - a[1].total).slice(0, 12).map(([name, v]) => ({ name, totalMs: ms(v.total), count: v.count })),
    longTasks: { count: longTasks.length, totalMs: ms(longTasks.reduce((a, t) => a + t.dur, 0)), worst: longTasks.sort((a, b) => b.dur - a.dur).slice(0, 8).map((t) => ({ atMs: ms(t.ts - t0), durationMs: ms(t.dur), top: children(t) })) },
    scriptTimeByUrlMs: [...urls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([u, d]) => ({ url: clip(u, 120), ms: ms(d) })),
    vitals, userTimings: marks.slice(0, 30),
  };
}

function analyzeCpuProfile(p: any, limit = 20) {
  const nodes = new Map<number, any>(); for (const n of p.nodes) nodes.set(n.id, { ...n, self: 0, total: 0 });
  const sampleCount = new Map<number, number>();
  for (const id of p.samples) sampleCount.set(id, (sampleCount.get(id) ?? 0) + 1);
  const totalUs = p.endTime - p.startTime, avg = totalUs / Math.max(1, p.samples.length);
  for (const [id, c] of sampleCount) nodes.get(id)!.self = c * avg;
  const parent = new Map<number, number>(); for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const totalOf = (id: number): number => { const n = nodes.get(id)!; if (n.total) return n.total; n.total = n.self + (n.children ?? []).reduce((a: number, c: number) => a + totalOf(c), 0); return n.total; };
  for (const n of p.nodes) if (!parent.has(n.id)) totalOf(n.id);
  const key = (n: any) => `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url ? clip(n.callFrame.url.replace(/^.*\//, ''), 40) + ':' + (n.callFrame.lineNumber + 1) : ''}`.trim();
  const bottomUp = new Map<string, { self: number; total: number; url?: string }>();
  for (const n of nodes.values()) { const k = key(n); const b = bottomUp.get(k) ?? { self: 0, total: 0, url: n.callFrame.url }; b.self += n.self; b.total = Math.max(b.total, n.total); bottomUp.set(k, b); }
  const ms = (us: number) => Math.round(us / 100) / 10;
  const roots = p.nodes.filter((n: any) => !parent.has(n.id));
  const tree: string[] = [];
  const walk = (id: number, depth: number) => { const n = nodes.get(id)!; if (n.total < totalUs * 0.01 || depth > 12 || tree.length > 80) return; tree.push(`${'  '.repeat(depth)}${key(n)} — total ${ms(n.total)}ms, self ${ms(n.self)}ms`); for (const c of [...(n.children ?? [])].sort((a: number, b: number) => nodes.get(b)!.total - nodes.get(a)!.total)) walk(c, depth + 1); };
  for (const r of roots) walk(r.id, 0);
  return { durationMs: ms(totalUs), samples: p.samples.length, bottomUp: [...bottomUp.entries()].filter(([k]) => !/^\((root|program|idle|garbage collector)\)/.test(k)).sort((a, b) => b[1].self - a[1].self).slice(0, limit).map(([fn, v]) => ({ function: fn, selfMs: ms(v.self), totalMs: ms(v.total), url: v.url && clip(v.url, 100) })), callTree: tree };
}

function summarizeHeap(json: string, limit = 40) {
  const snap = JSON.parse(json);
  const nf: string[] = snap.snapshot.meta.node_fields, types: string[] = snap.snapshot.meta.node_types[0], nodes: number[] = snap.nodes, strings: string[] = snap.strings;
  const N = nf.length, iType = nf.indexOf('type'), iName = nf.indexOf('name'), iSize = nf.indexOf('self_size'), iDet = nf.indexOf('detachedness');
  const byClass = new Map<string, { count: number; size: number }>();
  let total = 0, detached = 0, count = 0;
  for (let i = 0; i < nodes.length; i += N) {
    const t = types[nodes[i + iType]], name = strings[nodes[i + iName]], size = nodes[i + iSize];
    const cls = t === 'object' || t === 'native' ? name : t === 'closure' ? '(closure)' : t === 'string' || t === 'concatenated string' || t === 'sliced string' ? '(string)' : t === 'array' ? '(array)' : t === 'code' ? '(compiled code)' : t === 'regexp' ? '(regexp)' : `(${t})`;
    const c = byClass.get(cls) ?? { count: 0, size: 0 }; c.count++; c.size += size; byClass.set(cls, c);
    total += size; count++;
    if ((iDet >= 0 && nodes[i + iDet] === 2) || /^Detached /.test(name)) detached++;
  }
  return { nodes: count, totalBytes: total, detachedNodes: detached, classes: [...byClass.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, limit).map(([name, v]) => ({ name, count: v.count, bytes: v.size })), byClass: Object.fromEntries(byClass) };
}

function retainersOf(json: string, className: string, limit = 15) {
  const snap = JSON.parse(json);
  const nf: string[] = snap.snapshot.meta.node_fields, ef: string[] = snap.snapshot.meta.edge_fields, types: string[] = snap.snapshot.meta.node_types[0], etypes: string[] = snap.snapshot.meta.edge_types[0];
  const nodes: number[] = snap.nodes, edges: number[] = snap.edges, strings: string[] = snap.strings;
  const N = nf.length, E = ef.length, iType = nf.indexOf('type'), iName = nf.indexOf('name'), iEdges = nf.indexOf('edge_count'), eType = ef.indexOf('type'), eName = ef.indexOf('name_or_index'), eTo = ef.indexOf('to_node');
  const nodeCount = nodes.length / N;
  if (nodeCount > 3_000_000) throw new Error('Snapshot too large to index retainers in-process; open it in DevTools Memory panel');
  const targets = new Set<number>();
  for (let i = 0; i < nodes.length; i += N) if (strings[nodes[i + iName]] === className && (types[nodes[i + iType]] === 'object' || types[nodes[i + iType]] === 'native')) targets.add(i);
  if (!targets.size) throw new Error(`No objects of class ${className}`);
  const agg = new Map<string, number>(); let e = 0;
  for (let i = 0; i < nodes.length; i += N) {
    const cnt = nodes[i + iEdges];
    for (let k = 0; k < cnt; k++, e += E) {
      const to = edges[e + eTo]; if (!targets.has(to)) continue;
      const et = etypes[edges[e + eType]]; if (et === 'weak' || et === 'shortcut') continue;
      const en = et === 'element' || et === 'hidden' ? `[${edges[e + eName]}]` : strings[edges[e + eName]];
      const from = `${types[nodes[i + iType]] === 'object' || types[nodes[i + iType]] === 'native' ? strings[nodes[i + iName]] : '(' + types[nodes[i + iType]] + ')'} .${en}`;
      agg.set(from, (agg.get(from) ?? 0) + 1);
    }
  }
  return { className, instances: targets.size, retainedBy: [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([path, n]) => ({ path, edges: n })) };
}

const mergeRanges = (rs: { s: number; e: number }[]) => { rs.sort((a, b) => a.s - b.s); const out: { s: number; e: number }[] = []; for (const r of rs) { const l = out.at(-1); if (l && r.s <= l.e) l.e = Math.max(l.e, r.e); else out.push({ ...r }); } return out; };

export function registerProfilingTools(ctx: Ctx) {
  const { sessions, capture, page } = ctx;
  const tab = (id?: number) => sessions.resolve(id);
  if (!buffers.has(sessions)) {
    const tracing = new Map<number, Recording>(), heapChunks = new Map<number, string[]>();
    buffers.set(sessions, { tracing, heapChunks });
    // Sessions is shared by every MCP client. Each protocol event must be appended once.
    sessions.on('cdp.event', ({ tabId, method, params, sessionId }) => {
      if (sessionId) return;
      if (method === 'Tracing.dataCollected') tracing.get(tabId)?.chunks.push(...params.value);
      else if (method === 'Tracing.tracingComplete') { const r = tracing.get(tabId); if (r) r.done = true; }
      else if (method === 'HeapProfiler.addHeapSnapshotChunk') heapChunks.get(tabId)?.push(params.chunk);
    });
  }
  const { tracing, heapChunks } = buffers.get(sessions)!;
  const rememberRecording = (id: number, kind: string, stop: () => Promise<unknown>) => {
    const st = capture.get(id); if (!st) return;
    const rec = { kind, startedAt: Date.now(), done: false };
    st.recordings.push(rec);
    st.cleanups.push(async () => { if (!rec.done) { await stop(); rec.done = true; } });
  };
  const finishRecording = (id: number, kind: string) => {
    const rec = capture.get(id)?.recordings.find((r) => r.kind === kind && !r.done);
    if (rec) rec.done = true;
    return rec;
  };
  const endTrace = async (id: number, rec: Recording) => {
    if (!rec.done) await sessions.cdp(id, 'Tracing.end');
    for (let i = 0; i < 300 && !rec.done; i++) await new Promise((r) => setTimeout(r, 100));
    if (!rec.done) throw new Error('Tracing.tracingComplete never arrived (30s)');
    tracing.delete(id);
  };
  const artifactOf = (idOrPath?: string) => { if (!idOrPath) throw new Error('recordingId (artifact id or path) required'); return readArtifact(idOrPath); };

  tool(ctx, 'devtools_performance', 'Performance panel. start/stop a trace recording (Chrome trace format, opens in DevTools Performance and Perfetto). stop returns a summary: time by category, long tasks with their heaviest children, script time by URL, observed LCP/FCP/CLS, user timings. search finds trace events by name/args. compare diffs two recordings. vitals reads live Web Vitals (LCP, CLS, INP, FID, FCP, TTFB, long tasks) observed in the page since the session started. metrics returns Chrome runtime metrics.', {
    tabId: tabArg, action: z.enum(['start', 'stop', 'search', 'compare', 'vitals', 'metrics', 'list']),
    categories: z.array(z.string()).optional().describe('Trace categories (default: devtools timeline + v8)'), screenshots: z.boolean().optional(),
    reload: z.boolean().optional().describe('start: reload the page right after tracing begins (page-load profile)'),
    recordingId: z.string().optional(), other: z.string().optional().describe('compare: second recording'), query: z.string().optional(), regex: z.boolean().optional(), minDurationMs: z.number().optional(), ...pageArgs,
  }, async (a) => {
    const id = await tab(a.tabId);
    switch (a.action) {
      case 'start': {
        if (tracing.get(id) && !tracing.get(id)!.done) throw new Error('A trace is already recording on this tab; stop it first.');
        const cats = a.categories ?? [...TRACE_CATEGORIES, ...(a.screenshots ? ['disabled-by-default-devtools.screenshot'] : [])];
        const rec = { chunks: [], done: false, startedAt: Date.now(), screenshots: !!a.screenshots };
        tracing.set(id, rec);
        try {
          await sessions.cdp(id, 'Tracing.start', { traceConfig: { includedCategories: cats.filter((c) => !c.startsWith('-')), excludedCategories: cats.filter((c) => c.startsWith('-')).map((c) => c.slice(1)) }, transferMode: 'ReportEvents', bufferUsageReportingInterval: 0 });
        } catch (e) { tracing.delete(id); throw e; }
        rememberRecording(id, 'trace', async () => { try { if (tracing.get(id) === rec) await endTrace(id, rec); } finally { if (tracing.get(id) === rec) tracing.delete(id); } });
        if (a.reload) await page.navigate(id, 'reload');
        return `Tracing started on tab ${id}${a.reload ? ' and page reloaded' : ''}. Perform the interaction, then stop. Note: raw traces can include browser-wide activity, not strictly this tab.`;
      }
      case 'stop': {
        const rec = tracing.get(id); if (!rec || rec.done) throw new Error('No trace recording on this tab');
        const st = capture.get(id);
        await endTrace(id, rec);
        const r = finishRecording(id, 'trace');
        const summary = summarizeTrace(rec.chunks);
        const art = saveArtifact('trace', 'json', JSON.stringify({ traceEvents: rec.chunks, metadata: { source: 'browspark', tabId: id } }), `tab${id}`);
        setSummary(art.id, summary);
        if (r) r.artifact = art.path;
        if (st) capture.push(st, 'companion.recordingComplete', `trace ${art.id}`, { artifact: art.path });
        const live = await page.evaluate(id, 'window.__bmcpVitals || {}').catch(() => ({}));
        return { recordingId: art.id, artifact: art.path, bytes: art.bytes, ...summary, liveVitals: live, note: 'Open the artifact in Chrome DevTools > Performance > Load profile, or ui.perfetto.dev' };
      }
      case 'search': {
        const json = JSON.parse(artifactOf(a.recordingId)); const evs: any[] = json.traceEvents ?? json;
        const t0 = Math.min(...evs.filter((e) => typeof e.ts === 'number' && e.ph !== 'M').map((e) => e.ts));
        const qm = matcher(a.query, a.regex);
        const hits = evs.filter((e) => (qm(e.name) || (a.query && qm(JSON.stringify(e.args ?? {})))) && (a.minDurationMs === undefined || (e.dur ?? 0) / 1000 >= a.minDurationMs));
        return paginate(hits.map((e) => ({ atMs: Math.round((e.ts - t0) / 100) / 10, durationMs: e.dur !== undefined ? Math.round(e.dur / 100) / 10 : undefined, name: e.name, cat: e.cat, ph: e.ph, args: clip(JSON.stringify(e.args ?? {}), 300) })), a.offset, a.limit);
      }
      case 'compare': {
        const s1 = summaries.get(a.recordingId!) ?? summarizeTrace(JSON.parse(artifactOf(a.recordingId)).traceEvents), s2 = summaries.get(a.other!) ?? summarizeTrace(JSON.parse(artifactOf(a.other)).traceEvents);
        const cats = new Set([...Object.keys(s1.timeByCategoryMs), ...Object.keys(s2.timeByCategoryMs)]);
        return { a: a.recordingId, b: a.other, durationMs: [s1.durationMs, s2.durationMs], timeByCategoryMs: Object.fromEntries([...cats].map((c) => [c, { a: s1.timeByCategoryMs[c] ?? 0, b: s2.timeByCategoryMs[c] ?? 0, delta: Math.round(((s2.timeByCategoryMs[c] ?? 0) - (s1.timeByCategoryMs[c] ?? 0)) * 10) / 10 }])), longTasks: { a: s1.longTasks.count, b: s2.longTasks.count, totalMs: [s1.longTasks.totalMs, s2.longTasks.totalMs] }, vitals: { a: s1.vitals, b: s2.vitals } };
      }
      case 'vitals': { const v = await page.evaluate(id, 'window.__bmcpVitals || null'); return v ?? { note: 'No observer installed yet. Start a devtools session (it installs a Web Vitals observer) and reload.' }; }
      case 'metrics': { await sessions.cdp(id, 'Performance.enable'); const m = await sessions.cdp(id, 'Performance.getMetrics'); return Object.fromEntries(m.metrics.map((x: any) => [x.name, Math.round(x.value * 1000) / 1000])); }
      case 'list': return listArtifacts().filter((x) => /-trace-/.test(x.id)).map((x) => ({ recordingId: x.id, path: x.path, bytes: x.bytes }));
    }
  });

  tool(ctx, 'devtools_profile', 'CPU profiler. start/stop a sampling profile (.cpuprofile artifact, opens in DevTools Performance/JavaScript Profiler). stop and analyze return a bottom-up list of expensive functions (self time) and a call tree of hot paths.', {
    tabId: tabArg, action: z.enum(['start', 'stop', 'analyze', 'list']), samplingIntervalUs: z.number().int().optional(), profileId: z.string().optional(), limit: z.number().int().optional(),
  }, async (a) => {
    const id = await tab(a.tabId);
    switch (a.action) {
      case 'start': await sessions.cdp(id, 'Profiler.enable'); await sessions.cdp(id, 'Profiler.setSamplingInterval', { interval: a.samplingIntervalUs ?? 100 }); await sessions.cdp(id, 'Profiler.start'); rememberRecording(id, 'cpuprofile', () => sessions.cdp(id, 'Profiler.stop')); return `CPU profiling started on tab ${id}. Trigger the slow code, then stop.`;
      case 'stop': {
        const { profile } = await sessions.cdp(id, 'Profiler.stop');
        const r = finishRecording(id, 'cpuprofile');
        const art = saveArtifact('cpuprofile', 'cpuprofile', JSON.stringify(profile), `tab${id}`);
        const st = capture.get(id); if (r) r.artifact = art.path;
        if (st) capture.push(st, 'companion.recordingComplete', `cpuprofile ${art.id}`, { artifact: art.path });
        return { profileId: art.id, artifact: art.path, ...analyzeCpuProfile(profile, a.limit ?? 20) };
      }
      case 'analyze': return analyzeCpuProfile(JSON.parse(artifactOf(a.profileId)), a.limit ?? 20);
      case 'list': return listArtifacts().filter((x) => /-cpuprofile-/.test(x.id)).map((x) => ({ profileId: x.id, path: x.path, bytes: x.bytes }));
    }
  });

  tool(ctx, 'devtools_memory', 'Memory panel. snapshot captures a .heapsnapshot artifact (opens in DevTools Memory) and summarizes objects by class with sizes and detached DOM node count. compare diffs two snapshots by class (growth). retainers lists what holds instances of a class. sampling start/stop records an allocation sampling profile (.heapprofile) with top allocating functions. usage returns current heap size; growth samples heap usage over time to spot leaks.', {
    tabId: tabArg, action: z.enum(['snapshot', 'compare', 'retainers', 'sampling', 'usage', 'growth', 'list']),
    snapshotId: z.string().optional(), other: z.string().optional(), className: z.string().optional(), limit: z.number().int().optional(),
    phase: z.enum(['start', 'stop']).optional().describe('For sampling'), intervalBytes: z.number().int().optional(), seconds: z.number().optional().describe('growth: duration, default 10'), gc: z.boolean().optional().describe('Collect garbage first (default true for snapshot)'),
  }, async (a) => {
    const id = await tab(a.tabId);
    switch (a.action) {
      case 'snapshot': {
        await sessions.cdp(id, 'HeapProfiler.enable');
        if (a.gc !== false) await sessions.cdp(id, 'HeapProfiler.collectGarbage').catch(() => {});
        heapChunks.set(id, []);
        let json: string;
        try {
          await sessions.cdp(id, 'HeapProfiler.takeHeapSnapshot', { reportProgress: false, treatGlobalObjectsAsRoots: true, captureNumericValue: false }, 300_000);
          json = heapChunks.get(id)!.join('');
        } finally { heapChunks.delete(id); }
        const art = saveArtifact('heapsnapshot', 'heapsnapshot', json, `tab${id}`);
        const s = summarizeHeap(json, a.limit ?? 40); setSummary(art.id, s);
        const st = capture.get(id); if (st) capture.push(st, 'companion.recordingComplete', `heapsnapshot ${art.id}`, { artifact: art.path });
        return { snapshotId: art.id, artifact: art.path, bytes: art.bytes, nodes: s.nodes, totalBytes: s.totalBytes, detachedNodes: s.detachedNodes, topClasses: s.classes };
      }
      case 'compare': {
        const s1 = summaries.get(a.snapshotId!) ?? summarizeHeap(artifactOf(a.snapshotId)), s2 = summaries.get(a.other!) ?? summarizeHeap(artifactOf(a.other));
        const names = new Set([...Object.keys(s1.byClass), ...Object.keys(s2.byClass)]);
        const rows = [...names].map((n) => { const x = s1.byClass[n] ?? { count: 0, size: 0 }, y = s2.byClass[n] ?? { count: 0, size: 0 }; return { name: n, countDelta: y.count - x.count, bytesDelta: y.size - x.size, countBefore: x.count, countAfter: y.count }; }).filter((r) => r.countDelta || r.bytesDelta).sort((p, q) => q.bytesDelta - p.bytesDelta);
        return { before: a.snapshotId, after: a.other, totalBytesDelta: s2.totalBytes - s1.totalBytes, detachedNodes: [s1.detachedNodes, s2.detachedNodes], grew: rows.slice(0, a.limit ?? 25), shrank: rows.filter((r) => r.bytesDelta < 0).slice(-10) };
      }
      case 'retainers': { if (!a.className) throw new Error('className required'); return retainersOf(artifactOf(a.snapshotId), a.className, a.limit ?? 15); }
      case 'sampling': {
        if (a.phase === 'stop') {
          const { profile } = await sessions.cdp(id, 'HeapProfiler.stopSampling');
          const r = finishRecording(id, 'heapprofile');
          const art = saveArtifact('heapprofile', 'heapprofile', JSON.stringify(profile), `tab${id}`);
          if (r) r.artifact = art.path;
          const agg = new Map<string, number>(); const walk = (n: any) => { const k = `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url ? clip(n.callFrame.url.replace(/^.*\//, ''), 40) + ':' + (n.callFrame.lineNumber + 1) : ''}`; agg.set(k, (agg.get(k) ?? 0) + n.selfSize); for (const c of n.children ?? []) walk(c); }; walk(profile.head);
          return { profileId: art.id, artifact: art.path, topAllocators: [...agg.entries()].sort((x, y) => y[1] - x[1]).slice(0, a.limit ?? 20).map(([fn, bytes]) => ({ function: fn, bytes })) };
        }
        await sessions.cdp(id, 'HeapProfiler.enable'); await sessions.cdp(id, 'HeapProfiler.startSampling', { samplingInterval: a.intervalBytes ?? 32768 });
        rememberRecording(id, 'heapprofile', () => sessions.cdp(id, 'HeapProfiler.stopSampling'));
        return 'Allocation sampling started. Exercise the code, then sampling with phase:"stop".';
      }
      case 'usage': { const u = await sessions.cdp(id, 'Runtime.getHeapUsage'); return { usedBytes: u.usedSize, totalBytes: u.totalSize, usedMB: Math.round(u.usedSize / 1048576 * 10) / 10 }; }
      case 'growth': {
        const secs = a.seconds ?? 10, n = Math.max(2, Math.min(20, Math.round(secs))); const pts: number[] = [];
        for (let i = 0; i < n; i++) { const u = await sessions.cdp(id, 'Runtime.getHeapUsage'); pts.push(u.usedSize); if (i < n - 1) await new Promise((r) => setTimeout(r, secs * 1000 / (n - 1))); }
        await sessions.cdp(id, 'HeapProfiler.collectGarbage').catch(() => {}); const after = (await sessions.cdp(id, 'Runtime.getHeapUsage')).usedSize;
        return { seconds: secs, samplesMB: pts.map((p) => Math.round(p / 1048576 * 10) / 10), growthMB: Math.round((pts.at(-1)! - pts[0]) / 1048576 * 10) / 10, afterGcMB: Math.round(after / 1048576 * 10) / 10, retainedGrowthMB: Math.round((after - pts[0]) / 1048576 * 10) / 10, verdict: after - pts[0] > 2 * 1048576 ? 'heap grew and did not return after GC: likely leak' : 'no significant retained growth' };
      }
      case 'list': return listArtifacts().filter((x) => /-heap(snapshot|profile)-/.test(x.id)).map((x) => ({ id: x.id, path: x.path, bytes: x.bytes }));
    }
  });

  tool(ctx, 'devtools_coverage', 'Coverage panel. start records JavaScript and CSS usage; stop reports per-file used/unused bytes; detail lists the unused ranges of one file with line numbers and snippets.', {
    tabId: tabArg, action: z.enum(['start', 'stop', 'detail']), url: z.string().optional(), limit: z.number().int().optional(),
    reload: z.boolean().optional().describe('start: reload after enabling so every function is instrumented (default true, like the DevTools Coverage panel)'),
  }, async (a) => {
    const id = await tab(a.tabId);
    const st = capture.get(id);
    const key = `coverage:${id}`;
    switch (a.action) {
      case 'start': {
        await sessions.cdp(id, 'Profiler.enable'); await sessions.cdp(id, 'Profiler.startPreciseCoverage', { callCount: false, detailed: true, allowTriggeredUpdates: false });
        rememberRecording(id, 'coverage', () => Promise.all([sessions.cdp(id, 'Profiler.stopPreciseCoverage'), sessions.cdp(id, 'CSS.stopRuleUsageTracking').catch(() => {})]));
        await sessions.cdp(id, 'DOM.enable').catch(() => {}); await sessions.cdp(id, 'CSS.enable').catch(() => {}); await sessions.cdp(id, 'CSS.startRuleUsageTracking').catch(() => {});
        if (a.reload !== false) await page.navigate(id, 'reload');
        return `Coverage recording started${a.reload !== false ? ' and page reloaded' : ' (no reload: only code compiled from now on is tracked precisely)'}. Exercise the page, then stop.`;
      }
      case 'stop': {
        const js = await sessions.cdp(id, 'Profiler.takePreciseCoverage'); await sessions.cdp(id, 'Profiler.stopPreciseCoverage');
        const css = await sessions.cdp(id, 'CSS.stopRuleUsageTracking').catch(() => ({ ruleUsage: [] }));
        finishRecording(id, 'coverage');
        const files: any[] = [];
        for (const s of js.result) {
          if (!s.url) continue;
          const unused = mergeRanges(s.functions.flatMap((f: any) => f.ranges.filter((r: any) => r.count === 0).map((r: any) => ({ s: r.startOffset, e: r.endOffset }))));
          const total = Math.max(...s.functions.flatMap((f: any) => f.ranges.map((r: any) => r.endOffset)), 0);
          const unusedBytes = unused.reduce((x, r) => x + (r.e - r.s), 0);
          const zeroFns = s.functions.filter((f: any) => f.ranges[0]?.count === 0).length;
          files.push({ url: s.url, type: 'JS', totalBytes: total, unusedBytes, unusedPct: total ? Math.round(unusedBytes / total * 100) : 0, functions: s.functions.length, unexecutedFunctions: zeroFns, scriptId: s.scriptId, ranges: unused });
        }
        const bySheet = new Map<string, { used: number; unused: number; total: number; rules: any[] }>();
        for (const r of css.ruleUsage) { const k = r.styleSheetId; const b = bySheet.get(k) ?? { used: 0, unused: 0, total: 0, rules: [] }; const len = r.endOffset - r.startOffset; b.total += len; if (r.used) b.used += len; else { b.unused += len; b.rules.push({ s: r.startOffset, e: r.endOffset }); } bySheet.set(k, b); }
        for (const [sid, b] of bySheet) files.push({ url: st?.styleSheets.get(sid)?.sourceURL || `(inline stylesheet ${sid})`, type: 'CSS', totalBytes: b.total, unusedBytes: b.unused, unusedPct: b.total ? Math.round(b.unused / b.total * 100) : 0, styleSheetId: sid, ranges: b.rules });
        (globalThis as any)[key] = files;
        return { files: files.sort((x, y) => y.unusedBytes - x.unusedBytes).slice(0, a.limit ?? 40).map(({ ranges, ...f }) => ({ ...f, unusedRanges: ranges.length })), note: 'Use action:detail with url for line-level unused ranges.' };
      }
      case 'detail': {
        const files: any[] = (globalThis as any)[key]; if (!files) throw new Error('Run coverage start/stop first');
        const f = files.find((x) => x.url === a.url) ?? files.find((x) => a.url && x.url.includes(a.url)); if (!f) throw new Error('No coverage for that url');
        const text: string = f.type === 'JS' ? (await sessions.cdp(id, 'Debugger.getScriptSource', { scriptId: f.scriptId })).scriptSource : (await sessions.cdp(id, 'CSS.getStyleSheetText', { styleSheetId: f.styleSheetId })).text;
        const lineOf = (off: number) => text.slice(0, off).split('\n').length;
        return { url: f.url, type: f.type, totalBytes: f.totalBytes, unusedBytes: f.unusedBytes, unusedRanges: f.ranges.slice(0, a.limit ?? 50).map((r: any) => ({ fromLine: lineOf(r.s), toLine: lineOf(r.e), bytes: r.e - r.s, snippet: clip(text.slice(r.s, r.e).replace(/\s+/g, ' ').trim(), 120) })) };
      }
    }
  });
}
