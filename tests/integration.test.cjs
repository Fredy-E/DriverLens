// DriverLens integration tests.
//
// Spawns real server processes and exercises them over real HTTP:
//   * the production entrypoint (node server.cjs, from a contained copy so the
//     repository's own driver-report.json is never touched) with
//     DRIVERLENS_POWERSHELL pointed at a missing executable so a live scan can
//     never run — this also covers the real "collector failed" path;
//   * a harness (tests/collector-harness.cjs) that loads the same request
//     handler via the createServer injection seam and covers synthetic
//     collector success, pending (409), failure (500 detail) and non-Windows
//     (400) paths.
//
// Guarded surface: exact loopback Host header, exact Origin + X-DriverLens-Scan
// header for /scan, no CORS, fixed static allowlist, path traversal, /ping
// readiness, method handling, report endpoints. No real device inventory is
// ever collected by any test.
//
// Run: node tests/integration.test.cjs
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_REPORT = path.join(__dirname, 'fixtures', 'synthetic-report.json');
const PING_GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const INVENTORY_FAILED = 'Inventory failed. Install PowerShell 7 or set DRIVERLENS_POWERSHELL to its executable; check script policy and WMI access.';
const STORED_FILES = ['server.cjs', 'index.html', 'app.js', 'style.css', 'sample.json', 'Collect-DriverLens.ps1'];

const spawned = [];
let workDir = null;
let prod = null;
let harnessSuccess = null;
let harnessPending = null;
let harnessFail = null;
let harnessPlatform = null;
let repoBefore = null;

// ---------------------------------------------------------------- helpers

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function request(port, urlPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const asJson = (res) => JSON.parse(res.body.toString('utf8'));

// Raw-socket request helper: sends exact request lines so malformed request
// targets can be exercised (the Node http client validates some of them).
function rawTarget(port, requestLines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(requestLines.join('\r\n') + '\r\n\r\n');
    });
    const chunks = [];
    socket.on('data', (chunk) => { chunks.push(chunk); });
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); resolve(Buffer.concat(chunks)); });
  });
}

// Byte-accurate helpers: responses use explicit writeHead + end, so bodies arrive
// chunked on the raw wire. Slicing must stay on byte offsets (bodies contain
// multi-byte UTF-8 characters, so string slicing would drift into the framing).
const statusOf = (raw) => raw.subarray(0, raw.indexOf('\r\n')).toString('latin1').trim();
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const bodyOf = (raw) => {
  const split = raw.indexOf(HEADER_END);
  if (split === -1) return Buffer.alloc(0);
  const wire = raw.subarray(split + 4);
  if (!raw.subarray(0, split).toString('latin1').toLowerCase().includes('transfer-encoding: chunked')) return wire;
  const parts = [];
  let offset = 0;
  for (;;) {
    const nl = wire.indexOf(CRLF, offset);
    if (nl === -1) break;
    const size = parseInt(wire.subarray(offset, nl).toString('latin1'), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(wire.subarray(nl + 2, nl + 2 + size));
    offset = nl + 2 + size + 2;
  }
  return Buffer.concat(parts);
};

async function waitForPing(port, { timeoutMs = 15000, child = null, logs = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.exitCode !== null) {
      throw new Error(`server on port ${port} exited early (code ${child.exitCode})\n${logs ? logs.stderr : ''}`);
    }
    try {
      const res = await request(port, '/ping');
      if (res.status === 200) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`server on port ${port} did not become ready within ${timeoutMs} ms\n${logs ? logs.stderr : ''}`);
    }
    await delay(150);
  }
}

function spawnServer(scriptPath, env) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { stdout: '', stderr: '' };
  child.stdout.on('data', (data) => { logs.stdout += data; });
  child.stderr.on('data', (data) => { logs.stderr += data; });
  spawned.push(child);
  return { child, logs };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, delay(4000)]);
}

function snapshotRepo() {
  const reportPath = path.join(ROOT, 'driver-report.json');
  return {
    topLevel: fs.readdirSync(ROOT).sort(),
    // Digest the report instead of embedding its contents: the snapshot
    // compares the repository before/after, so a saved report must survive
    // byte-for-byte. Hashing necessarily reads the report bytes — what must
    // never happen is storing report plaintext in the snapshot or writing it
    // to diagnostics; only the digest (or null) is kept.
    report: fs.existsSync(reportPath) ? createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex') : null,
  };
}

// ---------------------------------------------------------------- setup

before(async () => {
  repoBefore = snapshotRepo();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverlens-integration-'));
  for (const file of STORED_FILES) {
    fs.copyFileSync(path.join(ROOT, file), path.join(workDir, file));
  }
  const missingPwsh = path.join(workDir, 'missing', 'pwsh.exe');
  assert.equal(fs.existsSync(missingPwsh), false, 'the injected DRIVERLENS_POWERSHELL path must not exist');

  const prodPort = await freePort();
  prod = {
    port: prodPort,
    missingPwsh,
    ...spawnServer(path.join(workDir, 'server.cjs'), {
      DRIVERLENS_PORT: String(prodPort),
      DRIVERLENS_POWERSHELL: missingPwsh,
    }),
  };
  await waitForPing(prodPort, { child: prod.child, logs: prod.logs });

  const spawnHarness = async (name, env) => {
    const port = await freePort();
    const reportPath = path.join(workDir, `${name}-report.json`);
    const info = {
      port,
      reportPath,
      ...spawnServer(path.join(__dirname, 'collector-harness.cjs'), {
        DRIVERLENS_TEST_PORT: String(port),
        DRIVERLENS_TEST_REPORT: reportPath,
        DRIVERLENS_TEST_FIXTURE: FIXTURE_REPORT,
        ...env,
      }),
    };
    await waitForPing(port, { child: info.child, logs: info.logs });
    return info;
  };
  harnessSuccess = await spawnHarness('harness-success', { DRIVERLENS_TEST_MODE: 'success' });
  harnessPending = await spawnHarness('harness-pending', { DRIVERLENS_TEST_MODE: 'pending', DRIVERLENS_TEST_DELAY: '1200' });
  harnessFail = await spawnHarness('harness-fail', { DRIVERLENS_TEST_MODE: 'fail' });
  harnessPlatform = await spawnHarness('harness-platform', { DRIVERLENS_TEST_MODE: 'platform' });
});

after(async () => {
  await Promise.all(spawned.map(stopChild));
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
});

// ------------------------------------------------- production entrypoint

test('production entrypoint: listens only on 127.0.0.1 and logs the loopback URL', { timeout: 30000 }, async () => {
  const deadline = Date.now() + 3000;
  while (!prod.logs.stdout.includes('DriverLens:') && Date.now() < deadline) await delay(50);
  assert.match(
    prod.logs.stdout,
    new RegExp(`DriverLens: http://127\\.0\\.0\\.1:${prod.port} — choose Scan this PC for a read-only inventory\\.`),
    'the entrypoint must log the exact loopback URL',
  );

  const page = await request(prod.port, '/');
  assert.equal(page.status, 200);

  if (process.platform === 'win32') {
    const netstatOut = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const locals = [];
    for (const line of netstatOut.split(/\r?\n/)) {
      const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+\d+\s*$/);
      if (match && Number(match[2]) === prod.port) locals.push(match[1]);
    }
    assert.ok(locals.includes('127.0.0.1'), `expected a 127.0.0.1 listener for port ${prod.port}; netstat found: ${JSON.stringify(locals)}`);
    assert.deepEqual(locals.filter((address) => address !== '127.0.0.1'), [], 'the server must not listen on any non-loopback interface');
  }
});

test('Host guard: only the exact 127.0.0.1:<port> Host header is accepted', { timeout: 30000 }, async () => {
  assert.equal((await request(prod.port, '/')).status, 200);
  const cases = [
    [`localhost:${prod.port}`, 'localhost must be rejected (use 127.0.0.1 by design)'],
    [`127.0.0.1:${prod.port + 1}`, 'a different port must be rejected'],
    ['127.0.0.1', 'a Host without the port must be rejected'],
    ['example.com', 'external hosts must be rejected'],
    [`[::1]:${prod.port}`, 'the IPv6 loopback spelling must be rejected'],
  ];
  for (const [host, why] of cases) {
    for (const urlPath of ['/', '/ping']) {
      const res = await request(prod.port, urlPath, { headers: { Host: host } });
      assert.equal(res.status, 403, `${why} (path ${urlPath})`);
      assert.deepEqual(asJson(res), { error: 'Use the local 127.0.0.1 address.' });
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
  }
});

test('static allowlist: exactly /, /app.js, /style.css, /sample.json with fixed types and bytes', { timeout: 30000 }, async () => {
  const assets = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
    ['/sample.json', 'sample.json', 'application/json; charset=utf-8'],
  ];
  for (const [urlPath, file, contentType] of assets) {
    const res = await request(prod.port, urlPath);
    assert.equal(res.status, 200, urlPath);
    assert.equal(res.headers['content-type'], contentType, urlPath);
    assert.equal(res.headers['cache-control'], 'no-store', urlPath);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', urlPath);
    assert.deepEqual(res.body, fs.readFileSync(path.join(ROOT, file)), `${urlPath} must serve exactly ${file}`);
  }
  const notServed = ['/index.html', '/assets/banner.png', '/server.cjs', '/Collect-DriverLens.ps1', '/Test-Collector.ps1', '/driver-report.json', '/tests/integration.test.cjs', '/package.json'];
  for (const urlPath of notServed) {
    const res = await request(prod.port, urlPath);
    assert.equal(res.status, 404, `${urlPath} must not be served`);
    assert.deepEqual(asJson(res), { error: 'Not found.' });
  }
});

test('path traversal and encoded traversal never escape the fixed asset map', { timeout: 30000 }, async () => {
  const indexBytes = fs.readFileSync(path.join(ROOT, 'index.html'));
  const traversal404 = ['/../server.cjs', '/..%2fserver.cjs', '/%2e%2e%2fserver.cjs', '/%2e%2e/server.cjs', '/....//server.cjs', '/subdir/../../server.cjs', '/%5c..%5cserver.cjs', '/server.cjs%00', '/./server.cjs'];
  for (const urlPath of traversal404) {
    const res = await request(prod.port, urlPath);
    assert.equal(res.status, 404, `${urlPath} must 404`);
    const body = res.body.toString('utf8');
    assert.equal(body, JSON.stringify({ error: 'Not found.' }), urlPath);
    for (const marker of ['execFile', 'child_process', 'createServer', 'require(']) {
      assert.equal(body.includes(marker), false, `${urlPath} must not leak source markers`);
    }
  }
  // Scheme-relative forms are normalized by WHATWG URL parsing to '/', so they can
  // only ever serve the public index page — never the server source file.
  for (const urlPath of ['//server.cjs', '///server.cjs']) {
    const res = await request(prod.port, urlPath);
    assert.equal(res.status, 200, urlPath);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.deepEqual(res.body, indexBytes, `${urlPath} may only serve the public index page`);
    assert.equal(res.body.toString('utf8').includes('execFile'), false);
  }
});

test('malformed request targets: 400 to the client, helper stays alive (no ERR_INVALID_URL crash)', { timeout: 30000 }, async () => {
  const port = await freePort();
  const instance = spawnServer(path.join(workDir, 'server.cjs'), {
    DRIVERLENS_PORT: String(port),
    DRIVERLENS_POWERSHELL: prod.missingPwsh,
  });
  try {
    await waitForPing(port, { child: instance.child, logs: instance.logs });

    // The exact parent-probe request: http.get with a raw '//[::' path.
    const viaClient = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '//[::' }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', (error) => resolve({ error: error.code }));
      req.setTimeout(3000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    });
    assert.deepEqual(viaClient, { status: 400 }, 'the exact parent-probe malformed request must return 400');

    const cases = [
      ['GET //[:: HTTP/1.1', 'scheme-relative target with an invalid IPv6 host'],
      ['GET http://[:: HTTP/1.1', 'absolute-form target with an invalid IPv6 host'],
      ['GET //[::1]:99999 HTTP/1.1', 'bracketed host with an out-of-range port'],
      ['GET //%zz HTTP/1.1', 'invalid percent escape in the authority'],
      ['GET http:// HTTP/1.1', 'scheme with an empty authority'],
    ];
    for (const [line, why] of cases) {
      const raw = await rawTarget(port, [line, `Host: 127.0.0.1:${port}`, 'Connection: close']);
      assert.match(statusOf(raw), /^HTTP\/1\.1 400 /, `${why} — got: ${statusOf(raw)}`);
      assert.deepEqual(JSON.parse(bodyOf(raw).toString('utf8')), { error: 'Invalid request target.' }, why);
      assert.equal(instance.child.exitCode, null, `${why} must not kill the helper process`);
    }

    // A malformed scan target with otherwise-valid scan headers is rejected before collection.
    const scanRaw = await rawTarget(port, [
      'POST //[:: HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      `Origin: http://127.0.0.1:${port}`,
      'X-DriverLens-Scan: 1',
      'Content-Length: 0',
      'Connection: close',
    ]);
    assert.match(statusOf(scanRaw), /^HTTP\/1\.1 400 /, 'a malformed scan target must be rejected, not collected');

    // Still fully alive and serving after every malformed request.
    assert.equal((await request(port, '/')).status, 200);
    assert.equal((await request(port, '/ping')).status, 200);
    assert.equal(instance.logs.stderr.includes('ERR_INVALID_URL'), false, 'no uncaught URL parse error may be logged');
  } finally {
    await stopChild(instance.child);
  }
});

test('request-target origin guard: foreign absolute targets are rejected, same-origin absolute targets still serve', { timeout: 30000 }, async () => {
  const port = await freePort();
  const instance = spawnServer(path.join(workDir, 'server.cjs'), {
    DRIVERLENS_PORT: String(port),
    DRIVERLENS_POWERSHELL: prod.missingPwsh,
  });
  try {
    await waitForPing(port, { child: instance.child, logs: instance.logs });
    const foreign = [
      ['GET http://evil.example/ HTTP/1.1', 'absolute target for another origin', 'json'],
      // llhttp is stricter than WHATWG URL parsing: these forms never reach the
      // handler and get the parser's bare 400 (empty body) instead.
      ['GET https:server.cjs HTTP/1.1', 'special-scheme target rejected before the handler', 'empty'],
      ['GET mailto:x HTTP/1.1', 'non-http scheme target rejected before the handler', 'empty'],
    ];
    for (const [line, why, bodyKind] of foreign) {
      const raw = await rawTarget(port, [line, `Host: 127.0.0.1:${port}`, 'Connection: close']);
      assert.match(statusOf(raw), /^HTTP\/1\.1 400 /, `${why} — got: ${statusOf(raw)}`);
      const body = bodyOf(raw);
      if (bodyKind === 'json') assert.deepEqual(JSON.parse(body.toString('utf8')), { error: 'Invalid request target.' }, why);
      else assert.equal(body.length, 0, `${why}: expected the parser's bare 400 with an empty body`);
    }
    // Same-origin absolute form (proxy-style but local) is equivalent to the plain path.
    const sameOrigin = await rawTarget(port, [`GET http://127.0.0.1:${port}/app.js HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close']);
    assert.match(statusOf(sameOrigin), /^HTTP\/1\.1 200 /, 'a same-origin absolute target must still serve the allowlist');
    assert.deepEqual(bodyOf(sameOrigin), fs.readFileSync(path.join(ROOT, 'app.js')));
    assert.equal(instance.child.exitCode, null);
  } finally {
    await stopChild(instance.child);
  }
});

test('/ping readiness probe: exact GIF pixel, no-store, correct content-length', { timeout: 30000 }, async () => {
  const expected = Buffer.from(PING_GIF_B64, 'base64');
  assert.equal(expected.length, 42);
  const res = await request(prod.port, '/ping');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['content-length'], String(expected.length));
  assert.deepEqual(res.body, expected);
});

test('method handling: non-GET is 405 and no response ever enables CORS', { timeout: 30000 }, async () => {
  const cases = [['PUT', '/'], ['POST', '/ping'], ['DELETE', '/report'], ['HEAD', '/'], ['OPTIONS', '/scan']];
  for (const [method, urlPath] of cases) {
    const res = await request(prod.port, urlPath, { method });
    assert.equal(res.status, 405, `${method} ${urlPath}`);
    if (method !== 'HEAD') assert.deepEqual(asJson(res), { error: 'Method not allowed.' });
  }
  const samples = [
    await request(prod.port, '/'),
    await request(prod.port, '/ping'),
    await request(prod.port, '/nope'),
    await request(prod.port, '/scan', { method: 'POST', headers: { Origin: 'http://evil.example', 'X-DriverLens-Scan': '1' } }),
  ];
  for (const res of samples) {
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['access-control-allow-methods'], undefined);
    assert.equal(res.headers['access-control-allow-headers'], undefined);
  }
});

test('GET /report before any scan: exact 404 and no report file in the contained directory', { timeout: 30000 }, async () => {
  const res = await request(prod.port, '/report');
  assert.equal(res.status, 404);
  assert.deepEqual(asJson(res), { error: 'No local scan saved yet.' });
  assert.equal(fs.existsSync(path.join(workDir, 'driver-report.json')), false);
});

test('scan guards: cross-origin, localhost, null and non-exact headers are rejected before collection', { timeout: 30000 }, async () => {
  const exactOrigin = `http://127.0.0.1:${prod.port}`;
  const reject = [
    [{ 'X-DriverLens-Scan': '1' }, 'missing Origin'],
    [{ Origin: exactOrigin }, 'missing X-DriverLens-Scan'],
    [{ Origin: 'http://evil.example', 'X-DriverLens-Scan': '1' }, 'cross-origin'],
    [{ Origin: `http://localhost:${prod.port}`, 'X-DriverLens-Scan': '1' }, 'localhost origin (127.0.0.1 required)'],
    [{ Origin: 'null', 'X-DriverLens-Scan': '1' }, 'null origin'],
    [{ Origin: `https://127.0.0.1:${prod.port}`, 'X-DriverLens-Scan': '1' }, 'https scheme'],
    [{ Origin: `${exactOrigin}/`, 'X-DriverLens-Scan': '1' }, 'trailing slash'],
    [{ Origin: `${exactOrigin}.evil.example`, 'X-DriverLens-Scan': '1' }, 'suffix trick'],
    [{ Origin: exactOrigin, 'X-DriverLens-Scan': 'true' }, 'header must be exactly "1" (true)'],
    [{ Origin: exactOrigin, 'X-DriverLens-Scan': '01' }, 'header "01" is not "1"'],
  ];
  for (const [headers, why] of reject) {
    const res = await request(prod.port, '/scan', { method: 'POST', headers });
    assert.equal(res.status, 403, why);
    assert.deepEqual(asJson(res), { error: 'Scan must be requested from the local UI.' }, why);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(fs.existsSync(path.join(workDir, 'driver-report.json')), false, 'rejected scans must never run the collector');
});

test('failed collector on the production entrypoint: actionable 500, no report written, busy lock released', { timeout: 30000 }, async () => {
  assert.equal(fs.existsSync(prod.missingPwsh), false, 'the injected DRIVERLENS_POWERSHELL must not exist');
  const scanHeaders = { Origin: `http://127.0.0.1:${prod.port}`, 'X-DriverLens-Scan': '1' };
  const first = await request(prod.port, '/scan', { method: 'POST', headers: scanHeaders });
  assert.equal(first.status, 500);
  const body = asJson(first);
  assert.equal(body.error, INVENTORY_FAILED);
  assert.ok(body.detail.includes('ENOENT'), 'detail must expose the spawn failure: ' + body.detail);
  assert.ok(body.detail.includes(prod.missingPwsh), 'detail must reference the configured missing PowerShell path, proving the injected env was in effect and no real collector ran');
  assert.ok(body.detail.length <= 600, 'detail must be truncated to 600 chars');
  assert.equal(fs.existsSync(path.join(workDir, 'driver-report.json')), false, 'a failed scan must not produce a report');
  const second = await request(prod.port, '/scan', { method: 'POST', headers: scanHeaders });
  assert.equal(second.status, 500, 'the busy lock must be released after a failure (not 409)');
});

test('repository entrypoint smoke: node server.cjs from the repo root serves the UI and readiness', { timeout: 30000 }, async () => {
  const port = await freePort();
  const smoke = spawnServer(path.join(ROOT, 'server.cjs'), {
    DRIVERLENS_PORT: String(port),
    DRIVERLENS_POWERSHELL: prod.missingPwsh,
  });
  try {
    await waitForPing(port, { child: smoke.child, logs: smoke.logs });
    const page = await request(port, '/');
    assert.equal(page.status, 200);
    assert.deepEqual(page.body, fs.readFileSync(path.join(ROOT, 'index.html')));
    assert.equal((await request(port, '/ping')).status, 200);
  } finally {
    await stopChild(smoke.child);
  }
});

// ------------------------------------------------- injected collector harness

test('injected collector success: scan returns the synthetic report, /report serves it, lock resets', { timeout: 30000 }, async () => {
  const fixtureBytes = fs.readFileSync(FIXTURE_REPORT);
  const headers = { Origin: `http://127.0.0.1:${harnessSuccess.port}`, 'X-DriverLens-Scan': '1' };
  const scan = await request(harnessSuccess.port, '/scan', { method: 'POST', headers });
  assert.equal(scan.status, 200);
  assert.equal(scan.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(scan.body, fixtureBytes, 'the scan must return exactly the synthetic report the collector wrote');
  assert.equal(JSON.parse(scan.body.toString('utf8')).devices.length, 2);
  const report = await request(harnessSuccess.port, '/report');
  assert.equal(report.status, 200);
  assert.deepEqual(report.body, fixtureBytes);
  const again = await request(harnessSuccess.port, '/scan', { method: 'POST', headers });
  assert.equal(again.status, 200, 'the busy lock must reset after a successful scan');
  assert.deepEqual(again.body, fixtureBytes);
  assert.equal(fs.existsSync(harnessSuccess.reportPath), true, 'the synthetic report must land in the contained temp directory');
  assert.deepEqual(snapshotRepo(), repoBefore, 'contained collectors must preserve repository files and any existing report');
});

test('pending collector: concurrent scan is 409, guards precede the busy lock, lock resets', { timeout: 60000 }, async () => {
  const postScan = () => request(harnessPending.port, '/scan', {
    method: 'POST',
    headers: { Origin: `http://127.0.0.1:${harnessPending.port}`, 'X-DriverLens-Scan': '1' },
  });
  const firstScan = postScan();
  await delay(200); // loopback: the pending scan request has arrived by now
  let busy = await postScan();
  for (let attempt = 0; attempt < 3 && busy.status !== 409; attempt += 1) {
    assert.equal(busy.status, 200, 'a scan attempt must resolve 200 (started) or 409 (refused)');
    await delay(50);
    busy = await postScan();
  }
  assert.equal(busy.status, 409, 'a concurrent scan must be refused while one is pending');
  assert.deepEqual(asJson(busy), { error: 'A scan is already running.' });
  assert.equal((await request(harnessPending.port, '/ping')).status, 200, 'the server must stay responsive while a scan is pending');
  const guarded = await request(harnessPending.port, '/scan', {
    method: 'POST',
    headers: { Origin: 'http://evil.example', 'X-DriverLens-Scan': '1' },
  });
  assert.equal(guarded.status, 403, 'scan guards are enforced before the busy check');
  const firstResult = await firstScan;
  assert.ok([200, 409].includes(firstResult.status), 'the pending scan resolves as completed (200) or refused (409)');
  let ok = null;
  for (let attempt = 0; attempt < 6 && !ok; attempt += 1) {
    const res = await postScan();
    if (res.status === 200) ok = res;
    else assert.equal(res.status, 409);
  }
  assert.ok(ok, 'scans must succeed again once the pending scan has finished');
  assert.deepEqual(ok.body, fs.readFileSync(FIXTURE_REPORT));
});

test('injected collector failure: 500 with stderr detail and lock released', { timeout: 30000 }, async () => {
  const headers = { Origin: `http://127.0.0.1:${harnessFail.port}`, 'X-DriverLens-Scan': '1' };
  const first = await request(harnessFail.port, '/scan', { method: 'POST', headers });
  assert.equal(first.status, 500);
  const body = asJson(first);
  assert.equal(body.error, INVENTORY_FAILED);
  assert.equal(body.detail, 'synthetic collector stderr detail');
  const second = await request(harnessFail.port, '/scan', { method: 'POST', headers });
  assert.equal(second.status, 500, 'a failure must not leave the server stuck busy');
});

test('injected non-Windows platform: scan is refused with 400 and the collector is never invoked', { timeout: 30000 }, async () => {
  const headers = { Origin: `http://127.0.0.1:${harnessPlatform.port}`, 'X-DriverLens-Scan': '1' };
  const res = await request(harnessPlatform.port, '/scan', { method: 'POST', headers });
  assert.equal(res.status, 400);
  assert.deepEqual(asJson(res), { error: 'Live scanning requires Windows.' });
  assert.equal(fs.existsSync(harnessPlatform.reportPath), false, 'the collector must not run on non-Windows platforms');
  assert.equal((await request(harnessPlatform.port, '/')).status, 200, 'the rest of the surface still works');
  assert.equal((await request(harnessPlatform.port, '/ping')).status, 200);
});

// ------------------------------------------------- static guard invariants

test('static guard invariants: no CORS, no wildcard bind, relative scan POST, loopback-only probe', { timeout: 30000 }, async () => {
  const serverSource = fs.readFileSync(path.join(ROOT, 'server.cjs'), 'utf8');
  assert.equal(serverSource.includes('Access-Control-Allow-Origin'), false, 'the server must never enable CORS');
  assert.equal(serverSource.includes('0.0.0.0'), false, 'the server must never bind a wildcard address');
  assert.match(serverSource, /server\.listen\(port, '127\.0\.0\.1'/);

  const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.ok(appSource.includes("fetch('/scan'"), 'the scan request must stay relative (same-origin)');
  assert.ok(appSource.includes("'X-DriverLens-Scan':'1'"), 'the scan marker header must be sent');
  assert.ok(appSource.includes('http://127.0.0.1:8781/ping'), 'the helper probe must target loopback only');
  assert.equal(appSource.includes('localhost'), false, 'the UI must never use localhost');
  assert.ok(appSource.includes('cannot start local programs'), 'the file:// message must stay honest about not launching programs');
  assert.equal(appSource.includes('no-cors'), false, 'the readiness probe must not rely on opaque (no-cors) fetch success');
  assert.equal(appSource.includes("fetch('http://127.0.0.1:8781/ping'"), false, 'the helper probe must not use a cross-origin fetch');
  assert.ok(appSource.includes('naturalWidth===1'), 'the readiness signal must verify the decoded 1x1 ping pixel');
});

test('repository untouched: no report or new files created by these tests', { timeout: 30000 }, async () => {
  assert.deepEqual(snapshotRepo(), repoBefore);
});
