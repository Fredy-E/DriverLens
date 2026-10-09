import { describe, expect, it } from "vitest";

import sampleJson from "./fixtures/sample.json";
import syntheticJson from "./fixtures/synthetic-report.json";
import { MAX_DEVICES, MAX_REPORT_BYTES } from "../src/contracts/report";
import type { Report, ReportValidationCode } from "../src/contracts/report";
import { validateReport } from "../src/contracts/validate-report";

/**
 * Contract tests for the schemaVersion 1 report (Task 4).
 *
 * The fixtures under tests/fixtures/ are local copies; no test reads the repo
 * root. Malformed variants are constructed inline (the >20000-device and
 * >20 MiB cases are generated at runtime so no huge file lives in the repo).
 */

function okReport(value: unknown): Report {
  const result = validateReport(value);
  if (!result.ok) {
    throw new Error(`expected a valid report, got ${result.code}: ${result.message}`);
  }
  return result.report;
}

function failure(value: unknown): { code: ReportValidationCode; message: string } {
  const result = validateReport(value);
  if (result.ok) {
    throw new Error("expected validation to fail, but the report was accepted");
  }
  return result;
}

/** Minimal device that satisfies the required fields: id, name, status. */
const minimalDevice = { id: "SYN0000000000001", name: "Example device", status: "observed" };
const minimalReport = { schemaVersion: 1, devices: [minimalDevice] };

describe("fixture reports", () => {
  it("validates the synthetic fixture copy (2 devices)", () => {
    const report = okReport(syntheticJson);
    expect(report.schemaVersion).toBe(1);
    expect(report.sample).toBe(true);
    expect(report.devices).toHaveLength(2);
    expect(report.devices[0].name).toBe("Contoso USB Serial Adapter (synthetic)");
  });

  it("validates the sample.json copy (3 devices)", () => {
    const report = okReport(sampleJson);
    expect(report.schemaVersion).toBe(1);
    expect(report.devices).toHaveLength(3);
    expect(report.devices[2].name).toBe("Example system component");
  });

  it("passes both fixtures through unchanged (deep equality)", () => {
    expect(okReport(syntheticJson)).toEqual(syntheticJson);
    expect(okReport(sampleJson)).toEqual(sampleJson);
  });

  it("tolerates missing optional evidence (sample.json device 3 omits vid/pid/inf/service/manufacturer)", () => {
    const device = okReport(sampleJson).devices[2];
    expect(device.vid).toBeUndefined();
    expect(device.pid).toBeUndefined();
    expect(device.inf).toBeUndefined();
    expect(device.service).toBeUndefined();
    expect(device.manufacturer).toBeUndefined();
    expect(device.architecture).toBe("Unknown");
  });

  it("does not mutate the input value", () => {
    const before = JSON.stringify(sampleJson);
    validateReport(sampleJson);
    expect(JSON.stringify(sampleJson)).toBe(before);
  });
});

describe("root shape", () => {
  it.each([null, undefined, "report", 42, true])("rejects a non-object root: %s", (value) => {
    expect(failure(value).code).toBe("not_object");
  });

  it("rejects an array root", () => {
    expect(failure([]).code).toBe("not_object");
  });

  it.each([2, "1", undefined, null])("rejects schemaVersion %s", (version) => {
    expect(failure({ schemaVersion: version, devices: [] }).code).toBe("schema_version");
  });

  it("rejects a report without a devices property (devices_missing)", () => {
    expect(failure({ schemaVersion: 1 }).code).toBe("devices_missing");
  });

  it.each([{}, "devices", null, 3])("rejects non-array devices: %s", (devices) => {
    expect(failure({ schemaVersion: 1, devices }).code).toBe("devices_not_array");
  });
});

describe("limits", () => {
  it("accepts a report at the 20000-device cap", () => {
    const devices = Array.from({ length: MAX_DEVICES }, (_, index) => ({
      id: `d${index}`,
      name: `n${index}`,
      status: "observed",
    }));
    expect(validateReport({ schemaVersion: 1, devices }).ok).toBe(true);
  });

  it("rejects a report over the 20000-device cap (devices_limit)", () => {
    const devices = Array.from({ length: MAX_DEVICES + 1 }, (_, index) => ({
      id: `d${index}`,
      name: `n${index}`,
      status: "observed",
    }));
    expect(failure({ schemaVersion: 1, devices }).code).toBe("devices_limit");
  });

  it("rejects a serialized report over 20 MiB (size_limit)", () => {
    const padding = "x".repeat(MAX_REPORT_BYTES + 1);
    expect(failure({ schemaVersion: 1, devices: [], padding }).code).toBe("size_limit");
  });
});

describe("device records", () => {
  it("rejects non-object device records", () => {
    expect(failure({ schemaVersion: 1, devices: [null] }).code).toBe("device_not_object");
    expect(failure({ schemaVersion: 1, devices: ["device"] }).code).toBe("device_not_object");
  });

  it("rejects a missing or non-string name", () => {
    expect(failure({ schemaVersion: 1, devices: [{ id: "d", status: "observed" }] }).code).toBe("device_name");
    expect(failure({ schemaVersion: 1, devices: [{ id: "d", name: 7, status: "observed" }] }).code).toBe(
      "device_name",
    );
  });

  it("rejects a missing or non-string id", () => {
    expect(failure({ schemaVersion: 1, devices: [{ name: "n", status: "observed" }] }).code).toBe("device_id");
    expect(failure({ schemaVersion: 1, devices: [{ id: {}, name: "n", status: "observed" }] }).code).toBe("device_id");
  });

  it("rejects an unknown status (missing or outside the enum)", () => {
    expect(failure({ schemaVersion: 1, devices: [{ id: "d", name: "n" }] }).code).toBe("device_status");
    expect(failure({ schemaVersion: 1, devices: [{ id: "d", name: "n", status: "pending" }] }).code).toBe(
      "device_status",
    );
    expect(failure({ schemaVersion: 1, devices: [{ id: "d", name: "n", status: "Review" }] }).code).toBe(
      "device_status",
    );
  });

  it("rejects wrong types for known device fields", () => {
    const cases: Array<[string, unknown]> = [
      ["packageTargets", "ARM64"],
      ["notes", [1]],
      ["signed", "true"],
      ["vid", 123],
      ["errorCode", "0"],
      ["manufacturer", 12],
      ["architecture", ["ARM64"]],
    ];
    for (const [field, bad] of cases) {
      const device = { ...minimalDevice, [field]: bad };
      expect(failure({ schemaVersion: 1, devices: [device] }).code, `field ${field}`).toBe("device_field_type");
    }
  });

  it("rejects non-finite errorCode values", () => {
    expect(failure({ schemaVersion: 1, devices: [{ ...minimalDevice, errorCode: Number.NaN }] }).code).toBe(
      "device_field_type",
    );
    expect(
      failure({ schemaVersion: 1, devices: [{ ...minimalDevice, errorCode: Number.POSITIVE_INFINITY }] }).code,
    ).toBe("device_field_type");
  });

  it("tolerates missing optional evidence (minimal device validates)", () => {
    expect(validateReport(minimalReport).ok).toBe(true);
  });

  it("keeps signed as a tri-state: null stays null, never coerced to false", () => {
    const withNull = okReport({ schemaVersion: 1, devices: [{ ...minimalDevice, signed: null }] }).devices[0];
    expect(withNull.signed).toBeNull();
    expect(withNull.signed === false).toBe(false);

    const absent = okReport(minimalReport).devices[0];
    expect(absent.signed).toBeUndefined();

    const unsigned = okReport({ schemaVersion: 1, devices: [{ ...minimalDevice, signed: false }] }).devices[0];
    expect(unsigned.signed).toBe(false);

    const signed = okReport({ schemaVersion: 1, devices: [{ ...minimalDevice, signed: true }] }).devices[0];
    expect(signed.signed).toBe(true);
  });

  it("keeps packageTargets (INF declarations) distinct from kernelBinary evidence", () => {
    const device = {
      ...minimalDevice,
      packageTargets: ["ARM64", "x64"],
      kernelBinary: "legacy.sys",
      architecture: "x86",
    };
    const validated = okReport({ schemaVersion: 1, devices: [device] }).devices[0];
    expect(validated.packageTargets).toEqual(["ARM64", "x64"]);
    expect(validated.kernelBinary).toBe("legacy.sys");
    expect(validated.architecture).toBe("x86");
  });
});

describe("top-level fields", () => {
  it("tolerates missing optional top-level fields", () => {
    expect(validateReport({ schemaVersion: 1, devices: [] }).ok).toBe(true);
  });

  it("rejects wrong types for known top-level fields", () => {
    const cases: Array<[string, unknown]> = [
      ["sample", "yes"],
      ["generatedAt", 5],
      ["warnings", "oops"],
      ["warnings", [1]],
      ["privacy", {}],
      ["system", []],
      ["system", { os: "Windows", build: "22631" }],
    ];
    for (const [field, bad] of cases) {
      expect(failure({ schemaVersion: 1, devices: [], [field]: bad }).code, `field ${field}`).toBe("field_type");
    }
  });
});

describe("malicious input stays inert", () => {
  it("passes hostile strings through unchanged and never executes them", () => {
    const hostileName = "<script>alert('pwned')</script> & <img src=x onerror=globalThis.__pwned=1>";
    const hostileNote = "</small><img src=x onerror=alert(1)>";
    const hostileId = '"; globalThis.__pwned=1; //';
    const value = {
      schemaVersion: 1,
      devices: [{ id: hostileId, name: hostileName, status: "observed", notes: [hostileNote] }],
    };
    const device = okReport(value).devices[0];
    expect(device.name).toBe(hostileName);
    expect(device.id).toBe(hostileId);
    expect(device.notes).toEqual([hostileNote]);
    expect((globalThis as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("treats path-shaped strings as inert data and never follows them", () => {
    const device = {
      ...minimalDevice,
      inf: "..\\..\\..\\Windows\\INF\\evil.inf",
      kernelBinary: "C:\\Windows\\System32\\drivers\\evil.sys",
      service: "\\\\?\\GLOBALROOT\\Device\\evil",
    };
    const validated = okReport({ schemaVersion: 1, devices: [device] }).devices[0];
    expect(validated.inf).toBe(device.inf);
    expect(validated.kernelBinary).toBe(device.kernelBinary);
    expect(validated.service).toBe(device.service);
  });

  it("never throws on hostile getters", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
      },
    );
    expect(() => validateReport(hostile)).not.toThrow();
    expect(validateReport(hostile).ok).toBe(false);
  });

  it("does not throw on non-JSON-serializable values (BigInt)", () => {
    const value = { schemaVersion: 1, devices: [], extra: BigInt(1) };
    expect(() => validateReport(value)).not.toThrow();
    expect(failure(value).code).toBe("unexpected_error");
  });

  it("does not throw on circular values", () => {
    const value: Record<string, unknown> = { schemaVersion: 1, devices: [] };
    value.self = value;
    expect(() => validateReport(value)).not.toThrow();
    expect(failure(value).code).toBe("unexpected_error");
  });
});

describe("caller integration pattern", () => {
  it("keeps a previously valid report when a new import fails", () => {
    let displayed: Report | null = null;
    const importReport = (value: unknown): boolean => {
      const result = validateReport(value);
      if (result.ok) {
        displayed = result.report;
      }
      return result.ok;
    };

    expect(importReport(sampleJson)).toBe(true);
    const before = displayed;
    expect(before).not.toBeNull();

    expect(importReport({ schemaVersion: 2, devices: [] })).toBe(false);
    expect(displayed).toBe(before);
  });
});
