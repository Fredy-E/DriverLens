// Dev-only probe descendant for tests/saved-report.test.cjs (forced-timeout
// regression). Writes a ready record carrying its own pid and its working
// directory — a real on-disk record, not a sleep — then holds that working
// directory (set by the parent via cwd) until it is terminated.
// No network, no device data, no system changes.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const scratch = process.env.PROBE_SCRATCH;
if (!scratch) {
  console.error('probe descendant: PROBE_SCRATCH is required');
  process.exit(2);
}

const readyFile = path.join(scratch, 'descendant-ready.json');
const record = { pid: process.pid, cwd: process.cwd(), marker: 'driverlens-timeout-probe' };
// Write-then-rename so the parent never reads a partially written record.
fs.writeFileSync(`${readyFile}.tmp`, `${JSON.stringify(record)}\n`);
fs.renameSync(`${readyFile}.tmp`, readyFile);

setInterval(() => {}, 1000); // hold this cwd until terminated
