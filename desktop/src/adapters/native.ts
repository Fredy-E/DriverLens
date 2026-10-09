/**
 * Typed wrappers for the six DriverLens native commands (Task 7 boundary,
 * extended in Task 10 with a filtered-export selection and later with the
 * read-only current-report read).
 *
 * This module is the ONLY place the renderer talks to the native side, and it
 * deliberately exposes no way to influence what the native side does:
 *
 * - every wrapper invokes a fixed command name; no executable, shell command,
 *   collector script path, or filesystem destination can ever be supplied.
 *   `exportReport` accepts one optional argument — a list of device ids to
 *   export (`ids`) — which the Rust side validates against the current report
 *   and uses only for set membership. It is never a path and never a filter
 *   expression;
 * - `openReport`, `exportReport` and `getReport` return native outcomes: the
 *   dialogs are opened by the Rust side (paths never travel through the
 *   webview), and `getReport` reads the current in-memory report with no
 *   arguments at all;
 * - errors reject with `ScanError` (`{ code, message }`) for command-level
 *   failures; an ACL denial (a page without the capability) rejects with a
 *   plain string instead — see `isScanError`.
 *
 * The command names and the `ScanErrorCode` union are mirrored by the Rust
 * side (desktop/src-tauri/src/scan.rs); keep them in sync.
 */

import { invoke } from "@tauri-apps/api/core";
import type { Report } from "../contracts/report";

/** Lifecycle states of the native scan, mirrored from Rust `ScanState`. */
export type ScanStateName = "idle" | "running" | "complete" | "error" | "cancelled";

/**
 * Stable scan/command error codes, mirrored from Rust `ScanErrorCode`.
 * These strings are part of the contract; messages are static display text.
 */
export type ScanErrorCode =
  | "busy"
  | "executable_missing"
  | "timeout"
  | "cancelled"
  | "exit_failure"
  | "output_missing"
  | "too_large"
  | "invalid_report"
  | "invalid_selection"
  | "io";

/** `{ code, message }` — the rejection shape of every command-level failure. */
export interface ScanError {
  code: ScanErrorCode;
  message: string;
}

/**
 * The only scan shape the frontend receives: no report contents, no raw
 * paths, no stderr. `startedMs` is only present while running; `errorCode`
 * only when the state is "error"; `deviceCount` reflects the current
 * in-memory report (last accepted scan or import).
 */
export interface ScanSnapshot {
  state: ScanStateName;
  generation: number;
  startedMs?: number;
  errorCode?: ScanErrorCode;
  deviceCount?: number;
}

/** Result of a successful export: bytes written to the user-chosen file. */
export interface ExportSummary {
  bytesWritten: number;
}

/**
 * Starts a scan of this PC. Resolves with the running snapshot, or rejects
 * with `{ code: "busy" }` when a scan is already in flight (parity with the
 * browser helper's 409). Poll `getScanState` for progress.
 */
export async function scanDevices(): Promise<ScanSnapshot> {
  return invoke<ScanSnapshot>("scan_devices");
}

/** Current lifecycle snapshot — safe to poll; never carries report contents. */
export async function getScanState(): Promise<ScanSnapshot> {
  return invoke<ScanSnapshot>("get_scan_state");
}

/**
 * Requests cancellation of the running scan (idempotent; no-op when idle).
 * The scan then finishes as `cancelled` with no report accepted.
 */
export async function cancelScan(): Promise<void> {
  return invoke<void>("cancel_scan");
}

/**
 * Opens the NATIVE open dialog (Rust side) and imports the selected report.
 * Resolves with the parsed, validated schemaVersion 1 report, or `null` when
 * the user cancelled the dialog. Rejects with `ScanError` for unreadable,
 * oversized, or invalid files.
 */
export async function openReport(): Promise<Report | null> {
  return invoke<Report | null>("open_report");
}

/**
 * Opens the NATIVE save dialog (Rust side) and writes schemaVersion 1 JSON.
 *
 * - `exportReport()` (no argument): the full current in-memory report, exactly
 *   as stored (from the last accepted scan or import). The stored value is
 *   written unchanged; a full export carries no `filterNote`.
 * - `exportReport(ids)`: a filtered export — exactly the devices whose `id`
 *   is in `ids`, in report order. The Rust side rejects the request with
 *   `{ code: "invalid_selection" }` if any id is not in the current report,
 *   and the written file gains `filterNote:
 *   "Filtered export from DriverLens"` (the browser edition's payload).
 *
 * Resolves with the byte count, or `null` when the user cancelled; rejects
 * with `{ code: "output_missing" }` when there is no report to export. The
 * save dialog's own overwrite confirmation is the only overwrite
 * confirmation — no file is ever written without the user picking it.
 */
export async function exportReport(ids?: readonly string[]): Promise<ExportSummary | null> {
  if (ids === undefined) {
    return invoke<ExportSummary | null>("export_report");
  }
  return invoke<ExportSummary | null>("export_report", { ids: [...ids] });
}

/**
 * The current validated in-memory report (the last accepted scan or import),
 * or `null` when none exists yet.
 *
 * Read-only and argument-free: it cannot start, cancel or influence anything,
 * and it returns exactly the stored value a full `exportReport()` would write.
 * This is how a freshly scanned report reaches the device table without being
 * saved to disk first.
 */
export async function getReport(): Promise<Report | null> {
  return invoke<Report | null>("get_report");
}

/**
 * Type guard for the `{ code, message }` rejection shape. An ACL denial or a
 * transport failure rejects with something else (typically a string); callers
 * that want the stable code should check with this first.
 */
export function isScanError(value: unknown): value is ScanError {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}
