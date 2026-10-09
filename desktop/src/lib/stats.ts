/**
 * Report-level stats, ported verbatim from the browser edition (app.js:6):
 *
 * - total: every device in the report;
 * - review: devices with status 'review';
 * - known: devices whose `architecture` is in the hard-coded
 *   KNOWN_ARCHITECTURES list (see lib/filters.ts);
 * - osArchitecture: `system.architecture` or 'Unknown'.
 *
 * These are whole-report counts — the same numbers show regardless of the
 * current search/filter state, exactly like the browser edition.
 */
import type { Device, SystemInfo } from "../contracts/report";
import { KNOWN_ARCHITECTURES } from "./filters";

export interface ReportStats {
  total: number;
  review: number;
  known: number;
  osArchitecture: string;
}

export function reportStats(devices: readonly Device[], system?: SystemInfo): ReportStats {
  const knownSet = new Set<string>(KNOWN_ARCHITECTURES);
  let review = 0;
  let known = 0;
  for (const device of devices) {
    if (device.status === "review") review += 1;
    if (typeof device.architecture === "string" && knownSet.has(device.architecture)) {
      known += 1;
    }
  }
  return {
    total: devices.length,
    review,
    known,
    osArchitecture: system?.architecture || "Unknown",
  };
}
