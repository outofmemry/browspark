import { compareVersions, isNewTab, type TabInfo } from '../../../shared/protocol.ts';
import type { PopupMsg, State } from './state.ts';
import { api, FIREFOX_PERMISSIONS } from './browser.ts';
import { graphBrand, labelOptions } from './brands.ts';
import { graphPosition, graphCurve, syncGraphCanvas, zoomGraph, resetGraphLayout } from './graph-canvas.ts';

// ---------- helpers ----------
const ask = (m: PopupMsg) => api.runtime.sendMessage(m) as Promise<State>;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Props = Record<string, unknown>;
const h = (tag: string, attrs: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined | false)[]) => {
  const e = document.createElement(tag);
  const props: Props = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k.startsWith('on') || (k in e && typeof v !== 'string')) { (e as any)[k] = v; props[k] = v; }
    else if (k === 'html') e.innerHTML = String(v);
    else e.setAttribute(k, String(v));
  }
  (e as any).__p = props;
  for (const k of kids) if (k) e.append(k);
  return e;
};

/** Patch `a` to look like `b`, keeping node identity where possible (no flicker, hover and scroll survive). */
function morph(a: Node, b: Node) {
  if (a.nodeType !== b.nodeType || (a as Element).tagName !== (b as Element).tagName) { a.parentNode!.replaceChild(b, a); return; }
  if (a.nodeType !== Node.ELEMENT_NODE) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  const ea = a as HTMLElement, eb = b as HTMLElement;
  for (const at of [...ea.attributes]) if (!eb.hasAttribute(at.name)) ea.removeAttribute(at.name);
  for (const at of [...eb.attributes]) if (ea.getAttribute(at.name) !== at.value) ea.setAttribute(at.name, at.value);
  const pa: Props = (ea as any).__p ?? {}, pb: Props = (eb as any).__p ?? {};
  const focused = document.activeElement === ea;
  for (const k in pb) { if (k === 'value' && focused) continue; if ((ea as any)[k] !== pb[k]) (ea as any)[k] = pb[k]; }
  for (const k in pa) if (!(k in pb)) (ea as any)[k] = typeof pa[k] === 'boolean' ? false : typeof pa[k] === 'function' ? null : '';
  (ea as any).__p = pb;
  if (ea.tagName === 'svg' && !ea.classList.contains('graph-connections')) { if (ea.innerHTML !== eb.innerHTML) ea.innerHTML = eb.innerHTML; return; }
  const next = [...eb.childNodes];
  const keyed = new Map<string, Node>();
  for (const n of ea.childNodes) { const k = (n as HTMLElement).dataset?.key; if (k) keyed.set(k, n); }
  next.forEach((nb, i) => {
    const key = (nb as HTMLElement).dataset?.key;
    let na: Node | undefined = key ? keyed.get(key) : ea.childNodes[i];
    if (na && na !== ea.childNodes[i]) ea.insertBefore(na, ea.childNodes[i] ?? null);
    if (!na) ea.insertBefore(nb, ea.childNodes[i] ?? null); else morph(na, nb);
  });
  while (ea.childNodes.length > next.length) ea.removeChild(ea.lastChild!);
}
const patch = (container: HTMLElement, ...kids: (Node | null | undefined | false)[]) => { const tmp = container.cloneNode(false) as HTMLElement; tmp.append(...kids.filter((k): k is Node => !!k)); morph(container, tmp); };
const I = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  tabs: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  graph: '<rect x="9" y="9" width="6" height="6" rx="1.5"/><circle cx="4" cy="4" r="2"/><circle cx="20" cy="4" r="2"/><circle cx="4" cy="20" r="2"/><circle cx="20" cy="20" r="2"/><path d="m6 6 3 3m6 0 3-3M6 18l3-3m6 0 3 3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  external: '<path d="M7 17 17 7M8 7h9v9"/>',
  tools: '<path d="m8 8-4 4 4 4m8-8 4 4-4 4M14 4l-4 16"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  puzzle: '<path d="M10 3a2 2 0 1 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 1 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 1 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 1 0 0-4H5V6a1 1 0 0 1 1-1h4z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  terminal: '<path d="m5 7 5 5-5 5M12 19h7"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  up: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};
const icon = (name: keyof typeof I) => h('span', { html: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${I[name]}</svg>` }).firstElementChild as SVGElement;
const host = (u: string) => { try { return new URL(u).host; } catch { return ''; } };
const initial = (t: TabInfo) => (host(t.url).replace(/^www\./, '') || t.title || '?')[0]?.toUpperCase() ?? '?';
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const ago = (t: number) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const plural = (n: number, label: string) => `${n} ${label}${n === 1 ? '' : 's'}`;
const OWN = api.runtime.getURL('');
const isOwn = (t: TabInfo) => t.url.startsWith(OWN);
const canShare = (t: TabInfo) => !t.unsupported || isNewTab(t.url);

// ---------- state ----------
let state: State | undefined;
let route = location.hash.replace(/^#\/?/, '') || 'overview';
let editing = false;
let connectionAction: 'connect' | 'stop' | undefined;
let connectionEpoch = 0;
const ui = { search: '', tabFilter: 'all' as 'all' | 'shared' | 'available', logFilter: 'all' as 'all' | 'errors', theme: 'system', setupClient: 'claude', setupOpen: undefined as boolean | undefined, toolSearch: '', toolFilter: 'all' as 'all' | 'on' | 'off', expanded: new Set<string>(), updateOpen: false, updatePath: '', agentsStopped: 0 };
try { ui.theme = localStorage.getItem('theme') || 'system'; ui.setupClient = localStorage.getItem('setupClient') || 'claude'; } catch {}
applyTheme();

function applyTheme() {
  if (ui.theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', ui.theme);
}

async function changeConnection(message: Extract<PopupMsg, { type: 'connect' | 'setConfig' | 'stop' }>) {
  const stopping = message.type === 'stop';
  if (!stopping && (connectionAction || state?.connecting)) return;
  const epoch = ++connectionEpoch;
  connectionAction = stopping ? 'stop' : 'connect';
  if (state) paint({ ...state, ...(message.type === 'setConfig' && { port: message.port }) });
  try {
    const next = await ask(message);
    if (epoch !== connectionEpoch) return;
    connectionAction = undefined;
    paint(next);
  } catch (e) {
    if (epoch !== connectionEpoch) return;
    connectionAction = undefined;
    paint({ ...normalize(state), connected: false, connecting: false, lastError: (e as Error).message || String(e) });
  }
}
const connectionBusy = (s: State) => s.connecting || !!connectionAction;
const spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });

// ---------- brand logos ----------
/** `<picture>` that follows the dashboard theme for logos with a dark variant. */
const brandImage = (brand: ReturnType<typeof graphBrand>, cls: string) => h('picture', {},
  brand.darkSrc ? h('source', { media: ui.theme === 'system' ? '(prefers-color-scheme: dark)' : ui.theme === 'dark' ? 'all' : 'not all', srcset: brand.darkSrc }) : null,
  h('img', { class: cls, src: brand.src, alt: '', draggable: 'false' }));
const browserBrand = (s: State, b: NonNullable<State['graph']>['browsers'][number]) => graphBrand(b.name, 'browser', b.browserEngine ?? (b.id === s.graph?.thisBrowserId ? s.browserEngine : undefined));
function favicon(t: TabInfo) {
  const fav = h('span', { class: 'fav', 'aria-hidden': 'true' });
  if (t.favIconUrl) { const img = h('img', { src: t.favIconUrl, alt: '' }) as HTMLImageElement; img.onerror = () => fav.replaceChildren(initial(t)); fav.append(img); } else fav.textContent = initial(t);
  return fav;
}

// ---------- shell ----------
const NAV: [string, keyof typeof I, string][] = [['overview', 'home', 'Overview'], ['tabs', 'tabs', 'Tabs'], ['graph', 'graph', 'Graph'], ['tools', 'tools', 'Tools'], ['activity', 'activity', 'Activity'], ['settings', 'settings', 'Settings']];
/** Update the dashboard's shared navigation, connection status, version, update prompt, and theme controls in place. */
function renderShell(s: State) {
  $('ver').textContent = `v${s.extensionVersion}`;
  $('crumb').textContent = NAV.find(([r]) => r === route)?.[2] ?? 'Overview';
  $('session-status').className = `local-badge ${s.connected ? 'ok' : s.connecting ? 'pending' : s.stopped || s.lastError ? 'bad' : ''}`;
  $('session-status').setAttribute('role', 'status');
  $('session-status').setAttribute('aria-busy', String(s.connecting));
  patch($('session-status'), s.connecting ? spinner() : h('span', { class: 'dot' }), h('span', {}, s.connecting ? 'Reconnecting…' : s.connected ? 'Connected' : s.lastError ? 'Disconnected' : s.stopped ? 'Access paused' : 'Disconnected'));
  patch($('nav'), ...NAV.filter(([r]) => r !== 'graph' || s.graphEnabled).map(([r, ic, label]) => {
    const n = r === 'tabs' ? s.tabs.filter((t) => t.shared && canShare(t)).length : r === 'tools' ? s.toolCatalog.length : 0;
    return h('a', { href: `#/${r}`, class: route === r ? 'on' : '', 'aria-current': route === r ? 'page' : undefined, 'data-key': r }, icon(ic), h('span', { class: 'nav-text' }, label), n ? h('span', { class: 'n' }, String(n)) : null);
  }));
  patch($('update-slot'), updateSidebar(s));
  patch($('theme'), ...([['system', 'monitor'], ['light', 'sun'], ['dark', 'moon']] as [string, keyof typeof I][]).map(([t, ic]) =>
    h('button', { class: ui.theme === t ? 'on' : '', title: `${t[0].toUpperCase()}${t.slice(1)} theme`, 'aria-label': `${t[0].toUpperCase()}${t.slice(1)} theme`, 'aria-pressed': String(ui.theme === t), onclick: () => { ui.theme = t; try { localStorage.setItem('theme', t); } catch {} applyTheme(); repaint(); } }, icon(ic))));
}

// ---------- views ----------
const pageHeader = (title: string, sub: string, ...actions: (Node | null)[]) => h('div', { class: 'page-h' }, h('div', { class: 'page-h-copy' }, h('h1', {}, title), h('p', {}, sub)), actions.filter(Boolean).length ? h('div', { class: 'actions' }, ...actions) : null);
const cardHead = (ic: keyof typeof I, title: string, ...rest: (Node | string | null)[]) => h('div', { class: 'card-h' }, h('span', { class: 'card-icon', 'aria-hidden': 'true' }, icon(ic)), h('h2', {}, title), ...rest);
const stat = (o: { k: string; v: string | number; extra?: string; cls?: string; icon: keyof typeof I; meter?: number }) => h('div', { class: 'stat' },
  h('div', { class: 'stat-top' }, h('div', { class: 'k' }, o.k), h('span', { class: 'stat-icon', 'aria-hidden': 'true' }, icon(o.icon))),
  h('div', { class: `v ${o.cls ?? ''}` }, String(o.v), o.extra ? h('small', {}, o.extra) : null),
  o.meter === undefined ? null : h('div', { class: 'meter', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.round(Math.min(1, Math.max(0, o.meter)) * 100)}%` })));
const empty = (ic: keyof typeof I, title: string, sub?: string, action?: Node) => h('div', { class: 'empty' }, h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon(ic)), h('b', {}, title), sub ? h('span', {}, sub) : null, action ?? null);
const stopResume = (s: State) => s.stopped
  ? h('button', { class: 'btn primary', disabled: connectionBusy(s), 'aria-busy': String(connectionBusy(s)), onclick: () => changeConnection({ type: 'connect' }) }, icon('play'), 'Resume access')
  : h('button', { class: 'btn danger', disabled: !s.connected && !s.connecting, onclick: () => changeConnection({ type: 'stop' }), title: 'Detach from this profile’s tabs and disconnect this extension' }, icon('stop'), 'Stop access');
/**
 * Confirm before requesting that the companion stop its agents, then refresh the dashboard even if sending fails.
 * Return immediately; the temporary status records a fulfilled message request, not confirmed agent exits.
 */
const stopAgents = (s: State) => {
  const n = s.graph?.agents.length;
  if (!confirm(`Stop ${n === undefined ? 'every agent' : n === 1 ? 'the 1 agent' : `all ${n} agents`} connected to 127.0.0.1:${s.port}? Agent processes, including background jobs, are ended. Desktop apps are only disconnected.`)) return;
  ask({ type: 'stopAgents' }).then(() => { ui.agentsStopped = Date.now(); }, () => {}).then(() => ask({ type: 'getState' })).then(paint);
};
const sw = (attrs: Record<string, unknown>) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', role: 'switch', ...attrs }));
const settingRow = (title: string, body: (Node | string | null)[], ...ctl: (Node | null)[]) => h('div', { class: 'setting' }, h('div', { class: 'setting-copy' }, h('h3', {}, title), ...body), h('div', { class: 'ctl' }, ...ctl));

function copyBtn(text: string, label = 'Copy') {
  return h('button', { class: 'btn sm icon ghost', title: label, 'aria-label': label, onclick: async (e: Event) => { const b = e.currentTarget as HTMLElement; await navigator.clipboard.writeText(text); b.replaceChildren(icon('check')); b.classList.add('copied'); setTimeout(() => { b.replaceChildren(icon('copy')); b.classList.remove('copied'); }, 1200); } }, icon('copy'));
}
const inputValue = (id: string) => $<HTMLInputElement>(id)?.value ?? '';
const checked = (e: Event) => (e.currentTarget as HTMLInputElement).checked;
let firefoxPermissionError = '';
function firefoxAccess(s: State) {
  if (s.browserEngine !== 'firefox') return null;
  return h('div', { class: `callout ${s.automationReady ? '' : 'attention'}` }, h('span', { class: 'callout-icon', 'aria-hidden': 'true' }, icon('shield')),
    h('div', { class: 'body' }, h('b', {}, s.automationReady ? 'Firefox shared-tab automation' : 'Enable Firefox automation'),
      h('p', { class: 'muted' }, s.automationReady ? 'Only tabs you share are controlled. Firefox uses simulated input and an isolated script environment. The page overlay shows the agent at work; stop access here in the dashboard.' : 'Allow website access and user scripts, then choose tabs to share. Firefox asks for these permissions separately.'),
      h('div', { class: 'callout-actions' },
        !s.automationReady ? h('button', { id: 'enable-firefox', class: 'btn primary', onclick: async () => {
          try {
            // Firefox requires the userScripts opt-in to be requested on its own, from a user gesture.
            const granted = await api.permissions.request(s.firefoxHostAccess ? { permissions: FIREFOX_PERMISSIONS.permissions } : { origins: FIREFOX_PERMISSIONS.origins });
            firefoxPermissionError = granted ? '' : 'Permission was not granted. Shared-tab automation stays disabled.';
            paint(await ask({ type: 'getState' })); repaint();
          } catch (error) { firefoxPermissionError = (error as Error).message; repaint(); }
        } }, s.firefoxHostAccess ? 'Enable Firefox automation' : 'Allow website access') : null,
        h('a', { class: 'text-link', href: 'https://docs.browspark.krishm.dev/reference/firefox', target: '_blank', rel: 'noreferrer' }, 'Firefox capabilities and exceptions', icon('external'))),
      firefoxPermissionError ? h('p', { role: 'alert', class: 'err-text' }, firefoxPermissionError) : null));
}

let extensionError = '';
function extensionsCard(s: State) {
  const grant = async () => {
    try {
      const granted = await api.permissions.request({ permissions: ['management'] });
      extensionError = granted ? '' : 'Permission was not granted. Browspark cannot see other extensions.';
    } catch (error) { extensionError = (error as Error).message; }
    paint(await ask({ type: 'getState' })); repaint();
  };
  const failed = (e: unknown) => { extensionError = (e as Error).message || String(e); repaint(); };
  const rows = (s.extensions ?? []).filter((x) => x.type !== 'theme').sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  return h('section', { class: 'card', id: 'extensions-card' },
    cardHead('puzzle', 'Other extensions'),
    settingRow('Let agents work with other extensions', [
      h('p', {}, 'Allows the browser_extensions tool to list your extensions and their permissions, enable or disable them, ask the browser to uninstall one (you confirm in the browser), message extensions that opt in, and open their options pages. Browspark cannot read other extensions’ data and never manages itself.'),
      !s.managementGranted ? h('p', { class: 'hint' }, 'Requires the browser’s management permission, which you grant separately.') : null,
      extensionError ? h('p', { role: 'alert', class: 'err-text' }, extensionError) : null],
      s.managementGranted
        ? sw({ id: 'extensions-access', checked: s.extensionsAccess, 'aria-label': 'Let agents work with other extensions', onchange: (e: Event) => { const on = checked(e); ask({ type: 'setExtensionsAccess', on }).then((n) => { extensionError = ''; paint(n); }).catch(failed); } })
        : h('button', { id: 'grant-management', class: 'btn primary', onclick: grant }, 'Grant permission')),
    s.browserEngine === 'firefox' ? null : settingRow('Share options pages the agent opens', [
      h('p', {}, 'When the agent opens an extension’s options page, share that tab so it can be automated. Only the options tab it opened is shared, only while it stays on that extension’s own pages, and the browser may still refuse to attach. Firefox does not support this.')],
      sw({ id: 'extension-pages', checked: s.extensionPages, disabled: !s.extensionsAccess, 'aria-label': 'Share options pages the agent opens', onchange: (e: Event) => { const on = checked(e); ask({ type: 'setExtensionPages', on }).then(paint).catch(failed); } })),
    s.managementGranted ? h('div', { class: 'setting stacked' }, h('div', { class: 'setting-copy' }, h('h3', {}, `Installed extensions (${rows.length})`),
      rows.length ? h('div', { class: 'ext-list' }, ...rows.map((x) => h('div', { class: `tab ext ${x.enabled ? '' : 'off'}`, 'data-key': x.id },
        h('span', { class: 'fav', 'aria-hidden': 'true' }, icon('puzzle')),
        h('div', {}, h('div', { class: 't' }, `${x.name} `, h('span', { class: 'muted' }, `v${x.version}`)), h('div', { class: 'u' }, x.id)),
        x.self ? h('span', { class: 'pill' }, 'This extension') : h('label', { class: 'switch', title: x.mayDisable === false ? 'Managed by policy' : x.enabled ? 'Disable' : 'Enable' }, h('input', { type: 'checkbox', role: 'switch', checked: x.enabled, disabled: x.mayDisable === false, 'aria-label': `${x.enabled ? 'Disable' : 'Enable'} ${x.name}`, onchange: (e: Event) => { const enabled = checked(e); ask({ type: 'setExtensionEnabled', id: x.id, enabled }).then((n) => { extensionError = ''; paint(n); }).catch(failed); } }))))) : h('p', { class: 'hint' }, 'No other extensions installed.'))) : null);
}

function connectForm(s: State) {
  const port = h('input', { id: 'port', type: 'number', min: 1, max: 65535, 'aria-label': 'Bridge port', value: String(s.port), class: 'mono' }) as HTMLInputElement;
  const submit = () => { editing = false; return changeConnection({ type: 'setConfig', port: Number(inputValue('port')) || 9223 }); };
  port.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  return h('div', { class: 'row pair-form' },
    h('label', { class: 'field port-field' }, h('span', {}, 'Port'), port),
    h('button', { class: 'btn primary', disabled: connectionBusy(s), 'aria-busy': String(connectionBusy(s)), onclick: submit }, s.connecting ? spinner() : null, s.connecting ? 'Reconnecting…' : s.connected ? 'Reconnect' : 'Connect'),
    editing ? h('button', { class: 'btn ghost', onclick: () => { editing = false; repaint(); } }, 'Cancel') : null);
}

const PACKAGE = 'browspark-mcp@latest';
function clientSetup(port: number) {
  const args = [PACKAGE, ...(port === 9223 ? [] : ['--port', String(port)])];
  const command = `bunx ${args.join(' ')}`;
  const STDIO_CONFIG = { command: 'bunx', args };
  const LOCAL_CONFIG = JSON.stringify({ mcp: { browspark: { type: 'local', command: ['bunx', ...args], enabled: true } } }, null, 2);
  const SETUP_CLIENTS = [
    { id: 'claude', name: 'Claude', file: 'Terminal · Claude Code',
      instruction: 'Run this command in your terminal to add Browspark to Claude Code for all projects.',
      code: `claude mcp add --transport stdio --scope user browspark -- ${command}`,
      next: 'Start a new Claude Code session, then use /mcp to check the connection.',
      docs: 'https://code.claude.com/docs/en/mcp' },
    { id: 'codex', name: 'Codex', file: 'Terminal · Codex CLI',
      instruction: 'Run this command in your terminal. Codex saves the server in ~/.codex/config.toml.',
      code: `codex mcp add browspark -- ${command}`,
      next: 'Restart your Codex client, then check the server in MCP settings or with /mcp in the CLI.',
      docs: 'https://developers.openai.com/codex/mcp/' },
    { id: 'opencode', name: 'OpenCode', file: '~/.config/opencode/opencode.json',
      instruction: 'Add this entry to your global OpenCode config, keeping any existing servers.',
      code: LOCAL_CONFIG, next: 'Restart OpenCode, then run opencode mcp list to check the connection.',
      docs: 'https://opencode.ai/docs/mcp-servers/' },
    { id: 'cursor', name: 'Cursor', file: '~/.cursor/mcp.json',
      instruction: 'Add this entry to your global Cursor config, keeping any existing servers.',
      code: JSON.stringify({ mcpServers: { browspark: { type: 'stdio', ...STDIO_CONFIG } } }, null, 2),
      next: 'Restart Cursor, then check that Browspark is enabled under Customize → MCP.',
      docs: 'https://cursor.com/docs/mcp' },
    { id: 'antigravity', name: 'Antigravity', file: 'mcp_config.json',
      instruction: 'In the Agent panel, open … → MCP Servers → Manage MCP Servers → View raw config. Add this entry, keeping any existing servers.',
      code: JSON.stringify({ mcpServers: { browspark: STDIO_CONFIG } }, null, 2),
      next: 'Save the config, then check that Browspark is enabled in MCP management.',
      docs: 'https://antigravity.google/docs/mcp' },
    { id: 'muse', name: 'Muse Code', file: '~/.config/muse/settings.json',
      instruction: 'Add this entry under mcpServers in ~/.config/muse/settings.json, keeping any existing servers.',
      code: JSON.stringify({ mcpServers: { browspark: { mode: 'optional', transport: 'stdio', command: 'bunx', args } } }, null, 2),
      next: 'Restart Muse Code, then check that Browspark is listed among its MCP servers.',
      docs: 'https://dev.meta.ai/docs/muse-code/extending#mcp' },
  ];

  const selected = SETUP_CLIENTS.find((client) => client.id === ui.setupClient) ?? SETUP_CLIENTS[0]!;
  return h('div', { class: 'client-setup' },
    h('div', { class: 'setup-clients', role: 'group', 'aria-label': 'MCP client' }, ...SETUP_CLIENTS.map((client) =>
      h('button', { class: 'btn', 'data-client': client.id, 'data-key': client.id, 'aria-pressed': String(client === selected), 'aria-controls': 'setup-instructions', onclick: () => {
        ui.setupClient = client.id; try { localStorage.setItem('setupClient', client.id); } catch {} repaint();
      } }, h('picture', {},
        ['opencode', 'cursor'].includes(client.id) ? h('source', { media: ui.theme === 'system' ? '(prefers-color-scheme: dark)' : ui.theme === 'dark' ? 'all' : 'not all', srcset: `assets/clients/${client.id}-dark.svg` }) : null,
        h('img', { src: `assets/clients/${client.id}.${client.id === 'claude' || client.id === 'antigravity' ? 'png' : 'svg'}`, alt: '', width: '20', height: '20' })), client.name))),
    h('div', { id: 'setup-instructions', class: 'setup-instructions', role: 'region', 'aria-label': `${selected.name} setup` },
      h('p', { class: 'setup-lead' }, selected.instruction),
      h('div', { class: 'setup-code' },
        h('div', { class: 'setup-code-h' }, h('span', {}, icon('terminal'), selected.file), copyBtn(selected.code, `Copy ${selected.name} setup`)),
        h('pre', { tabindex: '0', 'aria-label': `${selected.name} configuration` }, h('code', {}, selected.code))),
      h('div', { class: 'setup-next' }, h('p', {}, selected.next), h('a', { href: selected.docs, target: '_blank', rel: 'noreferrer', 'aria-label': `${selected.name} setup documentation` }, 'Docs', icon('external')))),
    h('p', { class: 'setup-prerequisites' }, 'Requires Bun. The companion is fetched from npm on first run. If ', h('code', {}, 'bunx'), ' is not found, use its full executable path (', h('code', {}, '~/.bun/bin/bunx'), ').'));
}

function setupStep(n: number, status: '' | 'now' | 'done', title: string, summary: Node | null, body: Node | null, toggle: Node | null = null) {
  return h('div', { class: `step ${status}`, 'data-key': `step-${n}` },
    h('div', { class: 'num', 'aria-hidden': 'true' }, status === 'done' ? icon('check') : String(n)),
    h('div', { class: 'step-main' },
      h('div', { class: 'step-head' },
        h('span', { class: 'sr-only' }, status === 'done' ? 'Completed step:' : status === 'now' ? 'Current step:' : 'Step:'),
        h('h3', {}, title), summary ? h('div', { class: 'step-summary' }, summary) : null, toggle),
      body));
}

/** Agents or browsers on the companion right now, as overlapping logos. */
function avatars(s: State, kind: 'agent' | 'browser') {
  const graph = s.graph!;
  const brands = kind === 'agent' ? graph.agents.map((a) => graphBrand(a.name, 'agent')) : graph.browsers.map((b) => browserBrand(s, b));
  if (!brands.length) return h('span', { class: 'strip-v muted' }, kind === 'agent' ? 'None yet' : 'Only this one');
  const names = brands.map((b) => b.label);
  return h('span', { class: 'strip-who' },
    h('span', { class: 'avatars', 'aria-hidden': 'true' }, ...brands.slice(0, 4).map((b, i) => h('span', { class: 'avatar', 'data-key': `${i}:${b.src}` }, brandImage(b, 'avatar-img')))),
    h('span', { class: 'strip-v', title: names.join(', ') }, names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')));
}

function viewOverview(s: State) {
  const shared = s.tabs.filter((t) => t.shared && canShare(t));
  const available = s.tabs.filter(canShare).length;
  const paired = (s.connected || s.connecting) && !editing;
  const step = !paired ? 2 : shared.length || s.shareAll ? 4 : 3;
  const companionOk = s.connected; // only verifiable once the bridge answers
  const done = Number(companionOk) + Number(step > 2) + Number(step > 3);
  const setupOpen = ui.setupOpen ?? !companionOk;
  const toggleSetup = h('button', { class: 'btn sm ghost step-toggle', 'aria-expanded': String(setupOpen), 'aria-controls': 'setup-step-1', onclick: () => { ui.setupOpen = !setupOpen; repaint(); } },
    setupOpen ? 'Hide' : companionOk ? 'Add a client' : 'Show', icon('chevron'));
  const onboarding = h('section', { class: `card setup-card ${done === 3 ? 'complete' : ''}`, 'aria-labelledby': 'setup-title' },
    h('div', { class: 'card-h' }, h('span', { class: 'card-icon', 'aria-hidden': 'true' }, icon('plug')), h('h2', { id: 'setup-title' }, done === 3 ? 'Workspace connected' : 'Connect your workspace'),
      h('div', { class: 'right setup-progress' }, h('span', { class: 'sub' }, `${done} of 3 done`),
        h('span', { class: 'progress', role: 'progressbar', 'aria-label': 'Setup progress', 'aria-valuemin': '0', 'aria-valuemax': '3', 'aria-valuenow': String(done) }, h('span', { style: `width:${Math.round(done / 3 * 100)}%` })))),
    h('div', { class: 'steps' },
      setupStep(1, companionOk ? 'done' : step === 2 ? 'now' : '', 'Run the companion',
        h('span', {}, companionOk ? 'Registered with your MCP client and running.' : 'Register it once with your MCP client.'),
        h('div', { class: 'step-body', id: 'setup-step-1', hidden: !setupOpen },
          h('p', {}, 'Every browser profile can use the same companion at ', h('code', {}, `127.0.0.1:${s.port}`), '. Pick your client:'),
          clientSetup(s.port)),
        toggleSetup),
      setupStep(2, step > 2 ? 'done' : step === 2 ? 'now' : '', 'Connect this extension',
        paired ? h('div', { class: 'row' }, h('span', { class: `pill ${s.connecting ? '' : 'ok'}` }, s.connecting ? spinner() : icon('check'), s.connecting ? 'Connecting…' : 'Connected'), h('code', { class: 'addr' }, `127.0.0.1:${s.port}`), h('button', { class: 'btn sm ghost', onclick: () => { editing = true; repaint(); $('port')?.focus(); } }, 'Change')) : null,
        !paired ? h('div', { class: 'step-body' },
          h('p', {}, 'It connects to the companion on this machine by itself. Change the port only if you run the companion with ', h('code', {}, '--port'), '.'),
          connectForm(s),
          s.lastError && !s.connected ? h('div', { class: 'notice bad' }, icon('alert'), h('span', {}, s.lastError)) : null)
          : s.lastError && !s.connected ? h('div', { class: 'step-body' }, h('div', { class: 'notice bad' }, icon('alert'), h('span', {}, s.lastError))) : null),
      setupStep(3, step > 3 ? 'done' : step === 3 ? 'now' : '', 'Share tabs',
        h('a', { href: '#/tabs', class: `btn sm ${step === 3 ? 'primary' : ''}` }, icon('tabs'), s.shareAll ? 'Sharing everything · manage' : shared.length ? `${shared.length} shared · manage` : 'Choose tabs'),
        step === 3 ? h('div', { class: 'step-body' }, h('p', {}, 'Choose the tabs your agent can control in this browser profile. Change access at any time.')) : null)));

  const ready = !editing && (!s.stopped || !!s.lastError);
  const recent = s.recent.slice(0, 5);
  const enabledTools = s.toolCatalog.filter((t) => !s.disabledTools.includes(t.name)).length;
  const sharedPanel = h('section', { class: 'card' },
    cardHead('tabs', 'Shared tabs', h('span', { class: 'pill' }, String(shared.length))),
    shared.length ? h('div', { class: 'list' }, ...shared.slice(0, 5).map((t) => h('a', { class: 'shared-preview', href: '#/tabs', title: t.title || t.url, 'data-key': String(t.id) },
      favicon(t), h('span', { class: 'shared-meta' }, h('b', {}, t.title || host(t.url)), h('span', {}, host(t.url))), t.attached ? h('span', { class: 'pill ok' }, 'active') : null, icon('arrow'))))
      : empty('lock', 'Your tabs stay private', 'Choose a tab to give your agent access.', h('a', { class: 'btn primary sm', href: '#/tabs' }, 'Choose tabs')),
    shared.length ? h('a', { class: 'panel-footer', href: '#/tabs' }, shared.length > 5 ? `View all ${shared.length} shared tabs` : 'Manage tab access', icon('arrow')) : null);
  return h('div', { class: 'page' },
    pageHeader('Overview', 'Sharing, connection and activity for this browser profile.', ready ? h('a', { class: 'btn primary', href: '#/tabs' }, icon('tabs'), 'Manage tabs') : null, stopResume(s)),
    s.stopped && !s.lastError ? h('div', { class: 'notice warn' }, icon('alert'), h('span', {}, 'Access to this profile is stopped. Resume, then share tabs again. Other browsers and developer sessions remain available.'), h('button', { class: 'btn sm', disabled: connectionBusy(s), 'aria-busy': String(connectionBusy(s)), onclick: () => changeConnection({ type: 'connect' }) }, 'Resume')) : null,
    firefoxAccess(s), onboarding,
    ready ? h('section', { class: `card connection-panel ${s.connecting ? 'pending' : s.connected ? 'live' : 'down'}`, 'aria-busy': String(s.connecting) },
      h('div', { class: 'connection-main' },
        h('div', { class: 'connection-icon' }, s.connecting ? spinner() : icon(s.connected ? 'zap' : 'plug')),
        h('div', { class: 'connection-copy' }, h('h2', {}, s.connecting ? 'Reconnecting…' : s.connected ? 'Your browser is connected' : 'Disconnected'), h('p', {}, s.connecting ? 'Waiting for the companion to confirm the connection.' : s.connected ? shared.length ? 'Your agent can work in the tabs you’ve shared.' : 'Share a tab to start working with your agent.' : s.lastError ?? 'Start the companion, then reconnect.')),
        h('div', { class: 'connection-meta' }, s.connected ? h('span', { class: 'pill ok live-pill' }, h('span', { class: 'dot' }), 'Live session') : s.connecting ? h('span', { class: 'pill' }, 'Connecting') : h('button', { class: 'btn', disabled: connectionBusy(s), onclick: () => changeConnection({ type: 'connect' }) }, icon('refresh'), 'Reconnect'), h('a', { href: '#/settings', title: 'Connection settings' }, h('code', {}, `127.0.0.1:${s.port}`)))),
      s.connected ? h('div', { class: 'connection-strip' },
        s.graph ? h('div', { class: 'strip-item' }, h('span', { class: 'strip-k' }, 'Agents'), avatars(s, 'agent')) : null,
        s.graph ? h('div', { class: 'strip-item' }, h('span', { class: 'strip-k' }, 'Browsers'), avatars(s, 'browser')) : null,
        h('div', { class: 'strip-item' }, h('span', { class: 'strip-k' }, 'Uptime'), h('span', { class: 'strip-v', 'data-ago': String(s.connectedAt), 'data-ago-fmt': '{ago}' }, ago(s.connectedAt!))),
        s.companionVersion ? h('div', { class: 'strip-item' }, h('span', { class: 'strip-k' }, 'Companion'), h('span', { class: 'strip-v mono' }, `v${s.companionVersion}`)) : null) : null) : null,
    h('div', { class: `grid ${s.activityLog ? 'c4' : 'c2'} metric-grid` },
      stat({ k: 'Shared tabs', icon: 'tabs', v: shared.length, extra: s.shareAll ? 'all tabs + new' : `of ${available} available`, meter: s.shareAll ? 1 : available ? shared.length / available : 0 }),
      stat({ k: 'Enabled tools', icon: 'tools', v: enabledTools, extra: `of ${s.toolCatalog.length} tools`, meter: s.toolCatalog.length ? enabledTools / s.toolCatalog.length : 0 }),
      s.activityLog ? stat({ k: 'Operations', icon: 'activity', v: s.totals.ops, extra: 'this session' }) : null,
      s.activityLog ? stat({ k: 'Errors', icon: 'alert', v: s.totals.errors, extra: s.totals.ops ? `${Math.round(s.totals.errors / s.totals.ops * 1000) / 10}% of operations` : undefined, cls: s.totals.errors ? 'bad' : '' }) : null),
    h('div', { class: 'overview-grid' },
      sharedPanel,
      h('section', { class: 'card' },
        cardHead('activity', 'Recent activity', h('div', { class: 'right' }, s.activityLog ? h('a', { href: '#/activity', class: 'btn sm ghost' }, 'View all', icon('arrow')) : null)),
        !s.activityLog ? empty('eye', 'Activity log is off', 'Nothing is recorded. Turn it on in Settings to see what the agent does.', h('a', { href: '#/settings', class: 'btn sm' }, 'Open Settings'))
        : recent.length ? h('div', { class: 'list' }, ...recent.map((r) => h('div', { class: 'recent-row', 'data-key': String(r.id), title: r.error },
          h('span', { class: `st ${r.ok ? '' : 'bad'}`, role: 'img', 'aria-label': r.ok ? 'Succeeded' : 'Failed' }),
          h('div', { class: 'recent-copy' }, h('code', {}, r.method), h('span', {}, r.client ? `${r.client} · ${r.tabLabel}` : r.tabLabel)),
          h('div', { class: 'recent-time' }, h('span', {}, time(r.at)), h('small', {}, `${r.ms} ms`)))))
          : empty('inbox', 'No commands yet', s.connected ? 'Your agent’s commands will appear here.' : 'Connect the companion to start a session.'))));
}

const graphCompact = matchMedia('(max-width: 680px)');
const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
graphCompact.addEventListener('change', () => { if (route === 'graph') repaint(); });

function viewGraph(s: State) {
  const note = h('div', { class: 'graph-note', role: 'note' }, icon('shield'),
    h('span', {}, 'Wrong name or logo? This browser may hide its identity — set the ', h('a', { href: '#/settings' }, 'Browser label'), '.'));
  const header = pageHeader('Graph', 'See the agents and browsers connected through your local companion.', note);
  if (!s.graphEnabled) return h('div', { class: 'page' }, header,
    h('div', { class: 'card' }, empty('graph', 'Connection graph is off', 'Enable Connection graph in Settings to show this page in the sidebar.', h('a', { class: 'btn primary', href: '#/settings' }, 'Open Settings'))));
  if (!s.connected) return h('div', { class: 'page' }, header,
    h('div', { class: 'card', id: 'graph-status', role: 'status' }, empty('plug', 'Connect to see your browsers', s.stopped ? 'Access to this profile is paused. Resume to see live connections.' : 'Connect this profile to the companion to see its agents and browsers.',
      h('button', { class: 'btn primary', disabled: connectionBusy(s), onclick: () => changeConnection({ type: 'connect' }) }, s.connecting ? spinner() : icon('plug'), s.connecting ? 'Reconnecting…' : s.stopped ? 'Resume access' : 'Connect'))));
  if (!s.graph) return h('div', { class: 'page' }, header,
    h('div', { class: 'card', id: 'graph-status', role: 'status' }, empty('graph', 'Waiting for connection data', 'Connections will appear here shortly. Restart the companion if this view stays empty.')));

  const { agents, browsers, thisBrowserId } = s.graph;
  const compact = graphCompact.matches, width = compact ? 380 : 1000;
  const middle = compact ? 148 + Math.max(1, agents.length) * 108 : Math.max(520, Math.max(agents.length, browsers.length) * 124 + 140) / 2;
  const height = compact ? middle + 148 + Math.max(1, browsers.length) * 108 : middle * 2;
  const agentX = compact ? 190 : 170, browserX = compact ? 190 : 830;
  const row = (i: number, n: number, agent: boolean) => compact ? (agent ? 92 : middle + 164) + i * 108 : middle + (i - (n - 1) / 2) * 124;
  const layout = compact ? 'mobile' : 'desktop';
  const scope = `${s.port}:${thisBrowserId}`;
  const key = (kind: string, id = '') => `${scope}:${layout}:${kind}:${id}`;
  const hubKey = key('companion'), hub = graphPosition(hubKey, { x: width / 2, y: middle });
  const agentPoints = agents.map((agent, i) => graphPosition(key('agent', agent.id), { x: agentX, y: row(i, agents.length, true) }));
  const browserPoints = browsers.map((browser, i) => graphPosition(key('browser', browser.id), { x: browserX, y: row(i, browsers.length, false) }));
  const nodeAttrs = (id: string, point: { x: number; y: number }, halfWidth: number) => ({ 'data-graph-node': id, 'data-x': point.x, 'data-y': point.y, 'data-half-width': halfWidth, style: `transform:translate3d(${point.x}px,${point.y}px,0) translate(-50%,-50%)` });
  const svg = (tag: string, attrs: Record<string, string>, ...children: Node[]) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    el.append(...children); return el;
  };
  const edges = (fromAgents: boolean) => (fromAgents ? agents : browsers).map((node, i) => {
    const from = fromAgents ? agentPoints[i] : hub, to = fromAgents ? hub : browserPoints[i];
    const fromSide = compact && fromAgents ? 'left' : 'right', toSide = compact && !fromAgents ? 'right' : 'left';
    const id = key(fromAgents ? 'agent' : 'browser', node.id);
    const d = graphCurve(from, to, fromAgents ? 110 : 80, fromAgents ? 80 : 110, fromSide, toSide);
    return svg('g', { class: `graph-edge ${fromAgents ? 'agent-edge' : 'browser-edge'}`, 'data-key': id, 'data-from': fromAgents ? id : hubKey, 'data-to': fromAgents ? hubKey : id, 'data-from-side': fromSide, 'data-to-side': toSide },
      svg('path', { d }), svg('path', { class: 'graph-edge-flow', style: `animation-delay:-${i * .6}s`, d }));
  });
  const logo = (brand: ReturnType<typeof graphBrand>) => h('span', { class: 'graph-node-icon', 'aria-hidden': 'true' }, brandImage(brand, 'graph-brand-logo'));
  return h('div', { class: 'page graph-page' }, header,
    h('section', { class: 'card connection-graph', id: 'connection-graph', 'aria-label': 'Live connection graph', 'aria-describedby': 'graph-description' },
      h('div', { class: 'graph-toolbar' },
        h('span', { class: 'graph-live', id: 'graph-status', role: 'status' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), 'Live connections'),
        h('span', { class: 'graph-legend', 'aria-hidden': 'true' }, h('span', { class: 'lg agent' }, 'Agents'), h('span', { class: 'lg browser' }, 'Browsers')),
        h('span', { class: 'graph-summary' }, plural(agents.length, 'agent'), h('span', { 'aria-hidden': 'true' }, ' / '), plural(browsers.length, 'browser'))),
      h('div', { class: 'graph-canvas', id: 'graph-canvas', 'data-layout': layout, 'data-graph-scope': scope, 'data-zoom': $('graph-canvas')?.dataset.zoom, 'data-pan-x': $('graph-canvas')?.dataset.panX, 'data-pan-y': $('graph-canvas')?.dataset.panY, 'data-dragging': $('graph-canvas')?.dataset.dragging, style: $('graph-canvas')?.getAttribute('style'), tabindex: '0', role: 'region', 'aria-label': 'Connection canvas. Drag a node to move it, or drag empty space to pan. Scroll to pan, Control or Command scroll to zoom.' },
        h('div', { class: 'graph-grid', 'aria-hidden': 'true', style: document.querySelector<HTMLElement>('.graph-grid')?.getAttribute('style') }),
        h('div', { class: `graph-world${compact ? ' vertical' : ''}`, id: 'graph-world', 'data-width': width, 'data-height': height, style: `width:${width}px;height:${height}px;transform:${$('graph-world')?.style.transform ?? ''}` },
          h('div', { class: 'graph-edges', 'aria-hidden': 'true' }, svg('svg', { class: 'graph-connections', width: String(width), height: String(height) }, ...edges(true), ...edges(false))),
          h('ul', { class: 'graph-nodes', 'aria-label': 'Connected agents' }, ...agents.map((agent, i) => {
            const brand = graphBrand(agent.name, 'agent');
            return h('li', { class: 'graph-node graph-agent', 'data-key': agent.id, 'data-agent-id': agent.id, tabindex: '0', ...nodeAttrs(key('agent', agent.id), agentPoints[i], 110), title: `${agent.name} · ${agent.id}`, 'aria-label': `${brand.label}, agent ${agent.id}. Drag to move or use arrow keys.` },
              logo(brand), h('div', { class: 'graph-node-copy' }, h('h3', {}, brand.label), h('p', {}, 'MCP agent')), h('span', { class: 'graph-port', 'aria-hidden': 'true' })); }),
            agents.length ? null : h('li', { class: 'graph-placeholder', tabindex: '0', ...nodeAttrs(key('placeholder'), graphPosition(key('placeholder'), { x: agentX, y: row(0, 1, true) }), 110) }, icon('tools'), h('b', {}, 'No agents connected'), h('span', {}, 'Connect an MCP client'))),
          h('div', { class: 'graph-hub', tabindex: '0', ...nodeAttrs(hubKey, hub, 80), 'aria-label': 'Browspark companion. Drag to move or use arrow keys.' },
            h('span', { class: 'graph-hub-logo' }, h('img', { src: 'assets/logo.png', alt: '', draggable: 'false' })),
            h('h3', {}, 'Browspark'), h('p', {}, h('span', { class: 'dot' }), 'Local companion'), h('span', { class: 'graph-hub-address' }, `127.0.0.1:${s.port}`)),
          h('ul', { class: 'graph-nodes', 'aria-label': 'Connected browsers' }, ...browsers.map((browser, i) => {
            const brand = browserBrand(s, browser);
            return h('li', { class: `graph-node graph-browser${browser.id === thisBrowserId ? ' current' : ''}`, 'data-key': browser.id, 'data-browser-id': browser.id, 'data-current-browser': String(browser.id === thisBrowserId), tabindex: '0', ...nodeAttrs(key('browser', browser.id), browserPoints[i], 110), title: `${browser.name} · ${browser.context ?? browser.id}`, 'aria-label': `${brand.label}, ${browser.context ?? browser.id}${browser.id === thisBrowserId ? ', this browser' : ''}. Drag to move or use arrow keys.` },
              h('span', { class: 'graph-port', 'aria-hidden': 'true' }), logo(brand),
              h('div', { class: 'graph-node-copy' }, h('h3', {}, brand.label), h('p', {}, browser.mode === 'dev' ? `${browser.context ?? 'Developer'} · ` : 'Profile · ', plural(browser.sharedTabs, 'tab'), browser.mode === 'dev' ? '' : ' shared')),
              browser.id === thisBrowserId ? h('span', { class: 'graph-current' }, h('span', { class: 'dot' }), 'This browser') : null); })))),
      h('div', { class: 'graph-controls' },
        h('span', { class: 'graph-pan-hint' }, icon('graph'), 'Drag nodes or canvas', h('span', { class: 'hint-zoom' }, ' · ', h('kbd', { class: 'kbd' }, MOD_KEY), ' + scroll to zoom')),
        h('div', { class: 'graph-zoom', role: 'group', 'aria-label': 'Canvas zoom' },
          h('button', { id: 'graph-zoom-out', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoomGraph(1 / 1.2) }, '−'),
          h('output', { id: 'graph-zoom-label', 'aria-label': 'Zoom level', 'aria-live': 'polite' }, '100%'),
          h('button', { id: 'graph-zoom-in', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoomGraph(1.2) }, '+'),
          h('button', { id: 'graph-fit', title: 'Fit all connections', 'aria-label': 'Fit all connections', onclick: () => zoomGraph() }, 'Fit'),
          h('button', { id: 'graph-reset', title: 'Reset node positions', 'aria-label': 'Reset node positions', onclick: () => resetGraphLayout() }, 'Reset')))),
    h('p', { class: 'graph-caption', id: 'graph-description' }, icon('shield'), 'Live connections. Each browser controls its shared tabs.'));
}

function viewTabs(s: State) {
  const q = ui.search.trim().toLowerCase();
  const all = s.tabs.filter((t) => !isOwn(t));
  const list = all.filter((t) => (ui.tabFilter === 'all' || (ui.tabFilter === 'shared' ? t.shared && canShare(t) : canShare(t))) && (!q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)));
  const shareable = list.filter(canShare);
  const windows = s.windows.map((w, i) => ({ ...w, label: `Window ${i + 1}${w.incognito ? ' · incognito' : ''}` }));
  const groups = windows.map((w) => ({ w, tabs: list.filter((t) => t.windowId === w.id) })).filter((g) => g.tabs.length);
  const search = h('input', { id: 'search', type: 'search', placeholder: 'Search tabs by title or URL…', 'aria-label': 'Search tabs', value: ui.search, oninput: (e: Event) => { ui.search = (e.target as HTMLInputElement).value; repaint(); } });
  const seg = (v: typeof ui.tabFilter, label: string, n?: number) => h('button', { class: ui.tabFilter === v ? 'on' : '', 'aria-pressed': String(ui.tabFilter === v), onclick: () => { ui.tabFilter = v; repaint(); } }, label, n === undefined ? null : ' ', n === undefined ? null : h('span', { class: 'seg-n' }, String(n)));
  const setMany = (ids: number[], shared: boolean) => ids.length && ask({ type: 'setShared', tabIds: ids, shared }).then(paint);

  const row = (t: TabInfo) => {
    const eligible = canShare(t);
    const cb = h('input', { type: 'checkbox', role: 'switch', checked: t.shared && eligible, 'aria-label': `Share ${t.title || t.url}`, disabled: !eligible, title: !eligible ? `The browser does not allow automation on ${t.unsupported}s` : t.shared ? 'Stop sharing' : isNewTab(t.url) ? 'Share this New Tab so the agent can navigate it to a website' : 'Share with agent', onchange: (e: Event) => ask({ type: 'setShared', tabIds: [t.id], shared: checked(e) }).then(paint) }) as HTMLInputElement;
    return h('div', { class: `tab ${!eligible ? 'off' : t.shared ? 'shared' : ''}`, 'data-key': String(t.id) },
      favicon(t),
      h('div', {}, h('div', { class: 't' }, h('button', { onclick: () => ask({ type: 'focusTab', tabId: t.id }), title: 'Switch to this tab' }, t.title || host(t.url) || 'Loading…')), h('div', { class: 'u' }, t.url || '')),
      h('div', { class: 'badges' },
        t.agent ? h('span', { class: 'pill agent' }, 'agent') : null,
        t.shared && eligible ? h('span', { class: 'pill ok' }, 'Shared') : null,
        t.attached ? h('span', { class: 'pill ok', title: s.browserEngine === 'firefox' ? 'The agent is using this shared tab through Firefox extension APIs.' : 'The debugger is attached. It detaches after 30s of inactivity unless an inspection session is running.' }, s.browserEngine === 'firefox' ? 'active' : 'debugging') : null,
        isNewTab(t.url) ? h('span', { class: 'pill', title: 'Share this tab to let the agent navigate it to a website. The browser’s New Tab content cannot be inspected directly.' }, 'New tab') : t.unsupported ? h('span', { class: 'pill' }, t.unsupported) : null),
      h('label', { class: 'switch' }, cb));
  };

  const allCb = h('input', { type: 'checkbox', role: 'switch', checked: s.shareAll, 'aria-label': 'Share everything', onchange: (e: Event) => ask({ type: 'setShareAll', on: checked(e) }).then(paint) }) as HTMLInputElement;
  const sharedCount = all.filter((t) => t.shared && canShare(t)).length;
  return h('div', { class: 'page' },
    pageHeader('Tabs', 'Choose tabs across all windows in this browser profile. Tabs opened by the agent here are shared automatically.',
      h('button', { class: 'btn', disabled: !shareable.some((t) => !t.shared), onclick: () => setMany(shareable.filter((t) => !t.shared).map((t) => t.id), true) }, icon('check'), `Share ${q || ui.tabFilter !== 'all' ? 'matching' : 'listed'}`),
      h('button', { class: 'btn', disabled: !list.some((t) => t.shared), onclick: () => setMany(list.filter((t) => t.shared).map((t) => t.id), false) }, 'Unshare'),
      stopResume(s)),
    firefoxAccess(s),
    h('div', { class: `callout ${s.shareAll ? 'sharing-all' : ''}` },
      h('span', { class: 'callout-icon', 'aria-hidden': 'true' }, icon(s.shareAll ? 'globe' : 'shield')),
      h('div', { class: 'body' }, h('b', {}, 'Share everything'), h('div', { class: 'muted' }, s.shareAll ? 'Supported tabs in this profile are shared across every window, including new tabs. Stopped or unshared tabs stay private until you share them again.' : 'Allow access to supported tabs in this profile across every window, including new tabs. Explicitly stopped or unshared tabs stay private.')),
      h('label', { class: 'switch ctl' }, allCb)),
    h('section', { class: 'card' },
      h('div', { class: 'toolbar' },
        h('label', { class: 'field search-field' }, icon('search'), search, h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, '/')),
        h('div', { class: 'seg' }, seg('all', 'All', all.length), seg('available', 'Available'), seg('shared', 'Shared', sharedCount)),
        h('div', { class: 'right' }, h('span', { class: 'shown' }, `${list.length} shown`))),
      groups.length ? h('div', { class: 'list' }, ...groups.flatMap((g) => [h('div', { class: 'group', 'data-key': `w${g.w.id}` }, icon(g.w.incognito ? 'eye' : 'layers'), g.w.label, h('span', { class: 'group-n' }, String(g.tabs.length)), h('span', { class: 'group-meta' }, `${g.tabs.filter((t) => t.shared && canShare(t)).length} shared`)), ...g.tabs.map(row)]))
        : empty('search', 'No tabs match', q ? `Nothing for “${ui.search}”.` : 'Open a page in this browser profile and it will appear here.')));
}

const TOOL_GROUPS: [RegExp, string][] = [
  [/^browser_/, 'Browser automation'], [/^devtools_(session|events|capabilities|cdp)$/, 'Sessions & protocol'], [/^devtools_(console|evaluate)$/, 'Console'], [/^devtools_network$/, 'Network'],
  [/^devtools_(sources|debugger)$/, 'Sources & debugger'], [/^devtools_elements$/, 'Elements'], [/^devtools_(performance|profile|memory|coverage)$/, 'Performance & memory'],
  [/^devtools_(storage|workers)$/, 'Application'], [/^devtools_(emulation|accessibility|security)$/, 'Emulation & audits'], [/^devtools_lighthouse$/, 'Lighthouse'], [/^devtools_recorder$/, 'Recorder'],
];
const groupOf = (name: string) => TOOL_GROUPS.find(([re]) => re.test(name))?.[1] ?? 'Other';

function viewTools(s: State) {
  const off = new Set(s.disabledTools);
  const q = ui.toolSearch.trim().toLowerCase();
  const all = s.toolCatalog;
  const list = all.filter((t) => (ui.toolFilter === 'all' || (ui.toolFilter === 'on' ? !off.has(t.name) : off.has(t.name))) && (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)));
  const groups = [...new Set(list.map((t) => groupOf(t.name)))].map((g) => ({ g, tools: list.filter((t) => groupOf(t.name) === g) }));
  const setMany = (names: string[], enabled: boolean) => names.length && ask({ type: 'setToolsEnabled', names, enabled }).then(paint);
  const seg = (v: typeof ui.toolFilter, label: string, n: number) => h('button', { class: ui.toolFilter === v ? 'on' : '', 'aria-pressed': String(ui.toolFilter === v), onclick: () => { ui.toolFilter = v; repaint(); } }, label, ' ', h('span', { class: 'seg-n' }, String(n)));
  const row = (t: { name: string; description: string }) => {
    const open = ui.expanded.has(t.name);
    return h('div', { class: `tab tool ${off.has(t.name) ? 'off' : ''}`, 'data-key': t.name },
      h('span', { class: 'fav', title: groupOf(t.name), 'aria-hidden': 'true' }, icon(t.name.startsWith('browser_') ? 'tabs' : 'tools')),
      h('div', {}, h('div', { class: 't' }, h('code', {}, t.name)), h('button', { type: 'button', class: `desc ${open ? 'open' : ''}`, 'aria-expanded': String(open), onclick: () => { open ? ui.expanded.delete(t.name) : ui.expanded.add(t.name); repaint(); }, title: open ? 'Collapse description' : 'Expand description' }, t.description)),
      h('div', { class: 'badges' }, off.has(t.name) ? h('span', { class: 'pill' }, 'Disabled') : null),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', role: 'switch', checked: !off.has(t.name), 'aria-label': `Enable ${t.name}`, onchange: (e: Event) => ask({ type: 'setToolEnabled', name: t.name, enabled: checked(e) }).then(paint) })));
  };
  const groupHead = (g: string, tools: { name: string }[]) => {
    const on = tools.filter((t) => !off.has(t.name)).length;
    return h('div', { class: 'group', 'data-key': `g:${g}` }, g, h('span', { class: 'group-n' }, `${on}/${tools.length}`),
      h('button', { class: 'btn sm ghost group-action', onclick: () => setMany(tools.map((t) => t.name), on < tools.length), 'aria-label': `${on < tools.length ? 'Enable' : 'Disable'} all ${g} tools` }, on < tools.length ? 'Enable all' : 'Disable all'));
  };
  return h('div', { class: 'page' },
    pageHeader('Tools', 'Switch tools on or off for this browser profile. Turn a disabled tool back on here to allow it.',
      h('button', { class: 'btn', disabled: !list.some((t) => off.has(t.name)), onclick: () => setMany(list.filter((t) => off.has(t.name)).map((t) => t.name), true) }, `Enable ${q || ui.toolFilter !== 'all' ? 'matching' : 'all'}`),
      h('button', { class: 'btn', disabled: !list.some((t) => !off.has(t.name)), onclick: () => setMany(list.filter((t) => !off.has(t.name)).map((t) => t.name), false) }, `Disable ${q || ui.toolFilter !== 'all' ? 'matching' : 'all'}`)),
    h('div', { class: 'notice info' }, icon('shield'), h('span', {}, 'Calls targeting this profile use these switches. Calls across browsers and in developer sessions use the combined restrictions from connected profiles. ', h('a', { href: 'https://docs.browspark.krishm.dev/concepts/tool-policy', target: '_blank', rel: 'noreferrer' }, 'Tool policy'))),
    h('section', { class: 'card' },
      h('div', { class: 'toolbar' },
        h('label', { class: 'field search-field' }, icon('search'), h('input', { id: 'toolsearch', type: 'search', placeholder: 'Search tools…', 'aria-label': 'Search tools', value: ui.toolSearch, oninput: (e: Event) => { ui.toolSearch = (e.target as HTMLInputElement).value; repaint(); } }), h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, '/')),
        h('div', { class: 'seg' }, seg('all', 'All', all.length), seg('on', 'Enabled', all.length - off.size), seg('off', 'Disabled', off.size)),
        h('div', { class: 'right' }, h('span', { class: 'shown' }, `${list.length} shown`))),
      !all.length ? empty('inbox', 'No tool list yet', !s.connected ? 'Connect the companion to load the list of tools.' : 'The connected companion is an older build that does not send its tool list. Restart the MCP server in your agent client (new session, or reconnect the MCP) so the companion restarts on the current code.')
        : groups.length ? h('div', { class: 'list' }, ...groups.flatMap(({ g, tools }) => [groupHead(g, tools), ...tools.map(row)]))
        : empty('search', 'No tools match', `Nothing for “${ui.toolSearch}”.`)));
}

function viewActivity(s: State) {
  if (!s.activityLog) return h('div', { class: 'page' }, pageHeader('Activity', 'The last 200 commands for this profile, recorded while activity logging is enabled.'),
    h('div', { class: 'card' }, empty('eye', 'Activity log is off', 'Nothing is being recorded. Enable it in Settings to see commands, latency, and errors here.', h('button', { class: 'btn primary sm', onclick: () => ask({ type: 'setActivityLog', on: true }).then(paint) }, 'Enable activity log'))));
  const errors = s.recent.filter((r) => !r.ok);
  const list = ui.logFilter === 'errors' ? errors : s.recent;
  const slowest = Math.max(1, ...list.map((r) => r.ms));
  const seg = (v: typeof ui.logFilter, label: string) => h('button', { class: ui.logFilter === v ? 'on' : '', 'aria-pressed': String(ui.logFilter === v), onclick: () => { ui.logFilter = v; repaint(); } }, label);
  return h('div', { class: 'page' },
    pageHeader('Activity', 'The last 200 commands for this profile, recorded while activity logging is enabled.',
      h('button', { class: 'btn ghost', disabled: !s.recent.length, onclick: () => ask({ type: 'clearLog' }).then(paint) }, icon('trash'), 'Clear')),
    h('div', { class: 'grid c4 metric-row' },
      stat({ k: 'Operations', icon: 'activity', v: s.recent.length }), stat({ k: 'Errors', icon: 'alert', v: errors.length, cls: errors.length ? 'bad' : '' }),
      stat({ k: 'Shown', icon: 'eye', v: list.length, extra: 'of last 200' }), stat({ k: 'Avg latency', icon: 'clock', v: s.recent.length ? Math.round(s.recent.reduce((a, r) => a + r.ms, 0) / s.recent.length) : 0, extra: 'ms' })),
    h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, h('div', { class: 'seg' }, seg('all', 'All'), seg('errors', `Errors · ${errors.length}`))),
      list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { style: 'width:1%' }, 'Time'), h('th', {}, 'Agent'), h('th', {}, 'Command'), h('th', {}, 'Tab'), h('th', { class: 'r', style: 'width:1%' }, 'Latency'), h('th', {}, 'Result'))),
        h('tbody', {}, ...list.map((r) => h('tr', { 'data-key': String(r.id) },
          h('td', { class: 'mono muted' }, time(r.at)),
          h('td', { class: 'muted' }, r.client ? h('span', { class: 'pill' }, r.client) : '—'),
          h('td', { class: 'mono' }, h('span', { class: `st ${r.ok ? '' : 'bad'}` }), r.method),
          h('td', { class: 'muted trunc', style: 'width:22%' }, r.tabLabel),
          h('td', { class: 'mono muted r' }, h('span', { class: `lat ${r.ms >= 1000 ? 'slow' : ''}` }, `${r.ms} ms`, h('span', { class: 'lat-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.max(4, Math.round(r.ms / slowest * 100))}%` })))),
          h('td', { class: `trunc ${r.ok ? 'muted' : 'err-text'}`, title: r.error ?? '' }, r.ok ? h('span', { class: 'pill ok' }, 'ok') : r.error ?? 'failed'))))))
        : empty('activity', ui.logFilter === 'errors' ? 'No errors' : 'No activity yet', ui.logFilter === 'errors' ? 'No errors in the recorded commands.' : 'Commands appear here as the agent works.')));
}

const SETTINGS_SECTIONS: [string, string][] = [['set-companion', 'Companion'], ['set-updates', 'Updates'], ['set-dashboard', 'Dashboard'], ['set-clients', 'Other clients'], ['set-developer', 'Developer browser'], ['extensions-card', 'Other extensions'], ['set-behavior', 'Browser behavior'], ['set-privacy', 'Privacy'], ['set-stop', 'Emergency stop']];
/** Build the settings page and its action handlers, including profile access controls and the companion-wide agent stop. */
function viewSettings(s: State) {
  const port = h('input', { id: 'port', type: 'number', min: 1, max: 65535, 'aria-label': 'Bridge port', value: String(s.port), class: 'mono' }) as HTMLInputElement;
  const save = () => changeConnection({ type: 'setConfig', port: Number(inputValue('port')) || 9223 });
  return h('div', { class: 'page settings-page' },
    pageHeader('Settings', 'Connection, privacy and agent access for this browser profile.'),
    h('div', { class: 'settings-layout' },
      h('nav', { class: 'settings-index', 'aria-label': 'Settings sections' }, ...SETTINGS_SECTIONS.map(([id, label]) => h('button', { type: 'button', 'data-key': id, onclick: () => $(id)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }) }, label))),
      h('div', { class: 'settings-body' },
        firefoxAccess(s),
        h('section', { class: 'card', id: 'set-companion' },
          cardHead('plug', 'Companion'),
          settingRow('Bridge port', [h('p', {}, 'Use the same port in each browser profile to connect to one companion. Change it if you run the companion with ', h('code', {}, '--port'), '.')], h('label', { class: 'field narrow' }, port)),
          settingRow('Browser label', [h('p', {}, 'Shown in the Graph with its logo. Auto detects this browser; pick a name when it is misidentified (for example Helium or Dia reporting as Chrome).')], h('label', { class: 'field select' }, h('select', { id: 'browser-label', 'aria-label': 'Browser label', disabled: connectionBusy(s), onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v !== s.customBrowser) ask({ type: 'setCustomBrowser', name: v }).then(paint); } },
            h('option', { value: '' }, 'Auto'),
            ...labelOptions(s.browserEngine ?? 'chromium').map((n) => h('option', { value: n, selected: s.customBrowser === n }, n))), icon('chevron'))),
          settingRow('Connection', [h('p', s.connected ? { 'data-ago': String(s.connectedAt), 'data-ago-fmt': 'Connected for {ago}.' } : {}, s.connecting ? 'Reconnecting… Waiting for the companion.' : s.connected ? `Connected for ${ago(s.connectedAt!)}.` : `Disconnected.${s.lastError ? ' ' + s.lastError : ''}`)],
            h('button', { id: 'reconnect', class: 'btn', 'aria-label': 'Reconnect', disabled: connectionBusy(s), 'aria-busy': String(connectionBusy(s)), onclick: () => changeConnection({ type: 'connect' }) }, s.connecting ? spinner() : icon('refresh'), s.connecting ? 'Reconnecting…' : 'Reconnect'), h('button', { class: 'btn primary', disabled: connectionBusy(s), 'aria-busy': String(connectionBusy(s)), onclick: save }, 'Save'))),
        updatesCard(s),
        h('section', { class: 'card', id: 'set-dashboard' },
          cardHead('graph', 'Dashboard'),
          settingRow('Connection graph', [h('p', {}, 'Show Graph in the sidebar to see connected agents, browser profiles and developer sessions. This preference only changes this dashboard.')],
            sw({ id: 'graph-enabled', checked: s.graphEnabled, 'aria-label': 'Connection graph', onchange: (e: Event) => ask({ type: 'setGraphEnabled', on: checked(e) }).then(paint) }))),
        h('section', { class: 'card', id: 'set-clients' },
          cardHead('link', 'Other clients'),
          h('div', { class: 'setting stacked' }, h('div', { class: 'setting-copy' }, h('h3', {}, 'HTTP endpoint'), h('p', {}, 'Local MCP clients that take a URL can connect here while the companion runs. The endpoint is available only on this machine; web pages are refused.'),
            h('div', { class: 'cmd' }, h('code', {}, `http://127.0.0.1:${s.port}/mcp`), copyBtn(`http://127.0.0.1:${s.port}/mcp`))))),
        h('section', { class: 'card', id: 'set-developer' },
          cardHead('terminal', 'Developer browser'),
          h('div', { class: 'setting stacked' }, h('div', { class: 'setting-copy' }, h('h3', {}, 'When the agent may launch a browser'), h('p', {}, 'Separate Chrome, Brave, Firefox and Zen sessions have their own saved profiles. Only when needed allows a launch when a tool requires it or you explicitly request it.'), h('p', {}, 'With multiple connected profiles, Never takes priority, followed by Only when needed, then Always. Firefox and Zen have ', h('a', { href: 'https://docs.browspark.krishm.dev/reference/firefox', target: '_blank', rel: 'noreferrer' }, 'documented tool exceptions'), '.')),
            h('div', { class: 'ctl' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Developer browser mode' }, ...([['auto', 'Only when needed'], ['always', 'Always'], ['never', 'Never']] as const).map(([v, label]) =>
              h('button', { class: s.devMode === v ? 'on' : '', 'aria-pressed': String(s.devMode === v), onclick: () => ask({ type: 'setDevMode', mode: v }).then(paint) }, label)))))),
        extensionsCard(s),
        h('section', { class: 'card', id: 'set-behavior' },
          cardHead('sliders', 'Browser behavior'),
          settingRow('Work in background', [h('p', {}, 'On by default for this profile. Commands target the assigned tab without switching your active tab or focusing its window. If an operation needs foreground interaction, select the agent tab yourself or temporarily turn this off.')],
            sw({ checked: s.backgroundMode, 'aria-label': 'Work in background', onchange: (e: Event) => ask({ type: 'setBackgroundMode', on: checked(e) }).then(paint) })),
          settingRow('Show the agent at work', [h('p', {}, s.browserEngine === 'firefox' ? 'Show a cyan halo, moving cursor and status pill on this profile’s tabs. The in-page Stop button is unavailable in Firefox; stop access or unshare a tab in this dashboard.' : 'Show a cyan halo, moving cursor and Stop button on this profile’s tabs. Stop revokes only that tab. Developer sessions show the overlay only if every connected profile enables it.')],
            sw({ checked: s.overlay, 'aria-label': 'Agent overlay', onchange: (e: Event) => ask({ type: 'setOverlay', on: (e.target as HTMLInputElement).checked }).then(paint) }))),
        h('section', { class: 'card', id: 'set-privacy' },
          cardHead('lock', 'Privacy'),
          settingRow('Activity log', [h('p', {}, s.activityLog ? 'Keeps the last 200 commands in memory for this session.' : 'Off. No command history is kept. Operations and Errors are hidden on Overview.')],
            sw({ checked: s.activityLog, 'aria-label': 'Activity log', onchange: (e: Event) => ask({ type: 'setActivityLog', on: checked(e) }).then(paint) }))),
        h('section', { class: 'card danger-card', id: 'set-stop' },
          cardHead('power', 'Emergency stop'),
          settingRow('Stop all agents', [h('p', {}, `Ends every agent process connected to the companion on port ${s.port}, including ones running background jobs (for example an OpenCode server or Hermes). Desktop apps such as Claude or Cursor are disconnected rather than closed. Browsers stay connected.`),
            Date.now() - ui.agentsStopped < 10_000 ? h('p', { class: 'hint', role: 'status' }, 'Stop sent. Agents leave the Graph as they exit.') : null],
            h('button', { id: 'stop-agents', class: 'btn danger', disabled: !s.connected, title: s.connected ? 'End all agent processes using the companion' : 'Connect to the companion first', onclick: () => stopAgents(s) }, icon('stop'), 'Stop all agents')),
          settingRow(s.stopped ? 'This profile’s access is stopped' : 'Stop access to this profile', [h('p', {}, 'Detaches this profile’s tabs, clears sharing, turns off Share everything and disconnects this extension. Other browser profiles and developer sessions remain available. Resume reconnects; share tabs again to restore access.')], stopResume(s))),
        h('p', { class: 'page-foot' }, `Browspark extension v${s.extensionVersion}${s.companionVersion ? ` · companion v${s.companionVersion}` : ''} · Browsers restrict automation on internal pages and extension stores.`))));
}

// ---------- updates ----------
const engineName = (s: State) => s.browserEngine === 'firefox' ? 'Firefox' : 'Chromium';
/** A release waits for the user: checks are on and this release was not postponed. */
const updatePrompt = (s: State) => !!s.update.status?.available && !!s.update.status.latest && s.updateCheck && s.update.dismissed !== s.update.status.latest;
const updateDialogOpen = (s: State) => !!s.update.status?.latest && (ui.updateOpen || !!s.update.install || updatePrompt(s));
/** Release notes as plain text: no markup from the network reaches the page. */
const plainNotes = (md: string) => md.replace(/\r/g, '').replace(/^#{1,6}\s*/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\((?:https?:[^)]+)\)/g, '$1')
  .replace(/^\s*[*-]\s+/gm, '• ').replace(/ by @[\w-]+ in https:\/\/\S+/g, '').replace(/\n{3,}/g, '\n\n').trim();
const STAGES = { download: 'Downloading', verify: 'Checking the download', install: 'Installing', reload: 'Reloading the extension' } as const;
const startUpdate = (s: State) => {
  const st = s.update.status;
  const path = st?.target ? undefined : (ui.updatePath || st?.candidates?.[0]?.path || '').trim();
  return ask({ type: 'installUpdate', ...(path && { path }) }).then(paint);
};
const laterUpdate = (s: State) => { ui.updateOpen = false; if (updatePrompt(s)) ask({ type: 'dismissUpdate' }).then(paint); else repaint(); };

function updateDialog(s: State) {
  const u = s.update, st = u.status!, latest = u.install?.version ?? st.latest!;
  const installing = !!u.install;
  const order = ['download', 'verify', 'install', 'reload'] as const;
  const stage = u.install?.stage;
  const pct = !stage ? 0 : stage === 'download' ? (u.install!.total ? Math.round((u.install!.received ?? 0) / u.install!.total * 55) : 10) : [0, 70, 85, 100][order.indexOf(stage)]!;
  const chosen = ui.updatePath || st.candidates?.[0]?.path || '';
  const ready = st.installable || (!!st.candidates?.length && !!chosen) || (st.reason === 'not-found' && !!ui.updatePath.trim());
  const where = installing ? null
    : st.target ? h('p', { class: 'update-where' }, icon('folder'), h('span', {}, 'Installs into ', h('code', {}, st.target.display), ' and reloads the extension. Tabs you shared stay shared.'))
    : st.candidates?.length ? h('fieldset', { class: 'update-choices' }, h('legend', {}, `Several ${engineName(s)} builds were found. Choose the one this browser loaded:`),
      ...st.candidates.map((c) => h('label', { class: 'choice', 'data-key': c.path }, h('input', { type: 'radio', name: 'update-target', value: c.path, checked: chosen === c.path, onchange: () => { ui.updatePath = c.path; repaint(); } }), h('code', {}, c.display))))
    : st.reason === 'no-asset' ? h('div', { class: 'notice warn' }, icon('alert'), h('span', {}, `Release ${latest} has no ${engineName(s)} archive. Download it from the release page.`))
    : h('div', { class: 'update-locate' },
      h('p', {}, 'Browspark could not find the folder this browser loaded it from. ', s.browserEngine === 'firefox' ? 'Open about:debugging → This Firefox → Browspark and copy its Location.' : 'Open your browser’s extensions page, find Browspark and copy the folder shown after “Loaded from”.'),
      h('label', { class: 'field' }, icon('folder'), h('input', { id: 'update-path', class: 'mono', placeholder: '~/browspark-extension', 'aria-label': 'Extension folder', value: ui.updatePath, oninput: (e: Event) => { ui.updatePath = (e.target as HTMLInputElement).value; const b = $('update-go') as HTMLButtonElement | null; if (b) b.disabled = !ui.updatePath.trim(); } })));
  const notes = st.notes ? plainNotes(st.notes) : '';
  return h('div', { class: 'modal-backdrop', 'data-key': 'update', onclick: (e: Event) => { if (e.target === e.currentTarget && !installing) laterUpdate(s); } },
    h('section', { class: 'modal update-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'update-title', 'aria-describedby': 'update-lead' },
      h('div', { class: 'update-head' },
        h('span', { class: 'update-mark', 'aria-hidden': 'true' }, h('img', { src: 'assets/logo.png', alt: '' }), h('span', { class: 'update-badge' }, icon('up'))),
        h('div', {}, h('h2', { id: 'update-title' }, installing ? `Updating to ${latest}` : u.installError ? 'The update did not finish' : 'Update available'),
          h('p', { id: 'update-lead' }, installing ? 'Keep this tab open. The dashboard reloads when the new version starts.' : `Browspark ${latest} is ready. You have ${s.extensionVersion}.`))),
      installing ? h('div', { class: 'update-progress', role: 'status', 'aria-live': 'polite' },
        h('div', { class: 'update-stage' }, spinner(), h('span', {}, `${STAGES[stage!]}…`), stage === 'download' && u.install!.total ? h('small', {}, `${Math.round((u.install!.received ?? 0) / 1024)} of ${Math.round(u.install!.total / 1024)} KB`) : null),
        h('span', { class: 'progress wide', role: 'progressbar', 'aria-label': 'Update progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('span', { style: `width:${pct}%` })))
        : null,
      !installing && notes ? h('div', { class: 'update-notes', tabindex: '0', 'aria-label': 'Release notes' }, notes) : null,
      u.installError && !installing ? h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('span', {}, u.installError)) : null,
      where,
      h('div', { class: 'update-actions' },
        st.releaseUrl ? h('a', { class: 'text-link', href: st.releaseUrl, target: '_blank', rel: 'noreferrer' }, st.installable || st.candidates?.length || installing ? 'Release notes' : 'Download from the release page', icon('external')) : h('span', {}),
        h('div', { class: 'row' },
          installing ? null : h('button', { class: 'btn ghost', onclick: () => laterUpdate(s) }, 'Later'),
          h('button', { id: 'update-go', class: 'btn primary', disabled: installing || !ready, 'aria-busy': String(installing), onclick: () => startUpdate(s) }, installing ? spinner() : icon('download'), installing ? 'Updating…' : u.installError ? 'Try again' : 'Update now')))));
}

function updateSidebar(s: State) {
  const st = s.update.status;
  if (!st?.available || !s.updateCheck || !st.latest) return null;
  return h('button', { class: `update-card ${s.update.install ? 'busy' : ''}`, 'data-key': 'update', onclick: () => { ui.updateOpen = true; repaint(); } },
    h('span', { class: 'update-card-icon', 'aria-hidden': 'true' }, s.update.install ? spinner() : icon('up')),
    h('span', { class: 'update-card-copy' }, h('b', {}, s.update.install ? 'Updating…' : 'Update available'), h('small', {}, `v${s.extensionVersion} → v${st.latest}`)),
    icon('arrow'));
}

function updatesCard(s: State) {
  const u = s.update, st = u.status;
  const statusText = u.checking ? 'Checking for updates…'
    : u.unreachable ? u.unreachable
    : !st ? (s.updateCheck ? 'Not checked yet.' : 'Update checks are off.')
    : st.reason === 'disabled' ? 'Update checks are turned off in the companion (BROWSPARK_UPDATE_CHECK=0).'
    : st.reason === 'offline' ? st.error ?? 'Could not reach GitHub.'
    : st.available ? `Browspark ${st.latest} is available.` : `Up to date. The latest release is ${st.latest}.`;
  const companionBehind = !!st?.latest && compareVersions(st.companion, st.latest) < 0;
  return h('section', { class: 'card', id: 'set-updates' },
    cardHead('download', 'Updates', st?.available ? h('span', { class: 'pill ok' }, `${st.latest} available`) : null),
    settingRow('Version', [
      h('p', {}, `Extension v${s.extensionVersion} · companion v${st?.companion ?? s.companionVersion ?? '?'}`),
      h('p', { class: u.unreachable ? 'err-text' : 'hint' }, statusText, st && !u.checking && !u.unreachable ? h('span', { 'data-ago': String(st.checkedAt), 'data-ago-fmt': ' Checked {ago} ago.' }, ` Checked ${ago(st.checkedAt)} ago.`) : null),
      companionBehind ? h('p', { class: 'hint' }, `The companion (v${st!.companion}) is older than ${st!.latest}. Restart your MCP client so it starts the latest companion.`) : null],
      h('button', { id: 'check-updates', class: 'btn', disabled: u.checking || !!u.install, onclick: () => ask({ type: 'checkUpdate' }).then(paint) }, u.checking ? spinner() : icon('refresh'), u.checking ? 'Checking…' : 'Check now'),
      st?.available ? h('button', { class: 'btn primary', onclick: () => { ui.updateOpen = true; repaint(); } }, icon('download'), 'Update…') : null),
    settingRow('Check for updates', [h('p', {}, 'Asks your local companion, which checks Browspark’s GitHub releases at most every 6 hours. When a release is out you get a badge and one notification, and you choose when to install it.')],
      sw({ id: 'update-check', checked: s.updateCheck, 'aria-label': 'Check for updates', onchange: (e: Event) => ask({ type: 'setUpdateCheck', on: checked(e) }).then(paint) })),
    settingRow('Install location', [h('p', {}, st?.target ? h('code', {}, st.target.display) : st?.candidates?.length ? `${st.candidates.length} ${engineName(s)} builds found; you choose one when updating.` : st ? 'Not found automatically. You can enter the folder when updating.' : 'Shown once the companion answers.'),
      h('p', { class: 'hint' }, 'Updates replace the files in the folder this browser loaded Browspark from, then reload the extension.')]));
}

// ---------- paint loop ----------
const VIEWS: Record<string, (s: State) => HTMLElement> = { overview: viewOverview, tabs: viewTabs, graph: viewGraph, tools: viewTools, activity: viewActivity, settings: viewSettings };
let lastKey = '', lastRoute = '';
/** Everything that should trigger a re-render; timers are updated in place by tick(). */
const fingerprint = (s: State) => JSON.stringify(s);
/** Refresh relative times without rebuilding the DOM. */
function tick() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-ago]')) el.textContent = el.dataset.agoFmt!.replace('{ago}', ago(Number(el.dataset.ago)));
}
/** Older workers (before an extension reload) omit newer fields; never let that blank the page. */
function normalize(s: Partial<State> | undefined): State {
  const x = (s ?? {}) as Partial<State>;
  const defaults: State = { connected: false, connecting: false, stopped: false, shareAll: false, activityLog: false, overlay: true, backgroundMode: true, graphEnabled: true, managementGranted: false, extensionsAccess: false, extensionPages: false, port: 9223, customBrowser: '', extensionVersion: '?', windows: [], tabs: [], recent: [], totals: { ops: 0, errors: 0 }, toolCatalog: [], disabledTools: [], devMode: 'auto', updateCheck: true, update: { checking: false } };
  const out: State = { ...defaults, ...x } as State;
  for (const k of ['windows', 'tabs', 'recent', 'toolCatalog', 'disabledTools'] as const) if (!Array.isArray(out[k])) (out as any)[k] = [];
  if (!out.totals) out.totals = { ops: 0, errors: 0 };
  if (!out.update || typeof out.update !== 'object') out.update = { checking: false };
  return out;
}
let rawState: Partial<State> | undefined;
let dialogShown = false, dialogReturn: HTMLElement | null = null;
function paint(raw: State) {
  rawState = raw;
  const s = normalize(raw);
  if (connectionAction) Object.assign(s, { connected: false, connecting: connectionAction === 'connect', stopped: connectionAction === 'stop', lastError: undefined });
  state = s;
  try { paintInner(s); }
  catch (e) {
    // a rendering bug must never leave a blank page
    $('main').replaceChildren(h('div', { class: 'notice bad', style: 'margin:16px' }, icon('alert'), h('span', {}, `The dashboard failed to render: ${(e as Error).message}. Try reloading the extension from your browser’s extensions page and reopening this dashboard.`), h('button', { class: 'btn sm', onclick: () => api.runtime.reload() }, 'Reload extension')));
  }
}
function paintInner(s: State) {
  const key = fingerprint(s);
  if (key === lastKey && route === lastRoute) { tick(); return; }
  lastKey = key;
  const main = $('main');
  const sameRoute = route === lastRoute;
  lastRoute = route;
  // preserve focus and caret across re-renders
  const a = document.activeElement as HTMLInputElement | null;
  const keep = a && a.id && 'selectionStart' in a ? { id: a.id, value: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
  const drafts = sameRoute ? [...main.querySelectorAll<HTMLInputElement>('#port,#browser-label')].filter((el) => el.value !== el.defaultValue).map((el) => ({ id: el.id, value: el.value })) : [];
  renderShell(s);
  document.title = `${NAV.find((n) => n[0] === route)?.[2] ?? 'Browspark'} · Browspark`;
  // The worker only picks up new code when the extension is reloaded; this page reloads on its own. Detect the mismatch.
  const onDisk = api.runtime.getManifest().version;
  const stale = !rawState || rawState.disabledTools === undefined || rawState.shareAll === undefined || rawState.connecting === undefined || rawState.graphEnabled === undefined || s.extensionVersion !== onDisk;
  const view = (VIEWS[route] ?? viewOverview)(s);
  if (!sameRoute) view.classList.add('enter');
  const updated = s.justUpdated ? h('div', { class: 'notice ok stale-banner', role: 'status' }, icon('check'), h('span', {}, `Browspark is now v${s.justUpdated.to} (was v${s.justUpdated.from}).`), h('button', { class: 'btn sm', onclick: () => ask({ type: 'ackUpdated' }).then(paint) }, 'Dismiss')) : null;
  const banner = stale ? h('div', { class: 'notice warn stale-banner' }, icon('alert'), h('span', {}, `The extension was updated on disk (worker v${s.extensionVersion ?? '?'}, files v${onDisk}). Reload it to pick up the new background code, then reopen this page.`), h('button', { class: 'btn sm', onclick: () => api.runtime.reload() }, icon('refresh'), 'Reload extension')) : null;
  if (sameRoute) patch(main, updated, banner, view); else { main.replaceChildren(...[updated, banner, view].filter((x): x is HTMLElement => !!x)); main.scrollTop = 0; }
  const dialog = updateDialogOpen(s);
  patch($('update-layer'), dialog ? updateDialog(s) : null);
  document.querySelector('.shell')?.toggleAttribute('inert', dialog);
  if (dialog && !dialogShown) {
    dialogReturn = document.activeElement as HTMLElement | null;
    const go = $<HTMLButtonElement>('update-go');
    (go && !go.disabled ? go : $('update-path') ?? document.querySelector<HTMLElement>('.update-dialog .btn'))?.focus();
  }
  if (!dialog && dialogShown) dialogReturn?.focus?.();
  dialogShown = dialog;
  syncGraphCanvas($('graph-canvas'));
  for (const draft of drafts) { const el = $<HTMLInputElement>(draft.id); if (el) el.value = draft.value; }
  if (keep) { const el = $<HTMLInputElement>(keep.id); if (el) { el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch {} } }
}
/** Force a rebuild (route change, local UI state change) even when worker state is unchanged. */
const repaint = () => { lastKey = ''; if (state) paint(state); };
const refreshState = () => {
  if (connectionAction) return;
  const epoch = connectionEpoch;
  ask({ type: 'getState' }).then((s) => { if (epoch === connectionEpoch) paint(s); });
};
document.querySelector<HTMLAnchorElement>('.skip-link')!.onclick = (e) => { e.preventDefault(); $('main').focus(); };
window.addEventListener('hashchange', () => { route = location.hash.replace(/^#\/?/, '') || 'overview'; editing = false; repaint(); });
document.addEventListener('keydown', (e) => {
  if (!dialogShown || !state) return;
  if (e.key === 'Escape' && !state.update.install) { e.preventDefault(); laterUpdate(state); }
  if (e.key === 'Tab') {
    const items = [...document.querySelectorAll<HTMLElement>('.update-dialog a, .update-dialog button:not(:disabled), .update-dialog input')];
    const first = items[0], last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});
document.addEventListener('keydown', (e) => { if (e.key === '/' && !(e.target as HTMLElement).matches('input, select, textarea')) { const s = $('search') ?? $('toolsearch'); if (s) { e.preventDefault(); s.focus(); } } });
refreshState();
setInterval(refreshState, 1000);
