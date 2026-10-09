// @vitest-environment jsdom
/**
 * App-level workflow tests (jsdom): import success / failure / cancel,
 * sample loading, export (full + exactly-filtered), failed writes, sample
 * badge, stats/meta, bounded rendering through the real App, escaping, and a
 * keyboard-driven import. The native adapter is mocked — no Tauri runtime,
 * no real dialog, no real scan.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { exportReport, getReport, getScanState, openReport, scanDevices } from "../src/adapters/native";
import { validateReport } from "../src/contracts/validate-report";
import { HOSTILE_REPORT, largeReport, LOCAL_REPORT, SCAN_REPORT } from "./fixtures/reports";

const openReportMock = vi.mocked(openReport);
const exportReportMock = vi.mocked(exportReport);

beforeEach(() => {
  vi.mocked(getScanState).mockReset();
  vi.mocked(getScanState).mockResolvedValue({ state: "idle", generation: 0 });
  vi.mocked(scanDevices).mockReset();
  vi.mocked(getReport).mockReset();
  vi.mocked(getReport).mockResolvedValue(null);
  openReportMock.mockReset();
  exportReportMock.mockReset();
});

afterEach(() => {
  cleanup();
});

const user = () => userEvent.setup();

/** Load the bundled fictional sample through the visible button. */
async function loadSample(): Promise<void> {
  await user().click(screen.getByRole("button", { name: "Load sample" }));
  await screen.findByText(/Sample report loaded/);
}

describe("App — initial state", () => {
  it("shows no report, disabled device controls and disabled exports", async () => {
    render(<App />);
    expect(screen.getByText("No report loaded.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Export full" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Export filtered/ }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("searchbox", { name: "Search devices" }) as HTMLInputElement).disabled
    ).toBe(true);
    // The scan panel settles into its idle state.
    expect(await screen.findByText(/Ready\. Scans read this PC's device and driver metadata locally/)).toBeTruthy();
  });
});

describe("App — sample loading", () => {
  it("loads the bundled fictional sample, keeps the chip, stats and meta", async () => {
    render(<App />);
    await loadSample();

    // Chip kept for sample data.
    expect(screen.getByText("Fictional sample data")).toBeTruthy();
    // Devices from the bundled asset rendered.
    expect(screen.getByText("Contoso USB Serial Adapter (synthetic)")).toBeTruthy();
    expect(screen.getByText("Adventure Works Legacy Controller (synthetic)")).toBeTruthy();
    // Stats row (browser counting rules: 2 devices, 1 review, 2 known).
    const stats = screen.getByRole("region", { name: "Report statistics" });
    expect(within(stats).getByText("Devices").previousElementSibling?.textContent).toBe("2");
    expect(within(stats).getByText("Need review").previousElementSibling?.textContent).toBe("1");
    expect(within(stats).getByText("OS architecture").previousElementSibling?.textContent).toBe(
      "ARM64"
    );
    // Meta line: sample label + generatedAt passthrough.
    expect(screen.getByText(/2 of 2 devices · Synthetic Windows machine · Sample data/)).toBeTruthy();
  });
});

describe("App — import flows", () => {
  it("imports a local report, resets filters and says nothing was uploaded", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    // Dirty the filters first; a successful import must reset them.
    await u.type(screen.getByRole("searchbox", { name: "Search devices" }), "zzz-no-match");
    expect(await screen.findByText("No devices match these filters.")).toBeTruthy();

    openReportMock.mockResolvedValueOnce(LOCAL_REPORT);
    await u.click(screen.getByRole("button", { name: "Open report…" }));

    expect(await screen.findByText("Local report loaded. No data was uploaded.")).toBeTruthy();
    expect(screen.getByText("Test USB Serial Adapter")).toBeTruthy();
    expect((screen.getByRole("searchbox", { name: "Search devices" }) as HTMLInputElement).value).toBe(
      ""
    );
  });

  it("keeps the previous report when an import does not validate", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    openReportMock.mockResolvedValueOnce({ schemaVersion: 2, devices: [] } as never);
    await u.click(screen.getByRole("button", { name: "Open report…" }));

    const error = await screen.findByText(/Import failed —/);
    expect(error.textContent).toContain("The previous report is still shown.");
    // The previous (sample) report is still displayed.
    expect(screen.getByText("Contoso USB Serial Adapter (synthetic)")).toBeTruthy();
  });

  it("keeps the previous report when the backend rejects the file", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    openReportMock.mockRejectedValueOnce({
      code: "invalid_report",
      message: "The selected file is not valid JSON.",
    });
    await u.click(screen.getByRole("button", { name: "Open report…" }));

    const error = await screen.findByText(/Import failed —/);
    expect(error.textContent).toContain("The selected file is not valid JSON.");
    expect(error.textContent).toContain("(invalid_report)");
    expect(error.textContent).toContain("The previous report is still shown.");
    expect(screen.getByText("Contoso USB Serial Adapter (synthetic)")).toBeTruthy();
  });

  it("treats a cancelled dialog as a no-op", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    openReportMock.mockResolvedValueOnce(null);
    await u.click(screen.getByRole("button", { name: "Open report…" }));

    expect(await screen.findByText("Open cancelled — no report was changed.")).toBeTruthy();
    expect(screen.getByText("Contoso USB Serial Adapter (synthetic)")).toBeTruthy();
  });
});

describe("App — exports", () => {
  it("exports the full report with no arguments", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    exportReportMock.mockResolvedValueOnce({ bytesWritten: 2048 });
    await u.click(screen.getByRole("button", { name: "Export full" }));

    expect(await screen.findByText("Full report exported — 2,048 bytes written.")).toBeTruthy();
    // Exactly a zero-argument call: the full export path.
    expect(exportReportMock).toHaveBeenCalledWith();
  });

  it("exports exactly the filtered device ids (and says how many)", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    await u.type(screen.getByRole("searchbox", { name: "Search devices" }), "Contoso");
    const filterButton = screen.getByRole("button", { name: "Export filtered (1)" });

    exportReportMock.mockResolvedValueOnce({ bytesWritten: 999 });
    await u.click(filterButton);

    expect(exportReportMock).toHaveBeenCalledWith(["SYN0000000000001"]);
    expect(await screen.findByText("Filtered report exported — 1 device in 999 bytes.")).toBeTruthy();
  });

  it("surfaces a failed write and changes nothing", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    exportReportMock.mockRejectedValueOnce({
      code: "io",
      message: "An unexpected operating system error occurred.",
    });
    await u.click(screen.getByRole("button", { name: "Export full" }));

    const error = await screen.findByText(/Export failed —/);
    expect(error.textContent).toContain("(io)");
    expect(screen.getByText("Contoso USB Serial Adapter (synthetic)")).toBeTruthy();
  });

  it("treats a cancelled save dialog as a no-op", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    exportReportMock.mockResolvedValueOnce(null);
    await u.click(screen.getByRole("button", { name: "Export full" }));

    expect(await screen.findByText("Save cancelled — nothing was exported.")).toBeTruthy();
  });
});

describe("App — scale, escaping, keyboard", () => {
  it("keeps rendering bounded for a 20,000-device import", async () => {
    render(<App />);
    const u = user();

    openReportMock.mockResolvedValueOnce(largeReport(20_000));
    await u.click(screen.getByRole("button", { name: "Open report…" }));
    await screen.findByText(/Local report loaded/);

    const table = screen.getByRole("table");
    expect(table.querySelectorAll("tr.device-row")).toHaveLength(50);
    expect(screen.getByText(/Page 1 of 400/)).toBeTruthy();
    expect(
      screen.getByText(/20,000 of 20,000 devices · Synthetic Windows · Local inventory/)
    ).toBeTruthy();
  });

  it("renders hostile imported strings as text only", async () => {
    render(<App />);
    const u = user();

    openReportMock.mockResolvedValueOnce(HOSTILE_REPORT);
    await u.click(screen.getByRole("button", { name: "Open report…" }));
    await screen.findByText(/Local report loaded/);

    expect(document.querySelector("script, style, img, iframe, svg")).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
    expect(screen.getByText('"><script>window.__pwned = 1;</script>')).toBeTruthy();
  });

  it("reaches Open report with the keyboard and activates it with Enter", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    // Tab order: Start scan → Open report… (first tabbable after the scan panel).
    (document.activeElement as HTMLElement | null)?.blur();
    await u.tab();
    await u.tab();
    const openButton = screen.getByRole("button", { name: "Open report…" });
    expect(document.activeElement).toBe(openButton);

    openReportMock.mockResolvedValueOnce(null);
    await u.keyboard("{Enter}");
    expect(openReportMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Open cancelled — no report was changed.")).toBeTruthy();
  });
});

describe("App — completed scan display (get_report)", () => {
  it("renders the completed scan's report in the device table; the sample chip follows the report", async () => {
    const u = user();
    vi.mocked(scanDevices).mockResolvedValue({
      state: "running",
      generation: 1,
      startedMs: 1_700_000_000_000,
    });
    vi.mocked(getScanState)
      .mockResolvedValueOnce({ state: "idle", generation: 0 }) // mount sync
      .mockResolvedValue({ state: "complete", generation: 1, deviceCount: 3 }); // poll
    vi.mocked(getReport).mockResolvedValue(SCAN_REPORT);

    render(<App />);
    await screen.findByText(/Ready\./);

    await u.click(screen.getByRole("button", { name: "Scan this PC" }));

    // The scan reaches Complete (poll), the report is fetched via get_report
    // and rendered through the same table path as imports.
    expect(
      await screen.findByText("Test Scanned Adapter", undefined, { timeout: 3_000 })
    ).toBeTruthy();
    expect(vi.mocked(getReport)).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("tr.device-row")).toHaveLength(3);
    expect(screen.getByText("Test Scanned Controller")).toBeTruthy();
    expect(screen.getByText(/3 of 3 devices · Test Windows · Local inventory/)).toBeTruthy();
    // A real scan report replaces the sample: no fictional-sample chip.
    expect(screen.queryByText("Fictional sample data")).toBeNull();
    // The lifecycle line still reports the collected count.
    expect(screen.getByText(/3 devices collected locally/)).toBeTruthy();

    // Loading the bundled sample replaces the scan report and re-shows the chip.
    await u.click(screen.getByRole("button", { name: "Load sample" }));
    await screen.findByText("Fictional sample data");
    expect(screen.getByText("Contoso USB Serial Adapter (synthetic)")).toBeTruthy();
    expect(screen.queryByText("Test Scanned Adapter")).toBeNull();
  });

  it("keeps the table empty and says so when the completed scan's report cannot be loaded", async () => {
    const u = user();
    vi.mocked(scanDevices).mockResolvedValue({
      state: "running",
      generation: 1,
      startedMs: 1_700_000_000_000,
    });
    vi.mocked(getScanState)
      .mockResolvedValueOnce({ state: "idle", generation: 0 })
      .mockResolvedValue({ state: "complete", generation: 1, deviceCount: 3 });
    vi.mocked(getReport).mockRejectedValue("Command get_report not allowed.");

    render(<App />);
    await screen.findByText(/Ready\./);
    await u.click(screen.getByRole("button", { name: "Scan this PC" }));

    expect(
      await screen.findByText(/The scan report could not be loaded/, undefined, { timeout: 5_000 })
    ).toBeTruthy();
    // The single bounded retry was attempted before the failure was surfaced.
    expect(vi.mocked(getReport)).toHaveBeenCalledTimes(2);
    // Nothing was guessed into the table.
    expect(document.querySelectorAll("tr.device-row")).toHaveLength(0);
    expect(screen.getByText("No report loaded.")).toBeTruthy();
  });
});

describe("App — hostile strings survive the whole flow", () => {
  it("renders script-like strings as text and exports exactly the hostile device id", async () => {
    render(<App />);
    const u = user();

    openReportMock.mockResolvedValueOnce(HOSTILE_REPORT);
    await u.click(screen.getByRole("button", { name: "Open report…" }));
    await screen.findByText(/Local report loaded/);

    // Rendered as text nodes only — no element injection anywhere.
    expect(document.querySelector("script, style, img, iframe, svg")).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
    expect(screen.getByText('\"><script>window.__pwned = 1;</script>')).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=window.__pwned=2>")).toBeTruthy();

    // Select exactly the hostile device and export it by id.
    await u.type(screen.getByRole("searchbox", { name: "Search devices" }), "pwned");
    exportReportMock.mockResolvedValueOnce({ bytesWritten: 512 });
    await u.click(screen.getByRole("button", { name: "Export filtered (1)" }));
    expect(exportReportMock).toHaveBeenCalledWith(["EVIL001"]);
    expect(await screen.findByText(/Filtered report exported/)).toBeTruthy();

    // Byte-preservation through the shared pipeline: the contract validator
    // is the same one the app runs on every import; it must hand the hostile
    // strings through unchanged. (The byte-level file write is proven by the
    // Rust suite's hostile round-trip test in src-tauri/src/scan.rs.)
    const source = HOSTILE_REPORT.devices[0];
    const selection = JSON.parse(
      JSON.stringify({
        ...HOSTILE_REPORT,
        devices: HOSTILE_REPORT.devices.filter((d) => d.id === "EVIL001"),
        filterNote: "Filtered export from DriverLens",
      })
    );
    const result = validateReport(selection);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const roundTripped = result.report.devices[0];
      expect(JSON.stringify(roundTripped)).toBe(JSON.stringify(source));
      expect(roundTripped.name).toBe(source.name);
      expect(roundTripped.provider).toBe(source.provider);
      expect(roundTripped.notes).toEqual(source.notes);
      expect(JSON.stringify(roundTripped)).not.toContain("&lt;");
    }
  });
});

describe("App — rejected and cancelled dialogs keep the previous state", () => {
  it("keeps the previous report when the import is denied at the ACL (string rejection)", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    openReportMock.mockRejectedValueOnce("Command open_report not allowed.");
    await u.click(screen.getByRole("button", { name: "Open report…" }));

    const error = await screen.findByText(/Import failed —/);
    expect(error.textContent).toContain("Command open_report not allowed.");
    expect(error.textContent).toContain("The previous report is still shown.");
    expect(screen.getByText("Contoso USB Serial Adapter (synthetic)")).toBeTruthy();
  });

  it("keeps the previous report when a filtered export is rejected", async () => {
    render(<App />);
    const u = user();
    await loadSample();
    await u.type(screen.getByRole("searchbox", { name: "Search devices" }), "Contoso");

    exportReportMock.mockRejectedValueOnce({
      code: "invalid_selection",
      message: "1 of 1 selected devices are not in the current report.",
    });
    await u.click(screen.getByRole("button", { name: "Export filtered (1)" }));

    const error = await screen.findByText(/Export failed —/);
    expect(error.textContent).toContain("(invalid_selection)");
    expect(error.textContent).toContain("not in the current report");
    expect(screen.getByText("Contoso USB Serial Adapter (synthetic)")).toBeTruthy();
  });

  it("treats a cancelled filtered save as a no-op", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    exportReportMock.mockResolvedValueOnce(null);
    await u.click(screen.getByRole("button", { name: "Export filtered (2)" }));
    expect(await screen.findByText("Save cancelled — nothing was exported.")).toBeTruthy();
    expect(exportReportMock).toHaveBeenCalledWith(["SYN0000000000001", "SYN0000000000002"]);
  });
});
