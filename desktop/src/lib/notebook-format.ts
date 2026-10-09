/**
 * Display formatting for the USB Device Notebook (extension E-01).
 *
 * Pure, DOM-free helpers so the component stays a rendering shell and the
 * formatting rules are testable on their own. Timestamps render in UTC
 * (`YYYY-MM-DD` / `YYYY-MM-DD HH:MM`) — deterministic everywhere, matching
 * how the report's `generatedAt` is displayed. Every fallback is honest:
 * unknown evidence is labelled, never guessed.
 */
import type { NotebookChange, NotebookDevice } from "../adapters/native";

/** `"2026-10-09"` (UTC) for a ms timestamp. */
export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `"2026-10-09 12:00"` (UTC) for a ms timestamp. */
export function formatDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** `"0403:6001"` when both are known; honest fallbacks otherwise. */
export function vidPidLabel(vid: string | null, pid: string | null): string {
  if (vid && pid) return `${vid}:${pid}`;
  if (vid) return `VID ${vid}`;
  if (pid) return `PID ${pid}`;
  return "VID/PID unknown";
}

/**
 * The most recent change for a field, or null when the field never changed.
 * Change lists are derived from consecutive observations, so the last entry
 * for a field is normally the newest; the scan is defensive (equal
 * timestamps keep the later entry).
 */
export function latestChange(
  device: NotebookDevice,
  field: NotebookChange["field"]
): NotebookChange | null {
  let latest: NotebookChange | null = null;
  for (const change of device.changes) {
    if (change.field !== field) continue;
    if (latest === null || change.at >= latest.at) latest = change;
  }
  return latest;
}

/** `"14.0.1 -> 14.0.2 (2026-10-09)"` — the version-change indicator. */
export function versionChangeLabel(change: NotebookChange): string {
  return `${change.from ?? "unknown"} -> ${change.to ?? "unknown"} (${formatDay(change.at)})`;
}
