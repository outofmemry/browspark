// Agent presence overlay: a cyan halo, a cursor that travels to each click, a typing highlight and a Stop pill,
// drawn on the tab while the agent works. Injected over CDP into an isolated world (no content script, no host
// permissions), inside a closed shadow root with a constructed stylesheet to isolate its styles from the page.
import type { Sessions } from './session.ts';
import { currentClient } from './context.ts';

export const OVERLAY_WORLD = 'browspark';
/** Binding the Stop button calls; the extension handles Runtime.bindingCalled by unsharing the tab. */
export const STOP_BINDING = '__browsparkStop';
const BEAT_MS = 1000;

const SCRIPT = `(() => {
  if (globalThis.__bs && !globalThis.__bs.stopped) return;
  const CSS = \`
    :host, .root { all: initial; }
    .root { --halo-width: clamp(40px, 9vmin, 110px); --accent: #51bfd4; position: fixed; inset: 0; overflow: clip; pointer-events: none; z-index: 2147483647; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; opacity: 0; transition: opacity .25s ease; }
    .root.on { opacity: 1; }
    /* A steady inward haze, flush under the toolbar. No hard stroke or tint over the page center. */
    .glow { position: absolute; inset: 0; border-radius: 0 0 10px 10px; box-shadow: inset 0 0 var(--halo-width) calc(var(--halo-width) * .12) rgb(49 180 204 / .65), inset 0 0 calc(var(--halo-width) * .3) 0 rgb(65 188 210 / .25); }
    /* Neutral surfaces and mint status match the dashboard's dark theme. */
    .pill { position: absolute; left: 50%; bottom: clamp(18px, 3.5vh, 32px); transform: translateX(-50%); display: flex; align-items: center; gap: 8px; max-width: calc(100% - 32px); box-sizing: border-box; padding: 4px 5px 4px 10px; border: 1px solid #282828; border-radius: 6px; background: #171717; color: #ededed; box-shadow: 0 1px 4px rgba(0,0,0,.16); pointer-events: auto; white-space: nowrap; }
    .dot { flex-shrink: 0; width: 5px; height: 5px; border-radius: 50%; background: #3ecf8e; }
    .name { overflow: hidden; text-overflow: ellipsis; color: #979797; }
    .name:empty { display: none; }
    .stop { display: none; flex-shrink: 0; align-items: center; gap: 6px; margin-left: 2px; padding: 3px 7px; border: 0; border-radius: 4px; background: transparent; color: #acacac; font: inherit; cursor: pointer; }
    .stop.show { display: inline-flex; }
    .stop:hover { background: #232323; color: #ededed; }
    .stop:focus-visible { outline: 2px solid #3ecf8e; outline-offset: 1px; }
    .stop i { width: 6px; height: 6px; border-radius: 1px; background: currentColor; }
    .cursor { position: absolute; left: 0; top: 0; width: 18px; height: 18px; transform: translate(-40px, -40px); opacity: 0; }
    .cursor.show { opacity: 1; }
    .ripple { position: absolute; width: 20px; height: 20px; margin: -10px 0 0 -10px; box-sizing: border-box; border-radius: 50%; border: 1px solid var(--accent); opacity: 0; transform: scale(.3); }
    .ripple.go { animation: ripple .3s ease-out forwards; }
    .box { position: absolute; box-sizing: border-box; border: 1px solid var(--accent); border-radius: 4px; box-shadow: 0 0 0 2px rgb(81 191 212 / .1); opacity: 0; transition: opacity .2s; }
    .box.show { opacity: 1; }
    @keyframes ripple { 0% { opacity: .55; transform: scale(.3); } 100% { opacity: 0; transform: scale(1.3); } }
    @media (prefers-reduced-motion: reduce) { .root, .cursor, .box { transition: none; } .ripple.go { animation: none; } }
  \`;
  let host = null, root, pill, name, stop, cursor, ripple, box, idle, boxTimer, lastPosition, dead = false;
  // Checked at mount time: the binding lands in this world once the extension's session installs it.
  const canStop = () => typeof globalThis.${STOP_BINDING} === 'function';
  const mount = () => {
    if (host && host.isConnected) return true;
    const doc = document, parent = doc.documentElement;
    if (!parent) return false;
    host = doc.createElement('browspark-overlay');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block';
    const sh = host.attachShadow({ mode: 'closed' });
    try { const sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); sh.adoptedStyleSheets = [sheet]; } catch {}
    root = doc.createElement('div'); root.className = 'root';
    // HTML sinks are blocked on pages requiring Trusted Types, even in this isolated world.
    const add = (tag, cls, parent = root, text = '') => {
      const el = doc.createElement(tag); el.className = cls; el.textContent = text; parent.append(el); return el;
    };
    add('div', 'glow').setAttribute('aria-hidden', 'true');
    pill = add('div', 'pill');
    add('span', 'dot', pill).setAttribute('aria-hidden', 'true'); add('span', '', pill, 'Browspark'); name = add('span', 'name', pill);
    stop = add('button', 'stop', pill); stop.type = 'button'; add('i', '', stop); stop.append(doc.createTextNode('Stop'));
    stop.setAttribute('aria-label', 'Stop Browspark on this tab');
    box = add('div', 'box'); box.setAttribute('aria-hidden', 'true');
    cursor = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.setAttribute('class', 'cursor'); cursor.setAttribute('viewBox', '0 0 18 18');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key, value] of Object.entries({ d: 'M2 2 15 6.5 9 9 6.5 15Z', fill: '#232323', stroke: '#979797', 'stroke-width': '1.25', 'stroke-linejoin': 'round' })) path.setAttribute(key, value);
    cursor.append(path); root.append(cursor); ripple = add('div', 'ripple'); ripple.setAttribute('aria-hidden', 'true');
    sh.append(root);
    if (canStop()) { stop.classList.add('show'); stop.addEventListener('click', () => { dead = true; host.remove(); globalThis.${STOP_BINDING}('stop'); }); }
    parent.append(host);
    return true;
  };
  const fade = () => { if (root) root.classList.remove('on'); setTimeout(() => { if (root && !root.classList.contains('on') && host) host.remove(); }, 400); };
  const show = (agent) => {
    if (dead || !mount()) return false;
    if (agent) name.textContent = agent === 'agent' ? '' : '· ' + agent;
    root.classList.add('on');
    clearTimeout(idle); idle = setTimeout(fade, 4000);
    return true;
  };
  globalThis.__bs = {
    get stopped() { return dead; },
    show,
    cursor(x, y, kind, agent) {
      if (!show(agent)) return;
      const from = cursor.classList.contains('show') ? getComputedStyle(cursor).transform
        : lastPosition || 'translate(' + (innerWidth / 2 - 2) + 'px,' + (innerHeight / 2 - 2) + 'px)';
      const point = new DOMMatrixReadOnly(from);
      const distance = Math.hypot(x - 2 - point.m41, y - 2 - point.m42);
      const duration = matchMedia('(prefers-reduced-motion: reduce)').matches || distance < 1 ? 0 : Math.min(1200, 320 + distance * .6);
      // Read the rendered position before cancelling, so interrupted travel stays continuous.
      for (const animation of cursor.getAnimations()) animation.cancel();
      cursor.classList.add('show');
      lastPosition = cursor.style.transform = 'translate(' + (x - 2) + 'px,' + (y - 2) + 'px)';
      const animation = cursor.animate({ transform: [from, lastPosition] }, { duration, easing: 'cubic-bezier(.42,0,.58,1)' });
      animation.onfinish = () => {
        if (kind === 'click' && host?.isConnected && !dead) { ripple.style.left = x + 'px'; ripple.style.top = y + 'px'; ripple.classList.remove('go'); void ripple.offsetWidth; ripple.classList.add('go'); }
      };
      return duration;
    },
    typing(agent) {
      if (!show(agent)) return;
      const el = document.activeElement;
      if (!el || el === document.body) return;
      const r = el.getBoundingClientRect();
      box.style.left = (r.left - 3) + 'px'; box.style.top = (r.top - 3) + 'px'; box.style.width = (r.width + 6) + 'px'; box.style.height = (r.height + 6) + 'px';
      box.classList.add('show');
      clearTimeout(boxTimer); boxTimer = setTimeout(() => box.classList.remove('show'), 1500);
    },
    hide(on) { if (host) host.style.display = on ? 'none' : 'block'; },
  };
})();`;

export class Overlay {
  /** Switched off from the dashboard's Settings. */
  enabled = true;
  private installed = new Set<number>();
  private contexts = new Map<number, number>();
  private frames = new Map<number, string>();
  private lastBeat = new Map<number, number>();
  private readonly s: Sessions;
  constructor(s: Sessions) {
    this.s = s;
    const forget = (tabId: number) => { this.installed.delete(tabId); this.contexts.delete(tabId); this.frames.delete(tabId); this.lastBeat.delete(tabId); };
    s.on('detached', ({ tabId }) => forget(tabId));
    s.on('cdp.event', ({ tabId, method, params, sessionId }) => {
      if (sessionId) return;
      if (method === 'Runtime.executionContextCreated' && params?.context?.auxData?.name === OVERLAY_WORLD && params.context.auxData.frameId === this.frames.get(tabId) && !params.context.auxData.isDefault) {
        // The on-new-document script re-creates the world after each navigation; track its fresh context id.
        this.contexts.set(tabId, params.context.id);
      }
      if (method === 'Runtime.executionContextsCleared') this.contexts.delete(tabId);
    });
  }

  private agent() { return currentClient()?.name ?? 'agent'; }
  private enabledFor(tabId: number) { const connection = this.s.bridge?.connectionForTab(tabId); return connection ? connection.policy?.overlay !== false : this.enabled; }

  /** The Firefox extension has no binding transport or preload scripts: the Stop pill stays hidden there
   * and the overlay reinstalls lazily through an isolated user-script world on the next command after each navigation. */
  private isFirefoxExtension(tabId: number) { return this.s.modeOf(tabId) === 'extension' && this.s.bridge?.connectionForTab(tabId)?.browserEngine === 'firefox'; }

  /** Install the world, the on-new-document script and (extension mode) the Stop binding once per attachment. */
  private async ensure(tabId: number): Promise<number | undefined> {
    if (!this.enabledFor(tabId)) return undefined;
    const firefoxExtension = this.isFirefoxExtension(tabId);
    if (!this.installed.has(tabId)) {
      this.installed.add(tabId);
      await this.s.cdp(tabId, 'Runtime.enable');
      await this.s.cdp(tabId, 'Page.enable');
      if (!firefoxExtension) {
        if (this.s.modeOf(tabId) === 'extension') await this.s.cdp(tabId, 'Runtime.addBinding', { name: STOP_BINDING, executionContextName: OVERLAY_WORLD });
        await this.s.cdp(tabId, 'Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT, worldName: OVERLAY_WORLD });
      }
    }
    let ctx = this.contexts.get(tabId);
    if (ctx === undefined) {
      const { frameTree } = await this.s.cdp(tabId, 'Page.getFrameTree');
      this.frames.set(tabId, frameTree.frame.id);
      const r = await this.s.cdp(tabId, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: OVERLAY_WORLD });
      ctx = r.executionContextId as number;
      this.contexts.set(tabId, ctx);
      await this.s.cdp(tabId, 'Runtime.evaluate', { expression: SCRIPT, contextId: ctx });
    }
    return ctx;
  }

  /** Run an overlay call; failures never surface to the agent. */
  private async call(tabId: number, expression: string) {
    try {
      let ctx = await this.ensure(tabId);
      if (ctx === undefined) return;
      let r = await this.s.cdp(tabId, 'Runtime.evaluate', { expression: `__bs && __bs.${expression}`, contextId: ctx, returnByValue: true });
      if (r?.exceptionDetails && /Cannot find context|__bs is not defined/.test(JSON.stringify(r.exceptionDetails))) {
        this.contexts.delete(tabId);
        ctx = await this.ensure(tabId);
        if (ctx !== undefined) r = await this.s.cdp(tabId, 'Runtime.evaluate', { expression: `__bs && __bs.${expression}`, contextId: ctx, returnByValue: true });
      }
      return r?.result?.value;
    } catch {}
  }

  /** Keep the frame lit while commands flow; at most one call per second per tab. */
  beat(tabId: number) {
    if (!this.enabledFor(tabId)) return;
    const now = Date.now();
    if (now - (this.lastBeat.get(tabId) ?? 0) < BEAT_MS) return;
    this.lastBeat.set(tabId, now);
    void this.call(tabId, `show(${JSON.stringify(this.agent())})`);
  }

  /** Wait for travel before clicks/hover; drag keeps dispatching input while the cursor moves. */
  async cursor(tabId: number, x: number, y: number, kind: 'click' | 'hover' | 'drag') {
    if (!this.enabledFor(tabId)) return;
    this.lastBeat.set(tabId, Date.now());
    const duration = await this.call(tabId, `cursor(${Math.round(x)},${Math.round(y)},${JSON.stringify(kind)},${JSON.stringify(this.agent())})`);
    // Leave two frames for animation startup, using a bounded timer even if a background tab stops painting.
    if (kind !== 'drag' && typeof duration === 'number' && duration > 0) await new Promise((r) => setTimeout(r, duration + 34));
  }

  /** Outline the focused element while text is entered. */
  async typing(tabId: number) {
    if (!this.enabledFor(tabId)) return;
    this.lastBeat.set(tabId, Date.now());
    await this.call(tabId, `typing(${JSON.stringify(this.agent())})`);
  }

  /** Hide the overlay around a capture so screenshots and PDFs show the page as it is. */
  async withHidden<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    if (!this.installed.has(tabId)) return fn();
    await this.call(tabId, 'hide(true)');
    try { return await fn(); } finally { await this.call(tabId, 'hide(false)'); }
  }
}
