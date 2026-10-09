//! DriverLens shared report contract (schemaVersion 1) — Rust mirror of
//! `desktop/src/contracts/report.ts` and `desktop/src/contracts/validate-report.ts`.
//!
//! Tolerance decisions (kept in sync with the TypeScript contract):
//! - Required at report level: schemaVersion == 1 and a `devices` array.
//!   Hard caps mirror the browser edition: 20000 devices, 20 MiB serialized.
//! - Required per device: id and name (strings) plus status (closed enum).
//! - Every other field is optional evidence: absent means "unknown" and is
//!   tolerated; a present field must match its declared type or validation
//!   fails. Unknown/extra fields are tolerated and passed through.
//! - `signed` is a tri-state via Option<bool>: Some(true) signed, Some(false)
//!   unsigned, None unknown. JSON null and absence both map to None; None is
//!   NEVER coerced to Some(false).
//! - JSON null vs absence is merged to None in Rust (TS keeps them distinct);
//!   both mean "unknown" everywhere the UI reads them.
//! - Strings are opaque data: never evaluated, never followed as paths.
//! - The serialized-size cap is measured in UTF-8 bytes (serde_json output),
//!   matching the TypeScript side which measures UTF-8 bytes via TextEncoder.
//! - `invalid_json` only exists on the text helper; TS callers surface
//!   JSON.parse errors outside the pure validator, so it is not a TS code.
//!
//! # Wiring
//!
//! Wired into the IPC layer through `scan.rs`: `validate_report_value`
//! guards every accepted scan (`perform_scan`) and import (`open_report`),
//! and the stored value it validates is what `get_report` / `export_report`
//! serve. The text helper `validate_report_str` mirrors the TS entry point
//! for the test suites (production IPC parses bytes itself) and carries the
//! module's single targeted `allow(dead_code)`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Report schema version this contract describes.
pub const REPORT_SCHEMA_VERSION: u64 = 1;

/// Hard cap on device records, mirroring the browser edition (app.js validate()).
pub const MAX_DEVICES: usize = 20_000;

/// Hard cap on the serialized report size (20 MiB), mirroring the browser
/// import guard (app.js:10).
pub const MAX_REPORT_BYTES: usize = 20 * 1024 * 1024;

/// Evidence status for a device — closed set. Unknown evidence stays distinct:
/// it is represented by absent evidence fields, never by a third status value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus {
    /// The scan completed and raised no review notes.
    Observed,
    /// At least one review note applies (see `notes`).
    Review,
}

/// Machine-level summary written by the collector (Collect-DriverLens.ps1:133).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// OS caption (display fallback: 'Unknown OS').
    pub os: String,
    /// OS build number string. Collected but not displayed by the browser edition.
    pub build: String,
    /// Normalized OS architecture ('ARM64' | 'x64' | 'x86' | other raw string).
    pub architecture: String,
}

/// One device record — every field the PowerShell collector emits
/// (Collect-DriverLens.ps1:108-127). `id`, `name` and `status` are required;
/// every other field is optional evidence (absent = unknown, tolerated).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// Opaque displayable digest (SHA-256 prefix); NOT the raw Windows instance ID.
    pub id: String,
    /// Human-readable device name.
    pub name: String,
    /// 'observed' | 'review'. Unknown evidence is never a third value.
    pub status: DeviceStatus,
    /// PNPClass, e.g. "USB".
    pub device_class: Option<String>,
    /// Manufacturer string; the fictional synthetic fixture omits it.
    pub manufacturer: Option<String>,
    /// First '\'-segment of the instance ID, e.g. "USB".
    pub bus: Option<String>,
    /// 4-hex uppercase vendor ID, or None when the instance ID carries none.
    pub vid: Option<String>,
    /// 4-hex uppercase product ID, or None when the instance ID carries none.
    pub pid: Option<String>,
    /// Windows device status string (CIM Status), e.g. "OK".
    pub windows_status: Option<String>,
    /// Win32 ConfigManagerErrorCode; 0 is a real value and must render as 0.
    pub error_code: Option<f64>,
    /// Driver provider name or "" when no signed-driver record was found.
    pub provider: Option<String>,
    /// Driver version or "".
    pub version: Option<String>,
    /// Signature evidence, tri-state: Some(true) signed, Some(false) unsigned,
    /// None unknown. None must never be coerced to Some(false).
    pub signed: Option<bool>,
    /// INF file name only (no path) or "". Inert display data; never opened.
    pub inf: Option<String>,
    /// Architecture declarations found in the INF text, or []. Declaration
    /// evidence — NOT proof of the loaded kernel binary's architecture; kept
    /// distinct from `kernel_binary` / `architecture`.
    pub package_targets: Option<Vec<String>>,
    /// Kernel service name or "".
    pub service: Option<String>,
    /// PE file name of the kernel binary (no path) or "". Never opened.
    pub kernel_binary: Option<String>,
    /// PE machine of the kernel binary (open set of strings).
    pub architecture: Option<String>,
    /// Review reasons, e.g. "Windows device error 10". Empty when none.
    pub notes: Option<Vec<String>>,
}

/// A schemaVersion 1 DriverLens report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Always 1 (the validator normalizes a numeric 1.0 to the integer 1).
    pub schema_version: u64,
    /// true = fictional sample data; None = unknown origin.
    pub sample: Option<bool>,
    /// ISO-8601 UTC timestamp string; opaque display data.
    pub generated_at: Option<String>,
    /// Machine summary; when present all three strings are required.
    pub system: Option<SystemInfo>,
    /// Fixed privacy statement emitted by the live collector.
    pub privacy: Option<String>,
    /// Collector warnings; absent or empty when none.
    pub warnings: Option<Vec<String>>,
    pub devices: Vec<Device>,
}

/// Stable failure codes mirroring the TypeScript ReportValidationCode union,
/// plus `invalid_json` for the text helper only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationCode {
    NotObject,
    SchemaVersion,
    DevicesMissing,
    DevicesNotArray,
    DevicesLimit,
    SizeLimit,
    DeviceNotObject,
    DeviceName,
    DeviceId,
    DeviceStatus,
    DeviceFieldType,
    FieldType,
    InvalidJson,
    UnexpectedError,
}

impl ValidationCode {
    /// The exact string used by the TypeScript contract for the same code.
    pub const fn as_str(self) -> &'static str {
        match self {
            ValidationCode::NotObject => "not_object",
            ValidationCode::SchemaVersion => "schema_version",
            ValidationCode::DevicesMissing => "devices_missing",
            ValidationCode::DevicesNotArray => "devices_not_array",
            ValidationCode::DevicesLimit => "devices_limit",
            ValidationCode::SizeLimit => "size_limit",
            ValidationCode::DeviceNotObject => "device_not_object",
            ValidationCode::DeviceName => "device_name",
            ValidationCode::DeviceId => "device_id",
            ValidationCode::DeviceStatus => "device_status",
            ValidationCode::DeviceFieldType => "device_field_type",
            ValidationCode::FieldType => "field_type",
            ValidationCode::InvalidJson => "invalid_json",
            ValidationCode::UnexpectedError => "unexpected_error",
        }
    }
}

/// Validation failure mirroring the TS `{ ok: false, code, message }` branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportError {
    pub code: ValidationCode,
    pub message: String,
}

impl std::fmt::Display for ReportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ReportError {}

fn err(code: ValidationCode, message: impl Into<String>) -> ReportError {
    ReportError {
        code,
        message: message.into(),
    }
}

/// Device fields that are strings when present (absent = unknown, tolerated).
const STRING_DEVICE_FIELDS: [&str; 10] = [
    "deviceClass",
    "manufacturer",
    "bus",
    "windowsStatus",
    "provider",
    "version",
    "inf",
    "service",
    "kernelBinary",
    "architecture",
];

/// First present-but-wrong-typed device field, or None when all present fields
/// match their declared types. Mirrors `invalidDeviceField()` in
/// validate-report.ts.
fn invalid_device_field(record: &Map<String, Value>) -> Option<String> {
    for field in STRING_DEVICE_FIELDS {
        match record.get(field) {
            None | Some(Value::String(_)) => {}
            Some(_) => return Some(field.to_owned()),
        }
    }
    for field in ["vid", "pid"] {
        match record.get(field) {
            None | Some(Value::Null) | Some(Value::String(_)) => {}
            Some(_) => return Some(field.to_owned()),
        }
    }
    match record.get("errorCode") {
        None | Some(Value::Null) | Some(Value::Number(_)) => {}
        Some(_) => return Some("errorCode".to_owned()),
    }
    match record.get("signed") {
        None | Some(Value::Null) | Some(Value::Bool(_)) => {}
        Some(_) => return Some("signed".to_owned()),
    }
    for field in ["packageTargets", "notes"] {
        match record.get(field) {
            None => {}
            Some(Value::Array(items)) if items.iter().all(Value::is_string) => {}
            Some(_) => return Some(field.to_owned()),
        }
    }
    None
}

/// Same for report-level optional fields. `system`, when present, must carry
/// all three string fields (absence is tolerated; see the module docs).
fn invalid_top_level_field(object: &Map<String, Value>) -> Option<String> {
    match object.get("sample") {
        None | Some(Value::Bool(_)) => {}
        Some(_) => return Some("sample".to_owned()),
    }
    match object.get("generatedAt") {
        None | Some(Value::String(_)) => {}
        Some(_) => return Some("generatedAt".to_owned()),
    }
    match object.get("privacy") {
        None | Some(Value::String(_)) => {}
        Some(_) => return Some("privacy".to_owned()),
    }
    match object.get("warnings") {
        None => {}
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => {}
        Some(_) => return Some("warnings".to_owned()),
    }
    if let Some(system) = object.get("system") {
        let Some(map) = system.as_object() else {
            return Some("system".to_owned());
        };
        for field in ["os", "build", "architecture"] {
            if !map.get(field).is_some_and(Value::is_string) {
                return Some(format!("system.{field}"));
            }
        }
    }
    None
}

/// Validate a parsed JSON value. Mirrors `validateReport()` in
/// `desktop/src/contracts/validate-report.ts`; never panics on any input.
/// Extra/unknown fields are tolerated during the checks and dropped by the
/// final typed deserialization (nothing behind this contract reads them).
pub fn validate_report_value(value: &Value) -> Result<Report, ReportError> {
    let object = value.as_object().ok_or_else(|| {
        err(
            ValidationCode::NotObject,
            "Expected a DriverLens schemaVersion 1 report object.",
        )
    })?;

    // JS numbers have no int/float split (1.0 === 1); accept numeric 1 either
    // way. The deserialization step below normalizes to the integer 1.
    let version_ok = object
        .get("schemaVersion")
        .and_then(Value::as_number)
        .is_some_and(|number| {
            number.as_u64() == Some(REPORT_SCHEMA_VERSION)
                || number.as_f64() == Some(REPORT_SCHEMA_VERSION as f64)
        });
    if !version_ok {
        return Err(err(
            ValidationCode::SchemaVersion,
            "Expected a DriverLens schemaVersion 1 report with a devices array.",
        ));
    }

    let devices = match object.get("devices") {
        None => {
            return Err(err(
                ValidationCode::DevicesMissing,
                "Expected a DriverLens schemaVersion 1 report with a devices array.",
            ))
        }
        Some(devices) => devices.as_array().ok_or_else(|| {
            err(
                ValidationCode::DevicesNotArray,
                "Expected a DriverLens schemaVersion 1 report with a devices array.",
            )
        })?,
    };
    if devices.len() > MAX_DEVICES {
        return Err(err(
            ValidationCode::DevicesLimit,
            format!(
                "Report contains {} devices; the limit is {}.",
                devices.len(),
                MAX_DEVICES
            ),
        ));
    }

    for (index, device) in devices.iter().enumerate() {
        let record = device.as_object().ok_or_else(|| {
            err(
                ValidationCode::DeviceNotObject,
                format!("Report contains an invalid device record at index {index}."),
            )
        })?;
        if !record.get("name").is_some_and(Value::is_string) {
            return Err(err(
                ValidationCode::DeviceName,
                format!("Device record at index {index} is missing a string name."),
            ));
        }
        if !record.get("id").is_some_and(Value::is_string) {
            return Err(err(
                ValidationCode::DeviceId,
                format!("Device record at index {index} is missing a string id."),
            ));
        }
        match record.get("status").and_then(Value::as_str) {
            Some("observed") | Some("review") => {}
            _ => {
                return Err(err(
                    ValidationCode::DeviceStatus,
                    format!("Device record at index {index} has an unknown status."),
                ))
            }
        }
        if let Some(field) = invalid_device_field(record) {
            return Err(err(
                ValidationCode::DeviceFieldType,
                format!("Device record at index {index} has an invalid field: {field}."),
            ));
        }
    }

    if let Some(field) = invalid_top_level_field(object) {
        return Err(err(
            ValidationCode::FieldType,
            format!("Report field has an invalid type: {field}."),
        ));
    }

    // Serialized-size cap in UTF-8 bytes — mirrors the TS side's TextEncoder
    // measurement and the browser import guard (20 MB, app.js:10).
    let serialized = serde_json::to_string(value).map_err(|_| {
        err(
            ValidationCode::UnexpectedError,
            "Report could not be validated.",
        )
    })?;
    if serialized.len() > MAX_REPORT_BYTES {
        return Err(err(
            ValidationCode::SizeLimit,
            "Report exceeds the 20 MB limit.",
        ));
    }

    let mut owned = value.clone();
    if owned.get("schemaVersion").and_then(Value::as_u64) != Some(REPORT_SCHEMA_VERSION) {
        if let Some(map) = owned.as_object_mut() {
            map.insert("schemaVersion".to_owned(), Value::Number(1.into()));
        }
    }
    serde_json::from_value::<Report>(owned).map_err(|_| {
        err(
            ValidationCode::UnexpectedError,
            "Report could not be validated.",
        )
    })
}

/// Parse report text and validate it. `invalid_json` reports a parse failure;
/// the pure value validator never sees it.
///
/// Test-only caller surface: production IPC parses bytes and calls
/// [`validate_report_value`] directly; this helper mirrors the TS text entry
/// point for the test suites.
#[allow(dead_code)] // test-only helper: mirrors the TS text entry point for the test suites
pub fn validate_report_str(text: &str) -> Result<Report, ReportError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| err(ValidationCode::InvalidJson, "Report is not valid JSON."))?;
    validate_report_value(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = include_str!("../fixtures/sample.json");
    const SYNTHETIC: &str = include_str!("../fixtures/synthetic-report.json");
    const INVALID_SCHEMA_VERSION: &str = include_str!("../fixtures/invalid-schema-version.json");
    const INVALID_DEVICES_MISSING: &str = include_str!("../fixtures/invalid-devices-missing.json");
    const INVALID_DEVICES_NOT_ARRAY: &str = include_str!("../fixtures/invalid-devices-not-array.json");
    const INVALID_DEVICE_STATUS: &str = include_str!("../fixtures/invalid-device-status.json");
    const INVALID_DEVICE_NAME: &str = include_str!("../fixtures/invalid-device-name.json");
    const INVALID_NOT_JSON: &str = include_str!("../fixtures/invalid-not-json.txt");

    fn fail(value: &Value) -> ReportError {
        validate_report_value(value).expect_err("expected validation to fail")
    }

    fn ok(value: Value) -> Report {
        validate_report_value(&value).expect("expected a valid report")
    }

    #[test]
    fn fixture_reports_validate_ok() {
        let sample = validate_report_str(SAMPLE).expect("sample.json must validate");
        assert_eq!(sample.schema_version, 1);
        assert_eq!(sample.sample, Some(true));
        assert_eq!(sample.devices.len(), 3);
        assert_eq!(sample.devices[2].name, "Example system component");

        let synthetic = validate_report_str(SYNTHETIC).expect("synthetic fixture must validate");
        assert_eq!(synthetic.devices.len(), 2);
        assert_eq!(
            synthetic.devices[0].name,
            "Contoso USB Serial Adapter (synthetic)"
        );
    }

    #[test]
    fn fixture_field_passthrough() {
        let sample = validate_report_str(SAMPLE).expect("sample.json must validate");
        let third = &sample.devices[2];
        assert_eq!(third.architecture.as_deref(), Some("Unknown"));
        assert_eq!(third.vid, None);
        assert_eq!(third.pid, None);
        assert_eq!(third.manufacturer, None);
        assert_eq!(third.inf, None);
        assert_eq!(third.service, None);
        assert_eq!(third.package_targets, Some(Vec::new()));
    }

    #[test]
    fn signed_is_a_tri_state_and_null_never_becomes_false() {
        let value = json!({
            "schemaVersion": 1,
            "devices": [
                { "id": "a", "name": "absent", "status": "observed" },
                { "id": "b", "name": "null", "status": "observed", "signed": null },
                { "id": "c", "name": "false", "status": "observed", "signed": false },
                { "id": "d", "name": "true", "status": "observed", "signed": true }
            ]
        });
        let report = ok(value);
        assert_eq!(report.devices[0].signed, None);
        assert_ne!(report.devices[0].signed, Some(false)); // unknown is NOT unsigned
        assert_eq!(report.devices[1].signed, None);
        assert_ne!(report.devices[1].signed, Some(false));
        assert_eq!(report.devices[2].signed, Some(false));
        assert_eq!(report.devices[3].signed, Some(true));
    }

    #[test]
    fn schema_version_must_be_one() {
        for bad in [json!(2), json!("1"), json!(null)] {
            let value = json!({ "schemaVersion": bad, "devices": [] });
            assert_eq!(fail(&value).code, ValidationCode::SchemaVersion);
        }
        let absent = json!({ "devices": [] });
        assert_eq!(fail(&absent).code, ValidationCode::SchemaVersion);
    }

    #[test]
    fn schema_version_one_point_zero_mirrors_js_number_semantics() {
        // JS numbers have no int/float distinction: 1.0 === 1, so the Rust
        // mirror accepts a numeric 1.0 and normalizes it to the integer 1.
        let report = validate_report_str(r#"{"schemaVersion": 1.0, "devices": []}"#)
            .expect("schemaVersion 1.0 must mirror JS 1");
        assert_eq!(report.schema_version, 1);
    }

    #[test]
    fn devices_missing_and_not_array() {
        let missing = json!({ "schemaVersion": 1 });
        assert_eq!(fail(&missing).code, ValidationCode::DevicesMissing);

        for bad in [json!({}), json!("devices"), json!(null)] {
            let value = json!({ "schemaVersion": 1, "devices": bad });
            assert_eq!(fail(&value).code, ValidationCode::DevicesNotArray);
        }
    }

    #[test]
    fn device_count_limit() {
        let devices: Vec<Value> = (0..MAX_DEVICES + 1)
            .map(|index| {
                json!({ "id": format!("d{index}"), "name": format!("n{index}"), "status": "observed" })
            })
            .collect();
        let value = json!({ "schemaVersion": 1, "devices": devices });
        assert_eq!(fail(&value).code, ValidationCode::DevicesLimit);
    }

    #[test]
    fn serialized_size_limit() {
        let padding = "x".repeat(MAX_REPORT_BYTES + 1);
        let value = json!({ "schemaVersion": 1, "devices": [], "padding": padding });
        assert_eq!(fail(&value).code, ValidationCode::SizeLimit);
    }

    #[test]
    fn device_record_shape_checks() {
        let not_object = json!({ "schemaVersion": 1, "devices": [null] });
        assert_eq!(fail(&not_object).code, ValidationCode::DeviceNotObject);

        let no_name = json!({ "schemaVersion": 1, "devices": [{ "id": "d", "status": "observed" }] });
        assert_eq!(fail(&no_name).code, ValidationCode::DeviceName);

        let non_string_name = json!({ "schemaVersion": 1, "devices": [{ "id": "d", "name": 42, "status": "observed" }] });
        assert_eq!(fail(&non_string_name).code, ValidationCode::DeviceName);

        let no_id = json!({ "schemaVersion": 1, "devices": [{ "name": "n", "status": "observed" }] });
        assert_eq!(fail(&no_id).code, ValidationCode::DeviceId);

        let bad_status = json!({ "schemaVersion": 1, "devices": [{ "id": "d", "name": "n", "status": "pending" }] });
        assert_eq!(fail(&bad_status).code, ValidationCode::DeviceStatus);

        let missing_status = json!({ "schemaVersion": 1, "devices": [{ "id": "d", "name": "n" }] });
        assert_eq!(fail(&missing_status).code, ValidationCode::DeviceStatus);
    }

    #[test]
    fn device_field_type_checks() {
        let cases = [
            json!([{ "id": "d", "name": "n", "status": "observed", "packageTargets": "ARM64" }]),
            json!([{ "id": "d", "name": "n", "status": "observed", "notes": [1] }]),
            json!([{ "id": "d", "name": "n", "status": "observed", "signed": "true" }]),
            json!([{ "id": "d", "name": "n", "status": "observed", "vid": 123 }]),
            json!([{ "id": "d", "name": "n", "status": "observed", "errorCode": "0" }]),
            json!([{ "id": "d", "name": "n", "status": "observed", "manufacturer": 12 }]),
            json!([{ "id": "d", "name": "n", "status": "observed", "architecture": ["ARM64"] }]),
        ];
        for devices in cases {
            let value = json!({ "schemaVersion": 1, "devices": devices });
            assert_eq!(fail(&value).code, ValidationCode::DeviceFieldType);
        }
    }

    #[test]
    fn top_level_field_type_checks() {
        let cases = [
            json!({ "sample": "yes" }),
            json!({ "generatedAt": 5 }),
            json!({ "warnings": "oops" }),
            json!({ "warnings": [1] }),
            json!({ "privacy": {} }),
            json!({ "system": [] }),
            json!({ "system": { "os": "Windows", "build": "22631" } }),
        ];
        for extra in cases {
            let mut value = json!({ "schemaVersion": 1, "devices": [] });
            if let Value::Object(map) = extra {
                for (key, val) in map {
                    value.as_object_mut().expect("root is an object").insert(key, val);
                }
            }
            assert_eq!(fail(&value).code, ValidationCode::FieldType);
        }
    }

    #[test]
    fn missing_optional_evidence_is_tolerated() {
        let value = json!({ "schemaVersion": 1, "devices": [{ "id": "d", "name": "n", "status": "observed" }] });
        let report = ok(value);
        assert_eq!(report.devices[0].manufacturer, None);
        assert_eq!(report.devices[0].signed, None);
    }

    #[test]
    fn malicious_text_is_inert_and_preserved() {
        let name = "<script>alert('pwned')</script> & <img src=x onerror=alert(1)>";
        let inf = "..\\..\\..\\Windows\\INF\\evil.inf";
        let kernel_binary = "C:\\Windows\\System32\\drivers\\evil.sys";
        let value = json!({
            "schemaVersion": 1,
            "devices": [{
                "id": "\"; globalThis.__pwned=1; //",
                "name": name,
                "status": "observed",
                "inf": inf,
                "kernelBinary": kernel_binary
            }]
        });
        let report = ok(value);
        assert_eq!(report.devices[0].name, name);
        assert_eq!(report.devices[0].inf.as_deref(), Some(inf));
        assert_eq!(report.devices[0].kernel_binary.as_deref(), Some(kernel_binary));
    }

    #[test]
    fn package_targets_stay_distinct_from_kernel_binary_evidence() {
        let value = json!({
            "schemaVersion": 1,
            "devices": [{
                "id": "d",
                "name": "n",
                "status": "observed",
                "packageTargets": ["ARM64", "x64"],
                "kernelBinary": "legacy.sys",
                "architecture": "x86"
            }]
        });
        let report = ok(value);
        let device = &report.devices[0];
        assert_eq!(
            device.package_targets,
            Some(vec!["ARM64".to_string(), "x64".to_string()])
        );
        assert_eq!(device.kernel_binary.as_deref(), Some("legacy.sys"));
        assert_eq!(device.architecture.as_deref(), Some("x86"));
    }

    #[test]
    fn non_object_roots_are_rejected() {
        for value in [Value::Null, json!([1, 2]), json!(3), json!("report"), json!(true)] {
            assert_eq!(fail(&value).code, ValidationCode::NotObject);
        }
    }

    #[test]
    fn malformed_fixture_files_fail_with_specific_codes() {
        assert_eq!(
            validate_report_str(INVALID_SCHEMA_VERSION).expect_err("must fail").code,
            ValidationCode::SchemaVersion
        );
        assert_eq!(
            validate_report_str(INVALID_DEVICES_MISSING).expect_err("must fail").code,
            ValidationCode::DevicesMissing
        );
        assert_eq!(
            validate_report_str(INVALID_DEVICES_NOT_ARRAY).expect_err("must fail").code,
            ValidationCode::DevicesNotArray
        );
        assert_eq!(
            validate_report_str(INVALID_DEVICE_STATUS).expect_err("must fail").code,
            ValidationCode::DeviceStatus
        );
        assert_eq!(
            validate_report_str(INVALID_DEVICE_NAME).expect_err("must fail").code,
            ValidationCode::DeviceName
        );
        assert_eq!(
            validate_report_str(INVALID_NOT_JSON).expect_err("must fail").code,
            ValidationCode::InvalidJson
        );
    }

    #[test]
    fn codes_match_the_typescript_contract() {
        assert_eq!(ValidationCode::NotObject.as_str(), "not_object");
        assert_eq!(ValidationCode::SchemaVersion.as_str(), "schema_version");
        assert_eq!(ValidationCode::DevicesMissing.as_str(), "devices_missing");
        assert_eq!(ValidationCode::DevicesNotArray.as_str(), "devices_not_array");
        assert_eq!(ValidationCode::DevicesLimit.as_str(), "devices_limit");
        assert_eq!(ValidationCode::SizeLimit.as_str(), "size_limit");
        assert_eq!(ValidationCode::DeviceNotObject.as_str(), "device_not_object");
        assert_eq!(ValidationCode::DeviceName.as_str(), "device_name");
        assert_eq!(ValidationCode::DeviceId.as_str(), "device_id");
        assert_eq!(ValidationCode::DeviceStatus.as_str(), "device_status");
        assert_eq!(ValidationCode::DeviceFieldType.as_str(), "device_field_type");
        assert_eq!(ValidationCode::FieldType.as_str(), "field_type");
        assert_eq!(ValidationCode::InvalidJson.as_str(), "invalid_json");
        assert_eq!(ValidationCode::UnexpectedError.as_str(), "unexpected_error");
    }
}
