/**
 * Device table (Task 9): search + filters + bounded rendering + evidence.
 *
 * Parity source: the browser edition's table (work/DriverLens/app.js:7,
 * index.html:6-7). The search haystack, exact-match filters, fallback
 * strings and badge texts are ported verbatim (lib/search.ts, lib/filters.ts,
 * lib/format.ts). Two deliberate desktop changes:
 *
 * - BOUNDED RENDERING: the browser rendered every filtered row (up to the
 *   20,000-device cap); the desktop table paginates (lib/pagination.ts,
 *   50 rows per page), so a 20k-device report keeps the UI responsive.
 * - Device evidence moved from a per-row <details> into an expandable detail
 *   row (a keyboard-operable toggle per device), which also carries the
 *   fields the browser spread across cells (INF, packageTargets,
 *   kernelBinary, service, windowsStatus, errorCode, notes…).
 *
 * Safety: every imported string is rendered as a React text node — never as
 * markup, never through dangerouslySetInnerHTML. "Observed" vs "Needs
 * review" is a text badge; unknown evidence values render the fallback text
 * in muted style, so unknown never impersonates real evidence. A status
 * value outside the contract union (drift) renders a muted "Unknown" badge,
 * never a guessed "Observed".
 */
import { useEffect, useMemo, useState } from "react";

import type { Device } from "../contracts/report";
import type { DeviceQuery, StatusFilter } from "../lib/filters";
import {
  ARCHITECTURE_FILTER_OPTIONS,
  BUS_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
} from "../lib/filters";
import {
  FALLBACKS,
  errorCodeLabel,
  formatCount,
  packageTargetsLabel,
  signatureLabel,
  statusLabel,
} from "../lib/format";
import { paginate } from "../lib/pagination";

export interface DeviceTableProps {
  /** The filtered device list (filtering happens in App so export and the
   *  table share one result set). */
  devices: Device[];
  query: DeviceQuery;
  onQueryChange: (query: DeviceQuery) => void;
  /** False until a report is loaded; the controls are disabled without one. */
  hasReport: boolean;
}

/** Renders an optional string; absent/empty values fall back, muted. */
function EvidenceValue({ value, fallback }: { value: string | null | undefined; fallback: string }) {
  if (value) return <>{value}</>;
  return <span className="muted">{fallback}</span>;
}

function SignatureValue({ signed }: { signed: boolean | null | undefined }) {
  if (signed === true || signed === false) return <>{signatureLabel(signed)}</>;
  return <span className="muted">Unknown</span>;
}

export default function DeviceTable({ devices, query, onQueryChange, hasReport }: DeviceTableProps) {
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  // A new result set (new query or new report) starts at page one. paginate()
  // clamps as well, so this reset is UX, not a correctness requirement.
  useEffect(() => {
    setPage(1);
  }, [devices]);

  const pageView = useMemo(() => paginate(devices, page), [devices, page]);

  const toggleExpanded = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="table-block">
      <div className="filters">
        <label className="field field--search">
          <span className="field__label">Search</span>
          <input
            className="input"
            type="search"
            value={query.search}
            placeholder="Search name, provider, VID/PID, INF…"
            aria-label="Search devices"
            disabled={!hasReport}
            onChange={(event) => onQueryChange({ ...query, search: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="field__label">Status</span>
          <select
            className="input"
            aria-label="Review status"
            value={query.status}
            disabled={!hasReport}
            onChange={(event) => onQueryChange({ ...query, status: event.target.value as StatusFilter })}
          >
            {STATUS_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Architecture</span>
          <select
            className="input"
            aria-label="Architecture"
            value={query.architecture}
            disabled={!hasReport}
            onChange={(event) => onQueryChange({ ...query, architecture: event.target.value })}
          >
            {ARCHITECTURE_FILTER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "all" ? "All architectures" : option}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Bus</span>
          <select
            className="input"
            aria-label="Bus"
            value={query.bus}
            disabled={!hasReport}
            onChange={(event) => onQueryChange({ ...query, bus: event.target.value })}
          >
            {BUS_FILTER_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "all" ? "All buses" : option}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="app__table-wrap">
        <table className="app__table">
          <caption className="visually-hidden">
            {hasReport
              ? `Devices in the loaded report — showing rows ${pageView.from} to ${pageView.to} of ${pageView.total} matched`
              : "No report loaded"}
          </caption>
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">Driver</th>
              <th scope="col">Architecture evidence</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {!hasReport ? (
              <tr>
                <td colSpan={4} className="app__empty">
                  No report loaded. Open a saved report or load the sample.
                </td>
              </tr>
            ) : pageView.items.length === 0 ? (
              <tr>
                <td colSpan={4} className="app__empty">
                  No devices match these filters.
                </td>
              </tr>
            ) : (
              pageView.items.map((device) => {
                const isExpanded = expanded.has(device.id);
                const detailId = `device-evidence-${device.id}`;
                return (
                  <FragmentRow
                    key={device.id}
                    device={device}
                    isExpanded={isExpanded}
                    detailId={detailId}
                    onToggle={() => toggleExpanded(device.id)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {hasReport && pageView.total > 0 ? (
        <nav className="pager" aria-label="Device table pages">
          <button
            type="button"
            className="button"
            onClick={() => setPage(pageView.page - 1)}
            disabled={pageView.page <= 1}
          >
            Previous
          </button>
          <span className="pager__status">
            Page {formatCount(pageView.page)} of {formatCount(pageView.pageCount)} · rows{" "}
            {formatCount(pageView.from)}–{formatCount(pageView.to)} of {formatCount(pageView.total)} matched
          </span>
          <button
            type="button"
            className="button"
            onClick={() => setPage(pageView.page + 1)}
            disabled={pageView.page >= pageView.pageCount}
          >
            Next
          </button>
        </nav>
      ) : null}
    </div>
  );
}

interface FragmentRowProps {
  device: Device;
  isExpanded: boolean;
  detailId: string;
  onToggle: () => void;
}

/** One device row plus (when expanded) its evidence detail row. */
function FragmentRow({ device, isExpanded, detailId, onToggle }: FragmentRowProps) {
  return (
    <>
      <tr className="device-row">
        <td>
          <strong>{device.name}</strong>
          <small className="app__sub">
            <EvidenceValue value={device.deviceClass} fallback={FALLBACKS.general} /> ·{" "}
            <EvidenceValue value={device.bus} fallback={FALLBACKS.general} />
          </small>
          {device.vid ? (
            <small className="app__sub">
              VID {device.vid} / PID {device.pid || FALLBACKS.pid}
            </small>
          ) : null}
          <button
            type="button"
            className="table__toggle"
            aria-expanded={isExpanded}
            aria-controls={detailId}
            onClick={onToggle}
          >
            <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span> Evidence
          </button>
        </td>
        <td>
          <EvidenceValue value={device.provider} fallback={FALLBACKS.provider} />
          <small className="app__sub">
            <EvidenceValue value={device.version} fallback={FALLBACKS.version} /> ·{" "}
            <EvidenceValue value={device.inf} fallback={FALLBACKS.inf} />
          </small>
          <small className="app__sub">
            Signature metadata: <SignatureValue signed={device.signed} />
          </small>
        </td>
        <td>
          <span className="badge">{device.architecture || FALLBACKS.architecture}</span>
          <small className="app__sub">
            Binary: <EvidenceValue value={device.kernelBinary} fallback={FALLBACKS.kernelBinary} />
          </small>
          <small className="app__sub">
            INF targets:{" "}
            {packageTargetsLabel(device.packageTargets) === FALLBACKS.packageTargets ? (
              <span className="muted">{FALLBACKS.packageTargets}</span>
            ) : (
              packageTargetsLabel(device.packageTargets)
            )}
          </small>
        </td>
        <td>
          {device.status === "review" ? (
            <span className="badge badge--warn">{statusLabel(device.status)}</span>
          ) : device.status === "observed" ? (
            <span className="badge">{statusLabel(device.status)}</span>
          ) : (
            // Contract drift (a value outside the closed union): an honest
            // muted Unknown — never a guessed "Observed".
            <span className="badge muted">{statusLabel(device.status)}</span>
          )}
        </td>
      </tr>
      {isExpanded ? (
        <tr className="device-detail">
          <td colSpan={4}>
            <dl className="evidence" id={detailId}>
              <dt>Device digest</dt>
              <dd className="mono">{device.id}</dd>
              <dt>Device class</dt>
              <dd>
                <EvidenceValue value={device.deviceClass} fallback={FALLBACKS.general} />
              </dd>
              <dt>Bus</dt>
              <dd>
                <EvidenceValue value={device.bus} fallback={FALLBACKS.general} />
              </dd>
              {device.manufacturer ? (
                <>
                  <dt>Manufacturer</dt>
                  <dd>{device.manufacturer}</dd>
                </>
              ) : null}
              <dt>VID / PID</dt>
              <dd>
                {device.vid ? (
                  <>
                    VID {device.vid} / PID {device.pid || FALLBACKS.pid}
                  </>
                ) : (
                  <span className="muted">Not present</span>
                )}
              </dd>
              <dt>Service</dt>
              <dd>
                <EvidenceValue value={device.service} fallback={FALLBACKS.service} />
              </dd>
              <dt>Windows status</dt>
              <dd>
                <EvidenceValue value={device.windowsStatus} fallback={FALLBACKS.windowsStatus} />
              </dd>
              <dt>Error code</dt>
              <dd>
                {device.errorCode === null || device.errorCode === undefined ? (
                  <span className="muted">{errorCodeLabel(device.errorCode)}</span>
                ) : (
                  errorCodeLabel(device.errorCode)
                )}
              </dd>
              <dt>Provider</dt>
              <dd>
                <EvidenceValue value={device.provider} fallback={FALLBACKS.provider} />
              </dd>
              <dt>Version</dt>
              <dd>
                <EvidenceValue value={device.version} fallback={FALLBACKS.version} />
              </dd>
              <dt>INF file</dt>
              <dd>
                <EvidenceValue value={device.inf} fallback={FALLBACKS.inf} />
              </dd>
              <dt>Signature</dt>
              <dd>
                <SignatureValue signed={device.signed} />
              </dd>
              <dt>INF targets</dt>
              <dd>
                {packageTargetsLabel(device.packageTargets) === FALLBACKS.packageTargets ? (
                  <span className="muted">{FALLBACKS.packageTargets}</span>
                ) : (
                  packageTargetsLabel(device.packageTargets)
                )}
              </dd>
              <dt>Kernel binary</dt>
              <dd>
                <EvidenceValue value={device.kernelBinary} fallback={FALLBACKS.kernelBinary} />
              </dd>
              <dt>Architecture</dt>
              <dd>
                <EvidenceValue value={device.architecture} fallback={FALLBACKS.architecture} />
              </dd>
              <dt>Notes</dt>
              <dd>
                {Array.isArray(device.notes) && device.notes.length > 0 ? (
                  <ul className="notes">
                    {device.notes.map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">No notes reported</span>
                )}
              </dd>
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}
