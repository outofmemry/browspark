import { FirefoxDOM } from '../../../companion/src/firefox-dom.ts';

type Target = { tabId: number; sessionId?: string };
type Attachment = { key: string; contextId: number; worlds: Map<number, string> };

/** Runs entirely in Firefox's USER_SCRIPT sandbox, which has no extension APIs or messaging. */
async function sandboxCommand(key: string, documentKey: string, method: string, p: any): Promise<string> {
  const scope = globalThis as any;
  if (scope.__browsparkDocumentKey !== documentKey) {
    delete (window as any).__bmcp;
    scope.__browsparkDocumentKey = documentKey;
  }
  if (scope.__browsparkRuntime?.key !== key) scope.__browsparkRuntime = { key, next: 1, objects: new Map<string, any>() };
  const state = scope.__browsparkRuntime;
  const object = (id: string) => {
    if (!state.objects.has(id)) throw new Error('Unknown or stale objectId; run browser_snapshot again');
    return state.objects.get(id);
  };
  const remote = (value: any, byValue = false): any => {
    const type = typeof value;
    if (value === null) return { type: 'object', subtype: 'null', value: null };
    if (type === 'undefined') return { type };
    if (type === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return { type, unserializableValue: Object.is(value, -0) ? '-0' : String(value) };
    if (type === 'bigint') return { type, unserializableValue: `${value}n` };
    if (type !== 'object' && type !== 'function' && type !== 'symbol') return { type, value };
    if (byValue) return { type, value: JSON.parse(JSON.stringify(value)) };
    let objectId: string | undefined;
    for (const [id, item] of state.objects) if (item === value) { objectId = id; break; }
    if (!objectId) { objectId = `${key}:${state.next++}`; state.objects.set(objectId, value); }
    return { type, objectId, ...(value instanceof Node ? { subtype: 'node', className: value.nodeName } : Array.isArray(value) ? { subtype: 'array' } : {}) };
  };
  const argument = (arg: any) => {
    if (arg.objectId) return object(arg.objectId);
    if (arg.unserializableValue !== undefined) {
      const v = arg.unserializableValue;
      if (/^-?\d+n$/.test(v)) return BigInt(v.slice(0, -1));
      if (v === 'NaN') return NaN;
      if (v === 'Infinity') return Infinity;
      if (v === '-Infinity') return -Infinity;
      if (v === '-0') return -0;
      throw new Error('Unsupported unserializable argument');
    }
    return arg.value;
  };
  const focused = (): any => {
    let el: any = document.activeElement;
    while (el?.shadowRoot?.activeElement || el?.contentDocument?.activeElement) el = el.shadowRoot?.activeElement ?? el.contentDocument.activeElement;
    return el;
  };
  const insert = (text: string) => {
    const el = focused(), doc = el?.ownerDocument, win = doc?.defaultView;
    if (!el || !win || el.disabled || el.readOnly) throw new Error('Focus an editable element before typing');
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (typeof el.selectionStart !== 'number') throw new Error('This input does not support text insertion; use browser_fill');
      el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
      el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: text ? 'insertText' : 'deleteContentForward', data: text }));
    } else if (el.isContentEditable) {
      const selection = doc.getSelection();
      if (!selection?.rangeCount) throw new Error('No selection in the editable element');
      const range = selection.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) throw new Error('Selection is outside the focused editable element');
      range.deleteContents(); const node = doc.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
      selection.removeAllRanges(); selection.addRange(range);
      el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else throw new Error('Focus an editable element before typing');
  };
  try {
    let result: any;
    switch (method) {
      case 'Runtime.evaluate': {
        let value = (0, eval)(p.expression);
        if (p.awaitPromise) value = await value;
        result = { result: remote(value, p.returnByValue) }; break;
      }
      case 'Runtime.callFunctionOn': {
        const fn = (0, eval)(`(${p.functionDeclaration})`);
        let value = fn.apply(p.objectId ? object(p.objectId) : undefined, (p.arguments ?? []).map(argument));
        if (p.awaitPromise) value = await value;
        result = { result: remote(value, p.returnByValue) }; break;
      }
      case 'Runtime.getProperties': {
        const properties: any[] = [], seen = new Set<string>();
        for (let current = object(p.objectId); current; current = p.ownProperties ? null : Object.getPrototypeOf(current)) {
          for (const name of Object.getOwnPropertyNames(current)) {
            if (seen.has(name)) continue; seen.add(name);
            const descriptor = Object.getOwnPropertyDescriptor(current, name)!;
            properties.push({ name, configurable: !!descriptor.configurable, enumerable: !!descriptor.enumerable, isOwn: current === object(p.objectId),
              ...('value' in descriptor ? { value: remote(descriptor.value), writable: !!descriptor.writable } : { get: remote(descriptor.get), set: remote(descriptor.set) }) });
          }
        }
        result = { result: properties }; break;
      }
      case 'Runtime.releaseObject': state.objects.delete(p.objectId); result = {}; break;
      case 'Input.insertText': insert(p.text); result = {}; break;
      case 'Input.dispatchMouseEvent': {
        let doc = document, x = p.x, y = p.y, el: any = doc.elementFromPoint(x, y);
        while (el) {
          const shadow = el.shadowRoot?.elementFromPoint(x, y);
          if (shadow && shadow !== el) { el = shadow; continue; }
          if (el.tagName !== 'IFRAME' || !el.contentDocument) break;
          const bounds = el.getBoundingClientRect(); x -= bounds.left; y -= bounds.top; doc = el.contentDocument; el = doc.elementFromPoint(x, y);
        }
        if (!el) throw new Error('No element at the requested coordinates');
        const win = doc.defaultView!;
        const options = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
          buttons: p.type === 'mousePressed' ? 1 : 0, detail: p.clickCount ?? 0 };
        const name = p.type === 'mouseMoved' ? 'mousemove' : p.type === 'mousePressed' ? 'mousedown' : 'mouseup';
        el.dispatchEvent(new win.PointerEvent(name.replace('mouse', 'pointer'), { ...options, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        const allowed = el.dispatchEvent(new win.MouseEvent(name, options));
        if (p.type === 'mousePressed' && allowed) el.focus?.();
        if (p.type === 'mouseReleased') el.dispatchEvent(new win.MouseEvent('click', options));
        result = {}; break;
      }
      case 'Input.dispatchKeyEvent': {
        const el = focused(), doc = el?.ownerDocument ?? document, win = doc.defaultView, modifiers = p.modifiers ?? 0;
        if (p.commands?.some((command: string) => command !== 'SelectAll') || modifiers & 1 || modifiers & 6 && p.key.toLowerCase() !== 'a') throw new Error('Native keyboard shortcuts are unsupported in the Firefox extension');
        if (!['Enter', 'Tab', 'Escape', 'Backspace', 'Delete'].includes(p.key) && p.key.length !== 1) throw new Error(`Native ${p.key} key behavior is unsupported in the Firefox extension`);
        const allowed = el?.dispatchEvent(new win.KeyboardEvent(p.type === 'keyUp' ? 'keyup' : 'keydown', { bubbles: true, cancelable: true, key: p.key, code: p.code,
          ctrlKey: !!(modifiers & 2), metaKey: !!(modifiers & 4), shiftKey: !!(modifiers & 8) }));
        if (p.type !== 'keyUp' && allowed) {
          if (modifiers & 6 && p.key.toLowerCase() === 'a') {
            if (el.select) el.select(); else if (el.isContentEditable) doc.getSelection()?.selectAllChildren(el);
          } else if (p.key === 'Tab') {
            const candidates = Array.from(doc.querySelectorAll('a[href],button,input,textarea,select,[tabindex]')).filter((item: any) => !item.disabled && item.tabIndex >= 0 && item.getClientRects().length) as HTMLElement[];
            const index = candidates.indexOf(el), delta = modifiers & 8 ? -1 : 1;
            candidates[(index + delta + candidates.length) % candidates.length]?.focus();
          } else if (p.key === 'Enter') {
            if (el.tagName === 'TEXTAREA' || el.isContentEditable) insert('\n');
            else if (el.tagName === 'INPUT' && el.form) el.form.requestSubmit();
            else el.click?.();
          } else if (p.key === 'Backspace' || p.key === 'Delete') {
            if (typeof el.selectionStart === 'number') {
              if (el.selectionStart === el.selectionEnd) el.setSelectionRange(p.key === 'Backspace' ? Math.max(0, el.selectionStart - 1) : el.selectionStart, p.key === 'Delete' ? el.selectionEnd + 1 : el.selectionEnd);
              insert('');
            } else if (el.isContentEditable) insert('');
            else throw new Error('Focus an editable element before deleting text');
          } else if (p.text) insert(p.text);
        }
        result = {}; break;
      }
      default: throw new Error(`${method} is unsupported in the Firefox extension`);
    }
    return JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ exceptionDetails: { text: message, exception: { type: 'object', subtype: 'error', description: message } } });
  }
}

/** Native Firefox adapter. Every script runs in an API-free userscript world, never an extension content script. */
export function createFirefoxDebugger(api: any, isShared: (tabId: number) => boolean) {
  const attached = new Map<number, Attachment>();
  const documents = new Map<number, string>();
  const loading = new Set<number>();
  const eventListeners = new Set<(target: Target, method: string, params: any) => void>();
  const detachListeners = new Set<(target: Target, reason: string) => void>();
  const configured = new Map<string, Promise<void>>();
  let nextContext = 1;
  const unsupported = (method: string): never => { throw new Error(`${method} is unsupported in the Firefox extension. Use a developer browser for additional capabilities; see the Firefox support guide.`); };
  const guard = (tabId: number) => { if (!isShared(tabId)) throw new Error('Not allowed: tab is not shared'); };
  const event = (tabId: number, method: string, params: any) => { if (attached.has(tabId) && isShared(tabId)) for (const listener of eventListeners) listener({ tabId }, method, params); };
  const dom = new FirefoxDOM((tabId, method, params) => sendCommand({ tabId }, method, params));
  async function configure(worldId: string) {
    if (!api.userScripts?.execute) throw new Error('Firefox 153 or later and the userScripts permission are required. Enable Firefox tab access in the Browspark dashboard.');
    let pending = configured.get(worldId);
    if (!pending) {
      pending = Promise.resolve(api.userScripts.configureWorld({ worldId, messaging: false, csp: "script-src 'self' 'unsafe-eval'" }));
      configured.set(worldId, pending);
      pending.catch(() => configured.delete(worldId));
    }
    await pending;
  }
  async function execute(tabId: number, method: string, params: any) {
    guard(tabId);
    const attachment = attached.get(tabId);
    if (!attachment) throw new Error('Firefox tab is not attached');
    const objectContext = [...attachment.worlds.keys()].find(id => params.objectId?.startsWith(`${attachment.key}-${id}:`));
    const contextId = params.contextId ?? params.executionContextId ?? objectContext ?? attachment.contextId;
    const worldId = attachment.worlds.get(contextId);
    if (!worldId) throw new Error('Cannot find context; run browser_snapshot again');
    await configure(worldId); guard(tabId);
    if (attached.get(tabId) !== attachment) throw new Error('Firefox attachment changed before execution; run browser_snapshot again');
    const key = attachment.key, documentKey = documents.get(tabId)!;
    const results = await api.userScripts.execute({ target: { tabId, frameIds: [0] }, world: 'USER_SCRIPT', worldId, injectImmediately: true,
      js: [{ code: `(${sandboxCommand.toString()})(${JSON.stringify(`${key}-${contextId}`)},${JSON.stringify(documentKey)},${JSON.stringify(method)},${JSON.stringify(params)})` }] });
    guard(tabId);
    if (attached.get(tabId) !== attachment || attachment.key !== key || documents.get(tabId) !== documentKey) throw new Error('Firefox attachment changed during execution; run browser_snapshot again');
    const response = results.find((result: any) => result.frameId === 0);
    if (response?.error) throw new Error(`Firefox script failed: ${response.error}`);
    if (typeof response?.result !== 'string') throw new Error('Firefox script returned no result; the page may have navigated');
    const result = JSON.parse(response.result);
    if (!method.startsWith('Runtime.') && result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result;
  }
  async function sendCommand(target: Target, method: string, p: any = {}): Promise<any> {
    const tabId = target.tabId;
    guard(tabId);
    if (target.sessionId) unsupported('Child target sessions');
    const attachment = attached.get(tabId);
    if (!attachment) throw new Error('Firefox tab is not attached');
    if (method === 'Input.dispatchMouseEvent') {
      if (!['mouseMoved', 'mousePressed', 'mouseReleased'].includes(p.type)) unsupported(`Mouse event ${p.type}`);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('Mouse coordinates must be finite numbers');
      if (p.button !== undefined && p.button !== 'left' && !(p.type === 'mouseMoved' && p.button === 'none') || p.clickCount !== undefined && p.clickCount !== 1 || p.modifiers || p.buttons) unsupported('Modified clicks, repeated clicks, and native dragging');
    }
    if (method.startsWith('DOM.') || method === 'CSS.getComputedStyleForNode') return dom.handle(tabId, method, p);
    switch (method) {
      case 'Page.enable': case 'Page.disable': case 'Runtime.disable': return {};
      case 'Runtime.enable': {
        const tab = await api.tabs.get(tabId); guard(tabId);
        event(tabId, 'Runtime.executionContextCreated', { context: { id: attachment.contextId, origin: tab.url ?? '', name: 'browspark', auxData: { frameId: String(tabId), isDefault: true, type: 'isolated' } } });
        return {};
      }
      case 'Runtime.evaluate': case 'Runtime.callFunctionOn': case 'Runtime.getProperties': case 'Runtime.releaseObject':
      case 'Input.insertText': case 'Input.dispatchKeyEvent': case 'Input.dispatchMouseEvent': return execute(tabId, method, p);
      case 'Page.navigate': {
        const url = new URL(p.url);
        if (!['http:', 'https:', 'about:'].includes(url.protocol) || url.protocol === 'about:' && p.url !== 'about:blank') throw new Error('Not allowed: unsupported navigation URL');
        await api.tabs.update(tabId, { url: p.url }); return { frameId: String(tabId) };
      }
      case 'Page.reload': await api.tabs.reload(tabId, { bypassCache: !!p.ignoreCache }); return {};
      case 'Page.traverseHistory': {
        if (p.delta !== -1 && p.delta !== 1) unsupported('Arbitrary history traversal');
        await (p.delta === -1 ? api.tabs.goBack(tabId) : api.tabs.goForward(tabId)); return {};
      }
      case 'Page.bringToFront': { const tab = await api.tabs.update(tabId, { active: true }); guard(tabId); await api.windows.update(tab.windowId, { focused: true }); return {}; }
      case 'Page.getFrameTree': { const tab = await api.tabs.get(tabId); return { frameTree: { frame: { id: String(tabId), url: tab.url ?? '' } } }; }
      case 'Page.createIsolatedWorld': {
        if (p.frameId !== String(tabId)) unsupported('Cross-frame isolated worlds');
        const contextId = nextContext++, worldId = `browspark-${contextId}`;
        await configure(worldId); guard(tabId); attachment.worlds.set(contextId, worldId);
        event(tabId, 'Runtime.executionContextCreated', { context: { id: contextId, name: p.worldName ?? '', auxData: { frameId: String(tabId), isDefault: false, name: p.worldName ?? '', type: 'isolated' } } });
        return { executionContextId: contextId };
      }
      case 'Page.getLayoutMetrics': {
        const r = await execute(tabId, 'Runtime.evaluate', { expression: '({x:0,y:0,width:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0),height:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)})', returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return { cssContentSize: r.result.value, contentSize: r.result.value };
      }
      case 'Page.captureScreenshot': {
        const dataUrl = await api.tabs.captureTab(tabId, { format: p.format ?? 'png', ...(p.quality !== undefined && { quality: p.quality }),
          ...(p.clip && { rect: { x: p.clip.x, y: p.clip.y, width: p.clip.width, height: p.clip.height }, scale: p.clip.scale ?? 1 }) });
        guard(tabId);
        if (attached.get(tabId) !== attachment) throw new Error('Firefox attachment changed during screenshot capture; retry the screenshot');
        return { data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
      }
      default: return unsupported(method);
    }
  }
  api.tabs.onUpdated.addListener((tabId: number, change: any) => {
    // The same userscript realm can return from BFCache; clear refs even when navigation happened while detached.
    if (documents.has(tabId) && change.status === 'loading') documents.set(tabId, crypto.randomUUID());
    if (!attached.has(tabId) || !isShared(tabId)) return;
    if (change.status === 'loading') { loading.add(tabId); attached.get(tabId)!.key = `browspark-${crypto.randomUUID()}`; dom.clear(tabId); event(tabId, 'Runtime.executionContextsCleared', {}); }
    if (change.url) event(tabId, 'Page.frameNavigated', { frame: { id: String(tabId), url: change.url } });
    if (change.status === 'complete') { loading.delete(tabId); event(tabId, 'Page.loadEventFired', { timestamp: Date.now() / 1000 }); }
    else if (change.url && !change.status && !loading.has(tabId)) event(tabId, 'Page.navigatedWithinDocument', { frameId: String(tabId), url: change.url });
  });
  api.tabs.onRemoved.addListener((tabId: number) => {
    documents.delete(tabId);
    if (!attached.delete(tabId)) return; loading.delete(tabId); dom.clear(tabId);
    for (const listener of detachListeners) listener({ tabId }, 'target_closed');
  });
  return {
    async attach(target: Target, _version?: string) {
      guard(target.tabId); await api.tabs.get(target.tabId); await configure('browspark'); guard(target.tabId);
      if (!documents.has(target.tabId)) documents.set(target.tabId, crypto.randomUUID());
      if (!attached.has(target.tabId)) { const contextId = nextContext++; attached.set(target.tabId, { key: `browspark-${crypto.randomUUID()}`, contextId, worlds: new Map([[contextId, 'browspark']]) }); }
    },
    // Like chrome.debugger, explicit detach does not dispatch onDetach; the caller owns that notification.
    async detach(target: Target) { if (attached.delete(target.tabId)) { loading.delete(target.tabId); dom.clear(target.tabId); } },
    sendCommand,
    onEvent: { addListener: (listener: (target: Target, method: string, params: any) => void) => eventListeners.add(listener) },
    onDetach: { addListener: (listener: (target: Target, reason: string) => void) => detachListeners.add(listener) },
  };
}
