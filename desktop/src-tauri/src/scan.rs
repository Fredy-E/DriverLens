//! Scan lifecycle (Task 8): the state machine (Idle → Running →
//! Complete/Error/Cancelled), a generation counter, the in-memory current
//! report, and the native file-dialog abstraction used by `open_report` /
//! `export_report` (Task 7).
//!
//! # Concurrency model
//!
//! One `Mutex<Inner>` guards every field of the lifecycle, so all transitions
//! are atomic with respect to each other:
//!
//! - `start_scan` accepts a scan only from a non-`Running` state and bumps the
//!   generation; a duplicate start while `Running` fails with `busy`
//!   (message parity: the browser helper answered 409 "A scan is already
//!   running."). Every terminal path (Complete, Error, Cancelled) leaves the
//!   machine ready for the next scan.
//! - The scan itself runs on a dedicated `std::thread` (never the UI thread).
//!   When it finishes it re-checks the generation before writing state, so a
//!   stale thread can never clobber a newer scan.
//! - `cancel_scan` is idempotent: it only acts when a scan is `Running`; it
//!   flags cancellation and kills exactly the owned child process. The scan
//!   thread observes the flag (or the kill) and finishes as `Cancelled` with
//!   no report accepted and no output file kept.
//!
//! # Generation-matched output
//!
//! Every scan writes to a unique app-owned temp file
//! `scan-<generation>-<random>.json` inside the manager's private `scans/`
//! directory (app local data; never the repository, never OneDrive-synced
//! folders). A previous scan's file can never be reused or mistaken for the
//! current scan's output: the name is new per generation, the path is checked
//! fresh, and the file is deleted after every terminal path. Leftovers from
//! crashed runs are purged best-effort on the next scan (only files matching
//! this exact naming scheme older than one hour).
//!
//! # What `get_scan_state` exposes
//!
//! `{state, generation, startedMs?, errorCode?, deviceCount?}` — nothing else.
//! Never report contents, never raw paths, never stderr text.
//!
//! # Import / export semantics
//!
//! `open_report` (native open dialog, Rust side) parses and validates the
//! picked file and, on success, also replaces the *current in-memory report*
//! that `export_report` writes. Import does not touch the scan lifecycle.
//! `export_report` writes the current report as pretty-printed schemaVersion 1
//! JSON through a native save dialog; the dialog's own overwrite confirmation
//! is the only overwrite confirmation (no silent overwrite beyond it).
//!
//! `export_report` accepts exactly ONE optional argument, `ids: string[]`
//! (Task 10 filtered export): a list of device digests. It is NOT a path,
//! NOT a filter expression and NOT a destination — every id is validated
//! against the current report (unknown ids are refused with
//! `invalid_selection` BEFORE the dialog opens) and used only for set
//! membership. The written document contains exactly the selected devices in
//! report order, plus `filterNote` (a schemaVersion-1-compatible extension:
//! unknown top-level fields are tolerated, so a filtered export revalidates
//! as a v1 report). Absent `ids` exports the full stored report unchanged.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::collector::{self, Runner, SharedChild};
use crate::notebook::NotebookStore;
use crate::report;

/// Stable error vocabulary shared by every IPC command. The `code` values are
/// the contract (the frontend adapter types them); messages are static,
/// human-readable text that never contains report contents or raw paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanErrorCode {
    Busy,
    ExecutableMissing,
    Timeout,
    Cancelled,
    ExitFailure,
    OutputMissing,
    TooLarge,
    InvalidReport,
    /// A filtered-export selection that does not match the current report
    /// (unknown device id, or more ids than the device cap).
    InvalidSelection,
    /// `save_device_note` for a key that is not in the notebook store.
    UnknownKey,
    /// A notebook note beyond the 4000-character cap.
    NoteTooLong,
    Io,
}

impl ScanErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            ScanErrorCode::Busy => "busy",
            ScanErrorCode::ExecutableMissing => "executable_missing",
            ScanErrorCode::Timeout => "timeout",
            ScanErrorCode::Cancelled => "cancelled",
            ScanErrorCode::ExitFailure => "exit_failure",
            ScanErrorCode::OutputMissing => "output_missing",
            ScanErrorCode::TooLarge => "too_large",
            ScanErrorCode::InvalidReport => "invalid_report",
            ScanErrorCode::InvalidSelection => "invalid_selection",
            ScanErrorCode::UnknownKey => "unknown_key",
            ScanErrorCode::NoteTooLong => "note_too_long",
            ScanErrorCode::Io => "io",
        }
    }
}

/// Serialized command error: `{ code, message }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScanError {
    pub code: ScanErrorCode,
    pub message: String,
}

impl ScanError {
    pub fn new(code: ScanErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Scan already running. Message matches the browser helper's 409 body
    /// (`server.cjs:38`) so the product voice is preserved.
    pub fn busy() -> Self {
        Self::new(ScanErrorCode::Busy, "A scan is already running.")
    }

    pub fn executable_missing() -> Self {
        Self::new(
            ScanErrorCode::ExecutableMissing,
            "PowerShell 7 (pwsh.exe) was not found. Install PowerShell 7 or set DRIVERLENS_POWERSHELL to its trusted executable path.",
        )
    }

    pub fn timeout() -> Self {
        Self::new(
            ScanErrorCode::Timeout,
            "The scan timed out before the collector finished.",
        )
    }

    pub fn cancelled() -> Self {
        Self::new(ScanErrorCode::Cancelled, "The scan was cancelled.")
    }

    pub fn exit_failure() -> Self {
        Self::new(
            ScanErrorCode::ExitFailure,
            "The collector exited with a nonzero status.",
        )
    }

    pub fn output_missing() -> Self {
        Self::new(
            ScanErrorCode::OutputMissing,
            "The collector did not produce a report.",
        )
    }

    pub fn too_large() -> Self {
        Self::new(
            ScanErrorCode::TooLarge,
            "The report exceeds the 20 MiB limit.",
        )
    }

    pub fn invalid_report() -> Self {
        Self::new(
            ScanErrorCode::InvalidReport,
            "The scan output is not a valid DriverLens v1 report.",
        )
    }

    /// Rejection of a filtered-export selection (unknown ids, oversized
    /// list). The message never echoes device data — only counts.
    pub fn invalid_selection(message: impl Into<String>) -> Self {
        Self::new(ScanErrorCode::InvalidSelection, message)
    }

    /// Rejection of an empty HTML payload (a renderer bug; refused before the
    /// dialog opens). Fixed template — never carries data.
    pub fn html_empty() -> Self {
        Self::new(ScanErrorCode::InvalidReport, "The HTML report is empty.")
    }

    /// Rejection of an HTML payload above [`MAX_HTML_BYTES`].
    pub fn html_too_large() -> Self {
        Self::new(
            ScanErrorCode::TooLarge,
            "The HTML report exceeds the 8 MiB limit.",
        )
    }

    pub fn io() -> Self {
        Self::new(ScanErrorCode::Io, "An unexpected operating system error occurred.")
    }
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ScanError {}

/// Lifecycle states — closed set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanState {
    Idle,
    Running,
    Complete,
    Error,
    Cancelled,
}

/// The only scan shape the frontend ever receives. Deliberately minimal: no
/// report contents, no paths, no stderr.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSnapshot {
    pub state: ScanState,
    /// Increments once per accepted scan start; 0 before the first scan.
    pub generation: u64,
    /// Present only while `Running` (wall-clock start, ms since UNIX epoch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_ms: Option<u64>,
    /// Present only when `state == "error"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<ScanErrorCode>,
    /// Device count of the current in-memory report (last accepted scan or
    /// import), when one exists. Independent of the scan lifecycle state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_count: Option<u64>,
}

/// What `export_report` returns on success: the number of bytes written to
/// the user-chosen destination. The path itself is never sent to the webview.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub bytes_written: u64,
}

/// `filterNote` stamped into filtered exports — browser edition parity
/// (work/DriverLens/app.js:14). A schemaVersion-1-compatible extension:
/// unknown top-level fields are tolerated by the contract, so a filtered
/// export still revalidates as a v1 report.
pub const FILTERED_EXPORT_NOTE: &str = "Filtered export from DriverLens";

/// Hard cap on an exported HTML report document (8 MiB). The renderer builds
/// the document; the cap bounds whatever it can ask to be written, and is
/// enforced before the save dialog opens.
pub const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;

/// Native file dialogs, abstracted so the command logic is testable without
/// a window. `Ok(None)` means the user cancelled — a normal outcome, not an
/// error. Production uses [`crate::commands::TauriReportDialogs`] (Tauri's
/// Rust dialog API); tests inject fakes.
pub trait ReportDialogs: Send + Sync + 'static {
    /// Native open dialog for importing a report; `None` on user cancel.
    fn pick_open_report(&self) -> Result<Option<PathBuf>, ScanError>;
    /// Native save dialog for exporting; `None` on user cancel.
    fn pick_export_path(&self) -> Result<Option<PathBuf>, ScanError>;
    /// Native save dialog for the portable HTML export; `None` on user
    /// cancel. `suggested_name` is only the dialog's default file name — it
    /// is sanitized by [`sanitize_export_file_name`] before it reaches the
    /// dialog and never influences the written destination.
    fn pick_export_html_path(&self, suggested_name: &str) -> Result<Option<PathBuf>, ScanError>;
}

/// Construction parameters for [`ScanManager`].
pub struct ScanManagerConfig {
    pub runner: Arc<dyn Runner>,
    pub dialogs: Option<Arc<dyn ReportDialogs>>,
    /// Private app-owned directory for per-scan temp output files.
    pub scans_dir: PathBuf,
    /// Wall deadline for one collection (production: [`collector::SCAN_DEADLINE`]).
    pub deadline: Duration,
}

struct Inner {
    state: ScanState,
    generation: u64,
    started_ms: Option<u64>,
    error: Option<ScanError>,
    /// Current in-memory report (last accepted scan or import), stored as the
    /// original parsed JSON so unknown schemaVersion 1 fields survive a
    /// re-export (passthrough, normalized only in `schemaVersion`).
    report: Option<Value>,
    cancel: Option<Arc<AtomicBool>>,
    child: Option<SharedChild>,
    /// Bounded stdout/stderr tails of the most recent attempt — test-only
    /// diagnostics: written on every terminal path (each tail capped at
    /// 64 KiB by the collector), read only by `last_tails_for_test`
    /// (`#[cfg(test)]`), which pins the guarantee that these bytes never
    /// reach the webview. Never serialized, never logged, never returned by
    /// any IPC command.
    #[allow(dead_code)] // read only via last_tails_for_test in test builds
    last_tails: Option<(Vec<u8>, Vec<u8>)>,
}

/// Owns the scan lifecycle and the current report. Cheap to construct; lives
/// in Tauri managed state.
pub struct ScanManager {
    inner: Arc<Mutex<Inner>>,
    runner: Arc<dyn Runner>,
    dialogs: Option<Arc<dyn ReportDialogs>>,
    scans_dir: PathBuf,
    deadline: Duration,
    /// Optional notebook store (extension E-01). Attached once during setup;
    /// when present, an accepted scan records one observation per device —
    /// best-effort, never failing or blocking the scan.
    notebook: Mutex<Option<Arc<NotebookStore>>>,
}

impl ScanManager {
    pub fn new(config: ScanManagerConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: ScanState::Idle,
                generation: 0,
                started_ms: None,
                error: None,
                report: None,
                cancel: None,
                child: None,
                last_tails: None,
            })),
            runner: config.runner,
            dialogs: config.dialogs,
            scans_dir: config.scans_dir,
            deadline: config.deadline,
            notebook: Mutex::new(None),
        }
    }

    /// Attaches the notebook store used to record accepted scans. Production
    /// wires this once in `lib.rs` before the manager is managed; tests may
    /// omit it entirely (recording is then a no-op).
    pub fn attach_notebook(&self, store: Arc<NotebookStore>) {
        *self
            .notebook
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(store);
    }

    fn notebook_store(&self) -> Option<Arc<NotebookStore>> {
        self.notebook
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// The only shape the frontend receives.
    pub fn snapshot(&self) -> ScanSnapshot {
        let guard = self.lock();
        guard.snapshot()
    }

    /// The current validated in-memory report (last accepted scan or import),
    /// exactly the value `export_report` writes, or `None` when none exists.
    /// Read-only: cloned under the state lock; never mutates anything. Served
    /// by the `get_report` command so the UI can display a freshly scanned
    /// report through the same table path as imports.
    pub fn current_report(&self) -> Option<Value> {
        self.lock().report.clone()
    }

    /// Starts a scan. Non-blocking: the collection runs on its own thread.
    /// Returns the `Running` snapshot, or `busy` when one is already running.
    pub fn start_scan(&self) -> Result<ScanSnapshot, ScanError> {
        let (snapshot, generation, cancel, slot) = {
            let mut guard = self.lock();
            if guard.state == ScanState::Running {
                return Err(ScanError::busy());
            }
            guard.generation += 1;
            guard.state = ScanState::Running;
            guard.started_ms = Some(now_ms());
            guard.error = None;
            // The previous report stays current until a new one is accepted;
            // a failed or cancelled scan never clears it.
            let cancel = Arc::new(AtomicBool::new(false));
            let slot: SharedChild = Arc::new(Mutex::new(None));
            guard.cancel = Some(cancel.clone());
            guard.child = Some(slot.clone());
            (guard.snapshot(), guard.generation, cancel, slot)
        };

        let inner = self.inner.clone();
        let runner = self.runner.clone();
        let scans_dir = self.scans_dir.clone();
        let deadline = self.deadline;
        let notebook = self.notebook_store();
        let spawned = std::thread::Builder::new()
            .name(format!("driverlens-scan-{generation}"))
            .spawn(move || {
                run_scan_thread(
                    inner, runner, scans_dir, deadline, generation, cancel, slot, notebook,
                );
            });

        if let Err(_spawn_error) = spawned {
            let mut guard = self.lock();
            // Only fail the state if this generation is still the current one.
            if guard.generation == generation && guard.state == ScanState::Running {
                guard.state = ScanState::Error;
                guard.error = Some(ScanError::io());
                guard.started_ms = None;
                guard.cancel = None;
                guard.child = None;
            }
            return Err(ScanError::io());
        }
        Ok(snapshot)
    }

    /// Idempotent cancel: flags cancellation and kills exactly the owned
    /// child when a scan is running; a no-op otherwise (including when the
    /// scan already finished — cancel then races completion, completion
    /// wins). Never blocks; the scan thread finishes as `Cancelled`.
    pub fn cancel_scan(&self) {
        let (cancel, slot) = {
            let guard = self.lock();
            if guard.state != ScanState::Running {
                return;
            }
            (guard.cancel.clone(), guard.child.clone())
        };
        if let Some(cancel) = cancel {
            cancel.store(true, Ordering::SeqCst);
        }
        if let Some(slot) = slot {
            if let Some(child) = slot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_mut()
            {
                let _ = child.kill();
            }
        }
    }

    /// Best-effort shutdown for application exit: kills the owned child (if
    /// any) so closing the app never orphans its collector. Does not block on
    /// the scan thread; process teardown reaps whatever remains.
    pub fn shutdown(&self) {
        self.cancel_scan();
    }

    /// Import a report through the native open dialog. On success the
    /// validated report also becomes the current in-memory report (so
    /// `export_report` can write it back). `Ok(None)` = user cancelled.
    pub fn open_report(&self) -> Result<Option<Value>, ScanError> {
        let dialogs = self.dialogs().ok_or_else(dialogs_unavailable)?;
        let Some(path) = dialogs.pick_open_report()? else {
            return Ok(None);
        };
        let bytes = match collector::read_file_capped(&path, report::MAX_REPORT_BYTES) {
            Ok(bytes) => bytes,
            Err(collector::ReadError::TooLarge) => return Err(ScanError::too_large()),
            Err(collector::ReadError::Missing) | Err(collector::ReadError::Io) => {
                return Err(ScanError::new(
                    ScanErrorCode::Io,
                    "The selected file could not be read.",
                ))
            }
        };
        let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| {
            ScanError::new(
                ScanErrorCode::InvalidReport,
                "The selected file is not valid JSON.",
            )
        })?;
        let parsed = report::validate_report_value(&value).map_err(|error| {
            // Validator messages are static templates with index numbers only;
            // they never carry paths or device data.
            ScanError::new(ScanErrorCode::InvalidReport, error.message)
        })?;
        let device_count = parsed.devices.len();
        debug_assert!(device_count <= report::MAX_DEVICES);
        normalize_schema_version(&mut value);
        self.lock().report = Some(value.clone());
        Ok(Some(value))
    }

    /// Export the current in-memory report through the native save dialog as
    /// pretty-printed schemaVersion 1 JSON. Refused with `output_missing`
    /// when there is nothing to export. `Ok(None)` = user cancelled. The
    /// save dialog owns any overwrite confirmation.
    ///
    /// `ids` selects a FILTERED export: when `Some`, the written document
    /// contains exactly the devices whose `id` is in the list (report order,
    /// deduplicated) plus `filterNote` (see [`FILTERED_EXPORT_NOTE`]). Every
    /// id must exist in the current report and the list may carry at most
    /// [`report::MAX_DEVICES`] entries; anything else is refused with
    /// `invalid_selection` BEFORE the save dialog opens. Ids are opaque
    /// display strings — never paths, never evaluated. When `None`, the full
    /// stored report is written unchanged.
    pub fn export_report(
        &self,
        ids: Option<Vec<String>>,
    ) -> Result<Option<ExportSummary>, ScanError> {
        let value = {
            let guard = self.lock();
            guard.report.clone().ok_or_else(|| {
                ScanError::new(
                    ScanErrorCode::OutputMissing,
                    "No report is available to export.",
                )
            })?
        };
        let value = match ids {
            None => value,
            Some(ids) => filter_report_devices(&value, &ids)?,
        };
        let dialogs = self.dialogs().ok_or_else(dialogs_unavailable)?;
        let Some(path) = dialogs.pick_export_path()? else {
            return Ok(None);
        };
        let json = serde_json::to_string_pretty(&value).map_err(|_| ScanError::io())?;
        std::fs::write(&path, json.as_bytes()).map_err(|_| ScanError::io())?;
        Ok(Some(ExportSummary {
            bytes_written: json.len() as u64,
        }))
    }

    /// Export a renderer-built, self-contained HTML document through the
    /// native save dialog. The document comes from the frontend (built from
    /// the validated report — redacted by default); this side enforces the
    /// payload contract before the dialog ever opens:
    ///
    /// - an empty payload is refused with `invalid_report`;
    /// - a payload above [`MAX_HTML_BYTES`] (8 MiB) is refused with
    ///   `too_large`;
    /// - `suggested_name` is sanitized ([`sanitize_export_file_name`]) and
    ///   used ONLY as the dialog's default file name — the written path is
    ///   always the user's dialog choice.
    ///
    /// `Ok(None)` = user cancelled. Returns the byte count written.
    pub fn export_html_report(
        &self,
        html: String,
        suggested_name: String,
    ) -> Result<Option<ExportSummary>, ScanError> {
        if html.is_empty() {
            return Err(ScanError::html_empty());
        }
        if html.len() > MAX_HTML_BYTES {
            return Err(ScanError::html_too_large());
        }
        let file_name = sanitize_export_file_name(&suggested_name);
        let dialogs = self.dialogs().ok_or_else(dialogs_unavailable)?;
        let Some(path) = dialogs.pick_export_html_path(&file_name)? else {
            return Ok(None);
        };
        std::fs::write(&path, html.as_bytes()).map_err(|_| ScanError::io())?;
        Ok(Some(ExportSummary {
            bytes_written: html.len() as u64,
        }))
    }

    fn dialogs(&self) -> Option<Arc<dyn ReportDialogs>> {
        self.dialogs.clone()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Test-only: polls until the machine leaves `Running` (panics after the
    /// timeout so a stuck scan fails loudly instead of hanging).
    #[cfg(test)]
    pub(crate) fn wait_for_terminal_for_test(&self, timeout: Duration) -> ScanSnapshot {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let snapshot = self.snapshot();
            if snapshot.state != ScanState::Running {
                return snapshot;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "scan did not reach a terminal state in time: {snapshot:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Test-only: the current in-memory report.
    #[cfg(test)]
    pub(crate) fn current_report_for_test(&self) -> Option<Value> {
        self.lock().report.clone()
    }

    /// Test-only: the bounded output tails of the most recent attempt.
    #[cfg(test)]
    pub(crate) fn last_tails_for_test(&self) -> Option<(Vec<u8>, Vec<u8>)> {
        self.lock().last_tails.clone()
    }
}

fn dialogs_unavailable() -> ScanError {
    ScanError::new(
        ScanErrorCode::Io,
        "Native file dialogs are unavailable in this session.",
    )
}

/// Cap on the sanitized default file name, in characters, INCLUDING the
/// `.html` extension.
const MAX_EXPORT_FILE_NAME_CHARS: usize = 120;

/// Extension the export dialog's default file name always carries.
const HTML_EXTENSION: &str = ".html";

/// Sanitize the renderer-suggested default file name for the HTML save
/// dialog. The result is cosmetic only (the dialog's own default); the
/// written destination always comes from the user's dialog choice.
///
/// - path separators (`/`, `\`, `:`) and control characters are removed, so
///   the suggested name can never read as a path;
/// - whitespace and leading/trailing dots are trimmed; an empty remainder
///   falls back to `driverlens-report`;
/// - the FINAL name, `.html` extension included, is capped at
///   [`MAX_EXPORT_FILE_NAME_CHARS`] characters: the stem is truncated so the
///   extension always fits;
/// - `.html` is appended when the name does not already end with it
///   (case-insensitive); an existing suffix keeps the caller's spelling.
fn sanitize_export_file_name(suggested: &str) -> String {
    let cleaned: String = suggested
        .chars()
        .filter(|ch| !matches!(ch, '/' | '\\' | ':' | '\0') && !ch.is_control())
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let name = if trimmed.is_empty() {
        "driverlens-report"
    } else {
        trimmed
    };

    // Split an existing `.html` suffix (case-insensitive) so it is neither
    // doubled nor truncated away; the caller's spelling is preserved.
    let (stem, extension) = match name.len().checked_sub(HTML_EXTENSION.len()) {
        Some(cut) if name.to_ascii_lowercase().ends_with(HTML_EXTENSION) => {
            (&name[..cut], &name[cut..])
        }
        _ => (name, ""),
    };

    // Truncate the stem so stem + extension fits the FINAL-name cap.
    let mut file_name: String = stem
        .chars()
        .take(MAX_EXPORT_FILE_NAME_CHARS - HTML_EXTENSION.len())
        .collect();
    if extension.is_empty() {
        file_name.push_str(HTML_EXTENSION);
    } else {
        file_name.push_str(extension);
    }
    file_name
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Keep `schemaVersion` an integer in the stored/exported value. The
/// validator accepts a numeric `1.0` (JS has no int/float split); exports
/// normalize it back to the canonical integer 1.
fn normalize_schema_version(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert("schemaVersion".to_owned(), Value::Number(1.into()));
    }
}

/// Builds the filtered-export document: the current report with `devices`
/// replaced by exactly the selected ones — report order, unique by id — and
/// [`FILTERED_EXPORT_NOTE`] added. The selection is validated against the
/// report BEFORE any dialog opens:
///
/// - more than [`report::MAX_DEVICES`] ids → `invalid_selection`;
/// - any id that is not a `devices[].id` of the current report →
///   `invalid_selection` (the message counts the unknowns, never echoing
///   device data);
/// - duplicate ids are harmless (set semantics).
///
/// Ids are opaque display strings: compared as strings, never resolved,
/// never treated as paths. The result revalidates as schemaVersion 1.
fn filter_report_devices(value: &Value, ids: &[String]) -> Result<Value, ScanError> {
    if ids.len() > report::MAX_DEVICES {
        return Err(ScanError::invalid_selection(format!(
            "The selection has {} devices; the limit is {}.",
            ids.len(),
            report::MAX_DEVICES
        )));
    }
    // Validated reports are always objects with a devices array; defensive
    // only (the stored value cannot get here unvalidated).
    let Some(object) = value.as_object() else {
        return Err(ScanError::invalid_report());
    };
    let Some(devices) = object.get("devices").and_then(Value::as_array) else {
        return Err(ScanError::invalid_report());
    };

    // Set membership only; O(devices + ids).
    let mut selected: HashSet<&str> = HashSet::with_capacity(ids.len());
    for id in ids {
        selected.insert(id.as_str());
    }
    let available: HashSet<&str> = devices
        .iter()
        .filter_map(|device| device.get("id").and_then(Value::as_str))
        .collect();
    let missing = ids
        .iter()
        .filter(|id| !available.contains(id.as_str()))
        .count();
    if missing > 0 {
        return Err(ScanError::invalid_selection(format!(
            "{missing} of {} selected devices are not in the current report.",
            ids.len()
        )));
    }

    // Report order (never request order), unique by id — the same shape the
    // browser edition's filtered export produced (filtered() preserves order).
    let exported: Vec<Value> = devices
        .iter()
        .filter(|device| {
            device
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| selected.contains(id))
        })
        .cloned()
        .collect();
    let mut filtered = object.clone();
    filtered.insert("devices".to_owned(), Value::Array(exported));
    filtered.insert(
        "filterNote".to_owned(),
        Value::String(FILTERED_EXPORT_NOTE.to_owned()),
    );
    Ok(Value::Object(filtered))
}

/// The scan thread body. Never panics out: a panic is converted into an
/// `io` error state so the machine can never get stuck in `Running`.
#[allow(clippy::too_many_arguments)]
fn run_scan_thread(
    inner: Arc<Mutex<Inner>>,
    runner: Arc<dyn Runner>,
    scans_dir: PathBuf,
    deadline: Duration,
    generation: u64,
    cancel: Arc<AtomicBool>,
    slot: SharedChild,
    notebook: Option<Arc<NotebookStore>>,
) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        perform_scan(
            runner.as_ref(),
            &scans_dir,
            deadline,
            generation,
            &cancel,
            &slot,
        )
    }));
    let (result, tails) = match outcome {
        Ok(result) => result,
        Err(_) => (Err(ScanError::io()), (Vec::new(), Vec::new())),
    };
    finish(inner, generation, result, tails, notebook);
}

/// One scan attempt: prepare the private directory, choose a fresh output
/// path, run the collection, clean up the temp file, validate the bytes.
/// Returns the accepted report `Value` or the error, plus the bounded tails.
#[allow(clippy::type_complexity)]
fn perform_scan(
    runner: &dyn Runner,
    scans_dir: &Path,
    deadline: Duration,
    generation: u64,
    cancel: &AtomicBool,
    slot: &SharedChild,
) -> (Result<Value, ScanError>, (Vec<u8>, Vec<u8>)) {
    if cancel.load(Ordering::SeqCst) {
        return (Err(ScanError::cancelled()), (Vec::new(), Vec::new()));
    }
    if let Err(error) = prepare_scans_dir(scans_dir) {
        return (Err(error), (Vec::new(), Vec::new()));
    }
    let output_path = match unique_output_path(scans_dir, generation) {
        Ok(path) => path,
        Err(error) => return (Err(error), (Vec::new(), Vec::new())),
    };

    let (result, tails) = collector::run_collection(runner, &output_path, deadline, cancel, slot);
    // The temp file is never kept: on success it has been read into memory,
    // on every failure it must not linger (a killed child can leave a
    // truncated file behind).
    let _ = std::fs::remove_file(&output_path);

    let value = match result {
        Ok(bytes) => {
            let mut value: Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => return (Err(ScanError::invalid_report()), tails),
            };
            if report::validate_report_value(&value).is_err() {
                return (Err(ScanError::invalid_report()), tails);
            }
            normalize_schema_version(&mut value);
            value
        }
        Err(error) => return (Err(error), tails),
    };
    (Ok(value), tails)
}

/// Applies a finished scan to the state machine — only if it is still the
/// current generation (defense against stale threads). After the state
/// transition is published (and the lock released), an accepted report is
/// recorded into the notebook store, best-effort: any notebook error is
/// logged as a static message and the scan result is unaffected.
fn finish(
    inner: Arc<Mutex<Inner>>,
    generation: u64,
    result: Result<Value, ScanError>,
    tails: (Vec<u8>, Vec<u8>),
    notebook: Option<Arc<NotebookStore>>,
) {
    let accepted = {
        let mut guard = inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.generation != generation {
            return;
        }
        let accepted = match result {
            Ok(value) => {
                guard.state = ScanState::Complete;
                guard.error = None;
                guard.report = Some(value.clone());
                Some(value)
            }
            Err(error) if error.code == ScanErrorCode::Cancelled => {
                guard.state = ScanState::Cancelled;
                guard.error = None;
                None
            }
            Err(error) => {
                guard.state = ScanState::Error;
                guard.error = Some(error);
                None
            }
        };
        guard.started_ms = None;
        guard.cancel = None;
        guard.child = None;
        guard.last_tails = Some(tails);
        accepted
    };

    if let (Some(value), Some(store)) = (accepted, notebook) {
        if store.record_report(&value).is_err() {
            // Static message only: never report contents, device ids, paths.
            eprintln!("driverlens: notebook recording skipped (store unavailable)");
        }
    }
}

impl Inner {
    fn snapshot(&self) -> ScanSnapshot {
        ScanSnapshot {
            state: self.state,
            generation: self.generation,
            started_ms: if self.state == ScanState::Running {
                self.started_ms
            } else {
                None
            },
            error_code: match self.state {
                ScanState::Error => self.error.as_ref().map(|error| error.code),
                _ => None,
            },
            device_count: self.report.as_ref().and_then(device_count_of),
        }
    }
}

fn device_count_of(value: &Value) -> Option<u64> {
    value
        .get("devices")
        .and_then(Value::as_array)
        .map(|devices| devices.len() as u64)
}

fn prepare_scans_dir(dir: &Path) -> Result<(), ScanError> {
    std::fs::create_dir_all(dir).map_err(|_| ScanError::io())?;
    purge_stale_files(dir);
    Ok(())
}

/// Best-effort removal of leftovers from crashed prior runs. Only files this
/// app itself creates (`scan-*-*.json`) older than one hour are removed:
/// errors are ignored (cleanup must never fail a scan) and recent files are
/// left alone so a concurrently running instance is never disturbed.
fn purge_stale_files(dir: &Path) {
    const MAX_AGE: Duration = Duration::from_secs(60 * 60);
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with("scan-") || !name.ends_with(".json") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else { continue };
        let Ok(modified) = metadata.modified() else { continue };
        let Ok(age) = SystemTime::now().duration_since(modified) else {
            continue;
        };
        if age > MAX_AGE {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// `<scans_dir>/scan-<generation>-<random>.json` — unique per scan start; the
/// random component comes from the clock (no new dependencies), the
/// generation pins the name to this scan.
fn unique_output_path(dir: &Path, generation: u64) -> Result<PathBuf, ScanError> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut candidate = dir.join(format!("scan-{generation}-{nanos:x}.json"));
    let mut attempt = 0;
    while candidate.exists() {
        attempt += 1;
        if attempt > 8 {
            return Err(ScanError::io());
        }
        candidate = dir.join(format!("scan-{generation}-{nanos:x}-{attempt}.json"));
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::MAX_REPORT_BYTES;
    use crate::test_fakes::{
        sample_bytes, scratch_dir, DialogBehavior, MockDialogs, MockRunner, SpawnBehavior,
    };
    use std::time::Instant;

    fn manager_with(
        runner: Arc<MockRunner>,
        dialogs: Arc<MockDialogs>,
        deadline: Duration,
    ) -> (ScanManager, PathBuf) {
        let scans_dir = scratch_dir("scan");
        let manager = ScanManager::new(ScanManagerConfig {
            runner,
            dialogs: Some(dialogs),
            scans_dir: scans_dir.clone(),
            deadline,
        });
        (manager, scans_dir)
    }

    fn success_runner() -> Arc<MockRunner> {
        Arc::new(MockRunner::new(SpawnBehavior::Success {
            bytes: sample_bytes(),
        }))
    }

    fn fixture_path(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join(name)
    }

    /// Blocks until the fake runner has recorded at least one spawn.
    fn await_spawn(runner: &MockRunner) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while runner.spawn_count() == 0 {
            assert!(Instant::now() < deadline, "fake spawn never happened");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    // -- lifecycle -----------------------------------------------------------

    #[test]
    fn success_transitions_and_generation_named_output() {
        let runner = success_runner();
        let (manager, scans_dir) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );

        let initial = manager.snapshot();
        assert_eq!(initial.state, ScanState::Idle);
        assert_eq!(initial.generation, 0);
        assert_eq!(initial.device_count, None);

        let started = manager.start_scan().expect("first scan accepted");
        assert_eq!(started.state, ScanState::Running);
        assert_eq!(started.generation, 1);
        assert!(started.started_ms.is_some());
        assert_eq!(started.error_code, None);

        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);
        assert_eq!(terminal.generation, 1);
        assert_eq!(terminal.device_count, Some(3));
        assert_eq!(terminal.error_code, None);
        assert_eq!(terminal.started_ms, None, "terminal states clear started_ms");

        let second = manager.start_scan().expect("later scan accepted");
        assert_eq!(second.generation, 2);
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);
        assert_eq!(terminal.generation, 2);

        let paths = runner.output_paths();
        assert_eq!(paths.len(), 2);
        assert_ne!(paths[0], paths[1], "each scan writes its own unique file");
        assert_eq!(paths[0].parent().expect("parent"), scans_dir.as_path());
        let first_name = paths[0].file_name().unwrap().to_str().unwrap();
        assert!(first_name.starts_with("scan-1-") && first_name.ends_with(".json"));
        let second_name = paths[1].file_name().unwrap().to_str().unwrap();
        assert!(second_name.starts_with("scan-2-") && second_name.ends_with(".json"));
        // Accepted temp output is removed after it is read into memory.
        assert!(!paths[0].exists(), "scan 1 temp file must be cleaned up");
        assert!(!paths[1].exists(), "scan 2 temp file must be cleaned up");
    }

    #[test]
    fn duplicate_scan_while_running_is_busy_then_terminal_permits_again() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::Slow {
            duration: Duration::from_millis(1500),
        }));
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(10),
        );

        manager.start_scan().expect("first scan accepted");
        let busy = manager.start_scan().expect_err("second start must be rejected");
        assert_eq!(busy.code, ScanErrorCode::Busy);
        assert_eq!(busy.message, "A scan is already running.");
        assert_eq!(
            manager.snapshot().generation,
            1,
            "a rejected start must not bump the generation"
        );

        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);

        runner.set_behavior(SpawnBehavior::Success {
            bytes: sample_bytes(),
        });
        let again = manager.start_scan().expect("terminal state permits a later scan");
        assert_eq!(again.generation, 2);
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);
    }

    #[test]
    fn executable_absent_sets_clear_missing_prerequisite_state() {
        let runner = success_runner();
        runner.missing.store(true, Ordering::SeqCst);
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );

        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::ExecutableMissing));
        assert_eq!(terminal.device_count, None);

        let json = serde_json::to_value(manager.snapshot()).unwrap();
        assert_eq!(json["errorCode"], "executable_missing");
        assert!(json.get("deviceCount").is_none());

        // Missing prerequisite is a terminal path: fixing it and scanning
        // again must work.
        runner.missing.store(false, Ordering::SeqCst);
        let again = manager
            .start_scan()
            .expect("error path permits a later scan");
        assert_eq!(again.generation, 2);
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);
        assert_eq!(terminal.device_count, Some(3));
    }

    #[test]
    fn every_terminal_path_permits_a_later_scan() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::SpawnFails));
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );

        // 1) Error (io) path.
        manager.start_scan().expect("scan 1 accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::Io));

        // 2) Cancelled path.
        runner.set_behavior(SpawnBehavior::NeverExits);
        manager.start_scan().expect("scan 2 accepted");
        await_spawn(&runner);
        manager.cancel_scan();
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Cancelled);

        // 3) Error (invalid_report) path.
        runner.set_behavior(SpawnBehavior::Malformed);
        manager.start_scan().expect("scan 3 accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::InvalidReport));

        // 4) Complete path.
        runner.set_behavior(SpawnBehavior::Success {
            bytes: sample_bytes(),
        });
        manager.start_scan().expect("scan 4 accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);
        assert_eq!(terminal.generation, 4);
    }

    #[test]
    fn cancel_without_running_scan_is_a_noop() {
        let runner = success_runner();
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.cancel_scan();
        assert_eq!(manager.snapshot().state, ScanState::Idle);
        assert_eq!(manager.snapshot().generation, 0);

        manager.start_scan().expect("scan accepted");
        manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(manager.snapshot().state, ScanState::Complete);
        // Cancelling after completion must not rewrite the terminal state.
        manager.cancel_scan();
        assert_eq!(manager.snapshot().state, ScanState::Complete);
    }

    // -- failure codes -------------------------------------------------------

    #[test]
    fn spawn_failure_maps_to_io() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::SpawnFails));
        let (manager, _) = manager_with(
            runner,
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::Io));
        assert_eq!(terminal.device_count, None);
    }

    #[test]
    fn malformed_output_is_rejected_and_cleaned() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::Malformed));
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::InvalidReport));
        let paths = runner.output_paths();
        assert_eq!(paths.len(), 1);
        assert!(!paths[0].exists(), "rejected output must be cleaned up");
    }

    #[test]
    fn oversized_output_is_rejected_before_parsing_and_cleaned() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::Oversized {
            size: MAX_REPORT_BYTES + 1,
        }));
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::TooLarge));
        let paths = runner.output_paths();
        assert!(!paths[0].exists(), "oversized output must be cleaned up");
    }

    #[test]
    fn unreadable_output_maps_to_io() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::OutputIsDirectory));
        let (manager, _) = manager_with(
            runner,
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::Io));
    }

    #[test]
    fn missing_output_maps_to_output_missing() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::MissingOutput));
        let (manager, _) = manager_with(
            runner,
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::OutputMissing));
    }

    #[test]
    fn nonzero_exit_fails_even_when_output_exists() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::ExitFailure {
            write_bytes: Some(sample_bytes()),
        }));
        let (manager, _) = manager_with(
            runner,
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::ExitFailure));
        assert_eq!(
            terminal.device_count, None,
            "a nonzero exit must never accept output, even a valid-looking file"
        );
    }

    #[test]
    fn stale_previous_generation_output_is_never_reused() {
        let runner = success_runner();
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );

        manager.start_scan().expect("scan 1 accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);
        let first_path = runner.output_paths()[0].clone();

        // Plant a valid-looking, stale file where scan 1 wrote (cleaned up by
        // the manager). A stale-output bug would accept this instead of
        // failing.
        std::fs::write(&first_path, sample_bytes()).expect("plant stale file");

        runner.set_behavior(SpawnBehavior::MissingOutput);
        manager.start_scan().expect("scan 2 accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(
            terminal.state,
            ScanState::Error,
            "stale output must never satisfy a new scan"
        );
        assert_eq!(terminal.error_code, Some(ScanErrorCode::OutputMissing));

        let paths = runner.output_paths();
        assert_eq!(paths.len(), 2);
        assert_ne!(paths[0], paths[1], "generation 2 must use a fresh path");
        let second_name = paths[1].file_name().unwrap().to_str().unwrap();
        assert!(second_name.starts_with("scan-2-"));
        assert!(first_path.exists(), "the stale file is ignored, not aped");
        // The last accepted report from scan 1 remains current for export.
        assert_eq!(terminal.device_count, Some(3));
    }

    // -- cancel / timeout / owned-only kill ----------------------------------

    #[test]
    fn cancel_kills_only_the_owned_child_and_permits_rescan() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::RealSleepers {
            sleeper_seconds: 60,
        }));
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(30),
        );

        manager.start_scan().expect("scan accepted");
        await_spawn(&runner);
        assert_eq!(manager.snapshot().state, ScanState::Running);
        manager.cancel_scan();

        // Reaching Cancelled quickly proves the owned child was killed (the
        // owned sleeper would otherwise run for ~60 s and block the scan
        // thread's wait).
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Cancelled);
        assert_eq!(terminal.error_code, None);
        assert_eq!(terminal.device_count, None, "cancelled scans write no report");

        // The un-owned sleeper was never touched.
        let mut bystander = runner
            .take_bystander()
            .expect("fake must have spawned the bystander");
        assert!(
            bystander.try_wait().expect("bystander status").is_none(),
            "the bystander process must stay alive after a cancel"
        );
        let _ = bystander.kill();
        let _ = bystander.wait();

        // A later scan is permitted after cancellation.
        runner.set_behavior(SpawnBehavior::Success {
            bytes: sample_bytes(),
        });
        let again = manager.start_scan().expect("cancel path permits a later scan");
        assert_eq!(again.generation, 2);
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);
    }

    #[test]
    fn timeout_kills_only_the_owned_child() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::RealSleepers {
            sleeper_seconds: 60,
        }));
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_millis(250),
        );

        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::Timeout));

        let mut bystander = runner
            .take_bystander()
            .expect("fake must have spawned the bystander");
        assert!(
            bystander.try_wait().expect("bystander status").is_none(),
            "the bystander process must stay alive after a timeout kill"
        );
        let _ = bystander.kill();
        let _ = bystander.wait();
    }

    #[test]
    fn fake_never_exiting_child_is_killed_on_cancel() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::NeverExits));
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(30),
        );

        manager.start_scan().expect("scan accepted");
        await_spawn(&runner);
        manager.cancel_scan();
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Cancelled);

        let flag = runner.last_kill_flag().expect("mock child kill flag");
        assert!(
            flag.load(Ordering::SeqCst),
            "cancel must kill exactly the owned child handle"
        );
    }

    #[test]
    fn fake_never_exiting_child_is_killed_on_timeout_with_short_deadline() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::NeverExits));
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_millis(150),
        );

        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::Timeout));

        let flag = runner.last_kill_flag().expect("mock child kill flag");
        assert!(flag.load(Ordering::SeqCst), "timeout must kill the owned child");
    }

    #[test]
    fn shutdown_cancels_a_running_scan() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::NeverExits));
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(30),
        );
        manager.start_scan().expect("scan accepted");
        await_spawn(&runner);
        manager.shutdown();
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Cancelled);
        let flag = runner.last_kill_flag().expect("mock child kill flag");
        assert!(flag.load(Ordering::SeqCst));
    }

    // -- snapshot shape / privacy -------------------------------------------

    #[test]
    fn snapshot_exposes_only_state_generation_started_error_and_count() {
        let runner = success_runner();
        let (manager, scans_dir) = manager_with(
            runner,
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        let running = manager.start_scan().expect("scan accepted");
        let json = serde_json::to_value(&running).unwrap();
        let object = json.as_object().expect("snapshot is an object");
        let allowed = ["state", "generation", "startedMs", "errorCode", "deviceCount"];
        for key in object.keys() {
            assert!(
                allowed.contains(&key.as_str()),
                "unexpected snapshot key: {key}"
            );
        }
        assert!(json.get("errorCode").is_none(), "no error while running");

        manager.wait_for_terminal_for_test(Duration::from_secs(10));
        let completed = serde_json::to_string(&manager.snapshot()).unwrap();
        assert!(!completed.contains("devices"), "no report contents: {completed}");
        assert!(!completed.contains("Example"), "no device data: {completed}");
        assert!(
            !completed.contains(&scans_dir.to_string_lossy().to_string()),
            "no paths: {completed}"
        );
    }

    #[test]
    fn bounded_output_tails_are_retained_but_never_serialized() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::CannedTails {
            stdout: b"collector stdout tail sentinel".to_vec(),
            stderr: b"collector stderr tail sentinel".to_vec(),
        }));
        let (manager, _) = manager_with(
            runner,
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        // CannedTails exits 0 without writing output -> missing output.
        assert_eq!(terminal.error_code, Some(ScanErrorCode::OutputMissing));

        let tails = manager.last_tails_for_test().expect("tails retained");
        assert_eq!(tails.0, b"collector stdout tail sentinel");
        assert_eq!(tails.1, b"collector stderr tail sentinel");
        // ... but they must never appear in anything the webview can read.
        let serialized = serde_json::to_string(&manager.snapshot()).unwrap();
        assert!(!serialized.contains("sentinel"));
        assert!(!serialized.to_lowercase().contains("stdout"));
    }

    // -- import / export -----------------------------------------------------

    #[test]
    fn import_and_export_round_trip_through_current_report() {
        let export_dir = scratch_dir("export");
        let export_path = export_dir.join("driverlens-report.json");
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(fixture_path("sample.json")),
            DialogBehavior::Pick(export_path.clone()),
        ));
        let (manager, _) = manager_with(success_runner(), dialogs, Duration::from_secs(5));

        let imported = manager
            .open_report()
            .expect("import succeeds")
            .expect("dialog picked a file");
        assert_eq!(imported["schemaVersion"], 1);
        assert_eq!(imported["devices"].as_array().unwrap().len(), 3);

        let snapshot = manager.snapshot();
        assert_eq!(snapshot.state, ScanState::Idle, "import is not a scan");
        assert_eq!(snapshot.generation, 0);
        assert_eq!(snapshot.device_count, Some(3));

        let summary = manager
            .export_report(None)
            .expect("export succeeds")
            .expect("dialog picked a destination");
        assert_eq!(
            summary.bytes_written,
            std::fs::metadata(&export_path).unwrap().len()
        );
        let text = std::fs::read_to_string(&export_path).expect("exported file");
        assert!(text.contains("\"schemaVersion\": 1"));
        crate::report::validate_report_str(&text).expect("export must revalidate");

        // Imported contents never leak into the snapshot channel.
        let serialized = serde_json::to_string(&manager.snapshot()).unwrap();
        assert!(!serialized.contains("Example"));
        assert!(!serialized.contains("devices"));
    }

    #[test]
    fn current_report_is_none_until_a_scan_or_import_stores_one() {
        let (manager, _) = manager_with(
            success_runner(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        assert_eq!(manager.current_report(), None, "nothing stored yet");

        // An accepted scan stores its report in the same slot.
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);
        let report = manager.current_report().expect("scan report stored");
        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["devices"].as_array().unwrap().len(), 3);

        // Read-only: a second read returns the same content (no consumption,
        // no mutation), and export would write this exact value.
        assert_eq!(manager.current_report(), Some(report));
    }

    #[test]
    fn rejected_import_keeps_the_previous_current_report() {
        let scratch = scratch_dir("current-report");
        let bad = scratch.join("bad.json");
        std::fs::write(&bad, br#""not a report""#).unwrap();
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(fixture_path("sample.json")),
            DialogBehavior::Cancel,
        ));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));
        assert!(manager.open_report().expect("import").is_some());
        let before = manager.current_report().expect("stored");
        assert_eq!(before["devices"].as_array().unwrap().len(), 3);

        *dialogs.open.lock().unwrap() = DialogBehavior::Pick(bad);
        assert!(manager.open_report().is_err(), "import must be rejected");
        assert_eq!(
            manager.current_report(),
            Some(before),
            "a rejected import must not change the current report"
        );
    }

    #[test]
    fn import_cancel_keeps_the_current_report() {
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(fixture_path("sample.json")),
            DialogBehavior::Cancel,
        ));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));

        assert!(manager.open_report().expect("first import").is_some());
        assert_eq!(manager.snapshot().device_count, Some(3));

        *dialogs.open.lock().unwrap() = DialogBehavior::Cancel;
        assert_eq!(manager.open_report().expect("cancelled import"), None);
        assert_eq!(
            manager.snapshot().device_count,
            Some(3),
            "a cancelled import must not clear the current report"
        );
        assert!(manager.current_report_for_test().is_some());
    }

    #[test]
    fn invalid_import_is_rejected_and_previous_report_retained() {
        let scratch = scratch_dir("import");
        let bad_schema = scratch.join("bad-schema.json");
        std::fs::write(&bad_schema, br#"{"schemaVersion": 2, "devices": []}"#).unwrap();
        let bad_json = scratch.join("bad-json.json");
        std::fs::write(&bad_json, b"not json at all").unwrap();
        let bad_device = scratch.join("bad-device.json");
        std::fs::write(&bad_device, br#"{"schemaVersion": 1, "devices": [{}]}"#).unwrap();

        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(fixture_path("sample.json")),
            DialogBehavior::Cancel,
        ));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));
        assert!(manager.open_report().expect("first import").is_some());

        for (path, expected_in_message) in [
            (&bad_schema, "schemaVersion 1"),
            (&bad_json, "not valid JSON"),
            (&bad_device, "index 0"),
        ] {
            *dialogs.open.lock().unwrap() = DialogBehavior::Pick(path.clone());
            let error = manager
                .open_report()
                .expect_err(&format!("{path:?} must be rejected"));
            assert_eq!(error.code, ScanErrorCode::InvalidReport, "{path:?}");
            assert!(
                error.message.contains(expected_in_message),
                "{path:?}: message {:?}",
                error.message
            );
        }
        assert_eq!(
            manager.snapshot().device_count,
            Some(3),
            "rejected imports must not clear the current report"
        );
    }

    #[test]
    fn import_edge_cases_map_to_stable_codes() {
        let scratch = scratch_dir("import-edges");
        let oversized = scratch.join("oversized.json");
        std::fs::write(&oversized, vec![b'x'; MAX_REPORT_BYTES + 1]).unwrap();
        let a_directory = scratch.join("directory.json");
        std::fs::create_dir_all(&a_directory).unwrap();
        let missing = scratch.join("missing.json");

        let dialogs = Arc::new(MockDialogs::new(DialogBehavior::Cancel, DialogBehavior::Cancel));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));

        for (path, expected) in [
            (oversized, ScanErrorCode::TooLarge),
            (a_directory, ScanErrorCode::Io),
            (missing, ScanErrorCode::Io),
        ] {
            *dialogs.open.lock().unwrap() = DialogBehavior::Pick(path.clone());
            let error = manager.open_report().expect_err(&format!("{path:?}"));
            assert_eq!(error.code, expected, "{path:?}");
        }
    }

    #[test]
    fn export_without_report_refuses_and_cancelled_export_is_none() {
        let scratch = scratch_dir("export-none");
        let destination = scratch.join("out.json");
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Cancel,
            DialogBehavior::Pick(destination.clone()),
        ));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));

        let refusal = manager.export_report(None).expect_err("nothing to export");
        assert_eq!(refusal.code, ScanErrorCode::OutputMissing);
        assert!(!destination.exists(), "refusal must not create a file");

        // With a report present but the dialog cancelled: Ok(None), no file.
        *dialogs.open.lock().unwrap() = DialogBehavior::Pick(fixture_path("sample.json"));
        *dialogs.save.lock().unwrap() = DialogBehavior::Cancel;
        assert!(manager.open_report().expect("import").is_some());
        assert_eq!(manager.export_report(None).expect("cancelled export"), None);
        assert!(!destination.exists());
    }

    #[test]
    fn export_write_failure_maps_to_io() {
        let scratch = scratch_dir("export-fail");
        let unwritable = scratch.join("as-directory");
        std::fs::create_dir_all(&unwritable).unwrap();
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(fixture_path("sample.json")),
            DialogBehavior::Pick(unwritable),
        ));
        let (manager, _) = manager_with(success_runner(), dialogs, Duration::from_secs(5));
        assert!(manager.open_report().expect("import").is_some());
        let error = manager.export_report(None).expect_err("write must fail");
        assert_eq!(error.code, ScanErrorCode::Io);
    }

    #[test]
    fn dialog_failures_map_to_io_and_missing_dialogs_are_refused() {
        // Import first (so a current report exists — export refuses with
        // output_missing when there is nothing to export, before it ever
        // reaches the save dialog), then make both dialogs fail.
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(fixture_path("sample.json")),
            DialogBehavior::Fail,
        ));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));
        assert!(manager.open_report().expect("import").is_some());
        assert_eq!(
            manager.export_report(None).expect_err("save dialog fails").code,
            ScanErrorCode::Io
        );
        *dialogs.open.lock().unwrap() = DialogBehavior::Fail;
        assert_eq!(
            manager.open_report().expect_err("open dialog fails").code,
            ScanErrorCode::Io
        );

        // Dialogs failing before any report exists: export refuses with
        // output_missing (the report check runs first).
        let failing = Arc::new(MockDialogs::new(DialogBehavior::Fail, DialogBehavior::Fail));
        let (fresh, _) = manager_with(success_runner(), failing, Duration::from_secs(5));
        assert_eq!(
            fresh.export_report(None).expect_err("nothing to export").code,
            ScanErrorCode::OutputMissing
        );

        // A manager without a dialog provider (never the production setup)
        // refuses cleanly instead of panicking.
        let bare = ScanManager::new(ScanManagerConfig {
            runner: success_runner(),
            dialogs: None,
            scans_dir: scratch_dir("bare"),
            deadline: Duration::from_secs(5),
        });
        assert_eq!(bare.open_report().expect_err("no dialogs").code, ScanErrorCode::Io);
        // Export checks the current report first: without one it refuses as
        // output_missing even when dialogs are unavailable.
        assert_eq!(
            bare.export_report(None).expect_err("no report and no dialogs").code,
            ScanErrorCode::OutputMissing
        );
    }

    // -- filtered export (Task 10) ------------------------------------------

    /// Imports the 3-device sample fixture and returns a manager whose save
    /// dialog writes to `destination` (save-call count observable).
    fn manager_with_imported_sample(destination: &Path) -> (ScanManager, Arc<MockDialogs>) {
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(fixture_path("sample.json")),
            DialogBehavior::Pick(destination.to_path_buf()),
        ));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));
        manager
            .open_report()
            .expect("import succeeds")
            .expect("file picked");
        (manager, dialogs)
    }

    #[test]
    fn full_export_writes_the_stored_report_unchanged_without_filter_note() {
        let export_dir = scratch_dir("export-full");
        let export_path = export_dir.join("full.json");
        let (manager, _) = manager_with_imported_sample(&export_path);

        manager.export_report(None).expect("export").expect("picked");
        let text = std::fs::read_to_string(&export_path).expect("exported file");
        assert!(!text.contains("filterNote"), "a full export gains no filterNote");
        let value: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(value["devices"].as_array().expect("devices").len(), 3);
        crate::report::validate_report_str(&text).expect("full export revalidates");
    }

    #[test]
    fn filtered_export_writes_exactly_the_selected_devices_in_report_order_with_filter_note() {
        let export_dir = scratch_dir("export-filtered");
        let export_path = export_dir.join("filtered.json");
        let (manager, dialogs) = manager_with_imported_sample(&export_path);

        // Reversed request order + a duplicate: the output is deduplicated
        // and keeps REPORT order, not request order.
        let summary = manager
            .export_report(Some(vec![
                "SAMPLE003".to_owned(),
                "SAMPLE001".to_owned(),
                "SAMPLE003".to_owned(),
            ]))
            .expect("export")
            .expect("picked");
        assert_eq!(
            summary.bytes_written,
            std::fs::metadata(&export_path).unwrap().len()
        );
        assert_eq!(dialogs.save_calls.load(Ordering::SeqCst), 1);

        let text = std::fs::read_to_string(&export_path).expect("exported file");
        let value: Value = serde_json::from_str(&text).expect("json");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["filterNote"], FILTERED_EXPORT_NOTE);
        assert_eq!(value["sample"], true, "top-level fields pass through");
        let ids: Vec<&str> = value["devices"]
            .as_array()
            .expect("devices")
            .iter()
            .filter_map(|device| device["id"].as_str())
            .collect();
        assert_eq!(ids, ["SAMPLE001", "SAMPLE003"]);
        // A filtered export is still a schemaVersion 1 DriverLens report.
        crate::report::validate_report_str(&text).expect("filtered export must revalidate");
    }

    #[test]
    fn filtered_export_with_empty_ids_writes_an_empty_devices_array() {
        let export_dir = scratch_dir("export-empty");
        let export_path = export_dir.join("empty.json");
        let (manager, _) = manager_with_imported_sample(&export_path);

        manager
            .export_report(Some(Vec::new()))
            .expect("export")
            .expect("picked");
        let text = std::fs::read_to_string(&export_path).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["devices"].as_array().unwrap().len(), 0);
        assert_eq!(value["filterNote"], FILTERED_EXPORT_NOTE);
        crate::report::validate_report_str(&text).expect("still a valid v1 report");
    }

    #[test]
    fn filtered_export_rejects_unknown_ids_before_opening_the_dialog() {
        let export_dir = scratch_dir("export-bad-ids");
        let export_path = export_dir.join("bad.json");
        let (manager, dialogs) = manager_with_imported_sample(&export_path);

        let error = manager
            .export_report(Some(vec![
                "NOT-A-DEVICE".to_owned(),
                "SAMPLE001".to_owned(),
            ]))
            .expect_err("unknown id must be refused");
        assert_eq!(error.code, ScanErrorCode::InvalidSelection);
        assert!(
            error.message.contains("1 of 2"),
            "the message counts the unknowns only: {:?}",
            error.message
        );
        assert!(
            !error.message.contains("NOT-A-DEVICE"),
            "messages never echo device data"
        );
        assert_eq!(
            dialogs.save_calls.load(Ordering::SeqCst),
            0,
            "a doomed selection must not open the save dialog"
        );
        assert!(!export_path.exists(), "nothing may be written");
        // The report itself is untouched.
        assert_eq!(manager.snapshot().device_count, Some(3));
    }

    #[test]
    fn filtered_export_rejects_an_oversized_selection_before_the_dialog() {
        let export_dir = scratch_dir("export-too-many");
        let export_path = export_dir.join("too-many.json");
        let (manager, dialogs) = manager_with_imported_sample(&export_path);

        let ids = vec!["SAMPLE001".to_owned(); crate::report::MAX_DEVICES + 1];
        let error = manager.export_report(Some(ids)).expect_err("limit must apply");
        assert_eq!(error.code, ScanErrorCode::InvalidSelection);
        assert_eq!(dialogs.save_calls.load(Ordering::SeqCst), 0);
        assert!(!export_path.exists());
    }

    #[test]
    fn filtered_export_without_a_report_refuses_output_missing() {
        let export_dir = scratch_dir("export-none-filtered");
        let export_path = export_dir.join("none.json");
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Cancel,
            DialogBehavior::Pick(export_path.clone()),
        ));
        let (manager, _) = manager_with(success_runner(), dialogs, Duration::from_secs(5));

        let refusal = manager
            .export_report(Some(vec!["ANY".to_owned()]))
            .expect_err("nothing to export");
        assert_eq!(refusal.code, ScanErrorCode::OutputMissing);
        assert!(!export_path.exists());
    }

    #[test]
    fn filtered_export_cancelled_dialog_is_none_and_writes_nothing() {
        let export_dir = scratch_dir("export-cancel-filtered");
        let export_path = export_dir.join("cancel.json");
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(fixture_path("sample.json")),
            DialogBehavior::Cancel,
        ));
        let (manager, _) = manager_with(success_runner(), dialogs, Duration::from_secs(5));
        manager.open_report().expect("import").expect("picked");

        assert_eq!(
            manager
                .export_report(Some(vec!["SAMPLE001".to_owned()]))
                .expect("a cancelled dialog is not an error"),
            None
        );
        assert!(!export_path.exists());
    }

    #[test]
    fn cancelled_scan_keeps_the_previous_report_current() {
        let runner = success_runner();
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan 1 accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.device_count, Some(3));

        runner.set_behavior(SpawnBehavior::NeverExits);
        manager.start_scan().expect("scan 2 accepted");
        await_spawn(&runner);
        manager.cancel_scan();
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Cancelled);
        assert_eq!(
            terminal.device_count,
            Some(3),
            "the last accepted report stays current after a cancel"
        );
    }

    // -- privacy / sanitization (Task 13) ------------------------------------

    /// Sentinel strings standing in for a real report's device data. If any
    /// of these ever appears in an error message or in anything the webview
    /// can read, the sanitization guarantee is broken.
    const LEAK_NAME: &str = "Synthetic Sentinel Device A1B2C3";
    const LEAK_ID: &str = "SENTINEL000000000000";

    /// Valid JSON, invalid contract (unknown status) — and the sentinel
    /// strings sit right next to the failure so a leak would be visible.
    fn sentinel_failure_bytes() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "warnings": [],
            "devices": [{
                "id": LEAK_ID,
                "name": LEAK_NAME,
                "status": "mystery",
                "notes": [format!("note mentioning {LEAK_ID}")]
            }]
        }))
        .expect("sentinel fixture must serialize")
    }

    #[test]
    fn failed_scan_and_import_never_leak_report_data_into_observable_strings() {
        // 1) A scan whose output fails validation: the snapshot (the only
        // scan shape the webview sees) and the static error message must not
        // carry any of the report's data.
        let runner = Arc::new(MockRunner::new(SpawnBehavior::Success {
            bytes: sentinel_failure_bytes(),
        }));
        let (manager, _) = manager_with(
            runner,
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Error);
        assert_eq!(terminal.error_code, Some(ScanErrorCode::InvalidReport));
        let snapshot_json = serde_json::to_string(&terminal).expect("serialize snapshot");
        assert!(
            !snapshot_json.contains(LEAK_NAME),
            "snapshot leaked a device name: {snapshot_json}"
        );
        assert!(
            !snapshot_json.contains(LEAK_ID),
            "snapshot leaked a device id: {snapshot_json}"
        );
        // The error path's message is the static constructor template.
        let message = ScanError::invalid_report().message;
        assert_eq!(message, "The scan output is not a valid DriverLens v1 report.");
        assert!(!message.contains(LEAK_NAME) && !message.contains(LEAK_ID));
        // A failed scan stores nothing.
        assert_eq!(manager.current_report(), None);

        // 2) An import that fails validation: the rejection DTO the renderer
        // receives must not carry the file's data either.
        let scratch = scratch_dir("sentinel-import");
        let bad = scratch.join("sentinel.json");
        std::fs::write(&bad, sentinel_failure_bytes()).expect("write sentinel file");
        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(bad.clone()),
            DialogBehavior::Cancel,
        ));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));
        let error = manager.open_report().expect_err("import must be rejected");
        assert_eq!(error.code, ScanErrorCode::InvalidReport);
        assert!(
            !error.message.contains(LEAK_NAME),
            "error leaked a device name: {error:?}"
        );
        assert!(
            !error.message.contains(LEAK_ID),
            "error leaked a device id: {error:?}"
        );
        assert!(!format!("{error}").contains(LEAK_NAME));
        assert!(!format!("{error}").contains(LEAK_ID));
        // The validator message is a static template with an index only.
        assert!(
            error.message.contains("index 0"),
            "static template expected: {:?}",
            error.message
        );
        assert_eq!(manager.current_report(), None);

        // 3) A non-JSON file containing the sentinel text: still static.
        let not_json = scratch.join("sentinel.txt");
        std::fs::write(
            &not_json,
            format!("{{ not json but mentions {LEAK_NAME} and {LEAK_ID}"),
        )
        .expect("write not-json file");
        *dialogs.open.lock().unwrap() = DialogBehavior::Pick(not_json);
        let error = manager.open_report().expect_err("import must be rejected");
        assert_eq!(error.message, "The selected file is not valid JSON.");
        assert!(!error.message.contains(LEAK_NAME) && !error.message.contains(LEAK_ID));
    }

    #[test]
    fn error_messages_are_static_templates_and_codes_serialize_as_contract_strings() {
        // Every constructor message is a fixed template: assert the exact
        // text so a future change that interpolates data fails loudly.
        let static_messages = [
            ScanError::busy(),
            ScanError::executable_missing(),
            ScanError::timeout(),
            ScanError::cancelled(),
            ScanError::exit_failure(),
            ScanError::output_missing(),
            ScanError::too_large(),
            ScanError::invalid_report(),
            ScanError::io(),
        ];
        for error in &static_messages {
            assert!(!error.message.is_empty());
            assert!(
                !error.message.contains(LEAK_NAME),
                "message must be static: {error:?}"
            );
            assert!(
                !error.message.contains(LEAK_ID),
                "message must be static: {error:?}"
            );
        }
        assert_eq!(ScanError::busy().message, "A scan is already running.");
        assert_eq!(
            ScanError::timeout().message,
            "The scan timed out before the collector finished."
        );
        assert_eq!(ScanError::cancelled().message, "The scan was cancelled.");
        assert_eq!(
            ScanError::exit_failure().message,
            "The collector exited with a nonzero status."
        );
        assert_eq!(
            ScanError::output_missing().message,
            "The collector did not produce a report."
        );
        assert_eq!(
            ScanError::too_large().message,
            "The report exceeds the 20 MiB limit."
        );
        assert_eq!(
            ScanError::invalid_report().message,
            "The scan output is not a valid DriverLens v1 report."
        );
        assert_eq!(
            ScanError::io().message,
            "An unexpected operating system error occurred."
        );
        assert!(ScanError::executable_missing().message.contains("PowerShell 7"));

        // The selection refusal carries counts only — never ids or names.
        let selection =
            ScanError::invalid_selection("2 of 3 selected devices are not in the current report.");
        assert_eq!(selection.code, ScanErrorCode::InvalidSelection);
        assert!(!selection.message.contains(LEAK_ID));

        // Codes serialize as the snake_case contract strings the frontend types.
        let codes = [
            (ScanErrorCode::Busy, "busy"),
            (ScanErrorCode::ExecutableMissing, "executable_missing"),
            (ScanErrorCode::Timeout, "timeout"),
            (ScanErrorCode::Cancelled, "cancelled"),
            (ScanErrorCode::ExitFailure, "exit_failure"),
            (ScanErrorCode::OutputMissing, "output_missing"),
            (ScanErrorCode::TooLarge, "too_large"),
            (ScanErrorCode::InvalidReport, "invalid_report"),
            (ScanErrorCode::InvalidSelection, "invalid_selection"),
            (ScanErrorCode::Io, "io"),
        ];
        for (code, expected) in codes {
            assert_eq!(code.as_str(), expected);
            assert_eq!(
                serde_json::to_string(&code).expect("serialize code"),
                format!("\"{expected}\"")
            );
        }
    }

    #[test]
    fn stderr_tails_with_report_like_content_never_reach_the_snapshot() {
        let runner = Arc::new(MockRunner::new(SpawnBehavior::CannedTails {
            stdout: format!("collector stdout mentions {LEAK_ID}").into_bytes(),
            stderr: format!("collector stderr mentions {LEAK_NAME}").into_bytes(),
        }));
        let (manager, _) = manager_with(
            runner,
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        // CannedTails writes no output file -> output_missing.
        assert_eq!(terminal.error_code, Some(ScanErrorCode::OutputMissing));

        // The tails ARE retained in memory (diagnostics)...
        let tails = manager.last_tails_for_test().expect("tails retained");
        assert!(String::from_utf8_lossy(&tails.0).contains(LEAK_ID));
        assert!(String::from_utf8_lossy(&tails.1).contains(LEAK_NAME));
        // ...but nothing the webview can read may contain them.
        let snapshot_json = serde_json::to_string(&manager.snapshot()).expect("snapshot");
        assert!(!snapshot_json.contains(LEAK_ID) && !snapshot_json.contains(LEAK_NAME));
    }

    #[test]
    fn hostile_strings_round_trip_byte_equal_through_filtered_export() {
        let hostile_name = r#"\"><script>window.__pwned = 1;</script>"#;
        let hostile_note = "<script>window.__pwned=7</script>";
        let hostile_provider = "<img src=x onerror=window.__pwned=2>";
        let scratch = scratch_dir("hostile-roundtrip");
        let input = scratch.join("hostile.json");
        let output = scratch.join("hostile-export.json");
        std::fs::write(
            &input,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "sample": false,
                "warnings": [],
                "devices": [{
                    "id": "EVILRT01",
                    "name": hostile_name,
                    "status": "observed",
                    "provider": hostile_provider,
                    "notes": [hostile_note]
                }]
            }))
            .expect("hostile fixture must serialize"),
        )
        .expect("write hostile fixture");

        let dialogs = Arc::new(MockDialogs::new(
            DialogBehavior::Pick(input),
            DialogBehavior::Pick(output.clone()),
        ));
        let (manager, _) = manager_with(success_runner(), dialogs, Duration::from_secs(5));
        manager
            .open_report()
            .expect("hostile import")
            .expect("picked");
        manager
            .export_report(Some(vec!["EVILRT01".to_owned()]))
            .expect("filtered export")
            .expect("picked");

        let text = std::fs::read_to_string(&output).expect("exported file");
        // No HTML escaping and no transformation of the hostile strings.
        assert!(
            !text.contains("&lt;") && !text.contains("&gt;") && !text.contains("&quot;"),
            "the export must not HTML-escape data: {text}"
        );
        let value: Value = serde_json::from_str(&text).expect("exported json");
        assert_eq!(value["devices"].as_array().expect("devices").len(), 1);
        let device = &value["devices"][0];
        assert_eq!(
            device["name"].as_str(),
            Some(hostile_name),
            "name must round-trip byte-for-byte"
        );
        assert_eq!(device["provider"].as_str(), Some(hostile_provider));
        assert_eq!(device["notes"][0].as_str(), Some(hostile_note));
        assert_eq!(value["filterNote"], FILTERED_EXPORT_NOTE);
        crate::report::validate_report_str(&text).expect("hostile filtered export must revalidate");
    }

    // -- notebook recording (extension E-01) ---------------------------------

    #[test]
    fn accepted_scan_records_one_notebook_observation_per_device() {
        let runner = success_runner();
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        let store = Arc::new(crate::notebook::NotebookStore::new(scratch_dir(
            "scan-notebook",
        )));
        manager.attach_notebook(store.clone());

        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Complete);

        // Recording runs on the scan thread after the terminal state is
        // published; wait (bounded) for it to land.
        let deadline = Instant::now() + Duration::from_secs(5);
        let view = loop {
            let view = store.view();
            if view.devices.len() == 3 {
                break view;
            }
            assert!(
                Instant::now() < deadline,
                "notebook never recorded the accepted scan"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        for device in &view.devices {
            assert_eq!(device.observations.len(), 1, "one sighting, one observation");
        }
        let keys: Vec<&str> = view.devices.iter().map(|d| d.key.as_str()).collect();
        assert!(keys.contains(&"SAMPLE001") && keys.contains(&"SAMPLE003"));

        // A cancelled scan afterwards records nothing new (no accepted report).
        runner.set_behavior(SpawnBehavior::NeverExits);
        manager.start_scan().expect("scan 2 accepted");
        await_spawn(&runner);
        manager.cancel_scan();
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(terminal.state, ScanState::Cancelled);
        for device in &store.view().devices {
            assert_eq!(device.observations.len(), 1, "cancel records nothing");
        }
    }

    #[test]
    fn notebook_store_failure_never_fails_or_blocks_the_scan() {
        let runner = success_runner();
        let (manager, _) = manager_with(
            runner.clone(),
            Arc::new(MockDialogs::cancelling()),
            Duration::from_secs(5),
        );
        // A store whose directory path is an existing file: every write fails.
        let scratch = scratch_dir("scan-notebook-broken");
        let blocked = scratch.join("blocked");
        std::fs::write(&blocked, b"file").expect("write blocker file");
        manager.attach_notebook(Arc::new(crate::notebook::NotebookStore::new(blocked)));

        manager.start_scan().expect("scan accepted");
        let terminal = manager.wait_for_terminal_for_test(Duration::from_secs(10));
        assert_eq!(
            terminal.state,
            ScanState::Complete,
            "a notebook store failure must never fail a scan"
        );
        assert_eq!(terminal.device_count, Some(3));
        assert!(manager.current_report().is_some(), "report still accepted");
    }

    // -- portable HTML export (E-03) -----------------------------------------

    #[test]
    fn export_html_report_writes_exactly_the_document_to_the_dialog_path() {
        let export_dir = scratch_dir("export-html");
        let export_path = export_dir.join("driverlens-report.html");
        let dialogs = Arc::new(
            MockDialogs::new(DialogBehavior::Cancel, DialogBehavior::Cancel)
                .with_html(DialogBehavior::Pick(export_path.clone())),
        );
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));

        let html = "<!doctype html><html lang=\"en\"><body>synthetic report</body></html>";
        let summary = manager
            .export_html_report(html.to_owned(), "driverlens-report".to_owned())
            .expect("export succeeds")
            .expect("dialog picked a destination");
        assert_eq!(summary.bytes_written, html.len() as u64);
        assert_eq!(
            std::fs::read_to_string(&export_path).expect("written file"),
            html
        );
        // The suggested name reaches the dialog sanitized (.html appended).
        assert_eq!(
            dialogs.last_html_name.lock().unwrap().as_deref(),
            Some("driverlens-report.html")
        );
        assert_eq!(dialogs.html_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn export_html_report_cancelled_dialog_is_none_and_writes_nothing() {
        let dialogs = Arc::new(MockDialogs::new(DialogBehavior::Cancel, DialogBehavior::Cancel));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));

        // The mock's HTML dialog defaults to cancel.
        let outcome = manager
            .export_html_report("<html></html>".to_owned(), "x".to_owned())
            .expect("a cancelled dialog is not an error");
        assert_eq!(outcome, None);
        assert_eq!(dialogs.html_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn export_html_report_refuses_empty_and_oversized_payloads_before_the_dialog() {
        let dialogs = Arc::new(MockDialogs::new(DialogBehavior::Cancel, DialogBehavior::Cancel));
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));

        let empty = manager
            .export_html_report(String::new(), "x".to_owned())
            .expect_err("empty payload must be refused");
        assert_eq!(empty.code, ScanErrorCode::InvalidReport);
        assert_eq!(empty.message, "The HTML report is empty.");

        let oversized = manager
            .export_html_report("x".repeat(MAX_HTML_BYTES + 1), "x".to_owned())
            .expect_err("oversized payload must be refused");
        assert_eq!(oversized.code, ScanErrorCode::TooLarge);
        assert_eq!(oversized.message, "The HTML report exceeds the 8 MiB limit.");

        // Neither refusal may open the dialog.
        assert_eq!(dialogs.html_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn export_html_report_at_the_cap_reaches_the_dialog_and_failures_map_to_io() {
        let dialogs = Arc::new(
            MockDialogs::new(DialogBehavior::Cancel, DialogBehavior::Cancel)
                .with_html(DialogBehavior::Fail),
        );
        let (manager, _) = manager_with(success_runner(), dialogs.clone(), Duration::from_secs(5));

        // Exactly at the cap (not above): valid, reaches the dialog; a dialog
        // failure is a plain io error.
        let error = manager
            .export_html_report("x".repeat(MAX_HTML_BYTES), "x".to_owned())
            .expect_err("dialog failure must map to io");
        assert_eq!(error.code, ScanErrorCode::Io);
        assert_eq!(dialogs.html_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn export_html_report_without_dialogs_refuses_cleanly() {
        let bare = ScanManager::new(ScanManagerConfig {
            runner: success_runner(),
            dialogs: None,
            scans_dir: scratch_dir("bare-html"),
            deadline: Duration::from_secs(5),
        });
        let error = bare
            .export_html_report("<html></html>".to_owned(), "x".to_owned())
            .expect_err("no dialogs");
        assert_eq!(error.code, ScanErrorCode::Io);
    }

    #[test]
    fn sanitize_export_file_name_strips_separators_and_appends_html() {
        assert_eq!(
            sanitize_export_file_name("driverlens-report"),
            "driverlens-report.html"
        );
        assert_eq!(sanitize_export_file_name("report.HTML"), "report.HTML");
        assert_eq!(sanitize_export_file_name("  spaced name  "), "spaced name.html");
        assert_eq!(sanitize_export_file_name(""), "driverlens-report.html");
        assert_eq!(sanitize_export_file_name(".."), "driverlens-report.html");

        for hostile in [r"C:\temp\evil.html", "/etc/passwd", r"..\..\evil", "C:evil"] {
            let name = sanitize_export_file_name(hostile);
            assert!(
                !name.contains('/') && !name.contains('\\') && !name.contains(':'),
                "separators must be stripped: {name}"
            );
            assert!(name.to_ascii_lowercase().ends_with(".html"));
        }

        // Control characters are stripped too.
        assert_eq!(sanitize_export_file_name("a\u{7}b\u{0}c"), "abc.html");

        // The cap bounds the FINAL name, extension included (regression: it
        // used to bound only the base, letting the result reach 125 chars).
        let long = sanitize_export_file_name(&"n".repeat(500));
        assert!(
            long.len() <= 120,
            "the final name (extension included) must fit the 120-char cap: {}",
            long.len()
        );
        assert_eq!(long, format!("{}.html", "n".repeat(115)));
        assert!(long.ends_with(".html"));

        // A caller name that already carries the extension is capped the
        // same way (the caller's spelling of `.html` is preserved).
        let long_with_extension = sanitize_export_file_name(&format!("{}.html", "m".repeat(500)));
        assert!(long_with_extension.len() <= 120);
        assert_eq!(long_with_extension.len(), 120);
        assert!(long_with_extension.ends_with(".html"));

        // The cap counts characters, not bytes: a multibyte stem is safe.
        let long_multibyte = sanitize_export_file_name(&"é".repeat(500));
        assert!(long_multibyte.chars().count() <= 120);
        assert!(long_multibyte.ends_with(".html"));
    }
}
