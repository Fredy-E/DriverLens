/**
 * Pure validator for DriverLens schemaVersion 1 reports. See report.ts for the
 * contract and tolerance decisions.
 *
 * Guarantees:
 * - NEVER throws: every failure path returns { ok: false, code, message }; the
 *   body is additionally wrapped in a catch so even hostile inputs (throwing
 *   getters, Proxy traps, BigInt, circular graphs) produce a failure result.
 * - Pure and stateless (no module state): a caller that keeps the last valid
 *   report on screen simply ignores the failure result.
 * - No filesystem/network access. Any string inside the value (including
 *   path-shaped ones like INF names or kernelBinary) is inert display data:
 *   it is type-checked only, never evaluated, never resolved, never followed.
 * - The value is not mutated; strings pass through unchanged.
 *
 * Check order (deterministic; first failure wins):
 *   not_object -> schema_version -> devices_missing/not_array -> devices_limit
 *   -> per-device checks -> top-level field types -> size_limit (serialized).
 */
import {
  MAX_DEVICES,
  MAX_REPORT_BYTES,
  REPORT_SCHEMA_VERSION,
  type Report,
  type ReportValidationCode,
  type ReportValidationResult,
} from "./report";

function fail(code: ReportValidationCode, message: string): ReportValidationResult {
  return { ok: false, code, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const STRING_DEVICE_FIELDS = [
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
] as const;

/**
 * First device field that is present but has the wrong type, or null when all
 * present fields match their declared types. Absent (undefined) fields are
 * tolerated: absence means "unknown" evidence (e.g. the fixtures omit
 * manufacturer, and sample.json device 3 omits vid/pid/inf/service).
 */
function invalidDeviceField(device: Record<string, unknown>): string | null {
  for (const field of STRING_DEVICE_FIELDS) {
    const value = device[field];
    if (value !== undefined && typeof value !== "string") return field;
  }
  for (const field of ["vid", "pid"] as const) {
    const value = device[field];
    if (value !== undefined && value !== null && typeof value !== "string") return field;
  }
  const errorCode = device.errorCode;
  if (
    errorCode !== undefined &&
    errorCode !== null &&
    (typeof errorCode !== "number" || !Number.isFinite(errorCode))
  ) {
    return "errorCode";
  }
  const signed = device.signed;
  if (signed !== undefined && signed !== null && typeof signed !== "boolean") return "signed";
  for (const field of ["packageTargets", "notes"] as const) {
    const value = device[field];
    if (value !== undefined && !isStringArray(value)) return field;
  }
  return null;
}

/**
 * Same idea for report-level optional fields. `system`, when present, must
 * carry all three string fields (types in report.ts declare them required);
 * its absence is tolerated because the browser edition renders fallbacks.
 */
function invalidTopLevelField(report: Record<string, unknown>): string | null {
  const sample = report.sample;
  if (sample !== undefined && typeof sample !== "boolean") return "sample";
  const generatedAt = report.generatedAt;
  if (generatedAt !== undefined && typeof generatedAt !== "string") return "generatedAt";
  const privacy = report.privacy;
  if (privacy !== undefined && typeof privacy !== "string") return "privacy";
  const warnings = report.warnings;
  if (warnings !== undefined && !isStringArray(warnings)) return "warnings";
  const system = report.system;
  if (system !== undefined) {
    if (!isObject(system)) return "system";
    for (const field of ["os", "build", "architecture"] as const) {
      if (typeof system[field] !== "string") return `system.${field}`;
    }
  }
  return null;
}

/**
 * Validate a parsed JSON value against the schemaVersion 1 contract.
 * Returns the value cast to Report on success; never throws.
 */
export function validateReport(value: unknown): ReportValidationResult {
  try {
    if (!isObject(value)) {
      return fail("not_object", "Expected a DriverLens schemaVersion 1 report object.");
    }
    if (value.schemaVersion !== REPORT_SCHEMA_VERSION) {
      return fail("schema_version", "Expected a DriverLens schemaVersion 1 report with a devices array.");
    }
    const devices = value.devices;
    if (devices === undefined) {
      return fail("devices_missing", "Expected a DriverLens schemaVersion 1 report with a devices array.");
    }
    if (!Array.isArray(devices)) {
      return fail("devices_not_array", "Expected a DriverLens schemaVersion 1 report with a devices array.");
    }
    if (devices.length > MAX_DEVICES) {
      return fail("devices_limit", `Report contains ${devices.length} devices; the limit is ${MAX_DEVICES}.`);
    }
    for (let index = 0; index < devices.length; index += 1) {
      const device: unknown = devices[index];
      if (!isObject(device)) {
        return fail("device_not_object", `Report contains an invalid device record at index ${index}.`);
      }
      if (typeof device.name !== "string") {
        return fail("device_name", `Device record at index ${index} is missing a string name.`);
      }
      if (typeof device.id !== "string") {
        return fail("device_id", `Device record at index ${index} is missing a string id.`);
      }
      if (device.status !== "observed" && device.status !== "review") {
        return fail("device_status", `Device record at index ${index} has an unknown status.`);
      }
      const field = invalidDeviceField(device);
      if (field !== null) {
        return fail("device_field_type", `Device record at index ${index} has an invalid field: ${field}.`);
      }
    }
    const topLevel = invalidTopLevelField(value);
    if (topLevel !== null) {
      return fail("field_type", `Report field has an invalid type: ${topLevel}.`);
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      // BigInt, circular graphs, hostile toJSON: cannot be a parsed JSON report.
      return fail("unexpected_error", "Report could not be validated.");
    }
    // Mirrors the browser import guard (20 MB, app.js:10): UTF-8 bytes, matching
    // the Rust side's serde_json output length.
    if (new TextEncoder().encode(serialized).length > MAX_REPORT_BYTES) {
      return fail("size_limit", "Report exceeds the 20 MB limit.");
    }
    return { ok: true, report: value as unknown as Report };
  } catch {
    // Safety net for hostile inputs (e.g. throwing getters): validation never throws.
    return fail("unexpected_error", "Report could not be validated.");
  }
}
