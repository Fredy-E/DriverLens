/**
 * Portable HTML report builder (E-03).
 *
 * `buildReportHtml` turns a VALIDATED Report object into one complete,
 * self-contained HTML document string:
 *
 * - doctype + utf-8 charset; a single inline `<style>` block — no external
 *   references of any kind and no `<script>` tags, so the file opens offline
 *   and renders nothing that can execute;
 * - every interpolated value is HTML-escaped, so hostile device strings can
 *   only ever render as inert text;
 * - redaction is ON by default (device digests → ordinals D01, D02, … via
 *   `lib/redact.ts`); the explicit `includeIdentifiers` opt-in keeps the
 *   digests and drops the "What is redacted" note;
 * - print-friendly (`@media print`) so the file can be printed or saved to
 *   PDF as-is.
 *
 * The document is written by the `export_html_report` Rust command through
 * the native save dialog — the destination is always the user's choice.
 */
import type { Device, Report } from "../contracts/report";
import { formatCount, statusLabel, textOr } from "./format";
import { redactReport, REDACTION_NOTE } from "./redact";

export const APP_NAME = "DriverLens";
export const APP_VERSION = "0.1.0";

/** Default file name suggested to the native save dialog. */
export const SUGGESTED_HTML_FILE_NAME = "driverlens-report.html";

export interface ReportHtmlOptions {
  /** Opt-in: keep the device digests instead of redacting them. Default false. */
  includeIdentifiers?: boolean;
}

/** HTML-escape a value so it can only ever render as text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorCodeText(code: number | null | undefined): string {
  return code === null || code === undefined ? "-" : String(code);
}

function vidPidLabel(device: Device): string {
  const vid = device.vid ? device.vid : null;
  const pid = device.pid ? device.pid : null;
  if (vid === null && pid === null) return "-";
  return `${vid ?? "?"}:${pid ?? "?"}`;
}

/** Driver version + provider in one cell; '-' when neither is present. */
function driverText(device: Device): string {
  const parts = [device.version, device.provider].filter(
    (part): part is string => typeof part === "string" && part !== ""
  );
  return parts.length > 0 ? parts.join(" · ") : "-";
}

function targetsText(targets: string[] | undefined): string {
  return Array.isArray(targets) && targets.length > 0 ? targets.join(", ") : "-";
}

function notesText(notes: string[] | undefined): string {
  return Array.isArray(notes) && notes.length > 0 ? notes.join("; ") : "-";
}

function deviceRow(device: Device): string {
  const cells = [
    device.id,
    device.name,
    textOr(device.deviceClass, "-"),
    textOr(device.manufacturer, "-"),
    textOr(device.bus, "-"),
    vidPidLabel(device),
    statusLabel(device.status),
    errorCodeText(device.errorCode),
    driverText(device),
    targetsText(device.packageTargets),
    notesText(device.notes),
  ];
  return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
}

const STYLE = `:root { color-scheme: light; }
body { margin: 0 auto; max-width: 1100px; padding: 24px; color: #1c2333; background: #ffffff;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.45; }
h1 { margin: 0 0 4px; font-size: 22px; }
h2 { margin: 28px 0 8px; font-size: 16px; }
p { margin: 8px 0; }
.report-meta, .closing { color: #5a6b8c; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { font-weight: 600; }
dd { margin: 0; }
.summary ul { margin: 0; padding-left: 20px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border: 1px solid #c9d2e3; padding: 6px 8px; text-align: left; vertical-align: top; }
th { background: #eef3fb; }
tr { break-inside: avoid; }
@media print {
  body { max-width: none; padding: 0; }
  h2 { break-after: avoid; }
  tr { break-inside: avoid; }
}`;

/**
 * Build the complete standalone HTML document for one validated report.
 * Deterministic: the same report and options always produce the same string.
 */
export function buildReportHtml(report: Report, options: ReportHtmlOptions = {}): string {
  const includeIdentifiers = options.includeIdentifiers === true;
  const source = includeIdentifiers ? report : redactReport(report).report;

  const metaParts = [
    `${APP_NAME} ${APP_VERSION}`,
    `Generated: ${textOr(source.generatedAt, "Date unknown")}`,
  ];
  if (source.sample === true) metaParts.push("Fictional sample data");

  const system = source.system;
  const os = textOr(system?.os, "Unknown OS");
  const build = textOr(system?.build, "Unknown");
  const architecture = textOr(system?.architecture, "Unknown");

  const statusCounts = new Map<string, number>();
  for (const device of source.devices) {
    const label = textOr(device.windowsStatus, "Unknown");
    statusCounts.set(label, (statusCounts.get(label) ?? 0) + 1);
  }
  const issues = source.devices.filter((device) => device.status === "review").length;
  const statusLines = [...statusCounts.entries()]
    .map(
      ([label, count]) =>
        `<li>Windows status — ${escapeHtml(label)}: ${formatCount(count)}</li>`
    )
    .join("\n");

  const redactionSection = includeIdentifiers
    ? ""
    : `<section class="redaction" aria-labelledby="redaction-title">
<h2 id="redaction-title">What is redacted</h2>
<p>${REDACTION_NOTE}</p>
</section>
`;

  const rows = source.devices.map(deviceRow).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DriverLens report</title>
<style>
${STYLE}
</style>
</head>
<body>
<header class="report-header">
<h1>DriverLens report</h1>
<p class="report-meta">${escapeHtml(metaParts.join(" · "))}</p>
</header>
<main>
<section class="system-info" aria-labelledby="system-title">
<h2 id="system-title">System</h2>
<dl>
<dt>OS</dt><dd>${escapeHtml(os)}</dd>
<dt>Build</dt><dd>${escapeHtml(build)}</dd>
<dt>Architecture</dt><dd>${escapeHtml(architecture)}</dd>
</dl>
</section>
<section class="summary" aria-labelledby="summary-title">
<h2 id="summary-title">Summary</h2>
<ul>
<li>Devices: ${formatCount(source.devices.length)}</li>
${statusLines}
<li>Issues (review flags): ${formatCount(issues)}</li>
</ul>
</section>
${redactionSection}<section class="devices" aria-labelledby="devices-title">
<h2 id="devices-title">Devices</h2>
<table class="device-table">
<thead>
<tr><th>ID</th><th>Name</th><th>Class</th><th>Manufacturer</th><th>Bus</th><th>VID:PID</th><th>Status</th><th>Error code</th><th>Driver</th><th>Package targets</th><th>Notes</th></tr>
</thead>
<tbody>
${rows}
</tbody>
</table>
</section>
<p class="closing">Local, read-only inventory — evidence, not diagnosis; no repair verdicts.</p>
</main>
</body>
</html>
`;
}
