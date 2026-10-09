//! Scripted E2E harness for the native WebDriver suite (feature `wdio-e2e`).
//!
//! SAFETY: this module is compiled ONLY with `--features wdio-e2e`; the
//! production binary contains none of it (the WebDriver plugin dependency is
//! optional and every reference to this module is `#[cfg]`-gated — see
//! `lib.rs`). Nothing here can run a real inventory:
//!
//! - [`ScriptedRunner`] never spawns a process. It writes a synthetic
//!   fixture to the app-owned output path and emulates exit/kill timing, so
//!   the real scan lifecycle (running → complete/error/cancelled/timeout)
//!   runs unchanged. `pwsh.exe` is never involved.
//! - [`EnvDialogs`] never opens an OS dialog; it returns caller-preconfigured
//!   paths from environment variables so import/export can be exercised.
//!
//! Environment contract (set by `desktop/e2e/wdio.conf.ts`):
//!
//! | Variable | Meaning |
//! |---|---|
//! | `DRIVERLENS_E2E_SCENARIO` | Comma-separated scenario queue consumed one entry per spawn: `success` \| `failure` \| `hang` \| `malformed`. The last entry repeats. |
//! | `DRIVERLENS_E2E_SCENARIO_FILE` | Optional per-spawn override: when set, the file's trimmed, non-empty content is the scenario (lets one app session exercise several scenarios). Fail-closed: a set-but-unreadable file is an error. |
//! | `DRIVERLENS_E2E_OPEN_PATH` | Path the fake open dialog returns (unset/empty = user cancel). |
//! | `DRIVERLENS_E2E_SAVE_PATH` | Path the fake save dialog returns (unset/empty = user cancel). |
//! | `DRIVERLENS_E2E_TIMEOUT_MS` | Overrides the scan deadline so the real timeout path can be exercised quickly (invalid/zero values are ignored). |
//!
//! Scenario semantics (all against the synthetic fixture
//! `fixtures/e2e-scripted-report.json` — no real device data exists anywhere
//! in this module):
//!
//! - `success`: write the fixture bytes, exit 0 after a short delay (the UI
//!   observes a real `running` state before `complete`).
//! - `failure`: write nothing, exit nonzero.
//! - `hang`: block until killed (cancel or timeout); never exits on its own.
//! - `malformed`: write invalid JSON, exit 0 (the real validator rejects it).
//!
//! Fail-closed: a missing or unknown scenario fails the scan with the `io`
//! code instead of guessing — a misconfigured harness must not silently run
//! something unexpected.
//!
//! The fixture carries the top-level marker field [`FAKE_MARKER_FIELD`]
//! (`e2eScriptedFake: "driverlens-wdio-e2e"`); the WebDriver spec asserts it
//! in `get_report` output and in exported files, proving the scripted fake —
//! and not a real collector — produced the data. Unknown top-level fields
//! are tolerated by the report contract, so the marker survives validation
//! and export.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use crate::collector::{ChildProcess, Runner};
use crate::scan::{ReportDialogs, ScanError};

/// Scenario queue environment variable.
pub const SCENARIO_ENV: &str = "DRIVERLENS_E2E_SCENARIO";
/// Per-spawn scenario override file environment variable.
pub const SCENARIO_FILE_ENV: &str = "DRIVERLENS_E2E_SCENARIO_FILE";
/// Fake open-dialog path environment variable.
pub const OPEN_PATH_ENV: &str = "DRIVERLENS_E2E_OPEN_PATH";
/// Fake save-dialog path environment variable.
pub const SAVE_PATH_ENV: &str = "DRIVERLENS_E2E_SAVE_PATH";
/// Fake HTML save-dialog path environment variable.
pub const HTML_PATH_ENV: &str = "DRIVERLENS_E2E_HTML_PATH";
/// Scan-deadline override environment variable (milliseconds).
pub const TIMEOUT_MS_ENV: &str = "DRIVERLENS_E2E_TIMEOUT_MS";
/// E2E-only notebook store directory override environment variable.
///
/// When set, the E2E binary keeps its notebook store under this directory
/// instead of the app local data dir, so a test run can never read or clear
/// a real user's notebook store. Unset = the production location.
pub const NOTEBOOK_DIR_ENV: &str = "DRIVERLENS_E2E_NOTEBOOK_DIR";

/// The synthetic scan output every scripted scan produces.
pub const FIXTURE_BYTES: &[u8] = include_bytes!("../fixtures/e2e-scripted-report.json");

/// Top-level marker field present only in the scripted fixture.
pub const FAKE_MARKER_FIELD: &str = "e2eScriptedFake";
/// Marker value the WebDriver spec asserts.
pub const FAKE_MARKER_VALUE: &str = "driverlens-wdio-e2e";

/// How long a successful scripted scan "runs" before exiting, so the UI can
/// observe a real `running` state.
const SUCCESS_DELAY: Duration = Duration::from_millis(600);
/// Delay before a failing/malformed scripted scan exits.
const FAILURE_DELAY: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scenario {
    Success,
    Failure,
    Hang,
    Malformed,
}

impl Scenario {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "success" => Some(Scenario::Success),
            "failure" => Some(Scenario::Failure),
            "hang" => Some(Scenario::Hang),
            "malformed" => Some(Scenario::Malformed),
            _ => None,
        }
    }
}

/// Resolves the scenario for the spawn at queue position `index`:
/// the control file first (per-scan override written by the spec), then the
/// env queue. Missing/invalid input resolves to `None` (fail closed).
fn resolve_scenario(index: usize) -> Option<Scenario> {
    if let Some(path) = path_from_env(SCENARIO_FILE_ENV) {
        let text = std::fs::read_to_string(&path).ok()?;
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        return Scenario::parse(trimmed);
    }
    let raw = std::env::var(SCENARIO_ENV).ok()?;
    let entries: Vec<&str> = raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect();
    if entries.is_empty() {
        return None;
    }
    Scenario::parse(entries[index.min(entries.len() - 1)])
}

/// A non-empty environment path, or `None` (dialog-cancel semantics).
fn path_from_env(name: &str) -> Option<PathBuf> {
    let raw = std::env::var_os(name)?;
    let path = PathBuf::from(raw);
    if path.as_os_str().is_empty() {
        None
    } else {
        Some(path)
    }
}

/// The E2E scan-deadline override (`DRIVERLENS_E2E_TIMEOUT_MS`). Invalid or
/// zero values are ignored so the production deadline stays in effect.
pub fn deadline_from_env() -> Option<Duration> {
    let raw = std::env::var(TIMEOUT_MS_ENV).ok()?;
    let ms: u64 = raw.trim().parse().ok()?;
    if ms == 0 {
        None
    } else {
        Some(Duration::from_millis(ms))
    }
}

/// The E2E notebook-store directory override (`DRIVERLENS_E2E_NOTEBOOK_DIR`).
/// Unset/empty = `None` (the production app local data dir is used).
pub fn notebook_dir_from_env() -> Option<PathBuf> {
    path_from_env(NOTEBOOK_DIR_ENV)
}

/// Scripted collector runner: writes synthetic fixture bytes to the fixed
/// `-OutputPath` argument and emulates process timing. Never spawns anything.
pub struct ScriptedRunner {
    /// The script path the production wiring resolved. Kept so the runner
    /// reports it, but never executed by the fake.
    script: PathBuf,
    /// How many spawns have been requested (scenario-queue position).
    spawns: AtomicUsize,
}

impl ScriptedRunner {
    pub fn new(script: PathBuf) -> Self {
        Self {
            script,
            spawns: AtomicUsize::new(0),
        }
    }
}

impl Runner for ScriptedRunner {
    fn resolve_executable(&self) -> Result<PathBuf, ScanError> {
        // Deliberately NOT pwsh.exe: nothing in this build may look like a
        // real collector executable.
        Ok(PathBuf::from("driverlens-e2e-scripted-collector"))
    }

    fn script_path(&self) -> PathBuf {
        self.script.clone()
    }

    fn spawn(&self, _program: &Path, args: &[OsString]) -> Result<Box<dyn ChildProcess>, ScanError> {
        let index = self.spawns.fetch_add(1, Ordering::SeqCst);
        let scenario = resolve_scenario(index).ok_or_else(|| {
            // Fail closed: a missing/unknown scenario must fail the scan
            // loudly instead of running an unexpected behavior.
            ScanError::io()
        })?;
        let output = output_path_from_args(args).ok_or_else(|| ScanError::io())?;
        match scenario {
            Scenario::Success => {
                std::fs::write(&output, FIXTURE_BYTES).map_err(|_| ScanError::io())?;
                Ok(Box::new(ScriptedChild::exits_after(SUCCESS_DELAY, true)))
            }
            Scenario::Failure => Ok(Box::new(ScriptedChild::exits_after(FAILURE_DELAY, false))),
            Scenario::Hang => Ok(Box::new(ScriptedChild::never())),
            Scenario::Malformed => {
                std::fs::write(&output, b"{ this is not valid json").map_err(|_| ScanError::io())?;
                Ok(Box::new(ScriptedChild::exits_after(FAILURE_DELAY, true)))
            }
        }
    }
}

/// The fixed argument vector carries `-OutputPath <path>`; the fake honors
/// exactly that element (same contract as the production runner).
fn output_path_from_args(args: &[OsString]) -> Option<PathBuf> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "-OutputPath" {
            return iter.next().map(PathBuf::from);
        }
    }
    None
}

#[cfg(windows)]
fn raw_status(code: u32) -> ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    ExitStatus::from_raw(code)
}

#[cfg(unix)]
fn raw_status(code: i32) -> ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    ExitStatus::from_raw(code)
}

/// Scripted child: exit timing and kill semantics mirror the injected test
/// children in `test_fakes.rs` (well-tested behavior), with no process
/// behind it.
struct ScriptedChild {
    /// When it exits on its own; `None` = never (must be killed).
    exits_at: Option<Instant>,
    exit_success: bool,
    /// Set by `kill` (cancel/timeout paths).
    killed: AtomicBool,
}

impl ScriptedChild {
    fn exits_after(delay: Duration, success: bool) -> Self {
        Self {
            exits_at: Some(Instant::now() + delay),
            exit_success: success,
            killed: AtomicBool::new(false),
        }
    }

    fn never() -> Self {
        Self {
            exits_at: None,
            exit_success: false,
            killed: AtomicBool::new(false),
        }
    }

    fn status(&self) -> ExitStatus {
        raw_status(if self.exit_success { 0 } else { 1 })
    }
}

impl ChildProcess for ScriptedChild {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        if self.killed.load(Ordering::SeqCst) {
            return Ok(Some(raw_status(1)));
        }
        match self.exits_at {
            Some(at) if Instant::now() >= at => Ok(Some(self.status())),
            _ => Ok(None),
        }
    }

    fn kill(&mut self) -> std::io::Result<()> {
        self.killed.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        if self.killed.load(Ordering::SeqCst) {
            return Ok(raw_status(1));
        }
        match self.exits_at {
            Some(at) => {
                let now = Instant::now();
                if now < at {
                    std::thread::sleep(at - now);
                }
                Ok(self.status())
            }
            // A real child that never exits would block here; the code under
            // test must always kill before waiting (cancel/timeout paths).
            None => loop {
                if self.killed.load(Ordering::SeqCst) {
                    return Ok(raw_status(1));
                }
                std::thread::sleep(Duration::from_millis(5));
            },
        }
    }

    fn output_tails(&mut self) -> (Vec<u8>, Vec<u8>) {
        (Vec::new(), Vec::new())
    }
}

/// Fake dialog provider: returns env-configured paths, never opens a dialog.
/// Unset/empty variables mean "the user cancelled" — a normal `Ok(None)`.
pub struct EnvDialogs;

impl ReportDialogs for EnvDialogs {
    fn pick_open_report(&self) -> Result<Option<PathBuf>, ScanError> {
        Ok(path_from_env(OPEN_PATH_ENV))
    }

    fn pick_export_path(&self) -> Result<Option<PathBuf>, ScanError> {
        Ok(path_from_env(SAVE_PATH_ENV))
    }

    fn pick_export_html_path(&self, suggested_name: &str) -> Result<Option<PathBuf>, ScanError> {
        // The suggested name is the OS dialog's cosmetic default only; the
        // fake uses its env-configured path like the other dialogs.
        let _ = suggested_name;
        Ok(path_from_env(HTML_PATH_ENV))
    }
}
