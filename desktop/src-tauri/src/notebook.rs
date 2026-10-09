//! USB Device Notebook (extension E-01) — the local device/driver history
//! store and its IPC-facing view.
//!
//! # What this is
//!
//! A private, local-only JSON store that remembers, per device (keyed by the
//! report's privacy digest `id`), when it was first and last seen, its
//! observed driver/status history, and a user note. Nothing here ever leaves
//! the machine: no network code, no upload, no telemetry.
//!
//! # Store shape (`notebook.json`)
//!
//! `{ "version": 1, "updatedAt": <ms>, "devices": { "<key>": {...} } }` —
//! written atomically (temp file + rename) into the app-owned
//! `notebook/` directory under the app local data dir.
//!
//! # Caps (enforced on every write)
//!
//! - at most [`MAX_NOTEBOOK_DEVICES`] devices; over the cap, the device with
//!   the smallest `lastSeen` is evicted (ties broken by key for determinism);
//! - at most [`MAX_OBSERVATIONS_PER_DEVICE`] observations per device; the
//!   oldest are dropped first;
//! - consecutive-duplicate collapse: a new observation is recorded only when
//!   `version` / `provider` / `windowsStatus` / `errorCode` differ from the
//!   previous stored observation (a first sighting always records one);
//!   `firstSeen` / `lastSeen` are bookkeeping and update on every sighting;
//! - notes are at most [`MAX_NOTE_CHARS`] characters (rejected beyond that).
//!
//! # Failure policy
//!
//! Scan recording is best-effort: [`NotebookStore::record_report`] returns an
//! error but the scan path never propagates it (see `scan.rs`), so a store
//! failure can never fail or block a scan. Read paths treat a missing,
//! unreadable, oversized or unparsable store as empty; the next successful
//! write replaces it atomically.
//!
//! # Privacy
//!
//! Only fields that are already part of the validated report are stored:
//! the privacy digest key, name, vid/pid/bus/deviceClass, driver version,
//! provider, Windows status, error code, and the user's own note. Never raw
//! instance IDs, paths, usernames, or hostnames.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::scan::{ScanError, ScanErrorCode};

/// Store schema version this module reads and writes.
pub const NOTEBOOK_SCHEMA_VERSION: u64 = 1;

/// Hard cap on stored devices; over the cap the least-recently-seen device is
/// evicted.
pub const MAX_NOTEBOOK_DEVICES: usize = 500;

/// Hard cap on observations per device (oldest dropped first).
pub const MAX_OBSERVATIONS_PER_DEVICE: usize = 100;

/// Hard cap on note length, in characters.
pub const MAX_NOTE_CHARS: usize = 4000;

/// Store file name inside the notebook directory.
pub const NOTEBOOK_FILE_NAME: &str = "notebook.json";

/// Temporary file used by the atomic write (same directory, same volume).
const TEMP_FILE_NAME: &str = "notebook.json.tmp";

/// Read-side sanity bound: a store file larger than this is treated as empty
/// rather than parsed (it can never be produced by this app's own caps).
const MAX_STORE_BYTES: u64 = 8 * 1024 * 1024;

/// One recorded sighting of a device's driver/status tuple.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    /// Wall-clock time of the sighting, ms since UNIX epoch.
    pub at: u64,
    /// Driver version at this sighting (absent/empty = unknown).
    pub version: Option<String>,
    /// Driver provider at this sighting.
    pub provider: Option<String>,
    /// Windows device status string at this sighting.
    pub windows_status: Option<String>,
    /// Win32 ConfigManagerErrorCode at this sighting (0 is a real value).
    pub error_code: Option<i64>,
}

/// One stored device: identity, sighting bookkeeping, observation history and
/// the user's note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    /// Privacy digest of the instance ID (the report's `id`).
    pub key: String,
    /// Human-readable device name (latest sighting wins).
    pub name: String,
    pub vid: Option<String>,
    pub pid: Option<String>,
    pub bus: Option<String>,
    pub device_class: Option<String>,
    /// First and last sighting times, ms since UNIX epoch.
    pub first_seen: u64,
    pub last_seen: u64,
    /// Driver/status history, oldest first, capped at
    /// [`MAX_OBSERVATIONS_PER_DEVICE`].
    pub observations: Vec<Observation>,
    /// User note (capped at [`MAX_NOTE_CHARS`] characters).
    pub note: String,
}

/// The persisted store document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub version: u64,
    pub updated_at: u64,
    pub devices: BTreeMap<String, DeviceRecord>,
}

impl Default for Notebook {
    fn default() -> Self {
        Self {
            version: NOTEBOOK_SCHEMA_VERSION,
            updated_at: 0,
            devices: BTreeMap::new(),
        }
    }
}

/// The device's current driver/status tuple (last stored observation).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentDriver {
    pub version: Option<String>,
    pub provider: Option<String>,
    pub windows_status: Option<String>,
    pub error_code: Option<i64>,
}

/// One derived field change between two consecutive observations.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookChange {
    /// When the new value was observed.
    pub at: u64,
    /// `version` | `provider` | `windowsStatus` | `errorCode`.
    pub field: String,
    /// Previous value (JSON null when unknown).
    pub from: Value,
    /// New value (JSON null when unknown).
    pub to: Value,
}

/// The `get_notebook` device shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookDeviceView {
    pub key: String,
    pub name: String,
    pub vid: Option<String>,
    pub pid: Option<String>,
    pub bus: Option<String>,
    pub device_class: Option<String>,
    pub first_seen: u64,
    pub last_seen: u64,
    pub observations: Vec<Observation>,
    pub current: CurrentDriver,
    pub changes: Vec<NotebookChange>,
    pub note: String,
}

/// The `get_notebook` payload. Devices are ordered most-recently-seen first
/// (ties broken by key) so the newest activity is at the top.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookView {
    pub devices: Vec<NotebookDeviceView>,
    pub updated_at: u64,
}

/// Uniform success payload for the write commands (`{ "ok": true }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OkResponse {
    pub ok: bool,
}

/// Store-level failure vocabulary, mapped onto the shared [`ScanError`] DTO
/// at the command boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotebookError {
    /// `save_device_note` for a key that is not in the store.
    UnknownKey,
    /// Note text beyond [`MAX_NOTE_CHARS`] characters.
    NoteTooLong,
    /// Any filesystem failure (create/write/rename).
    Io,
}

impl From<NotebookError> for ScanError {
    fn from(error: NotebookError) -> Self {
        match error {
            NotebookError::UnknownKey => ScanError::new(
                ScanErrorCode::UnknownKey,
                "No device with that key exists in the notebook.",
            ),
            NotebookError::NoteTooLong => ScanError::new(
                ScanErrorCode::NoteTooLong,
                "The note exceeds the 4000 character limit.",
            ),
            NotebookError::Io => ScanError::new(
                ScanErrorCode::Io,
                "The notebook store could not be written.",
            ),
        }
    }
}

/// The notebook store: a directory plus a lazily-loaded, write-through cache
/// of its `notebook.json`. Cheap to construct; lives in Tauri managed state.
pub struct NotebookStore {
    dir: PathBuf,
    state: Mutex<Option<Notebook>>,
}

impl NotebookStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            state: Mutex::new(None),
        }
    }

    /// Records one observation per device of a validated report. Best-effort
    /// by contract: the caller (the scan success path) ignores the result, so
    /// a store failure never fails or blocks a scan.
    pub fn record_report(&self, report: &Value) -> Result<(), NotebookError> {
        self.record_report_at(report, now_ms())
    }

    /// The `now`-injectable core of [`NotebookStore::record_report`]
    /// (unit-testable without clock races).
    fn record_report_at(&self, report: &Value, now: u64) -> Result<(), NotebookError> {
        let Some(devices) = report.get("devices").and_then(Value::as_array) else {
            return Ok(());
        };
        self.mutate(|notebook| {
            for device in devices {
                let Some(key) = device.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let observation = Observation {
                    at: now,
                    version: field_str(device, "version"),
                    provider: field_str(device, "provider"),
                    windows_status: field_str(device, "windowsStatus"),
                    error_code: device.get("errorCode").and_then(Value::as_i64),
                };
                match notebook.devices.get_mut(key) {
                    Some(record) => {
                        // Identity fields follow the latest sighting.
                        record.name = field_str(device, "name").unwrap_or_default();
                        record.vid = field_str(device, "vid");
                        record.pid = field_str(device, "pid");
                        record.bus = field_str(device, "bus");
                        record.device_class = field_str(device, "deviceClass");
                        record.last_seen = now;
                        // Consecutive-duplicate collapse: record only when the
                        // driver/status tuple differs from the previous stored
                        // observation; firstSeen/lastSeen stay bookkeeping.
                        let changed = record.observations.last().map_or(true, |previous| {
                            previous.version != observation.version
                                || previous.provider != observation.provider
                                || previous.windows_status != observation.windows_status
                                || previous.error_code != observation.error_code
                        });
                        if changed {
                            record.observations.push(observation);
                            let overflow = record
                                .observations
                                .len()
                                .saturating_sub(MAX_OBSERVATIONS_PER_DEVICE);
                            if overflow > 0 {
                                record.observations.drain(0..overflow);
                            }
                        }
                    }
                    None => {
                        notebook.devices.insert(
                            key.to_owned(),
                            DeviceRecord {
                                key: key.to_owned(),
                                name: field_str(device, "name").unwrap_or_default(),
                                vid: field_str(device, "vid"),
                                pid: field_str(device, "pid"),
                                bus: field_str(device, "bus"),
                                device_class: field_str(device, "deviceClass"),
                                first_seen: now,
                                last_seen: now,
                                observations: vec![observation],
                                note: String::new(),
                            },
                        );
                    }
                }
            }
            evict_least_recently_seen(&mut notebook.devices);
            notebook.updated_at = now;
            Ok(())
        })
    }

    /// Saves the note for an existing device. Rejects unknown keys and
    /// over-long text before touching the store.
    pub fn save_note(&self, key: &str, text: &str) -> Result<(), NotebookError> {
        if text.chars().count() > MAX_NOTE_CHARS {
            return Err(NotebookError::NoteTooLong);
        }
        self.mutate(|notebook| {
            let Some(record) = notebook.devices.get_mut(key) else {
                return Err(NotebookError::UnknownKey);
            };
            record.note = text.to_owned();
            notebook.updated_at = now_ms();
            Ok(())
        })
    }

    /// Removes the store file (idempotent) and resets the cache.
    pub fn clear(&self) -> Result<(), NotebookError> {
        let mut guard = self.lock();
        let path = self.dir.join(NOTEBOOK_FILE_NAME);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(NotebookError::Io),
        }
        let _ = std::fs::remove_file(self.dir.join(TEMP_FILE_NAME));
        *guard = Some(Notebook::default());
        Ok(())
    }

    /// The `get_notebook` view. Read-only; a missing/corrupt store reads as
    /// empty (never an error, never a panic). Devices are ordered
    /// most-recently-seen first, ties broken by key.
    pub fn view(&self) -> NotebookView {
        let mut guard = self.lock();
        let notebook = self.read_locked(&mut guard);
        let mut devices: Vec<NotebookDeviceView> =
            notebook.devices.values().map(device_view).collect();
        devices.sort_by(|left, right| {
            right
                .last_seen
                .cmp(&left.last_seen)
                .then_with(|| left.key.cmp(&right.key))
        });
        NotebookView {
            devices,
            updated_at: notebook.updated_at,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Notebook>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The cached store, loaded from disk on first access. Missing,
    /// unreadable, oversized or unparsable stores read as empty.
    fn read_locked(&self, guard: &mut Option<Notebook>) -> Notebook {
        if let Some(notebook) = guard.as_ref() {
            return notebook.clone();
        }
        let notebook = load_from_dir(&self.dir);
        *guard = Some(notebook.clone());
        notebook
    }

    /// Read-modify-write under the lock: the change closure runs on a copy,
    /// the copy is atomically saved, and only then committed to the cache —
    /// so a failed write never leaves the cache ahead of the disk.
    fn mutate<T>(
        &self,
        change: impl FnOnce(&mut Notebook) -> Result<T, NotebookError>,
    ) -> Result<T, NotebookError> {
        let mut guard = self.lock();
        let mut notebook = self.read_locked(&mut guard);
        let value = change(&mut notebook)?;
        save_atomic(&self.dir, &notebook)?;
        *guard = Some(notebook);
        Ok(value)
    }
}

fn field_str(device: &Value, field: &str) -> Option<String> {
    device
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Evicts the least-recently-seen devices until the cap holds. Ties (equal
/// `lastSeen`, e.g. one scan recorded at a single instant) break by key so
/// eviction is deterministic.
fn evict_least_recently_seen(devices: &mut BTreeMap<String, DeviceRecord>) {
    while devices.len() > MAX_NOTEBOOK_DEVICES {
        let victim = devices
            .iter()
            .min_by_key(|(key, record)| (record.last_seen, (*key).clone()))
            .map(|(key, _)| key.clone());
        match victim {
            Some(key) => {
                devices.remove(&key);
            }
            None => break,
        }
    }
}

fn device_view(record: &DeviceRecord) -> NotebookDeviceView {
    let current = record
        .observations
        .last()
        .map(|observation| CurrentDriver {
            version: observation.version.clone(),
            provider: observation.provider.clone(),
            windows_status: observation.windows_status.clone(),
            error_code: observation.error_code,
        })
        .unwrap_or(CurrentDriver {
            version: None,
            provider: None,
            windows_status: None,
            error_code: None,
        });
    NotebookDeviceView {
        key: record.key.clone(),
        name: record.name.clone(),
        vid: record.vid.clone(),
        pid: record.pid.clone(),
        bus: record.bus.clone(),
        device_class: record.device_class.clone(),
        first_seen: record.first_seen,
        last_seen: record.last_seen,
        observations: record.observations.clone(),
        current,
        changes: changes_of(&record.observations),
        note: record.note.clone(),
    }
}

fn text_to_json(value: &Option<String>) -> Value {
    value
        .as_ref()
        .map_or(Value::Null, |text| Value::String(text.clone()))
}

fn number_to_json(value: Option<i64>) -> Value {
    value.map_or(Value::Null, |number| Value::Number(number.into()))
}

/// Field changes between consecutive stored observations.
fn changes_of(observations: &[Observation]) -> Vec<NotebookChange> {
    let mut changes = Vec::new();
    for pair in observations.windows(2) {
        let (previous, next) = (&pair[0], &pair[1]);
        if previous.version != next.version {
            changes.push(NotebookChange {
                at: next.at,
                field: "version".to_owned(),
                from: text_to_json(&previous.version),
                to: text_to_json(&next.version),
            });
        }
        if previous.provider != next.provider {
            changes.push(NotebookChange {
                at: next.at,
                field: "provider".to_owned(),
                from: text_to_json(&previous.provider),
                to: text_to_json(&next.provider),
            });
        }
        if previous.windows_status != next.windows_status {
            changes.push(NotebookChange {
                at: next.at,
                field: "windowsStatus".to_owned(),
                from: text_to_json(&previous.windows_status),
                to: text_to_json(&next.windows_status),
            });
        }
        if previous.error_code != next.error_code {
            changes.push(NotebookChange {
                at: next.at,
                field: "errorCode".to_owned(),
                from: number_to_json(previous.error_code),
                to: number_to_json(next.error_code),
            });
        }
    }
    changes
}

fn load_from_dir(dir: &Path) -> Notebook {
    let path = dir.join(NOTEBOOK_FILE_NAME);
    let Ok(metadata) = std::fs::metadata(&path) else {
        return Notebook::default();
    };
    if metadata.len() > MAX_STORE_BYTES {
        return Notebook::default();
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return Notebook::default();
    };
    let Ok(notebook) = serde_json::from_slice::<Notebook>(&bytes) else {
        return Notebook::default();
    };
    if notebook.version != NOTEBOOK_SCHEMA_VERSION {
        return Notebook::default();
    }
    notebook
}

/// Atomic write: serialize to a temp file in the same directory, flush it,
/// then rename over the store file (on Windows this replaces the existing
/// file in one step). A failed rename removes the temp file best-effort.
fn save_atomic(dir: &Path, notebook: &Notebook) -> Result<(), NotebookError> {
    std::fs::create_dir_all(dir).map_err(|_| NotebookError::Io)?;
    let final_path = dir.join(NOTEBOOK_FILE_NAME);
    let temp_path = dir.join(TEMP_FILE_NAME);
    let json = serde_json::to_vec_pretty(notebook).map_err(|_| NotebookError::Io)?;
    {
        let mut file = std::fs::File::create(&temp_path).map_err(|_| NotebookError::Io)?;
        file.write_all(&json).map_err(|_| NotebookError::Io)?;
        file.sync_all().map_err(|_| NotebookError::Io)?;
    }
    std::fs::rename(&temp_path, &final_path).map_err(|_| {
        let _ = std::fs::remove_file(&temp_path);
        NotebookError::Io
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fakes::scratch_dir;

    fn store(label: &str) -> (NotebookStore, PathBuf) {
        let dir = scratch_dir(&format!("notebook-{label}"));
        (NotebookStore::new(dir.clone()), dir)
    }

    fn device_json(id: &str, version: &str) -> Value {
        serde_json::json!({
            "id": id,
            "name": format!("Device {id}"),
            "status": "observed",
            "deviceClass": "Ports",
            "bus": "USB",
            "vid": "0403",
            "pid": "6001",
            "provider": "Example provider",
            "version": version,
            "windowsStatus": "OK",
            "errorCode": 0
        })
    }

    fn report_with(devices: Vec<Value>) -> Value {
        serde_json::json!({ "schemaVersion": 1, "devices": devices })
    }

    // -- create / append / collapse ------------------------------------------

    #[test]
    fn first_scan_creates_devices_with_one_observation_each() {
        let (store, dir) = store("create");
        store
            .record_report_at(
                &report_with(vec![device_json("A", "1.0"), device_json("B", "2.0")]),
                1_000,
            )
            .expect("record must succeed");

        let view = store.view();
        assert_eq!(view.devices.len(), 2);
        assert_eq!(view.updated_at, 1_000);
        for device in &view.devices {
            assert_eq!(device.observations.len(), 1, "one sighting, one observation");
            assert_eq!(device.first_seen, 1_000);
            assert_eq!(device.last_seen, 1_000);
            assert!(device.changes.is_empty(), "no history, no changes");
            assert_eq!(device.note, "");
        }
        assert!(dir.join(NOTEBOOK_FILE_NAME).exists(), "store file written");
        // No temp file may linger after an atomic write.
        assert!(!dir.join(TEMP_FILE_NAME).exists());
    }

    #[test]
    fn identical_rescan_collapses_and_updates_last_seen() {
        let (store, _) = store("collapse");
        let report = report_with(vec![device_json("A", "1.0")]);
        store.record_report_at(&report, 1_000).unwrap();
        store.record_report_at(&report, 2_000).unwrap();
        store.record_report_at(&report, 3_000).unwrap();

        let view = store.view();
        let device = &view.devices[0];
        assert_eq!(
            device.observations.len(),
            1,
            "consecutive duplicates must collapse"
        );
        assert_eq!(device.first_seen, 1_000, "firstSeen is bookkeeping");
        assert_eq!(device.last_seen, 3_000, "lastSeen tracks every sighting");
        assert_eq!(view.updated_at, 3_000);
        assert!(device.changes.is_empty());
    }

    #[test]
    fn changed_fields_append_observations_and_derive_changes() {
        let (store, _) = store("changes");
        store
            .record_report_at(&report_with(vec![device_json("A", "14.0.1")]), 1_000)
            .unwrap();
        let mut changed = device_json("A", "14.0.2");
        changed["provider"] = serde_json::json!("New provider");
        changed["windowsStatus"] = serde_json::json!("Error");
        changed["errorCode"] = serde_json::json!(10);
        store
            .record_report_at(&report_with(vec![changed.clone()]), 2_000)
            .unwrap();
        // An identical sighting afterwards collapses again.
        store
            .record_report_at(&report_with(vec![changed]), 3_000)
            .unwrap();

        let view = store.view();
        let device = &view.devices[0];
        assert_eq!(device.observations.len(), 2, "one change, one new observation");
        assert_eq!(device.first_seen, 1_000);
        assert_eq!(device.last_seen, 3_000);
        assert_eq!(device.current.version.as_deref(), Some("14.0.2"));
        assert_eq!(device.current.error_code, Some(10));

        let fields: Vec<&str> = device.changes.iter().map(|c| c.field.as_str()).collect();
        assert_eq!(
            fields,
            ["version", "provider", "windowsStatus", "errorCode"],
            "every changed field is derived, in a stable order"
        );
        let version = &device.changes[0];
        assert_eq!(version.at, 2_000);
        assert_eq!(version.from, serde_json::json!("14.0.1"));
        assert_eq!(version.to, serde_json::json!("14.0.2"));
    }

    #[test]
    fn observations_cap_at_100_keeping_the_newest() {
        let (store, _) = store("obs-cap");
        for index in 0..150u64 {
            store
                .record_report_at(
                    &report_with(vec![device_json("A", &format!("1.{index}"))]),
                    1_000 + index,
                )
                .unwrap();
        }
        let view = store.view();
        let device = &view.devices[0];
        assert_eq!(device.observations.len(), MAX_OBSERVATIONS_PER_DEVICE);
        assert_eq!(
            device.observations.first().unwrap().version.as_deref(),
            Some("1.50"),
            "the oldest observations are dropped first"
        );
        assert_eq!(
            device.observations.last().unwrap().version.as_deref(),
            Some("1.149")
        );
        // The retained window still derives changes from consecutive pairs.
        assert_eq!(
            device.changes.len(),
            MAX_OBSERVATIONS_PER_DEVICE - 1,
            "each retained consecutive pair changed the version"
        );
    }

    // -- device cap / eviction ----------------------------------------------

    #[test]
    fn device_cap_evicts_the_least_recently_seen() {
        let (store, _) = store("evict");
        let old: Vec<Value> = (0..MAX_NOTEBOOK_DEVICES)
            .map(|index| device_json(&format!("k{index:03}"), "1.0"))
            .collect();
        store
            .record_report_at(&report_with(old), 1_000)
            .expect("first batch");

        // A later scan with a new device pushes the store over the cap: the
        // new device is the most recently seen; the oldest batch loses one.
        store
            .record_report_at(&report_with(vec![device_json("knew", "1.0")]), 2_000)
            .expect("second batch");

        let view = store.view();
        assert_eq!(view.devices.len(), MAX_NOTEBOOK_DEVICES);
        let keys: Vec<&str> = view.devices.iter().map(|d| d.key.as_str()).collect();
        assert!(keys.contains(&"knew"), "the newest device survives");
        assert!(
            !keys.contains(&"k000"),
            "an oldest-batch device is evicted (ties break by key)"
        );
        assert!(keys.contains(&"k499"), "only exactly enough is evicted");
    }

    #[test]
    fn a_reseen_device_is_not_evicted() {
        let (store, _) = store("evict-recent");
        let old: Vec<Value> = (0..MAX_NOTEBOOK_DEVICES)
            .map(|index| device_json(&format!("k{index:03}"), "1.0"))
            .collect();
        store.record_report_at(&report_with(old), 1_000).unwrap();

        // Re-see k000 later, then add a new device: k000 must survive.
        store
            .record_report_at(&report_with(vec![device_json("k000", "1.0")]), 1_500)
            .unwrap();
        store
            .record_report_at(&report_with(vec![device_json("knew", "1.0")]), 2_000)
            .unwrap();

        let view = store.view();
        assert_eq!(view.devices.len(), MAX_NOTEBOOK_DEVICES);
        let keys: Vec<&str> = view.devices.iter().map(|d| d.key.as_str()).collect();
        assert!(keys.contains(&"k000"), "the re-seen device survives");
        assert!(!keys.contains(&"k001"), "the next-least-recent is evicted");
    }

    // -- notes ---------------------------------------------------------------

    #[test]
    fn notes_persist_cap_and_reject_unknown_keys() {
        let (store, dir) = store("notes");
        store
            .record_report_at(&report_with(vec![device_json("A", "1.0")]), 1_000)
            .unwrap();

        store.save_note("A", "Hello notebook").expect("save");
        assert_eq!(store.view().devices[0].note, "Hello notebook");

        assert_eq!(
            store.save_note("missing", "x"),
            Err(NotebookError::UnknownKey)
        );
        let too_long = "x".repeat(MAX_NOTE_CHARS + 1);
        assert_eq!(
            store.save_note("A", &too_long),
            Err(NotebookError::NoteTooLong)
        );
        let exactly_max = "x".repeat(MAX_NOTE_CHARS);
        store
            .save_note("A", &exactly_max)
            .expect("the cap itself is allowed");

        // Persistence across a fresh store instance (app restart).
        let reloaded = NotebookStore::new(dir);
        assert_eq!(reloaded.view().devices[0].note, exactly_max);
    }

    // -- atomic write / restart / corruption ---------------------------------

    #[test]
    fn atomic_write_survives_restart_and_leaves_no_temp_file() {
        let (store, dir) = store("atomic");
        store
            .record_report_at(&report_with(vec![device_json("A", "1.0")]), 1_000)
            .unwrap();

        let entries: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![NOTEBOOK_FILE_NAME.to_owned()]);

        let text = std::fs::read_to_string(dir.join(NOTEBOOK_FILE_NAME)).unwrap();
        let parsed: Notebook = serde_json::from_str(&text).expect("valid store JSON");
        assert_eq!(parsed.version, NOTEBOOK_SCHEMA_VERSION);
        assert_eq!(parsed.devices.len(), 1);

        let reloaded = NotebookStore::new(dir);
        let view = reloaded.view();
        assert_eq!(view.devices.len(), 1);
        assert_eq!(view.devices[0].key, "A");
    }

    #[test]
    fn corrupt_or_foreign_store_reads_as_empty_and_is_replaced_on_write() {
        let (store, dir) = store("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(NOTEBOOK_FILE_NAME), b"{ not json at all").unwrap();
        assert!(store.view().devices.is_empty(), "corrupt reads as empty");

        store
            .record_report_at(&report_with(vec![device_json("A", "1.0")]), 1_000)
            .expect("a write replaces the corrupt store");
        assert_eq!(store.view().devices.len(), 1);

        // A foreign schema version is not interpreted.
        let foreign = NotebookStore::new(scratch_dir("notebook-foreign"));
        let foreign_dir = foreign.dir.clone();
        std::fs::create_dir_all(&foreign_dir).unwrap();
        std::fs::write(
            foreign_dir.join(NOTEBOOK_FILE_NAME),
            br#"{"version": 99, "updatedAt": 5, "devices": {}}"#,
        )
        .unwrap();
        assert!(foreign.view().devices.is_empty());
    }

    #[test]
    fn store_failures_are_reported_and_never_panic() {
        // 1) The store directory path is an existing FILE: every write fails,
        // reads stay empty, nothing panics.
        let scratch = scratch_dir("notebook-broken");
        let blocked = scratch.join("not-a-directory");
        std::fs::write(&blocked, b"file").unwrap();
        let blocked_store = NotebookStore::new(blocked);

        assert_eq!(
            blocked_store.record_report(&report_with(vec![device_json("A", "1.0")])),
            Err(NotebookError::Io)
        );
        assert!(blocked_store.view().devices.is_empty());
        // With no loadable store there is no known key, so the refusal is the
        // unknown-key business error (the write path is never reached).
        assert_eq!(
            blocked_store.save_note("A", "x"),
            Err(NotebookError::UnknownKey)
        );

        // 2) A known key whose write fails mid-session: the store loads (from
        // cache), the write is refused with io, and the cache is not advanced.
        let (good, dir) = store("notebook-write-fail");
        good.record_report_at(&report_with(vec![device_json("A", "1.0")]), 1_000)
            .expect("initial record");
        std::fs::remove_file(dir.join(NOTEBOOK_FILE_NAME)).unwrap();
        std::fs::remove_dir(&dir).unwrap();
        std::fs::write(&dir, b"file").unwrap();
        assert_eq!(good.save_note("A", "x"), Err(NotebookError::Io));
        // The failed save must not advance the cache: the last successful
        // write is still what the view reflects.
        let view = good.view();
        assert_eq!(view.devices.len(), 1);
        assert_eq!(view.devices[0].note, "");
    }

    #[test]
    fn clear_removes_the_store_file_and_resets() {
        let (store, dir) = store("clear");
        store
            .record_report_at(&report_with(vec![device_json("A", "1.0")]), 1_000)
            .unwrap();
        store.save_note("A", "note").unwrap();
        assert!(dir.join(NOTEBOOK_FILE_NAME).exists());

        store.clear().expect("clear succeeds");
        assert!(!dir.join(NOTEBOOK_FILE_NAME).exists());
        assert!(store.view().devices.is_empty());
        assert_eq!(store.save_note("A", "x"), Err(NotebookError::UnknownKey));
        // Idempotent: clearing again is not an error.
        store.clear().expect("second clear succeeds");
    }

    // -- view shape / ordering ------------------------------------------------

    #[test]
    fn view_is_ordered_most_recently_seen_first() {
        let (store, _) = store("order");
        store
            .record_report_at(&report_with(vec![device_json("OLD", "1.0")]), 1_000)
            .unwrap();
        store
            .record_report_at(&report_with(vec![device_json("NEW", "1.0")]), 2_000)
            .unwrap();

        let view = store.view();
        let keys: Vec<&str> = view
            .devices
            .iter()
            .map(|device| device.key.as_str())
            .collect();
        assert_eq!(keys, ["NEW", "OLD"]);
    }

    #[test]
    fn missing_optional_fields_are_tolerated_and_unknown_fields_ignored() {
        let (store, _) = store("tolerant");
        store
            .record_report_at(
                &report_with(vec![serde_json::json!({
                    "id": "BARE",
                    "name": "Bare device",
                    "status": "observed",
                    "unknownFutureField": {"nested": true}
                })]),
                1_000,
            )
            .unwrap();

        let device = &store.view().devices[0];
        assert_eq!(device.key, "BARE");
        assert_eq!(device.vid, None);
        assert_eq!(device.current.version, None);
        assert_eq!(device.current.error_code, None);
        assert_eq!(device.observations.len(), 1);
    }

    #[test]
    fn error_mapping_is_static_and_codes_serialize_as_contract_strings() {
        let unknown = ScanError::from(NotebookError::UnknownKey);
        assert_eq!(unknown.code, ScanErrorCode::UnknownKey);
        assert_eq!(unknown.code.as_str(), "unknown_key");
        assert_eq!(
            serde_json::to_string(&unknown.code).unwrap(),
            "\"unknown_key\""
        );
        assert_eq!(
            unknown.message,
            "No device with that key exists in the notebook."
        );

        let too_long = ScanError::from(NotebookError::NoteTooLong);
        assert_eq!(too_long.code.as_str(), "note_too_long");
        assert_eq!(
            too_long.message,
            "The note exceeds the 4000 character limit."
        );

        let io = ScanError::from(NotebookError::Io);
        assert_eq!(io.code, ScanErrorCode::Io);
        assert_eq!(io.message, "The notebook store could not be written.");

        // The success payload serializes exactly as the contract promises.
        let ok = serde_json::to_value(OkResponse { ok: true }).unwrap();
        assert_eq!(ok, serde_json::json!({ "ok": true }));
    }
}
