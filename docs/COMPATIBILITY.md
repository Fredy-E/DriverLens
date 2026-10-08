# Compatibility and verification matrix

Honest record of what DriverLens has actually been verified to do, on which
platform, and what remains unverified. If something is not listed as verified
here, treat it as unverified.

**Verification pass:** 2026-10-08 on Windows 11 ARM64 (Node 26.7.0, PowerShell
7.6.6, system Chrome 154, Playwright 1.63.0). CI runs the same checks on
GitHub's `windows-11-arm` runner (Node 24) — including the browser test with
Playwright's bundled Chromium.

## What each check proves

| Check | What it runs | What it proves |
|---|---|---|
| `Test-Collector.ps1` | Synthetic PE/INF fixtures built locally | PE machine-type parsing and INF decoration parsing only |
| `tests/launcher.test.cjs` | Static file invariants of `Start-DriverLens.cmd` | Prerequisite checks, CRLF, bounded `/ping` pixel readiness poll (no fixed sleep); a timeout reports failure instead of opening the browser |
| `tests/integration.test.cjs` | Real spawned servers over real HTTP | Request guards, static allowlist, traversal resistance, malformed/foreign request-target rejection, `/ping`, scan state machine (synthetic collectors) |
| `tests/browser.test.cjs` | Real Chrome via Playwright | `file://` page → helper auto-connect (down→up and already-up) → synthetic report import; a wrong service on port 8781 is never adopted |

## Matrix

| Area | How it is verified | Status |
|---|---|---|
| PE parsing: ARM64, ARM64EC, ARM64X fixtures | Synthetic fixtures (local + CI) | ✅ Verified |
| PE parsing: x86, x64 fixtures | Synthetic fixtures (local + CI) | ✅ Verified — **fixture parsing only**; no x86/x64 hardware was used |
| Malformed PE rejection | Synthetic fixture | ✅ Verified |
| INF architecture decorations | Synthetic fixture | ✅ Verified |
| Loopback-only listening (`127.0.0.1`) | Integration test (netstat + HTTP) | ✅ Verified |
| Host guard (localhost, wrong port, external hosts, IPv6 spelling) | Integration test | ✅ Verified |
| `/scan` guards (exact Origin + `X-DriverLens-Scan: 1`; no CORS anywhere) | Integration test | ✅ Verified |
| Static allowlist + path-traversal resistance | Integration test | ✅ Verified |
| `/ping` readiness + `file://` auto-connect + report import | Browser test: Chrome 154 locally; bundled Chromium in CI mode | ✅ Verified locally; the CI step runs it after installing the bundled browser and fails loudly if none can launch |
| Wrong service on `127.0.0.1:8781` (404/200 text) is never adopted; malformed request targets get a 400 without killing the helper | Browser test (wrong-service variants) + integration test (raw request targets) | ✅ Verified |
| Launcher prerequisites / CRLF / bounded readiness | Static invariants | ✅ Verified |
| Live inventory on real ARM64 hardware | — | ⚠️ Not run by any test (privacy: no test collects real device data). User-initiated local runs only |
| Live inventory on x86 / x64 hardware | — | ❌ Unverified — no x86/x64 hardware in this pass |
| Windows versions other than 11, other device classes | — | ❌ Unverified |
| Driver signature status | `Win32_PnPSignedDriver` `IsSigned` metadata | ⚠️ Metadata only — not a cryptographic verification of files |
| Bundled browser under Windows ARM64 | Playwright ships an x64 Chromium that runs under Windows ARM64 emulation | ✅ Runs (verified locally) |

## Claims this project does not make

- No x86/x64 hardware compatibility certification; fixture parsing is not hardware testing.
- “Observed” in a report is not a compatibility statement.
- Signature metadata is not a fresh cryptographic check of driver files.
- No test collects a real device report; fixtures are synthetic (Contoso /
  Adventure Works fictional devices) and reports stay local.
- The `file://` page cannot start programs; it only connects to a helper the
  user already started. There is no zero-click launch.
- Readiness checks are a liveness/identity signal (the helper's `/ping` pixel), not cryptographic authentication.

## Reproduce

```powershell
pwsh -NoProfile -File .\Test-Collector.ps1 -FixtureDirectory .\test-fixtures
npm ci
npm run test:launcher
npm run test:integration
npm run test:browser   # or: npx playwright install chromium first
```
