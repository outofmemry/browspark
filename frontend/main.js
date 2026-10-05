import { highlightCode } from './highlight.js';

document.documentElement.classList.add('js');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Header: mobile menu and a solid background once the page scrolls.
const header = document.querySelector('.site-header');
const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
const closeMenu = () => { menu.setAttribute('aria-expanded', 'false'); navigation.classList.remove('is-open'); };
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('is-open', open);
});
navigation.addEventListener('click', (event) => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); } });
const onScroll = () => header.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Dashboard preview: views and shared-tab switches.
for (const button of document.querySelectorAll('[data-preview]')) {
  button.addEventListener('click', () => {
    for (const item of document.querySelectorAll('[data-preview]')) {
      const selected = item === button;
      item.setAttribute('aria-pressed', String(selected));
      document.querySelector(`#preview-${item.dataset.preview}`).hidden = !selected;
    }
  });
}

const sharedSummary = () => {
  const tabs = [...document.querySelectorAll('[data-share]:checked')];
  const browsers = new Set(tabs.map((input) => input.dataset.browser)).size;
  return tabs.length ? `${tabs.length} shared ${tabs.length === 1 ? 'tab' : 'tabs'} · ${browsers} ${browsers === 1 ? 'browser' : 'browsers'}` : 'No shared tabs available';
};
for (const input of document.querySelectorAll('[data-share]')) {
  input.addEventListener('change', () => {
    const count = document.querySelectorAll('[data-share]:checked').length;
    document.querySelector('#shared-count').textContent = count;
    document.querySelector('#nav-tab-count').textContent = count;
    const permission = input.closest('.demo-tab').querySelector('.tab-permission');
    permission.textContent = input.checked ? 'Shared' : 'Private';
    permission.classList.toggle('private', !input.checked);
    document.querySelector('#demo-result').textContent = sharedSummary();
  });
}

// Quickstart: one configuration per MCP client, remembered across visits.
const pkg = 'browspark-mcp@latest';
const stdio = { command: 'bunx', args: [pkg] };
const local = JSON.stringify({ mcp: { browspark: { type: 'local', command: ['bunx', pkg], enabled: true } } }, null, 2);
const clients = {
  claude: { name: 'Claude Code', file: 'Terminal', instruction: 'Run this command in your terminal to register Browspark for all your projects.', code: `claude mcp add --transport stdio --scope user browspark -- bunx ${pkg}`, next: 'Start a new session, then check /mcp.', docs: 'https://code.claude.com/docs/en/mcp' },
  codex: { name: 'Codex', file: 'Terminal · Codex CLI', instruction: 'Run this command in your terminal. Codex saves the server in ~/.codex/config.toml.', code: `codex mcp add browspark -- bunx ${pkg}`, next: 'Restart your Codex client, then check MCP settings.', docs: 'https://developers.openai.com/codex/mcp/' },
  opencode: { name: 'OpenCode', file: '~/.config/opencode/opencode.json', instruction: 'Add this entry to your global OpenCode config, keeping any existing servers.', code: local, next: 'Restart OpenCode, then run opencode mcp list.', docs: 'https://opencode.ai/docs/mcp-servers/' },
  cursor: { name: 'Cursor', file: '~/.cursor/mcp.json', instruction: 'Add this entry to your global Cursor config, keeping any existing servers.', code: JSON.stringify({ mcpServers: { browspark: { type: 'stdio', ...stdio } } }, null, 2), next: 'Restart Cursor, then enable the server in Customize → MCP.', docs: 'https://cursor.com/docs/mcp' },
  antigravity: { name: 'Antigravity', file: 'mcp_config.json', instruction: 'Open the Agent panel → … → MCP Servers → Manage MCP Servers → View raw config. Add this entry, keeping existing servers.', code: JSON.stringify({ mcpServers: { browspark: stdio } }, null, 2), next: 'Save, then check Browspark in MCP management.', docs: 'https://antigravity.google/docs/mcp' },
  muse: { name: 'Muse Code', file: '~/.config/muse/settings.json', instruction: 'Add this entry under mcpServers in ~/.config/muse/settings.json, keeping any existing servers.', code: JSON.stringify({ mcpServers: { browspark: { mode: 'optional', transport: 'stdio', ...stdio } } }, null, 2), next: 'Restart Muse Code, then check that Browspark is listed among its MCP servers.', docs: 'https://dev.meta.ai/docs/muse-code/extending#mcp' },
  hermes: { name: 'Hermes', file: '~/.hermes/config.yaml', instruction: 'Add this entry under mcp_servers in ~/.hermes/config.yaml, keeping any existing servers.', code: `mcp_servers:\n  browspark:\n    command: "bunx"\n    args: ["${pkg}"]`, next: 'Restart Hermes, then check that Browspark is listed among its MCP servers.', docs: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp' },
  cline: { name: 'Cline', file: 'VSCode → Cline → MCP Servers', instruction: 'Open the Cline extension → MCP Servers → Configure MCP Servers. Add this entry, keeping existing servers.', code: JSON.stringify({ mcpServers: { browspark: stdio } }, null, 2), next: 'Save, then check Browspark in the Cline MCP server list.', docs: 'https://cline.bot' },
  kilo: { name: 'Kilo Code', file: 'VSCode → Kilo Code → MCP Servers', instruction: 'Open the Kilo Code extension → MCP Servers → Configure MCP Servers. Add this entry, keeping existing servers.', code: JSON.stringify({ mcpServers: { browspark: stdio } }, null, 2), next: 'Save, then check Browspark in the Kilo Code MCP server list.', docs: 'https://kilocode.ai' },
  openclaw: { name: 'OpenClaw', file: '~/.openclaw/openclaw.json', instruction: 'Add this entry to your OpenClaw config, keeping any existing servers.', code: JSON.stringify({ mcpServers: { browspark: stdio } }, null, 2), next: 'Restart OpenClaw, then check that Browspark is listed among its MCP servers.', docs: 'https://openclaw.ai' },
  pi: { name: 'Pi', file: 'Pi MCP config', instruction: 'Add this entry to your Pi MCP config, keeping any existing servers.', code: JSON.stringify({ mcpServers: { browspark: stdio } }, null, 2), next: 'Restart Pi, then check that Browspark is listed among its MCP servers.', docs: 'https://pi.dev' },
  commandcode: { name: 'Command Code', file: 'Command Code MCP config', instruction: 'Add this entry to your Command Code MCP config, keeping any existing servers.', code: JSON.stringify({ mcpServers: { browspark: stdio } }, null, 2), next: 'Restart Command Code, then check that Browspark is listed among its MCP servers.', docs: 'https://commandcode.ai/' },
};
function chooseClient(id) {
  if (!Object.hasOwn(clients, id)) return;
  const client = clients[id];
  for (const button of document.querySelectorAll('[data-client]')) button.setAttribute('aria-pressed', String(button.dataset.client === id));
  document.querySelector('#client-name').textContent = client.name;
  document.querySelector('#client-instruction').textContent = client.instruction;
  document.querySelector('#config-file').textContent = client.file;
  document.querySelector('#client-command').innerHTML = highlightCode(client.code);
  document.querySelector('.client-config').setAttribute('aria-label', `${client.name} configuration`);
  document.querySelector('#client-next').textContent = client.next;
  document.querySelector('#client-docs').href = client.docs;
  document.querySelector('#client-docs-label').textContent = `Read docs for ${client.name}`;
  try { localStorage.setItem('browspark-client', id); } catch {}
}
for (const button of document.querySelectorAll('[data-client]')) button.addEventListener('click', () => chooseClient(button.dataset.client));
document.addEventListener('click', (event) => { const link = event.target.closest('[data-choose-client]'); if (link) chooseClient(link.dataset.chooseClient); });
let savedClient;
try { savedClient = localStorage.getItem('browspark-client'); } catch {}
chooseClient(Object.hasOwn(clients, savedClient) ? savedClient : 'claude');

// Copy buttons, with a selection fallback when the clipboard is unavailable.
const toast = document.querySelector('#copy-status');
let toastTimer;
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(code.textContent);
      toast.textContent = 'Copied to clipboard';
      button.classList.add('copied');
      setTimeout(() => button.classList.remove('copied'), 1400);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      toast.textContent = 'Select and copy the highlighted command.';
      (code.closest('pre') ?? code).focus?.();
    }
    clearTimeout(toastTimer);
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  });
}

// Hero graph: connection lines follow the laid-out nodes at every width.
const stage = document.querySelector('#viz-stage');
const lines = document.querySelector('#viz-lines');
const SVG = 'http://www.w3.org/2000/svg';
function curve(a, b) {
  const sideways = b.left >= a.right - 4;
  if (sideways) {
    const x1 = a.right, y1 = a.top + a.height / 2, x2 = b.left, y2 = b.top + b.height / 2, bend = Math.max(28, (x2 - x1) / 2);
    return `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
  }
  const x1 = a.left + a.width / 2, y1 = a.bottom, x2 = b.left + b.width / 2, y2 = b.top, bend = Math.max(18, (y2 - y1) / 2);
  return `M${x1} ${y1} C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2}`;
}
function drawLines() {
  const box = stage.getBoundingClientRect();
  const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top, width: r.width, height: r.height }; };
  const hub = rect(stage.querySelector('[data-viz="hub"]'));
  lines.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  lines.replaceChildren(...[...stage.querySelectorAll('.viz-node')].map((node, i) => {
    const agent = node.dataset.viz.startsWith('agent');
    const d = agent ? curve(rect(node), hub) : curve(hub, rect(node));
    const group = document.createElementNS(SVG, 'g');
    group.setAttribute('class', `viz-edge ${agent ? 'agent' : 'browser'}`);
    group.dataset.edge = node.dataset.viz;
    for (const cls of ['base', 'flow']) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      if (cls === 'flow') path.style.animationDelay = `-${(i * .45).toFixed(2)}s`;
      group.append(path);
    }
    return group;
  }));
}
if (stage) {
  new ResizeObserver(drawLines).observe(stage);
  for (const image of stage.querySelectorAll('img')) if (!image.complete) image.addEventListener('load', drawLines, { once: true });
}
const highlight = (agent, browser) => {
  for (const el of stage.querySelectorAll('.is-active')) el.classList.remove('is-active');
  const keys = [agent === undefined ? null : `agent-${agent}`, browser === undefined ? null : `browser-${browser}`].filter(Boolean);
  if (!keys.length) return;
  stage.querySelector('[data-viz="hub"]').classList.add('is-active');
  for (const key of keys) {
    stage.querySelector(`[data-viz="${key}"]`)?.classList.add('is-active');
    stage.querySelector(`[data-edge="${key}"]`)?.classList.add('is-active');
  }
};

// Tool ticker: real tool calls, with the agent and browser involved lit up in the graph.
const command = document.querySelector('#demo-command');
const result = document.querySelector('#demo-result');
const CALLS = [
  ['browser_tabs', '({ onlyUsable: true })', sharedSummary, 0, 0],
  ['browser_status', '()', 'Chrome + Brave · Firefox + Zen contexts', 1],
  ['browser_snapshot', '({ tabId: 2147483648 })', 'Chrome · accessible tree with refs', 0, 0],
  ['browser_click', '({ tabId: 2147483648, ref: "e12" })', 'Chrome · clicked "Checkout"', 0, 0],
  ['devtools_session', '({ tabId: 2147483648, action: "start" })', 'Chrome · collecting console and network', 2, 0],
  ['devtools_network', '({ tabId: 2147483648, query: "/api" })', '3 requests · 1 slow (412 ms)', 2, 0],
  ['devtools_console', '({ tabId: 2147483648, level: ["error"] })', '1 exception · stack mapped to app.ts:41', 1, 0],
  ['devtools_performance', '({ tabId: 2147483648, action: "vitals" })', 'Chrome · LCP 1.2 s · 2 long tasks', 0, 0],
  ['browser_tabs', '({ context: "firefox" })', 'Firefox · separate developer profile', 1, 2],
  ['browser_tabs', '({ context: "zen" })', 'Zen · separate developer profile', 2, 3],
];
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const check = '<svg class="icon small"><use href="#i-check"/></svg>';
let index = 0, timer, pinnedUntil = 0;
const show = (tool, args, text) => {
  command.innerHTML = `<span class="tool">${tool}</span><span class="arg">${escapeHtml(args)}</span>`;
  result.innerHTML = `${escapeHtml(text)} ${check}`;
};
async function tick() {
  if (Date.now() < pinnedUntil) { timer = setTimeout(tick, pinnedUntil - Date.now()); return; }
  const [tool, args, text, agent, browser] = CALLS[index];
  index = (index + 1) % CALLS.length;
  const full = tool + args;
  result.classList.add('pending');
  highlight(agent, browser);
  if (reduceMotion) {
    show(tool, args, typeof text === 'function' ? text() : text);
  } else {
    command.classList.add('typing');
    for (let i = 1; i <= full.length; i++) {
      const head = full.slice(0, i);
      command.innerHTML = head.length <= tool.length ? `<span class="tool">${head}</span>` : `<span class="tool">${tool}</span><span class="arg">${escapeHtml(head.slice(tool.length))}</span>`;
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 320));
    command.classList.remove('typing');
    result.innerHTML = `${escapeHtml(typeof text === 'function' ? text() : text)} ${check}`;
  }
  result.classList.remove('pending');
  timer = setTimeout(tick, reduceMotion ? 3200 : 2800);
}
for (const input of document.querySelectorAll('[data-share]')) {
  input.addEventListener('change', () => {
    clearTimeout(timer);
    index = 1;
    show('browser_tabs', '({ onlyUsable: true })', sharedSummary());
    highlight(0, 0);
    result.classList.remove('pending');
    pinnedUntil = Date.now() + 4000;
    timer = setTimeout(tick, 4000);
  });
}
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) timer = setTimeout(tick, 600); });
timer = setTimeout(tick, 1200);

// Client marquee: a hidden copy makes the loop seamless; reduced motion keeps the static wrapped list.
const logos = document.querySelector('.client-logos');
if (logos && !reduceMotion) {
  const copy = logos.cloneNode(true);
  copy.setAttribute('aria-hidden', 'true');
  for (const link of copy.querySelectorAll('a')) link.tabIndex = -1;
  logos.after(copy);
  logos.parentElement.classList.add('is-moving');
}

// Scroll reveals: sections animate in once when they enter the viewport.
for (const el of document.querySelectorAll('.section-intro, .product-preview, .how-steps > li, .bento > *, .graph-preview, .graph-details > div, .quickstart-grid, .faqs, .closing-inner')) el.classList.add('reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  for (const el of document.querySelectorAll('.reveal, .inspector')) io.observe(el);
} else {
  for (const el of document.querySelectorAll('.reveal, .inspector')) el.classList.add('in');
}
