/**
 * Search semantics, ported from the browser edition (work/DriverLens/app.js:5).
 *
 * The haystack is exactly `[name, provider, version, inf, vid, pid,
 * deviceClass].join(' ')` — bus, status, architecture, notes, kernelBinary and
 * packageTargets are deliberately NOT searched (they have their own filters or
 * belong to the evidence detail). The match is a case-insensitive substring
 * test with no trimming, byte-for-byte parity with the browser edition.
 */
import type { Device } from "../contracts/report";

/** The exact browser haystack for one device (fields joined with spaces). */
export function searchHaystack(device: Device): string {
  return [
    device.name,
    device.provider,
    device.version,
    device.inf,
    device.vid,
    device.pid,
    device.deviceClass,
  ].join(" ");
}

/**
 * `true` when the query is empty or appears (case-insensitive, as a plain
 * substring) in the device's haystack. All inputs are opaque text data; the
 * query is never interpreted as a pattern or markup.
 */
export function matchesSearch(device: Device, query: string): boolean {
  const needle = query.toLowerCase();
  if (needle === "") return true;
  return searchHaystack(device).toLowerCase().includes(needle);
}
