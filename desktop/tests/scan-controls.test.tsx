// @vitest-environment jsdom
/**
 * ScanControls lifecycle tests (jsdom, fake timers). The native adapter is
 * mocked — no Tauri runtime, no real scan, no real dialog can ever run here.
 * Polling cadence, all five states, error-code guidance, cancel, busy
 * duplicate-start handling and poll-failure resilience are asserted through
 * the real React component.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/adapters/native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/native")>();
  return {
    ...actual,
    scanDevices: vi.fn(),
    getScanState: vi.fn(),
    getReport: vi.fn(),
    cancelScan: vi.fn(),
  };
});

import ScanControls from "../src/components/ScanControls";
import { cancelScan, getReport, getScanState, scanDevices } from "../src/adapters/native";
import { SCAN_REPORT } from "./fixtures/reports";

const scanDevicesMock = vi.mocked(scanDevices);
const getScanStateMock = vi.mocked(getScanState);
const getReportMock = vi.mocked(getReport);
const cancelScanMock = vi.mocked(cancelScan);

const IDLE = { state: "idle", generation: 0 } as const;
const RUNNING = { state: "running", generation: 1, startedMs: 1_700_000_000_000 } as const;

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const clickAsync = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element);
  });
  await flush();
};

const statusText = () => screen.getByRole("status").textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  scanDevicesMock.mockReset();
  getScanStateMock.mockReset();
  getReportMock.mockReset();
  cancelScanMock.mockReset();
  getScanStateMock.mockResolvedValue(IDLE);
  getReportMock.mockResolvedValue(null);
  cancelScanMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ScanControls — states", () => {
  it("renders the idle state with an enabled Start button and no Cancel", async () => {
    render(<ScanControls />);
    await flush();

    const start = screen.getByRole("button", { name: "Scan this PC" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Cancel scan" })).toBeNull();
    expect(statusText()).toContain("Ready");
  });

  it("runs the full lifecycle: start → running (disabled + cancel) → complete with device count", async () => {
    scanDevicesMock.mockResolvedValue(RUNNING);
    render(<ScanControls />);
    await flush();

    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));
    expect(scanDevicesMock).toHaveBeenCalledTimes(1);

    const scanning = screen.getByRole("button", { name: "Scanning…" }) as HTMLButtonElement;
    expect(scanning.disabled).toBe(true);
    expect(scanning.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Cancel scan" })).toBeTruthy();
    expect(statusText()).toContain("Reading Windows device and driver metadata");

    getScanStateMock.mockResolvedValue({ state: "complete", generation: 1, deviceCount: 412 });
    await advance(500);

    expect(statusText()).toContain("412 devices");
    expect((screen.getByRole("button", { name: "Scan this PC" }) as HTMLButtonElement).disabled).toBe(
      false
    );
    expect(screen.queryByRole("button", { name: "Cancel scan" })).toBeNull();
    // No consumer was provided: the completed report is never fetched.
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it("polls every 500 ms while running and stops at a terminal state", async () => {
    scanDevicesMock.mockResolvedValue(RUNNING);
    render(<ScanControls />);
    await flush();
    const mountCalls = getScanStateMock.mock.calls.length; // 1 (initial sync)

    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));
    expect(getScanStateMock.mock.calls.length).toBe(mountCalls);

    await advance(499);
    expect(getScanStateMock.mock.calls.length).toBe(mountCalls);
    await advance(1);
    expect(getScanStateMock.mock.calls.length).toBe(mountCalls + 1);

    getScanStateMock.mockResolvedValue({ state: "complete", generation: 1, deviceCount: 3 });
    await advance(500);
    const afterComplete = getScanStateMock.mock.calls.length;
    await advance(2000);
    expect(getScanStateMock.mock.calls.length).toBe(afterComplete);
  });

  it("stops polling when unmounted", async () => {
    scanDevicesMock.mockResolvedValue(RUNNING);
    const view = render(<ScanControls />);
    await flush();
    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));
    await advance(500);
    const calls = getScanStateMock.mock.calls.length;

    view.unmount();
    await advance(2000);
    expect(getScanStateMock.mock.calls.length).toBe(calls);
  });

  it("cancels a running scan and reflects the cancelled terminal state", async () => {
    scanDevicesMock.mockResolvedValue(RUNNING);
    render(<ScanControls />);
    await flush();
    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));

    await clickAsync(screen.getByRole("button", { name: "Cancel scan" }));
    expect(cancelScanMock).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("Cancelling");

    getScanStateMock.mockResolvedValue({ state: "cancelled", generation: 1, deviceCount: 0 });
    await advance(500);
    expect(statusText()).toContain("Scan cancelled");
    expect((screen.getByRole("button", { name: "Scan this PC" }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });
});

describe("ScanControls — failure handling", () => {
  it("maps a terminal error code to human guidance (executable_missing → PowerShell 7)", async () => {
    scanDevicesMock.mockResolvedValue(RUNNING);
    render(<ScanControls />);
    await flush();
    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));

    getScanStateMock.mockResolvedValue({
      state: "error",
      generation: 1,
      errorCode: "executable_missing",
    });
    await advance(500);

    expect(statusText()).toContain("PowerShell 7");
    expect(statusText()).toContain("winget install");
    expect(statusText()).toContain("(code: executable_missing)");

    // A new scan is allowed from the terminal error state.
    scanDevicesMock.mockResolvedValue({ state: "running", generation: 2, startedMs: 2 });
    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));
    expect(scanDevicesMock).toHaveBeenCalledTimes(2);
    expect(statusText()).toContain("Reading Windows device and driver metadata");
  });

  it("handles a duplicate start (busy) gracefully: notice + resync + polling", async () => {
    getScanStateMock
      .mockResolvedValueOnce(IDLE)
      .mockResolvedValue({ state: "running", generation: 1, startedMs: 1 });
    scanDevicesMock.mockRejectedValue({ code: "busy", message: "A scan is already running." });
    render(<ScanControls />);
    await flush();

    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));
    expect(statusText()).toContain("A scan is already running — showing its progress.");
    expect(screen.getByRole("button", { name: "Cancel scan" })).toBeTruthy();

    getScanStateMock.mockResolvedValue({ state: "complete", generation: 1, deviceCount: 7 });
    await advance(500);
    expect(statusText()).toContain("7 devices");
  });

  it("surfaces a start rejection with the backend message and code", async () => {
    scanDevicesMock.mockRejectedValue({
      code: "io",
      message: "An unexpected operating system error occurred.",
    });
    render(<ScanControls />);
    await flush();
    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));

    expect(statusText()).toContain("unexpected operating system error");
    expect(statusText()).toContain("(io)");
  });

  it("keeps polling through a transient poll failure and self-heals", async () => {
    getScanStateMock
      .mockResolvedValueOnce(IDLE) // mount sync
      .mockRejectedValueOnce("Command get_scan_state not allowed.") // first poll fails
      .mockResolvedValue(RUNNING); // later polls recover
    scanDevicesMock.mockResolvedValue(RUNNING);
    render(<ScanControls />);
    await flush();
    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));

    await advance(500);
    expect(statusText()).toContain("could not be refreshed");
    expect(screen.getByRole("status").className).toContain("scan__status--error");

    await advance(500); // the next poll succeeds again
    expect(statusText()).toContain("Reading Windows device and driver metadata");
  });

  it("reports an unreadable initial state instead of pretending idle", async () => {
    getScanStateMock.mockReset();
    getScanStateMock.mockRejectedValue("Command get_scan_state not allowed.");
    render(<ScanControls />);
    await flush();

    expect(statusText()).toContain("Could not read the current scan state");
    expect(screen.getByRole("status").className).toContain("scan__status--error");
  });
});

describe("ScanControls — completed-scan report delivery (get_report)", () => {
  it("fetches the completed scan's report once per generation and delivers it validated", async () => {
    const onScanReport = vi.fn();
    scanDevicesMock.mockResolvedValue(RUNNING);
    getScanStateMock
      .mockResolvedValueOnce(IDLE) // mount sync
      .mockResolvedValue({ state: "complete", generation: 1, deviceCount: 3 });
    getReportMock.mockResolvedValue(SCAN_REPORT);
    render(<ScanControls onScanReport={onScanReport} />);
    await flush();

    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));
    expect(getReportMock).not.toHaveBeenCalled();

    await advance(500);
    await flush();
    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(onScanReport).toHaveBeenCalledTimes(1);
    expect(onScanReport.mock.calls[0][0]).toEqual(SCAN_REPORT);

    // Polling stopped at complete; a stable complete state never re-fetches.
    await advance(2000);
    await flush();
    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(onScanReport).toHaveBeenCalledTimes(1);
  });

  it("also fetches when a complete state is first observed at mount (scan finished earlier)", async () => {
    const onScanReport = vi.fn();
    getScanStateMock.mockResolvedValue({ state: "complete", generation: 4, deviceCount: 3 });
    getReportMock.mockResolvedValue(SCAN_REPORT);
    render(<ScanControls onScanReport={onScanReport} />);
    await flush();

    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(onScanReport).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("3 devices");
  });

  it("refuses an invalid scan report payload instead of delivering it", async () => {
    const onScanReport = vi.fn();
    scanDevicesMock.mockResolvedValue(RUNNING);
    getScanStateMock
      .mockResolvedValueOnce(IDLE)
      .mockResolvedValue({ state: "complete", generation: 1, deviceCount: 3 });
    getReportMock.mockResolvedValue({ schemaVersion: 2, devices: [] } as never);
    render(<ScanControls onScanReport={onScanReport} />);
    await flush();

    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));
    await advance(500);
    await flush();

    expect(onScanReport).not.toHaveBeenCalled();
    expect(statusText()).toContain("could not be displayed");
    expect(statusText()).toContain("schemaVersion");
  });

  it("retries a failed get_report once, then surfaces the failure (bounded, no guessing)", async () => {
    const onScanReport = vi.fn();
    scanDevicesMock.mockResolvedValue(RUNNING);
    getScanStateMock
      .mockResolvedValueOnce(IDLE)
      .mockResolvedValue({ state: "complete", generation: 1, deviceCount: 3 });
    getReportMock.mockRejectedValue({
      code: "io",
      message: "An unexpected operating system error occurred.",
    });
    render(<ScanControls onScanReport={onScanReport} />);
    await flush();

    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));
    await advance(500);
    await flush();

    // First failure: exactly one bounded retry is scheduled — no notice yet.
    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(statusText()).not.toContain("could not be loaded");

    await advance(1500);
    await flush();

    // The retry failed too: the failure is surfaced and nothing was guessed.
    expect(getReportMock).toHaveBeenCalledTimes(2);
    expect(onScanReport).not.toHaveBeenCalled();
    expect(statusText()).toContain("could not be loaded");
    expect(statusText()).toContain("(io)");

    // Bounded: no further attempts are ever made.
    await advance(5000);
    await flush();
    expect(getReportMock).toHaveBeenCalledTimes(2);
  });

  it("delivers the report when the single retry succeeds after a transient failure", async () => {
    const onScanReport = vi.fn();
    scanDevicesMock.mockResolvedValue(RUNNING);
    getScanStateMock
      .mockResolvedValueOnce(IDLE)
      .mockResolvedValue({ state: "complete", generation: 1, deviceCount: 3 });
    getReportMock
      .mockRejectedValueOnce("Command get_report not allowed.") // transient hiccup
      .mockResolvedValue(SCAN_REPORT);
    render(<ScanControls onScanReport={onScanReport} />);
    await flush();

    await clickAsync(screen.getByRole("button", { name: "Scan this PC" }));
    await advance(500);
    await flush();

    expect(getReportMock).toHaveBeenCalledTimes(1);
    expect(onScanReport).not.toHaveBeenCalled();

    await advance(1500);
    await flush();

    expect(getReportMock).toHaveBeenCalledTimes(2);
    expect(onScanReport).toHaveBeenCalledTimes(1);
    expect(onScanReport.mock.calls[0][0]).toEqual(SCAN_REPORT);
    expect(statusText()).not.toContain("could not be loaded");
  });
});
