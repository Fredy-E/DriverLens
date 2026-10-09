//! Safe collector integration (Task 8): direct process spawning, bounded
//! output capture, limits, and the production `Runner`.
//!
//! # Spawn rules (enforced here, not by callers)
//!
//! - The collector is spawned DIRECTLY — no shell (`cmd /c`, `sh -c`), no
//!   string concatenation, no per-scan overrides. The argument vector is
//!   exactly
//!   `['-NoProfile', '-NonInteractive', '-File', <bundled script>, '-OutputPath', <app-owned temp output>]`
//!   and nothing else. `-ExecutionPolicy` is never passed (the script must run
//!   under the machine's policy).
//! - The renderer cannot influence the program, the script, the arguments, or
//!   the output path: the IPC commands take no arguments and all of these are
//!   fixed by the application. Environment-based executable selection
//!   (`DRIVERLENS_POWERSHELL`) is process-scope — a webview can never set it —
//!   and is validated below.
//!
//! # Process ownership & kill semantics
//!
//! - The collector script spawns no grandchildren: all CIM/WMI queries run
//!   in-process in the PowerShell host; the only child the app owns is that
//!   PowerShell process. Killing the direct child is therefore a complete
//!   kill — documented here on purpose, because if the script ever gains
//!   child processes this reasoning must be revisited; re-verify whenever
//!   the collector script changes (nothing tracks this automatically).
//! - Cancellation and timeout call `ChildProcess::kill` on exactly the owned
//!   handle that this module spawned. No process enumeration happens anywhere;
//!   unrelated processes can never be touched.
//!
//! # Limits
//!
//! - 120 s wall deadline (production), enforced by polling `try_wait`.
//! - stdout/stderr are drained continuously into rolling tails capped at
//!   64 KiB each, so a chatty child can never deadlock on a full pipe.
//! - The report file is capped at 20 MiB BEFORE it is parsed or buffered.
//!
//! # Logging policy
//!
//! Nothing here prints report contents, device IDs, usernames, hostnames, raw
//! paths, or unbounded stderr. The bounded tails stay in memory, are stored
//! only on the (private) scan manager state, and are never serialized to the
//! webview. This module has no `println!`/`eprintln!` at all.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::report::MAX_REPORT_BYTES;
use crate::scan::ScanError;

/// Production wall-clock deadline for one collection (parity: server.cjs used
/// `timeout: 120000` for the same script).
pub const SCAN_DEADLINE: Duration = Duration::from_secs(120);

/// Cap of each captured stdout/stderr rolling tail (bytes).
pub const MAX_OUTPUT_TAIL_BYTES: usize = 64 * 1024;

/// How often the wait loop checks the child, the deadline and the cancel flag.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// The shared, owned child handle: created by the scan manager, filled by
/// [`run_collection`] right after spawn, consulted by cancel/shutdown.
pub type SharedChild = Arc<Mutex<Option<Box<dyn ChildProcess>>>>;

/// Minimal process abstraction so tests can inject fake children while the
/// production implementation drives a real `std::process::Child`.
pub trait ChildProcess: Send {
    /// Non-blocking status check; `Ok(None)` while still running.
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>>;
    /// Kills exactly this child process (direct handle, no tree walk).
    fn kill(&mut self) -> std::io::Result<()>;
    /// Blocks until exit and reaps the process.
    fn wait(&mut self) -> std::io::Result<ExitStatus>;
    /// Joins the output reader threads (valid once the process exited) and
    /// returns the bounded rolling tails as `(stdout, stderr)`.
    fn output_tails(&mut self) -> (Vec<u8>, Vec<u8>);
}

/// Everything the collection pipeline needs from the outside world. Tests
/// inject fakes; production uses [`RealRunner`]. `run_collection` never runs
/// for real inventory in tests.
pub trait Runner: Send + Sync + 'static {
    /// Resolves the collector executable, or `executable_missing`.
    fn resolve_executable(&self) -> Result<PathBuf, ScanError>;
    /// The bundled collector script path (fixed by the application).
    fn script_path(&self) -> PathBuf;
    /// Spawns the process directly with exactly `args` (no shell).
    fn spawn(&self, program: &Path, args: &[OsString]) -> Result<Box<dyn ChildProcess>, ScanError>;
}

/// Normalizes a Windows verbatim (`\\?\` / `\\?\UNC\`) path to the standard
/// Win32 form. `std::fs::canonicalize` — and therefore Tauri's resource
/// resolution, which canonicalizes the executable path — can produce verbatim
/// paths, and PowerShell's `-File` parameter REJECTS them ("SecurityError:
/// AuthorizationManager check failed", exit 1). Only those prefixes are
/// rewritten; every other path is passed through unchanged. A non-UTF-8 path
/// is passed through unchanged (this app's paths are UTF-8 in practice).
fn normalize_win32_path(path: &Path) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path.to_path_buf();
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// Builds the fixed collector argument vector. Exactly six elements; tests
/// pin this. Never contains `-ExecutionPolicy`, `-Command`, or caller input.
/// Both path elements are normalized to the standard Win32 form first: this
/// spawn boundary is where pwsh's `-File`/`-OutputPath` reject the verbatim
/// prefix that Tauri's resource resolution can introduce on Windows.
pub fn build_collector_args(script: &Path, output_path: &Path) -> Vec<OsString> {
    let script = normalize_win32_path(script);
    let output = normalize_win32_path(output_path);
    vec![
        OsString::from("-NoProfile"),
        OsString::from("-NonInteractive"),
        OsString::from("-File"),
        script.into_os_string(),
        OsString::from("-OutputPath"),
        output.into_os_string(),
    ]
}

enum WaitOutcome {
    Exited(ExitStatus),
    Cancelled,
    TimedOut,
    Failed,
}

/// Runs one collection. Always reaps the child (success, cancel, timeout,
/// failure) and always empties `slot` before returning. Never panics.
/// Returns the raw report bytes on success plus the bounded output tails.
pub fn run_collection(
    runner: &dyn Runner,
    output_path: &Path,
    deadline: Duration,
    cancel: &AtomicBool,
    slot: &SharedChild,
) -> (Result<Vec<u8>, ScanError>, (Vec<u8>, Vec<u8>)) {
    let program = match runner.resolve_executable() {
        Ok(program) => program,
        Err(error) => return (Err(error), (Vec::new(), Vec::new())),
    };
    // Fixed argument vector: the runner receives exactly these elements.
    let args = build_collector_args(&runner.script_path(), output_path);

    if cancel.load(Ordering::SeqCst) {
        return (Err(ScanError::cancelled()), (Vec::new(), Vec::new()));
    }

    let child = match runner.spawn(&program, &args) {
        Ok(child) => child,
        Err(error) => return (Err(error), (Vec::new(), Vec::new())),
    };
    *lock_slot(slot) = Some(child);

    let outcome = wait_for_child(slot, deadline, cancel);

    let mut error: Option<ScanError> = None;
    match outcome {
        WaitOutcome::Exited(status) => {
            if cancel.load(Ordering::SeqCst) {
                error = Some(ScanError::cancelled());
            } else if !status.success() {
                error = Some(ScanError::exit_failure());
            }
        }
        WaitOutcome::Cancelled => error = Some(ScanError::cancelled()),
        WaitOutcome::TimedOut => error = Some(ScanError::timeout()),
        WaitOutcome::Failed => error = Some(ScanError::io()),
    }

    // Take the owned child out of the shared slot and collect its tails. The
    // child was reaped by whichever wait path ran; a second `wait` is safe
    // (std caches the status) but is not needed here.
    let mut child = lock_slot(slot).take();
    let (stdout_tail, stderr_tail) = match child.as_mut() {
        Some(child) => child.output_tails(),
        None => (Vec::new(), Vec::new()),
    };
    drop(child);

    match error {
        Some(error) => (Err(error), (stdout_tail, stderr_tail)),
        None => match read_file_capped(output_path, MAX_REPORT_BYTES) {
            Ok(report) => (Ok(report), (stdout_tail, stderr_tail)),
            Err(ReadError::Missing) => (Err(ScanError::output_missing()), (stdout_tail, stderr_tail)),
            Err(ReadError::TooLarge) => (Err(ScanError::too_large()), (stdout_tail, stderr_tail)),
            Err(ReadError::Io) => (Err(ScanError::io()), (stdout_tail, stderr_tail)),
        },
    }
}

/// Polls the owned child: returns on exit, on the cancel flag, on the
/// deadline, or on a wait error. On cancel/timeout the owned child is killed
/// (direct `Child::kill` equivalent) and reaped before returning.
fn wait_for_child(slot: &SharedChild, deadline: Duration, cancel: &AtomicBool) -> WaitOutcome {
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            kill_owned(slot);
            return WaitOutcome::Cancelled;
        }
        if started.elapsed() >= deadline {
            kill_owned(slot);
            return WaitOutcome::TimedOut;
        }
        let poll = lock_slot(slot).as_mut().map(|child| child.try_wait());
        match poll {
            Some(Ok(Some(status))) => {
                // A cancel that raced natural exit still wins: the scan is
                // reported cancelled and its output is not accepted.
                return if cancel.load(Ordering::SeqCst) {
                    WaitOutcome::Cancelled
                } else {
                    WaitOutcome::Exited(status)
                };
            }
            Some(Ok(None)) => {}
            Some(Err(_)) => {
                kill_owned(slot);
                return WaitOutcome::Failed;
            }
            None => return WaitOutcome::Failed,
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

fn kill_owned(slot: &SharedChild) {
    if let Some(child) = lock_slot(slot).as_mut() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn lock_slot(slot: &SharedChild) -> MutexGuard<'_, Option<Box<dyn ChildProcess>>> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Failure classifier for reading a candidate report file.
#[derive(Debug)]
pub enum ReadError {
    /// The file does not exist.
    Missing,
    /// The file exceeds the byte cap (checked before buffering).
    TooLarge,
    /// Any other I/O failure (permission denied, is-a-directory, ...).
    Io,
}

/// Reads at most `cap` bytes; refuses larger files before parsing/buffering.
pub fn read_file_capped(path: &Path, cap: usize) -> Result<Vec<u8>, ReadError> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(ReadError::Missing),
        Err(_) => return Err(ReadError::Io),
    };
    if let Ok(metadata) = file.metadata() {
        if metadata.len() > cap as u64 {
            return Err(ReadError::TooLarge);
        }
    }
    let mut bytes = Vec::new();
    let mut limited = file.take(cap as u64 + 1);
    limited.read_to_end(&mut bytes).map_err(|_| ReadError::Io)?;
    if bytes.len() > cap {
        return Err(ReadError::TooLarge);
    }
    Ok(bytes)
}

/// Rolling byte tail: keeps the LAST `capacity` bytes pushed.
pub struct BoundedTail {
    capacity: usize,
    bytes: Vec<u8>,
}

impl BoundedTail {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            bytes: Vec::new(),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > self.capacity {
            let excess = self.bytes.len() - self.capacity;
            self.bytes.drain(..excess);
        }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    #[cfg(test)]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

// ---------------------------------------------------------------------------
// Production runner
// ---------------------------------------------------------------------------

/// The production runner: resolves `pwsh.exe` from trusted, fixed locations
/// and spawns the bundled collector script directly.
pub struct RealRunner {
    script: PathBuf,
}

impl RealRunner {
    pub fn new(script: PathBuf) -> Self {
        Self { script }
    }

    /// Trusted executable resolution — never renderer-supplied:
    ///
    /// 1. `DRIVERLENS_POWERSHELL` (explicit operator selection, parity with
    ///    the browser edition's `server.cjs`): must be an absolute path to an
    ///    existing `pwsh.exe` / `powershell.exe`. If it is set but invalid the
    ///    scan fails with `executable_missing` (fail closed — a broken
    ///    override is never silently ignored).
    /// 2. `%ProgramFiles%\PowerShell\7\pwsh.exe` (the standard PS7 location).
    /// 3. A controlled full-path search of `pwsh.exe` across the process
    ///    `PATH` — absolute entries only, no current-directory search, no
    ///    shell resolution.
    ///
    /// No other fallback exists: the app never degrades to a generic shell.
    pub fn resolve_executable() -> Result<PathBuf, ScanError> {
        if let Some(raw) = std::env::var_os("DRIVERLENS_POWERSHELL") {
            let path = PathBuf::from(raw);
            if is_trusted_override(&path) {
                return Ok(path);
            }
            return Err(ScanError::executable_missing());
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let candidate = PathBuf::from(program_files)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        if let Some(path_var) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path_var) {
                if dir.as_os_str().is_empty() || !dir.is_absolute() {
                    continue;
                }
                let candidate = dir.join("pwsh.exe");
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
        Err(ScanError::executable_missing())
    }
}

fn is_trusted_override(path: &Path) -> bool {
    if !path.is_absolute() || !path.is_file() {
        return false;
    }
    match path.file_name().and_then(|name| name.to_str()) {
        Some(name) => {
            name.eq_ignore_ascii_case("pwsh.exe") || name.eq_ignore_ascii_case("powershell.exe")
        }
        None => false,
    }
}

impl Runner for RealRunner {
    fn resolve_executable(&self) -> Result<PathBuf, ScanError> {
        Self::resolve_executable()
    }

    fn script_path(&self) -> PathBuf {
        self.script.clone()
    }

    fn spawn(&self, program: &Path, args: &[OsString]) -> Result<Box<dyn ChildProcess>, ScanError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: parity with the browser edition's
            // `windowsHide: true`; a GUI app must not flash a console.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command.spawn().map_err(|_| ScanError::io())?;
        Ok(Box::new(RealChild::new(child)))
    }
}

/// Real child wrapper with drain-as-you-go bounded output capture.
pub(crate) struct RealChild {
    child: Option<std::process::Child>,
    stdout_reader: Option<std::thread::JoinHandle<BoundedTail>>,
    stderr_reader: Option<std::thread::JoinHandle<BoundedTail>>,
    stdout_tail: Vec<u8>,
    stderr_tail: Vec<u8>,
}

impl RealChild {
    pub(crate) fn new(mut child: std::process::Child) -> Self {
        let stdout_reader = child
            .stdout
            .take()
            .map(|reader| std::thread::spawn(move || drain_into_tail(reader, MAX_OUTPUT_TAIL_BYTES)));
        let stderr_reader = child
            .stderr
            .take()
            .map(|reader| std::thread::spawn(move || drain_into_tail(reader, MAX_OUTPUT_TAIL_BYTES)));
        Self {
            child: Some(child),
            stdout_reader,
            stderr_reader,
            stdout_tail: Vec::new(),
            stderr_tail: Vec::new(),
        }
    }

    fn join_readers(&mut self) {
        if let Some(handle) = self.stdout_reader.take() {
            if let Ok(tail) = handle.join() {
                self.stdout_tail = tail.into_bytes();
            }
        }
        if let Some(handle) = self.stderr_reader.take() {
            if let Ok(tail) = handle.join() {
                self.stderr_tail = tail.into_bytes();
            }
        }
    }

    fn exited(&mut self) -> bool {
        matches!(
            self.child.as_mut().and_then(|child| child.try_wait().ok()),
            Some(Some(_))
        )
    }
}

fn drain_into_tail<R: Read>(mut reader: R, capacity: usize) -> BoundedTail {
    let mut tail = BoundedTail::new(capacity);
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => tail.push(&buffer[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    tail
}

fn no_child_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::NotFound, "child process not available")
}

impl ChildProcess for RealChild {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        let status = self
            .child
            .as_mut()
            .ok_or_else(no_child_error)?
            .try_wait()?;
        if status.is_some() {
            // The pipes close at exit; joining here (never before) cannot
            // block because the collector script spawns no grandchildren
            // that could keep the handles open.
            self.join_readers();
        }
        Ok(status)
    }

    fn kill(&mut self) -> std::io::Result<()> {
        self.child.as_mut().ok_or_else(no_child_error)?.kill()
    }

    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        let status = self.child.as_mut().ok_or_else(no_child_error)?.wait()?;
        self.join_readers();
        Ok(status)
    }

    fn output_tails(&mut self) -> (Vec<u8>, Vec<u8>) {
        if self.exited() {
            self.join_readers();
        }
        (self.stdout_tail.clone(), self.stderr_tail.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_as_strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn collector_args_are_the_fixed_six_element_vector() {
        let script = Path::new(r"C:\Program Files\DriverLens\resources\Collect-DriverLens.ps1");
        let output = Path::new(r"C:\Users\test\AppData\Local\com.fredye.driverlens\scans\scan-3-abc.json");
        let args = build_collector_args(script, output);
        assert_eq!(
            args_as_strings(&args),
            vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-File".to_string(),
                script.to_string_lossy().into_owned(),
                "-OutputPath".to_string(),
                output.to_string_lossy().into_owned(),
            ]
        );
        // Negative assertions: no policy bypass, no shell/command switches,
        // no extra elements.
        assert_eq!(args.len(), 6);
        for forbidden in ["-ExecutionPolicy", "Bypass", "-Command", "-EncodedCommand"] {
            assert!(
                !args_as_strings(&args).iter().any(|arg| arg == forbidden),
                "{forbidden} must never appear"
            );
        }
    }

    #[test]
    fn bounded_tail_keeps_the_last_capacity_bytes() {
        let mut tail = BoundedTail::new(10);
        tail.push(b"abc");
        assert_eq!(tail.as_bytes(), b"abc");
        tail.push(b"defghij");
        assert_eq!(tail.as_bytes(), b"abcdefghij");
        tail.push(b"klm");
        assert_eq!(tail.as_bytes(), b"defghijklm");
        // A single oversize chunk also keeps only its last 10 bytes.
        let mut tail = BoundedTail::new(4);
        tail.push(b"0123456789");
        assert_eq!(tail.as_bytes(), b"6789");
        let mut tail = BoundedTail::new(4);
        tail.push(&[b'x'; MAX_OUTPUT_TAIL_BYTES + 100]);
        assert_eq!(tail.into_bytes().len(), 4);
    }

    #[test]
    fn read_file_capped_classifies_missing_oversized_and_ok() {
        let dir = crate::test_fakes::scratch_dir("read-capped");
        let missing = dir.join("missing.json");
        assert!(matches!(
            read_file_capped(&missing, 64),
            Err(ReadError::Missing)
        ));

        let ok = dir.join("ok.json");
        std::fs::write(&ok, b"{\"schemaVersion\":1}").unwrap();
        assert_eq!(read_file_capped(&ok, 64).unwrap(), b"{\"schemaVersion\":1}");

        let big = dir.join("big.json");
        std::fs::write(&big, vec![b'x'; 65]).unwrap();
        assert!(matches!(read_file_capped(&big, 64), Err(ReadError::TooLarge)));

        // A directory is not readable as a file: classified as a permission
        // style I/O failure (Platform: opening a directory is Access denied).
        let dir_as_file = dir.join("as-file");
        std::fs::create_dir_all(&dir_as_file).unwrap();
        assert!(matches!(
            read_file_capped(&dir_as_file, 64),
            Err(ReadError::Io)
        ));
    }

    /// Real-process smoke test for the production child wrapper: spawns
    /// `cmd /c echo` (textbook-safe, never an inventory tool) and checks
    /// captured tails and exit handling.
    #[test]
    fn real_child_captures_output_and_exits() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/c", "echo", "driverlens-probe"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().expect("cmd.exe must be spawnable");
        let mut child = RealChild::new(child);
        let status = child.wait().expect("wait must succeed");
        assert!(status.success());
        let (stdout, stderr) = child.output_tails();
        assert!(stdout.windows(16).any(|w| w == b"driverlens-probe"));
        assert!(stderr.is_empty());
    }

    /// The rolling window holds under real load: ~100 KiB of output keeps
    /// exactly the last 64 KiB.
    #[test]
    fn real_child_rolling_tail_is_bounded_under_load() {
        let mut command = Command::new("cmd.exe");
        command
            .args([
                "/c",
                "for /L %i in (1,1,2000) do @echo AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().expect("cmd.exe must be spawnable");
        let mut child = RealChild::new(child);
        let status = child.wait().expect("wait must succeed");
        assert!(status.success());
        let (stdout, _) = child.output_tails();
        assert_eq!(stdout.len(), MAX_OUTPUT_TAIL_BYTES);
        // The tail is the END of the stream: only 'A' and CR/LF bytes.
        assert!(stdout
            .iter()
            .all(|byte| *byte == b'A' || *byte == b'\r' || *byte == b'\n'));
    }

    /// The bundled resource must be byte-identical to the reviewed
    /// repository-root script. Skipped (with a note) when the desktop folder
    /// is checked out standalone without the repository root.
    #[test]
    fn bundled_collector_script_matches_reviewed_source() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let bundled = manifest_dir.join("resources").join("Collect-DriverLens.ps1");
        let bundled_bytes = std::fs::read(&bundled).expect("bundled collector script must exist");
        let source = manifest_dir.join("..").join("..").join("Collect-DriverLens.ps1");
        let Ok(source_bytes) = std::fs::read(&source) else {
            eprintln!(
                "note: repository-root {} is absent; parity check skipped",
                source.display()
            );
            return;
        };
        assert_eq!(
            bundled_bytes, source_bytes,
            "bundled Collect-DriverLens.ps1 must be byte-identical to the reviewed source"
        );
    }

    /// The bundled window closes both `helper` functions parity: the bundled
    /// script must still expose a param block and the read-only header.
    #[test]
    fn bundled_collector_script_keeps_its_contract_header() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(
            manifest_dir.join("resources").join("Collect-DriverLens.ps1"),
        )
        .expect("bundled collector script must exist");
        assert!(text.contains("param("));
        assert!(text.contains("[switch]$FunctionsOnly"));
        assert!(text.contains("Inventory only: this script does not install, disable, modify, or remove drivers."));
    }

    /// Regression (found in the first real-hardware scan of the release
    /// build): Tauri's resource resolution canonicalizes the executable path,
    /// so the bundled script path can arrive carrying the Windows verbatim
    /// prefix (`\\?\`). pwsh rejects a verbatim `-File` argument with
    /// "SecurityError: AuthorizationManager check failed" (exit 1) — the
    /// spawn must always receive the standard form.
    #[test]
    fn verbatim_paths_are_normalized_for_the_pwsh_arguments() {
        let script = Path::new(r"\\?\C:\app\resources\Collect-DriverLens.ps1");
        let output =
            Path::new(r"\\?\C:\Users\test\AppData\Local\com.fredye.driverlens\scans\scan-1-a.json");
        let args = args_as_strings(&build_collector_args(script, output));
        assert_eq!(args[3], r"C:\app\resources\Collect-DriverLens.ps1");
        assert_eq!(
            args[5],
            r"C:\Users\test\AppData\Local\com.fredye.driverlens\scans\scan-1-a.json"
        );
        assert!(
            args.iter().all(|arg| !arg.contains(r"\\?\")),
            "no argument may keep a verbatim prefix"
        );
    }

    /// The verbatim UNC form maps back to the standard UNC form.
    #[test]
    fn verbatim_unc_paths_map_to_the_standard_unc_form() {
        let args = args_as_strings(&build_collector_args(
            Path::new(r"\\?\UNC\server\share\Collect-DriverLens.ps1"),
            Path::new(r"\\?\UNC\server\share\out.json"),
        ));
        assert_eq!(args[3], r"\\server\share\Collect-DriverLens.ps1");
        assert_eq!(args[5], r"\\server\share\out.json");
    }

    /// Acceptance proof against a REAL PowerShell: the exact argument builder
    /// output must be accepted by pwsh's `-File`. Runs a harmless stub script
    /// (no inventory, no device data); skips with a note when no pwsh exists.
    #[test]
    fn real_pwsh_accepts_the_normalized_file_argument() {
        let program = match RealRunner::resolve_executable() {
            Ok(program) => program,
            Err(_) => {
                eprintln!("note: pwsh is not resolvable; real-pwsh acceptance test skipped");
                return;
            }
        };
        let dir = crate::test_fakes::scratch_dir("pwsh-verbatim");
        let stub = dir.join("stub-collector.ps1");
        std::fs::write(
            &stub,
            "param([string]$OutputPath) [IO.File]::WriteAllText($OutputPath, '{\"schemaVersion\":1,\"devices\":[]}')",
        )
        .unwrap();
        // Deliberately verbatim — exactly what canonicalization produces.
        let verbatim_script = PathBuf::from(format!(r"\\?\{}", stub.display()));
        let output = dir.join("out.json");
        let args = build_collector_args(&verbatim_script, &output);
        let mut command = Command::new(&program);
        command
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().expect("pwsh must be spawnable");
        let status = child.wait().expect("wait must succeed");
        assert!(
            status.success(),
            "real pwsh rejected the collector argument vector (exit {:?})",
            status.code()
        );
        assert!(
            output.is_file(),
            "the stub collector must have written its output"
        );
    }
}
