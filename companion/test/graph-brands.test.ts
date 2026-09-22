import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { detectBrowserName, graphBrand, isKnownLabel, labelOptions, resolveBrowserName } from '../../extension/shared/src/brands.ts';

test('graph brands resolve reported names and use explicit fallbacks for unknown clients and browser engines', () => {
  const agents = ['Claude', 'Codex', 'Cursor', 'OpenCode', 'Antigravity', 'Muse Code'];
  const browsers = ['Chrome', 'Chromium', 'Edge', 'Brave', 'Helium', 'Vivaldi', 'Arc', 'Dia', 'Firefox', 'Tor', 'Zen'];
  for (const [kind, names] of [['agent', agents], ['browser', browsers]] as const) {
    for (const name of names) {
      const brand = graphBrand(name, kind);
      assert.equal(brand.name, name);
      assert.equal(brand.label, name);
      for (const src of [brand.src, brand.darkSrc].filter(Boolean)) {
        assert.match(src!, /^assets\/(?:clients|browsers)\/[a-z-]+\.(?:png|svg)$/);
        assert.ok(existsSync(new URL(`../../extension/shared/${src}`, import.meta.url)), `${src} is bundled`);
      }
    }
  }
  for (const [name, expected, label = name] of [['claude-code', 'Claude'], ['codex-mcp-client', 'Codex'], ['cursor-vscode', 'Cursor'], ['opencode', 'OpenCode'], ['Google Antigravity', 'Antigravity'], ['muse-code', 'Muse Code'], ['Meta Muse', 'Muse Code'], ['muse-spark-1.3-contributor', 'Muse Code'], ['MuseSpark', 'Muse Code'], ['tbh', 'Muse Code', 'Muse Code'], ['tbh:tui', 'Muse Code', 'Muse Code'], ['tbh:exec', 'Muse Code', 'Muse Code'], ['tbh:desktop', 'Muse Code', 'Muse Code']]) {
    assert.equal(graphBrand(name, 'agent')?.name, expected);
    assert.equal(graphBrand(name, 'agent').label, label);
  }
  for (const [name, expected] of [['Google Chrome 153', 'Chrome'], ['Chrome/153.0', 'Chrome'], ['Microsoft Edge 140', 'Edge'], ['Edge/140.0', 'Edge'], ['Edg/140.0', 'Edge'], ['Brave/153.0', 'Brave'], ['Brave Browser 1.80', 'Brave'], ['Helium 0.1', 'Helium'], ['Vivaldi/7.0', 'Vivaldi'], ['Arc/1.0', 'Arc'], ['Dia/1.0', 'Dia'], ['Mozilla Firefox 153', 'Firefox'], ['Tor Browser 15', 'Tor'], ['Zen Browser 1.2', 'Zen'], ['Zen/1.2', 'Zen']]) {
    assert.equal(graphBrand(name, 'browser')?.name, expected);
    assert.equal(graphBrand(name, 'browser').label, name);
  }
  for (const name of ['', 'My agent', 'Kilobyte', 'Cursorless', 'Claudeish', 'Chrome']) {
    const brand = graphBrand(name, 'agent');
    assert.equal(brand.label, 'Other agent');
    assert.equal(brand.src, 'assets/clients/other-agent.svg');
    assert.ok(existsSync(new URL(`../../extension/shared/${brand.src}`, import.meta.url)));
  }
  for (const engine of ['chromium', 'firefox'] as const) {
    for (const name of ['', 'Custom browser', 'Firefox-based browser', 'Arcade', 'Dialog', 'Zenith', 'Edgy', 'My Chrome profile', 'Codex']) {
      const brand = graphBrand(name, 'browser', engine);
      assert.equal(brand.label, engine === 'firefox' ? 'Unknown Firefox' : 'Unknown Chromium');
      assert.equal(brand.src, `assets/browsers/${engine}.png`);
      assert.ok(existsSync(new URL(`../../extension/shared/${brand.src}`, import.meta.url)));
    }
  }
  assert.equal(graphBrand('Chromium 153', 'browser').name, 'Chromium');
  assert.equal(graphBrand('Chromium 153', 'browser').src, 'assets/browsers/chromium.png');
  assert.equal(graphBrand('Chromium-based 153', 'browser').label, 'Unknown Chromium');
  assert.equal(graphBrand('Firefox-based browser', 'browser').label, 'Unknown Firefox');
  assert.deepEqual(labelOptions('chromium'), ['Chrome', 'Edge', 'Brave', 'Helium', 'Vivaldi', 'Arc', 'Dia', 'Chromium', 'Other']);
  assert.deepEqual(labelOptions('firefox'), ['Firefox', 'Tor', 'Zen', 'Other']);
  for (const label of [...labelOptions('chromium'), ...labelOptions('firefox'), '']) assert.ok(isKnownLabel(label), label);
  for (const label of ['My browser', 'Chrome!', 'Chromium 153']) assert.ok(!isKnownLabel(label), label);
});

test('browser detection prefers UA tokens over spoofed Chrome client hints', () => {
  const chromeBrands = [{ brand: 'Chromium', version: '153' }, { brand: 'Google Chrome', version: '153' }, { brand: 'Not-A.Brand', version: '99' }];
  const chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  // Helium keeps Chrome hints; its UA token must win so it does not render as Chrome.
  const heliumUA = `${chromeUA} Helium/0.1`;
  assert.match(detectBrowserName(chromeBrands, heliumUA)!, /^Helium\b/i);
  assert.equal(graphBrand(detectBrowserName(chromeBrands, heliumUA)!, 'browser', 'chromium').name, 'Helium');
  // Frozen low-entropy hints: real brand only in high-entropy fullVersionList.
  const frozen = [{ brand: 'Chromium', version: '153' }, { brand: 'Google Chrome', version: '153' }, { brand: 'Not-A.Brand', version: '99' }];
  const withFullList = [{ brand: 'Helium', version: '0.7.0' }, ...frozen];
  assert.match(detectBrowserName(withFullList, chromeUA)!, /^Helium\b/i);
  assert.equal(graphBrand(detectBrowserName(withFullList, chromeUA)!, 'browser', 'chromium').name, 'Helium');
  assert.equal(graphBrand(detectBrowserName(chromeBrands, chromeUA)!, 'browser', 'chromium').name, 'Chrome');
  const edgeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';
  assert.match(detectBrowserName(chromeBrands, edgeUA)!, /^Microsoft Edge\b/i);
  assert.equal(graphBrand(detectBrowserName(chromeBrands, edgeUA)!, 'browser', 'chromium').name, 'Edge');
  const braveBrands = [{ brand: 'Chromium', version: '153' }, { brand: 'Brave', version: '153' }, { brand: 'Not-A.Brand', version: '99' }];
  assert.match(detectBrowserName(braveBrands, chromeUA)!, /^Brave\b/i);
  const vivaldiUA = `${chromeUA} Vivaldi/7.0`;
  assert.match(detectBrowserName(chromeBrands, vivaldiUA)!, /^Vivaldi\b/i);
  const arcUA = `${chromeUA} Arc/1.0`;
  assert.match(detectBrowserName(chromeBrands, arcUA)!, /^Arc\b/i);
  const diaUA = `${chromeUA} Dia/1.0`;
  assert.match(detectBrowserName(chromeBrands, diaUA)!, /^Dia\b/i);
  // Firefox engine: Zen UA keeps the Zen logo instead of falling back to Firefox.
  assert.match(detectBrowserName([], 'Mozilla/5.0 Gecko/20100101 Firefox/153.0 Zen/1.2', { name: 'Firefox', version: '153.0' })!, /^Zen\b/i);
});

test('manual browser label overrides auto-detection for spoofed browsers', () => {
  const chromeBrands = [{ brand: 'Chromium', version: '153' }, { brand: 'Google Chrome', version: '153' }, { brand: 'Not-A.Brand', version: '99' }];
  const chromeUA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  assert.equal(resolveBrowserName('Helium', chromeBrands, chromeUA), 'Helium');
  assert.equal(resolveBrowserName('Dia', chromeBrands, chromeUA), 'Dia');
  assert.equal(graphBrand(resolveBrowserName('Dia', chromeBrands, chromeUA)!, 'browser', 'chromium').name, 'Dia');
  for (const blank of [undefined, '', '   ']) {
    assert.equal(resolveBrowserName(blank, chromeBrands, chromeUA), detectBrowserName(chromeBrands, chromeUA));
  }
  assert.equal(resolveBrowserName('Other', chromeBrands, chromeUA, undefined, 'chromium'), 'Chromium');
  assert.equal(resolveBrowserName('Other', chromeBrands, chromeUA, undefined, 'firefox'), 'Firefox');
  assert.equal(graphBrand(resolveBrowserName('Other', chromeBrands, chromeUA, undefined, 'chromium')!, 'browser', 'chromium').name, 'Chromium');
});
