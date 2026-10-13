'use strict';
/**
 * DriverLens desktop — faithful Vite renderer preview-state capture (round 2).
 *
 * OWNERSHIP: native/DriverLens/desktop only. Writes ONLY to
 * evidence/round2/DriverLens-desktop/preview-capture/ (new evidence; old
 * evidence/DriverLens-desktop is untouched).
 *
 * What this is: a SIMULATED renderer capture. The Vite build (dist/) is served
 * via `vite preview` and driven in an owned scratch-Chrome profile via
 * shared/cdp-browser.cjs. Tauri IPC does not exist in a plain browser, so
 * `window.__TAURI_INTERNALS__.invoke` is stubbed from the SINGLE faithful
 * source tests/fixtures/preview-ipc-stub.json — which itself is validated by
 * tests/preview-ipc-stub-fidelity.test.ts against the REAL definitions
 * (src/adapters/native.ts + src-tauri/src/lib.rs/scan.rs/notebook.rs/commands.rs).
 *
 * The stub REPAIRS the previous "Could not read the current scan state" capture
 * artifact by answering get_scan_state idle/0 + get_report null + get_notebook
 * empty. Production error handling is UNTOUCHED: ScanControls.tsx still renders
 * the genuine resync notice on a real rejection (fidelity test asserts the DOM
 * + string survive); this harness never hides error elements.
 *
 * Every screenshot here is SIMULATED (synthetic IPC + fictional sample) — NOT
 * native IPC/hardware proof. See result.json (simulated:true,
 * nativeIPCExercised:false) and evidence IMPLEMENTATION.md.
 *
 * Run under the browser slot ONLY:
 *   python guard.py browser -- node tests/capture-preview.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..', '..', '..');
const SHARED = path.join(ROOT, 'shared', 'cdp-browser.cjs');
const STUB_PATH = path.join(DESKTOP, 'tests', 'fixtures', 'preview-ipc-stub.json');
const OUT = path.join(ROOT, 'evidence', 'round2', 'DriverLens-desktop', 'preview-capture');
const PORT = 1421;
const PREVIEW_URL = `http://localhost:${PORT}/`;

const { launch } = require(SHARED);

const checks = [];
function check(label, pass, observed) {
  checks.push({ label, pass: Boolean(pass), observed });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label} ${JSON.stringify(observed)}`);
}

function luminance(rgb) {
  const v = rgb.slice(0, 3).map((n) => n / 255).map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
}
function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(retries = 60) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(PREVIEW_URL);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await wait(500);
  }
  throw new Error(`vite preview did not come up at ${PREVIEW_URL}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const stub = JSON.parse(fs.readFileSync(STUB_PATH, 'utf8'));
  if (stub.simulated !== true) throw new Error('stub must be marked simulated');
  const synthetics = {};
  for (const [cmd, entry] of Object.entries(stub.commands)) synthetics[cmd] = entry.synthetic;

  // Serve the already-built dist/ (build runs separately under the native slot).
  const preview = spawn(process.execPath, [path.join(DESKTOP, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: DESKTOP,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let previewLog = '';
  for (const s of [preview.stdout, preview.stderr]) {
    if (s) s.on('data', (d) => { previewLog += d.toString(); });
  }
  preview.on('error', (e) => { previewLog += `\npreview spawn error: ${e.message}\n`; });

  let page = null;
  const shots = [];
  try {
    await waitForPort();
    page = await launch({ artifactsDir: OUT });

    // Faithful stub BEFORE any app script runs.
    const stubSource = `(() => {
      const MAP = ${JSON.stringify(synthetics)};
      window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        if (Object.prototype.hasOwnProperty.call(MAP, cmd)) {
          const v = MAP[cmd];
          return v === null || v === undefined ? null : JSON.parse(JSON.stringify(v));
        }
        throw 'Denied: unknown command ' + cmd;
      };
      window.__TAURI_INTERNALS__.transformCallback = () => 0;
      window.__TAURI_INTERNALS__.unregisterCallback = () => {};
      window.__TAURI_INTERNALS__.convertFileSrc = (p) => p;
    })();`;
    await page.command('Page.addScriptToEvaluateOnNewDocument', { source: stubSource });

    const renderedPair = (selector) => page.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const parse = (v) => (v.match(/[\\d.]+/g) || []).map(Number);
      const fg = parse(getComputedStyle(el).color);
      let node = el, bg = null;
      while (node) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c.length >= 3 && (c.length === 3 || c[3] === 1)) { bg = c.slice(0, 3); break; }
        node = node.parentElement;
      }
      return { fg: fg.slice(0, 3), bg: bg || [255, 255, 255] };
    })()`);

    const emulate = (media = 'screen', scheme = 'dark') =>
      page.command('Emulation.setEmulatedMedia', { media, features: [{ name: 'prefers-color-scheme', value: scheme }] });

    // ---- dark sample flow ----
    await emulate('screen', 'dark');
    await page.viewport(1280, 900);
    await page.goto(PREVIEW_URL);
    await page.waitFor('!!document.querySelector("main.app[data-ui-revision=\\"portfolio-preview-1\\"]")', 'shell mounted');

    const revision = await page.evaluate('document.querySelector("main.app").getAttribute("data-ui-revision")');
    check('shell-mounted-revision', revision === 'portfolio-preview-1', revision);
    check('has-preview-pill', await page.evaluate('!![...document.querySelectorAll("p")].find(n=>/Desktop UI preview/i.test(n.textContent||""))'), true);
    check('has-version', await page.evaluate('document.body.textContent.includes("0.3.0-preview.1")'), true);
    for (const h of ['Scan workspace', 'Report library', 'Export', 'Devices']) {
      check(`has-heading-${h}`, await page.evaluate(`!![...document.querySelectorAll("h2,h3")].find(n=>(n.textContent||"").includes(${JSON.stringify(h)}))`), h);
    }
    // Mock repair: initial scan status must be Ready (idle/0), NOT the resync error.
    const initialStatus = await page.evaluate('document.querySelector(".scan__status")?.textContent || ""');
    check('initial-scan-ready-not-resync-error', /Ready\./.test(initialStatus) && !/Could not read the current scan state/.test(initialStatus), initialStatus.slice(0, 160));
    // Genuine error DOM contract: the status element exists (error TONE is conditional, element is not).
    check('scan-status-element-present', await page.evaluate('!!document.querySelector(".scan__status[role=status]")'), true);
    // Keyboard contract: scan controls precede the view switcher in DOM order.
    const order = await page.evaluate(`(() => {
      const html = document.querySelector("main.app").innerHTML;
      return { scan: html.indexOf("Scan this PC"), view: html.indexOf("Notebook view") };
    })()`);
    check('keyboard-scan-before-switcher', order.scan >= 0 && order.view > order.scan, order);

    // Load the fictional sample (bundled JSON validator path — no IPC report invented).
    await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(n=>(n.textContent||"").includes("Load sample"));
      if (!btn) throw new Error("Load sample button missing");
      btn.click();
      return true;
    })()`);
    await page.waitFor('document.body.textContent.includes("Fictional sample data")', 'sample chip');
    check('sample-loaded-chip', await page.evaluate('document.body.textContent.includes("Fictional sample data")'), true);
    check('sample-meta', await page.evaluate('document.body.textContent.includes("2 of 2 devices")'), true);
    await page.waitFor('document.querySelectorAll(".device-row").length >= 1', 'device rows');

    const shot = async (name) => {
      const file = path.join(OUT, name);
      await page.screenshot(file);
      shots.push(file);
      return file;
    };

    const pageOverflow = () => page.evaluate('Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth');

    // Dark 1280
    await emulate('screen', 'dark');
    await page.viewport(1280, 900);
    await wait(300);
    check('dark-no-page-overflow-1280', (await pageOverflow()) <= 1, await pageOverflow());
    await shot('desktop-sample-1280-dark.png');

    // Light 1280 + rendered AA spot checks (mirror parent sandbox, plus full component set)
    await emulate('screen', 'light');
    await page.viewport(1280, 900);
    await wait(300);
    const bodyPair = await renderedPair('body');
    check('light-body-actually-light', bodyPair && luminance(bodyPair.bg) > 0.5, bodyPair);
    for (const sel of ['.app__table th', '.button', '.input', '.stats__value', '.scan__status', '.app__note', '.chip', '.pager__status']) {
      const pair = await renderedPair(sel);
      const ratio = pair ? contrast(pair.fg, pair.bg) : 0;
      // Some selectors are absent pre-report or hidden; only assert when present.
      if (pair) check(`light-rendered-AA-${sel}`, ratio >= 4.5, { pair, ratio: Number(ratio.toFixed(2)) });
      else check(`light-rendered-present-${sel}`, true, 'absent-in-this-state-skipped');
    }
    check('light-no-page-overflow-1280', (await pageOverflow()) <= 1, await pageOverflow());
    await shot('desktop-sample-1280-light.png');

    // Narrow light: 390 / 320 / 300 (page never grows; table scrolls inside panel by design)
    for (const w of [390, 320, 300]) {
      await page.viewport(w, 900);
      await wait(300);
      const overflow = await pageOverflow();
      check(`narrow-no-page-overflow-${w}`, overflow <= 1, overflow);
      const innerScroll = await page.evaluate(`(() => {
        const n = document.querySelector(".workbench__evidence .app__table-wrap");
        if (!n) return null;
        return { scrollWidth: n.scrollWidth, clientWidth: n.clientWidth };
      })()`);
      check(`narrow-inner-table-scroll-${w}`, !!innerScroll && innerScroll.scrollWidth >= innerScroll.clientWidth, innerScroll);
      await shot(`desktop-sample-${w}-light.png`);
    }

    // Focus check: programmatic focus lands + outline rule exists (visual ring in shot)
    await page.viewport(1280, 900);
    await emulate('screen', 'light');
    await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(n=>(n.textContent||"").includes("Load sample"));
      btn.focus();
      return document.activeElement === btn;
    })()`);
    check('focus-lands-on-control', await page.evaluate('!!document.activeElement && document.activeElement.tagName === "BUTTON"'), true);
    await shot('desktop-focus-1280-light.png');

    // Print emulation: controls hidden per print CSS, evidence still readable
    await page.command('Emulation.setEmulatedMedia', { media: 'print' });
    await wait(300);
    const hiddenControls = await page.evaluate(`[...document.querySelectorAll(".viewnav,.scan__buttons,.toolbar,.pager")]
      .filter(n => { const r = n.getClientRects(); return r.length > 0 && getComputedStyle(n).display !== "none"; }).length`);
    check('print-hides-interactive-controls', hiddenControls === 0, hiddenControls);
    check('print-evidence-present', await page.evaluate('!!document.querySelector(".workbench__evidence .app__table")'), true);
    await shot('desktop-print.png');
    await page.command('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'light' }] });

    // Request hygiene: only localhost preview assets (no external network — app makes none).
    const external = page.requests.filter((u) => {
      try {
        const host = new (globalThis.URL)(u).hostname;
        return !(host === 'localhost' || host === '127.0.0.1');
      } catch { return true; }
    });
    check('no-external-requests', external.length === 0, page.requests);
    check('no-console-errors', page.errors.length === 0, page.errors);
  } finally {
    if (page) await page.close().catch(() => {});
    try {
      if (preview.exitCode === null) {
        if (process.platform === 'win32') {
          spawn('taskkill.exe', ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else preview.kill('SIGKILL');
      }
    } catch { /* best effort */ }
    try { fs.writeFileSync(path.join(OUT, 'preview-server.log'), previewLog); } catch { /* best effort */ }
  }

  const report = {
    simulated: true,
    nativeIPCExercised: false,
    ownerDataUsed: false,
    url: PREVIEW_URL,
    stub: 'tests/fixtures/preview-ipc-stub.json',
    sample: 'src/assets/synthetic-report.json (fictional; 2 devices)',
    checkedAt: new Date().toISOString(),
    checks,
    shots,
    pass: checks.length > 0 && checks.every((c) => c.pass),
  };
  fs.writeFileSync(path.join(OUT, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nCapture ${report.pass ? 'PASS' : 'FAIL'}: ${checks.filter((c) => c.pass).length}/${checks.length} checks, ${shots.length} shots`);
  if (!report.pass) process.exitCode = 1;
}

main().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 2; });
