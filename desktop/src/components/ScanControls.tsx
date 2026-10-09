/**
 * Device-scan controls (Task 9): the real native scan lifecycle UI.
 *
 * Backend shape (desktop/src-tauri/src/scan.rs): `scan_devices` is
 * NON-BLOCKING — it returns the Running snapshot immediately and the
 * collection runs on a Rust thread. Progress is read by polling
 * `get_scan_state` (~every 500 ms while Running); `cancel_scan` requests
 * cancellation, and the scan then finishes as `cancelled` with no report
 * accepted. The snapshot carries only `{state, generation, startedMs?,
 * errorCode?, deviceCount?}` — terminal failures arrive as an `errorCode`
 * with no message, so this component maps codes to human guidance
 * (lib/scan-messages.ts).
 *
 * Every state is renderable:
 * - idle/initial: Start enabled ("Scan this PC"); a new scan is allowed from
 *   every terminal state (complete / error / cancelled);
 * - running: Start disabled with a visible busy indicator, Cancel shown;
 * - complete: the device count is shown ("N devices collected locally") and —
 *   when the caller passes `onScanReport` — the completed scan's report is
 *   fetched with `get_report` and handed over for display (once per
 *   generation, including a complete state first observed at mount; a failed
 *   fetch gets one bounded retry before the failure is surfaced);
 * - error: the mapped guidance for the terminal code, code token visible;
 * - cancelled: an explicit notice that the previous report is unchanged.
 *
 * A duplicate start (double click race, or a scan started elsewhere) rejects
 * with `{code: "busy"}` and is handled gracefully: the UI says so and
 * resyncs to the authoritative state instead of treating it as a failure.
 * Nothing here blocks the UI thread; all work is async.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { ScanSnapshot } from "../adapters/native";
import { cancelScan, getReport, getScanState, isScanError, scanDevices } from "../adapters/native";
import type { Report } from "../contracts/report";
import { validateReport } from "../contracts/validate-report";
import {
  SCAN_BUSY_NOTICE,
  commandErrorText,
  scanCancelledMessage,
  scanCompleteMessage,
  scanErrorGuidance,
  scanIdleMessage,
  scanRunningMessage,
} from "../lib/scan-messages";

/** Poll cadence while a scan is running. */
export const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Delay before the single bounded retry of a failed `get_report` fetch. One
 * transient IPC hiccup must not force a save/import round trip to see the
 * scan result; only a second failure is surfaced as a notice.
 */
export const REPORT_FETCH_RETRY_DELAY_MS = 1500;

interface Notice {
  tone: "info" | "error";
  text: string;
}

export interface ScanControlsProps {
  /** Poll cadence override — tests inject a shorter interval. */
  pollIntervalMs?: number;
  /**
   * Receives the validated report of a completed scan, fetched with
   * `get_report` exactly once per scan generation (a complete state is also
   * honored when it is first observed at mount, i.e. a scan that finished
   * before this component appeared). Omit to disable the fetch — the
   * component then shows only the lifecycle and the device count.
   */
  onScanReport?: (report: Report) => void;
}

export default function ScanControls({
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  onScanReport,
}: ScanControlsProps) {
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null);
  const [polling, setPolling] = useState(false);
  /** A start/cancel request is in flight (buttons disabled meanwhile). */
  const [commandBusy, setCommandBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const pollErrorShown = useRef(false);
  /** True once the user (or a resync) started/cancelled a scan in this view:
   *  the mount-time sync must then never overwrite fresher state. */
  const interacted = useRef(false);
  /** False after unmount: a late `get_report` resolution must not set state. */
  const alive = useRef(true);
  /** Pending single-retry timer for a failed `get_report` (cleared on unmount). */
  const reportRetryTimer = useRef<number | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (reportRetryTimer.current !== null) {
        window.clearTimeout(reportRetryTimer.current);
        reportRetryTimer.current = null;
      }
    };
  }, []);

  const isRunning = snapshot?.state === "running";

  const applySnapshot = useCallback(
    (next: ScanSnapshot, options?: { keepNotice?: boolean }) => {
      setSnapshot(next);
      setPolling(next.state === "running");
      // A successful state read clears any "lost contact" warning.
      pollErrorShown.current = false;
      setPollError(null);
      // Terminal states speak for themselves; drop transient notices —
      // unless the caller is resyncing after a command rejection, where the
      // notice (e.g. the rejection reason) must survive the resync.
      if (next.state !== "running" && options?.keepNotice !== true) {
        setNotice(null);
      }
    },
    []
  );

  // Initial sync: a scan may already be running (app reload, second window).
  useEffect(() => {
    let active = true;
    getScanState()
      .then((next) => {
        // Never let this one-shot sync clobber a scan the user just started
        // (its response can arrive after the newer start confirmation).
        if (active && !interacted.current) applySnapshot(next);
      })
      .catch(() => {
        if (active) setPollError("Could not read the current scan state. Start a scan to resync.");
      });
    return () => {
      active = false;
    };
  }, [applySnapshot]);

  // Poll while running. A failed poll is survivable (local IPC): keep the
  // cadence, surface the first failure, and self-heal on the next success.
  useEffect(() => {
    if (!polling) return undefined;
    const timer = window.setInterval(() => {
      getScanState()
        .then(applySnapshot)
        .catch((error: unknown) => {
          if (!pollErrorShown.current) {
            pollErrorShown.current = true;
            setPollError(`Scan status could not be refreshed — ${commandErrorText(error, undefined)}`);
          }
        });
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [polling, pollIntervalMs, applySnapshot]);

  // A completed scan leaves its validated report in the backend's
  // current-report slot — the same stored value `export_report` writes. Fetch
  // it with `get_report` once per generation (a complete state is honored on
  // transition AND when first observed, e.g. a scan that finished before this
  // component mounted) and hand it to the consumer so the device table can
  // show the scan's result without a save/import round trip. A failed fetch
  // gets ONE bounded retry (REPORT_FETCH_RETRY_DELAY_MS later); only the final
  // failure surfaces as an explicit notice — the component never guesses a
  // report into view.
  const deliveredGenerations = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (onScanReport === undefined || snapshot === null) return;
    if (snapshot.state !== "complete") return;
    const generation = snapshot.generation;
    if (deliveredGenerations.current.has(generation)) return;
    deliveredGenerations.current.add(generation);

    const attempt = (isRetry: boolean) => {
      void getReport()
        .then((payload) => {
          if (!alive.current) return;
          if (payload === null) {
            deliveredGenerations.current.delete(generation);
            setNotice({
              tone: "error",
              text: "The scan finished, but no report is available to display.",
            });
            return;
          }
          // Belt-and-braces: the Rust side validated the report before storing
          // it; revalidating here keeps any contract drift out of the table.
          const result = validateReport(payload);
          if (!result.ok) {
            setNotice({
              tone: "error",
              text: `The scan report could not be displayed — ${result.message}`,
            });
            return;
          }
          onScanReport(result.report);
        })
        .catch((error: unknown) => {
          if (!alive.current) return;
          if (!isRetry) {
            // One bounded retry: a single transient IPC failure must not force
            // the user into a save/import round trip to see the scan result.
            reportRetryTimer.current = window.setTimeout(() => {
              reportRetryTimer.current = null;
              if (alive.current) attempt(true);
            }, REPORT_FETCH_RETRY_DELAY_MS);
            return;
          }
          deliveredGenerations.current.delete(generation);
          setNotice({
            tone: "error",
            text: `The scan report could not be loaded — ${commandErrorText(
              error,
              isScanError(error) ? error.code : undefined
            )}`,
          });
        });
    };
    attempt(false);
  }, [snapshot, onScanReport]);

  const startScan = useCallback(async () => {
    if (commandBusy) return;
    setCommandBusy(true);
    interacted.current = true;
    setNotice(null);
    try {
      const running = await scanDevices();
      applySnapshot(running);
    } catch (error) {
      if (isScanError(error) && error.code === "busy") {
        // Duplicate start: a scan is already running. Resync and keep polling.
        setNotice({ tone: "info", text: SCAN_BUSY_NOTICE });
        setPolling(true);
        try {
          applySnapshot(await getScanState());
        } catch {
          // The polling effect will retry; nothing else to do here.
        }
      } else {
        setNotice({
          tone: "error",
          text: commandErrorText(error, isScanError(error) ? error.code : undefined),
        });
        try {
          applySnapshot(await getScanState(), { keepNotice: true });
        } catch {
          // Leave the previous snapshot; the notice already explains.
        }
      }
    } finally {
      setCommandBusy(false);
    }
  }, [applySnapshot, commandBusy]);

  const requestCancel = useCallback(async () => {
    if (commandBusy) return;
    setCommandBusy(true);
    interacted.current = true;
    setNotice({ tone: "info", text: "Cancelling the scan…" });
    try {
      await cancelScan();
      // The scan thread finishes as `cancelled`; polling observes it.
      setPolling(true);
    } catch (error) {
      setNotice({
        tone: "error",
        text: commandErrorText(error, isScanError(error) ? error.code : undefined),
      });
    } finally {
      setCommandBusy(false);
    }
  }, [commandBusy]);

  let statusTone: "info" | "error" = "info";
  let statusText: string;
  if (pollError !== null) {
    statusTone = "error";
    statusText = pollError;
  } else if (notice !== null) {
    statusTone = notice.tone;
    statusText = notice.text;
  } else if (snapshot === null) {
    statusText = "Checking scan status…";
  } else {
    switch (snapshot.state) {
      case "running":
        statusText = scanRunningMessage();
        break;
      case "complete":
        statusText = scanCompleteMessage(snapshot);
        break;
      case "cancelled":
        statusText = scanCancelledMessage();
        break;
      case "error":
        statusText = scanErrorGuidance(snapshot.errorCode);
        break;
      default:
        statusText = scanIdleMessage();
        break;
    }
  }

  const startDisabled = isRunning || commandBusy;

  return (
    <section className="app__panel scan" aria-labelledby="scan-title">
      <div className="app__panel-head">
        <h2 id="scan-title">Device scan</h2>
      </div>
      <div className="scan__buttons">
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            void startScan();
          }}
          disabled={startDisabled}
          aria-busy={isRunning}
          title={isRunning ? "A scan is already running." : "Scan this PC for devices and drivers."}
        >
          {isRunning ? "Scanning…" : commandBusy ? "Starting…" : "Scan this PC"}
        </button>
        {isRunning ? (
          <button
            type="button"
            className="button"
            onClick={() => {
              void requestCancel();
            }}
            disabled={commandBusy}
            title="Stop the running scan; no report will be accepted."
          >
            Cancel scan
          </button>
        ) : null}
        {isRunning ? <span className="scan__spinner" aria-hidden="true" /> : null}
      </div>
      <p
        className={statusTone === "error" ? "scan__status scan__status--error" : "scan__status"}
        role="status"
      >
        {statusText}
        {snapshot?.state === "error" && snapshot.errorCode !== undefined ? (
          <small className="scan__code"> (code: {snapshot.errorCode})</small>
        ) : null}
      </p>
    </section>
  );
}
