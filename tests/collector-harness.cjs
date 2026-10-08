// Test-only child process for tests/integration.test.cjs.
// Serves the real DriverLens request handler (../server.cjs) with an injected
// synthetic collector, so the scan success / pending / failure paths can be
// exercised over real HTTP without ever running Collect-DriverLens.ps1 or
// reading any real device data.
//
// Required environment:
//   DRIVERLENS_TEST_MODE    success | pending | fail | platform
//   DRIVERLENS_TEST_PORT    port to listen on (loopback only)
//   DRIVERLENS_TEST_REPORT  report path the synthetic collector writes to
//   DRIVERLENS_TEST_FIXTURE synthetic report fixture to copy on success
// Optional:
//   DRIVERLENS_TEST_DELAY   pending-mode delay in ms (default 750)
'use strict';
const fs = require('node:fs');
const { createServer } = require('../server.cjs');

const mode = process.env.DRIVERLENS_TEST_MODE;
const allowed = new Set(['success', 'pending', 'fail', 'platform']);
if (!allowed.has(mode)) {
  console.error('collector-harness: DRIVERLENS_TEST_MODE must be one of ' + [...allowed].join(', '));
  process.exit(2);
}
const port = Number(process.env.DRIVERLENS_TEST_PORT);
const reportPath = process.env.DRIVERLENS_TEST_REPORT;
const fixturePath = process.env.DRIVERLENS_TEST_FIXTURE;
const delayMs = Number(process.env.DRIVERLENS_TEST_DELAY || 750);
if (!port || !reportPath || !fixturePath) {
  console.error('collector-harness: DRIVERLENS_TEST_PORT, DRIVERLENS_TEST_REPORT and DRIVERLENS_TEST_FIXTURE are required');
  process.exit(2);
}

const runCollector = (done) => {
  const finish = () => {
    if (mode === 'fail') return done(new Error('synthetic collector failure'), '', 'synthetic collector stderr detail');
    fs.copyFileSync(fixturePath, reportPath);
    done(null, 'synthetic collector output', '');
  };
  if (mode === 'pending') setTimeout(finish, delayMs);
  else setImmediate(finish);
};

const { server, port: boundPort } = createServer({
  port,
  reportPath,
  platform: mode === 'platform' ? 'linux' : 'win32',
  runCollector,
});
server.listen(boundPort, '127.0.0.1', () => console.log(`collector-harness ready: http://127.0.0.1:${boundPort}`));
