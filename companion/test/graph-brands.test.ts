import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { graphBrand } from '../../extension/shared/src/brands.ts';

test('graph brands resolve reported names and use explicit fallbacks for unknown clients and browser engines', () => {
  const agents = ['Claude', 'Codex', 'Cursor', 'OpenCode', 'Antigravity', 'Muse Code'];
  const browsers = ['Chrome', 'Brave', 'Helium', 'Vivaldi', 'Arc', 'Dia', 'Firefox', 'Tor', 'Zen'];
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
  for (const [name, expected] of [['Google Chrome 153', 'Chrome'], ['Brave/153.0', 'Brave'], ['Mozilla Firefox 153', 'Firefox'], ['Tor Browser 15', 'Tor'], ['Zen Browser 1.2', 'Zen']]) {
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
    for (const name of ['', 'Custom browser', 'Chromium', 'Firefox-based browser', 'Arcade', 'Dialog', 'Zenith', 'My Chrome profile', 'Codex']) {
      const brand = graphBrand(name, 'browser', engine);
      assert.equal(brand.label, engine === 'firefox' ? 'Unknown Firefox' : 'Unknown Chromium');
      assert.equal(brand.src, `assets/browsers/${engine}.png`);
      assert.ok(existsSync(new URL(`../../extension/shared/${brand.src}`, import.meta.url)));
    }
  }
  assert.equal(graphBrand('Chromium 153', 'browser').label, 'Unknown Chromium');
  assert.equal(graphBrand('Firefox-based browser', 'browser').label, 'Unknown Firefox');
});
