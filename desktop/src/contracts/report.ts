/**
 * DriverLens shared report contract — schemaVersion 1.
 *
 * Mirrors the report emitted by Collect-DriverLens.ps1 (see
 * notes/COLLECTOR-CONTRACT-NOTES.md §2) and accepted by the browser edition
 * (app.js validate(), app.js:4). This file is the TypeScript source of truth
 * for the report shape; the Rust mirror lives in desktop/src-tauri/src/report.rs.
 *
 * Tolerance decisions (kept in sync with validate-report.ts and report.rs):
 * - Required at report level: schemaVersion === 1 and a `devices` array.
 *   Hard caps mirror app.js: 20000 devices and 20 MiB serialized.
 * - Required per device: id and name (strings) plus status (closed enum) —
 *   exactly the fields the browser validator hard-requires (app.js:4).
 * - Every other field is optional evidence. Absence means "unknown" and is
 *   tolerated (both fixtures omit fields on some devices, e.g. manufacturer;
 *   sample.json device 3 omits vid/pid/inf/service); a present field must
 *   match its declared type or validation fails.
 * - Unknown/extra fields are tolerated and passed through unchanged (forward
 *   compatibility within schemaVersion 1).
 * - All strings are opaque data. Nothing behind this contract evaluates them,
 *   renders them as HTML, or follows them as filesystem paths.
 */

/** Report schema version this contract describes. */
export const REPORT_SCHEMA_VERSION = 1;

/** Hard cap on device records, mirroring the browser edition (app.js validate()). */
export const MAX_DEVICES = 20_000;

/**
 * Hard cap on the serialized report size (20 MiB), mirroring the browser
 * import guard (app.js:10). Measured as UTF-8 bytes of the serialized JSON.
 */
export const MAX_REPORT_BYTES = 20 * 1024 * 1024;

/**
 * Evidence status for a device — closed set:
 * - `observed`: the scan completed and raised no review notes.
 * - `review`: at least one review note applies (see `notes`).
 *
 * Unknown evidence stays distinct: it is represented by absent evidence
 * fields, never by a third status value.
 */
export type DeviceStatus = "observed" | "review";

/** Machine-level summary written by the collector (Collect-DriverLens.ps1:133). */
export interface SystemInfo {
  /** OS caption, e.g. "Microsoft Windows 11 Pro" (display fallback: 'Unknown OS'). */
  os: string;
  /** OS build number string. Collected but not displayed by the browser edition. */
  build: string;
  /** Normalized OS architecture ('ARM64' | 'x64' | 'x86' | other raw string). */
  architecture: string;
}

/**
 * One device record — every field the PowerShell collector emits, in its
 * emission order (Collect-DriverLens.ps1:108-127).
 *
 * `id`, `name` and `status` are required (browser parity). Every other field
 * is optional evidence: absent means unknown and is tolerated; a present field
 * is type-checked by validateReport().
 */
export interface Device {
  /**
   * Opaque displayable digest: SHA-256 of the uppercased device instance ID,
   * first 16 hex characters (Collect-DriverLens.ps1:47-52). It is NOT the raw
   * Windows instance ID and must never be used as one.
   */
  id: string;
  /** Human-readable device name. */
  name: string;
  /** 'observed' | 'review'. Unknown evidence is never a third value. */
  status: DeviceStatus;
  /** PNPClass, e.g. "USB". */
  deviceClass?: string;
  /**
   * Manufacturer string. Optional because the fictional synthetic fixture
   * omits it; live collector reports always include it.
   */
  manufacturer?: string;
  /** First '\'-segment of the instance ID, e.g. "USB". */
  bus?: string;
  /** 4-hex uppercase vendor ID, or null when the instance ID carries none. */
  vid?: string | null;
  /** 4-hex uppercase product ID, or null when the instance ID carries none. */
  pid?: string | null;
  /** Windows device status string (CIM Status), e.g. "OK". */
  windowsStatus?: string;
  /** Win32 ConfigManagerErrorCode; 0 is a real value and must render as 0 (app.js:7 uses ??). */
  errorCode?: number | null;
  /** Driver provider name or '' when no signed-driver record was found. */
  provider?: string;
  /** Driver version or ''. */
  version?: string;
  /**
   * Signature evidence, tri-state: true = signed, false = unsigned,
   * null/absent = unknown. NEVER coerce null/absent to false (app.js:7 labels
   * Signed | Unsigned | Unknown via strict === true / === false / else).
   */
  signed?: boolean | null;
  /** INF file name only (no path) or ''. Inert display data; never opened. */
  inf?: string;
  /**
   * Architecture declarations found by scanning the INF text (ARM64/x64/x86/
   * ARM32), or []. Declaration evidence — what the INF claims — and NOT proof
   * of the loaded kernel binary's architecture. Kept distinct from
   * `kernelBinary` and `architecture`, which are binary evidence.
   */
  packageTargets?: string[];
  /** Kernel service name or ''. */
  service?: string;
  /** PE file name of the kernel binary (no path) or ''. Inert display data; never opened. */
  kernelBinary?: string;
  /**
   * PE machine of the kernel binary: 'ARM64' | 'x64' | 'x86' | 'ARM64EC' |
   * 'ARM64X' | 'ARM32' | 'Unknown' | 'Not PE' | 'Unreadable' | 'Invalid PE' |
   * 'Unknown (0xXXXX)' (open set of strings).
   */
  architecture?: string;
  /** Review reasons, e.g. "Windows device error 10". Empty when none. */
  notes?: string[];
}

/** A schemaVersion 1 DriverLens report. */
export interface Report {
  schemaVersion: 1;
  /**
   * Optional top-level fields. The live collector and both fixtures always
   * emit sample/generatedAt/system/warnings, but the browser edition tolerates
   * absence (fallbacks at app.js:6-8), so this contract tolerates it too:
   * absent = unknown. When present, `system` must carry all three strings.
   */
  sample?: boolean;
  /** ISO-8601 UTC timestamp string; opaque display data. */
  generatedAt?: string;
  system?: SystemInfo;
  /**
   * Fixed privacy statement emitted by the live collector
   * (Collect-DriverLens.ps1:134); the synthetic fixture omits it.
   */
  privacy?: string;
  /** Collector warnings; absent or empty when none. */
  warnings?: string[];
  devices: Device[];
}

/** Stable failure codes returned by validateReport(). */
export type ReportValidationCode =
  | "not_object"
  | "schema_version"
  | "devices_missing"
  | "devices_not_array"
  | "devices_limit"
  | "size_limit"
  | "device_not_object"
  | "device_name"
  | "device_id"
  | "device_status"
  | "device_field_type"
  | "field_type"
  | "unexpected_error";

/**
 * Discriminated validation result. The validator is pure and stateless, so a
 * caller can keep a previously valid displayed report when an import fails:
 *
 *   const result = validateReport(parsed);
 *   if (result.ok) { show(result.report); } else { showError(result.message); }
 */
export type ReportValidationResult =
  | { ok: true; report: Report }
  | { ok: false; code: ReportValidationCode; message: string };
