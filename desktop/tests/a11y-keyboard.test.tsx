// @vitest-environment jsdom
/**
 * Keyboard + live-announcement regression tests (Task 13).
 *
 * REAL interface assertions (not static strings): user-event drives real
 * Tab/Enter/Space key events through the actual App and DeviceTable DOM; the
 * tab order is asserted stop-by-stop; Enter/Space activate the evidence
 * expanders and the pager; role=status regions are queried by role and
 * checked across scan transitions; aria-busy is asserted on the Start button
 * while a scan runs.
 *
 * jsdom limits (honest): jsdom has no CSS engine, so `:focus-visible`
 * styling cannot be observed here — the stylesheet's focus-visible rules are
 * asserted statically in styles-a11y.test.ts, and the rendered focus ring is
 * deferred to the native/manual matrix (notes/ACCESSIBILITY-PRIVACY-NOTES.md).
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
import {
  cancelScan,
  getReport,
  getScanState,
  scanDevices,
  type ScanSnapshot,
} from "../src/adapters/native";
import DeviceTable from "../src/components/DeviceTable";
import { DEFAULT_QUERY } from "../src/lib/filters";
import { largeReport, LOCAL_REPORT } from "./fixtures/reports";

const scanDevicesMock = vi.mocked(scanDevices);
const getScanStateMock = vi.mocked(getScanState);
const getReportMock = vi.mocked(getReport);
const cancelScanMock = vi.mocked(cancelScan);

const RUNNING: ScanSnapshot = {
  state: "running",
  generation: 1,
  startedMs: 1_700_000_000_000,
};

beforeEach(() => {
  scanDevicesMock.mockReset();
  getScanStateMock.mockReset();
  getReportMock.mockReset();
  cancelScanMock.mockReset();
  getScanStateMock.mockResolvedValue({ state: "idle", generation: 0 });
  getReportMock.mockResolvedValue(null);
  cancelScanMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

const user = () => userEvent.setup();

async function loadSample(): Promise<void> {
  await user().click(screen.getByRole("button", { name: "Load sample" }));
  await screen.findByText(/Sample report loaded/);
}

describe("App — full keyboard tab order", () => {
  it("reaches Start scan, import/export and every filter in DOM order", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    const expected: Array<[string, () => HTMLElement]> = [
      ["Start scan", () => screen.getByRole("button", { name: "Scan this PC" })],
      ["import (Open report…)", () => screen.getByRole("button", { name: "Open report…" })],
      ["Load sample", () => screen.getByRole("button", { name: "Load sample" })],
      ["Export full", () => screen.getByRole("button", { name: "Export full" })],
      ["Export filtered", () => screen.getByRole("button", { name: "Export filtered (2)" })],
      ["Search filter", () => screen.getByRole("searchbox", { name: "Search devices" })],
      ["Status filter", () => screen.getByRole("combobox", { name: "Review status" })],
      ["Architecture filter", () => screen.getByRole("combobox", { name: "Architecture" })],
      ["Bus filter", () => screen.getByRole("combobox", { name: "Bus" })],
      ["Evidence expander (device 1)", () => screen.getAllByRole("button", { name: "Evidence" })[0]],
      ["Evidence expander (device 2)", () => screen.getAllByRole("button", { name: "Evidence" })[1]],
    ];

    (document.activeElement as HTMLElement | null)?.blur();
    for (const [label, get] of expected) {
      await u.tab();
      expect(document.activeElement, `tab stop: ${label}`).toBe(get());
    }
  });

  it("keeps Start → Cancel → filters → import/export reachable while a scan runs", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    scanDevicesMock.mockResolvedValue(RUNNING);
    getScanStateMock.mockResolvedValue(RUNNING);

    // Start the scan from the keyboard: tab to Start and activate with Enter.
    (document.activeElement as HTMLElement | null)?.blur();
    await u.tab();
    const start = screen.getByRole("button", { name: "Scan this PC" });
    expect(document.activeElement).toBe(start);
    await u.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Cancel scan" });
    expect(scanDevicesMock).toHaveBeenCalledTimes(1);

    // While running, Start is disabled (skipped by Tab); Cancel is the next
    // stop and must be Enter-activatable.
    const cancel = screen.getByRole("button", { name: "Cancel scan" });
    await u.tab();
    expect(document.activeElement, "tab stop: Cancel").toBe(cancel);
    await u.keyboard("{Enter}");
    expect(cancelScanMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Cancelling the scan/)).toBeTruthy();

    // The rest of the flow stays reachable in DOM order.
    const expected: Array<[string, () => HTMLElement]> = [
      ["import (Open report…)", () => screen.getByRole("button", { name: "Open report…" })],
      ["Load sample", () => screen.getByRole("button", { name: "Load sample" })],
      ["Export full", () => screen.getByRole("button", { name: "Export full" })],
      ["Export filtered", () => screen.getByRole("button", { name: "Export filtered (2)" })],
      ["Search filter", () => screen.getByRole("searchbox", { name: "Search devices" })],
      ["Status filter", () => screen.getByRole("combobox", { name: "Review status" })],
      ["Architecture filter", () => screen.getByRole("combobox", { name: "Architecture" })],
      ["Bus filter", () => screen.getByRole("combobox", { name: "Bus" })],
    ];
    for (const [label, get] of expected) {
      await u.tab();
      expect(document.activeElement, `tab stop: ${label}`).toBe(get());
    }
  });
});

describe("DeviceTable — Enter/Space activation", () => {
  it("activates the evidence expander with Enter and Space", async () => {
    const u = user();
    const { container } = render(
      <DeviceTable
        devices={LOCAL_REPORT.devices.slice(0, 1)}
        query={DEFAULT_QUERY}
        onQueryChange={() => {}}
        hasReport
      />
    );
    const toggle = screen.getByRole("button", { name: "Evidence" });

    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    await u.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("tr.device-detail")).toBeTruthy();

    await u.keyboard(" ");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("tr.device-detail")).toBeNull();
  });

  it("reaches the pager by keyboard and pages with Enter and Space", async () => {
    const u = user();
    const report = largeReport(75); // two pages: 50 + 25
    render(
      <DeviceTable
        devices={report.devices}
        query={DEFAULT_QUERY}
        onQueryChange={() => {}}
        hasReport
      />
    );

    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    const previous = screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);

    // Keyboard reachability: bounded tab walk until focus lands on Next.
    (document.activeElement as HTMLElement | null)?.blur();
    let reached = false;
    for (let i = 0; i < 80 && !reached; i += 1) {
      await u.tab();
      reached = document.activeElement === next;
    }
    expect(reached, "Next must be keyboard-reachable").toBe(true);

    await u.keyboard("{Enter}");
    expect(screen.getByText(/Page 2 of 2/)).toBeTruthy();
    expect(previous.disabled).toBe(false);

    previous.focus();
    await u.keyboard(" ");
    expect(screen.getByText(/Page 1 of 2/)).toBeTruthy();
    expect(previous.disabled).toBe(true);
  });
});

describe("App — every interactive control has an accessible name", () => {
  /**
   * Approximate accessible-name sources used in this app (aria-label,
   * aria-labelledby, a wrapping <label>, or button text). The per-control
   * getByRole queries in this file are the authoritative check — they run
   * testing-library's real accessible-name computation; this sweep exists to
   * catch a NEW control that has no name at all.
   */
  function approximateAccessibleName(el: Element): string {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel !== null && ariaLabel.trim() !== "") return ariaLabel.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (text !== "") return text;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      const wrapping = el.closest("label");
      return wrapping === null ? "" : (wrapping.textContent ?? "").trim();
    }
    return (el.textContent ?? "").trim();
  }

  it("names every control in the no-report state and in the loaded state", async () => {
    const { container } = render(<App />);
    await screen.findByText(/Ready\./);

    for (const el of container.querySelectorAll("button, input, select, a[href]")) {
      expect(
        approximateAccessibleName(el),
        `${el.tagName}.${el.className} must have an accessible name`
      ).not.toBe("");
    }

    await loadSample();
    for (const el of container.querySelectorAll("button, input, select, a[href]")) {
      expect(
        approximateAccessibleName(el),
        `${el.tagName}.${el.className} must have an accessible name`
      ).not.toBe("");
    }

    // Authoritative per-control queries (accessible names as computed by
    // testing-library's role engine).
    expect(screen.getByRole("button", { name: "Scan this PC" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open report…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load sample" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export full" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export filtered (2)" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search devices" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Review status" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Architecture" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Bus" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Evidence" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Previous" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Device table pages" })).toBeTruthy();
  });
});

describe("App — live status and busy announcements", () => {
  it("announces each scan transition through role=status and flags the running button aria-busy", async () => {
    render(<App />);
    const u = user();
    const scanRegion = screen.getByRole("region", { name: "Device scan" });

    // Idle: the status region speaks the ready message.
    const idleStatus = await within(scanRegion).findByText(/Ready\./);
    expect(idleStatus.getAttribute("role")).toBe("status");

    // Running: the same region announces progress; Start carries aria-busy.
    scanDevicesMock.mockResolvedValue(RUNNING);
    getScanStateMock.mockResolvedValue(RUNNING);
    const start = screen.getByRole("button", { name: "Scan this PC" }) as HTMLButtonElement;
    expect(start.getAttribute("aria-busy")).toBe("false");
    await u.click(start);

    const running = await within(scanRegion).findByText(
      /Reading Windows device and driver metadata/
    );
    expect(running.getAttribute("role")).toBe("status");
    const scanning = screen.getByRole("button", { name: "Scanning…" }) as HTMLButtonElement;
    expect(scanning.disabled).toBe(true);
    expect(scanning.getAttribute("aria-busy")).toBe("true");

    // Cancelled: the scan finishes as cancelled (the poll observes it) and
    // the region announces the terminal state; the button is busy-free again.
    getScanStateMock.mockResolvedValue({ state: "cancelled", generation: 1 });
    await u.click(screen.getByRole("button", { name: "Cancel scan" }));
    const cancelled = await within(scanRegion).findByText(/Scan cancelled/, {}, { timeout: 3_000 });
    expect(cancelled.getAttribute("role")).toBe("status");
    const again = await screen.findByRole("button", { name: "Scan this PC" });
    expect(again.getAttribute("aria-busy")).toBe("false");
  });

  it("reports import outcomes through the Report panel's role=status", async () => {
    render(<App />);
    const reportRegion = screen.getByRole("region", { name: "Report" });

    const initial = within(reportRegion).getByRole("status");
    expect(initial.textContent).toContain("No report loaded.");

    await loadSample();
    expect(within(reportRegion).getByRole("status").textContent).toContain("Sample report loaded");
  });
});
