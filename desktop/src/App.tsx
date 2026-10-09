/**
 * DriverLens desktop — application shell (Tasks 9 + 10).
 *
 * Real workflows now:
 * - ScanControls drives the native scan lifecycle (start/poll/cancel, all
 *   five states, error guidance, Busy handling). When a scan completes, its
 *   report is fetched with the read-only `get_report` command and flows
 *   through the same `handleReportLoaded` path as imports and the sample.
 * - ReportActions imports reports through the native open dialog, loads the
 *   bundled fictional sample, and exports through the native save dialog
 *   (full or exactly-filtered).
 * - The Devices panel shows the current report: report-level stats (browser
 *   parity), the search/filter toolbar, and a paginated table with
 *   expandable per-device evidence.
 *
 * State ownership: App holds the loaded report and the table query — the
 * single filtered result set feeds both the table (rendering) and the
 * filtered export (ids), so "export filtered" can never disagree with what
 * the table shows. All device strings are rendered as text nodes (React
 * escaping); nothing is ever interpreted as markup.
 */
import { useCallback, useMemo, useState } from "react";

import DeviceTable from "./components/DeviceTable";
import NotebookView from "./components/NotebookView";
import ReportActions from "./components/ReportActions";
import ScanControls from "./components/ScanControls";
import type { Report } from "./contracts/report";
import { DEFAULT_QUERY, filterDevices, type DeviceQuery } from "./lib/filters";
import { formatCount } from "./lib/format";
import { idsForExport } from "./lib/selection";
import { reportStats, type ReportStats } from "./lib/stats";

export default function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [query, setQuery] = useState<DeviceQuery>(DEFAULT_QUERY);
  /** Active view: the scan/report workflow, or the USB Device Notebook. */
  const [view, setView] = useState<"scan" | "notebook">("scan");

  const handleReportLoaded = useCallback((next: Report) => {
    setReport(next);
    // A new report invalidates the old filters (an architecture/bus value
    // from the previous report may match nothing in the new one).
    setQuery(DEFAULT_QUERY);
  }, []);

  const filtered = useMemo(
    () => (report ? filterDevices(report.devices, query) : []),
    [report, query]
  );
  const stats = useMemo(
    () => (report ? reportStats(report.devices, report.system) : null),
    [report]
  );
  const filteredIds = useMemo(() => idsForExport(filtered), [filtered]);

  // Browser-parity meta line (app.js:6), with the shipped fallbacks.
  const meta = report
    ? `${formatCount(filtered.length)} of ${formatCount(report.devices.length)} devices · ` +
      `${report.system?.os || "Unknown OS"} · ${report.sample ? "Sample data" : "Local inventory"} · ` +
      `${report.generatedAt || "Date unknown"}`
    : "No report loaded.";

  return (
    <main className="app" aria-labelledby="app-title">
      <header className="app__header">
        <p className="app__eyebrow">FREDY-E / SYSTEM TOOLS</p>
        <h1 id="app-title">
          DriverLens <span className="chip">Prototype</span>
        </h1>
        <p className="app__tagline">
          Understand the devices and drivers behind this Windows machine.
        </p>
      </header>

      {view === "scan" ? (
        <>
          <ScanControls onScanReport={handleReportLoaded} />

          <ReportActions
            report={report}
            filteredIds={filteredIds}
            matchedCount={filtered.length}
            onReportLoaded={handleReportLoaded}
          />

          <section className="app__panel" aria-labelledby="devices-title">
            <div className="app__panel-head">
              <h2 id="devices-title">Devices</h2>
              {report?.sample ? <span className="chip">Fictional sample data</span> : null}
            </div>
            <StatsRow stats={stats} />
            <p className="app__meta">{meta}</p>
            <DeviceTable
              devices={filtered}
              query={query}
              onQueryChange={setQuery}
              hasReport={report !== null}
            />
          </section>
        </>
      ) : (
        <NotebookView />
      )}

      {/*
        View switcher (extension E-01). Placed after the scan view's panels on
        purpose: the pre-existing keyboard tab-order contract walks the scan
        view stop-by-stop in DOM order (tests/a11y-keyboard.test.tsx), so the
        switcher must not insert tab stops before those controls. It is fully
        keyboard operable where it sits (Tab to reach, Enter/Space to switch),
        labelled, and each button reflects the active view via aria-pressed.
      */}
      <nav className="viewnav" aria-label="View">
        <span className="viewnav__label">View</span>
        <button
          type="button"
          className="button"
          aria-pressed={view === "scan"}
          onClick={() => setView("scan")}
        >
          Scan view
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={view === "notebook"}
          onClick={() => setView("notebook")}
        >
          Notebook view
        </button>
      </nav>

      <footer className="app__footer">
        <p>
          Read-only inventory · Everything stays on this machine — no network calls, no data
          uploaded.
        </p>
      </footer>
    </main>
  );
}

function StatsRow({ stats }: { stats: ReportStats | null }) {
  const items = [
    { label: "Devices", value: stats ? formatCount(stats.total) : "—" },
    { label: "Need review", value: stats ? formatCount(stats.review) : "—" },
    { label: "Binary architecture known", value: stats ? formatCount(stats.known) : "—" },
    { label: "OS architecture", value: stats ? stats.osArchitecture : "—" },
  ];
  return (
    <section className="stats" aria-label="Report statistics">
      {items.map((item) => (
        <div className="stats__item" key={item.label}>
          <b className="stats__value">{item.value}</b>
          <span className="stats__label">{item.label}</span>
        </div>
      ))}
    </section>
  );
}
