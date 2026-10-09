import { describe, expect, it } from "vitest";

import { device, LOCAL_REPORT } from "./fixtures/reports";
import { DEFAULT_QUERY, filterDevices } from "../src/lib/filters";
import { matchesSearch, searchHaystack } from "../src/lib/search";
import { reportStats } from "../src/lib/stats";
import type { DeviceQuery } from "../src/lib/filters";

/**
 * Browser-parity tests for the search/filter/count semantics
 * (work/DriverLens/app.js:5-6). The haystack, exact-match select semantics
 * and fallbacks are asserted explicitly so a "helpful" refactor cannot
 * silently widen or narrow what users see.
 */

const [adapter, controller, component] = LOCAL_REPORT.devices;

function query(overrides: Partial<DeviceQuery>): DeviceQuery {
  return { ...DEFAULT_QUERY, ...overrides };
}

describe("search haystack and matching", () => {
  it("builds the exact browser haystack (name, provider, version, inf, vid, pid, deviceClass)", () => {
    expect(searchHaystack(adapter)).toBe(
      "Test USB Serial Adapter Contoso 1.0.0.0 contoso.inf 04D8 000A Ports"
    );
  });

  it("joins empty/absent fields as empty strings (browser join parity)", () => {
    // name + empty provider/version/inf/vid/pid + deviceClass, joined by " ".
    expect(searchHaystack(component)).toBe(
      ["Test System Component", "", "", "", "", "", "System"].join(" ")
    );
  });

  it("matches case-insensitively across every haystack field", () => {
    expect(matchesSearch(adapter, "serial")).toBe(true);
    expect(matchesSearch(adapter, "CONTOSO")).toBe(true);
    expect(matchesSearch(adapter, "1.0.0.0")).toBe(true);
    expect(matchesSearch(adapter, "contoso.inf")).toBe(true);
    expect(matchesSearch(adapter, "04d8")).toBe(true);
    expect(matchesSearch(adapter, "000a")).toBe(true);
    expect(matchesSearch(adapter, "ports")).toBe(true);
  });

  it("does NOT search bus, status, architecture, notes or kernelBinary (browser parity)", () => {
    // 'PCI' is the controller's bus but appears nowhere in its haystack.
    expect(matchesSearch(controller, "PCI")).toBe(false);
    // 'review' is its status.
    expect(matchesSearch(controller, "review")).toBe(false);
    // 'x64' is its architecture.
    expect(matchesSearch(controller, "x64")).toBe(false);
    // notes / kernelBinary are not searched either.
    expect(matchesSearch(controller, "device error 10")).toBe(false);
    expect(matchesSearch(adapter, "contoso.sys")).toBe(false);
  });

  it("matches everything for an empty query and nothing for an absent term", () => {
    expect(matchesSearch(adapter, "")).toBe(true);
    expect(matchesSearch(adapter, "zzz-nothing")).toBe(false);
  });

  it("does not trim the query (browser filter parity)", () => {
    // 'serial ' WOULD match (haystack: "...serial adapter..."), so use terms
    // where trimming would change the result: a leading space before the
    // first token, and a trailing space after the last token.
    expect(matchesSearch(adapter, " test")).toBe(false);
    expect(matchesSearch(adapter, "ports ")).toBe(false);
    expect(matchesSearch(adapter, "ports")).toBe(true);
  });

  it("treats markup-like input as plain text", () => {
    expect(matchesSearch(adapter, "<script>")).toBe(false);
    expect(matchesSearch(device({ id: "X", name: "<script>alert(1)</script>" }), "<script>")).toBe(true);
  });
});

describe("filterDevices — exact-match conditions, AND-composed", () => {
  it("returns every device for the default query and does not mutate the input", () => {
    const input = [...LOCAL_REPORT.devices];
    const result = filterDevices(input, DEFAULT_QUERY);
    expect(result).toHaveLength(3);
    expect(result).not.toBe(input);
    expect(input).toHaveLength(3);
  });

  it("filters status exactly (all | review | observed)", () => {
    expect(filterDevices(LOCAL_REPORT.devices, query({ status: "review" }))).toEqual([controller]);
    expect(filterDevices(LOCAL_REPORT.devices, query({ status: "observed" }))).toEqual([
      adapter,
      component,
    ]);
  });

  it("filters architecture exactly on the raw value", () => {
    expect(filterDevices(LOCAL_REPORT.devices, query({ architecture: "ARM64" }))).toEqual([adapter]);
    expect(filterDevices(LOCAL_REPORT.devices, query({ architecture: "x64" }))).toEqual([controller]);
    // "Unknown" matches only the literal string (open question #2 kept as-is).
    expect(filterDevices(LOCAL_REPORT.devices, query({ architecture: "Unknown" }))).toEqual([
      component,
    ]);
    expect(filterDevices(LOCAL_REPORT.devices, query({ architecture: "ARM64EC" }))).toEqual([]);
  });

  it("filters bus exactly on the raw value", () => {
    expect(filterDevices(LOCAL_REPORT.devices, query({ bus: "USB" }))).toEqual([adapter]);
    expect(filterDevices(LOCAL_REPORT.devices, query({ bus: "ACPI" }))).toEqual([component]);
    expect(filterDevices(LOCAL_REPORT.devices, query({ bus: "ROOT" }))).toEqual([]);
  });

  it("composes search and selects with AND", () => {
    expect(
      filterDevices(LOCAL_REPORT.devices, query({ search: "legacy", status: "review" }))
    ).toEqual([controller]);
    expect(
      filterDevices(LOCAL_REPORT.devices, query({ search: "legacy", status: "observed" }))
    ).toEqual([]);
    expect(
      filterDevices(
        LOCAL_REPORT.devices,
        query({ search: "test", bus: "ACPI", architecture: "Unknown" })
      )
    ).toEqual([component]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterDevices(LOCAL_REPORT.devices, query({ search: "zzz" }))).toEqual([]);
  });
});

describe("reportStats — browser counting rules", () => {
  it("counts total, review, known architectures and the OS architecture", () => {
    expect(reportStats(LOCAL_REPORT.devices, LOCAL_REPORT.system)).toEqual({
      total: 3,
      review: 1,
      known: 2, // ARM64 + x64; the literal "Unknown" is NOT known
      osArchitecture: "ARM64",
    });
  });

  it("counts the wider known list (ARM64EC/ARM64X/ARM32) even though it is not filterable", () => {
    const devices = [
      device({ id: "A", name: "A", architecture: "ARM64EC" }),
      device({ id: "B", name: "B", architecture: "ARM64X" }),
      device({ id: "C", name: "C", architecture: "ARM32" }),
      device({ id: "D", name: "D", architecture: "Not PE" }),
      device({ id: "E", name: "E" }),
    ];
    expect(reportStats(devices).known).toBe(3);
  });

  it("falls back to 'Unknown' for a missing system architecture", () => {
    expect(reportStats([], undefined).osArchitecture).toBe("Unknown");
    expect(reportStats([], { os: "x", build: "1", architecture: "" }).osArchitecture).toBe("Unknown");
  });
});
