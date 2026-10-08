// Browser integration test (dev-only Playwright).
//
// Proves, against the real repository files:
//   * index.html opened from file:// waits for the local helper and says so
//     honestly (browser pages cannot start programs — no zero-click launch);
//   * the page auto-connects itself to the helper once it is running — both
//     the "helper comes up later" and "helper already running" entry paths;
//   * the page never adopts an unrelated service squatting on port 8781
//     (wrong-service 404 and 200 text variants): readiness is fail-closed;
//   * the served page loads the fictional bundled sample;
//   * a synthetic report imports through the real file input, renders, and
//     filters; docs/images/app.png is saved showing the synthetic report only.
//
// Run: node tests/browser.test.cjs
// Requires: npm ci (dev-only Playwright) and a browser: system Chrome/Edge or
// `npx playwright install chromium`. Choose with
// DRIVERLENS_BROWSER=chrome|chromium|msedge. DRIVERLENS_REQUIRE_BROWSER=1 turns
// "no browser available" into a failure (CI uses it after installing Chromium).
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8781; // fixed: app.js's file:// auto-connect probes exactly this loopback port
const FIXTURE = path.join(__dirname, 'fixtures', 'synthetic-report.json');
const SCREENSHOT = path.join(ROOT, 'docs', 'images', 'app.png');
const STORED_FILES = ['server.cjs', 'index.html', 'app.js', 'style.css', 'sample.json', 'Collect-DriverLens.ps1'];

let playwright = null;
try { playwright = require('playwright'); } catch { playwright = null; }

const spawned = [];
let browser = null;
let workDir = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1500, () => done(false));
  });
}

function pingOnce(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ping', method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForPing(port, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.exitCode !== null) throw new Error(`helper exited early with code ${child.exitCode}`);
    try { if ((await pingOnce(port)) === 200) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`helper on port ${port} did not become ready within ${timeoutMs} ms`);
    await delay(150);
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, delay(4000)]);
}

function browserOrder() {
  const override = process.env.DRIVERLENS_BROWSER;
  if (override) {
    if (!['chrome', 'chromium', 'msedge'].includes(override)) {
      throw new Error('DRIVERLENS_BROWSER must be chrome, chromium or msedge');
    }
    return [override];
  }
  return ['chrome', 'chromium', 'msedge'];
}

async function launchAnyBrowser(chromium) {
  const failures = [];
  for (const name of browserOrder()) {
    const options = name === 'chromium' ? { headless: true } : { channel: name, headless: true };
    try {
      return { browser: await chromium.launch(options), label: name };
    } catch (error) {
      failures.push(`${name}: ${String((error && error.message) || error).split('\n')[0].slice(0, 140)}`);
    }
  }
  console.error('browser launch attempts failed:\n  ' + failures.join('\n  '));
  return null;
}

// Shared gate for every test in this file: launch a browser, or skip (or fail
// when DRIVERLENS_REQUIRE_BROWSER=1) with the same policy and messages.
async function browserOrSkip(t) {
  const requireBrowser = process.env.DRIVERLENS_REQUIRE_BROWSER === '1';
  const refuse = (message) => {
    if (requireBrowser) assert.fail(message);
    t.skip(message);
    return null;
  };
  if (!playwright) return refuse('Playwright is not installed (dev-only). Run `npm ci` first; this browser test was skipped.');
  if (await portInUse(PORT)) return refuse(`port ${PORT} is already in use (a DriverLens helper may be running); cannot run the contained browser test.`);
  const launched = await launchAnyBrowser(playwright.chromium);
  if (!launched) return refuse('No browser could be launched (tried ' + browserOrder().join(', ') + '). Install one or run `npx playwright install chromium`.');
  return launched;
}

after(async () => {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
  for (const child of spawned.splice(0)) await stopChild(child);
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('file:// page waits for the helper, auto-connects, and imports a synthetic report', { timeout: 180000 }, async (t) => {
  const launched = await browserOrSkip(t);
  if (!launched) return;
  browser = launched.browser;
  t.diagnostic(`browser: ${launched.label} ${browser.version()}`);

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverlens-browser-'));
  for (const file of STORED_FILES) {
    fs.copyFileSync(path.join(ROOT, file), path.join(workDir, file));
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  try {
    // 1) Open the real index.html from disk, before any helper exists.
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
    const waiting = await page.textContent('#message');
    assert.ok(waiting.includes('Waiting for the local helper'), 'the file:// page must show the waiting message: ' + waiting);
    assert.ok(waiting.includes('cannot start local programs'), 'the file:// page must not promise a zero-click program launch');
    assert.ok(waiting.includes('Start-DriverLens.cmd'), 'the file:// page must point at the launcher');
    await delay(1200);
    assert.ok(page.url().startsWith('file://'), 'the page must not leave file:// while no helper is running');

    // 2) Start the contained helper (production server code; missing PowerShell so no scan can run).
    const child = spawn(process.execPath, ['server.cjs'], {
      cwd: workDir,
      env: { ...process.env, DRIVERLENS_PORT: String(PORT), DRIVERLENS_POWERSHELL: path.join(workDir, 'missing', 'pwsh.exe') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(child);
    child.stderr.on('data', (data) => process.stderr.write('[helper] ' + data));
    await waitForPing(PORT, 15000, child);

    // 3) The page must auto-connect itself to the helper.
    await page.waitForURL(`http://127.0.0.1:${PORT}/`, { timeout: 25000 });
    await page.waitForSelector('#scan', { state: 'visible' });
    assert.equal(await page.title(), 'DriverLens');

    // 4) Load the bundled fictional sample through the served page.
    await page.click('#demo');
    await page.waitForFunction(() => document.getElementById('total').textContent === '3', null, { timeout: 10000 });
    let message = await page.textContent('#message');
    assert.ok(message.includes('Sample report loaded'), message);
    assert.ok(message.includes('fictional'), 'the sample must be labelled fictional: ' + message);
    assert.ok((await page.textContent('#count')).includes('Sample data'));

    // 5) Manual report import through the real file input (synthetic fixture).
    await page.setInputFiles('#file', FIXTURE);
    await page.waitForFunction(() => document.getElementById('total').textContent === '2', null, { timeout: 10000 });
    message = await page.textContent('#message');
    assert.ok(message.includes('these devices are fictional'), message);
    assert.equal(await page.textContent('#review'), '1');
    assert.equal(await page.textContent('#system'), 'ARM64');
    const rows = await page.textContent('#rows');
    assert.ok(rows.includes('Contoso USB Serial Adapter (synthetic)'), 'imported synthetic device must render');
    assert.ok(rows.includes('Adventure Works Legacy Controller (synthetic)'));
    await page.fill('#search', 'contoso');
    await page.waitForFunction(() => document.getElementById('count').textContent.startsWith('1 of 2'), null, { timeout: 5000 });
    await page.fill('#search', '');
    await page.waitForFunction(() => document.getElementById('count').textContent.startsWith('2 of 2'), null, { timeout: 5000 });

    // 6) Screenshot with the synthetic report visible (docs/images/app.png).
    fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true });
    await page.screenshot({ path: SCREENSHOT, fullPage: true });
    const png = fs.readFileSync(SCREENSHOT);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'screenshot must be a real PNG');
    assert.ok(png.length > 10000, 'screenshot must not be empty');

    assert.deepEqual(pageErrors, [], 'no uncaught page errors are allowed');
  } finally {
    await browser.close().catch(() => {});
    browser = null;
    for (const child of spawned.splice(0)) await stopChild(child);
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    workDir = null;
  }
});

test('file:// page never adopts a wrong service on port 8781 (404 and 200 text variants)', { timeout: 120000 }, async (t) => {
  const launched = await browserOrSkip(t);
  if (!launched) return;
  const localBrowser = launched.browser;
  try {
    for (const [status, label] of [[404, 'wrong-service 404 text'], [200, 'wrong-service 200 text']]) {
      let hits = 0;
      const wrong = http.createServer((req, res) => {
        hits += 1;
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end('Not a DriverLens helper');
      });
      await new Promise((resolve, reject) => { wrong.once('error', reject); wrong.listen(PORT, '127.0.0.1', resolve); });
      try {
        const page = await localBrowser.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(String(error)));
        await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
        const waiting = await page.textContent('#message');
        assert.ok(waiting.includes('Waiting for the local helper'), `${label}: the waiting message must stay: ${waiting}`);
        // Cover several probe intervals (immediate + 2s + 4s): with the old opaque
        // probe the page navigated to this wrong service within the first one.
        await page.waitForURL(`http://127.0.0.1:${PORT}/`, { timeout: 4500 }).catch(() => {});
        assert.ok(page.url().startsWith('file://'), `${label}: the page must stay on file:// (url=${page.url()})`);
        const stillWaiting = await page.textContent('#message');
        assert.ok(stillWaiting.includes('Waiting for the local helper'), `${label}: waiting message must persist: ${stillWaiting}`);
        assert.ok(hits >= 1, `${label}: the page must have probed the port before declining (hits=${hits})`);
        assert.deepEqual(pageErrors, [], `${label}: no uncaught page errors are allowed`);
        await page.close();
      } finally {
        await new Promise((resolve) => { wrong.close(resolve); wrong.closeAllConnections?.(); });
      }
    }
  } finally {
    await localBrowser.close().catch(() => {});
  }
});

test('file:// page connects when the helper is already running (already-up entry)', { timeout: 120000 }, async (t) => {
  const launched = await browserOrSkip(t);
  if (!launched) return;
  const localBrowser = launched.browser;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverlens-browser-up-'));
  let child = null;
  try {
    for (const file of STORED_FILES) {
      fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
    }
    child = spawn(process.execPath, ['server.cjs'], {
      cwd: dir,
      env: { ...process.env, DRIVERLENS_PORT: String(PORT), DRIVERLENS_POWERSHELL: path.join(dir, 'missing', 'pwsh.exe') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(child);
    child.stderr.on('data', (data) => process.stderr.write('[helper] ' + data));
    await waitForPing(PORT, 15000, child);
    const page = await localBrowser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href);
    await page.waitForURL(`http://127.0.0.1:${PORT}/`, { timeout: 15000 });
    await page.waitForSelector('#scan', { state: 'visible' });
    assert.equal(await page.title(), 'DriverLens');
    assert.deepEqual(pageErrors, [], 'no uncaught page errors are allowed');
    await page.close();
  } finally {
    await stopChild(child);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await localBrowser.close().catch(() => {});
  }
});
