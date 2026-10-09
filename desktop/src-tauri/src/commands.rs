//! The six DriverLens IPC commands (Task 7 boundary, extended) plus the
//! production dialog implementation (Task 7's native-dialog strategy).
//!
//! # The boundary
//!
//! Exactly seven custom commands exist, all snake_case:
//! `scan_devices`, `get_scan_state`, `cancel_scan`, `open_report`,
//! `export_report`, `export_html_report`, `get_report`. `export_report` takes
//! exactly ONE optional argument — `ids: string[]`, a list of device digests
//! to export (Task 10 filtered export), validated against the current report
//! and used only for set membership. `export_html_report` takes exactly TWO
//! arguments — `html` (the self-contained document the renderer built from
//! the validated report; redacted by default) and `suggested_name` (the save
//! dialog's default file name, sanitized before use — never a destination).
//! Nothing else is parameterized: the JS side cannot supply an executable
//! name, a shell command, a collector script path, or a filesystem
//! destination:
//!
//! - `scan_devices` / `get_scan_state` / `cancel_scan`: no arguments. The
//!   process to run, the script, the argument vector and the app-owned output
//!   path are all fixed by the Rust side.
//! - `open_report`: no arguments. The user picks the file through a NATIVE
//!   open dialog opened from the Rust side; the chosen path never travels
//!   through the webview (except the parsed, validated report returning).
//! - `export_report`: optionally `ids` (device digests only — never a path,
//!   never a destination, never a filter expression). The user picks the
//!   destination through a NATIVE save dialog; the dialog's own overwrite
//!   confirmation is the only overwrite confirmation. Writes the current
//!   in-memory report — full when `ids` is absent, or exactly the selected
//!   devices stamped with `filterNote` when it is present.
//! - `export_html_report`: `html` + `suggested_name` (renderer data only —
//!   never a destination). The user picks the destination through a NATIVE
//!   save dialog and the file written is exactly the chosen path. An empty
//!   payload or one above 8 MiB is refused before the dialog opens.
//! - `get_report`: no arguments, read-only. Returns the current in-memory
//!   report (the last accepted scan or import — the same stored value
//!   `export_report` writes) or `null` when none exists. It cannot start,
//!   cancel or influence anything; it is served from the same stored-report
//!   slot the scan/import paths maintain.
//!
//! Invocation permission is enforced by Tauri's ACL (see `build.rs` and
//! `capabilities/default.json`): only the bundled `main` window holds the
//! `allow-*` permissions. Plugin capabilities are irrelevant to this boundary.
//!
//! # Threading
//!
//! `open_report` and `export_report` are `async` commands: Tauri runs async
//! commands on the async runtime worker threads, which is required because
//! the blocking native dialog APIs must not run on the main/event-loop
//! thread. `scan_devices` returns immediately (the collection runs on its own
//! dedicated thread) and `get_scan_state`/`cancel_scan` only touch the state
//! mutex, so they are cheap synchronous commands.

use std::path::PathBuf;

use serde_json::Value;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::scan::{ExportSummary, ReportDialogs, ScanError, ScanManager, ScanSnapshot};

/// Starts a scan of this PC. Returns the running snapshot, or the `busy`
/// error when a scan is already in flight (parity with the browser helper's
/// 409). Poll `get_scan_state` for progress.
#[tauri::command]
pub fn scan_devices(state: State<'_, ScanManager>) -> Result<ScanSnapshot, ScanError> {
    state.start_scan()
}

/// Current scan lifecycle snapshot. No report contents, no raw paths.
#[tauri::command]
pub fn get_scan_state(state: State<'_, ScanManager>) -> ScanSnapshot {
    state.snapshot()
}

/// Requests cancellation of the running scan (idempotent; no-op when no scan
/// is running). The scan finishes as `cancelled` with no report accepted.
#[tauri::command]
pub fn cancel_scan(state: State<'_, ScanManager>) -> Result<(), ScanError> {
    state.cancel_scan();
    Ok(())
}

/// Opens a native file picker and imports the selected report. Returns the
/// parsed, validated report, or `None` when the dialog was cancelled. On
/// success the imported report also becomes the current in-memory report.
#[tauri::command]
pub async fn open_report(state: State<'_, ScanManager>) -> Result<Option<Value>, ScanError> {
    state.open_report()
}

/// Opens a native save picker and writes the current in-memory report as
/// schemaVersion 1 JSON. Returns the byte count written, or `None` when the
/// dialog was cancelled; refuses (`output_missing`) when no report exists.
///
/// `ids` selects a filtered export: exactly the devices with those ids, in
/// report order, stamped with `filterNote`. Every id must exist in the
/// current report (otherwise `invalid_selection`, refused before the dialog
/// opens) and the list is capped at the device limit. Ids are opaque display
/// strings — never paths.
#[tauri::command]
pub async fn export_report(
    state: State<'_, ScanManager>,
    ids: Option<Vec<String>>,
) -> Result<Option<ExportSummary>, ScanError> {
    state.export_report(ids)
}

/// Opens a native save picker and writes the renderer-built HTML document to
/// the chosen path. Returns the byte count written, or `None` when the
/// dialog was cancelled. The payload contract is enforced before the dialog
/// opens: empty is refused (`invalid_report`), above 8 MiB is refused
/// (`too_large`), and `suggested_name` is only the dialog's sanitized
/// default file name — never a destination.
#[tauri::command]
pub async fn export_html_report(
    state: State<'_, ScanManager>,
    html: String,
    suggested_name: String,
) -> Result<Option<ExportSummary>, ScanError> {
    state.export_html_report(html, suggested_name)
}

/// The current validated in-memory report (the last accepted scan or import),
/// or `null` when none exists yet. Read-only and argument-free: it cannot
/// start, cancel or influence anything, and it returns exactly the stored
/// value `export_report` writes. This is how a fresh scan result reaches the
/// UI's device table without a file having been saved first.
#[tauri::command]
pub fn get_report(state: State<'_, ScanManager>) -> Option<Value> {
    state.current_report()
}

/// Production [`ReportDialogs`]: Tauri's native dialogs via the Rust plugin
/// API. The webview is never involved — the renderer holds no dialog
/// permission at all (`capabilities/default.json` does not grant the dialog
/// plugin).
pub struct TauriReportDialogs {
    app: tauri::AppHandle,
}

impl TauriReportDialogs {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl ReportDialogs for TauriReportDialogs {
    fn pick_open_report(&self) -> Result<Option<PathBuf>, ScanError> {
        self.app
            .dialog()
            .file()
            .set_title("Open DriverLens report")
            .add_filter("DriverLens report (JSON)", &["json"])
            .blocking_pick_file()
            .map(|file_path| {
                file_path
                    .into_path()
                    .map_err(|_| ScanError::io())
            })
            .transpose()
    }

    fn pick_export_path(&self) -> Result<Option<PathBuf>, ScanError> {
        self.app
            .dialog()
            .file()
            .set_title("Export DriverLens report")
            .set_file_name("driverlens-report.json")
            .add_filter("DriverLens report (JSON)", &["json"])
            .blocking_save_file()
            .map(|file_path| {
                file_path
                    .into_path()
                    .map_err(|_| ScanError::io())
            })
            .transpose()
    }

    fn pick_export_html_path(&self, suggested_name: &str) -> Result<Option<PathBuf>, ScanError> {
        self.app
            .dialog()
            .file()
            .set_title("Export DriverLens HTML report")
            .set_file_name(suggested_name)
            .add_filter("DriverLens report (HTML)", &["html"])
            .blocking_save_file()
            .map(|file_path| {
                file_path
                    .into_path()
                    .map_err(|_| ScanError::io())
            })
            .transpose()
    }
}
