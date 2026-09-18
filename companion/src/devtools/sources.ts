// devtools_sources: list/get/search scripts, stylesheets and documents; source maps; resource overrides.
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { type Ctx, tool, tabArg, matcher, paginate, pageArgs, clip } from '../context.ts';
import { applyFetchRules } from './network.ts';
import { parseSourceMap, toOriginal, toGenerated, resolveMapUrl, decodeDataUrl, type SourceMap } from './sourcemap.ts';
import type { TabState } from './capture.ts';

const MAX_MAP_CACHE = 100;
const mapCache = new Map<string, Promise<SourceMap | undefined>>(); // key: tabId:scriptId:hash

export async function sourceMapFor(ctx: Ctx, tabId: number, st: TabState, scriptId: string): Promise<SourceMap | undefined> {
  const s = st.scripts.get(scriptId);
  if (!s?.sourceMapURL) return undefined;
  const key = `${tabId}:${scriptId}:${s.hash}`;
  if (!mapCache.has(key)) {
    if (mapCache.size >= MAX_MAP_CACHE) {
      const oldest = mapCache.keys().next().value;
      if (oldest) mapCache.delete(oldest);
    }
    mapCache.set(key, (async () => {
      const url = resolveMapUrl(s.url, s.sourceMapURL!);
      let text: string | undefined;
      if (url.startsWith('data:')) text = decodeDataUrl(url);
      else {
        // script.url can be forged with sourceURL. Keep requests in the page so CSP,
        // browser network restrictions and the tab's Fetch policy remain authoritative.
        text = await ctx.page.evaluate<string>(tabId, `fetch(${JSON.stringify(url)}).then(r => r.ok ? r.text() : Promise.reject(new Error(r.status)))`).catch(() => undefined);
      }
      if (!text) return undefined;
      try { return parseSourceMap(text); } catch { return undefined; }
    })());
  }
  return mapCache.get(key)!;
}

/** Map a generated location (1-based) to original, if a map exists. */
export async function originalLocation(ctx: Ctx, tabId: number, st: TabState, scriptId: string | undefined, line1: number, col1: number) {
  if (!scriptId) return undefined;
  const map = await sourceMapFor(ctx, tabId, st, scriptId).catch(() => undefined);
  if (!map) return undefined;
  const o = toOriginal(map, line1 - 1, Math.max(0, col1 - 1));
  return o && { source: o.source, line: o.line + 1, column: o.column + 1, name: o.name };
}

/** Find generated location for an original source path + 1-based line across all mapped scripts. */
export async function generatedLocation(ctx: Ctx, tabId: number, st: TabState, source: string, line1: number, col1?: number) {
  for (const s of st.scripts.values()) {
    if (!s.sourceMapURL) continue;
    const map = await sourceMapFor(ctx, tabId, st, s.scriptId).catch(() => undefined);
    if (!map) continue;
    const g = toGenerated(map, source, line1 - 1, col1 !== undefined ? col1 - 1 : undefined);
    if (g) return { scriptId: s.scriptId, url: s.url, line: g.line + 1, column: g.column + 1, source: map.sources[g.sourceIndex] };
  }
  return undefined;
}

export function registerSourcesTools(ctx: Ctx) {
  const { sessions, capture } = ctx;
  const tab = (id?: number) => sessions.resolve(id);

  tool(ctx, 'devtools_sources', 'Sources panel: list loaded scripts, stylesheets, documents, frames and execution contexts; get file contents (optionally the original source via source map); search across sources by filename, text, or regex; resolve source maps; apply, list, and revert temporary resource overrides (served in place of the network response after reload).', {
    tabId: tabArg, action: z.enum(['list', 'get', 'search', 'sourcemap', 'map', 'override', 'overrides', 'revert']).default('list'),
    kind: z.enum(['scripts', 'stylesheets', 'documents', 'frames', 'contexts', 'all']).optional().describe('For list/search; default all'),
    url: z.string().optional().describe('Filter (substring) or exact URL for get/override'), scriptId: z.string().optional(), styleSheetId: z.string().optional(), frameId: z.string().optional(),
    query: z.string().optional().describe('Search text or regex'), regex: z.boolean().optional(), caseSensitive: z.boolean().optional(),
    fromLine: z.number().int().optional().describe('1-based, for get'), toLine: z.number().int().optional(), maxChars: z.number().int().optional(), original: z.boolean().optional().describe('get: return original source via source map; search: report original locations'),
    source: z.string().optional().describe('Original source path (for get original / map)'), line: z.number().int().optional().describe('1-based line for map'), column: z.number().int().optional(), direction: z.enum(['toOriginal', 'toGenerated']).optional(),
    body: z.string().optional().describe('Override content'), file: z.string().optional().describe('Override content from a local file path'), contentType: z.string().optional(), reload: z.boolean().optional().describe('Reload after installing/reverting an override'),
    ...pageArgs,
  }, async (a) => {
    const id = await tab(a.tabId);
    const st = capture.require(id);
    const um = matcher(a.url);
    switch (a.action) {
      case 'list': {
        const kind = a.kind ?? 'all';
        const out: Record<string, unknown> = {};
        if (kind === 'all' || kind === 'scripts') out.scripts = paginate([...st.scripts.values()].filter((s) => um(s.url)).map((s) => ({ scriptId: s.scriptId, url: s.url || '(inline/eval)', lines: s.endLine - s.startLine + 1, bytes: s.length, sourceMap: !!s.sourceMapURL, module: s.isModule || undefined, contextId: s.contextId })), a.offset, a.limit);
        if (kind === 'all' || kind === 'stylesheets') out.stylesheets = paginate([...st.styleSheets.values()].filter((s) => um(s.sourceURL)).map((s) => ({ styleSheetId: s.styleSheetId, url: s.sourceURL || '(inline)', origin: s.origin, bytes: s.length, inline: s.isInline || undefined, sourceMap: !!s.sourceMapURL, frameId: s.frameId })), a.offset, a.limit);
        if (kind === 'all' || kind === 'documents') {
          const tree = await sessions.cdp(id, 'Page.getResourceTree').catch(() => undefined);
          const docs: any[] = [];
          const walk = (n: any) => { if (!n) return; docs.push({ frameId: n.frame.id, url: n.frame.url, type: 'Document' }); for (const r of n.resources ?? []) if (um(r.url)) docs.push({ frameId: n.frame.id, url: r.url, type: r.type, mimeType: r.mimeType, bytes: r.contentSize }); for (const c of n.childFrames ?? []) walk(c); };
          walk(tree?.frameTree);
          out.documents = paginate(docs.filter((d) => um(d.url)), a.offset, a.limit);
        }
        if (kind === 'all' || kind === 'frames') out.frames = [...st.frames.values()];
        if (kind === 'all' || kind === 'contexts') out.contexts = [...st.contexts.values()];
        return out;
      }
      case 'get': {
        let text: string, label: string;
        if (a.original && a.source) {
          for (const s of st.scripts.values()) {
            const map = s.sourceMapURL ? await sourceMapFor(ctx, id, st, s.scriptId) : undefined;
            const i = map?.sources.findIndex((x) => x === a.source || x.endsWith('/' + a.source!) || x.endsWith(a.source!)) ?? -1;
            if (map && i >= 0) {
              const content = map.sourcesContent?.[i];
              if (content) return slice(content, `${map.sources[i]} (from source map of ${s.url})`, a);
              const fetched = await ctx.page.evaluate<string>(id, `fetch(${JSON.stringify(new URL(map.sources[i], s.url).href)}).then(r => r.text())`).catch(() => undefined);
              if (fetched) return slice(fetched, map.sources[i], a);
            }
          }
          throw new Error(`No source map exposes ${a.source}`);
        }
        const script = a.scriptId ? st.scripts.get(a.scriptId) : a.url ? [...st.scripts.values()].find((s) => s.url === a.url) ?? [...st.scripts.values()].find((s) => s.url.includes(a.url!)) : undefined;
        const sheet = a.styleSheetId ? st.styleSheets.get(a.styleSheetId) : !script && a.url ? [...st.styleSheets.values()].find((s) => s.sourceURL === a.url || s.sourceURL.includes(a.url!)) : undefined;
        if (script) {
          if (a.original) {
            const map = await sourceMapFor(ctx, id, st, script.scriptId);
            if (!map) throw new Error(`${script.url} has no usable source map`);
            return { url: script.url, sources: map.sources, note: 'Pass source:<path> with original:true to read one of these' };
          }
          const r = await sessions.cdp(id, 'Debugger.getScriptSource', { scriptId: script.scriptId }); text = r.scriptSource; label = script.url || `script ${script.scriptId}`;
        } else if (sheet) { const r = await sessions.cdp(id, 'CSS.getStyleSheetText', { styleSheetId: sheet.styleSheetId }); text = r.text; label = sheet.sourceURL || `stylesheet ${sheet.styleSheetId}`; }
        else if (a.url) { const fid = a.frameId ?? [...st.frames.values()].find((f) => !f.parentId)?.id; const r = await sessions.cdp(id, 'Page.getResourceContent', { frameId: fid, url: a.url }); text = r.base64Encoded ? Buffer.from(r.content, 'base64').toString('utf8') : r.content; label = a.url; }
        else throw new Error('Provide scriptId, styleSheetId, or url');
        return slice(text, label, a);
      }
      case 'search': {
        if (!a.query) throw new Error('query required');
        const kind = a.kind ?? 'all';
        const hits: any[] = [];
        const fileMatch = matcher(a.query, a.regex, a.caseSensitive ? '' : 'i');
        if (kind === 'all' || kind === 'scripts') {
          for (const s of st.scripts.values()) {
            if (!um(s.url) || !s.url) continue;
            if (fileMatch(s.url)) hits.push({ url: s.url, scriptId: s.scriptId, line: 0, match: 'filename' });
            const r = await sessions.cdp(id, 'Debugger.searchInContent', { scriptId: s.scriptId, query: a.query, caseSensitive: !!a.caseSensitive, isRegex: !!a.regex }).catch(() => ({ result: [] }));
            for (const m of r.result.slice(0, 200)) {
              const h: any = { url: s.url, scriptId: s.scriptId, line: m.lineNumber + 1, text: clip(m.lineContent.trim(), 200) };
              if (a.original) { const o = await originalLocation(ctx, id, st, s.scriptId, m.lineNumber + 1, 1); if (o) h.original = `${o.source}:${o.line}`; }
              hits.push(h);
            }
          }
        }
        if (kind === 'all' || kind === 'stylesheets') {
          const re = a.regex ? new RegExp(a.query, a.caseSensitive ? '' : 'i') : undefined;
          for (const s of st.styleSheets.values()) {
            if (!um(s.sourceURL)) continue;
            if (s.sourceURL && fileMatch(s.sourceURL)) hits.push({ url: s.sourceURL, styleSheetId: s.styleSheetId, line: 0, match: 'filename' });
            const r = await sessions.cdp(id, 'CSS.getStyleSheetText', { styleSheetId: s.styleSheetId }).catch(() => undefined);
            r?.text.split('\n').forEach((l: string, i: number) => { if (re ? re.test(l) : (a.caseSensitive ? l.includes(a.query!) : l.toLowerCase().includes(a.query!.toLowerCase()))) hits.push({ url: s.sourceURL || '(inline)', styleSheetId: s.styleSheetId, line: i + 1, text: clip(l.trim(), 200) }); });
          }
        }
        return paginate(hits, a.offset, a.limit);
      }
      case 'sourcemap': {
        const script = a.scriptId ? st.scripts.get(a.scriptId) : [...st.scripts.values()].find((s) => s.url === a.url || (a.url && s.url.includes(a.url)));
        if (!script) throw new Error('script not found');
        if (!script.sourceMapURL) return { url: script.url, sourceMap: 'none' };
        const map = await sourceMapFor(ctx, id, st, script.scriptId);
        if (!map) return { url: script.url, sourceMapURL: script.sourceMapURL, sourceMap: 'failed to load or parse' };
        return { url: script.url, sourceMapURL: clip(script.sourceMapURL, 120), sources: map.sources, hasSourcesContent: !!map.sourcesContent?.some(Boolean), mappings: map.mappings.length };
      }
      case 'map': {
        if (a.line === undefined) throw new Error('line required');
        if ((a.direction ?? (a.source ? 'toGenerated' : 'toOriginal')) === 'toGenerated') {
          if (!a.source) throw new Error('source required for toGenerated');
          const g = await generatedLocation(ctx, id, st, a.source, a.line, a.column);
          return g ?? { result: 'no mapping', hint: 'Is the script with that source map loaded? Check devtools_sources sourcemap.' };
        }
        const script = a.scriptId ? st.scripts.get(a.scriptId) : [...st.scripts.values()].find((s) => s.url === a.url || (a.url && s.url.includes(a.url)));
        if (!script) throw new Error('scriptId or url required for toOriginal');
        return (await originalLocation(ctx, id, st, script.scriptId, a.line, a.column ?? 1)) ?? { result: 'no mapping' };
      }
      case 'override': {
        if (!a.url) throw new Error('url (glob) required');
        const body = a.file ? readFileSync(a.file, 'utf8') : a.body;
        if (body === undefined) throw new Error('body or file required');
        st.overrides.set(a.url, { kind: 'override', body, contentType: a.contentType ?? guessType(a.url) });
        await applyFetchRules(ctx, id, st);
        let note = `Override installed for ${a.url} (${body.length} chars, ${a.contentType ?? guessType(a.url)}).`;
        if (a.reload) { await ctx.page.navigate(id, 'reload'); note += ' Reloaded.'; } else note += ' Reload to apply (reload:true).';
        return note;
      }
      case 'overrides': return [...st.overrides.entries()].filter(([, r]) => r.kind === 'override').map(([pattern, r]) => ({ pattern, contentType: r.contentType, chars: r.body.length }));
      case 'revert': {
        if (a.url) st.overrides.delete(a.url); else for (const [k, v] of st.overrides) if (v.kind === 'override') st.overrides.delete(k);
        await applyFetchRules(ctx, id, st);
        if (a.reload) await ctx.page.navigate(id, 'reload');
        return `Reverted${a.url ? ' ' + a.url : ' all overrides'}. ${st.overrides.size} rule(s) remain.${a.reload ? ' Reloaded.' : ''}`;
      }
    }
  });
}

function slice(text: string, label: string, a: { fromLine?: number; toLine?: number; maxChars?: number }) {
  const lines = text.split('\n');
  const from = Math.max(1, a.fromLine ?? 1), to = Math.min(lines.length, a.toLine ?? lines.length);
  let out = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n');
  const max = a.maxChars ?? 30_000;
  const truncated = out.length > max;
  if (truncated) out = out.slice(0, max);
  return { file: label, totalLines: lines.length, fromLine: from, toLine: to, truncated, text: out };
}
const guessType = (u: string) => /\.m?js(\?|$)/.test(u) ? 'application/javascript' : /\.css(\?|$)/.test(u) ? 'text/css' : /\.json(\?|$)/.test(u) ? 'application/json' : /\.html?(\?|$)|\/$/.test(u) ? 'text/html' : 'text/plain';
