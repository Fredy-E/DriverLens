// @vitest-environment jsdom
/**
 * Export HTML report UI flows (E-03): the action is disabled until a report
 * is loaded; redaction is ON by default; the 'Include device identifiers'
 * checkbox opts in; success/cancel/failure feedback mirrors the existing
 * export lines; the controls are keyboard accessible and labeled. The native
 * adapter is mocked — no Tauri runtime, no real dialog.
 */
import { cleanup, render, screen } from "@testing-library/react";
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
    exportHtmlReport: vi.fn(),
  };
});

import App from "../src/App";
import { exportHtmlReport, getReport, getScanState } from "../src/adapters/native";

const exportHtmlReportMock = vi.mocked(exportHtmlReport);

beforeEach(() => {
  vi.mocked(getScanState).mockReset();
  vi.mocked(getScanState).mockResolvedValue({ state: "idle", generation: 0 });
  vi.mocked(getReport).mockReset();
  vi.mocked(getReport).mockResolvedValue(null);
  exportHtmlReportMock.mockReset();
});

afterEach(() => {
  cleanup();
});

const user = () => userEvent.setup();

async function loadSample(): Promise<void> {
  await user().click(screen.getByRole("button", { name: "Load sample" }));
  await screen.findByText(/Sample report loaded/);
}

const htmlButton = () => screen.getByRole("button", { name: "Export HTML report…" }) as HTMLButtonElement;
const identifierCheckbox = () =>
  screen.getByRole("checkbox", { name: "Include device identifiers" }) as HTMLInputElement;

describe("App — Export HTML report action state", () => {
  it("keeps the action and the opt-in disabled until a report is loaded, and shows the redaction helper text", async () => {
    render(<App />);
    expect(htmlButton().disabled).toBe(true);
    expect(identifierCheckbox().disabled).toBe(true);
    expect(identifierCheckbox().checked).toBe(false);
    expect(
      screen.getByText("Redacted by default — identifiers are replaced with D01, D02 …")
    ).toBeTruthy();
  });

  it("enables both with a report loaded", async () => {
    render(<App />);
    await loadSample();
    expect(htmlButton().disabled).toBe(false);
    expect(identifierCheckbox().disabled).toBe(false);
  });
});

describe("App — Export HTML report flows", () => {
  it("exports a redacted document by default (ordinals; digests stay out)", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    exportHtmlReportMock.mockResolvedValueOnce({ bytesWritten: 4096 });
    await u.click(htmlButton());

    expect(await screen.findByText("HTML report exported — 4,096 bytes written.")).toBeTruthy();
    expect(exportHtmlReportMock).toHaveBeenCalledTimes(1);
    const [html, suggestedName] = exportHtmlReportMock.mock.calls[0];
    expect(suggestedName).toBe("driverlens-report.html");
    expect(html).toContain("D01");
    expect(html).not.toContain("SYN0000000000001");
    expect(html).toContain("What is redacted");
  });

  it("includes the digests only when the checkbox is on", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    await u.click(identifierCheckbox());
    expect(identifierCheckbox().checked).toBe(true);

    exportHtmlReportMock.mockResolvedValueOnce({ bytesWritten: 2048 });
    await u.click(htmlButton());

    const [html] = exportHtmlReportMock.mock.calls[0];
    expect(html).toContain("SYN0000000000001");
    expect(html).not.toContain("D01");
    expect(html).not.toContain("What is redacted");
  });

  it("toggles the checkbox with the keyboard (Space) and activates the action with Enter", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    identifierCheckbox().focus();
    await u.keyboard(" ");
    expect(identifierCheckbox().checked).toBe(true);

    htmlButton().focus();
    exportHtmlReportMock.mockResolvedValueOnce({ bytesWritten: 100 });
    await u.keyboard("{Enter}");
    expect(exportHtmlReportMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/HTML report exported/)).toBeTruthy();
  });

  it("treats a cancelled save dialog as a no-op", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    exportHtmlReportMock.mockResolvedValueOnce(null);
    await u.click(htmlButton());

    expect(await screen.findByText("Save cancelled — nothing was exported.")).toBeTruthy();
  });

  it("surfaces a refused or failed write through the shared error line", async () => {
    render(<App />);
    const u = user();
    await loadSample();

    exportHtmlReportMock.mockRejectedValueOnce({
      code: "too_large",
      message: "The HTML report exceeds the 8 MiB limit.",
    });
    await u.click(htmlButton());

    const error = await screen.findByText(/Export failed —/);
    expect(error.textContent).toContain("The HTML report exceeds the 8 MiB limit.");
    expect(error.textContent).toContain("(too_large)");
  });
});
