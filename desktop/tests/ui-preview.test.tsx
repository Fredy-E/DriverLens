// @vitest-environment jsdom
/**
 * Portfolio preview UI regression (Desktop UI preview 0.3.0-preview.1).
 *
 * Proves the new workbench shell without weakening existing contracts:
 * - principal shell carries data-ui-revision="portfolio-preview-1";
 * - masthead identifies the surface as a desktop preview (not production
 *   certification, not an unimplemented-web-concept label);
 * - actual workflows stay grouped and real (scan / report library / export /
 *   notebook / evidence), with the existing keyboard tab-order contract intact
 *   (scan controls before the view switcher in DOM order);
 * - stats + evidence table + friendly empty states render;
 * - version badge matches the preview metadata.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { getReport, getScanState } from "../src/adapters/native";
import { APP_VERSION } from "../src/lib/report-html";

const CSS = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");

beforeEach(() => {
  vi.mocked(getScanState).mockReset();
  vi.mocked(getScanState).mockResolvedValue({ state: "idle", generation: 0 });
  vi.mocked(getReport).mockReset();
  vi.mocked(getReport).mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

describe("Desktop UI preview shell", () => {
  it("marks the principal shell with the portfolio preview revision", () => {
    const { container } = render(<App />);
    const shell = container.querySelector("main.app");
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute("data-ui-revision")).toBe("portfolio-preview-1");
  });

  it("identifies the build as a desktop UI preview with its version", () => {
    render(<App />);
    expect(screen.getByText(/Desktop UI preview/i)).toBeTruthy();
    expect(screen.getByText(/0\.3\.0-preview\.1/)).toBeTruthy();
    // Never a production-certification claim.
    expect(screen.queryByText(/production-ready|certified|certification/i)).toBeNull();
  });

  it("groups the real workflows under explicit workbench headings", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: /Scan workspace/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Report library/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Export/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Devices/i })).toBeTruthy();
  });

  it("keeps the keyboard contract: scan controls precede the view switcher in DOM order", () => {
    const { container } = render(<App />);
    const html = container.innerHTML;
    const scanPos = html.indexOf("Scan this PC");
    const viewPos = html.indexOf("Notebook view");
    expect(scanPos).toBeGreaterThanOrEqual(0);
    expect(viewPos).toBeGreaterThan(scanPos);
  });

  it("shows friendly empty states while keeping the exact legacy status strings", async () => {
    render(<App />);
    expect(screen.getByText("No report loaded.")).toBeTruthy();
    expect(
      screen.getAllByText(/Open a saved report or load the sample/i).length
    ).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText(/Ready\./)).toBeTruthy();
  });

  it("exposes the preview design tokens", () => {
    for (const token of [
      "--ui-bg",
      "--ui-surface",
      "--ui-ink",
      "--ui-muted",
      "--ui-accent",
      "--ui-border",
      "--ui-radius",
    ]) {
      expect(CSS).toContain(token);
    }
  });

  it("honors the light scheme for every legacy functional component (rendered selectors, not tokens)", () => {
    const lightStart = CSS.indexOf("@media (prefers-color-scheme: light)");
    expect(lightStart, "light scheme block must exist").toBeGreaterThanOrEqual(0);
    const light = CSS.slice(lightStart);
    // Legacy functional rules must have explicit light coverage — token presence
    // alone previously hid dark-islands-on-white (review §1).
    for (const token of [
      "--dl-bg",
      "--dl-panel",
      "--dl-text",
      "--dl-muted",
      "--dl-accent",
      "--dl-th-bg",
      "--dl-button-bg",
      "--dl-badge-bg",
      "--dl-badge-text",
      "--dl-warn-bg",
      "--dl-warn-text",
      "--dl-error-text",
      "--dl-input-bg",
    ]) {
      expect(light, `light block must redefine ${token}`).toContain(token);
    }
    for (const selector of [
      ".app__table th",
      ".button:hover",
      ".input::placeholder",
      ".stats__item",
      ".stats__value",
      ".device-detail td",
      ".notebook__detail",
    ]) {
      expect(light, `light block must paint ${selector}`).toContain(selector);
    }
  });

  it("ships the preview metadata version in the report builder", () => {
    expect(APP_VERSION).toBe("0.3.0-preview.1");
  });
});
