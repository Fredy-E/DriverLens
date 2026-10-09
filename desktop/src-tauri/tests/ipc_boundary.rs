//! IPC boundary integration tests (Task 7).
//!
//! Each test builds a mock-runtime app from the REAL generated context, so
//! Tauri resolves the REAL ACL embedded from `build.rs` +
//! `capabilities/default.json` through the actual invoke path — not a static
//! JSON grep. Every command runs against injected fakes; no real inventory
//! can run from these tests.
//!
//! This lives in `tests/` (integration) rather than `src/` because Windows
//! test binaries that link Tauri's GUI machinery need the comctl32 v6
//! manifest; `build.rs` embeds it for test targets only (see
//! `windows-test.manifest`), and rustc's `rustc-link-arg-tests` applies to
//! test targets.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value as JsonValue};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use driverlens_desktop_lib::collector::{ChildProcess, Runner};
use driverlens_desktop_lib::commands;
use driverlens_desktop_lib::scan::{
    ReportDialogs, ScanError, ScanManager, ScanManagerConfig, ScanSnapshot, ScanState,
};

/// The origin of a local (bundled) page on Windows.
const LOCAL_URL: &str = "http://tauri.localhost";
/// A remote origin (anything the app did not bundle).
const REMOTE_URL: &str = "https://evil.example/report";

#[cfg(windows)]
fn exit_status(code: u32) -> std::process::ExitStatus {
    use std::os::windows::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(code)
}

#[cfg(unix)]
fn exit_status(code: i32) -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(code)
}

/// Fake child that has always already exited (the fake runner writes its
/// output file during `spawn`, mirroring a collector that completed).
struct FakeChild {
    success: bool,
}

impl ChildProcess for FakeChild {
    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        Ok(Some(exit_status(if self.success { 0 } else { 1 })))
    }

    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }

    fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        Ok(exit_status(if self.success { 0 } else { 1 }))
    }

    fn output_tails(&mut self) -> (Vec<u8>, Vec<u8>) {
        (Vec::new(), Vec::new())
    }
}

/// Fake runner: records every spawn (program + exact args) and writes the
/// script's output to the `-OutputPath` element of the fixed argument vector.
struct FakeRunner {
    bytes: Vec<u8>,
    program: PathBuf,
    script: PathBuf,
    spawns: Mutex<Vec<(PathBuf, Vec<OsString>)>>,
}

impl FakeRunner {
    fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            program: PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            script: PathBuf::from(r"C:\Program Files\DriverLens\resources\Collect-DriverLens.ps1"),
            spawns: Mutex::new(Vec::new()),
        }
    }

    fn spawn_records(&self) -> Vec<(PathBuf, Vec<OsString>)> {
        self.spawns.lock().unwrap().clone()
    }

    fn spawn_count(&self) -> usize {
        self.spawns.lock().unwrap().len()
    }
}

impl Runner for FakeRunner {
    fn resolve_executable(&self) -> Result<PathBuf, ScanError> {
        Ok(self.program.clone())
    }

    fn script_path(&self) -> PathBuf {
        self.script.clone()
    }

    fn spawn(&self, program: &Path, args: &[OsString]) -> Result<Box<dyn ChildProcess>, ScanError> {
        self.spawns
            .lock()
            .unwrap()
            .push((program.to_path_buf(), args.to_vec()));
        let mut iter = args.iter();
        let mut output = None;
        while let Some(arg) = iter.next() {
            if arg == "-OutputPath" {
                output = iter.next().map(PathBuf::from);
            }
        }
        let output = output.expect("fixed args carry -OutputPath");
        std::fs::write(&output, &self.bytes).map_err(|_| ScanError::io())?;
        Ok(Box::new(FakeChild { success: true }))
    }
}

/// Fake dialogs: each side is either a chosen path (Ok(Some)) or a simulated
/// cancel (Ok(None)).
struct FakeDialogs {
    open: Mutex<Option<PathBuf>>,
    save: Mutex<Option<PathBuf>>,
}

impl ReportDialogs for FakeDialogs {
    fn pick_open_report(&self) -> Result<Option<PathBuf>, ScanError> {
        Ok(self.open.lock().unwrap().clone())
    }

    fn pick_export_path(&self) -> Result<Option<PathBuf>, ScanError> {
        Ok(self.save.lock().unwrap().clone())
    }
}

fn scratch_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "driverlens-ipc-{label}-{}-{nanos:x}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("scratch dir must be creatable");
    dir
}

fn build_app(runner: Arc<FakeRunner>, dialogs: Arc<FakeDialogs>) -> tauri::App<MockRuntime> {
    let manager = ScanManager::new(ScanManagerConfig {
        runner,
        dialogs: Some(dialogs),
        scans_dir: scratch_dir("scans"),
        deadline: Duration::from_secs(10),
    });
    mock_builder()
        .invoke_handler(tauri::generate_handler![
            commands::scan_devices,
            commands::get_scan_state,
            commands::cancel_scan,
            commands::open_report,
            commands::export_report,
            commands::get_report
        ])
        .manage(manager)
        .build(tauri::generate_context!())
        .expect("the mock test app must build")
}

fn window(app: &tauri::App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .build()
        .expect("mock window must build")
}

fn request(cmd: &str, url: &str, body: InvokeBody) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: url.parse().expect("test URL must parse"),
        body,
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    url: &str,
) -> Result<tauri::ipc::InvokeResponseBody, JsonValue> {
    get_ipc_response(webview, request(cmd, url, InvokeBody::default()))
}

/// An ACL denial is a JSON *string* error; a command-level refusal is a JSON
/// *object* (`{code, message}`). This discriminator is asserted explicitly so
/// "denied" can never be confused with "ran and refused".
fn assert_acl_denied(result: Result<tauri::ipc::InvokeResponseBody, JsonValue>, cmd: &str) {
    let error = result.expect_err(&format!("{cmd} must be denied"));
    let message = error
        .as_str()
        .unwrap_or_else(|| panic!("{cmd}: expected an ACL denial string, got {error}"));
    assert!(
        message.contains("not allowed"),
        "{cmd}: denial message must say so, got: {message}"
    );
}

fn wait_for_terminal(manager: &ScanManager, timeout: Duration) -> ScanSnapshot {
    let deadline = Instant::now() + timeout;
    loop {
        let snapshot = manager.snapshot();
        if snapshot.state != ScanState::Running {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "scan did not reach a terminal state in time: {snapshot:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn sample_bytes() -> Vec<u8> {
    include_bytes!("../fixtures/sample.json").to_vec()
}

#[test]
fn ipc_allowed_commands_respond_on_main_window() {
    let runner = Arc::new(FakeRunner::new(sample_bytes()));
    let dialogs = Arc::new(FakeDialogs {
        open: Mutex::new(None),
        save: Mutex::new(None),
    });
    let app = build_app(runner.clone(), dialogs);
    let main = window(&app, "main");

    // get_scan_state: allowed, typed snapshot, and inert.
    let body = invoke(&main, "get_scan_state", LOCAL_URL).expect("get_scan_state must be allowed");
    let snapshot = body
        .deserialize::<ScanSnapshot>()
        .expect("snapshot must deserialize");
    assert_eq!(snapshot.state, ScanState::Idle);
    assert_eq!(snapshot.generation, 0);
    assert_eq!(snapshot.started_ms, None);
    assert_eq!(snapshot.error_code, None);
    assert_eq!(snapshot.device_count, None);

    // cancel_scan: allowed, idempotent no-op with no scan running.
    invoke(&main, "cancel_scan", LOCAL_URL).expect("cancel_scan must be allowed");

    // open_report: allowed; the fake dialog cancels -> Ok(None).
    let body = invoke(&main, "open_report", LOCAL_URL).expect("open_report must be allowed");
    assert_eq!(
        body.deserialize::<Option<JsonValue>>().expect("option"),
        None,
        "a cancelled dialog is a normal None, not an error"
    );

    // get_report: allowed, read-only, and null before any scan or import.
    let body = invoke(&main, "get_report", LOCAL_URL).expect("get_report must be allowed");
    assert_eq!(
        body.deserialize::<Option<JsonValue>>().expect("option"),
        None,
        "no report exists yet, so get_report answers null"
    );

    // export_report: allowed; no report yet -> business refusal (object error
    // with code output_missing), NOT an ACL denial.
    let result = invoke(&main, "export_report", LOCAL_URL);
    let refusal = result.expect_err("export must refuse without a report");
    assert_eq!(
        refusal["code"], "output_missing",
        "expected the business-refusal DTO, got {refusal}"
    );

    // Nothing above may have started a collection.
    assert_eq!(runner.spawn_count(), 0);
    assert_eq!(
        app.state::<ScanManager>().snapshot().state,
        ScanState::Idle
    );
}

#[test]
fn ipc_scan_runs_through_injected_runner_and_completes() {
    let runner = Arc::new(FakeRunner::new(sample_bytes()));
    let dialogs = Arc::new(FakeDialogs {
        open: Mutex::new(None),
        save: Mutex::new(None),
    });
    let app = build_app(runner.clone(), dialogs);
    let main = window(&app, "main");

    let body = invoke(&main, "scan_devices", LOCAL_URL).expect("scan_devices must be allowed");
    let started = body.deserialize::<ScanSnapshot>().expect("snapshot");
    assert_eq!(started.state, ScanState::Running);
    assert_eq!(started.generation, 1);
    assert!(started.started_ms.is_some(), "running scans report started_ms");

    let manager = app.state::<ScanManager>();
    let terminal = wait_for_terminal(&manager, Duration::from_secs(15));
    assert_eq!(terminal.state, ScanState::Complete);
    assert_eq!(terminal.generation, 1);
    assert_eq!(terminal.device_count, Some(3));
    assert_eq!(terminal.started_ms, None, "terminal states clear started_ms");

    // The same result is visible over IPC.
    let body = invoke(&main, "get_scan_state", LOCAL_URL).expect("allowed");
    let snapshot = body.deserialize::<ScanSnapshot>().expect("snapshot");
    assert_eq!(snapshot.state, ScanState::Complete);
    assert_eq!(snapshot.device_count, Some(3));
}

/// `get_report` is the read-only bridge from a completed scan to the device
/// table: null before any report exists, exactly the stored report after a
/// (synthetic) scan, unchanged by forged arguments, and it never spawns
/// anything.
#[test]
fn ipc_get_report_returns_the_scan_report_and_ignores_forged_arguments() {
    let runner = Arc::new(FakeRunner::new(sample_bytes()));
    let app = build_app(
        runner.clone(),
        Arc::new(FakeDialogs {
            open: Mutex::new(None),
            save: Mutex::new(None),
        }),
    );
    let main = window(&app, "main");

    // Null before any scan or import.
    let body = invoke(&main, "get_report", LOCAL_URL).expect("get_report must be allowed");
    assert_eq!(
        body.deserialize::<Option<JsonValue>>().expect("option"),
        None,
        "no report exists yet"
    );

    // Run a synthetic scan through the real invoke path.
    invoke(&main, "scan_devices", LOCAL_URL).expect("scan start allowed");
    let manager = app.state::<ScanManager>();
    let terminal = wait_for_terminal(&manager, Duration::from_secs(15));
    assert_eq!(terminal.state, ScanState::Complete);

    // Forged extra arguments are ignored entirely: the response is exactly
    // the stored report, and no forged value appears anywhere in it.
    let forged = InvokeBody::Json(json!({
        "path": "C:\\evil-report.json",
        "command": "read_anything",
        "ids": ["NOT-A-DEVICE"],
        "outputPath": "C:\\evil-output.json"
    }));
    let body = get_ipc_response(&main, request("get_report", LOCAL_URL, forged))
        .expect("get_report must run with its fixed, argument-free behavior");
    let report = body
        .deserialize::<Option<JsonValue>>()
        .expect("option")
        .expect("a report exists after the scan");
    assert_eq!(report["schemaVersion"], 1);
    let devices = report["devices"].as_array().expect("devices array");
    assert_eq!(devices.len(), 3);
    assert_eq!(devices[0]["id"], "SAMPLE001");
    let text = serde_json::to_string(&report).expect("serialize");
    assert!(!text.contains("evil"), "forged values must not reach the report");

    // Read-only: no additional spawn, and the stored report is still current
    // (a full export would write exactly this value).
    assert_eq!(runner.spawn_count(), 1, "get_report must never spawn anything");
    assert_eq!(manager.snapshot().device_count, Some(3));
}

#[test]
fn ipc_unknown_command_name_is_rejected() {
    let app = build_app(
        Arc::new(FakeRunner::new(sample_bytes())),
        Arc::new(FakeDialogs {
            open: Mutex::new(None),
            save: Mutex::new(None),
        }),
    );
    let main = window(&app, "main");
    for cmd in ["read_anything", "run_program", "open_report_anywhere"] {
        assert_acl_denied(invoke(&main, cmd, LOCAL_URL), cmd);
    }
}

#[test]
fn ipc_window_without_capability_is_denied_for_every_command() {
    let runner = Arc::new(FakeRunner::new(sample_bytes()));
    let app = build_app(
        runner.clone(),
        Arc::new(FakeDialogs {
            open: Mutex::new(None),
            save: Mutex::new(None),
        }),
    );
    let other = window(&app, "other");
    for cmd in [
        "scan_devices",
        "get_scan_state",
        "cancel_scan",
        "open_report",
        "export_report",
        "get_report",
        "read_anything",
    ] {
        assert_acl_denied(invoke(&other, cmd, LOCAL_URL), cmd);
    }
    // Denial happened before execution: no collection started.
    assert_eq!(runner.spawn_count(), 0, "no spawn may happen on a denied window");
    assert_eq!(
        app.state::<ScanManager>().snapshot().state,
        ScanState::Idle,
        "denied commands must not start scans"
    );
}

#[test]
fn ipc_remote_origin_is_denied() {
    let runner = Arc::new(FakeRunner::new(sample_bytes()));
    let app = build_app(
        runner.clone(),
        Arc::new(FakeDialogs {
            open: Mutex::new(None),
            save: Mutex::new(None),
        }),
    );
    let main = window(&app, "main");
    for cmd in [
        "scan_devices",
        "get_scan_state",
        "open_report",
        "export_report",
        "get_report",
    ] {
        assert_acl_denied(invoke(&main, cmd, REMOTE_URL), cmd);
    }
    assert_eq!(runner.spawn_count(), 0);
    assert_eq!(app.state::<ScanManager>().snapshot().state, ScanState::Idle);
}

/// A page that forges a body with a program, arguments, and an output path
/// cannot smuggle any of them: the fixed vector is used instead.
#[test]
fn ipc_forged_arguments_cannot_change_program_args_or_output() {
    let runner = Arc::new(FakeRunner::new(sample_bytes()));
    let app = build_app(
        runner.clone(),
        Arc::new(FakeDialogs {
            open: Mutex::new(None),
            save: Mutex::new(None),
        }),
    );
    let main = window(&app, "main");

    let forged = InvokeBody::Json(json!({
        "program": "C:\\evil.exe",
        "command": "calc.exe",
        "scriptPath": "C:\\evil.ps1",
        "args": ["-ExecutionPolicy", "Bypass", "-Command", "Invoke-Evil"],
        "outputPath": "C:\\evil-output.json"
    }));
    let result = get_ipc_response(&main, request("scan_devices", LOCAL_URL, forged));
    result.expect("scan_devices must run with its fixed configuration");

    let manager = app.state::<ScanManager>();
    let terminal = wait_for_terminal(&manager, Duration::from_secs(15));
    assert_eq!(terminal.state, ScanState::Complete);

    let records = runner.spawn_records();
    assert_eq!(records.len(), 1);
    let (program, args) = &records[0];
    // Program: exactly the runner's resolved executable.
    assert_eq!(program, &runner.program);
    // Args: exactly the fixed six-element vector.
    assert_eq!(args.len(), 6);
    assert_eq!(args[0], "-NoProfile");
    assert_eq!(args[1], "-NonInteractive");
    assert_eq!(args[2], "-File");
    assert_eq!(args[3], runner.script.as_os_str());
    assert_eq!(args[4], "-OutputPath");
    let output = PathBuf::from(&args[5]);
    assert!(
        output
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("scan-1-") && name.ends_with(".json")),
        "output must be the app-generated generation-named file, got {output:?}"
    );
    for arg in args {
        let text = arg.to_string_lossy().into_owned();
        assert!(
            !text.contains("evil") && !text.contains("Bypass") && !text.contains("calc"),
            "forged value leaked into args: {text}"
        );
    }
}

#[test]
fn ipc_import_and_export_run_through_native_dialog_layer() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = manifest_dir.join("fixtures").join("sample.json");
    let export_dir = scratch_dir("export");
    let export_path = export_dir.join("driverlens-report.json");
    let dialogs = Arc::new(FakeDialogs {
        open: Mutex::new(Some(fixture)),
        save: Mutex::new(Some(export_path.clone())),
    });
    let app = build_app(Arc::new(FakeRunner::new(sample_bytes())), dialogs);
    let main = window(&app, "main");

    // Import (async command) through the real invoke path.
    let body = invoke(&main, "open_report", LOCAL_URL).expect("open_report must be allowed");
    let imported = body
        .deserialize::<Option<JsonValue>>()
        .expect("option")
        .expect("the fake dialog picked a file");
    assert_eq!(imported["schemaVersion"], 1);
    assert_eq!(imported["devices"].as_array().expect("devices").len(), 3);
    assert_eq!(
        app.state::<ScanManager>().snapshot().device_count,
        Some(3),
        "import updates the current report (export source)"
    );

    // Export (async command): writes the imported report back out.
    let body = invoke(&main, "export_report", LOCAL_URL).expect("export must be allowed");
    let summary = body
        .deserialize::<Option<driverlens_desktop_lib::scan::ExportSummary>>()
        .expect("option")
        .expect("the fake dialog picked a destination");
    assert_eq!(
        summary.bytes_written,
        std::fs::metadata(&export_path).expect("exported file").len()
    );
    let text = std::fs::read_to_string(&export_path).expect("exported file readable");
    assert!(text.contains("\"schemaVersion\": 1"));
    driverlens_desktop_lib::report::validate_report_str(&text)
        .expect("export must revalidate as schemaVersion 1");
}

/// Filtered export over the real invoke path: `ids` is the ONLY argument
/// that ever influences an export — the destination still comes from the
/// native dialog, unknown ids are refused with the `invalid_selection`
/// business DTO (never an ACL denial), and a forged body cannot smuggle
/// anything else alongside the ids.
#[test]
fn ipc_filtered_export_accepts_only_ids() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture = manifest_dir.join("fixtures").join("sample.json");
    let export_dir = scratch_dir("export-filtered-ipc");
    let export_path = export_dir.join("filtered.json");
    let dialogs = Arc::new(FakeDialogs {
        open: Mutex::new(Some(fixture)),
        save: Mutex::new(Some(export_path.clone())),
    });
    let app = build_app(Arc::new(FakeRunner::new(sample_bytes())), dialogs);
    let main = window(&app, "main");

    let body = invoke(&main, "open_report", LOCAL_URL).expect("open_report must be allowed");
    body.deserialize::<Option<JsonValue>>()
        .expect("option")
        .expect("the fake dialog picked a file");

    // Forged extras alongside ids: only the ids may be honored — the
    // destination is still the dialog's path and the program/args/output
    // keys must be ignored entirely.
    let forged = InvokeBody::Json(json!({
        "ids": ["SAMPLE002"],
        "program": "C:\\evil.exe",
        "outputPath": "C:\\evil-output.json",
        "args": ["--evil"]
    }));
    let result = get_ipc_response(&main, request("export_report", LOCAL_URL, forged));
    let body = result.expect("a filtered export with valid ids must run");
    body.deserialize::<Option<driverlens_desktop_lib::scan::ExportSummary>>()
        .expect("option")
        .expect("the fake dialog picked a destination");

    let text = std::fs::read_to_string(&export_path).expect("written file");
    let value: JsonValue = serde_json::from_str(&text).expect("json");
    assert_eq!(value["filterNote"], "Filtered export from DriverLens");
    let ids: Vec<&str> = value["devices"]
        .as_array()
        .expect("devices")
        .iter()
        .filter_map(|device| device["id"].as_str())
        .collect();
    assert_eq!(ids, ["SAMPLE002"], "exactly the selected device");
    assert!(!text.contains("evil"), "forged values must not reach the file");
    driverlens_desktop_lib::report::validate_report_str(&text)
        .expect("filtered export must revalidate as schemaVersion 1");

    // Unknown ids: business refusal with the invalid_selection DTO — NOT an
    // ACL denial string, and nothing is written.
    let unknown = InvokeBody::Json(json!({ "ids": ["NOT-IN-THE-REPORT"] }));
    let error = get_ipc_response(&main, request("export_report", LOCAL_URL, unknown))
        .expect_err("unknown ids must be refused");
    assert_eq!(
        error.get("code").and_then(|code| code.as_str()),
        Some("invalid_selection"),
        "expected the business-refusal DTO, got {error}"
    );

    // Absent ids (no argument at all) still takes the full-export path.
    let body = invoke(&main, "export_report", LOCAL_URL).expect("full export must be allowed");
    let summary = body
        .deserialize::<Option<driverlens_desktop_lib::scan::ExportSummary>>()
        .expect("option")
        .expect("destination picked");
    assert!(summary.bytes_written > 0);
    let full = std::fs::read_to_string(&export_path).expect("full export file");
    assert!(!full.contains("filterNote"), "a full export gains no filterNote");
}

/// The main window can reach the dialog-backed commands even while a scan is
/// running, and a denied window never can — the boundary does not depend on
/// scan state. (The fake runner completes scans immediately, so the deny
/// checks run against whatever state the machine is in.)
#[test]
fn ipc_boundary_is_independent_of_scan_state() {
    let runner = Arc::new(FakeRunner::new(sample_bytes()));
    let app = build_app(
        runner.clone(),
        Arc::new(FakeDialogs {
            open: Mutex::new(None),
            save: Mutex::new(None),
        }),
    );
    let main = window(&app, "main");
    let other = window(&app, "other");

    invoke(&main, "scan_devices", LOCAL_URL).expect("scan start allowed");
    assert_acl_denied(
        invoke(&other, "scan_devices", LOCAL_URL),
        "scan_devices (other)",
    );
    assert_acl_denied(
        invoke(&other, "cancel_scan", LOCAL_URL),
        "cancel_scan (other)",
    );
    invoke(&main, "cancel_scan", LOCAL_URL).expect("cancel allowed on main");

    let manager = app.state::<ScanManager>();
    let terminal = wait_for_terminal(&manager, Duration::from_secs(15));
    let _ = terminal;
}
