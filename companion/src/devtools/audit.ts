// devtools_audit: instant 360-degree page health, responsive layout, accessibility, and quality diagnostic.
import { z } from 'zod';
import { type Ctx, tool, tabArg } from '../context.ts';
import { saveArtifact } from '../artifacts.ts';

const AUDIT_SCRIPT = String(function auditPage(this: unknown) {
  const S = (window as any).__bmcp || ((window as any).__bmcp = { els: [], idx: new WeakMap() });
  if (!S.idx) S.idx = new WeakMap();
  const getRef = (el: Element): string => {
    let i = S.idx.get(el);
    if (i === undefined) { i = S.els.push(el) - 1; S.idx.set(el, i); }
    return 'e' + i;
  };

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const view = el.ownerDocument.defaultView || window;
    const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null;
    if (!style) return true;
    const opacity = Number(style.opacity);
    return style.display !== 'none' && style.visibility !== 'hidden' && (isNaN(opacity) || opacity > 0);
  };

  const out: {
    layout: Array<{ rule: string; ref?: string; detail: string; severity: 'error' | 'warning' }>;
    accessibility: Array<{ rule: string; ref?: string; detail: string; severity: 'error' | 'warning' }>;
    seo: Array<{ rule: string; ref?: string; detail: string; severity: 'error' | 'warning' }>;
    performance: {
      fcp?: number;
      ttfb?: number;
      domNodes: number;
      domDepth: number;
      issues: Array<{ rule: string; detail: string; severity: 'error' | 'warning' }>;
    };
    security: Array<{ rule: string; ref?: string; detail: string; severity: 'error' | 'warning' }>;
    brokenAssets: Array<{ type: string; url: string; ref?: string; detail: string }>;
  } = {
    layout: [],
    accessibility: [],
    seo: [],
    performance: { domNodes: 0, domDepth: 0, issues: [] },
    security: [],
    brokenAssets: []
  };

  // --- LAYOUT & RESPONSIVENESS ---
  const docElem = document.documentElement;
  const viewportWidth = window.innerWidth || docElem.clientWidth;
  if (docElem.scrollWidth > viewportWidth + 2) {
    const allEls = document.querySelectorAll('*');
    let culpritFound = false;
    for (let j = 0; j < allEls.length; j++) {
      const el = allEls[j];
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right > viewportWidth + 3) {
        out.layout.push({
          rule: 'horizontal-overflow',
          ref: getRef(el),
          detail: `Element overflows viewport: right edge is ${Math.round(rect.right)}px (viewport: ${viewportWidth}px, overflow: +${Math.round(rect.right - viewportWidth)}px)`,
          severity: 'error'
        });
        culpritFound = true;
        if (out.layout.length >= 5) break;
      }
    }
    if (!culpritFound) {
      out.layout.push({
        rule: 'horizontal-overflow',
        detail: `Document has horizontal scrollbar: scrollWidth (${docElem.scrollWidth}px) exceeds clientWidth (${viewportWidth}px)`,
        severity: 'error'
      });
    }
  }

  // Clickable target minimum sizing (< 24x24px)
  const clickables = document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button]');
  for (let j = 0; j < clickables.length; j++) {
    const el = clickables[j];
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 24) {
      out.layout.push({
        rule: 'small-touch-target',
        ref: getRef(el),
        detail: `Interactive target is ${Math.round(rect.width)}x${Math.round(rect.height)}px (smaller than recommended 24x24px minimum)`,
        severity: 'warning'
      });
      if (out.layout.filter(l => l.rule === 'small-touch-target').length >= 5) break;
    }
  }

  // Broken images (capped at 5)
  const imgs = document.querySelectorAll('img');
  for (let j = 0; j < imgs.length; j++) {
    const img = imgs[j];
    const src = img.getAttribute('src') || '';
    if (!src) {
      out.brokenAssets.push({ type: 'image', url: '', ref: getRef(img), detail: 'Image missing src attribute' });
      if (out.brokenAssets.length >= 5) break;
    } else if (img.complete && img.naturalWidth === 0) {
      out.brokenAssets.push({ type: 'image', url: src, ref: getRef(img), detail: `Image failed to load: ${src.slice(0, 80)}` });
      if (out.brokenAssets.length >= 5) break;
    }
  }

  // --- ACCESSIBILITY (WCAG 2.1 AA) ---
  for (let j = 0; j < imgs.length; j++) {
    const img = imgs[j];
    if (isVisible(img) && !img.hasAttribute('alt')) {
      out.accessibility.push({
        rule: 'image-alt',
        ref: getRef(img),
        detail: `Missing alt attribute on <img src="${(img.getAttribute('src') || '').slice(0, 60)}">`,
        severity: 'warning'
      });
      if (out.accessibility.filter(a => a.rule === 'image-alt').length >= 5) break;
    }
  }

  for (let j = 0; j < clickables.length; j++) {
    const el = clickables[j];
    if (!isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
      const text = (el.textContent || '').trim();
      const ariaLabel = el.getAttribute('aria-label');
      const ariaLabelledBy = el.getAttribute('aria-labelledby');
      const title = el.getAttribute('title');
      const hasImgAlt = !!el.querySelector('img[alt]:not([alt=""])');
      const hasSvgTitle = !!el.querySelector('svg title');
      if (!text && !ariaLabel && !ariaLabelledBy && !title && !hasImgAlt && !hasSvgTitle) {
        out.accessibility.push({
          rule: tag === 'a' ? 'link-name' : 'button-name',
          ref: getRef(el),
          detail: `<${tag}> element has no accessible name (empty text and no aria-label/title)`,
          severity: 'error'
        });
        if (out.accessibility.filter(a => a.rule === 'button-name' || a.rule === 'link-name').length >= 5) break;
      }
    }
  }

  const formInputs = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea');
  for (let j = 0; j < formInputs.length; j++) {
    const input = formInputs[j] as HTMLElement;
    if (!isVisible(input)) continue;
    const id = input.id;
    const hasLabelFor = id && !!document.querySelector(`label[for="${CSS.escape(id)}"]`);
    const hasParentLabel = !!input.closest('label');
    const hasAria = !!input.getAttribute('aria-label') || !!input.getAttribute('aria-labelledby');
    const placeholder = input.getAttribute('placeholder');
    if (!hasLabelFor && !hasParentLabel && !hasAria) {
      out.accessibility.push({
        rule: 'form-label',
        ref: getRef(input),
        detail: `Form control <${input.tagName.toLowerCase()}${input.getAttribute('type') ? ' type=' + input.getAttribute('type') : ''}> has no associated <label>${placeholder ? ` (placeholder="${placeholder}" is not an accessible label substitute)` : ''}`,
        severity: 'error'
      });
      if (out.accessibility.filter(a => a.rule === 'form-label').length >= 5) break;
    }
  }

  // Duplicate IDs (capped at 5)
  const idCounts: Record<string, number> = {};
  const allIds = document.querySelectorAll('[id]');
  for (let j = 0; j < allIds.length; j++) {
    const id = allIds[j].id;
    if (id) idCounts[id] = (idCounts[id] || 0) + 1;
  }
  let dupFound = 0;
  for (const [id, count] of Object.entries(idCounts)) {
    if (count > 1) {
      dupFound++;
      if (dupFound <= 5) {
        out.accessibility.push({
          rule: 'duplicate-id',
          detail: `Duplicate ID #${id} found ${count} times in DOM`,
          severity: 'error'
        });
      }
    }
  }
  if (dupFound > 5) {
    out.accessibility.push({
      rule: 'duplicate-id',
      detail: `...and ${dupFound - 5} more duplicate IDs (total ${dupFound})`,
      severity: 'error'
    });
  }

  // --- SEO & DOCUMENT SEMANTICS ---
  const docTitle = document.title ? document.title.trim() : '';
  if (!docTitle) {
    out.seo.push({ rule: 'missing-title', detail: 'Document is missing a <title> or title is empty', severity: 'error' });
  } else if (docTitle.length < 10) {
    out.seo.push({ rule: 'short-title', detail: `Document title "${docTitle}" is very short (<10 characters)`, severity: 'warning' });
  }

  const h1s = document.querySelectorAll('h1');
  if (h1s.length === 0) {
    out.seo.push({ rule: 'missing-h1', detail: 'Page has no <h1> heading', severity: 'warning' });
  } else if (h1s.length > 1) {
    out.seo.push({ rule: 'multiple-h1', detail: `Page has ${h1s.length} <h1> headings (recommended: exactly 1 per page)`, severity: 'warning' });
  }

  if (!document.documentElement.getAttribute('lang')) {
    out.seo.push({ rule: 'missing-lang', detail: '<html lang="..."> attribute is missing', severity: 'error' });
  }

  const viewportMeta = document.querySelector('meta[name="viewport"]');
  if (!viewportMeta || !viewportMeta.getAttribute('content')) {
    out.seo.push({ rule: 'missing-viewport-meta', detail: '<meta name="viewport"> is missing or has no content', severity: 'error' });
  }

  // --- PERFORMANCE & DOM METRICS ---
  const domNodes = document.getElementsByTagName('*').length;
  out.performance.domNodes = domNodes;
  if (domNodes > 1500) {
    out.performance.issues.push({
      rule: 'excessive-dom-size',
      detail: `Large DOM: ${domNodes} elements (recommended < 1,400)`,
      severity: domNodes > 3000 ? 'error' : 'warning'
    });
  }

  // Iterative DOM depth to prevent stack overflow on deep DOMs
  let maxDepth = 1;
  const stack: Array<{ el: Element; depth: number }> = [{ el: document.documentElement, depth: 1 }];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (curr.depth > maxDepth) maxDepth = curr.depth;
    const children = curr.el.children;
    for (let k = 0; k < children.length; k++) {
      stack.push({ el: children[k], depth: curr.depth + 1 });
    }
  }
  out.performance.domDepth = maxDepth;
  if (maxDepth > 32) {
    out.performance.issues.push({
      rule: 'deep-dom-tree',
      detail: `Deep DOM tree: maximum depth is ${maxDepth} (recommended <= 32)`,
      severity: 'warning'
    });
  }

  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) out.performance.ttfb = Math.round(nav.responseStart - nav.requestStart);
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    if (fcp) out.performance.fcp = Math.round(fcp.startTime);
  } catch {}

  // --- SECURITY ---
  const isHttps = location.protocol === 'https:';
  if (isHttps) {
    const mixed = document.querySelectorAll('img[src^="http://"], script[src^="http://"], link[href^="http://"], iframe[src^="http://"]');
    for (let j = 0; j < mixed.length; j++) {
      const m = mixed[j];
      const src = m.getAttribute('src') || m.getAttribute('href') || '';
      out.security.push({
        rule: 'mixed-content',
        ref: getRef(m),
        detail: `Insecure HTTP resource loaded over HTTPS: ${src.slice(0, 100)}`,
        severity: 'error'
      });
      if (out.security.length >= 5) break;
    }
  } else if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    const pwd = document.querySelector('input[type=password]');
    if (pwd) {
      out.security.push({
        rule: 'insecure-password-field',
        ref: getRef(pwd),
        detail: 'Password input rendered on non-HTTPS origin',
        severity: 'error'
      });
    }
  }

  return out;
});

export function registerAuditTools(ctx: Ctx) {
  const { sessions, capture, page } = ctx;
  const tab = (id?: number) => sessions.resolve(id);

  tool(ctx, 'devtools_audit', 'Instant 360-degree page health check: evaluates console runtime errors, failed network requests, horizontal layout overflow (scrollbars), broken images, WCAG 2.1 AA accessibility (unlabelled buttons/inputs, duplicate IDs), Core Web Vitals, and SEO. In-page DOM audits work across Chromium and Firefox in both modes; console and network capture require active DevTools capture sessions. Returns a health score (0-100), letter grade, and actionable element refs [ref=e12].', {
    tabId: tabArg,
    categories: z.array(z.enum(['errors', 'network', 'layout', 'accessibility', 'performance', 'security', 'seo'])).optional().describe('Categories to audit (default: all)'),
    threshold: z.enum(['all', 'warnings', 'errors']).optional().default('all').describe('Filter findings: "all" (all items), "warnings" (warnings and errors), or "errors" (errors only)'),
    summaryOnly: z.boolean().optional().describe('Return scores and counts without individual item details'),
    saveReport: z.boolean().optional().default(true).describe('Save diagnostic report artifact (default: true)'),
  }, async ({ tabId, categories, threshold = 'all', summaryOnly, saveReport = true }) => {
    const id = await tab(tabId);
    const pageUrl = await page.evaluate<string>(id, 'location.href').catch(() => 'unknown');
    const pageTitle = await page.evaluate<string>(id, 'document.title').catch(() => 'untitled');

    // 1. Run in-page scanner
    const inPage = await page.evaluate<any>(id, `(${AUDIT_SCRIPT})()`);

    // 2. Scan Capture ring buffers if DevTools session is active
    const st = capture.get(id);
    const consoleErrors: Array<{ type: string; message: string; severity: 'error' }> = [];
    const failedRequests: Array<{ url: string; status?: number; error?: string; severity: 'error' | 'warning' }> = [];

    if (st) {
      // Collect console errors & exceptions
      for (const log of st.console) {
        if (log.level === 'error' || log.kind === 'exception') {
          consoleErrors.push({
            type: log.kind,
            message: log.text || (log.args ?? []).join(' '),
            severity: 'error'
          });
        }
      }

      // Collect failed network requests
      for (const net of st.network) {
        if (net.status && net.status >= 400) {
          failedRequests.push({
            url: net.url,
            status: net.status,
            severity: net.status >= 500 ? 'error' : 'warning'
          });
        } else if (net.blockedReason) {
          failedRequests.push({
            url: net.url,
            error: `Blocked (${net.blockedReason})`,
            severity: 'error'
          });
        }
      }
    }

    // 3. Assemble findings list across categories
    interface Finding {
      category: 'errors' | 'network' | 'layout' | 'accessibility' | 'performance' | 'security' | 'seo';
      rule: string;
      severity: 'error' | 'warning';
      ref?: string;
      detail: string;
    }

    const allFindings: Finding[] = [];

    // Console Errors
    for (const ce of consoleErrors) {
      allFindings.push({ category: 'errors', rule: ce.type, severity: 'error', detail: ce.message.slice(0, 180) });
    }

    // Network & Broken Assets
    for (const fr of failedRequests) {
      allFindings.push({
        category: 'network',
        rule: fr.status ? `http-${fr.status}` : 'request-blocked',
        severity: fr.severity,
        detail: `${fr.status ? `HTTP ${fr.status}` : fr.error}: ${fr.url.slice(0, 120)}`
      });
    }
    for (const ba of inPage.brokenAssets ?? []) {
      allFindings.push({
        category: 'network',
        rule: 'broken-asset',
        severity: 'error',
        ref: ba.ref,
        detail: ba.detail
      });
    }

    // Layout
    for (const l of inPage.layout ?? []) {
      allFindings.push({ category: 'layout', rule: l.rule, severity: l.severity, ref: l.ref, detail: l.detail });
    }

    // Accessibility
    for (const a of inPage.accessibility ?? []) {
      allFindings.push({ category: 'accessibility', rule: a.rule, severity: a.severity, ref: a.ref, detail: a.detail });
    }

    // Performance
    for (const p of inPage.performance?.issues ?? []) {
      allFindings.push({ category: 'performance', rule: p.rule, severity: p.severity, detail: p.detail });
    }

    // SEO
    for (const s of inPage.seo ?? []) {
      allFindings.push({ category: 'seo', rule: s.rule, severity: s.severity, detail: s.detail });
    }

    // Security
    for (const sec of inPage.security ?? []) {
      allFindings.push({ category: 'security', rule: sec.rule, severity: sec.severity, ref: sec.ref, detail: sec.detail });
    }

    // 4. Calculate Scores
    let score = 100;
    const errorCount = allFindings.filter(f => f.severity === 'error').length;
    const warningCount = allFindings.filter(f => f.severity === 'warning').length;

    // Deductions
    for (const f of allFindings) {
      if (f.category === 'errors') score -= 15;
      else if (f.rule === 'horizontal-overflow') score -= 15;
      else if (f.severity === 'error') score -= 8;
      else if (f.severity === 'warning') score -= 3;
    }
    score = Math.max(0, Math.min(100, score));

    const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
    const status = score >= 90 ? 'pass' : score >= 70 ? 'warn' : 'fail';

    // 5. Category breakdown
    const selectedCategories = new Set(categories ?? ['errors', 'network', 'layout', 'accessibility', 'performance', 'security', 'seo']);
    const categorySummary: Record<string, { errors: number; warnings: number }> = {};
    for (const cat of ['errors', 'network', 'layout', 'accessibility', 'performance', 'security', 'seo']) {
      categorySummary[cat] = {
        errors: allFindings.filter(f => f.category === cat && f.severity === 'error').length,
        warnings: allFindings.filter(f => f.category === cat && f.severity === 'warning').length,
      };
    }

    // 6. Filter findings: threshold 'warnings' keeps both errors and warnings; 'errors' keeps only errors
    const filteredFindings = allFindings.filter(f => {
      if (!selectedCategories.has(f.category)) return false;
      if (threshold === 'errors' && f.severity !== 'error') return false;
      if (threshold === 'warnings' && f.severity !== 'error' && f.severity !== 'warning') return false;
      return true;
    });

    const report = {
      url: pageUrl,
      title: pageTitle,
      score,
      grade,
      status,
      summary: `${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'} across audited categories`,
      categories: categorySummary,
      metrics: {
        fcpMs: inPage.performance?.fcp ?? null,
        ttfbMs: inPage.performance?.ttfb ?? null,
        domNodes: inPage.performance?.domNodes ?? 0,
        domDepth: inPage.performance?.domDepth ?? 0,
        captureSessionActive: !!st,
      },
      ...(!summaryOnly && { findings: filteredFindings }),
      note: !st ? 'DevTools capture session is inactive; start devtools_session for real-time console and network interception.' : undefined,
    };

    if (saveReport) {
      const art = saveArtifact('audit', 'json', JSON.stringify(report, null, 2), pageTitle.slice(0, 30));
      return { ...report, reportArtifact: art.path };
    }

    return report;
  });
}
