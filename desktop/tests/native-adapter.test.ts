import { beforeEach, describe, expect, it, vi } from "vitest";

import sampleJson from "./fixtures/sample.json";
import {
  cancelScan,
  exportReport,
  getReport,
  getScanState,
  isScanError,
  openReport,
  scanDevices,
  type ExportSummary,
  type ScanSnapshot,
} from "../src/adapters/native";
import type { Report } from "../src/contracts/report";

/**
 * Task 7 adapter tests: the six wrappers must invoke EXACT fixed command
 * names with ZERO arguments (the renderer cannot smuggle a program, a script
 * path, or a destination), and must pass results through with the contract's
 * types.
 *
 * `@tauri-apps/api/core` is mocked: no Tauri runtime is involved.
 */
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

const invokeMock = vi.mocked(invoke);

/** Exact command names asserted by both this suite and the Rust IPC tests. */
const COMMAND_NAMES = [
  "scan_devices",
  "get_scan_state",
  "get_report",
  "cancel_scan",
  "open_report",
  "export_report",
] as const;

function lastCall(): unknown[] {
  expect(invokeMock).toHaveBeenCalledTimes(1);
  const call = invokeMock.mock.calls[0];
  // The whole argument list: exactly one argument (the command name).
  return call;
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("native adapter — command names and no-argument invocation", () => {
  it("scanDevices invokes scan_devices with no arguments", async () => {
    const snapshot: ScanSnapshot = {
      state: "running",
      generation: 1,
      startedMs: 1_700_000_000_000,
    };
    invokeMock.mockResolvedValue(snapshot);
    await expect(scanDevices()).resolves.toEqual(snapshot);
    expect(lastCall()).toEqual(["scan_devices"]);
  });

  it("getScanState invokes get_scan_state with no arguments", async () => {
    const snapshot: ScanSnapshot = { state: "idle", generation: 0 };
    invokeMock.mockResolvedValue(snapshot);
    await expect(getScanState()).resolves.toEqual(snapshot);
    expect(lastCall()).toEqual(["get_scan_state"]);
  });

  it("getReport invokes get_report with no arguments", async () => {
    invokeMock.mockResolvedValue(sampleJson);
    const report: Report | null = await getReport();
    expect(report).toEqual(sampleJson);
    expect(lastCall()).toEqual(["get_report"]);
  });

  it("cancelScan invokes cancel_scan with no arguments", async () => {
    invokeMock.mockResolvedValue(undefined);
    await expect(cancelScan()).resolves.toBeUndefined();
    expect(lastCall()).toEqual(["cancel_scan"]);
  });

  it("openReport invokes open_report with no arguments", async () => {
    invokeMock.mockResolvedValue(sampleJson);
    const report: Report | null = await openReport();
    expect(report).toEqual(sampleJson);
    expect(lastCall()).toEqual(["open_report"]);
  });

  it("exportReport invokes export_report with no arguments", async () => {
    const summary: ExportSummary = { bytesWritten: 1234 };
    invokeMock.mockResolvedValue(summary);
    await expect(exportReport()).resolves.toEqual(summary);
    expect(lastCall()).toEqual(["export_report"]);
  });

  it("exportReport(ids) invokes export_report with exactly the id list (no paths)", async () => {
    const summary: ExportSummary = { bytesWritten: 99 };
    invokeMock.mockResolvedValue(summary);
    await expect(exportReport(["SAMPLE001", "SAMPLE003"])).resolves.toEqual(summary);
    expect(lastCall()).toEqual(["export_report", { ids: ["SAMPLE001", "SAMPLE003"] }]);
  });

  it("exportReport copies the id list so later caller mutations cannot change the request", async () => {
    invokeMock.mockResolvedValue({ bytesWritten: 1 });
    const ids = ["A", "B"];
    const pending = exportReport(ids);
    ids.push("C");
    await pending;
    expect(lastCall()).toEqual(["export_report", { ids: ["A", "B"] }]);
  });

  it("exportReport([]) still sends an explicit empty selection (not the full export)", async () => {
    invokeMock.mockResolvedValue({ bytesWritten: 1 });
    await exportReport([]);
    expect(lastCall()).toEqual(["export_report", { ids: [] }]);
  });

  it("uses exactly the six agreed command names and no others", async () => {
    invokeMock.mockResolvedValue(null);
    await scanDevices().catch(() => undefined);
    await getScanState().catch(() => undefined);
    await getReport().catch(() => undefined);
    await cancelScan().catch(() => undefined);
    await openReport().catch(() => undefined);
    await exportReport().catch(() => undefined);
    const names = invokeMock.mock.calls.map((call) => call[0]);
    expect(names).toEqual([...COMMAND_NAMES]);
    for (const call of invokeMock.mock.calls) {
      expect(call).toHaveLength(1);
    }
  });
});

describe("native adapter — result typing and pass-through", () => {
  it("passes the scan snapshot through unchanged (optional fields included)", async () => {
    const complete: ScanSnapshot = {
      state: "complete",
      generation: 3,
      deviceCount: 412,
    };
    invokeMock.mockResolvedValue(complete);
    const snapshot = await scanDevices();
    expect(snapshot).toEqual(complete);
    expect(snapshot.state).toBe("complete");
    expect(snapshot.errorCode).toBeUndefined();
    expect(snapshot.startedMs).toBeUndefined();
  });

  it("passes a null get_report result through (no report exists yet)", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(getReport()).resolves.toBeNull();
  });

  it("passes a null import result through (user cancelled the dialog)", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(openReport()).resolves.toBeNull();
  });

  it("passes a null export result through (user cancelled the dialog)", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(exportReport()).resolves.toBeNull();
  });
});

describe("native adapter — error surface", () => {
  it("propagates the { code, message } rejection untouched", async () => {
    const busy = { code: "busy", message: "A scan is already running." };
    invokeMock.mockRejectedValue(busy);
    await expect(scanDevices()).rejects.toEqual(busy);
  });

  it("propagates an ACL denial string untouched (not a ScanError)", async () => {
    const denial = 'Command scan_devices not allowed. Command not found';
    invokeMock.mockRejectedValue(denial);
    await expect(scanDevices()).rejects.toBe(denial);
  });

  it("isScanError distinguishes DTO errors from strings and junk", () => {
    expect(isScanError({ code: "busy", message: "…" })).toBe(true);
    expect(isScanError({ code: "timeout", message: "…" })).toBe(true);
    expect(isScanError({ code: "invalid_selection", message: "…" })).toBe(true);
    expect(isScanError("Command not allowed")).toBe(false);
    expect(isScanError(null)).toBe(false);
    expect(isScanError(undefined)).toBe(false);
    expect(isScanError({ code: 5, message: "x" })).toBe(false);
    expect(isScanError({ code: "busy" })).toBe(false);
  });

  it("passes an invalid_selection rejection through untouched (filtered export)", async () => {
    const rejection = {
      code: "invalid_selection",
      message: "1 of 2 selected devices are not in the current report.",
    };
    invokeMock.mockRejectedValue(rejection);
    await expect(exportReport(["stale-id"])).rejects.toEqual(rejection);
  });
});
