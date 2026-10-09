/**
 * Redaction unit tests (E-03 portable HTML reports): redaction is ON by
 * default and replaces device digests with stable, order-based ordinals
 * (D01, D02, …). The redactable-field list is data-driven so future
 * sensitive fields can be added without touching call sites.
 */
import { describe, expect, it } from "vitest";

import type { Report } from "../src/contracts/report";
import {
  deviceOrdinal,
  REDACTABLE_DEVICE_FIELDS,
  redactReport,
} from "../src/lib/redact";
import { LOCAL_REPORT } from "./fixtures/reports";

describe("deviceOrdinal", () => {
  it("pads to two digits and grows naturally", () => {
    expect(deviceOrdinal(0)).toBe("D01");
    expect(deviceOrdinal(8)).toBe("D09");
    expect(deviceOrdinal(9)).toBe("D10");
    expect(deviceOrdinal(99)).toBe("D100");
    expect(deviceOrdinal(100)).toBe("D101");
  });
});

describe("redactReport — default-on ordinals", () => {
  it("replaces every device digest with its position ordinal (D01, D02, …)", () => {
    const { report, ordinals } = redactReport(LOCAL_REPORT);
    expect(report.devices.map((device) => device.id)).toEqual(["D01", "D02", "D03"]);
    expect(ordinals.get("LOCAL001")).toBe("D01");
    expect(ordinals.get("LOCAL002")).toBe("D02");
    expect(ordinals.get("LOCAL003")).toBe("D03");
    expect(ordinals.size).toBe(3);
  });

  it("never mutates the input report and returns a fresh copy", () => {
    const { report } = redactReport(LOCAL_REPORT);
    expect(report).not.toBe(LOCAL_REPORT);
    expect(report.devices).not.toBe(LOCAL_REPORT.devices);
    // The source report keeps its original digests.
    expect(LOCAL_REPORT.devices.map((device) => device.id)).toEqual([
      "LOCAL001",
      "LOCAL002",
      "LOCAL003",
    ]);
    // Non-identifier fields pass through unchanged.
    expect(report.devices[0].name).toBe(LOCAL_REPORT.devices[0].name);
    expect(report.devices[1].notes).toEqual(LOCAL_REPORT.devices[1].notes);
    expect(report.devices[1].provider).toBe(LOCAL_REPORT.devices[1].provider);
  });

  it("is stable per report and order-based, not digest-based", () => {
    const first = redactReport(LOCAL_REPORT);
    const second = redactReport(LOCAL_REPORT);
    expect(second.report.devices.map((device) => device.id)).toEqual(
      first.report.devices.map((device) => device.id)
    );

    // Reversing the device order reverses the ordinal assignment: D01 is the
    // FIRST device of the report, whatever its digest is.
    const reversed: Report = {
      ...LOCAL_REPORT,
      devices: [...LOCAL_REPORT.devices].reverse(),
    };
    const { report } = redactReport(reversed);
    expect(report.devices.map((device) => device.id)).toEqual(["D01", "D02", "D03"]);
    expect(report.devices[0].name).toBe("Test System Component");
  });

  it("gives duplicate digests their own positional ordinals", () => {
    const duplicate: Report = {
      ...LOCAL_REPORT,
      devices: [LOCAL_REPORT.devices[0], { ...LOCAL_REPORT.devices[0] }],
    };
    const { report } = redactReport(duplicate);
    expect(report.devices.map((device) => device.id)).toEqual(["D01", "D02"]);
  });
});

describe("redactReport — data-driven field list", () => {
  it("declares the redactable fields as data (extensible without call-site changes)", () => {
    expect(REDACTABLE_DEVICE_FIELDS).toContainEqual({ field: "id", mode: "ordinal" });
  });

  it("redacts exactly the declared fields and nothing else", () => {
    const { report } = redactReport(LOCAL_REPORT);
    // Only `id` is declared, so every other field survives byte-for-byte.
    expect(JSON.stringify(report.devices[1])).toBe(
      JSON.stringify({ ...LOCAL_REPORT.devices[1], id: "D02" })
    );
  });
});
