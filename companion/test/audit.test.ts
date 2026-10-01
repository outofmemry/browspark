import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { registerAuditTools } from '../src/devtools/audit.ts';

function createMockHarness(options: {
  consoleLogs?: any[];
  networkRequests?: any[];
  inPageResult?: any;
  hasCaptureSession?: boolean;
} = {}) {
  const mockTabId = 101;
  const {
    consoleLogs = [
      { kind: 'exception', level: 'error', text: 'Uncaught TypeError: Cannot read properties of undefined', args: [] },
      { kind: 'console', level: 'info', text: 'App initialized', args: [] },
    ],
    networkRequests = [
      { url: 'https://example.com/api/broken', status: 500 },
      { url: 'https://example.com/api/ok', status: 200 },
      { url: 'https://tracker.test/pixel.gif', blockedReason: 'inspector' },
    ],
    inPageResult = {
      layout: [
        { rule: 'horizontal-overflow', ref: 'e1', detail: 'Element overflows viewport: right edge is 1450px', severity: 'error' },
        { rule: 'small-touch-target', ref: 'e2', detail: 'Interactive target is 16x16px', severity: 'warning' },
      ],
      accessibility: [
        { rule: 'button-name', ref: 'e3', detail: '<button> element has no accessible name', severity: 'error' },
        { rule: 'image-alt', ref: 'e4', detail: 'Missing alt attribute on <img src="/logo.png">', severity: 'warning' },
        { rule: 'duplicate-id', detail: 'Duplicate ID #user-id found 2 times in DOM', severity: 'error' },
      ],
      seo: [
        { rule: 'missing-viewport-meta', detail: '<meta name="viewport"> is missing or has no content', severity: 'error' },
      ],
      performance: {
        fcp: 420,
        ttfb: 65,
        domNodes: 450,
        domDepth: 12,
        issues: [],
      },
      security: [],
      brokenAssets: [
        { type: 'image', url: 'https://example.com/missing.png', ref: 'e5', detail: 'Image failed to load: https://example.com/missing.png' },
      ],
    },
    hasCaptureSession = true,
  } = options;

  const mockCapture = {
    get: (id: number) => {
      if (id !== mockTabId || !hasCaptureSession) return undefined;
      return { console: consoleLogs, network: networkRequests };
    },
  };

  const mockPage = {
    evaluate: async (_id: number, script: string) => {
      if (script === 'location.href') return 'https://example.com/checkout';
      if (script === 'document.title') return 'Checkout';
      return inPageResult;
    },
  };

  const mockSessions = {
    resolve: async (id?: number) => id ?? mockTabId,
  };

  const fakeCtx: any = {
    sessions: mockSessions,
    capture: mockCapture,
    page: mockPage,
    client: { id: 'test-client', name: 'test', ownedTabs: new Set([mockTabId]) },
    registry: new Map(),
    server: {
      registerTool: () => {},
    },
  };

  registerAuditTools(fakeCtx);
  const auditFn = fakeCtx.registry.get('devtools_audit');
  assert.ok(auditFn, 'devtools_audit should be registered in ctx.registry');

  const runAudit = async (args: any = {}) => {
    const res = await auditFn({ tabId: mockTabId, ...args });
    assert.ok(res && res.content && res.content[0], 'Tool should return MCP Result');
    return JSON.parse(res.content[0].text);
  };

  return { runAudit, mockTabId };
}

test('devtools_audit registers and audits page with simulated issues and captures', async () => {
  const { runAudit, mockTabId } = createMockHarness();

  const fullReport = await runAudit({ tabId: mockTabId, saveReport: false });
  assert.equal(fullReport.url, 'https://example.com/checkout');
  assert.equal(fullReport.title, 'Checkout');
  assert.equal(fullReport.status, 'fail');
  assert.ok(fullReport.score < 70, `Score should be docked for errors, got ${fullReport.score}`);
  assert.ok(fullReport.findings.length > 5, 'Should collect multiple findings across categories');
  assert.ok(fullReport.metrics.fcpMs === 420, 'FCP metric preserved');
  assert.equal(fullReport.metrics.captureSessionActive, true, 'Capture session active recognized');

  // Verify finding refs
  const buttonIssue = fullReport.findings.find((f: any) => f.rule === 'button-name');
  assert.ok(buttonIssue && buttonIssue.ref === 'e3', 'Ref preserved on finding');
  const brokenAssetIssue = fullReport.findings.find((f: any) => f.rule === 'broken-asset');
  assert.ok(brokenAssetIssue && brokenAssetIssue.ref === 'e5', 'Ref preserved on broken asset');
});

test('devtools_audit filtering by category and threshold', async () => {
  const { runAudit } = createMockHarness();

  // 1. Filter by category
  const layoutOnly = await runAudit({ categories: ['layout'], saveReport: false });
  assert.ok(layoutOnly.findings.length > 0);
  assert.ok(layoutOnly.findings.every((f: any) => f.category === 'layout'), 'Only layout category returned');

  // 2. Threshold: 'warnings' must return BOTH errors and warnings (minimum severity warning)
  const warningsThreshold = await runAudit({ threshold: 'warnings', saveReport: false });
  const hasErrors = warningsThreshold.findings.some((f: any) => f.severity === 'error');
  const hasWarnings = warningsThreshold.findings.some((f: any) => f.severity === 'warning');
  assert.ok(hasErrors, 'threshold: warnings should include errors');
  assert.ok(hasWarnings, 'threshold: warnings should include warnings');
  assert.ok(warningsThreshold.findings.every((f: any) => f.severity === 'error' || f.severity === 'warning'));

  // 3. Threshold: 'errors' must return ONLY errors
  const errorsOnly = await runAudit({ threshold: 'errors', saveReport: false });
  assert.ok(errorsOnly.findings.length > 0);
  assert.ok(errorsOnly.findings.every((f: any) => f.severity === 'error'), 'Only error severity returned');

  // 4. Summary only with specific category
  const layoutSummary = await runAudit({ summaryOnly: true, categories: ['layout'], saveReport: false });
  assert.equal(layoutSummary.findings, undefined, 'Findings omitted in summaryOnly mode');
  assert.ok(layoutSummary.categories.layout.errors > 0, 'Category error count preserved');
  assert.ok(layoutSummary.categories.layout.warnings > 0, 'Category warning count preserved');
});

test('devtools_audit saveReport persists artifact file', async () => {
  const { runAudit } = createMockHarness();
  const report = await runAudit({ saveReport: true });

  assert.ok(typeof report.reportArtifact === 'string' && report.reportArtifact.length > 0);
  assert.ok(existsSync(report.reportArtifact), 'Report artifact file must exist on disk');

  try {
    const raw = readFileSync(report.reportArtifact, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.url, 'https://example.com/checkout');
    assert.equal(parsed.score, report.score);
    assert.equal(parsed.status, report.status);
  } finally {
    try {
      unlinkSync(report.reportArtifact);
    } catch {}
  }
});

test('devtools_audit grade and status boundaries align correctly', async () => {
  // Score 100: Grade A, Status pass
  const clean = createMockHarness({
    consoleLogs: [],
    networkRequests: [],
    inPageResult: {
      layout: [],
      accessibility: [],
      seo: [],
      performance: { fcp: 300, ttfb: 40, domNodes: 50, domDepth: 3, issues: [] },
      security: [],
      brokenAssets: [],
    },
  });
  const resClean = await clean.runAudit();
  assert.equal(resClean.score, 100);
  assert.equal(resClean.grade, 'A');
  assert.equal(resClean.status, 'pass');

  // 5 warnings (-15 points -> score 85): Grade B, Status warn
  const gradeB = createMockHarness({
    consoleLogs: [],
    networkRequests: [],
    inPageResult: {
      layout: Array.from({ length: 5 }, (_, i) => ({
        rule: `warn-${i}`,
        detail: `Warning ${i}`,
        severity: 'warning',
      })),
      accessibility: [],
      seo: [],
      performance: { fcp: 300, ttfb: 40, domNodes: 50, domDepth: 3, issues: [] },
      security: [],
      brokenAssets: [],
    },
  });
  const resB = await gradeB.runAudit();
  assert.equal(resB.score, 85);
  assert.equal(resB.grade, 'B');
  assert.equal(resB.status, 'warn');

  // 8 warnings (-24 points -> score 76): Grade C, Status warn
  const gradeC = createMockHarness({
    consoleLogs: [],
    networkRequests: [],
    inPageResult: {
      layout: Array.from({ length: 8 }, (_, i) => ({
        rule: `warn-${i}`,
        detail: `Warning ${i}`,
        severity: 'warning',
      })),
      accessibility: [],
      seo: [],
      performance: { fcp: 300, ttfb: 40, domNodes: 50, domDepth: 3, issues: [] },
      security: [],
      brokenAssets: [],
    },
  });
  const resC = await gradeC.runAudit();
  assert.equal(resC.score, 76);
  assert.equal(resC.grade, 'C');
  assert.equal(resC.status, 'warn');

  // 1 error (-8) + 9 warnings (-27) = -35 points -> score 65: Grade D, Status fail
  const gradeD = createMockHarness({
    consoleLogs: [],
    networkRequests: [],
    inPageResult: {
      layout: [
        { rule: 'err-1', detail: 'Error 1', severity: 'error' },
        ...Array.from({ length: 9 }, (_, i) => ({
          rule: `warn-${i}`,
          detail: `Warning ${i}`,
          severity: 'warning',
        })),
      ],
      accessibility: [],
      seo: [],
      performance: { fcp: 300, ttfb: 40, domNodes: 50, domDepth: 3, issues: [] },
      security: [],
      brokenAssets: [],
    },
  });
  const resD = await gradeD.runAudit();
  assert.equal(resD.score, 65);
  assert.equal(resD.grade, 'D');
  assert.equal(resD.status, 'fail');

  // Console exception (-15) + 5 errors (-40) = -55 points -> score 45: Grade F, Status fail
  const gradeF = createMockHarness({
    consoleLogs: [
      { kind: 'exception', level: 'error', text: 'Crash', args: [] },
    ],
    networkRequests: [],
    inPageResult: {
      layout: Array.from({ length: 5 }, (_, i) => ({
        rule: `err-${i}`,
        detail: `Error ${i}`,
        severity: 'error',
      })),
      accessibility: [],
      seo: [],
      performance: { fcp: 300, ttfb: 40, domNodes: 50, domDepth: 3, issues: [] },
      security: [],
      brokenAssets: [],
    },
  });
  const resF = await gradeF.runAudit();
  assert.equal(resF.score, 45);
  assert.equal(resF.grade, 'F');
  assert.equal(resF.status, 'fail');
});

test('devtools_audit reports inactive capture session when devtools_session is not started', async () => {
  const { runAudit } = createMockHarness({ hasCaptureSession: false });
  const report = await runAudit();

  assert.equal(report.metrics.captureSessionActive, false);
  assert.ok(typeof report.note === 'string' && report.note.includes('DevTools capture session is inactive'));
});
