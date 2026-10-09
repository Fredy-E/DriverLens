//! Shared test fakes for the collector/lifecycle suites (Task 8).
//!
//! SAFETY: nothing in this module can run a real inventory. Fake runners
//! either write fixture bytes directly to the requested output path or spawn
//! inert sleeper processes (`ping.exe` loopback) to exercise real
//! kill/ownership semantics. `pwsh.exe` is never involved, so a test can
//! never collect real device data even by accident.
#![cfg(test)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::collector::{ChildProcess, RealChild, Runner};
use crate::scan::{ReportDialogs, ScanError};

/// A unique scratch directory for one test (never the repository, never
/// OneDrive — the OS temp dir).
pub(crate) fn scratch_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "driverlens-test-{label}-{}-{nanos:x}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("scratch dir must be creatable");
    dir
}

pub(crate) fn sample_bytes() -> Vec<u8> {
    include_bytes!("../fixtures/sample.json").to_vec()
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

// ---------------------------------------------------------------------------
// Fake child processes
// ---------------------------------------------------------------------------

/// Fake child with controllable exit timing and an observable kill flag.
pub(crate) struct MockChild {
    /// When it exits on its own; `None` = never (must be killed).
    exits_at: Option<Instant>,
    exit_success: bool,
    /// Shared with the test so it can assert `kill` was called.
    killed: Arc<AtomicBool>,
    tails: (Vec<u8>, Vec<u8>),
}

impl MockChild {
    /// A child that has already exited (immediately observable).
    pub(crate) fn exited(success: bool) -> (Self, Arc<AtomicBool>) {
        Self::exits_after(Duration::ZERO, success)
    }

    /// A child that exits successfully after `delay`.
    pub(crate) fn exits_after(delay: Duration, success: bool) -> (Self, Arc<AtomicBool>) {
        let killed = Arc::new(AtomicBool::new(false));
        (
            Self {
                exits_at: Some(Instant::now() + delay),
                exit_success: success,
                killed: killed.clone(),
                tails: (Vec::new(), Vec::new()),
            },
            killed,
        )
    }

    /// A child that never exits on its own.
    pub(crate) fn never() -> (Self, Arc<AtomicBool>) {
        let killed = Arc::new(AtomicBool::new(false));
        (
            Self {
                exits_at: None,
                exit_success: false,
                killed: killed.clone(),
                tails: (Vec::new(), Vec::new()),
            },
            killed,
        )
    }

    pub(crate) fn with_tails(mut self, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        self.tails = (stdout, stderr);
        self
    }
}

impl ChildProcess for MockChild {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        if self.killed.load(Ordering::SeqCst) {
            return Ok(Some(raw_status(1)));
        }
        match self.exits_at {
            Some(at) if Instant::now() >= at => Ok(Some(raw_status(if self.exit_success {
                0
            } else {
                1
            }))),
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
                Ok(raw_status(if self.exit_success { 0 } else { 1 }))
            }
            // A real child that never exits would block here; the code under
            // test must always kill before waiting. Mirror that by waiting
            // for the kill (bounded by the test harness).
            None => loop {
                if self.killed.load(Ordering::SeqCst) {
                    return Ok(raw_status(1));
                }
                std::thread::sleep(Duration::from_millis(5));
            },
        }
    }

    fn output_tails(&mut self) -> (Vec<u8>, Vec<u8>) {
        self.tails.clone()
    }
}

// ---------------------------------------------------------------------------
// Fake runner
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub(crate) enum SpawnBehavior {
    /// Writes `bytes` to `-OutputPath` and exits 0 (a normal scan).
    Success { bytes: Vec<u8> },
    /// Optionally writes bytes, then exits nonzero.
    ExitFailure { write_bytes: Option<Vec<u8>> },
    /// Writes a malformed JSON document and exits 0.
    Malformed,
    /// Writes `size` bytes of padding and exits 0.
    Oversized { size: usize },
    /// Creates a directory at `-OutputPath` and exits 0 (unreadable output).
    OutputIsDirectory,
    /// Exits 0 but writes nothing.
    MissingOutput,
    /// Fails to spawn at all (permission/policy style failure).
    SpawnFails,
    /// Exits successfully after `duration` (busy/later-scan tests). Writes the
    /// sample fixture so the scan completes end-to-end.
    Slow { duration: Duration },
    /// Never exits (timeout/cancel tests, kill flag observable).
    NeverExits,
    /// Exits immediately with canned bounded tails (retention tests).
    CannedTails {
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    /// Spawns TWO real sleeper processes: the owned one (returned to the
    /// manager) and a bystander (exposed to the test). Killing must only ever
    /// touch the owned process.
    RealSleepers { sleeper_seconds: u64 },
}

pub(crate) struct SpawnRecord {
    pub args: Vec<OsString>,
}

pub(crate) struct MockRunner {
    pub program: PathBuf,
    pub script: PathBuf,
    /// When true, `resolve_executable` fails with `executable_missing`.
    pub missing: AtomicBool,
    behavior: Mutex<SpawnBehavior>,
    spawns: Mutex<Vec<SpawnRecord>>,
    /// Kill flag of the most recently spawned MockChild (default never sets
    /// it; `NeverExits` uses it).
    last_kill_flag: Mutex<Option<Arc<AtomicBool>>>,
    /// Bystander handle for `RealSleepers`.
    bystander: Mutex<Option<Child>>,
}

impl MockRunner {
    pub(crate) fn new(behavior: SpawnBehavior) -> Self {
        Self {
            program: PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            script: PathBuf::from(r"C:\Program Files\DriverLens\resources\Collect-DriverLens.ps1"),
            missing: AtomicBool::new(false),
            behavior: Mutex::new(behavior),
            spawns: Mutex::new(Vec::new()),
            last_kill_flag: Mutex::new(None),
            bystander: Mutex::new(None),
        }
    }

    pub(crate) fn set_behavior(&self, behavior: SpawnBehavior) {
        *self.behavior.lock().unwrap() = behavior;
    }

    pub(crate) fn spawn_count(&self) -> usize {
        self.spawns.lock().unwrap().len()
    }

    /// Every `-OutputPath` value this runner was asked to write.
    pub(crate) fn output_paths(&self) -> Vec<PathBuf> {
        self.spawns
            .lock()
            .unwrap()
            .iter()
            .filter_map(|record| output_path_from_args(&record.args))
            .collect()
    }

    pub(crate) fn last_kill_flag(&self) -> Option<Arc<AtomicBool>> {
        self.last_kill_flag.lock().unwrap().clone()
    }

    pub(crate) fn take_bystander(&self) -> Option<Child> {
        self.bystander.lock().unwrap().take()
    }
}

impl Runner for MockRunner {
    fn resolve_executable(&self) -> Result<PathBuf, ScanError> {
        if self.missing.load(Ordering::SeqCst) {
            return Err(ScanError::executable_missing());
        }
        Ok(self.program.clone())
    }

    fn script_path(&self) -> PathBuf {
        self.script.clone()
    }

    fn spawn(
        &self,
        program: &Path,
        args: &[OsString],
    ) -> Result<Box<dyn ChildProcess>, ScanError> {
        // `program` is accepted (and would be honored by the production
        // runner) but the fake only needs the fixed argument vector.
        let _ = program;
        let behavior = self.behavior.lock().unwrap().clone();
        self.spawns.lock().unwrap().push(SpawnRecord {
            args: args.to_vec(),
        });
        let output = output_path_from_args(args)
            .expect("fake spawn requires -OutputPath in the fixed arg vector");
        match behavior {
            SpawnBehavior::Success { bytes } => {
                std::fs::write(&output, bytes).expect("fake write");
                let (child, _flag) = MockChild::exited(true);
                Ok(Box::new(child))
            }
            SpawnBehavior::ExitFailure { write_bytes } => {
                if let Some(bytes) = write_bytes {
                    std::fs::write(&output, bytes).expect("fake write");
                }
                let (child, _flag) = MockChild::exited(false);
                Ok(Box::new(child))
            }
            SpawnBehavior::Malformed => {
                std::fs::write(&output, b"{ this is not json").expect("fake write");
                let (child, _flag) = MockChild::exited(true);
                Ok(Box::new(child))
            }
            SpawnBehavior::Oversized { size } => {
                std::fs::write(&output, vec![b'x'; size]).expect("fake write");
                let (child, _flag) = MockChild::exited(true);
                Ok(Box::new(child))
            }
            SpawnBehavior::OutputIsDirectory => {
                std::fs::create_dir_all(&output).expect("fake dir");
                let (child, _flag) = MockChild::exited(true);
                Ok(Box::new(child))
            }
            SpawnBehavior::MissingOutput => {
                let (child, _flag) = MockChild::exited(true);
                Ok(Box::new(child))
            }
            SpawnBehavior::SpawnFails => Err(ScanError::io()),
            SpawnBehavior::Slow { duration } => {
                std::fs::write(&output, sample_bytes()).expect("fake write");
                let (child, _flag) = MockChild::exits_after(duration, true);
                Ok(Box::new(child))
            }
            SpawnBehavior::NeverExits => {
                let (child, flag) = MockChild::never();
                *self.last_kill_flag.lock().unwrap() = Some(flag);
                Ok(Box::new(child))
            }
            SpawnBehavior::CannedTails { stdout, stderr } => {
                let (child, _flag) = MockChild::exited(true);
                Ok(Box::new(child.with_tails(stdout, stderr)))
            }
            SpawnBehavior::RealSleepers { sleeper_seconds } => {
                let owned = spawn_sleeper(sleeper_seconds).map_err(|_| ScanError::io())?;
                let bystander = spawn_sleeper(sleeper_seconds).map_err(|_| ScanError::io())?;
                *self.bystander.lock().unwrap() = Some(bystander);
                Ok(Box::new(RealChild::new(owned)))
            }
        }
    }
}

fn output_path_from_args(args: &[OsString]) -> Option<PathBuf> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "-OutputPath" {
            return iter.next().map(PathBuf::from);
        }
    }
    None
}

/// A real, inert sleeper: `ping.exe -n <big> 127.0.0.1` with null stdio. It
/// owns no children itself, so killing it kills exactly one process.
fn spawn_sleeper(seconds: u64) -> std::io::Result<Child> {
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    let ping = system_root.join("System32").join("ping.exe");
    Command::new(ping)
        .args(["-n", &seconds.to_string(), "127.0.0.1"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

// ---------------------------------------------------------------------------
// Fake dialogs
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub(crate) enum DialogBehavior<T: Clone> {
    Pick(T),
    Cancel,
    Fail,
}

pub(crate) struct MockDialogs {
    pub open: Mutex<DialogBehavior<PathBuf>>,
    pub save: Mutex<DialogBehavior<PathBuf>>,
    pub open_calls: AtomicU32,
    pub save_calls: AtomicU32,
}

impl MockDialogs {
    pub(crate) fn new(
        open: DialogBehavior<PathBuf>,
        save: DialogBehavior<PathBuf>,
    ) -> Self {
        Self {
            open: Mutex::new(open),
            save: Mutex::new(save),
            open_calls: AtomicU32::new(0),
            save_calls: AtomicU32::new(0),
        }
    }

    pub(crate) fn cancelling() -> Self {
        Self::new(DialogBehavior::Cancel, DialogBehavior::Cancel)
    }
}

impl ReportDialogs for MockDialogs {
    fn pick_open_report(&self) -> Result<Option<PathBuf>, ScanError> {
        self.open_calls.fetch_add(1, Ordering::SeqCst);
        match &*self.open.lock().unwrap() {
            DialogBehavior::Pick(path) => Ok(Some(path.clone())),
            DialogBehavior::Cancel => Ok(None),
            DialogBehavior::Fail => Err(ScanError::io()),
        }
    }

    fn pick_export_path(&self) -> Result<Option<PathBuf>, ScanError> {
        self.save_calls.fetch_add(1, Ordering::SeqCst);
        match &*self.save.lock().unwrap() {
            DialogBehavior::Pick(path) => Ok(Some(path.clone())),
            DialogBehavior::Cancel => Ok(None),
            DialogBehavior::Fail => Err(ScanError::io()),
        }
    }
}
