import { highlightCode } from './highlight.js';

document.documentElement.classList.add('js');

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
for (const link of document.querySelectorAll('[data-choose-client]')) link.addEventListener('click', () => chooseClient(link.dataset.chooseClient));
let savedClient;
try { savedClient = localStorage.getItem('browspark-client'); } catch {}
chooseClient(Object.hasOwn(clients, savedClient) ? savedClient : 'claude');

const toast = document.querySelector('#copy-status');
let toastTimer;
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(code.textContent);
      toast.textContent = 'Copied to clipboard';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
      toast.textContent = 'Select and copy the highlighted command.';
      code.closest('pre').focus();
    }
    clearTimeout(toastTimer);
    toast.classList.add('show');
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  });
}

// Tool ticker: cycles through real tool calls in the preview terminal.
const command = document.querySelector('#demo-command');
const result = document.querySelector('#demo-result');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const CALLS = [
  ['browser_tabs', '({ onlyUsable: true })', sharedSummary],
  ['browser_status', '()', 'Chrome + Brave · Firefox + Zen contexts'],
  ['browser_snapshot', '({ tabId: 2147483648 })', 'Chrome · accessible tree with refs'],
  ['browser_click', '({ tabId: 2147483648, ref: "e12" })', 'Chrome · clicked "Checkout"'],
  ['devtools_session', '({ tabId: 2147483648, action: "start" })', 'Chrome · collecting console and network'],
  ['devtools_network', '({ tabId: 2147483648, query: "/api" })', '3 requests · 1 slow (412 ms)'],
  ['devtools_console', '({ tabId: 2147483648, level: ["error"] })', '1 exception · stack mapped to app.ts:41'],
  ['devtools_performance', '({ tabId: 2147483648, action: "vitals" })', 'Chrome · LCP 1.2 s · 2 long tasks'],
  ['browser_tabs', '({ context: "firefox" })', 'Firefox · separate developer profile'],
  ['browser_tabs', '({ context: "zen" })', 'Zen · separate developer profile'],
];
const check = '<svg class="icon small"><use href="#i-check"/></svg>';
let index = 0, timer, pinnedUntil = 0;
const show = (tool, args, text) => {
  command.innerHTML = `<span class="tool">${tool}</span><span class="arg">${args}</span>`;
  result.innerHTML = `${text} ${check}`;
};
async function tick() {
  if (Date.now() < pinnedUntil) { timer = setTimeout(tick, pinnedUntil - Date.now()); return; }
  const [tool, args, text] = CALLS[index];
  index = (index + 1) % CALLS.length;
  const full = tool + args;
  result.classList.add('pending');
  if (reduceMotion) {
    show(tool, args, typeof text === 'function' ? text() : text);
  } else {
    command.classList.add('typing');
    for (let i = 1; i <= full.length; i++) {
      const head = full.slice(0, i);
      command.innerHTML = head.length <= tool.length ? `<span class="tool">${head}</span>` : `<span class="tool">${tool}</span><span class="arg">${head.slice(tool.length)}</span>`;
      await new Promise((r) => setTimeout(r, 22));
    }
    await new Promise((r) => setTimeout(r, 350));
    command.classList.remove('typing');
    result.innerHTML = `${typeof text === 'function' ? text() : text} ${check}`;
  }
  result.classList.remove('pending');
  timer = setTimeout(tick, reduceMotion ? 3200 : 2800);
}
for (const input of document.querySelectorAll('[data-share]')) {
  input.addEventListener('change', () => {
    clearTimeout(timer);
    index = 1;
    show('browser_tabs', '({ onlyUsable: true })', sharedSummary());
    result.classList.remove('pending');
    pinnedUntil = Date.now() + 4000;
    timer = setTimeout(tick, 4000);
  });
}
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) timer = setTimeout(tick, 600); });
timer = setTimeout(tick, 1200);

// Scroll reveals: sections and the inspector animate in once when they enter the viewport.
for (const el of document.querySelectorAll('.feature, .developer-feature, .integrations, .client-showcase, .closing, .faq-section > div')) el.classList.add('reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.2 });
  for (const el of document.querySelectorAll('.reveal, .inspector')) io.observe(el);
} else {
  for (const el of document.querySelectorAll('.reveal, .inspector')) el.classList.add('in');
}
