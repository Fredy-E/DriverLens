/**
 * Display formatting for device evidence — fallback strings and labels,
 * ported from the browser edition (app.js:7) so the desktop table renders
 * the same words:
 *
 * - `textOr` mirrors the browser's `value || fallback` (an empty string also
 *   falls back);
 * - `signatureLabel` is the strict tri-state: `true` → Signed, `false` →
 *   Unsigned, anything else (null/absent) → Unknown — never coerced;
 * - `errorCodeLabel` mirrors `errorCode ?? 'Unknown'`, so a real `0` renders
 *   as "0";
 * - `packageTargetsLabel` mirrors the Array.isArray-guarded join, where an
 *   empty array renders "Unknown".
 *
 * Fallback strings are returned as data; the components decide how to mark
 * them (the table renders fallbacks in muted style so "unknown" stays
 * visually distinct from real evidence).
 */
import type { DeviceStatus } from "../contracts/report";

export const FALLBACKS = {
  provider: "Unknown provider",
  version: "Version unknown",
  inf: "INF unknown",
  architecture: "Unknown",
  kernelBinary: "Not resolved",
  service: "Unknown",
  windowsStatus: "Unknown",
  errorCode: "Unknown",
  packageTargets: "Unknown",
  general: "Unknown",
  pid: "?",
} as const;

/** Browser-parity `value || fallback` for optional evidence strings. */
export function textOr(value: string | null | undefined, fallback: string): string {
  return value ? value : fallback;
}

/** Strict tri-state signature label (app.js:7). */
export function signatureLabel(signed: boolean | null | undefined): "Signed" | "Unsigned" | "Unknown" {
  if (signed === true) return "Signed";
  if (signed === false) return "Unsigned";
  return "Unknown";
}

/**
 * Badge text for a device status. The contract's closed union
 * (`observed` | `review`) yields the two definitive labels; anything else —
 * contract drift, a hand-built value — renders "Unknown". The function is
 * total and never guesses "Observed" for a value it does not recognize.
 */
export function statusLabel(status: DeviceStatus): "Needs review" | "Observed" | "Unknown" {
  if (status === "review") return "Needs review";
  if (status === "observed") return "Observed";
  // Unreachable through the typed contract; kept for runtime honesty.
  return "Unknown";
}

/** Browser-parity INF target list; empty or absent renders "Unknown". */
export function packageTargetsLabel(targets: string[] | undefined): string {
  if (!Array.isArray(targets) || targets.length === 0) return FALLBACKS.packageTargets;
  return targets.join(", ");
}

/** Browser-parity error code text (`??`: 0 renders as "0"). */
export function errorCodeLabel(code: number | null | undefined): string {
  if (code === null || code === undefined) return FALLBACKS.errorCode;
  return String(code);
}

/** `412` → `"412"`, `19842` → `"19,842"` (en-US grouping, deterministic). */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** "1 device" / "2 devices". */
export function deviceCountLabel(count: number): string {
  return `${formatCount(count)} device${count === 1 ? "" : "s"}`;
}

/** "1 byte" / "412 bytes". */
export function byteCountLabel(value: number): string {
  return `${formatCount(value)} byte${value === 1 ? "" : "s"}`;
}
