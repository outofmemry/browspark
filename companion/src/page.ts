// Page-level operations on top of raw CDP. Shared by extension mode and (later) direct CDP mode.
import { Overlay } from './overlay.ts';
import type { Sessions } from './session.ts';

export interface Dialog { type: string; message: string; defaultPrompt?: string }

/**
 * In-page script. Walks the DOM (and same-origin iframes), emits an indented accessible tree,
 * and stores element handles on window.__bmcp so later calls can resolve `e12` refs.
 */
const SNAPSHOT_FN = String(function snapshot(this: unknown) {
  const W = window as any;
  // Refs are stable: an element keeps its index for the life of the page; disconnected ones are nulled, never reused.
  const S = W.__bmcp || (W.__bmcp = { els: [] as (Element | null)[], idx: new WeakMap<Element, number>() });
  if (!S.idx) S.idx = new WeakMap();
  S.els.forEach((e: Element | null, i: number) => { if (e && !e.isConnected) S.els[i] = null; });
  const refOf = (el: Element) => { let i = S.idx.get(el); if (i === undefined) { i = S.els.push(el) - 1; S.idx.set(el, i); } return i; };
  const ROLE: Record<string, string> = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', IMG: 'img',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
    NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', FORM: 'form', TABLE: 'table',
    UL: 'list', OL: 'list', LI: 'listitem', LABEL: 'label', DIALOG: 'dialog', SUMMARY: 'button', DETAILS: 'group',
    IFRAME: 'iframe', OPTION: 'option', TR: 'row', TH: 'columnheader', TD: 'cell',
  };
  const INPUT_ROLE: Record<string, string> = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', file: 'button', image: 'button' };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'HEAD', 'META', 'LINK', 'BROWSPARK-OVERLAY']);
  const lines: string[] = [];
  const clip = (s: string, n = 120) => { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

  // 'hidden': skip the element and its subtree. 'boxless': element has no box of its own (display: contents,
  // zero-size wrapper) but its children may be visible, so keep walking. true: visible.
  function visible(el: Element): boolean | 'boxless' {
    const view = el.ownerDocument.defaultView || window;
    const st = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : ({} as CSSStyleDeclaration);
    if (st.display === 'none' || st.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true') return false;
    if ((el as HTMLElement).hidden) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0 || el.tagName === 'OPTION' ? true : 'boxless';
  }
  function role(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    if (el.tagName === 'INPUT') return INPUT_ROLE[(el as HTMLInputElement).type] || 'textbox';
    if (el.tagName === 'A' && !el.hasAttribute('href')) return 'generic';
    return ROLE[el.tagName] || 'generic';
  }
  function name(el: Element): string {
    const doc = el.ownerDocument;
    const lab = el.getAttribute('aria-labelledby');
    if (lab) return clip(lab.split(/\s+/).map((id) => doc.getElementById(id)?.textContent || '').join(' '));
    const al = el.getAttribute('aria-label'); if (al) return clip(al);
    if (el.tagName === 'IMG') return clip(el.getAttribute('alt') || '');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const id = el.id && doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const wrap = el.closest('label');
      const isBtn = INPUT_ROLE[(el as HTMLInputElement).type] === 'button';
      const t = (id || wrap)?.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || (isBtn ? (el as HTMLInputElement).value : '');
      return clip(t || el.getAttribute('name') || '');
    }
    if (el.tagName === 'IFRAME') return clip(el.getAttribute('title') || el.getAttribute('src') || '');
    return clip(el.getAttribute('title') || '');
  }
  const interactive = (el: Element, r: string) =>
    /^(link|button|textbox|combobox|checkbox|radio|slider|option|menuitem|tab|switch|searchbox|spinbutton|iframe)$/.test(r) ||
    (el as HTMLElement).isContentEditable || el.hasAttribute('onclick') || el.getAttribute('tabindex') !== null || el.tagName === 'SUMMARY';

  function state(el: Element): string {
    const out: string[] = [];
    const i = el as HTMLInputElement;
    if (el.tagName === 'INPUT' && (i.type === 'checkbox' || i.type === 'radio')) out.push(i.checked ? 'checked' : 'unchecked');
    else if (el.getAttribute('aria-checked')) out.push(el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked');
    if (i.disabled || el.getAttribute('aria-disabled') === 'true') out.push('disabled');
    if (el.getAttribute('aria-expanded')) out.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true' || (el as HTMLOptionElement).selected) out.push('selected');
    if (el.tagName === 'INPUT' && i.value && i.type !== 'password' && !INPUT_ROLE[i.type]) out.push(`value="${clip(i.value, 60)}"`);
    if (el.tagName === 'TEXTAREA' && i.value) out.push(`value="${clip(i.value, 60)}"`);
    if (el.tagName === 'SELECT') { const s = el as HTMLSelectElement; if (s.selectedIndex >= 0) out.push(`value="${clip(s.options[s.selectedIndex].text, 60)}"`); }
    if (el.tagName === 'A' && el.getAttribute('href')) out.push(`href="${clip((el as HTMLAnchorElement).href, 80)}"`);
    if (/^H[1-6]$/.test(el.tagName)) out.push(`level=${el.tagName[1]}`);
    if (el.ownerDocument.activeElement === el) out.push('focused');
    return out.length ? ' ' + out.join(' ') : '';
  }

  function walk(node: Node, depth: number) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = clip(node.textContent || '');
      if (t) lines.push(`${'  '.repeat(depth)}- text "${t}"`);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP.has(el.tagName)) return;
    const v = visible(el);
    if (!v) return;
    const r = role(el);
    const emit = v === true && (r !== 'generic' || interactive(el, r));
    let d = depth;
    if (emit) {
      const ref = refOf(el);
      const n = name(el);
      // leaf text nodes fold into the name for compact output
      const ownText = !n && el.children.length === 0 ? clip(el.textContent || '') : '';
      const label = n || ownText;
      lines.push(`${'  '.repeat(depth)}- ${r}${label ? ` "${label}"` : ''}${state(el)} [ref=e${ref}]`);
      if (ownText) return;
      d++;
      if (el.tagName === 'IFRAME') {
        let doc: Document | null = null;
        try { doc = (el as HTMLIFrameElement).contentDocument; } catch {}
        if (doc) walk(doc.body || doc.documentElement, d);
        else lines.push(`${'  '.repeat(d)}- text "(cross-origin frame: contents not accessible from this snapshot)"`);
        return;
      }
      if (el.tagName === 'SELECT' && (el as HTMLSelectElement).options.length > 30) { lines.push(`${'  '.repeat(d)}- text "(${(el as HTMLSelectElement).options.length} options)"`); return; }
    }
    const root = el.shadowRoot || el;
    for (const c of Array.from(root.childNodes)) walk(c, d);
  }
  walk(document.body || document.documentElement, 0);
  return { title: document.title, url: location.href, tree: lines.join('\n'), refs: S.els.length };
});

/** Resolve a ref inside the page and return a JSON-able result from `fn(el)`. Throws a clear error when stale. */
function refFn(body: string): string {
  return `(function(ref){
    var S = window.__bmcp; if (!S) throw new Error('No snapshot for this page yet; run browser_snapshot first');
    var i = Number(String(ref).replace(/^e/, '')); var el = S.els[i];
    if (el === null) throw new Error('Stale ref ' + ref + ': element was removed from the page; run browser_snapshot again');
    if (!el) throw new Error('Unknown ref ' + ref + '; run browser_snapshot');
    if (!el.isConnected) throw new Error('Stale ref ' + ref + ': element left the DOM; run browser_snapshot again');
    ${body}
  })`;
}

/** Viewport-absolute center of an element, walking up through same-origin frame offsets. */
const CENTER = `
  el.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
  var r = el.getBoundingClientRect(), x = r.left + r.width/2, y = r.top + r.height/2, w = el.ownerDocument.defaultView;
  while (w && w !== window && w.frameElement) { var fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; }
  if (r.width === 0 && r.height === 0) throw new Error('Element has no size; cannot click');
  var top = el.ownerDocument.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
  return { x: x, y: y, covered: top && top !== el && !el.contains(top) && !top.contains(el) ? (top.tagName.toLowerCase() + (top.id ? '#' + top.id : '')) : null };
`;

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }, Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 }, Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 }, Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }, ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 }, End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 }, PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
// macOS handles editing shortcuts in the browser layer, which synthetic CDP keys bypass; pass the command explicitly.
const MAC_EDIT_COMMANDS: Record<string, string> = { a: 'SelectAll', c: 'Copy', v: 'Paste', x: 'Cut', z: 'Undo' };

export class Page {
  private enabled = new Set<number>();
  /** Agent presence overlay (frame, cursor, Stop pill) drawn on the tab while commands flow. */
  readonly overlay: Overlay;
  readonly dialogs = new Map<number, Dialog>();
  private loadWaiters = new Map<number, Set<() => void>>();
  private dialogWaiters = new Map<number, Set<(why: 'dialog' | 'paused') => void>>();
  private lastSnapshot = new Map<number, string>();
  readonly s: Sessions;

  constructor(s: Sessions) {
    this.s = s;
    this.overlay = new Overlay(s);
    s.on('cdp.event', ({ tabId, method, params }) => {
      if (method === 'Page.javascriptDialogOpening') { this.dialogs.set(tabId, params as Dialog); for (const w of this.dialogWaiters.get(tabId) ?? []) w('dialog'); }
      if (method === 'Debugger.paused') for (const w of this.dialogWaiters.get(tabId) ?? []) w('paused');
      if (method === 'Page.javascriptDialogClosed') this.dialogs.delete(tabId);
      // bfcache restores and same-document navigations never fire load; treat them as navigation completion too
      if (method === 'Page.loadEventFired' || method === 'Page.navigatedWithinDocument' ||
          (method === 'Page.frameNavigated' && !(params as any).frame?.parentId && (params as any).type === 'BackForwardCacheRestore'))
        for (const w of this.loadWaiters.get(tabId) ?? []) w();
    });
    s.on('detached', ({ tabId }) => { this.enabled.delete(tabId); this.dialogs.delete(tabId); this.lastSnapshot.delete(tabId); });
  }

  async cdp<T = any>(tabId: number, method: string, params?: unknown): Promise<T> {
    if (!this.enabled.has(tabId)) {
      this.enabled.add(tabId);
      try { await this.s.cdp(tabId, 'Page.enable'); await this.s.cdp(tabId, 'Runtime.enable'); }
      catch (e) { this.enabled.delete(tabId); throw e; }
    }
    this.overlay.beat(tabId);
    return this.s.cdp<T>(tabId, method, params);
  }

  async evaluate<T = any>(tabId: number, expression: string, awaitPromise = true): Promise<T> {
    if (this.dialogs.has(tabId)) throw new Error(`A ${this.dialogs.get(tabId)!.type} dialog is open ("${this.dialogs.get(tabId)!.message}"); handle it with browser_dialog first`);
    const r = await this.cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      throw new Error(ex.exception?.description?.split('\n')[0] || ex.text || 'evaluation failed');
    }
    return r.result?.value as T;
  }

  callRef<T = any>(tabId: number, ref: string, body: string): Promise<T> {
    return this.evaluate<T>(tabId, `${refFn(body)}(${JSON.stringify(ref)})`);
  }

  async snapshot(tabId: number, diff = false) {
    const r = await this.evaluate<{ title: string; url: string; tree: string; refs: number }>(tabId, `(${SNAPSHOT_FN})()`);
    const prev = this.lastSnapshot.get(tabId);
    this.lastSnapshot.set(tabId, r.tree);
    if (!diff) return { ...r, diff: undefined as string | undefined };
    if (prev === undefined) return { ...r, diff: undefined };
    return { ...r, diff: lineDiff(prev, r.tree) };
  }

  /** Register an element found by CSS selector as a ref (for replay and selector-based tools). */
  refFromSelector(tabId: number, selector: string) {
    return this.evaluate<string>(tabId, `(function(){
      var el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('No element matches ' + ${JSON.stringify(selector)});
      var S = window.__bmcp || (window.__bmcp = { els: [], idx: new WeakMap() }); if (!S.idx) S.idx = new WeakMap(); var i = S.idx.get(el); if (i === undefined) { i = S.els.push(el) - 1; S.idx.set(el, i); } return 'e' + i; })()`);
  }

  /** A reasonably stable CSS selector for a ref, recorded alongside actions so flows can be replayed. */
  selectorFor(tabId: number, ref: string) {
    return this.callRef<string>(tabId, ref, `
      var d = el.ownerDocument;
      if (el.id && d.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
      for (var a of ['data-testid', 'data-test', 'name', 'aria-label']) { var v = el.getAttribute(a); if (v) { var sel = el.tagName.toLowerCase() + '[' + a + '=' + JSON.stringify(v) + ']'; if (d.querySelectorAll(sel).length === 1) return sel; } }
      var parts = []; var n = el;
      while (n && n.nodeType === 1 && n !== d.body) { var p = n.parentElement; var idx = p ? Array.from(p.children).filter(c => c.tagName === n.tagName).indexOf(n) + 1 : 1; parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + idx + ')'); n = p; }
      return parts.join(' > ');
    `);
  }

  async objectId(tabId: number, ref: string): Promise<string> {
    const r = await this.cdp(tabId, 'Runtime.evaluate', { expression: `${refFn('return el;')}(${JSON.stringify(ref)})` });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'ref lookup failed');
    return r.result.objectId as string;
  }

  async hover(tabId: number, ref: string) {
    const { x, y } = await this.callRef<{ x: number; y: number }>(tabId, ref, CENTER);
    await this.overlay.cursor(tabId, x, y, 'hover');
    await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return `Hovering ${ref} at (${Math.round(x)}, ${Math.round(y)})`;
  }

  async drag(tabId: number, fromRef: string, toRef: string) {
    const a = await this.callRef<{ x: number; y: number }>(tabId, fromRef, CENTER);
    const b = await this.callRef<{ x: number; y: number }>(tabId, toRef, CENTER);
    const mouse = (type: string, x: number, y: number, extra: object = {}) => this.cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
    await this.overlay.cursor(tabId, a.x, a.y, 'click');
    await mouse('mouseMoved', a.x, a.y); await mouse('mousePressed', a.x, a.y, { clickCount: 1 });
    await this.overlay.cursor(tabId, b.x, b.y, 'drag');
    const steps = 8; for (let i = 1; i <= steps; i++) await mouse('mouseMoved', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, { buttons: 1 });
    await mouse('mouseReleased', b.x, b.y, { clickCount: 1 });
    return `Dragged ${fromRef} to ${toRef}`;
  }

  async upload(tabId: number, ref: string, files: string[]) {
    const objectId = await this.objectId(tabId, ref);
    await this.cdp(tabId, 'DOM.setFileInputFiles', { files, objectId });
    return `Set ${files.length} file(s) on ${ref}`;
  }

  async screenshotAdvanced(tabId: number, opts: { fullPage?: boolean; ref?: string; format?: 'png' | 'jpeg'; quality?: number }) {
    const format = opts.format ?? 'png';
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (opts.ref) {
      const r = await this.callRef<{ x: number; y: number; w: number; h: number }>(tabId, opts.ref, `
        el.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
        var r = el.getBoundingClientRect(), x = r.left, y = r.top, w = el.ownerDocument.defaultView;
        while (w && w !== window && w.frameElement) { var fr = w.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; w = w.parent; }
        return { x: x + window.scrollX, y: y + window.scrollY, w: r.width, h: r.height };`);
      clip = { x: r.x, y: r.y, width: Math.max(1, r.w), height: Math.max(1, r.h), scale: 1 };
    } else if (opts.fullPage) {
      const m = await this.cdp(tabId, 'Page.getLayoutMetrics');
      const cs = m.cssContentSize ?? m.contentSize;
      clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.min(Math.ceil(cs.height), 16384), scale: 1 };
    }
    const r = await this.overlay.withHidden(tabId, () => this.cdp(tabId, 'Page.captureScreenshot', { format, quality: format === 'jpeg' ? opts.quality ?? 80 : undefined, clip, captureBeyondViewport: !!clip }));
    return { data: r.data as string, mimeType: `image/${format}` };
  }

  /** Structured extraction: for each element matching `items`, read named fields (text or attribute). */
  extract(tabId: number, spec: { items: string; fields: Record<string, string | { selector?: string; attr?: string }>; limit?: number }) {
    return this.evaluate(tabId, `(function(){
      var spec = ${JSON.stringify(spec)}; var out = [];
      for (var it of Array.from(document.querySelectorAll(spec.items)).slice(0, spec.limit || 200)) {
        var row = {};
        for (var [k, f] of Object.entries(spec.fields)) {
          var sel = typeof f === 'string' ? f : f.selector, attr = typeof f === 'string' ? undefined : f.attr;
          var el = !sel || sel === '.' ? it : it.querySelector(sel);
          row[k] = !el ? null : attr ? (attr === 'href' || attr === 'src' ? el[attr] : el.getAttribute(attr)) : (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        }
        out.push(row);
      }
      return out; })()`);
  }

  async click(tabId: number, ref: string, opts: { button?: 'left' | 'right' | 'middle'; count?: number; modifiers?: string[] } = {}) {
    const { x, y, covered } = await this.callRef<{ x: number; y: number; covered: string | null }>(tabId, ref, CENTER);
    const modifiers = (opts.modifiers ?? []).reduce((m, k) => m | (MODS[k.toLowerCase()] ?? 0), 0);
    const button = opts.button ?? 'left';
    const count = opts.count ?? 1;
    await this.overlay.cursor(tabId, x, y, 'click');
    await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    const r = await this.inputRacingDialog(tabId, async () => {
      for (let i = 1; i <= count; i++) {
        await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
        await this.cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
      }
    });
    if (r === 'dialog') { const d = this.dialogs.get(tabId)!; return `Clicked ${ref}; a ${d.type} dialog opened ("${d.message}"). Use browser_dialog to accept or dismiss it.`; }
    if (r === 'paused') return `Clicked ${ref}; the debugger paused (breakpoint or exception). Use devtools_debugger stack/resume.`;
    return covered ? `Clicked ${ref} at (${Math.round(x)}, ${Math.round(y)}). Note: point was covered by <${covered}>, which may have received the click.` : `Clicked ${ref}`;
  }

  async fill(tabId: number, ref: string, text: string) {
    const kind = await this.callRef<string>(tabId, ref, `
      el.focus();
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        var t = (el.type || '').toLowerCase();
        if (/^(date|time|datetime-local|month|week|color|range|number)$/.test(t)) {
          el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return 'set';
        }
        if (/^(checkbox|radio|file|button|submit|reset)$/.test(t)) throw new Error('Cannot fill an input of type ' + t + '; use browser_click');
        el.select(); return 'text';
      }
      if (el.isContentEditable) { var s = el.ownerDocument.getSelection(); s.selectAllChildren(el); return 'text'; }
      throw new Error('Element is not fillable (' + tag.toLowerCase() + ')');
    `);
    if (kind === 'text') {
      await this.overlay.typing(tabId);
      // insertText replaces the current selection and fires native input events.
      await this.cdp(tabId, 'Input.insertText', { text });
      if (text === '') await this.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }).then(() => this.cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }));
    }
    return `Filled ${ref}`;
  }

  async select(tabId: number, ref: string, values: string[]) {
    await this.callRef<void>(tabId, ref, 'el.focus();');
    await this.overlay.typing(tabId);
    return this.callRef<string>(tabId, ref, `
      if (el.tagName !== 'SELECT') throw new Error('Element is not a <select>');
      var want = ${JSON.stringify(values)}, hit = [];
      for (var o of el.options) { var m = want.includes(o.value) || want.includes(o.text.trim()); if (!el.multiple && hit.length && m) m = false; o.selected = m; if (m) hit.push(o.text.trim()); }
      if (!hit.length) throw new Error('No option matched ' + JSON.stringify(want) + '. Options: ' + Array.from(el.options).map(o => o.text.trim()).slice(0, 30).join(' | '));
      el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));
      return 'Selected ' + hit.join(', ');
    `);
  }

  /** Press a key or chord like "Enter", "Control+a", "Shift+Tab". Single printable chars are typed. */
  async key(tabId: number, combo: string) {
    const parts = combo.split('+');
    const last = parts.pop()!;
    const modifiers = parts.reduce((m, k) => m | (MODS[k.toLowerCase()] ?? 0), 0);
    const def = KEYS[last] ?? (last.length === 1
      ? { key: last, code: /[a-z]/i.test(last) ? 'Key' + last.toUpperCase() : /[0-9]/.test(last) ? 'Digit' + last : '', keyCode: last.toUpperCase().charCodeAt(0), text: last }
      : undefined);
    if (!def) throw new Error(`Unknown key "${last}". Known: ${Object.keys(KEYS).join(', ')}, or any single character`);
    const commands = process.platform === 'darwin' && modifiers === 4 ? [MAC_EDIT_COMMANDS[last.toLowerCase()]].filter(Boolean)
      : process.platform === 'darwin' && modifiers === 12 && last.toLowerCase() === 'z' ? ['Redo'] : undefined;
    const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers, commands };
    const text = modifiers & ~8 ? undefined : def.text; // no text when ctrl/alt/meta held
    await this.overlay.typing(tabId);
    const r = await this.inputRacingDialog(tabId, async () => {
      await this.cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text });
      await this.cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    });
    if (r === 'dialog') { const d = this.dialogs.get(tabId)!; return `Pressed ${combo}; a ${d.type} dialog opened ("${d.message}"). Use browser_dialog to accept or dismiss it.`; }
    if (r === 'paused') return `Pressed ${combo}; the debugger paused. Use devtools_debugger stack/resume.`;
    return `Pressed ${combo}`;
  }

  async type(tabId: number, text: string) {
    await this.overlay.typing(tabId);
    await this.cdp(tabId, 'Input.insertText', { text });
    return `Typed ${text.length} characters`;
  }

  scroll(tabId: number, opts: { ref?: string; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number }) {
    const dir = opts.direction ?? 'down';
    const amt = opts.amount ?? 600;
    const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
    const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
    if (opts.ref) return this.callRef<string>(tabId, opts.ref, `
      var p = el; while (p && p !== el.ownerDocument.documentElement && p.scrollHeight <= p.clientHeight && p.scrollWidth <= p.clientWidth) p = p.parentElement;
      (p || el.ownerDocument.documentElement).scrollBy(${dx}, ${dy}); return 'Scrolled ' + ${JSON.stringify(dir)} + ' by ' + ${amt} + 'px within ' + (p || el).tagName.toLowerCase();
    `);
    return this.evaluate<string>(tabId, `(window.scrollBy(${dx}, ${dy}), 'Scrolled ${dir} by ${amt}px; scrollY=' + Math.round(window.scrollY) + '/' + Math.round(document.documentElement.scrollHeight - innerHeight))`);
  }

  async screenshot(tabId: number) {
    const r = await this.overlay.withHidden(tabId, () => this.cdp(tabId, 'Page.captureScreenshot', { format: 'png' }));
    return r.data as string;
  }

  read(tabId: number, what: 'text' | 'links' | 'tables' | 'html' | 'markdown', ref?: string) {
    const scope = ref ? refFn('return el;') + `(${JSON.stringify(ref)})` : 'document.body';
    const map: Record<string, string> = {
      markdown: `(${HTML_TO_MD})(${ref ? scope : 'document.querySelector("main, article, [role=main]") || document.body'})`,
      text: `${scope}.innerText`,
      html: `${scope}.outerHTML.slice(0, 200000)`,
      links: `Array.from(${scope}.querySelectorAll('a[href]')).map(a => ({ text: a.innerText.replace(/\\s+/g,' ').trim().slice(0,120), href: a.href })).filter(l => l.text || l.href).slice(0, 500)`,
      tables: `Array.from(${scope}.querySelectorAll('table')).slice(0, 20).map(t => Array.from(t.rows).slice(0, 200).map(r => Array.from(r.cells).map(c => c.innerText.replace(/\\s+/g,' ').trim())))`,
    };
    return this.evaluate(tabId, map[what]);
  }

  async navigate(tabId: number, action: 'goto' | 'reload' | 'back' | 'forward', url?: string, timeoutMs = 20_000) {
    if (action === 'goto') {
      if (!url) throw new Error('url is required for goto');
      url = /^[a-z]+:/i.test(url) ? url : 'https://' + url;
      if (this.s.modeOf(tabId) === 'extension') {
        // Prepare New Tab before attaching; the destination still uses CDP and its domain policies.
        await this.s.bridge.request('tabs.prepare', { tabId });
        this.s.bridge.invalidateTabs(this.s.bridge.connectionForTab(tabId)?.id);
      }
    }
    const loaded = this.waitForLoad(tabId, timeoutMs);
    if (action === 'goto') {
      const r = await this.cdp(tabId, 'Page.navigate', { url });
      if (r.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
    } else if (action === 'reload') {
      await this.cdp(tabId, 'Page.reload');
    } else if (this.s.devOfTab(tabId)?.browserType === 'firefox' || this.s.bridge.connectionForTab(tabId)?.browserEngine === 'firefox') {
      await this.cdp(tabId, 'Page.traverseHistory', { delta: action === 'back' ? -1 : 1 });
    } else {
      const h = await this.cdp(tabId, 'Page.getNavigationHistory');
      const idx = h.currentIndex + (action === 'back' ? -1 : 1);
      if (!h.entries[idx]) throw new Error(`Cannot go ${action}: no history entry`);
      await this.cdp(tabId, 'Page.navigateToHistoryEntry', { entryId: h.entries[idx].id });
    }
    const timedOut = !(await loaded);
    if (!timedOut) for (let i = 0; i < 40 && (await this.evaluate(tabId, 'document.readyState').catch(() => 'complete')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
    const info = await this.evaluate<{ url: string; title: string }>(tabId, '({url: location.href, title: document.title})').catch(() => ({ url: '?', title: '?' }));
    return `${timedOut ? 'Load event not seen within timeout; page may still be loading. ' : ''}Now at ${info.url} — "${info.title}"`;
  }

  /**
   * Input commands block in CDP while a JS dialog they triggered is open. Race the command against
   * the dialog-opening event so the tool returns and the agent can call browser_dialog.
   */
  private async inputRacingDialog<T>(tabId: number, run: () => Promise<T>): Promise<T | 'dialog' | 'paused'> {
    const set = this.dialogWaiters.get(tabId) ?? new Set();
    this.dialogWaiters.set(tabId, set);
    let fn!: (why: 'dialog' | 'paused') => void;
    const opened = new Promise<'dialog' | 'paused'>((r) => { fn = (why) => r(why); set.add(fn); });
    const p = run();
    p.catch(() => {}); // the losing side may reject later (timeout); never let it surface as unhandled
    try { return await Promise.race([p, opened]); } finally { set.delete(fn); }
  }

  /** Resolves true on Page.loadEventFired, false on timeout. */
  waitForLoad(tabId: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const set = this.loadWaiters.get(tabId) ?? new Set();
      this.loadWaiters.set(tabId, set);
      const done = (ok: boolean) => { clearTimeout(t); set.delete(fn); resolve(ok); };
      const fn = () => done(true);
      const t = setTimeout(() => done(false), timeoutMs);
      set.add(fn);
    });
  }

  async wait(tabId: number, cond: { text?: string; textGone?: string; url?: string; ref?: string; state?: 'visible' | 'hidden' | 'enabled' }, timeoutMs = 15_000) {
    const start = Date.now();
    let expr: string;
    if (cond.text !== undefined) expr = `document.body.innerText.includes(${JSON.stringify(cond.text)})`;
    else if (cond.textGone !== undefined) expr = `!document.body.innerText.includes(${JSON.stringify(cond.textGone)})`;
    else if (cond.url !== undefined) expr = `location.href.includes(${JSON.stringify(cond.url)})`;
    else if (cond.ref) {
      const st = cond.state ?? 'visible';
      expr = `(function(){ try { return ${refFn(`
        var r = el.getBoundingClientRect(), cs = getComputedStyle(el), vis = (r.width > 0 || r.height > 0) && cs.visibility !== 'hidden' && cs.display !== 'none';
        return ${st === 'visible' ? 'vis' : st === 'hidden' ? '!vis' : 'vis && !el.disabled'};`)}(${JSON.stringify(cond.ref)}); } catch (e) { return ${st === 'hidden' ? 'true' : 'false'}; } })()`;
    } else throw new Error('Provide one of text, textGone, url, or ref');
    while (true) {
      const ok = await this.evaluate<boolean>(tabId, expr).catch(() => false);
      if (ok) return `Condition met after ${Date.now() - start}ms`;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${JSON.stringify(cond)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async dialog(tabId: number, accept: boolean, promptText?: string) {
    const d = this.dialogs.get(tabId);
    if (!d) throw new Error('No dialog is open on this tab');
    await this.s.cdp(tabId, 'Page.handleJavaScriptDialog', { accept, promptText });
    this.dialogs.delete(tabId);
    return `${accept ? 'Accepted' : 'Dismissed'} ${d.type} dialog: "${d.message}"`;
  }
}

/** In-page HTML → Markdown for the "fetch a page as markdown" use case. Keeps headings, lists, links, code, tables, images. */
const HTML_TO_MD = String(function (root: Element) {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'IFRAME', 'BUTTON', 'FORM', 'INPUT', 'SELECT', 'TEXTAREA', 'BROWSPARK-OVERLAY']);
  const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY']);
  const esc = (s: string) => s.replace(/\s+/g, ' ');
  const vis = (el: Element) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden'; };
  function walk(node: Node, ctx: { pre: boolean; depth: number; ol?: number }): string {
    if (node.nodeType === Node.TEXT_NODE) return ctx.pre ? node.textContent ?? '' : esc(node.textContent ?? '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement, t = el.tagName;
    if (SKIP.has(t) || el.getAttribute('aria-hidden') === 'true' || !vis(el)) return '';
    const kids = (c = ctx) => Array.from(el.childNodes).map((n) => walk(n, c)).join('');
    switch (t) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return `\n\n${'#'.repeat(Number(t[1]))} ${kids().trim()}\n\n`;
      case 'P': return `\n\n${kids().trim()}\n\n`;
      case 'BR': return '  \n';
      case 'HR': return '\n\n---\n\n';
      case 'STRONG': case 'B': { const s = kids().trim(); return s ? `**${s}**` : ''; }
      case 'EM': case 'I': { const s = kids().trim(); return s ? `*${s}*` : ''; }
      case 'CODE': return ctx.pre ? kids() : '`' + (el.textContent ?? '').replace(/`/g, '\\`') + '`';
      case 'PRE': { const lang = (el.querySelector('code')?.className.match(/language-([\w-]+)/) || [])[1] ?? ''; return `\n\n\`\`\`${lang}\n${(el.textContent ?? '').replace(/\n$/, '')}\n\`\`\`\n\n`; }
      case 'A': { const href = el.getAttribute('href'); const s = kids().trim(); if (!s) return ''; return href && !href.startsWith('#') && !href.startsWith('javascript:') ? `[${s}](${(el as HTMLAnchorElement).href})` : s; }
      case 'IMG': { const alt = el.getAttribute('alt') ?? ''; return alt ? `![${alt}](${(el as HTMLImageElement).src})` : ''; }
      case 'UL': case 'OL': return '\n\n' + Array.from(el.children).filter((c) => c.tagName === 'LI').map((li, i) => `${'  '.repeat(ctx.depth)}${t === 'OL' ? `${i + 1}.` : '-'} ${walk(li, { ...ctx, depth: ctx.depth + 1 }).trim().replace(/\n\n+/g, '\n' + '  '.repeat(ctx.depth + 1))}`).join('\n') + '\n\n';
      case 'LI': return kids();
      case 'BLOCKQUOTE': return '\n\n' + kids().trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
      case 'TABLE': { const rows = Array.from(el.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => esc(c.textContent ?? '').trim().replace(/\|/g, '\\|'))); if (!rows.length) return ''; const w = Math.max(...rows.map((r) => r.length)); const line = (r: string[]) => '| ' + Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ') + ' |'; return `\n\n${line(rows[0])}\n${line(Array(w).fill('---'))}\n${rows.slice(1).map(line).join('\n')}\n\n`; }
      case 'DT': return `\n**${kids().trim()}**\n`;
      case 'DD': return `${kids().trim()}\n`;
      default: return BLOCK.has(t) ? `\n${kids()}\n` : kids();
    }
  }
  return walk(root, { pre: false, depth: 0 }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
});

/** Compact line diff: lines that disappeared (-) and appeared (+), in order. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n'), b = after.split('\n');
  const count = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m; };
  const ca = count(a), cb = count(b);
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (const l of a) { const n = (seen.get(l) ?? 0) + 1; seen.set(l, n); if (n > (cb.get(l) ?? 0)) out.push('- ' + l); }
  seen.clear();
  for (const l of b) { const n = (seen.get(l) ?? 0) + 1; seen.set(l, n); if (n > (ca.get(l) ?? 0)) out.push('+ ' + l); }
  return out.length ? out.join('\n') : '(no changes)';
}
