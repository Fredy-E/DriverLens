/**
 * Export-selection helpers. A filtered export sends device ids (the opaque
 * device digests) to `export_report`; the Rust side validates every id
 * against the current report and rejects unknown ones. Order and uniqueness
 * are decided here so the request is deterministic:
 *
 * - device ids are taken in REPORT order (never DOM order of the current
 *   page — the whole filtered result set is exported, not one page);
 * - duplicate ids (a report may theoretically repeat one) are sent once.
 */
import type { Device } from "../contracts/report";

/** The ids to export for the given (already filtered) device list. */
export function idsForExport(devices: readonly Device[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const device of devices) {
    if (!seen.has(device.id)) {
      seen.add(device.id);
      ids.push(device.id);
    }
  }
  return ids;
}
