import { describe, expect, it } from "vitest";

import { device, LOCAL_REPORT } from "./fixtures/reports";
import { idsForExport } from "../src/lib/selection";

/**
 * The filtered export sends device ids; order and uniqueness are decided
 * here so `export_report {ids}` is deterministic and the Rust side can
 * validate membership with set semantics.
 */

describe("idsForExport", () => {
  it("returns ids in report order", () => {
    expect(idsForExport(LOCAL_REPORT.devices)).toEqual(["LOCAL001", "LOCAL002", "LOCAL003"]);
  });

  it("deduplicates repeated ids while keeping the first occurrence's position", () => {
    const devices = [
      device({ id: "B", name: "B" }),
      device({ id: "A", name: "A" }),
      device({ id: "B", name: "B copy" }),
    ];
    expect(idsForExport(devices)).toEqual(["B", "A"]);
  });

  it("returns an empty list when nothing matched", () => {
    expect(idsForExport([])).toEqual([]);
  });
});
