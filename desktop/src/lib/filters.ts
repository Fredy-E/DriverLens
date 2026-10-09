/**
 * Search + filter + counts semantics, ported from the browser edition
 * (work/DriverLens/app.js:5-6 `filtered()` and `render()`), so the desktop
 * table matches the tool users already know:
 *
 * - Search is the lib/search.ts haystack (name/provider/version/INF/VID/PID/
 *   deviceClass), case-insensitive substring, no trimming.
 * - Status / architecture / bus are EXACT matches on the raw field value
 *   (no fallback substitution): a device whose `architecture` is missing or
 *   is a literal like "ARM64EC" never matches the "Unknown" option, exactly
 *   like the browser select.
 * - All four conditions compose with AND.
 */
import type { Device } from "../contracts/report";
import { matchesSearch } from "./search";

/** Status filter value; 'all' disables the condition. */
export type StatusFilter = "all" | "observed" | "review";

/** One snapshot of every table control. Pure data; never mutated in place. */
export interface DeviceQuery {
  search: string;
  status: StatusFilter;
  /** 'all' or an exact `architecture` value. */
  architecture: string;
  /** 'all' or an exact `bus` value. */
  bus: string;
}

/** Initial (no-op) query: every device matches. */
export const DEFAULT_QUERY: DeviceQuery = {
  search: "",
  status: "all",
  architecture: "all",
  bus: "all",
};

/** Status select options (browser parity: all | review | observed). */
export const STATUS_FILTER_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "review", label: "Needs review" },
  { value: "observed", label: "Observed" },
];

/**
 * Architecture select options — browser parity (index.html:6): the values are
 * the literal strings and only 'all' is special (open question #3 in
 * notes/UI-PARITY-NOTES.md noted that e.g. ARM64EC/ARM64X/ARM32 devices are
 * counted by the stats but not filterable; kept as-is for parity).
 */
export const ARCHITECTURE_FILTER_OPTIONS: readonly string[] = [
  "all",
  "ARM64",
  "x64",
  "x86",
  "Unknown",
];

/** Bus select options — browser parity. */
export const BUS_FILTER_OPTIONS: readonly string[] = ["all", "USB", "PCI", "ROOT", "ACPI"];

/**
 * Architectures counted by the "Binary architecture known" stat — the exact
 * hard-coded list from the browser edition (app.js:6). Deliberately wider
 * than the filter options.
 */
export const KNOWN_ARCHITECTURES: readonly string[] = [
  "ARM64",
  "x64",
  "x86",
  "ARM64EC",
  "ARM64X",
  "ARM32",
];

/**
 * The filtered device list, in report order (browser `filtered()` parity).
 * Pure: returns a new array; never mutates the input.
 */
export function filterDevices(devices: readonly Device[], query: DeviceQuery): Device[] {
  return devices.filter(
    (device) =>
      matchesSearch(device, query.search) &&
      (query.status === "all" || device.status === query.status) &&
      (query.architecture === "all" || device.architecture === query.architecture) &&
      (query.bus === "all" || device.bus === query.bus)
  );
}
