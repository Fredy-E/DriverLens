// DriverLens saved-report preservation regression.
//
// Running the integration suite must never change the repository — including
// when an owner keeps a saved driver-report.json in the checkout (it is a
// normal, git-ignored file). This suite proves the behavior end to end from a
// contained scratch copy: it copies server.cjs, index.html, app.js, style.css,
// sample.json, Collect-DriverLens.ps1 and tests/ into a fresh temp directory,
// optionally seeds driver-report.json with the explicitly fictional
// tests/fixtures/synthetic-report.json bytes, runs the REAL copied
// tests/integration.test.cjs as a bounded child process, and verifies the
// report's presence and sha256 are exactly unchanged.
//
// No real device inventory is possible: the contained integration suite
// already injects a missing DRIVERLENS_POWERSHELL plus synthetic collector
// harnesses, and this suite additionally points DRIVERLENS_POWERSHELL at a
// nonexistent path inside the scratch copy as a fail-closed backstop.
//
// Report bytes are read only to compute the before/after presence+sha256
// snapshot; report content is never printed in diagnostics.
//
// Only owned directories are removed, and only after the owned process tree
// has exited. A third, dev-only case ("forced timeout") pins that contract
// with a short test-only deadline: the whole owned tree (a test-created parent
// plus a descendant holding a scratch directory as its cwd) must be
// terminated, the scratch directory must stay removable, and the failure must
// identify the timeout instead of being masked by a cleanup (EPERM) error.
// It exercises the same runner as the two real cases; on failure a backstop
// stops the exact owned pids so no probe process is ever left running.
//
// Run: node tests/saved-report.test.cjs
// Focused probe: node --test --test-name-pattern="forced timeout" tests/saved-report.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STORED_FILES = ['server.cjs', 'index.html', 'app.js', 'style.css', 'sample.json', 'Collect-DriverLens.ps1'];
const FIXTURE_REPORT = path.join(__dirname, 'fixtures', 'synthetic-report.json');
const PROBE_PARENT = path.join(__dirname, 'fixtures', 'timeout-probe', 'parent.cjs');
const PROBE_READY_PATTERN = /PROBE-READY (\{[^\n]*\})/;
const CHILD_TIMEOUT_MS = 180000;
const PROBE_TIMEOUT_MS = 4000; // short test-only deadline; the two real cases keep CHILD_TIMEOUT_MS
const PROBE_READY_TIMEOUT_MS = 20000;
const OUTPUT_TAIL_LIMIT = 4000;
const TREE_KILL_TIMEOUT_MS = 10000;
const CLOSE_TIMEOUT_MS = 15000;
const IS_WINDOWS = process.platform === 'win32';
// Trusted full path to the Windows tree killer; spawned directly (no shell,
// never resolved through PATH).
const WINDOWS_TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sha256Of = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

function snapshotReport(reportPath) {
  return fs.existsSync(reportPath)
    ? { present: true, sha256: sha256Of(reportPath) }
    : { present: false, sha256: null };
}

// ---------------------------------------------------------------- capture

// Hard-bounded rolling output tail: memory stays at ~limit chars per stream no
// matter how much the child prints, while totalChars keeps the true size so a
// trimmed tail is still diagnosable ("…(trimmed N of M captured chars)…").
class RollingTail {
  constructor(limit = OUTPUT_TAIL_LIMIT) {
    this.limit = limit;
    this.data = '';
    this.totalChars = 0;
  }

  push(chunk) {
    const text = String(chunk);
    this.totalChars += text.length;
    this.data += text;
    if (this.data.length > this.limit) this.data = this.data.slice(-this.limit);
    return this;
  }

  text() {
    return this.data;
  }

  get trimmedChars() {
    return Math.max(0, this.totalChars - this.data.length);
  }

  format() {
    const clean = this.data.replace(/\u001b\[[0-9;]*m/g, '');
    return this.trimmedChars > 0
      ? `…(trimmed ${this.trimmedChars} of ${this.totalChars} captured chars)…\n${clean}`
      : clean;
  }
}

// ---------------------------------------------------------------- process tree

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists but not signalable
  }
}

// Terminates the whole owned process tree rooted at pid, bounded in time, and
// resolves with a truthful outcome (never throws for the common races).
//   Windows: spawns the trusted %SystemRoot%\System32\taskkill.exe directly
//   with ['/PID', pid, '/T', '/F'] — normal Windows flags, no shell — and
//   waits for it with a bound. An already-exited process or taskkill's
//   "not found" result is reported, not treated as an error.
//   POSIX: the runner spawns its children detached, i.e. each child leads its
//   own process group (pgid === child pid), so the group is killed. It never
//   targets a group the runner did not create — in particular never the
//   calling runner's own group.
function terminateProcessTree(pid, { timeoutMs = TREE_KILL_TIMEOUT_MS } = {}) {
  if (!isPidAlive(pid)) return Promise.resolve({ ok: true, method: 'none', detail: 'already exited' });

  if (IS_WINDOWS) {
    return new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };

      let killer;
      try {
        killer = spawn(WINDOWS_TASKKILL, ['/PID', String(pid), '/T', '/F'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        settle({ ok: false, method: 'taskkill', detail: `spawn threw: ${error.message}` });
        return;
      }

      const output = new RollingTail(1000);
      killer.stdout.on('data', (chunk) => output.push(chunk));
      killer.stderr.on('data', (chunk) => output.push(chunk));
      killer.once('error', (error) => settle({ ok: false, method: 'taskkill', detail: `spawn error: ${error.code || error.message}` }));
      killer.once('close', (code) => {
        const text = output.format().trim();
        const notFound = code === 128 || /not found/i.test(text);
        settle({ ok: code === 0 || notFound, method: 'taskkill /PID /T /F', detail: `exit ${code}${text ? `: ${text}` : ''}` });
      });
      timer = setTimeout(() => {
        try {
          killer.kill();
        } catch {
          /* already gone */
        }
        settle({ ok: false, method: 'taskkill', detail: `did not finish within ${timeoutMs} ms` });
      }, timeoutMs);
    });
  }

  return new Promise((resolve) => {
    try {
      process.kill(-pid, 'SIGKILL');
      resolve({ ok: true, method: 'process group SIGKILL', detail: '' });
    } catch (error) {
      if (error.code === 'ESRCH') {
        resolve({ ok: true, method: 'process group SIGKILL', detail: 'already gone (ESRCH)' });
        return;
      }
      try {
        process.kill(pid, 'SIGKILL');
        resolve({ ok: true, method: 'direct SIGKILL fallback', detail: `group kill failed: ${error.code}` });
      } catch (fallbackError) {
        resolve({ ok: false, method: 'SIGKILL', detail: `group: ${error.code}; direct: ${fallbackError.code}` });
      }
    }
  });
}

// ---------------------------------------------------------------- runner

// Shared bounded runner, used by both the real contained-integration runs and
// the forced-timeout probe. Captures stdout/stderr as bounded rolling tails
// (no unbounded accumulation), records a real ready signal when a readyPattern
// is provided, and — on timeout — is required to terminate the whole owned
// process tree before resolving, so the caller can safely remove the scratch
// directory and no descendant is left holding it.
// Returns { child, pid, ready, done }: `ready` resolves with the parsed signal
// (or null when no readyPattern), `done` resolves with the run result.
function runContainedNode({ scriptPath, cwd, env, timeoutMs = CHILD_TIMEOUT_MS, readyPattern = null, label = 'contained child' }) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: dedicate a process group per child so timeout termination can kill
    // the whole owned tree by group. Windows keeps the default (taskkill walks
    // the process tree instead; detached would also pop a console window).
    detached: !IS_WINDOWS,
    windowsHide: true,
  });

  const stdout = new RollingTail(OUTPUT_TAIL_LIMIT);
  const stderr = new RollingTail(OUTPUT_TAIL_LIMIT);
  const startedAt = Date.now();
  const state = { exitSeen: false, closeSeen: false, code: null, signal: null, spawnError: null };

  let readySeen = false;
  let readyInfo = null;
  let readyLine = '';
  let resolveReady = null;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  if (!readyPattern) resolveReady(null);

  child.stdout.on('data', (chunk) => {
    stdout.push(chunk);
    if (readyPattern && !readySeen) {
      readyLine += String(chunk);
      if (readyLine.length > 8192) readyLine = readyLine.slice(-8192);
      const match = readyLine.match(readyPattern);
      if (match) {
        readySeen = true;
        readyInfo = { line: match[0], payload: match[1] !== undefined ? match[1] : match[0], atMs: Date.now() - startedAt };
        resolveReady(readyInfo);
      }
    }
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  // Timeout path: terminate the WHOLE owned process tree (parent plus
  // descendants, including detached ones), then wait — bounded — for the child
  // to close. A direct child.kill() is not enough: a surviving descendant that
  // holds the scratch directory as its cwd makes fs.rmSync fail with EPERM and
  // would replace the timeout diagnostic with a cleanup error (see the
  // forced-timeout probe). Already-exited races are handled by not signalling
  // an exited child (pid-reuse safety), and taskkill's "not found" result is
  // reported as success — the process is gone either way — never thrown.
  const done = new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let termination = null;
    let terminationSettled = false;
    let closeWaitTimer = null;

    const emit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeWaitTimer) clearTimeout(closeWaitTimer);
      resolve({
        label,
        pid: child.pid,
        code: state.code,
        signal: state.signal,
        spawnError: state.spawnError,
        timedOut,
        readySeen,
        ready: readyInfo,
        termination,
        closeConfirmed: state.closeSeen,
        stdout: stdout.format(),
        stderr: stderr.format(),
        elapsedMs: Date.now() - startedAt,
      });
    };

    // Bounded wait for the child's 'close' (stdio fully flushed). Armed only
    // when the child cannot be expected to close on its own any more (failed
    // spawn, or after the exit/timeout window): emits with closeConfirmed=false
    // instead of waiting indefinitely.
    const armCloseWait = (ms) => {
      if (closeWaitTimer || state.closeSeen) return;
      closeWaitTimer = setTimeout(() => emit(), ms);
    };

    const maybeEmit = () => {
      if (settled) return;
      if (!state.closeSeen) {
        armCloseWait(CLOSE_TIMEOUT_MS);
        return;
      }
      if (timedOut && !terminationSettled) return; // wait for the bounded tree-kill outcome
      emit();
    };

    child.once('error', (error) => {
      state.spawnError = error.message;
      // A failed spawn may never emit 'close': bound the wait, then report.
      armCloseWait(2000);
    });
    child.once('exit', (code, signal) => {
      state.exitSeen = true;
      state.code = code;
      state.signal = signal;
      // 'close' normally follows 'exit' within milliseconds; bound it anyway.
      armCloseWait(CLOSE_TIMEOUT_MS);
    });
    child.once('close', (code, signal) => {
      state.closeSeen = true;
      state.exitSeen = true;
      state.code = code;
      state.signal = signal;
      maybeEmit();
    });

    const timer = setTimeout(() => {
      if (state.exitSeen) {
        // Raced: the child exited on its own at/near the deadline — do not
        // signal anything; just bound the remaining stdio flush and report.
        armCloseWait(CLOSE_TIMEOUT_MS);
        return;
      }
      timedOut = true;
      if (child.pid == null) {
        termination = { ok: false, method: 'none', detail: 'no pid (spawn failed)' };
        terminationSettled = true;
        maybeEmit();
        return;
      }
      terminateProcessTree(child.pid, { timeoutMs: TREE_KILL_TIMEOUT_MS }).then((result) => {
        termination = result;
        terminationSettled = true;
        if (!result.ok && !state.exitSeen) {
          // Last resort when the tree killer failed: signal the direct child
          // (descendants may remain; `termination` above stays truthful).
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }
        maybeEmit();
      });
    }, timeoutMs);
  });

  return { child, pid: child.pid, ready, done };
}

// Runs the real (copied) integration suite through the shared runner above.
function runContainedIntegration(scratchDir) {
  // The contained suite creates its own work directory under os.tmpdir()
  // (driverlens-integration-*). Point TMP/TEMP/TMPDIR into the owned scratch
  // dir: any residue a timeout-killed run leaves behind (its after() hook can
  // never run after a kill) is then removed together with the scratch dir
  // instead of littering the shared temp directory. The 'tmp' entry is created
  // before the suite starts, so the contained suite's own before/after
  // repository snapshot compares identical listings.
  const containedTmp = path.join(scratchDir, 'tmp');
  fs.mkdirSync(containedTmp, { recursive: true });
  return runContainedNode({
    scriptPath: path.join(scratchDir, 'tests', 'integration.test.cjs'),
    cwd: scratchDir,
    env: {
      ...process.env,
      TMP: containedTmp,
      TEMP: containedTmp,
      TMPDIR: containedTmp,
      // Fail-closed backstop: if any spawned server ever ran without its own
      // injected missing-pwsh path, this nonexistent executable still prevents
      // a live inventory.
      DRIVERLENS_POWERSHELL: path.join(scratchDir, 'no-live-collector', 'pwsh.exe'),
    },
    timeoutMs: CHILD_TIMEOUT_MS,
    label: 'contained integration suite',
  });
}

// ---------------------------------------------------------------- diagnostics

function resultSummary(stdout) {
  const pass = stdout.match(/(?:ℹ|#)\s*pass (\d+)/);
  const fail = stdout.match(/(?:ℹ|#)\s*fail (\d+)/);
  return pass || fail
    ? ` (contained suite: pass ${pass ? pass[1] : '?'}, fail ${fail ? fail[1] : '?'})`
    : '';
}

// The exact diagnostic surfaced for a timed-out run. Kept as one function so
// the forced-timeout probe asserts the same text the real cases produce; a
// cleanup error must never replace it (see runCase below).
function timeoutFailureMessage(label, timeoutMs, result) {
  const termination = result && result.termination
    ? `${result.termination.method}${result.termination.detail ? ` (${result.termination.detail})` : ''}`
    : 'no tree termination recorded';
  return `${label}: the contained run exceeded ${timeoutMs} ms and was terminated.\n` +
    `Termination: ${termination}; closeConfirmed=${result ? result.closeConfirmed : '?'}.\n` +
    `Report bytes are hashed only for the before/after snapshot; no report content is printed by this suite.\n` +
    `--- child stdout (tail) ---\n${result ? result.stdout : ''}\n--- child stderr (tail) ---\n${result ? result.stderr : ''}`;
}

// ---------------------------------------------------------------- scratch cleanup

// Removes only the owned scratch directory (bounded retries for transient
// Windows locks) and RETURNS any error instead of throwing, so a cleanup error
// can never replace a primary test failure. If the owned runner is somehow
// still alive, terminate it once and retry.
async function finalizeOwnedScratch(scratchDir, run) {
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    return null;
  } catch (error) {
    if (run && Number.isInteger(run.pid) && isPidAlive(run.pid)) {
      await terminateProcessTree(run.pid, { timeoutMs: TREE_KILL_TIMEOUT_MS });
      await delay(250);
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
        return null;
      } catch (retryError) {
        return retryError;
      }
    }
    return error;
  }
}

// ---------------------------------------------------------------- probe helpers

// Recovers the descendant pid from the probe's on-disk ready record (backstop
// path: the record exists even if the stdout line was never observed).
function recoverProbeDescendant(scratchDir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(scratchDir, 'descendant-ready.json'), 'utf8'));
    return Number.isInteger(record.pid) && record.pid > 0 ? record : null;
  } catch {
    return null;
  }
}

// Backstop: stops the exact owned probe pids (nothing else), bounded, and
// reports honestly what happened. Runs even when the probe failed, so a failing
// probe can never leave its processes behind.
async function stopOwnedPids(pids) {
  const report = [];
  for (const pid of pids) {
    for (let attempt = 0; attempt < 2 && isPidAlive(pid); attempt += 1) {
      const outcome = await terminateProcessTree(pid, { timeoutMs: TREE_KILL_TIMEOUT_MS });
      await delay(150);
      report.push(`pid ${pid}: ${outcome.method}${outcome.detail ? ` (${outcome.detail})` : ''}; alive after stop=${isPidAlive(pid)}`);
    }
  }
  return report;
}

// ---------------------------------------------------------------- real cases

function copyContained(scratchDir) {
  for (const file of STORED_FILES) {
    fs.copyFileSync(path.join(ROOT, file), path.join(scratchDir, file));
  }
  fs.cpSync(path.join(ROOT, 'tests'), path.join(scratchDir, 'tests'), { recursive: true });
}

async function runCase(t, { seed }) {
  const label = seed ? 'seeded' : 'unseeded';
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), `driverlens-saved-report-${label}-`));
  const reportPath = path.join(scratchDir, 'driver-report.json');
  let run = null;
  let primaryError = null;
  try {
    copyContained(scratchDir);
    assert.equal(
      fs.existsSync(path.join(scratchDir, 'tests', 'integration.test.cjs')),
      true,
      'the scratch copy must contain the real integration suite',
    );
    if (seed) fs.copyFileSync(FIXTURE_REPORT, reportPath); // explicitly fictional fixture only
    const before = snapshotReport(reportPath);
    if (seed) {
      assert.equal(before.sha256, sha256Of(FIXTURE_REPORT), 'the seeded copy must start with the exact synthetic fixture bytes');
    } else {
      assert.deepEqual(before, { present: false, sha256: null }, 'the unseeded copy must not contain a report');
    }

    run = await runContainedIntegration(scratchDir).done;
    const after = snapshotReport(reportPath);

    if (run.spawnError) {
      assert.fail(`saved-report ${label}: the contained integration suite could not be spawned: ${run.spawnError}`);
    }
    if (run.timedOut) {
      assert.fail(timeoutFailureMessage(`saved-report ${label}`, CHILD_TIMEOUT_MS, run));
    }
    if (run.code !== 0) {
      assert.fail(
        `saved-report ${label}: the contained integration suite failed (exit ${run.code}, signal ${run.signal || 'none'}).\n` +
        `Hint: when the output mentions "no report may be written into the repository", the integration suite is asserting\n` +
        `report absence in the repository instead of preserving repository state; it must compare before/after snapshots.\n` +
        `Report bytes are hashed only for the before/after snapshot; no report content is printed by this suite.\n` +
        `--- child stdout (tail) ---\n${run.stdout}\n--- child stderr (tail) ---\n${run.stderr}`,
      );
    }
    assert.deepEqual(
      after,
      before,
      `saved-report ${label}: the contained integration suite must leave driver-report.json exactly as found (presence and sha256)`,
    );
    t.diagnostic(`saved-report ${label}: PASS — report unchanged ${JSON.stringify(after)}${resultSummary(run.stdout)}`);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // The run resolved only after the child exited (or was terminated, with a
    // bounded close wait); remove only the owned scratch directory. A cleanup
    // error must never mask a primary failure.
    const cleanupError = await finalizeOwnedScratch(scratchDir, run);
    if (cleanupError && !primaryError) {
      throw new Error(
        `saved-report ${label}: the owned scratch directory could not be removed after a successful run (${cleanupError.code}): ${cleanupError.message}`,
      );
    }
    if (cleanupError) {
      t.diagnostic(`saved-report ${label}: cleanup could not remove the scratch directory (${cleanupError.code}); the primary failure above is preserved`);
    }
  }
}

test('saved-report unseeded: contained integration suite passes and leaves no report behind', { timeout: 240000 }, async (t) => {
  await runCase(t, { seed: false });
});

test('saved-report seeded: contained integration suite passes and preserves the existing report', { timeout: 240000 }, async (t) => {
  await runCase(t, { seed: true });
});

// ---------------------------------------------------------------- forced-timeout probe

// Dev-only forced-timeout probe: creates its own parent+descendant fixture
// processes (no app code, no inventory) and runs them through the SAME runner
// used by the two real cases, with a short test-only deadline. The descendant
// holds a scratch directory as its cwd and is spawned detached on Windows, so
// it deliberately escapes the implicit job-object cleanup a plain child gets:
// the timeout path must terminate the whole owned tree explicitly, or the
// surviving descendant blocks scratch removal with EPERM and replaces the
// timeout diagnostic (the finding). On failure a backstop stops the exact
// owned pids so no probe process is left running.
test('forced timeout: the timeout path terminates the whole owned process tree and keeps the scratch directory removable', { timeout: 120000 }, async (t) => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driverlens-timeout-probe-'));
  const holdDir = path.join(scratchDir, 'held-cwd');
  fs.mkdirSync(holdDir);

  // Helper unit check: the rolling capture is hard-bounded in memory and keeps
  // the true captured count for diagnostics.
  const flood = new RollingTail(1000);
  for (let index = 0; index < 300; index += 1) flood.push('x'.repeat(1000));
  assert.equal(flood.text().length, 1000, 'captured output must stay at the tail limit');
  assert.equal(flood.trimmedChars, 299000, 'the trimmed count must reflect everything captured');

  let handle = null;
  let result = null;
  let descendantPid = null;
  let primaryError = null;
  try {
    handle = runContainedNode({
      scriptPath: PROBE_PARENT,
      cwd: scratchDir,
      env: { ...process.env, PROBE_SCRATCH: scratchDir, PROBE_HOLD_CWD: holdDir },
      timeoutMs: PROBE_TIMEOUT_MS,
      readyPattern: PROBE_READY_PATTERN,
      label: 'timeout probe',
    });

    // Wait for the real ready signal (or the run's own resolution), bounded.
    const outcome = await Promise.race([
      handle.ready.then((info) => ({ kind: 'ready', info })),
      handle.done.then((res) => ({ kind: 'done', res })),
      delay(PROBE_READY_TIMEOUT_MS).then(() => ({ kind: 'deadline' })),
    ]);
    if (outcome.kind === 'done') result = outcome.res;
    assert.equal(
      outcome.kind,
      'ready',
      `the probe parent must deliver a real PROBE-READY signal before the ${PROBE_TIMEOUT_MS} ms deadline (got: ${outcome.kind}` +
        `${outcome.kind === 'done' ? `; timedOut=${result.timedOut}; stderr tail: ${String(result.stderr).slice(-400)}` : ''})`,
    );
    const record = (() => {
      try {
        return JSON.parse(outcome.info.payload);
      } catch {
        return null;
      }
    })();
    assert.ok(record && Number.isInteger(record.descendantPid), `the ready record must carry the descendant pid: ${outcome.info.payload}`);
    assert.equal(record.marker, 'driverlens-timeout-probe', 'the ready record must come from the probe descendant');
    assert.equal(
      path.resolve(String(record.descendantCwd)).toLowerCase(),
      path.resolve(holdDir).toLowerCase(),
      'the descendant must be holding the probe scratch cwd when it reports ready',
    );
    descendantPid = record.descendantPid;
    assert.equal(isPidAlive(descendantPid), true, 'the descendant must be alive once it has written its ready record');

    result = await handle.done;
    assert.equal(result.timedOut, true, `the probe must hit the ${PROBE_TIMEOUT_MS} ms test-only deadline`);
    assert.equal(result.readySeen, true, 'the runner must have recorded the real ready signal');

    const parentAlive = isPidAlive(result.pid);
    const descendantAlive = isPidAlive(descendantPid);
    let removalError = null;
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch (error) {
      removalError = error;
    }
    const outcomeLine =
      `[forced-timeout probe] parent(${result.pid}) alive=${parentAlive}; descendant(${descendantPid}) alive=${descendantAlive}; ` +
      `scratch removable=${removalError === null}${removalError ? ` (${removalError.code})` : ''}; ` +
      `termination=${JSON.stringify(result.termination)}; closeConfirmed=${result.closeConfirmed}; timedOut=${result.timedOut}`;
    t.diagnostic(outcomeLine);
    console.log(outcomeLine);

    assert.equal(
      descendantAlive,
      false,
      `descendant pid ${descendantPid} is still alive after the forced timeout: the timeout path must terminate the whole owned tree ` +
        `(descendants holding the scratch cwd leak and break cleanup)`,
    );
    assert.equal(parentAlive, false, `probe parent pid ${result.pid} is still alive after the forced timeout`);
    if (removalError) {
      assert.fail(`the owned scratch directory is not removable after the forced timeout (${removalError.code}): ${removalError.message}`);
    }

    const diagnostic = timeoutFailureMessage('saved-report probe', PROBE_TIMEOUT_MS, result);
    assert.match(diagnostic, new RegExp(`exceeded ${PROBE_TIMEOUT_MS} ms and was terminated`), 'the surfaced failure must identify the timeout');
    assert.equal(diagnostic.includes('EPERM'), false, 'the timeout diagnostic must not be replaced by a cleanup (EPERM) error');
    assert.ok(
      result.termination && result.termination.ok === true,
      `the timeout path must record a successful tree termination: ${JSON.stringify(result.termination)}`,
    );
    assert.match(
      String(result.termination && result.termination.method),
      IS_WINDOWS ? /taskkill/ : /SIGKILL/,
      'the tree must be terminated with the platform tree killer',
    );
    assert.equal(result.closeConfirmed, true, 'the runner must not resolve before the child streams have closed');
    t.diagnostic('forced-timeout probe: PASS — tree terminated, scratch removable, timeout identified');
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Backstop (always runs): stop the exact owned pids if anything is still
    // alive, then remove the scratch dir; a backstop error must never replace
    // the primary failure.
    const recovered = recoverProbeDescendant(scratchDir);
    const candidates = [];
    for (const pid of [result && result.pid, handle && handle.pid, descendantPid, recovered && recovered.pid]) {
      if (Number.isInteger(pid) && pid > 0 && !candidates.includes(pid)) candidates.push(pid);
    }
    const stopReport = await stopOwnedPids(candidates);
    if (stopReport.length) console.log(`[forced-timeout probe backstop] ${stopReport.join(' | ')}`);
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      t.diagnostic(`probe backstop: scratch removal still failing (${cleanupError.code}); the primary failure is preserved`);
    }
  }
});
