/**
 * Report actions (Task 10): import, sample, full export, filtered export.
 *
 * Flow rules (fail-safe, nothing silent):
 * - Import calls the native `open_report` (the Rust side opens the dialog and
 *   validates the file). A cancelled dialog is a no-op; a rejected import
 *   KEEPS the previously displayed report and says so; a successfully
 *   imported report replaces it and resets the filters (App).
 * - The bundled fictional sample is validated with the same validator the
 *   contract ships (contracts/validate-report.ts) before it is displayed.
 * - Full export writes the current in-memory report unchanged.
 * - Filtered export sends the ids of exactly the devices matching the current
 *   search/filters; the Rust side rejects unknown ids and stamps
 *   `filterNote` into the written file.
 * - Every export goes through the NATIVE save dialog; its own overwrite
 *   confirmation is the only overwrite confirmation (nothing is ever written
 *   without the user picking the destination).
 * - The portable HTML export builds one self-contained document from the
 *   validated current report (redacted by default — see lib/redact.ts and
 *   lib/report-html.ts) and writes it through the same native save dialog.
 */
import { useCallback, useState } from "react";

import { exportHtmlReport, exportReport, isScanError, openReport } from "../adapters/native";
import syntheticReportData from "../assets/synthetic-report.json";
import type { Report } from "../contracts/report";
import { validateReport } from "../contracts/validate-report";
import { byteCountLabel, deviceCountLabel, formatCount } from "../lib/format";
import { REDACTION_HELPER_TEXT } from "../lib/redact";
import { buildReportHtml, SUGGESTED_HTML_FILE_NAME } from "../lib/report-html";
import { commandErrorText } from "../lib/scan-messages";

export interface ReportActionsProps {
  /** The currently displayed report, or null. */
  report: Report | null;
  /** Device ids matching the current search/filters (report order). */
  filteredIds: readonly string[];
  /** How many devices those ids cover (for the button label and messages). */
  matchedCount: number;
  /** Called with a newly loaded report (import or sample). Never called on failure. */
  onReportLoaded: (report: Report) => void;
}

type StatusTone = "info" | "error";
interface Status {
  tone: StatusTone;
  text: string;
}

type Pending = "import" | "sample" | "export-full" | "export-filtered" | "export-html" | null;

const INITIAL_STATUS: Status = {
  tone: "info",
  text: "No report loaded. Open a saved report or load the sample.",
};

/** Browser-parity load message (app.js:8), warnings appended when present. */
function loadedMessage(report: Report): string {
  const base = report.sample
    ? "Sample report loaded; these devices are fictional."
    : "Local report loaded. No data was uploaded.";
  const warnings = Array.isArray(report.warnings) && report.warnings.length > 0
    ? ` ${report.warnings.join(" ")}`
    : "";
  return `${base}${warnings}`;
}

export default function ReportActions({
  report,
  filteredIds,
  matchedCount,
  onReportLoaded,
}: ReportActionsProps) {
  const [pending, setPending] = useState<Pending>(null);
  const [status, setStatus] = useState<Status>(INITIAL_STATUS);
  // Opt-in: OFF keeps the digests redacted (ordinals) in the HTML export.
  const [includeIdentifiers, setIncludeIdentifiers] = useState(false);

  const importReport = useCallback(async () => {
    if (pending !== null) return;
    setPending("import");
    try {
      const imported = await openReport();
      if (imported === null) {
        setStatus({ tone: "info", text: "Open cancelled — no report was changed." });
        return;
      }
      // Belt-and-braces: the Rust side already validated the file; the
      // contract validator runs again here so any transport/contract drift
      // surfaces as a kept-previous-report failure, never as a rendered one.
      const result = validateReport(imported);
      if (!result.ok) {
        setStatus({
          tone: "error",
          text: `Import failed — ${result.message}${report ? " The previous report is still shown." : " No report was loaded."}`,
        });
        return;
      }
      onReportLoaded(result.report);
      setStatus({ tone: "info", text: loadedMessage(result.report) });
    } catch (error) {
      const code = isScanError(error) ? error.code : undefined;
      setStatus({
        tone: "error",
        text: `Import failed — ${commandErrorText(error, code)}${report ? " The previous report is still shown." : " No report was loaded."}`,
      });
    } finally {
      setPending(null);
    }
  }, [onReportLoaded, pending, report]);

  const loadSample = useCallback(() => {
    if (pending !== null) return;
    setPending("sample");
    try {
      const result = validateReport(syntheticReportData);
      if (!result.ok) {
        setStatus({ tone: "error", text: `Sample data failed validation — ${result.message}` });
        return;
      }
      onReportLoaded(result.report);
      setStatus({ tone: "info", text: loadedMessage(result.report) });
    } finally {
      setPending(null);
    }
  }, [onReportLoaded, pending]);

  const runExport = useCallback(
    async (kind: "full" | "filtered") => {
      if (pending !== null || report === null) return;
      setPending(kind === "full" ? "export-full" : "export-filtered");
      try {
        // Full export: a real zero-argument call (the adapter then invokes
        // `export_report` with no argument list at all). Filtered export:
        // exactly the id list.
        const summary =
          kind === "filtered" ? await exportReport([...filteredIds]) : await exportReport();
        if (summary === null) {
          setStatus({ tone: "info", text: "Save cancelled — nothing was exported." });
        } else if (kind === "full") {
          setStatus({
            tone: "info",
            text: `Full report exported — ${byteCountLabel(summary.bytesWritten)} written.`,
          });
        } else {
          setStatus({
            tone: "info",
            text: `Filtered report exported — ${deviceCountLabel(matchedCount)} in ${byteCountLabel(summary.bytesWritten)}.`,
          });
        }
      } catch (error) {
        const code = isScanError(error) ? error.code : undefined;
        setStatus({ tone: "error", text: `Export failed — ${commandErrorText(error, code)}` });
      } finally {
        setPending(null);
      }
    },
    [filteredIds, matchedCount, pending, report]
  );

  const runHtmlExport = useCallback(async () => {
    if (pending !== null || report === null) return;
    setPending("export-html");
    try {
      // The HTML is built from the validated report in view; redaction is on
      // unless the user opted into identifiers. The Rust side opens the save
      // dialog and writes exactly the chosen path.
      const html = buildReportHtml(report, { includeIdentifiers });
      const summary = await exportHtmlReport(html, SUGGESTED_HTML_FILE_NAME);
      if (summary === null) {
        setStatus({ tone: "info", text: "Save cancelled — nothing was exported." });
      } else {
        setStatus({
          tone: "info",
          text: `HTML report exported — ${byteCountLabel(summary.bytesWritten)} written.`,
        });
      }
    } catch (error) {
      const code = isScanError(error) ? error.code : undefined;
      setStatus({ tone: "error", text: `Export failed — ${commandErrorText(error, code)}` });
    } finally {
      setPending(null);
    }
  }, [includeIdentifiers, pending, report]);

  const busy = pending !== null;

  return (
    <section className="app__panel" aria-labelledby="report-actions-title">
      <div className="app__panel-head">
        <h2 id="report-actions-title">Report</h2>
      </div>
      <div className="toolbar">
        <button
          type="button"
          className="button"
          onClick={() => {
            void importReport();
          }}
          disabled={busy}
          title="Open a saved DriverLens report (JSON) from disk."
        >
          Open report…
        </button>
        <button
          type="button"
          className="button"
          onClick={loadSample}
          disabled={busy}
          title="Load the bundled fictional sample report."
        >
          Load sample
        </button>
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            void runExport("full");
          }}
          disabled={busy || report === null}
          title={
            report === null
              ? "No report is loaded to export."
              : "Export the full current report through a native save dialog."
          }
        >
          Export full
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            void runExport("filtered");
          }}
          disabled={busy || report === null}
          title={
            report === null
              ? "No report is loaded to export."
              : "Export exactly the devices matching the current search and filters."
          }
        >
          Export filtered ({formatCount(matchedCount)})
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            void runHtmlExport();
          }}
          disabled={busy || report === null}
          title={
            report === null
              ? "No report is loaded to export."
              : "Export one self-contained HTML report (opens offline; redacted by default)."
          }
        >
          Export HTML report…
        </button>
        <label className="app__checkbox">
          <input
            type="checkbox"
            checked={includeIdentifiers}
            onChange={(event) => setIncludeIdentifiers(event.target.checked)}
            disabled={busy || report === null}
            aria-describedby="export-html-redaction-hint"
          />{" "}
          Include device identifiers
        </label>
      </div>
      <p className="app__note" id="export-html-redaction-hint">
        {REDACTION_HELPER_TEXT}
      </p>
      <p
        className={status.tone === "error" ? "app__note app__note--error" : "app__note"}
        role="status"
      >
        {status.text}
      </p>
    </section>
  );
}
