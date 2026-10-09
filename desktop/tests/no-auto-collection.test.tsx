// @vitest-environment jsdom
/**
 * Startup privacy (Task 13): mounting the app must never start a collection.
 * The only IPC at mount is the read-only `get_scan_state` sync — `scan_devices`
 * must not be called until the user activates Start, even when a scan is
 * already running (the UI observes it; it never (re)starts one).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/adapters/native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/native")>();
  return {
    ...actual,
    scanDevices: vi.fn(),
    getScanState: vi.fn(),
    getReport: vi.fn(),
    cancelScan: vi.fn(),
    openReport: vi.fn(),
    exportReport: vi.fn(),
  };
});

import App from "../src/App";
import { cancelScan, getReport, getScanState, scanDevices } from "../src/adapters/native";

const scanDevicesMock = vi.mocked(scanDevices);
const getScanStateMock = vi.mocked(getScanState);
const getReportMock = vi.mocked(getReport);

beforeEach(() => {
  scanDevicesMock.mockReset();
  getScanStateMock.mockReset();
  getReportMock.mockReset();
  vi.mocked(cancelScan).mockReset();
  getScanStateMock.mockResolvedValue({ state: "idle", generation: 0 });
  getReportMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

describe("App — no automatic collection at startup", () => {
  it("never calls scan_devices on mount; the only startup IPC is the read-only state sync", async () => {
    render(<App />);
    await screen.findByText(/Ready\./); // mount sync + first render settled

    expect(scanDevicesMock).not.toHaveBeenCalled();
    expect(getScanStateMock).toHaveBeenCalled(); // read-only observation is allowed
    expect(getReportMock).not.toHaveBeenCalled(); // idle: nothing to fetch
  });

  it("observing an already-running scan does not start one", async () => {
    getScanStateMock.mockResolvedValue({
      state: "running",
      generation: 7,
      startedMs: 1_700_000_000_000,
    });
    render(<App />);

    // The running state is observed and rendered (Cancel appears)...
    expect(await screen.findByRole("button", { name: "Cancel scan" })).toBeTruthy();
    expect(screen.getByText(/Reading Windows device and driver metadata/)).toBeTruthy();
    // ...but the app never started a scan on its own.
    expect(scanDevicesMock).not.toHaveBeenCalled();
  });
});
