/**
 * Scan lifecycle copy. The running/idle strings keep the browser edition's
 * product voice (app.js:12); the failure strings map the stable Rust error
 * codes (desktop/src-tauri/src/scan.rs) to clear, actionable human text —
 * the snapshot itself carries only the code, never a message.
 *
 * Every terminal state must be renderable by code alone: `scanErrorGuidance`
 * is a total function over the closed code set (plus a defensive branch for
 * codes a future backend might add).
 */
import type { ScanErrorCode, ScanSnapshot, ScanStateName } from "../adapters/native";
import { deviceCountLabel } from "./format";

/** Short labels for the five lifecycle states (used for aria/tests/tooltips). */
export const SCAN_STATE_LABELS: Record<ScanStateName, string> = {
  idle: "Idle",
  running: "Running",
  complete: "Complete",
  error: "Error",
  cancelled: "Cancelled",
};

/** The browser edition's progress string, kept verbatim (app.js:12). */
export const SCAN_RUNNING_MESSAGE = "Reading Windows device and driver metadata…";

/** Shown when a duplicate start collides with an already-running scan. */
export const SCAN_BUSY_NOTICE = "A scan is already running — showing its progress.";

export function scanIdleMessage(): string {
  return "Ready. Scans read this PC's device and driver metadata locally; nothing is uploaded.";
}

export function scanRunningMessage(): string {
  return SCAN_RUNNING_MESSAGE;
}

export function scanCompleteMessage(snapshot: ScanSnapshot): string {
  const count = snapshot.deviceCount;
  if (count === undefined) {
    return "Scan complete — the report was accepted. Nothing was uploaded.";
  }
  return `Scan complete — ${deviceCountLabel(count)} collected locally. The report is kept on this PC and can be saved with Export; nothing was uploaded.`;
}

export function scanCancelledMessage(): string {
  return "Scan cancelled — no new report was accepted, and the previous report is unchanged.";
}

const ERROR_GUIDANCE: Record<ScanErrorCode, string> = {
  busy: "A scan is already running. Wait for it to finish or cancel it.",
  executable_missing:
    "PowerShell 7 (pwsh.exe) was not found, and DriverLens needs it to read device and driver metadata. " +
    "Install PowerShell 7 (for example: winget install --id Microsoft.PowerShell) or set the DRIVERLENS_POWERSHELL " +
    "environment variable to the full path of a trusted pwsh.exe, then scan again.",
  timeout: "The scan timed out before the collector finished. Nothing was changed — try again.",
  cancelled: "The scan was cancelled before it completed. No new report was accepted.",
  exit_failure:
    "The collector exited with a nonzero status. Check that PowerShell 7 is installed and that script policy " +
    "allows the bundled collector, then try again.",
  output_missing: "The collector finished but produced no report. Try again.",
  too_large: "The scan produced a report larger than the 20 MiB limit, so nothing was loaded.",
  invalid_report: "The scan produced output that is not a valid DriverLens v1 report, so nothing was loaded.",
  io: "An unexpected operating-system error interrupted the scan. Try again.",
  invalid_selection:
    "The export selection does not match the current report. Reopen the report and export again.",
};

/** Human guidance for a terminal scan-error code. Total over the closed set. */
export function scanErrorGuidance(code: ScanErrorCode | undefined): string {
  if (code === undefined) {
    return "The scan failed for an unknown reason. Try again.";
  }
  return ERROR_GUIDANCE[code] ?? `The scan failed (${code}). Try again.`;
}

/**
 * Human text for a rejected command call (start/cancel/import/export). Prefers
 * the backend's own message when the rejection carries one; string rejections
 * (ACL denials, transport failures) are shown as-is; anything else gets a
 * generic line. Never throws.
 */
export function commandErrorText(error: unknown, code: ScanErrorCode | undefined): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") {
      return code === undefined || message.includes(code) ? message : `${message} (${code})`;
    }
  }
  if (typeof error === "string" && error !== "") return error;
  return code === undefined ? "The operation failed." : `The operation failed (${code}).`;
}
