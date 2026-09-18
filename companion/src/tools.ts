// browser_* tools: connection, tabs, and page automation. Work in both connection modes.
import { z } from 'zod';
import { type Ctx, image, tool, tabArg, refArg, text, devGate, ownerOf } from './context.ts';
import { recorder } from './devtools/recorder.ts';
import { policies, defaultPolicy, setDefaultPolicy, setPolicy, forgetTab, type Policy } from './devtools/intercept.ts';
import { saveArtifact } from './artifacts.ts';
import { writeFileSync } from 'node:fs';
import type { Download } from './cdp.ts';
import { isNewTab } from '../../shared/protocol.ts';

export function registerBrowserTools(ctx: Ctx) {
  const { sessions, page, capture, registry } = ctx;
  const tab = (id?: number) => sessions.resolve(id);
  const owner = (id: number) => { const o = ownerOf(id); return o && o !== ctx.client ? ` (opened by agent "${o.name}")` : o ? ' (opened by you)' : ''; };

  tool(ctx, 'browser_status', 'Connection status for both modes, how to get the extension connected, shared tabs across all windows, and open dialogs. Select a listed tabId to target a tab. Call this first if anything fails.', {}, async () => {
    const b = sessions.bridge;
    const lines = [`Companion bridge: ws://127.0.0.1:${b.port}`, `You are agent "${ctx.client.name}"${(await import('./context.ts')).clients.size > 1 ? `; other agents connected: ${[...(await import('./context.ts')).clients.values()].filter((c) => c !== ctx.client).map((c) => c.name).join(', ')}` : ''}.`];
    if (b.connected) for (const c of b.connections()) lines.push(`Extension mode: connected to ${c.browser ?? 'an unknown browser'} (extension v${c.extensionVersion}, browserId ${c.id}). Use browserId to open a tab in this browser; existing tabs use tabId. The user can open DevTools (F12) on shared tabs.`);
    else lines.push('Extension mode: NOT CONNECTED (shared browser tabs)', `  To use shared browser tabs, open the Browspark extension dashboard (click its toolbar icon). It connects to port ${b.port} on its own; if the dashboard shows a different port, set it under Settings. Then share tabs.`, `    port:  ${b.port}`);
    const devs = sessions.runningDevs();
    if (!devs.length) lines.push('Developer mode: not running. Only launch it (browser_session) if the user asks for a separate browser or a tool says an operation needs it; otherwise work in the user\'s shared tabs.');
    for (const d of devs) lines.push(`Developer mode [${d.name}] (${d.browserName}): ${d.version}, pid ${d.pid}${d.headless ? ', headless' : ''}, profile ${d.profileDir}, downloads ${d.downloadDir}${d.proxy ? `, proxy ${d.proxy}` : ''}\n  ${d.browserType === 'firefox' ? 'WebDriver BiDi endpoint' : 'CDP endpoint for Playwright/Puppeteer connectOverCDP'}: ${d.wsEndpoint}${d.browserType === 'firefox' ? '\n  Firefox/Zen: use devtools_capabilities for supported operations; live screencast, raw CDP and Lighthouse are unavailable.' : `\n  Live view: http://127.0.0.1:${b.port}/live/<tabId>`}`);
    const tabs = (await sessions.tabs(true).catch(() => [])).filter((t) => t.shared);
    lines.push(tabs.length ? `Usable tabs (${tabs.length}) across all windows; select a listed tabId:` : 'Usable tabs: none — ask the user to share a tab from any window, or open one with browser_tabs {action:"new", url}.');
    for (const t of tabs) lines.push(`  [${t.id}] ${t.mode}${owner(t.id)} (${t.browserName ?? t.mode}, ${t.browserId ? 'browserId ' + t.browserId : 'context ' + t.context}) ${isNewTab(t.url) ? '(new tab: navigate to a website) ' : t.unsupported ? `(unsupported: ${t.unsupported}) ` : ''}${t.title || '(untitled)'} — ${t.url}${t.windowId !== undefined ? ` (window ${t.windowId})` : ''}${t.attached ? ' (attached)' : ''}${capture.get(t.id)?.active ? ' (inspecting)' : ''}${page.dialogs.has(t.id) ? ` — DIALOG OPEN: ${page.dialogs.get(t.id)!.type} "${page.dialogs.get(t.id)!.message}"` : ''}`);
    return lines.join('\n');
  });

  tool(ctx, 'browser_session', 'Developer-mode browsers: launch Chrome, Brave, Firefox, or Zen without the user\'s logins. Only launch when the user explicitly asks (pass userRequested: true, never on your own initiative), or a tool reported it needs developer mode. For everyday work use shared tabs. Each named context has its own persistent profile; use different context names to run browsers simultaneously. chromium preserves automatic Chrome/Chromium discovery. Firefox and Zen use WebDriver BiDi with documented exceptions; Firefox/Zen extension sharing uses its own package and has additional documented exceptions. launch/close take a context (default "default"); status lists running browsers; contexts lists saved profiles; delete removes a stopped profile.', {
    action: z.enum(['launch', 'status', 'close', 'contexts', 'delete']),
    context: z.string().optional().describe('Context name, e.g. "work" or "personal" (default "default")'), all: z.boolean().optional().describe('close: close every running context'),
    url: z.string().optional().describe('Initial URL for launch'),
    userRequested: z.boolean().optional().describe('launch: the user explicitly asked for a developer browser in their own words. Satisfies the "Only when needed" dashboard setting. Never set it on your own initiative.'),
    headless: z.boolean().optional().describe('Launch without a window; screenshots work in either browser, live view is Chromium-only'),
    browser: z.enum(['chromium', 'chrome', 'brave', 'firefox', 'zen']).optional().describe('launch/delete: browser brand (default chromium for a new context).'),
    browserPath: z.string().optional().describe('Executable for the selected browser; overrides automatic discovery.'),
    chromePath: z.string().optional().describe('Legacy executable override for Chromium browsers'), firefoxPath: z.string().optional().describe('Legacy executable override for Firefox browsers'), args: z.array(z.string()).optional().describe('Extra browser switches'),
    devtools: z.boolean().optional().describe('Chromium only: open DevTools for every tab (default true unless headless); Firefox rejects true'),
    proxy: z.string().optional().describe('Proxy server for this browser, e.g. "http://proxy:8080" or "socks5://127.0.0.1:1080"'),
    extensions: z.array(z.string()).optional().describe('Chromium only: unpacked extension directories to load'),
    downloadDir: z.string().optional().describe('Where downloads land (default ~/.browspark/downloads/<browser>/<context>; legacy chromium omits the browser directory)'),
  }, async ({ action, context, all, url, userRequested, headless, browser, browserPath, chromePath, firefoxPath, args, devtools, proxy, extensions, downloadDir }) => {
    const name = context ?? 'default';
    if (action === 'contexts') return sessions.listContexts();
    if (action === 'delete') { await sessions.deleteContext(name, browser); return `Deleted context "${name}" and its profile.`; }
    if (action === 'status') { const devs = sessions.runningDevs(); return devs.length ? devs.map((d) => `[${d.name}] ${d.browserName}: ${d.version}, pid ${d.pid}, port ${d.port}, ${d.listTabs().length} tab(s), profile ${d.profileDir}, ${d.browserType === 'firefox' ? 'BiDi' : 'CDP'} ${d.wsEndpoint}`).join('\n') : 'no developer browser running'; }
    if (action === 'close') { const targets = [...sessions.devs.values()].filter(d => d.busy && (all || d.name === name)); if (!targets.length) return 'not running'; for (const d of targets) await d.close(); return `Closed ${targets.map((d) => d.name).join(', ')}.`; }
    if (sessions.bridge.connected) {
      const recent = Date.now() - devGate.lastNeededAt < 10 * 60_000;
      if (devGate.policy === 'never') throw new Error('The developer browser is disabled in the Browspark dashboard (Settings → Developer browser). Work in the user\'s shared tabs, or ask the user to change that setting.');
      if (devGate.policy === 'auto' && !recent && !userRequested) throw new Error('Not launching a developer browser: nothing so far needed one. Work in the user\'s shared tabs (or open a tab with browser_tabs). The developer browser is only for operations Chrome blocks for extensions (heap snapshots, Lighthouse, raw CDP); if such an operation fails with "unsupported", a launch is then allowed. If the user explicitly asked for a developer browser, retry with userRequested: true. The user can also set Settings → Developer browser to "Always".');
    }
    const d = await sessions.launch(name, { url, headless, browser, browserPath, chromePath, firefoxPath, args, devtools, proxy, extensions, downloadDir });
    const tabs = d.listTabs();
    return `Launched context "${name}": ${d.version} (pid ${d.pid}) on devtools port ${d.port}, profile ${d.profileDir}${d.browserType === 'chromium' && (devtools ?? !headless) ? ', DevTools opens on every tab' : ''}${proxy ? `, proxy ${proxy}` : ''}${d.loadedExtensions.length ? `, extensions: ${d.loadedExtensions.map((e) => e.id).join(', ')}` : ''}. ${d.browserType === 'firefox' ? 'WebDriver BiDi' : 'CDP'} endpoint: ${d.wsEndpoint}. Tabs: ${tabs.map((t) => `[${t.id}] ${t.url}`).join(', ')}`;
  });

  tool(ctx, 'browser_tabs', 'List, open, close, or activate tabs across all connected browsers and windows. tabId is unique across browsers. For new tabs, choose browserId for an extension browser or context for a developer browser when several are connected. Without tabId, page tools use the agent\'s own usable tab or the only usable tab. Open a new tab only when the task needs a separate page. Never launch a separate browser just to get a tab. Dev-mode tabs are always usable.', {
    action: z.enum(['list', 'new', 'close', 'activate']).default('list'),
    tabId: tabArg, url: z.string().optional().describe('URL for new'),
    mode: z.enum(['extension', 'dev']).optional().describe('Where to open a new tab; default extension if connected, otherwise dev if running'), context: z.string().min(1).optional().describe('Developer context for new/list'),
    browserId: z.string().min(1).optional().describe('Extension browser ID from browser_status/browser_tabs for new/list'),
    onlyUsable: z.boolean().optional().describe('Default true. false lists every tab including unshared ones.'),
  }, async ({ action, tabId, url, mode, context, browserId, onlyUsable }) => {
    if (browserId && context) throw new Error('Choose browserId or context, not both.');
    if ((browserId || context) && (action === 'close' || action === 'activate')) throw new Error('Use tabId for close/activate.');
    if (action === 'new') {
      // Open blank, arm the default policy, then navigate: the first request must already be intercepted.
      const id = await sessions.newTab('about:blank', mode, context, true, browserId);
      if (defaultPolicy) await setPolicy(sessions, id, defaultPolicy);
      if (url && url !== 'about:blank') await page.navigate(id, 'goto', url);
      return `Opened tab ${id}${url ? ` at ${url}` : ''}${defaultPolicy ? ' (default domain policy applied)' : ''}`;
    }
    if (action === 'close') { const id = await tab(tabId); await sessions.closeTab(id); return `Closed tab ${id}`; }
    if (action === 'activate') { const id = await tab(tabId); await sessions.activate(id); return `Activated tab ${id}`; }
    if (browserId && !sessions.bridge.connections().some(c => c.id === browserId)) throw new Error(`Browser ${browserId} is not connected. Call browser_status for available browser IDs.`);
    if (context && !sessions.devs.get(context)?.running) throw new Error(`Context "${context}" is not running.`);
    const tabs = (await sessions.tabs(true)).filter(t => (!browserId || t.browserId === browserId) && (!context || t.context === context));
    const list = onlyUsable === false ? tabs : tabs.filter((t) => t.shared);
    if (!list.length) return onlyUsable === false ? 'No tabs.' : 'No usable tabs. Ask the user to share a tab in the extension dashboard, or launch the development browser.';
    return list.map((t) => `[${t.id}] ${t.mode}${t.browser === 'firefox' ? ':firefox' : ''}${t.context ? ':' + t.context : ''}${owner(t.id)} ${t.shared ? 'shared' : 'not shared'} (${t.browserName ?? t.mode}${t.browserId ? ', browserId ' + t.browserId : ''})${isNewTab(t.url) ? ' (new tab: navigate to a website)' : t.unsupported ? ` (unsupported: ${t.unsupported})` : ''}${t.windowId !== undefined ? ` (window ${t.windowId})` : ''}${t.attached ? ' debugging' : ''} — ${t.title} — ${t.url}`).join('\n');
  });

  tool(ctx, 'browser_navigate', 'Navigate a tab: goto a URL, reload, back, or forward. Waits for the load event.', {
    tabId: tabArg, action: z.enum(['goto', 'reload', 'back', 'forward']).default('goto'), url: z.string().optional().describe('Required for goto'), timeoutMs: z.number().int().optional(),
  }, async ({ tabId, action, url, timeoutMs }) => { const id = await sessions.resolve(tabId, action === 'goto'); const r = await page.navigate(id, action, url, timeoutMs); recorder.record(id, 'browser_navigate', { action, url }); return r; });

  tool(ctx, 'browser_snapshot', 'Accessible snapshot of the page as an indented tree. Interactive elements get refs like [ref=e12] for click/fill/select/read/wait and the devtools_elements tool. Refs stay valid until the DOM changes; re-snapshot after navigation. diff:true returns only lines that changed since the previous snapshot of this tab.', {
    tabId: tabArg, diff: z.boolean().optional(),
  }, async ({ tabId, diff }) => {
    const s = await page.snapshot(await tab(tabId), diff);
    if (diff) return `Page: ${s.title}\nURL: ${s.url}\n\n${s.diff ?? '(no previous snapshot; full tree follows)\n\n' + s.tree}`;
    return `Page: ${s.title}\nURL: ${s.url}\n\n${s.tree || '(empty body)'}`;
  });

  tool(ctx, 'browser_read', 'Read page content: visible text, markdown (main content converted with headings, lists, links, code, tables), links, tables (as row arrays), or raw HTML. Optionally scoped to a ref.', {
    tabId: tabArg, what: z.enum(['text', 'markdown', 'links', 'tables', 'html']).default('text'), ref: refArg.optional(),
  }, async ({ tabId, what, ref }) => page.read(await tab(tabId), what, ref));

  tool(ctx, 'browser_fetch', 'Fetch a URL and return its main content as markdown (or text/html): opens a background agent tab, waits for load, reads, closes. Choose browserId for an extension browser or context for a developer browser when several are connected. Use for reading docs and articles.', {
    url: z.string(), what: z.enum(['markdown', 'text', 'html']).default('markdown'), context: z.string().min(1).optional(), browserId: z.string().min(1).optional(), keepTab: z.boolean().optional(), timeoutMs: z.number().int().optional(),
  }, async ({ url, what, context, browserId, keepTab, timeoutMs }) => {
    const id = await sessions.newTab('about:blank', undefined, context, false, browserId);
    try {
      if (defaultPolicy) await setPolicy(sessions, id, defaultPolicy);
      await page.navigate(id, 'goto', url, timeoutMs ?? 20_000);
      const title = await page.evaluate<string>(id, 'document.title');
      const content = await page.read(id, what);
      return { url: await page.evaluate<string>(id, 'location.href'), title, tabId: keepTab ? id : undefined, content: typeof content === 'string' ? content : JSON.stringify(content) };
    } finally { if (!keepTab) { forgetTab(id); await sessions.closeTab(id).catch(() => {}); } }
  });

  tool(ctx, 'browser_policy', 'Restrict where a tab (or every tab the agent opens from now on) may navigate and load from: allow lists domains that are permitted (everything else is blocked), block lists domains that are denied. Subdomains match. Non-http schemes always pass. Blocked navigations fail with ERR_BLOCKED_BY_CLIENT.', {
    action: z.enum(['set', 'clear', 'status']), tabId: tabArg, allow: z.array(z.string()).optional(), block: z.array(z.string()).optional(),
    default: z.boolean().optional().describe('set/clear: also make this the policy for tabs the agent opens later'),
  }, async ({ action, tabId, allow, block, default: dflt }) => {
    if (action === 'status') return { default: defaultPolicy ?? null, tabs: Object.fromEntries([...policies.entries()]) };
    const id = tabId !== undefined || !dflt ? await tab(tabId) : undefined;
    if (action === 'clear') { if (id !== undefined) await setPolicy(sessions, id, undefined); if (dflt) setDefaultPolicy(undefined); return `Policy cleared${id !== undefined ? ` for tab ${id}` : ''}${dflt ? ' and as default' : ''}`; }
    if (!allow?.length && !block?.length) throw new Error('allow or block required');
    const p: Policy = { ...(allow?.length && { allow }), ...(block?.length && { block }) };
    if (id !== undefined) await setPolicy(sessions, id, p);
    if (dflt) setDefaultPolicy(p);
    return `Policy ${JSON.stringify(p)} applied${id !== undefined ? ` to tab ${id}` : ''}${dflt ? ' and as default for new agent tabs' : ''}`;
  });

  tool(ctx, 'browser_download', 'Downloads started in the browser: list them, or wait for the newest matching download to complete, including one already completed, and get its file path when available. Developer mode saves into the context\'s download directory; extension mode reports downloads observed on shared tabs.', {
    action: z.enum(['list', 'wait']).default('list'), tabId: tabArg, urlContains: z.string().optional(), timeoutMs: z.number().int().optional().describe('wait: default 60000'),
  }, async ({ action, tabId, urlContains, timeoutMs }) => {
    const id = await tab(tabId);
    const dev = sessions.devOfTab(id);
    if (dev?.browserType === 'firefox' && !dev.downloadsSupported) throw new Error('Download tracking is unsupported in this Firefox version; update Firefox.');
    const list = async (): Promise<Download[]> => dev ? [...dev.downloads.values()] : await sessions.bridge.request<Download[]>('downloads.list', { tabId: id });
    const fmt = (d: Download) => ({ url: d.url, filename: d.filename, path: d.path, state: d.state, receivedBytes: d.receivedBytes, totalBytes: d.totalBytes, startedAt: new Date(d.startedAt).toISOString() });
    if (action === 'list') return (await list()).filter((d) => !urlContains || d.url.includes(urlContains)).sort((a, b) => b.startedAt - a.startedAt).slice(0, 30).map(fmt);
    const t0 = Date.now(), limit = timeoutMs ?? 60_000;
    while (Date.now() - t0 < limit) {
      const hit = (await list()).filter((d) => !urlContains || d.url.includes(urlContains)).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (hit?.state === 'completed') return fmt(hit);
      if (hit?.state === 'canceled') throw new Error(`Download canceled: ${hit.filename}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`No download completed within ${limit}ms${urlContains ? ` matching "${urlContains}"` : ''}`);
  });

  tool(ctx, 'browser_pdf', 'Print the page to a PDF file (like Print → Save as PDF). Returns the file path.', {
    tabId: tabArg, path: z.string().optional().describe('Write here instead of the artifacts directory'), landscape: z.boolean().optional(), format: z.enum(['A4', 'Letter', 'Legal']).optional(), printBackground: z.boolean().optional(), scale: z.number().optional(),
  }, async ({ tabId, path, landscape, format, printBackground, scale }) => {
    const id = await tab(tabId);
    const sizes: Record<string, [number, number]> = { A4: [8.27, 11.69], Letter: [8.5, 11], Legal: [8.5, 14] };
    const [w, h] = sizes[format ?? 'A4'];
    const r = await page.overlay.withHidden(id, () => sessions.cdp(id, 'Page.printToPDF', { landscape: !!landscape, printBackground: printBackground ?? true, paperWidth: w, paperHeight: h, scale: scale ?? 1, preferCSSPageSize: false }));
    const buf = Buffer.from(r.data, 'base64');
    if (path) { writeFileSync(path, buf); return `Wrote PDF (${buf.length} bytes) to ${path}`; }
    const art = saveArtifact('pdf', 'pdf', buf, (await page.evaluate<string>(id, 'document.title').catch(() => 'page')).slice(0, 40));
    return `Wrote PDF (${art.bytes} bytes) to ${art.path}`;
  });

  tool(ctx, 'browser_webmcp', 'WebMCP: pages can expose typed tools to agents via navigator.modelContext. list reports what the page exposes (or that it exposes nothing); invoke calls one by name.', {
    tabId: tabArg, action: z.enum(['list', 'invoke']).default('list'), name: z.string().optional(), args: z.record(z.string(), z.unknown()).optional(),
  }, async ({ tabId, action, name, args }) => {
    const id = await tab(tabId);
    const probe = `(async () => {
      const mc = navigator.modelContext; if (!mc) return { supported: false, note: 'navigator.modelContext is not present on this page' };
      let tools = [];
      try { tools = typeof mc.listTools === 'function' ? await mc.listTools() : Array.isArray(mc.tools) ? mc.tools : typeof mc.getTools === 'function' ? await mc.getTools() : []; } catch (e) { return { supported: true, error: String(e) }; }
      return { supported: true, tools: (tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? t.parameters ?? t.schema })) };
    })()`;
    if (action === 'list') return await page.evaluate(id, probe);
    if (!name) throw new Error('name required');
    return await page.evaluate(id, `(async () => {
      const mc = navigator.modelContext; if (!mc) throw new Error('navigator.modelContext is not present on this page');
      const tools = typeof mc.listTools === 'function' ? await mc.listTools() : Array.isArray(mc.tools) ? mc.tools : typeof mc.getTools === 'function' ? await mc.getTools() : [];
      const t = (tools || []).find((x) => x.name === ${JSON.stringify(name)}); if (!t) throw new Error('No WebMCP tool named ' + ${JSON.stringify(name)});
      const fn = t.execute ?? t.invoke ?? t.handler ?? t.call; if (typeof fn !== 'function') throw new Error('Tool has no callable execute/invoke');
      const r = await fn.call(t, ${JSON.stringify(args ?? {})}); return typeof r === 'string' ? r : JSON.parse(JSON.stringify(r ?? null));
    })()`);
  });

  tool(ctx, 'browser_extract', 'Structured extraction: for every element matching `items`, read named fields as text or an attribute. Returns an array of objects.', {
    tabId: tabArg, items: z.string().describe('CSS selector for repeated items, e.g. ".product"'),
    fields: z.record(z.string(), z.union([z.string(), z.object({ selector: z.string().optional(), attr: z.string().optional() })])).describe('field name -> selector, or {selector, attr}'),
    limit: z.number().int().optional(),
  }, async ({ tabId, ...spec }) => page.extract(await tab(tabId), spec));

  tool(ctx, 'browser_click', 'Click an element by ref. Chromium and Firefox developer sessions use native mouse input; the Firefox extension simulates ordinary left clicks. Hover (hover:true), drag (dragTo), modified and multiple clicks are unavailable in the Firefox extension.', {
    tabId: tabArg, ref: refArg, button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().min(1).max(3).optional().describe('2 for double-click'),
    modifiers: z.array(z.enum(['Shift', 'Control', 'Alt', 'Meta'])).optional(), hover: z.boolean().optional().describe('Only move the mouse over the element'), dragTo: refArg.optional().describe('Drag from ref to this ref'),
  }, async ({ tabId, ref, hover, dragTo, ...opts }) => {
    const id = await tab(tabId);
    const sel = await page.selectorFor(id, ref).catch(() => undefined);
    const r = hover ? await page.hover(id, ref) : dragTo ? await page.drag(id, ref, dragTo) : await page.click(id, ref, opts);
    recorder.record(id, 'browser_click', { ref, selector: sel, hover, dragTo, ...opts });
    return r;
  });

  tool(ctx, 'browser_fill', 'Replace the contents of a text input, textarea, or contenteditable. Use browser_select for <select>, browser_click for checkboxes, browser_upload for files.', {
    tabId: tabArg, ref: refArg, text: z.string(),
  }, async ({ tabId, ref, text: t }) => { const id = await tab(tabId); const sel = await page.selectorFor(id, ref).catch(() => undefined); const r = await page.fill(id, ref, t); recorder.record(id, 'browser_fill', { ref, selector: sel, text: t }); return r; });

  tool(ctx, 'browser_select', 'Choose option(s) in a <select> by value or visible label.', { tabId: tabArg, ref: refArg, values: z.array(z.string()).min(1) },
    async ({ tabId, ref, values }) => { const id = await tab(tabId); const sel = await page.selectorFor(id, ref).catch(() => undefined); const r = await page.select(id, ref, values); recorder.record(id, 'browser_select', { ref, selector: sel, values }); return r; });

  tool(ctx, 'browser_upload', 'Set files on an <input type=file> by ref. Paths must be readable by the browser machine.', { tabId: tabArg, ref: refArg, files: z.array(z.string()).min(1) },
    async ({ tabId, ref, files }) => page.upload(await tab(tabId), ref, files));

  tool(ctx, 'browser_key', 'Press a key or chord on the focused element ("Enter", "Tab", "Escape", "ArrowDown", "Shift+Tab", "a"), or type text. Keys go to the web page only: browser-level shortcuts (opening DevTools, Cmd+Shift+C, tab switching, reload) are handled by the browser UI and cannot be triggered this way; use the devtools_* tools instead. Editing shortcuts use the platform modifier (e.g. "Meta+a" on macOS, "Control+a" on Windows/Linux selects all).', {
    tabId: tabArg, key: z.string().optional(), text: z.string().optional(),
  }, async ({ tabId, key, text: t }) => {
    const id = await tab(tabId);
    if (!key && t === undefined) throw new Error('Provide key or text');
    const r = key ? await page.key(id, key) : await page.type(id, t!);
    recorder.record(id, 'browser_key', { key, text: t });
    return r;
  });

  tool(ctx, 'browser_scroll', 'Scroll the page, or the nearest scrollable ancestor of a ref.', {
    tabId: tabArg, direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional().describe('Pixels, default 600'), ref: refArg.optional(),
  }, async ({ tabId, ...opts }) => page.scroll(await tab(tabId), opts));

  tool(ctx, 'browser_screenshot', 'Screenshot the viewport, the full page, or one element.', {
    tabId: tabArg, fullPage: z.boolean().optional(), ref: refArg.optional(), format: z.enum(['png', 'jpeg']).optional(), quality: z.number().int().min(1).max(100).optional(),
  }, async ({ tabId, ...opts }) => { const r = await page.screenshotAdvanced(await tab(tabId), opts); return image(r.data, r.mimeType); });

  tool(ctx, 'browser_wait', 'Wait until text appears/disappears, the URL contains a string, or a ref reaches a state. Polls up to timeoutMs (default 15000).', {
    tabId: tabArg, text: z.string().optional(), textGone: z.string().optional(), url: z.string().optional(), ref: refArg.optional(), state: z.enum(['visible', 'hidden', 'enabled']).optional(), timeoutMs: z.number().int().max(120_000).optional(),
  }, async ({ tabId, timeoutMs, ...cond }) => { const id = await tab(tabId); const r = await page.wait(id, cond, timeoutMs); recorder.record(id, 'browser_wait', { ...cond, timeoutMs }); return r; });

  tool(ctx, 'browser_dialog', 'Accept or dismiss an open JavaScript alert/confirm/prompt/beforeunload dialog. browser_status shows open dialogs.', {
    tabId: tabArg, accept: z.boolean().default(true), promptText: z.string().optional(),
  }, async ({ tabId, accept, promptText }) => page.dialog(await tab(tabId), accept, promptText));

  tool(ctx, 'browser_batch', 'Run several tool calls in order in one round trip. Stops at the first error. Each step is {tool, args}.', {
    steps: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).optional() })).min(1).max(50),
  }, async ({ steps }) => {
    const out: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].tool === 'browser_batch') throw new Error(`Step ${i + 1}: nested browser_batch is not allowed`);
      const fn = registry.get(steps[i].tool);
      if (!fn) throw new Error(`Step ${i + 1}: unknown tool ${steps[i].tool}`);
      const r = await fn(steps[i].args ?? {});
      const t = r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
      out.push(`${i + 1}. ${steps[i].tool}: ${t || '(image)'}`);
      if (r.isError) { out.push(`Stopped at step ${i + 1}.`); return { ...text(out.join('\n')), isError: true }; }
    }
    return out.join('\n');
  });
}
