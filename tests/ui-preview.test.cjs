'use strict';
// DriverLens browser-edition UI preview regression (implementer-authored).
//
// Proves the portfolio-preview-1 workbench shell without driving a browser:
//   * principal shell carries data-ui-revision="portfolio-preview-1"
//   * visible #prototype-notice with the exact honest concept wording, placed
//     early in the DOM (masthead area, before the evidence table)
//   * family CSS tokens --ui-* on :root, light scheme via
//     prefers-color-scheme, visible focus, reduced-motion + print handling
//   * preserved report workflow ids/handlers (filter/import/export/digest),
//     hosted-demo origin guard + loopback helper bootstrap still present,
//     server/collector/launcher-adjacent strings untouched here
//   * no runtime libs/fonts/CDN/storage/new HTTP APIs, no fake action buttons,
//     tables scroll inside their own panel (no body overflow camouflage)
//
// Run: node tests/ui-preview.test.cjs
// RED on the pre-revamp shell (no data-ui-revision, no notice, no tokens).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

test('principal shell carries data-ui-revision="portfolio-preview-1"', () => {
  assert.ok(
    html.includes('data-ui-revision="portfolio-preview-1"'),
    'index.html must mark the principal shell with data-ui-revision="portfolio-preview-1"'
  );
  assert.match(html, /<main[^>]*data-ui-revision="portfolio-preview-1"/);
});

test('honest concept notice is present, exact, and placed in the masthead area', () => {
  assert.ok(html.includes('id="prototype-notice"'), 'missing #prototype-notice element');
  const m = html.match(/<[^>]*id="prototype-notice"[^>]*>([\s\S]*?)<\/[^>]+>/);
  // fallback: capture the element's text span even if nested markup surrounds it
  const idx = html.indexOf('id="prototype-notice"');
  const slice = html.slice(idx, idx + 1200);
  assert.ok(
    slice.includes('Experimental concept prototype — idea exploration only.'),
    'notice must contain the exact phrase with em dash: ' + slice.slice(0, 200)
  );
  assert.match(slice, /not a finished|not finished/i, 'notice must say it is not finished');
  assert.match(slice, /production.ready/i, 'notice must say it is not production-ready');
  // early placement: notice comes before the evidence table and stats render
  const noticePos = html.indexOf('id="prototype-notice"');
  const rowsPos = html.indexOf('id="rows"');
  const scanPos = html.indexOf('id="scan"');
  assert.ok(noticePos > -1 && rowsPos > -1 && noticePos < rowsPos, 'notice must precede the evidence table');
  assert.ok(scanPos > -1 && noticePos < rowsPos, 'notice must sit in the upper workbench region');
  void m;
});

test('family CSS tokens exist on :root with light-scheme support', () => {
  for (const token of ['--ui-bg', '--ui-surface', '--ui-ink', '--ui-muted', '--ui-accent', '--ui-border', '--ui-radius']) {
    assert.ok(css.includes(token), `style.css must define ${token}`);
  }
  assert.match(css, /:root\s*\{[^}]*--ui-bg/, ':root must set the family tokens');
  assert.match(css, /prefers-color-scheme:\s*light/, 'must honor the light system color preference');
  assert.match(css, /color-scheme/, 'must declare color-scheme');
});

test('accessible, motion- and print-aware styling', () => {
  assert.match(css, /:focus-visible/, 'must show a visible keyboard focus style');
  assert.match(css, /prefers-reduced-motion/, 'must respect reduced motion');
  assert.match(css, /@media\s+print|@mediaprint/, 'must keep printed evidence readable');
});

test('report workflow ids and handlers are preserved', () => {
  for (const id of ['scan', 'file', 'demo', 'export', 'message', 'total', 'review', 'known', 'system', 'search', 'status', 'architecture', 'bus', 'count', 'rows']) {
    assert.ok(html.includes(`id="${id}"`), `index.html must keep id="${id}"`);
  }
  assert.ok(app.includes("validate"), 'app.js must keep report validation');
  assert.ok(app.includes('schemaVersion'), 'app.js must keep schemaVersion gating');
  assert.ok(app.includes('Filtered export from DriverLens') || app.includes('filterNote'), 'app.js must keep filtered export');
  assert.ok(app.includes('/scan'), 'app.js must keep the /scan collection path');
  assert.ok(app.includes('X-DriverLens-Scan'), 'app.js must keep the scan header guard');
});

test('hosted-demo guard and loopback helper bootstrap are preserved', () => {
  assert.ok(app.includes("location.hostname!=='127.0.0.1'") || app.includes('location.hostname !=='), 'app.js must keep the hosted-demo origin guard');
  assert.ok(app.includes('/ping'), 'app.js must keep the /ping readiness probe');
  assert.ok(app.includes('cannot start local programs'), 'app.js must keep the honest no-zero-click-launch wording');
  assert.ok(app.includes('Start-DriverLens.cmd'), 'app.js must keep pointing at the launcher');
});

test('no runtime libs, fonts, CDN, storage, or new remote APIs', () => {
  assert.equal(/<script\s+src="http/i.test(html), false, 'no remote <script src>');
  assert.equal(/<link[^>]+href="https?:/i.test(html), false, 'no remote <link href>');
  assert.equal(/@import\s+url\(\s*['\"]?https?:/i.test(css), false, 'no remote @import');
  assert.equal(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com/i.test(html + css), false, 'no webfont/CDN domains');
  assert.equal(/localStorage|sessionStorage|indexedDB/i.test(app + html), false, 'no web storage (honor no-persistence rule)');
  // only owned-loopback fetches plus the same-document sample fetch are allowed
  const fetches = [...app.matchAll(/fetch\(\s*['\"`]([^'\"`]+)['\"`]/g)].map((m) => m[1]);
  for (const target of fetches) {
    assert.ok(
      target.startsWith('/') || target === 'sample.json' || target.startsWith('http://127.0.0.1'),
      `unexpected fetch target (only owned loopback/same-document allowed): ${target}`
    );
  }
});

test('no fake action buttons; stats stay factual (existing four only)', () => {
  const buttons = [...html.matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(buttons.sort(), ['demo', 'export', 'scan'], 'only the three real workbench actions may be buttons');
  for (const id of ['total', 'review', 'known', 'system']) {
    assert.ok(html.includes(`id="${id}"`), `stat ${id} must remain`);
  }
  assert.ok(app.includes("$('total')") || app.includes("('total')"), 'app.js must still render the factual stats');
});

test('evidence table scrolls inside its panel; no page-overflow camouflage', () => {
  assert.ok(html.includes('table-wrap'), 'evidence table must stay wrapped in its own scroll panel');
  assert.match(css, /\.table-wrap\s*\{[^}]*overflow\s*:\s*auto/, '.table-wrap must scroll internally');
  assert.equal(/html\s*\{[^}]*overflow-x\s*:\s*hidden/i.test(css), false, 'must not hide page overflow on html');
  assert.equal(/body\s*\{[^}]*overflow-x\s*:\s*hidden/i.test(css), false, 'must not hide page overflow on body');
});

test('responsive workbench: small viewports keep controls reachable', () => {
  assert.match(css, /@media\s*\(max-width:\s*(760|700|640|600|520|480)px\)/, 'must include a small-viewport layout rule');
  assert.ok(css.includes('min-width') || css.includes('minmax'), 'filters/controls must guard against min-content blowout');
});
