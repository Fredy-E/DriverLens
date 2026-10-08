// Static invariants for Start-DriverLens.cmd — the one-click launcher.
//
// These checks are static (file-level) because executing the launcher would
// start a server and open a browser on the user's desktop. The assertions pin:
//   - CRLF line endings (batch labels/goto are only reliable on Windows EOLs)
//   - Node.js and PowerShell 7 prerequisite handling with honest guidance
//   - readiness detection by polling the real /ping pixel (bounded), NOT a fixed
//     blind sleep and NOT any HTTP 200; a timeout reports failure without opening
//     the browser
//   - loopback-only URLs and that the browser opens only after readiness
//
// Run: node tests/launcher.test.cjs
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const launcherPath = path.join(ROOT, 'Start-DriverLens.cmd');
const raw = fs.readFileSync(launcherPath);
const text = raw.toString('utf8');

test('launcher uses CRLF line endings throughout', () => {
  const stripped = raw.toString('latin1').replace(/\r\n/g, '');
  assert.equal(stripped.includes('\n'), false, 'found a bare LF (batch files must be CRLF)');
  assert.equal(/\r(?!\n)/.test(raw.toString('latin1')), false, 'found a bare CR');
  assert.ok(raw.toString('latin1').includes('\r\n'), 'expected CRLF line endings');
});

test('launcher checks the Node.js prerequisite and stops with guidance when missing', () => {
  assert.match(text, /where node >nul 2>nul/);
  assert.match(text, /Node\.js is required to run DriverLens\. Get it at https:\/\/nodejs\.org and try again\./);
  assert.match(text, /pause/);
  assert.match(text, /exit \/b 1/);
});

test('launcher checks the PowerShell 7 prerequisite with non-fatal guidance', () => {
  assert.match(text, /where pwsh >nul 2>nul/);
  assert.match(text, /PowerShell 7 was not found on PATH/);
  assert.match(text, /https:\/\/aka\.ms\/powershell/);
  assert.match(text, /DRIVERLENS_POWERSHELL/);
  // the pwsh advisory must not abort the launcher: its own block contains no exit /b
  // (exit /b appears later only in the success terminator and the :notready path)
  const pwshBlock = text.slice(text.indexOf('where pwsh'), text.indexOf(':waitready'));
  assert.equal(/exit \/b/.test(pwshBlock), false, 'the pwsh check must not terminate the launcher');
});

test('launcher waits for real readiness (bounded /ping pixel poll) instead of a fixed blind sleep', () => {
  assert.match(text, /\/ping/); // readiness endpoint actually probed
  // identity is the real /ping GIF (image/gif + the exact 42-byte pixel), not any HTTP 200
  assert.match(text, /'image\/gif'/);
  assert.match(text, /RawContentLength -eq 42/);
  assert.match(text, /:waitready/);
  assert.match(text, /goto waitready/);
  assert.match(text, /set \/a tries\+=1/);
  assert.match(text, /if %tries% geq 15 goto notready/); // bounded, and a timeout must not open the UI
  assert.equal(text.includes('timeout /t 2 /nobreak'), false, 'the old fixed two-second sleep must be gone');
  // the browser is opened only after the readiness block
  assert.ok(text.indexOf('start "" "http://127.0.0.1:8781"') > text.indexOf(':openui'), 'browser opens after readiness handling');
  // readiness pre-check for an already-running server validates the /ping pixel too
  assert.match(text, /Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http:\/\/127\.0\.0\.1:8781\/ping'/);
  assert.match(text, /if not errorlevel 1 goto running/);
  assert.equal(/TimeoutSec 2 'http:\/\/127\.0\.0\.1:8781\/'/.test(text), false, 'the bare root URL must not be used as server identity');
});

test('launcher reports a clear failure on readiness timeout instead of opening the browser', () => {
  const notreadyIdx = text.indexOf(':notready');
  assert.ok(notreadyIdx > 0, 'the launcher must have a :notready timeout label');
  const section = text.slice(notreadyIdx);
  assert.match(section, /did not become ready/i);
  assert.equal(section.includes('start "" "http'), false, 'the timeout path must never open the browser');
  assert.match(section, /pause/);
  assert.match(section, /exit \/b 1/);
  const openuiSection = text.slice(text.indexOf(':openui'), notreadyIdx);
  assert.match(openuiSection, /exit \/b 0/, 'the success path must end before :notready (no fall-through)');
});

test('launcher uses loopback URLs only and runs from its own folder', () => {
  assert.equal(text.includes('localhost'), false, 'the launcher must never use localhost (the server rejects it by design)');
  assert.match(text, /cd \/d "%~dp0\."/);
  assert.match(text, /setlocal/);
  assert.match(text, /start "" "http:\/\/127\.0\.0\.1:8781"/);
});
