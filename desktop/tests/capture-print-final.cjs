'use strict';
/**
 * DriverLens desktop — final print fix capture (round3).
 *
 * OWNERSHIP: candidate-source/DriverLens/desktop only. Writes ONLY to
 * evidence/final-fixes/DriverLens-desktop/print-capture/ (new evidence; old
 * evidence/DriverLens-desktop, evidence/round2/* and parent-qa gates untouched).
 *
 * What this is: a SIMULATED renderer capture. The rebuilt dist/ is served via
 * `vite preview` and driven in an owned scratch-Chrome profile via
 * shared/cdp-browser.cjs. Tauri IPC does not exist in a plain browser, so
 * `window.__TAURI_INTERNALS__.invoke` is stubbed from the SINGLE faithful
 * source tests/fixtures/preview-ipc-stub.json (ten real commands, validated by
 * tests/preview-ipc-stub-fidelity.test.ts). The fictional sample loads through
 * the real bundled-JSON validator path (Load sample click).
 *
 * Print proof: for BOTH schemes (dark/light) under print media, this harness
 * - screenshots the real renderer with print CSS applied (no JS DOM hiding;
 *   hiding comes only from @media print in src/styles.css),
 * - exports backgrounds-off PDFs via Page.printToPDF { printBackground:false },
 * - asserts .filters + all input/select/textarea/button hidden while evidence
 *   (table/stats/badge) stays present,
 * - recomputes WCAG AA for stats value/label + badge both printed and
 *   paper-white (backgrounds-off), mirroring parent-qa/desktop-print-gates.cjs.
 *
 * Every screenshot/PDF here is SIMULATED (synthetic IPC + fictional sample) —
 * NOT native IPC/hardware proof. See result.json (simulated:true,
 * nativeIPCExercised:false).
 *
 * Run under the browser slot ONLY:
 *   python guard.py browser -- node tests/capture-print-final.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DESKTOP = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP, '..', '..', '..');
const SHARED = path.join(ROOT, 'shared', 'cdp-browser.cjs');
const STUB_PATH = path.join(DESKTOP, 'tests', 'fixtures', 'preview-ipc-stub.json');
const OUT = path.join(ROOT, 'evidence', 'final-fixes', 'DriverLens-desktop', 'print-capture');
const PORT = 1422;
const PREVIEW_URL = `http://localhost:${PORT}/`;

const { launch } = require(SHARED);

const checks = [];
function check(label, pass, observed) {
  checks.push({ label, pass: Boolean(pass), observed });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label} ${JSON.stringify(observed)}`);
}

function lum(rgb) {
  const v = rgb.slice(0, 3).map((n) => n / 255).map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
  return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
}
function ratio(a, b) {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForPort(retries = 60) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(PREVIEW_URL);
      if (res.ok) return true;
    } catch { /* not up yet */ }
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
  const pdfs = [];
  try {
    await waitForPort();
    page = await launch({ artifactsDir: OUT });

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

    await page.command('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await page.viewport(1280, 900);
    await page.goto(PREVIEW_URL);
    await page.waitFor('!!document.querySelector("main.app[data-ui-revision=\\"portfolio-preview-1\\"]")', 'shell mounted');
    check('shell-mounted', true, true);

    // Load fictional sample through the real validator path (no IPC invention).
    await page.evaluate(`(() => {
      const btn = [...document.querySelectorAll("button")].find(n=>(n.textContent||"").includes("Load sample"));
      if (!btn) throw new Error("Load sample button missing");
      btn.click();
      return true;
    })()`);
    await page.waitFor('document.body.textContent.includes("Fictional sample data")', 'sample chip');
    check('sample-loaded-chip', await page.evaluate('document.body.textContent.includes("Fictional sample data")'), true);

    const shot = async (name) => {
      const file = path.join(OUT, name);
      await page.screenshot(file);
      shots.push(file);
      return file;
    };

    for (const scheme of ['dark', 'light']) {
      await page.command('Emulation.setEmulatedMedia', { media: 'print', features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await wait(400);

      // Controls hidden via CSS only (no JS DOM hiding in this harness).
      const controls = await page.evaluate('[...document.querySelectorAll("input,select,textarea,button")].filter(n=>n.getClientRects().length&&getComputedStyle(n).visibility!=="hidden").map(n=>n.tagName)');
      check(`${scheme}-renderer-print-controls-hidden`, controls.length === 0, controls);
      const filtersVisible = await page.evaluate('(()=>{const n=document.querySelector(".filters");if(!n)return "absent";const r=n.getClientRects();return r.length>0&&getComputedStyle(n).display!=="none"?"visible":"hidden";})()');
      check(`${scheme}-renderer-filters-hidden`, filtersVisible !== 'visible', filtersVisible);
      check(`${scheme}-renderer-evidence-present`, await page.evaluate('!!document.querySelector(".workbench__evidence .app__table")'), true);
      check(`${scheme}-renderer-stats-present`, await page.evaluate('!!document.querySelector(".stats__value")&&!!document.querySelector(".stats__label")'), true);
      check(`${scheme}-renderer-badge-present`, await page.evaluate('!!document.querySelector(".badge,.chip")'), true);

      // Rendered AA for the three gate selectors (printed bg + paper-white).
      for (const selector of ['.stats__label', '.stats__value', '.badge']) {
        const pair = await page.evaluate(`(()=>{
          const n=document.querySelector(${JSON.stringify(selector)});
          if(!n) return null;
          const parse=v=>(v.match(/[\\d.]+/g)||[]).map(Number);
          const fg=parse(getComputedStyle(n).color);
          let a=n,bg=null;
          while(a){const c=parse(getComputedStyle(a).backgroundColor);if(c.length===3||c[3]===1){bg=c;break;}a=a.parentElement;}
          return {fg,bg:bg||[255,255,255]};
        })()`);
        if (!pair) {
          check(`${scheme}-renderer-AA-${selector}`, false, 'missing');
          continue;
        }
        const printed = ratio(pair.fg, pair.bg);
        const paper = ratio(pair.fg, [255, 255, 255]);
        check(`${scheme}-renderer-printed-AA-${selector}`, printed >= 4.5, { fg: pair.fg, bg: pair.bg, ratio: Number(printed.toFixed(3)) });
        check(`${scheme}-renderer-paper-white-AA-${selector}`, paper >= 4.5, { fg: pair.fg, ratio: Number(paper.toFixed(3)) });
      }

      await shot(`renderer-print-${scheme}-1280.png`);

      // Backgrounds-off PDF: real print output with decorative backgrounds disabled.
      const pdf = await page.command('Page.printToPDF', { printBackground: false, preferCSSPageSize: true });
      const pdfPath = path.join(OUT, `renderer-paper-backgrounds-off-${scheme}.pdf`);
      fs.writeFileSync(pdfPath, Buffer.from(pdf.data, 'base64'));
      pdfs.push(pdfPath);
      const bytes = fs.statSync(pdfPath).size;
      check(`${scheme}-renderer-backgrounds-off-pdf`, bytes > 5000, { path: pdfPath, bytes });
    }

    await page.command('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'light' }] });

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
    pdfs,
    pass: checks.length > 0 && checks.every((c) => c.pass),
  };
  fs.writeFileSync(path.join(OUT, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nCapture ${report.pass ? 'PASS' : 'FAIL'}: ${checks.filter((c) => c.pass).length}/${checks.length} checks, ${shots.length} shots, ${pdfs.length} pdfs`);
  if (!report.pass) process.exitCode = 1;
}

main().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 2; });
