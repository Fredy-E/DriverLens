/**
 * Shared run paths for the native E2E suite (desktop/e2e/).
 *
 * Loaded by BOTH the WDIO config (which passes the app-side values into the
 * E2E binary's environment) and the spec (which writes the scenario control
 * file, the import fixture, and reads exported files back). Every path is
 * derived from this module's own location, so the config process and the
 * spec worker agree without relying on environment inheritance between WDIO
 * processes.
 *
 * Runtime artifacts live under desktop/e2e/.run/ (ignored by git): nothing
 * here ever touches the repository root or a user directory.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RUN_DIR = path.join(E2E_DIR, ".run");

/** Per-spawn scenario control file (rewritten by the spec before each scan). */
export const SCENARIO_FILE = path.join(RUN_DIR, "scenario.txt");
/** The synthetic report the fake open dialog "picks" for import. */
export const IMPORT_REPORT_PATH = path.join(RUN_DIR, "import-report.json");
/** The destination the fake save dialog returns for exports. */
export const EXPORT_REPORT_PATH = path.join(RUN_DIR, "export-report.json");
/** The destination the fake HTML save dialog returns for HTML exports. */
export const HTML_REPORT_PATH = path.join(RUN_DIR, "export-report.html");
/**
 * The E2E app's private notebook store directory
 * (`DRIVERLENS_E2E_NOTEBOOK_DIR`): the E2E binary keeps its notebook store
 * here — never the real user store under the app local data dir.
 */
export const NOTEBOOK_DIR = path.join(RUN_DIR, "notebook");
/** The machine-readable run summary written by the spec's after() hook. */
export const RESULTS_PATH = path.join(RUN_DIR, "results.json");
/** WDIO screenshots captured during the run. */
export const SHOTS_DIR = path.join(RUN_DIR, "shots");

/**
 * The feature-gated E2E binary (built with `--features wdio-e2e` and
 * `CARGO_TARGET_DIR=src-tauri/target-e2e`, so the verified release artifact
 * in `src-tauri/target/` is never touched). Override with
 * `DRIVERLENS_E2E_BINARY` when the binary lives elsewhere (e.g. CI).
 */
export const E2E_BINARY = process.env.DRIVERLENS_E2E_BINARY
  ? path.resolve(process.env.DRIVERLENS_E2E_BINARY)
  : path.resolve(
      E2E_DIR,
      "../src-tauri/target-e2e/aarch64-pc-windows-msvc/release/driverlens-desktop.exe",
    );

/**
 * Scan-deadline override for the E2E app (milliseconds). Keeps the real
 * timeout path fast while leaving the busy/cancel cases a wide margin to
 * finish their UI round trips: the cancel case has this long to cancel, the
 * timeout case waits it out.
 */
export const E2E_TIMEOUT_MS = process.env.DRIVERLENS_E2E_TIMEOUT_MS ?? "20000";

/** Marker field/value the scripted fake stamps into its synthetic report. */
export const FAKE_MARKER_FIELD = "e2eScriptedFake";
export const FAKE_MARKER_VALUE = "driverlens-wdio-e2e";
