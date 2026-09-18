// DOM inspection through native page objects. IDs never survive a navigation.
type Cdp = (tabId: number, method: string, params?: any) => Promise<any>;
export class FirefoxDOM {
  private readonly cdp: Cdp;
  private nextId = 1;
  private nodes = new Map<number, { tabId: number; objectId: string }>();
  private searches = new Map<string, { tabId: number; nodes: number[] }>();
  constructor(cdp: Cdp) { this.cdp = cdp; }
  clear(tabId: number) {
    for (const [id, node] of this.nodes) if (node.tabId === tabId) this.nodes.delete(id);
    for (const [id, search] of this.searches) if (search.tabId === tabId) this.searches.delete(id);
  }
  private register(tabId: number, objectId: string): number {
    if (!objectId) throw new Error('DOM node was not found; run browser_snapshot again');
    for (const [id, node] of this.nodes) if (node.tabId === tabId && node.objectId === objectId) return id;
    const id = this.nextId++; this.nodes.set(id, { tabId, objectId }); return id;
  }
  private object(tabId: number, nodeId: number): string {
    const node = this.nodes.get(nodeId);
    if (!node || node.tabId !== tabId) throw new Error('Unknown or stale nodeId; run browser_snapshot again');
    return node.objectId;
  }
  private async call(tabId: number, objectId: string, body: string, args: unknown[] = [], byValue = true) {
    const r = await this.cdp(tabId, 'Runtime.callFunctionOn', { objectId, functionDeclaration: `function(...args) { if (!this.isConnected) throw new Error('Stale DOM node; run browser_snapshot again'); ${body} }`, arguments: args.map(value => ({ value })), returnByValue: byValue });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result;
  }
  private async arrayNodes(tabId: number, result: any): Promise<number[]> {
    if (!result?.objectId) return [];
    try {
      const props = await this.cdp(tabId, 'Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
      return props.result.filter((p: any) => /^\d+$/.test(p.name) && p.value?.subtype === 'node').map((p: any) => this.register(tabId, p.value.objectId));
    } finally { await this.cdp(tabId, 'Runtime.releaseObject', { objectId: result.objectId }); }
  }
  private async describe(tabId: number, nodeId: number, depth: number): Promise<any> {
    const objectId = this.object(tabId, nodeId);
    const r = await this.call(tabId, objectId, `return { nodeType: this.nodeType, nodeName: this.nodeName, localName: this.localName || '', nodeValue: this.nodeValue || '', childNodeCount: this.childNodes.length, attributes: Array.from(this.attributes || []).flatMap(a => [a.name, a.value]) };`);
    const node = { nodeId, backendNodeId: nodeId, ...r.value };
    if (depth > 0) {
      const ids = await this.arrayNodes(tabId, await this.call(tabId, objectId, 'return Array.from(this.childNodes);', [], false));
      node.children = await Promise.all(ids.map(id => this.describe(tabId, id, depth - 1)));
    }
    return node;
  }
  async handle(tabId: number, method: string, p: any = {}): Promise<any> {
    switch (method) {
      case 'DOM.enable': case 'DOM.disable': return {};
      case 'DOM.getDocument': {
        if ((p.depth ?? 1) < 0) throw new Error('Unbounded DOM tree inspection is unsupported in Firefox; provide a finite depth.');
        const r = await this.cdp(tabId, 'Runtime.evaluate', { expression: 'document', returnByValue: false });
        const id = this.register(tabId, r.result?.objectId); return { root: await this.describe(tabId, id, p.depth ?? 1) };
      }
      case 'DOM.requestNode': return { nodeId: this.register(tabId, p.objectId) };
      case 'DOM.resolveNode': return { object: { type: 'object', subtype: 'node', objectId: this.object(tabId, p.nodeId ?? p.backendNodeId) } };
      case 'DOM.describeNode': {
        if ((p.depth ?? 0) < 0) throw new Error('Unbounded DOM tree inspection is unsupported in Firefox; provide a finite depth.');
        return { node: await this.describe(tabId, p.nodeId ?? p.backendNodeId ?? this.register(tabId, p.objectId), p.depth ?? 0) };
      }
      case 'DOM.querySelector': {
        const result = await this.call(tabId, this.object(tabId, p.nodeId), 'return this.querySelector(args[0]);', [p.selector], false);
        return { nodeId: result.subtype === 'null' ? 0 : this.register(tabId, result.objectId) };
      }
      case 'DOM.performSearch': {
        const r = await this.cdp(tabId, 'Runtime.evaluate', { expression: `(function(q) { try { const nodes = Array.from(document.querySelectorAll(q)); if (nodes.length) return nodes; } catch {} try { const found = document.evaluate(q, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); if (found.snapshotLength) return Array.from({length: found.snapshotLength}, (_, i) => found.snapshotItem(i)); } catch {} return Array.from(document.querySelectorAll('*')).filter(el => Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.includes(q))); })(${JSON.stringify(p.query)})`, returnByValue: false });
        const nodes = await this.arrayNodes(tabId, r.result), searchId = String(this.nextId++);
        this.searches.set(searchId, { tabId, nodes }); return { searchId, resultCount: nodes.length };
      }
      case 'DOM.getSearchResults': {
        const s = this.searches.get(p.searchId); if (!s || s.tabId !== tabId) throw new Error('Unknown or stale DOM search');
        return { nodeIds: s.nodes.slice(p.fromIndex, p.toIndex) };
      }
      case 'DOM.discardSearchResults': {
        if (this.searches.get(p.searchId)?.tabId === tabId) this.searches.delete(p.searchId); return {};
      }
      case 'DOM.getOuterHTML': return { outerHTML: (await this.call(tabId, this.object(tabId, p.nodeId), 'return this.outerHTML;')).value };
      case 'DOM.setOuterHTML': await this.call(tabId, this.object(tabId, p.nodeId), 'this.outerHTML = args[0];', [p.outerHTML]); return {};
      case 'DOM.getAttributes': return { attributes: (await this.call(tabId, this.object(tabId, p.nodeId), 'return Array.from(this.attributes).flatMap(a => [a.name, a.value]);')).value };
      case 'DOM.setAttributeValue': await this.call(tabId, this.object(tabId, p.nodeId), 'this.setAttribute(args[0], args[1]);', [p.name, p.value]); return {};
      case 'DOM.removeAttribute': await this.call(tabId, this.object(tabId, p.nodeId), 'this.removeAttribute(args[0]);', [p.name]); return {};
      case 'CSS.getComputedStyleForNode': return { computedStyle: (await this.call(tabId, this.object(tabId, p.nodeId), 'const s = this.ownerDocument.defaultView.getComputedStyle(this); return Array.from(s).map(name => ({name, value: s.getPropertyValue(name)}));')).value };
      default: throw new Error(`${method} is unsupported in Firefox. See the Firefox support guide for available operations.`);
    }
  }
}
