// Generates docs/reference/capability-matrix.mdx by probing CDP domains live in both connection modes.
// Run: bun companion/test/capabilities.ts   (launches one throwaway Chrome with the extension and one headless dev Chrome)
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startTestServer } from '../../test-apps/server.ts';
import { launchExtensionChrome, startCompanion, callers, pairAndShare, ROOT } from './harness.ts';

const { server, url } = await startTestServer(join(ROOT, 'test-apps'));
const ext = await launchExtensionChrome();
const client = await startCompanion();
const { ok, okJson } = callers(client);
try {
  await ext.cdp.send('Target.createTarget', { url: url + 'debug.html' });
  const extTab = await pairAndShare(ext, ok, url + 'debug.html');
  const extCaps = await okJson('devtools_capabilities', { tabId: extTab, refresh: true });
  await ok('browser_session', { action: 'launch', headless: true, userRequested: true, url: url + 'debug.html' });
  const devTab = Number(/\[(\d+)\] dev/.exec(await ok('browser_tabs'))![1]);
  const devCaps = await okJson('devtools_capabilities', { tabId: devTab, refresh: true });
  const domains = [...new Set([...Object.keys(extCaps.domains), ...Object.keys(devCaps.domains)])];
  const mark = (v: string) => (v === 'supported' ? '✅' : `${v.startsWith('unprobed:') ? '—' : '❌'} ${v.replace(/^(unsupported|unprobed): /, '').replace(/[{}"]/g, '').slice(0, 60)}`);
  const rows = domains.map((d) => `| ${d} | ${mark(extCaps.domains[d] ?? 'unsupported: not probed')} | ${mark(devCaps.domains[d] ?? 'unsupported: not probed')} |`);
  const md = `# Capability matrix

Probed live by \`bun companion/test/capabilities.ts\` on ${new Date().toISOString().slice(0, 10)}.

These results describe the Chromium build below. They do not describe Firefox or Zen; see [Firefox and Zen coverage](/reference/firefox). Run \`devtools_capabilities\` with the intended \`tabId\` to check another connected browser. A supported domain does not imply that every command is available; Media is left unprobed because its available probes change browser state.

- Extension mode: ${extCaps.browser} via chrome.debugger (extension v${/v([\d.]+)/.exec(await ok('browser_status'))?.[1] ?? '?'})
- Developer mode: ${devCaps.browser} via direct CDP

| CDP domain | Extension mode | Developer mode |
|---|---|---|
${rows.join('\n')}

## What that means for the tools

| Tool | Extension mode | Developer mode |
|---|---|---|
| browser_* automation | ✅ shared tabs only | ✅ every tab |
| devtools_console, devtools_evaluate, devtools_network, devtools_sources, devtools_debugger, devtools_elements | ✅ | ✅ |
| devtools_storage | ✅ cookies via CDP, web storage via page JavaScript | ✅ |
| devtools_workers | ${extCaps.domains.ServiceWorker === 'supported' ? '✅' : '⚠️ registrations via the page; update/unregister via the page; skipWaiting/start/evaluate need developer mode'} | ✅ |
| devtools_performance (tracing) | ${extCaps.domains.Tracing === 'supported' ? '✅' : '❌'} | ✅ |
| devtools_profile (CPU) | ${extCaps.domains.Profiler === 'supported' ? '✅' : '❌'} | ✅ |
| devtools_memory (heap) | ${extCaps.domains.HeapProfiler === 'supported' ? '✅' : '❌ HeapProfiler not exposed to extensions'} | ✅ |
| devtools_coverage | ${extCaps.domains.Profiler === 'supported' ? '✅' : '❌'} | ✅ |
| devtools_emulation | ✅ | ✅ |
| devtools_accessibility, devtools_security | ✅ | ✅ |
| devtools_lighthouse | ❌ developer mode only | ✅ |
| devtools_cdp (raw commands) | ❌ developer mode only | ✅ |
| Browser-wide operations (Target, Browser, Storage domains) | ${extCaps.domains.Target === 'supported' ? '✅' : '❌ not exposed to extensions'} | ✅ |

## Other extensions (browser_extensions)

| Capability | Chromium extension | Firefox / Zen extension |
|---|---|---|
| list, info, enable, disable | ✅ needs the \`management\` permission and user consent | ✅ |
| uninstall | ✅ the browser asks the user to confirm | ✅ the browser asks the user to confirm |
| message (\`runtime.sendMessage\`) | ✅ target must accept Browspark in \`externally_connectable\` | ✅ same rule |
| open options page | ✅ | ✅ |
| automate the options page | ⚠️ only when the user shares options pages; the browser may still refuse the debugger | ❌ HTTP(S) pages only |
| read another extension's storage | ❌ | ❌ |
| \`chrome://extensions\`, store and add-on pages | ❌ always blocked | ❌ always blocked |
`;
  writeFileSync(join(ROOT, 'docs/reference/capability-matrix.mdx'), `---\ntitle: "Capability matrix"\ndescription: "Which DevTools Protocol domains work in extension mode versus developer mode, probed live."\n---\n\n` + md.replace(/^# Capability matrix\n\n/, '').replace('`bun companion/test/capabilities.ts`', '`bun run capabilities`'));
  console.log(md);
} finally {
  await ok('browser_session', { action: 'close' }).catch(() => {});
  await client.close().catch(() => {});
  await ext.cleanup();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
