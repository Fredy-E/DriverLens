# Native E2E — real Tauri window + real Rust IPC over WebDriver (Task 12)

How to build and run the native end-to-end suite for the DriverLens desktop
app on Windows ARM64 (`aarch64-pc-windows-msvc`), using the official Tauri
WebDriver workflow with the **embedded** driver provider.

## What this proves (and what it cannot)

The suite drives a **real compiled Tauri window** over a W3C WebDriver
server that runs *inside the app* (`tauri-plugin-wdio-webdriver` 1.5.0 via
`@wdio/tauri-service` 1.5.0, `driverProvider: 'embedded'`). It exercises:

- the ten real IPC commands through the real invoke path, including the ACL
  boundary (an unlisted command name is denied for the real main window);
- the real Rust scan state machine — running / complete / error / cancelled
  / timeout / busy — observed in the real UI;
- import and export through the real command implementations (only the OS
  file picker is replaced by a fake dialog; validation, filtering and file
  writing are production code);
- the device table, filtering, and the filtered-export file contents;
- the USB Device Notebook (extension E-01): the empty state, scan recording
  (device rows carrying their current driver versions), and note save +
  in-session persistence through the real commands;
- the portable HTML export (extension E-03): the disabled state with no
  report, the redaction default (helper text, checkbox OFF), and the written
  document — redacted vs. the identifier opt-in — through the real command.

It cannot prove: real hardware inventory, real collector behavior on a
device, or x64 coverage. It never runs a real scan: **all scans run against
scripted synthetic collectors** (see below), and the suite asserts the
`e2eScriptedFake` marker to prove it. The OS save/open dialogs themselves are
never opened (the fakes replace only the picker — the same limitation the
pre-existing export cases carry), and the notebook's cross-restart durability
is covered by Rust unit tests, not by this suite.

## Architecture

- **Feature-gated E2E binary.** `--features wdio-e2e` (see
  `src-tauri/Cargo.toml`) enables:
  - the optional dependency `tauri-plugin-wdio-webdriver = "=1.5.0"`,
    registered in `lib.rs` *only* under the feature (it hosts the embedded
    WebDriver server on `TAURI_WEBDRIVER_PORT`, default 4445);
  - `src-tauri/src/e2e_harness.rs`: the scripted fake collector runner and
    the env-configured fake dialogs, swapped in for the production runner /
    native dialogs in `setup_scan_manager`. It also provides the
    `DRIVERLENS_E2E_NOTEBOOK_DIR` override, which keeps the E2E notebook
    store out of the real app local data directory.
- **Production is untouched.** The plugin is an optional dependency and every
  reference is `#[cfg]`-gated, so default `cargo build` / `cargo test` / the
  release build contain no WebDriver server, no fakes, and no env hooks.
- **Separate artifact.** The E2E build uses `CARGO_TARGET_DIR=src-tauri/
  target-e2e`, so the verified release artifact in `src-tauri/target/` is
  never overwritten.

## Build the E2E binary

From `desktop/` (bash / MSYS shown; PowerShell equivalent below):

```bash
export CARGO_TARGET_DIR="$PWD/src-tauri/target-e2e"
npm run tauri -- build --target aarch64-pc-windows-msvc --no-bundle --features wdio-e2e
```

```powershell
$env:CARGO_TARGET_DIR="$PWD/src-tauri/target-e2e"
npm run tauri -- build --target aarch64-pc-windows-msvc --no-bundle --features wdio-e2e
```

Output: `src-tauri/target-e2e/aarch64-pc-windows-msvc/release/driverlens-desktop.exe`.
(The Tauri CLI honors `CARGO_TARGET_DIR` — verified 2026-10-08; the exe and
its `resources/` land under the overridden directory.)

The wdio config looks for the binary at exactly that path; override with
`DRIVERLENS_E2E_BINARY=<path>` when it lives elsewhere (e.g. CI).

## Run the suite

```bash
npm --prefix desktop run test:native        # from the repo work tree
# or: cd desktop && npm run test:native
```

The run needs an **interactive, unlocked desktop session** (a GUI window is
created and driven). On a locked session the app may not become drivable —
the failure is recorded verbatim rather than skipped (see below).

What the runner does:

1. `@wdio/tauri-service` spawns the E2E binary with `TAURI_WEBDRIVER_PORT`
   and the `DRIVERLENS_E2E_*` environment from `e2e/wdio.conf.ts`;
2. the app's embedded WebDriver server comes up; the service polls
   `http://127.0.0.1:<port>/status` until `{"value":{"ready":true}}`;
3. the spec (`e2e/driverlens.spec.ts`) drives the window;
4. results: spec output in the console, screenshots + `results.json` under
   `desktop/e2e/.run/` (git-ignored).

## Environment contract (E2E binary only)

| Variable | Meaning |
|---|---|
| `DRIVERLENS_E2E_SCENARIO` | Scenario queue, one entry consumed per scan spawn: `success` \| `failure` \| `hang` \| `malformed` (last entry repeats). |
| `DRIVERLENS_E2E_SCENARIO_FILE` | Per-spawn override file; when set, its trimmed non-empty content is the scenario. The spec rewrites it before each scan so one app session can exercise several scenarios. |
| `DRIVERLENS_E2E_OPEN_PATH` | Path the fake open dialog returns (unset = cancel). |
| `DRIVERLENS_E2E_SAVE_PATH` | Path the fake save dialog returns (unset = cancel). |
| `DRIVERLENS_E2E_HTML_PATH` | Path the fake HTML save dialog returns (unset = cancel). |
| `DRIVERLENS_E2E_NOTEBOOK_DIR` | Notebook store directory override: the E2E binary keeps its notebook store here (the suite uses `e2e/.run/notebook`), so a test run never reads or clears a real user notebook store. Unset = the production location. |
| `DRIVERLENS_E2E_TIMEOUT_MS` | Scan deadline override (ms) so the real timeout path runs fast (default in the spec: 12000). |

Scenario semantics: `success` writes the synthetic fixture
(`src-tauri/fixtures/e2e-scripted-report.json`) and exits 0 after ~600 ms;
`failure` writes nothing and exits nonzero; `hang` blocks until killed
(cancel or timeout); `malformed` writes invalid JSON and exits 0. A missing
or unknown scenario fails the scan with the `io` code (fail closed).

## Test inventory (15 cases)

1. startup chrome + empty report panel; 2. HTML export disabled with no
report (redaction hint + checkbox default OFF); 3. sample chip after "Load
sample"; 4. import via the native-dialog path; 5. scan success → 3 scripted
devices + `e2eScriptedFake` marker via `get_report`; 6. failed scan →
`exit_failure` guidance, previous report kept; 7. repeated scan after a
failure; 8. busy — duplicate start rejected at IPC level (`{code:"busy"}`)
and the UI busy notice; 9. cancellation of a hanging scan → Cancelled;
10. timeout via the deadline override; 11. unauthorized IPC (unlisted
command denied, forged args inert); 12. filtering + filtered/full export
file contents; 13. HTML export: redacted by default, opt-in keeps
identifiers (real command, real file); 14. notebook: empty state → a
scripted scan records devices with their driver versions → note save +
in-session persistence (real commands; isolated store under
`e2e/.run/notebook`); 15. console stayed clean.

## Evidence

- `driverlens-extensions/evidence/sa-pub-wdio-e2e-build.log` — the v0.2.0 feature build.
- `driverlens-extensions/evidence/sa-pub-wdio-native.log` — full WDIO run output + exit.
- `driverlens-extensions/evidence/sa-pub-wdio-native.json` — cases run/passed/failed/
  skipped, console errors, notes (copied from `e2e/.run/results.json`).
- `driverlens-extensions/evidence/sa-pub-screenshots/` — WDIO captures.

## Troubleshooting

- **Locked/headless session** — WebDriver automation needs an unlocked
  interactive desktop. The run fails with the driver's exact error; record
  it and re-run after unlocking. This is a blocker, not a skip.
- **Port 4445 busy** — set `embeddedPort` (service option) or
  `TAURI_WEBDRIVER_PORT`; the service fails loudly when the port is taken.
- **`Embedded WebDriver server did not become ready`** — the app started
  without the plugin (wrong binary: rebuild with `--features wdio-e2e`) or
  startup was slow (raise `startTimeout`/`statusPollTimeout`).
- **Binary not found** — build first (command above); the config points at
  `src-tauri/target-e2e/...`; override with `DRIVERLENS_E2E_BINARY`.
- **Scenario misconfiguration** — scans fail with the `io` error if
  `DRIVERLENS_E2E_SCENARIO` is unset and the control file is unreadable;
  that is intentional (fail closed).

### Known harness quirks (learned the hard way)

- **`.app__note` must be scoped for the report status line.** Extension E-03
  added the redaction helper text — a second `.app__note` — BEFORE the report
  status line, so a bare `.app__note` selector resolves to the helper (first
  match). The spec pins the status via `.app__note[role="status"]`.
- **Never put an `error` key in an in-page invoke helper's return value.**
  WDIO's protocol layer classifies any response whose `value` carries a
  non-null `error` key as a WebDriver error and throws it — so the helper
  returns `{ ok, value }` / `{ ok: false, failure }` (see
  `invokeFromPage` in the spec). This is a protocol-shape collision, not an
  app behavior.
- **The 5 s per-lookup stall**: `@wdio/tauri-service` probes window focus
  before `findElement`/`click`/`getTitle` via the optional `tauri-plugin-wdio`
  bridge (not shipped in this E2E binary), costing a 5 s timeout per probe.
  The spec's `before()` calls `browser.tauri.switchWindow('main')` once,
  which suppresses the probe for the rest of the session.
- **`JSON error: invalid type: null, expected u32 …` console lines** are
  cosmetic harness noise, not app errors: every embedded-plugin async-script
  completion posts `{handler, id, result, error: null}` on the WebView2
  message channel, and Tauri's IPC message parser also receives it (unknown
  fields ignored, `error: null` fails its u32 callback-id parse) and evals a
  `console.error` line. The plugin still handles its own message; the spec's
  console check filters exactly this pattern and reports the count
  (`harnessConsoleNoise` in `results.json`).

## Why production stays mocking-free

- `tauri-plugin-wdio-webdriver` is an **optional** dependency: without
  `--features wdio-e2e` it is not in the build graph (verify with
  `cargo tree --features wdio-e2e | grep wdio` vs. plain `cargo tree`).
- `src/e2e_harness.rs` and its wiring exist only under
  `#[cfg(feature = "wdio-e2e")]`; grep `desktop/src-tauri/src` for `wdio`
  shows only cfg-gated references.
- The release binary contains no automation surface: no WebDriver server,
  no command mocking, no env-var hooks.
