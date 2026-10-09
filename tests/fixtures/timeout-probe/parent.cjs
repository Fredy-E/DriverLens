// Dev-only probe parent for tests/saved-report.test.cjs (forced-timeout
// regression). Spawns a descendant whose working directory is PROBE_HOLD_CWD
// (a directory inside the probe scratch dir), waits for the descendant's
// on-disk ready record (a real signal — no fixed sleep), then prints a
// PROBE-READY line on stdout and stays alive until it is terminated.
// The descendant keeps the held cwd locked while it lives, exactly like the
// contained integration suite's harness servers hold the scratch copy.
// No network, no device data, no system changes.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const scratch = process.env.PROBE_SCRATCH;
const holdCwd = process.env.PROBE_HOLD_CWD;
if (!scratch || !holdCwd) {
  console.error('probe parent: PROBE_SCRATCH and PROBE_HOLD_CWD are required');
  process.exit(2);
}
const readyFile = path.join(scratch, 'descendant-ready.json');

// The descendant is spawned detached on Windows so it deliberately ESCAPES the
// implicit job-object cleanup Windows applies to plain child processes: a
// runner that only signals the direct child (child.kill()) must not rely on
// that implicit mechanism — it does not cover detached children, and it can
// fail outside plain local runs. On POSIX no implicit child cleanup exists, so
// a plain child is enough and it stays within the parent's process group,
// which the runner's group termination then reaches.
const descendant = spawn(process.execPath, [path.join(__dirname, 'descendant.cjs')], {
  cwd: holdCwd,
  env: { ...process.env },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: process.platform === 'win32',
  windowsHide: true,
});
descendant.once('error', (error) => {
  console.error(`probe parent: descendant spawn failed: ${error.message}`);
  process.exit(3);
});

const deadline = Date.now() + 15000;
const poll = () => {
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
  } catch {
    record = null; // missing or mid-write; retry
  }
  if (record && Number.isInteger(record.pid) && record.pid > 0) {
    process.stdout.write(
      `PROBE-READY ${JSON.stringify({ descendantPid: record.pid, descendantCwd: record.cwd, marker: record.marker })}\n`,
    );
    setInterval(() => {}, 1000); // stay alive until terminated by the runner
    return;
  }
  if (Date.now() > deadline) {
    console.error('probe parent: descendant never became ready');
    process.exit(2);
  }
  setTimeout(poll, 25);
};
poll();
