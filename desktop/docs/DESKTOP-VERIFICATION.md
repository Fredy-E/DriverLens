# DESKTOP-VERIFICATION.md — Task 14: ARM64 release, NSIS installer, full battery

**Run:** 2026-10-08 21:01–21:10 UTC (local 2026-10-09 00:01–00:10, Asia/Beirut).
**Machine:** Windows 11 ARM64, the ordinary build machine (user session) — **not a clean
machine**; see §8 for what that means for the Task-15 matrix.
**Scope:** Milestone-B review minors cleanup, a fresh post-cleanup full battery (including
the native E2E suite), the production `aarch64-pc-windows-msvc` build with the NSIS
current-user installer, artifact inspection, and the release-candidate artifact copy.
**No commits** were made; nothing outside `desktop/` (plus `evidence/` and `artifacts/`)
was modified.

**Update 2026-10-09 — post-verification fix + full re-verification.** The first
real-hardware scan of this release build failed (`exit_failure`); the root cause was a
Windows verbatim-path bug in the collector spawn — found and fixed on 2026-10-09. All
suites were then re-run on the fixed tree, the native E2E was re-run, and the release
artifacts were rebuilt. **Current artifact hashes: §5/§7. Fix + manual real scan +
provenance: §0. Rebuild mechanics: §3c. Post-fix battery: §4b.** Sections §1–§3b below
are the original (pre-fix) record, kept as history.

---

## 0. Post-verification fix (2026-10-09) — verbatim-path bug, fix, manual real scan, re-verification

**What failed.** The first real-hardware scan of the release build failed with
`exit_failure` (user-reported; reproduced twice).

**Root cause.** Tauri's resource resolution canonicalizes the executable path on Windows,
so the bundled collector script path arrived at the spawn boundary as a **verbatim path**
(`\\?\C:\…`). PowerShell's `-File` parameter **rejects verbatim paths**
("SecurityError: AuthorizationManager check failed", exit 1). Every fake-runner test
passed because none handed a canonicalized verbatim path to a real `pwsh` — the first
real scan exposed the gap. (Diagnosis evidence: WMI capture of the spawned child command
line showing the verbatim `-File` argument; a 10 s replay reproduced exit 1; a Rust probe
with the clean path exited 0.)

**The fix** — `desktop/src-tauri/src/collector.rs` (the only source file changed):
- New `normalize_win32_path(&Path) -> PathBuf` (collector.rs:102): strips the `\\?\`
  prefix and maps `\\?\UNC\server\share` → `\\server\share`; every other path (including
  non-UTF-8) passes through unchanged.
- `build_collector_args` (collector.rs:120) now normalizes **both** path elements (the
  script path and the `-OutputPath` value) before building the fixed six-element argument
  vector.
- Three new tests in the `collector::tests` module:
  1. `verbatim_paths_are_normalized_for_the_pwsh_arguments` — verbatim script/output
     paths come out clean; no argument keeps a verbatim prefix.
  2. `verbatim_unc_paths_map_to_the_standard_unc_form` — `\\?\UNC\` maps to `\\`.
  3. `real_pwsh_accepts_the_normalized_file_argument` — acceptance test that spawns a
     **real `pwsh`** with the exact argument-vector builder output against a harmless
     stub script (no inventory; skips with a note when pwsh is unresolvable).
- Rust test count 74 → **77** (67 lib unittests + 10 `ipc_boundary` integration).

**Manual real-scan verification (this dev machine, post-fix).** A real scan through the
fixed app **succeeded**: the UI reported **277 devices collected locally**; the spawned
collector command line showed the clean `-File` path (no `\\?\`), the child exited
normally (~9 s), and the app's scans directory was cleaned up afterwards. Read-only,
local-only — **no report contents are recorded anywhere in this record** (device count
only). This is a manual single-machine verification, not a hardware matrix (§8).

**Re-verification (2026-10-09).** Full battery re-run on the fixed tree — all six suites
green (§4b). Native E2E re-run against a fresh `--features wdio-e2e` build of the fixed
code — 12/12 (§4b). Release exe + NSIS installer rebuilt; the new installer's payload was
verified byte-identical to the release exe (§3c, §5, §7).

**Provenance — final source state.** `git rev-parse HEAD` = `99ed3db` (unchanged; no
commits were made). sha256 of the sources this candidate was built from:

| File | sha256 |
|---|---|
| `desktop/src-tauri/src/collector.rs` | `221454322d8fe6b8cb14d53cffeb63d813f4c5ab1b94aa556ad8a70c9184eeed` |
| `desktop/src-tauri/src/lib.rs` | `3105afa6b8c322f74f2c2929ce4cf43125584e6c7c095bf98713dd3ee11f3777` |
| `desktop/src-tauri/src/scan.rs` | `ed1e6515a5dbc9443510b44d0f51eb1eb0b8631f698f3f7bdaca863cdcc7785b` |

---

## 1. Milestone-B review minors — resolution (all four applied, none deferred)

| # | Item | Resolution |
|---|------|------------|
| 1 | `report.rs` blanket `#![allow(dead_code)]` + stale "wired later" comment | Blanket allow **removed**. The module docs now carry a `# Wiring` section: report.rs is wired into IPC via `scan.rs` (`validate_report_value` guards every accepted scan and import; the stored value it validates is what `get_report` / `export_report` serve). A single **targeted** `#[allow(dead_code)]` now marks `validate_report_str` as the test-only text entry point (production IPC parses bytes and calls `validate_report_value`). `cargo check --all-targets` (forced recompile) is **warning-free** — `evidence/task14-cleanup-check.log`. |
| 2 | `scan.rs` `last_tails` — keep or drop | **Kept, consciously.** Re-documented as test-only bounded diagnostics: written on every terminal path (each tail capped at 64 KiB by the collector), read only by `last_tails_for_test` (`#[cfg(test)]`), which pins the guarantee that these bytes never reach the webview — never serialized, never logged, never returned by any IPC command. Targeted allow retained with a precise comment. |
| 3 | `ScanControls` `get_report` failure — bounded auto-retry | **Implemented (not deferred).** A failed `get_report` fetch now gets **one** bounded retry after `REPORT_FETCH_RETRY_DELAY_MS = 1500 ms` (timer cleared on unmount); only a second failure surfaces the error notice — the component still never guesses a report into view. Tests updated: the rejection test now asserts retry-then-surface plus boundedness (exactly 2 attempts), a new test covers retry-success delivery, and `app-flows.test.tsx` asserts the bounded retry before the failure appears. Vitest count: 168 → **169**. |
| 4 | `collector.rs:24` stale "(Task 9 tracks it)" | Reworded to "…this reasoning must be revisited; re-verify whenever the collector script changes (nothing tracks this automatically)." |

Notes on (1): the helper is `pub` in a lib crate, so rustc treats it as a lint root and
does not currently flag it even without the allow; the targeted allow is a deliberate
test-only marker (and keeps the item covered if module visibility ever tightens). The
removed blanket allow was not masking any current warning in any build configuration
checked. Together with (2), `src/` now contains exactly two `allow(dead_code)` sites —
both targeted, both commented (grep output in the cleanup log).

## 2. Toolchain / versions (verified on this machine)

| Component | Version |
|---|---|
| OS / Rust target | Windows 11 ARM64 / `aarch64-pc-windows-msvc` |
| rustc / cargo | 1.98.0 (rustc `88d9e12ae` 2026-08-18; cargo `797e8a9bc` 2026-08-05) |
| Node.js / npm | v26.7.0 / 11.19.0 |
| `@tauri-apps/cli` | 2.12.1 |
| `tauri` (crate, from Cargo.lock) | 2.12.1 |
| `tauri-build` / `tauri-plugin-dialog` | 2.7.1 / 2.8.1 |
| vite / vitest / TypeScript | 8.3.4 / 5.0.3 / 5.9.3 |
| `@wdio/*` (E2E only) | 9.32.0; `tauri-plugin-wdio-webdriver` 1.5.0 (optional, feature-gated) |

## 3. Build commands + exit codes

All commands were run with cargo on PATH (`%USERPROFILE%\.cargo\bin`). Logs are kept
verbatim under `driverlens-v2/evidence/`.

### 3a. E2E binary rebuild (post-cleanup; prerequisite for the E2E suite)

```
cd desktop/
CARGO_TARGET_DIR=<abs>/desktop/src-tauri/target-e2e \
  npm run tauri -- build --target aarch64-pc-windows-msvc --no-bundle --features wdio-e2e
```

- **EXIT 0** — `evidence/task14-e2e-build.log` (started 21:01:25Z; release build finished
  in ~42 s incremental).
- Output: `desktop/src-tauri/target-e2e/aarch64-pc-windows-msvc/release/driverlens-desktop.exe`.
- The rebuilt binary embeds the **post-cleanup** frontend bundle (`index-B5PXNKuk.js`;
  the pre-cleanup `index-BFfWcu4V.js` is absent), so the E2E run exercised tonight's code.
  (The E2E target directory is separate — the verified release artifact in `target/` is
  never overwritten by it.)

### 3b. Production build + NSIS bundle

```
cd desktop/
npm run tauri -- build --target aarch64-pc-windows-msvc --bundles nsis
```

- **EXIT 0** — `evidence/task14-nsis-build.log` (started 21:06:17Z).
- `--bundles nsis` keeps the run NSIS-only (the config's `bundle.targets: "all"` would
  otherwise also attempt an MSI/WiX path).
- **NSIS toolset download (first bundle run; single attempt, no retry needed):** the
  bundler downloaded `nsis-3.11.zip` from
  `https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip`
  ("validating hash" passed) and `nsis_tauri_utils.dll` v0.5.3 from
  `https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll`
  ("validating hash" passed), then extracted the toolset to
  `%LOCALAPPDATA%\tauri\NSIS` (`makensis.exe` present;
  `Plugins\x86-unicode\additional\nsis_tauri_utils.dll` present).
- `makensis` produced the installer at
  `desktop/src-tauri/target/aarch64-pc-windows-msvc/release/bundle/nsis/DriverLens_0.1.0_arm64-setup.exe`
  (1.82 MiB).
- No system installs, no toolchain changes, no admin rights were needed; no build-time
  WebView2 fetch occurred (default `downloadBootstrapper` mode downloads nothing at build
  time — see §8).
- *(This installer was built before the post-verification fix; it has been superseded by
  the rebuild in §3c — its local copies were removed, see §7.)*

### 3c. Post-fix rebuild (2026-10-09) — release exe + NSIS installer

The release exe was rebuilt with the fix. One build-system collision was hit and is
recorded in full in `evidence/postfix-nsis-notes.txt`:

- The fixed app instance is **running from `target/…/release/driverlens-desktop.exe`**
  (the user's session, kept open after the manual scan — §0), so that file cannot be
  relinked or opened for write while it runs.
- `npm run tauri -- build --target aarch64-pc-windows-msvc --bundles nsis` therefore
  cannot complete in that state: the tauri build re-runs the frontend build, which makes
  cargo want to recompile and relink the release exe, and the relink fails to remove the
  locked file ("Access is denied. (os error 5)") —
  `evidence/postfix-nsis-build-attempt1.log`. The exe was left untouched by the failure.
- `npm run tauri -- bundle --target aarch64-pc-windows-msvc --bundles nsis` (bundles the
  existing exe, no compilation) produced the installer. The bundler's post-production
  "restore the main binary" step then reported the same lock ("os error 32") **after**
  the installer had been fully written (`tauri-bundler src/bundle.rs:212-216`) —
  `evidence/postfix-nsis-build-attempt2.log`.
- The produced installer was verified complete anyway (7-Zip): integrity test
  "Everything is Ok"; the embedded `driverlens-desktop.exe` was extracted and is
  **byte-identical** to the release exe (`01179464…`), and the embedded
  `resources/Collect-DriverLens.ps1` is byte-identical to the repository-root reviewed
  source (`eb13430f…`). Because the exe was locked, the bundle-type marker patch step
  could not run, so the installer ships the exact verified (unpatched) exe; the marker is
  read only by the Tauri updater plugin, which this app does not use.

## 4. Battery — Task 14 (2026-10-08) and post-fix re-run (2026-10-09)

### 4a. Task-14 battery (pre-fix; superseded by §4b) — `evidence/task14-battery.log`

Started 21:02:34Z, finished 21:05:14Z. Every step's exit code is recorded in the log.

| # | Step (exact command) | Result | Exit |
|---|---|---|---|
| 1 | `cargo test` (default features; from `desktop/src-tauri`) | **74 passed, 0 failed** (64 lib unittests + 10 `ipc_boundary` integration) | 0 |
| 2 | `npm --prefix desktop run test` (vitest) | **15 files / 169 tests passed** | 0 |
| 3 | `npm --prefix desktop run typecheck` (`tsc --noEmit`) | clean | 0 |
| 4 | `npm --prefix desktop run build` (vite) | dist built (`index.html` 0.47 kB, `index-Bs-Ud8ju.css` 5.40 kB, `index-B5PXNKuk.js` 244.14 kB) | 0 |
| 5 | `node desktop/tests/bundle.test.cjs` (from repo root) | **7/7** (production CSP, dev-CSP split, bundle contents, dist scan, no server/plugin code, capabilities, no helper refs) | 0 |
| 6 | root `npm test` (TMP/TEMP/TMPDIR=`…/hermes/cache/scratch`) | **27 passed, 0 failed** (launcher 6 + integration 18 + saved-report 3) | 0 |
| 7 | `npm --prefix desktop run test:native` (native E2E, embedded WebDriver server) | **12/12 passed**; `consoleErrors: []`; 6 expected cosmetic WebView2 IPC-noise lines (filtered by the spec as `harnessConsoleNoise`) | 0 |

**Overall: PASS.** The E2E suite ran in the unlocked interactive user session (it creates
and drives a real GUI window) against scripted synthetic collectors only — no real device
inventory was ever collected.

E2E evidence copied to `evidence/`: `task14-e2e-scan-success.png`,
`task14-e2e-busy-notice.png`, `task14-e2e-cancelled.png`, `task14-e2e-filtered-export.png`,
`task14-e2e-results.json` (12 collected / 12 passed / 0 failed / 0 skipped).

### 4b. Post-fix re-run (2026-10-09) — `evidence/postfix-battery.log`

Started 05:54:28Z, finished 05:56:13Z UTC. Every step's exit code is recorded in the log;
per-step outputs: `evidence/postfix-logs/`.

| # | Step (exact command) | Result | Exit |
|---|---|---|---|
| 1 | `cargo test` (default features; from `desktop/src-tauri`) | **77 passed, 0 failed** (67 lib unittests + 10 `ipc_boundary` integration) — includes the three new verbatim-path tests (§0) | 0 |
| 2 | `npm --prefix desktop run test` (vitest) | **15 files / 169 tests passed** | 0 |
| 3 | `npm --prefix desktop run typecheck` (`tsc --noEmit`) | clean | 0 |
| 4 | `npm --prefix desktop run build` (vite) | dist built (same bundle names/sizes as 4a) | 0 |
| 5 | `node desktop/tests/bundle.test.cjs` (from repo root) | **7/7** | 0 |
| 6 | root `npm test` (TMP/TEMP/TMPDIR=`…/hermes/cache/scratch`) | **27 passed, 0 failed** (launcher 6 + integration 18 + saved-report 3) | 0 |
| 7 | `npm --prefix desktop run test:native` (native E2E **re-run**, against a fresh `--features wdio-e2e` build of the fixed code — `evidence/postfix-e2e-build.log`) | **12/12 passed**; `consoleErrors: []`; 6 expected cosmetic WebView2 IPC-noise lines (filtered as `harnessConsoleNoise`) | 0 |

**Overall: PASS (7/7, none cited).** The E2E suite ran in the interactive user session
against scripted synthetic collectors only; the fixed app instance used for the manual
real scan (§0) stayed running throughout — it was not closed, killed, or restarted by
this pass.

E2E evidence (2026-10-09 run): `evidence/postfix-e2e.log` (full run output),
`evidence/wdio-native.json` (refreshed: 12 collected / 12 passed / 0 failed / 0 skipped),
screenshots `evidence/postfix-e2e-{scan-success,busy-notice,cancelled,filtered-export}.png`.

## 5. Release artifacts — names, sizes, SHA-256, PE (post-fix rebuild, 2026-10-09)

| Artifact | Size (bytes) | SHA-256 | PE machine |
|---|---|---|---|
| `driverlens-desktop.exe` (app) | 8,072,704 | `0117946488d70fcb09269f0005d788709ecbc59bdb0e3c9a9522c05c9a3f18bd` | **0xAA64 (ARM64)** |
| `DriverLens_0.1.0_arm64-setup.exe` (NSIS installer) | 1,911,385 (1.82 MiB) | `a712308c50833fea3b9f615724af89c18dcfdaec56aa2bf3492d14a3bbc97c74` | **0x014C (x86 I386)** — expected |
| `resources/Collect-DriverLens.ps1` (beside the exe) | 7,811 | `eb13430f4513427e41856d29824d85a6f501af2d2fbcb373fcde026991db7adb` | n/a (script) |

- Locations in the workspace (same paths as before the rebuild):
  `desktop/src-tauri/target/aarch64-pc-windows-msvc/release/{driverlens-desktop.exe, bundle/nsis/DriverLens_0.1.0_arm64-setup.exe, resources/Collect-DriverLens.ps1}`.
- **PE check:** the app exe is native ARM64 (`0xAA64`). The installer itself is x86
  (`0x014C`) — documented, expected Tauri behavior ("the NSIS installer itself will still
  be x86 running on the ARM machine via emulation; the app itself will be a native ARM64
  binary", INSTALLER-PREREQS-NOTES.md §3). The installer's **payload** was extracted
  (7-Zip) and checked: the embedded `driverlens-desktop.exe` is byte-identical to the app
  exe above (`01179464…f18bd`), native ARM64 — see §3c.
- **Resources parity:** the `Collect-DriverLens.ps1` shipped beside the exe is
  byte-identical (SHA-256 `eb13430f…db7adb`) to the repository-root reviewed source, to
  `desktop/src-tauri/resources/Collect-DriverLens.ps1`, and to the copy inside the
  installer (extracted and hash-verified).
- **Signing:** both the app exe and the installer are **unsigned** — `Get-AuthenticodeSignature`
  reports `NotSigned` for both (no certificate is configured). See §8 for the SmartScreen
  disclosure.
- **Superseded:** the pre-fix artifacts (exe `7fcb276d…`, installer `0dee8c53…`) were
  replaced by this rebuild on 2026-10-09; their local copies were removed (§7).

## 6. Production feature-set proof (no E2E/WebDriver surface in the release)

- `cargo tree --manifest-path desktop/src-tauri/Cargo.toml | grep -i wdio` → **EMPTY**
  (exit 1, no match). Contrast (feature build): `cargo tree --features wdio-e2e | grep -i
  wdio` → `tauri-plugin-wdio-webdriver v1.5.0`. *(Re-verified 2026-10-09 on the fixed tree.)*
- Byte-level scan of the release `driverlens-desktop.exe` (case-insensitive; re-run on the
  2026-10-09 rebuild — all-zero result again): `wdio` **0**,
  `webdriver` **0**, `tauri_webdriver_port` **0**, `driverlens_e2e` **0**, `e2e_harness`
  **0**, `scriptedfake` **0**, `e2escriptedfake` **0**. `grep -a -i wdio` and
  `grep -a DRIVERLENS_E2E` → no matches either.
- The fixture-override environment names (`DRIVERLENS_E2E_*`) do **not** appear in the
  production exe; no WebDriver server, no fakes, no env hooks ship in the release binary.

## 7. Release-candidate artifact copy (post-fix, 2026-10-09)

Copied (and hash-verified after copy) to:

```
driverlens-v2/artifacts/release-candidate-01179464/
├── driverlens-desktop.exe                      (sha256 01179464…f18bd)
├── DriverLens_0.1.0_arm64-setup.exe            (sha256 a712308c…97c74)
└── resources/
    └── Collect-DriverLens.ps1                  (sha256 eb13430f…7adb)
```

Directory name carries the app-exe SHA-256 prefix (`01179464`). All three hashes were
re-computed on the copies and match §5. The installer in this directory is the file whose
payload was verified byte-identical to the exe beside it (§3c).

**Supersession + removal:** the previous release candidate
(`artifacts/release-candidate-7fcb276d/`, exe `7fcb276d…`, installer `0dee8c53…`) contained
the pre-fix binary, and `artifacts/verified-release-3c887c9f/` held an earlier pre-fix exe
(`3c887c9f…`). Both directories were **deleted on 2026-10-09** so the buggy binaries cannot
be mistaken for a candidate; only `artifacts/release-candidate-01179464/` remains.

## 8. Task 15 — clean-machine matrix: UNVERIFIED

**No clean-machine verification has happened.** No isolated VM (or clean account/image) is
available on this machine, and this machine must never be altered to simulate missing
prerequisites (no uninstalling WebView2, no policy changes, no OS-level edits). Everything
in §1–§7 above is build-machine / local-session evidence only. The Task-15 matrix below is
therefore listed **entirely as UNVERIFIED**, with the expected behavior taken from
`notes/INSTALLER-PREREQS-NOTES.md` §8 (expectations, not observations):

| # | Task 15 case | Expected (per prereq notes) | Status |
|---|---|---|---|
| 1 | Runtime present (stock Win10 1803+/Win11), offline install | install succeeds without network; app launches, UI renders, process is native ARM64, collector runs | **UNVERIFIED** |
| 2 | Missing WebView2 + online | bootstrapper downloads + installs silently (`silent: true` default) | **UNVERIFIED** |
| 3 | Missing WebView2 + offline | bootstrapper failure surfaces; capture actual behavior | **UNVERIFIED** |
| 4 | Normal-user (non-admin) install | no UAC prompt; per-user install; app runs as standard user | **UNVERIFIED** |
| 5 | First launch after install | app starts, main window renders | **UNVERIFIED** |
| 6 | Sample / import / export on the clean machine | bundled sample loads; import/export work through native dialogs | **UNVERIFIED** |
| 7 | Upgrade-over-install | allowed (allowDowngrades default true) | **UNVERIFIED** |
| 8 | Uninstall / retention | install dir, shortcuts and uninstall registry entries removed; record what remains under `%APPDATA%`/`%LOCALAPPDATA%\com.fredye.driverlens` (WebView2 `EBWebView`) | **UNVERIFIED** |
| 9 | SmartScreen (unsigned, fetched via browser) | warning expected; record click-through (no prompt expected for side-loaded copies) | **UNVERIFIED** |
| 10 | Missing PowerShell (collector prerequisite) | graceful error, not a crash (simulate via policy/restricted account; cannot be uninstalled) | **UNVERIFIED** |
| 11 | Installer x86 emulation note | setup.exe runs as x86 under emulation on ARM64 — expected; note if AV/policy blocks it | **UNVERIFIED** |

### Installer network behavior (disclosure)

`tauri.conf.json` sets no `webviewInstallMode`, so the schema default applies:
`downloadBootstrapper` (`silent: true`). Consequence: the installer requires an **internet
connection only if the WebView2 runtime is missing** on the target machine — it then
downloads and runs Microsoft's bootstrapper. On Windows 10 (1803+) and Windows 11 the
runtime ships with the OS, so typical installs need no network. No build-time WebView2
download occurs with this mode (confirmed: the build log shows no WebView2 fetch). The
runtime-missing cases (online and offline) are UNVERIFIED (§8 rows 2–3).

### Unsigned / SmartScreen status

No code-signing certificate is configured (`certificateThumbprint` / `signCommand`
unset), and both binaries were verified to carry an **empty Authenticode certificate
table** — the artifacts are unsigned. Per the Tauri signing docs, users who download the
`-setup.exe` via a browser on a machine without reputation should expect a SmartScreen
warning and must click through it; it does not block functionality, and a local
(non-MOTW) copy typically does not prompt. The SmartScreen behavior itself is
**UNVERIFIED** here (§8 row 9).

## 9. Evidence index

| File | What it holds |
|---|---|
| `evidence/task14-battery.log` | Full 7-step Task-14 battery, per-step exit codes, overall PASS |
| `evidence/task14-e2e-build.log` | E2E binary rebuild (feature `wdio-e2e`, separate target dir) |
| `evidence/task14-nsis-build.log` | Production build + NSIS toolset download + makensis + output |
| `evidence/task14-cleanup-check.log` | `cargo check --all-targets` warning-free proof + grep of remaining allow sites |
| `evidence/task14-e2e-results.json` | E2E machine-readable summary (12/12) |
| `evidence/task14-e2e-*.png` | E2E screenshots (scan success, busy notice, cancelled, filtered export) |
| `evidence/postfix-battery.log` + `evidence/postfix-logs/` | Post-fix 6-step battery (2026-10-09): all green, per-step exit codes + full outputs |
| `evidence/postfix-e2e-build.log` | Post-fix E2E binary rebuild (`wdio-e2e`, separate target dir) |
| `evidence/postfix-e2e.log` | Post-fix native E2E run (12/12, exit 0) |
| `evidence/wdio-native.json` | E2E machine-readable summary — refreshed by the 2026-10-09 run |
| `evidence/postfix-e2e-*.png` | Post-fix E2E screenshots (same four captures) |
| `evidence/postfix-nsis-build-attempt1.log`, `…-attempt2.log`, `evidence/postfix-nsis-notes.txt` | Installer rebuild: locked-exe collision, diagnosis, and the verification chain |
| `artifacts/release-candidate-01179464/` | App exe + installer + resource, hash-verified copies (current) |

*Honesty note: every observation recorded above is from real command output produced
during the runs it describes; nothing is inferred. The 2026-10-09 additions (§0, §3c, §4b
and the §5/§7 updates) follow the same rule — every value was produced by real commands
during that pass. The unverified items are explicitly marked UNVERIFIED. No real device
inventory was collected or used by any automated test or the E2E suite (scripted synthetic
collectors only); the one manual real scan (2026-10-09, §0) is recorded as a device count
only — no report contents.*
