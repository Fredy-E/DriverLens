// @vitest-environment jsdom
/**
 * Portable HTML report builder tests (E-03): a complete standalone document —
 * doctype + utf-8 charset, inline styles only, zero scripts, zero external
 * references, every value HTML-escaped, redacted by default (ordinals),
 * print-friendly. Hostile strings must render inert.
 */
import { describe, expect, it } from "vitest";

import { buildReportHtml, SUGGESTED_HTML_FILE_NAME } from "../src/lib/report-html";
import { HOSTILE_REPORT, LOCAL_REPORT, SAMPLE_REPORT } from "./fixtures/reports";

// Built at runtime so this file itself contains no scheme-literal string.
const HTTP_SCHEME = ["ht", "tp://"].join("");
const HTTPS_SCHEME = ["ht", "tps://"].join("");

function parsed(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("buildReportHtml — document shape", () => {
  it("emits a complete standalone document with doctype and utf-8 charset", () => {
    const html = buildReportHtml(LOCAL_REPORT);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<html lang="en">');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("contains zero script tags and zero external references", () => {
    const html = buildReportHtml(LOCAL_REPORT);
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toContain(HTTP_SCHEME);
    expect(html).not.toContain(HTTPS_SCHEME);
    expect(html).not.toContain("src=");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("@import");
    expect(html).not.toContain("url(");
    const doc = parsed(html);
    expect(doc.querySelectorAll("script, link, img, iframe, svg, object, embed").length).toBe(0);
    expect(doc.querySelectorAll("[src], [href], [onerror], [onload]").length).toBe(0);
  });

  it("uses inline styles only, with print-friendly rules", () => {
    const html = buildReportHtml(LOCAL_REPORT);
    expect(html).toContain("<style>");
    expect(html).toContain("@media print");
  });

  it("is deterministic for the same input", () => {
    expect(buildReportHtml(LOCAL_REPORT)).toBe(buildReportHtml(LOCAL_REPORT));
  });

  it("suggests a .html file name", () => {
    expect(SUGGESTED_HTML_FILE_NAME).toBe("driverlens-report.html");
  });
});

describe("buildReportHtml — required sections", () => {
  it("renders header, system info, summary stats, device table and the closing honesty line", () => {
    const html = buildReportHtml(LOCAL_REPORT);
    expect(html).toContain("<h1>DriverLens report</h1>");
    expect(html).toContain("DriverLens 0.2.0");
    expect(html).toContain("Generated: 2026-10-08T00:00:00Z");
    // System info.
    expect(html).toContain("Test Windows");
    expect(html).toContain("26100");
    expect(html).toContain("ARM64");
    // Summary stats: counts by windowsStatus + issues count.
    expect(html).toContain("Devices: 3");
    expect(html).toContain("Windows status — OK: 1");
    expect(html).toContain("Windows status — Error: 1");
    expect(html).toContain("Windows status — Unknown: 1");
    expect(html).toContain("Issues (review flags): 1");
    // Device table headers.
    for (const header of [
      "ID",
      "Name",
      "Class",
      "Manufacturer",
      "Bus",
      "VID:PID",
      "Status",
      "Error code",
      "Driver",
      "Package targets",
      "Notes",
    ]) {
      expect(html).toContain(`<th>${header}</th>`);
    }
    // Closing honesty line (exact wording).
    expect(html).toContain(
      "Local, read-only inventory — evidence, not diagnosis; no repair verdicts."
    );
  });

  it("renders device evidence with fallbacks: driver version + provider, targets, notes, error code 0", () => {
    const html = buildReportHtml(LOCAL_REPORT);
    expect(html).toContain("1.0.0.0 · Contoso");
    expect(html).toContain("0.9 · Adventure Works");
    expect(html).toContain("ARM64, x64");
    expect(html).toContain("Windows device error 10; Driver metadata reports unsigned");
    // errorCode 0 is a real value and must render as 0, never as a fallback.
    expect(html).toContain("<td>0</td>");
    // Absent evidence falls back to '-'.
    expect(html).toContain("<td>-</td>");
  });

  it("marks the fictional sample honestly when report.sample is true", () => {
    const html = buildReportHtml(SAMPLE_REPORT);
    expect(html).toContain("Fictional sample data");
  });

  it("falls back to honest unknown labels for missing system/generatedAt", () => {
    const html = buildReportHtml({ schemaVersion: 1, devices: [] });
    expect(html).toContain("Unknown OS");
    expect(html).toContain("Generated: Date unknown");
    expect(html).toContain("Devices: 0");
    expect(html).toContain("Issues (review flags): 0");
  });
});

describe("buildReportHtml — redaction by default", () => {
  it("replaces digests with ordinals and embeds the 'What is redacted' note", () => {
    const html = buildReportHtml(LOCAL_REPORT);
    const doc = parsed(html);
    const firstCells = [...doc.querySelectorAll("tbody tr td:first-child")].map(
      (cell) => cell.textContent
    );
    expect(firstCells).toEqual(["D01", "D02", "D03"]);
    expect(html).not.toContain("LOCAL001");
    expect(html).toContain("What is redacted");
    expect(html).toContain("replaced by ordinals");
    expect(html).toContain("No hostnames, usernames, or serial numbers are ever collected.");
  });

  it("keeps digests (and drops the note) only with the explicit opt-in", () => {
    const html = buildReportHtml(LOCAL_REPORT, { includeIdentifiers: true });
    const doc = parsed(html);
    const firstCells = [...doc.querySelectorAll("tbody tr td:first-child")].map(
      (cell) => cell.textContent
    );
    expect(firstCells).toEqual(["LOCAL001", "LOCAL002", "LOCAL003"]);
    expect(html).not.toContain("What is redacted");
    expect(html).not.toContain("D01");
  });
});

describe("buildReportHtml — hostile strings are inert", () => {
  it("escapes hostile device names so nothing can execute or inject markup", () => {
    const html = buildReportHtml(HOSTILE_REPORT);
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;script&gt;window.__pwned = 1;&lt;/script&gt;");
    const doc = parsed(html);
    expect(doc.querySelectorAll("script, img, iframe, svg").length).toBe(0);
    expect(doc.querySelectorAll("[onerror], [onload], [src]").length).toBe(0);
    // The hostile name is present as TEXT content, not as markup.
    const cells = [...doc.querySelectorAll("tbody td")].map((cell) => cell.textContent ?? "");
    expect(cells.some((text) => text.includes("<script>window.__pwned = 1;</script>"))).toBe(true);
  });
});
