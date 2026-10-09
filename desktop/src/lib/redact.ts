/**
 * Redaction for portable exports (E-03).
 *
 * Redaction is ON by default: device digests (`devices[].id`) are replaced
 * with stable, order-based ordinals (D01, D02, …) in the exported document.
 * The redactable surface is a data list ([`REDACTABLE_DEVICE_FIELDS`]) so
 * future sensitive fields can be added in one place without touching the
 * report builder.
 *
 * Honest scope: ordinals break the digest link for this one export, but a
 * redacted report is still local, pseudonymous data at best — names,
 * provider strings, INF names and notes are free text and may identify
 * specific equipment. DriverLens never collects hostnames, usernames, raw
 * instance IDs, serial numbers or full driver paths in the first place.
 */
import type { Device, Report } from "../contracts/report";

/** How a redactable field is replaced. */
export type RedactionMode = "ordinal";

/** One redactable device field (data-driven; extend the list to add fields). */
export interface RedactableField {
  /** The device field that is replaced when redaction is on. */
  readonly field: "id";
  /** How the replacement is produced: a per-report ordinal (D01, D02, …). */
  readonly mode: RedactionMode;
}

/**
 * The redactable fields, as data. Only the digest is redacted today; adding
 * a field here (with its mode) extends redaction everywhere it is applied.
 */
export const REDACTABLE_DEVICE_FIELDS: readonly RedactableField[] = [
  { field: "id", mode: "ordinal" },
];

/** The "What is redacted" note embedded in a redacted HTML report. */
export const REDACTION_NOTE =
  "Device identifiers are replaced by ordinals (D01, D02 …). " +
  "No hostnames, usernames, or serial numbers are ever collected.";

/** The helper line shown next to the opt-in checkbox in the UI. */
export const REDACTION_HELPER_TEXT =
  "Redacted by default — identifiers are replaced with D01, D02 …";

/** Ordinal for the device at `index` (0-based) in report order: D01, D02, … */
export function deviceOrdinal(index: number): string {
  return `D${String(index + 1).padStart(2, "0")}`;
}

/** Result of [`redactReport`]. */
export interface RedactedReport {
  /** A fresh report with every declared field replaced (input untouched). */
  readonly report: Report;
  /** Original digest → ordinal, for labels and tests. */
  readonly ordinals: ReadonlyMap<string, string>;
}

/**
 * Apply the declared redactions to a report. Pure: the input is never
 * mutated; ordinals are order-based (the first device of the report is
 * always D01), so the same report always redacts to the same document.
 */
export function redactReport(report: Report): RedactedReport {
  const ordinals = new Map<string, string>();
  const devices = report.devices.map((device, index) => {
    const ordinal = deviceOrdinal(index);
    if (typeof device.id === "string") {
      ordinals.set(device.id, ordinal);
    }
    return redactDevice(device, ordinal);
  });
  return { report: { ...report, devices }, ordinals };
}

/** Replace every declared field on one device; other fields pass through. */
function redactDevice(device: Device, ordinal: string): Device {
  let next = device;
  for (const rule of REDACTABLE_DEVICE_FIELDS) {
    if (rule.field === "id" && rule.mode === "ordinal") {
      next = { ...next, id: ordinal };
    }
  }
  return next;
}
