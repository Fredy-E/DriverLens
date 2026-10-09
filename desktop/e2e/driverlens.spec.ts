/**
 * DriverLens native E2E suite (Task 12) — a REAL compiled Tauri window on
 * ARM64, driven over the embedded W3C WebDriver server, exercising the real
 * Rust IPC boundary (Tauri commands + ACL) end to end.
 *
 * Every scan in this suite runs against the SCRIPTED FAKE collector
 * (src-tauri/src/e2e_harness.rs): synthetic fixture bytes only — no pwsh,
 * no collector process, no real device inventory. The `e2eScriptedFake`
 * marker asserted below exists only in the scripted fixture, so its
 * presence in `get_report` output and in exported files proves the fake
 * path produced the data.
 *
 * What renderer-only tests cannot prove and this suite does:
 * - the six real commands respond through the real invoke path;
 * - an unlisted command name is denied by the ACL for a page in the real
 *   main window, and forged arguments are inert;
 * - scan lifecycle states (running/complete/error/cancelled/timeout, busy)
 *   are produced by the real Rust state machine, observed in the real UI;
 * - import/export go through the real command implementations (the fake
 *   dialogs only replace the OS picker; validation, filtering and file
 *   writing are the production Rust code).
 */
import fs from "node:fs";
import path from "node:path";

import { browser, $, $$, expect } from "@wdio/globals";

import {
  EXPORT_REPORT_PATH,
  FAKE_MARKER_FIELD,
  FAKE_MARKER_VALUE,
  HTML_REPORT_PATH,
  IMPORT_REPORT_PATH,
  RESULTS_PATH,
  SCENARIO_FILE,
  SHOTS_DIR,
} from "./run-paths";

// ---------------------------------------------------------------------------
// Selectors — product copy and stable classes are part of the tested contract.
// ---------------------------------------------------------------------------
const APP_ROOT = ".app";
const SCAN_STATUS = ".scan__status";
// The report status line. Scoped to `role="status"`: extension E-03 added a
// second `.app__note` (the redaction helper text) BEFORE the status line, so
// a bare `.app__note` would now resolve to the helper (first match).
const REPORT_STATUS = '.app__note[role="status"]';
const META = ".app__meta";
const SAMPLE_CHIP = ".app__panel-head .chip";
const SEARCH_INPUT = 'input[aria-label="Search devices"]';
const ROW_NAMES = "tr.device-row strong";

const SCAN_BUTTON = "button*=Scan this PC";
const CANCEL_BUTTON = "button*=Cancel scan";
const OPEN_BUTTON = "button*=Open report";
const SAMPLE_BUTTON = "button*=Load sample";
const EXPORT_FULL_BUTTON = "button*=Export full";
const EXPORT_FILTERED_BUTTON = "button*=Export filtered";
const EXPORT_HTML_BUTTON = "button*=Export HTML report";
const REDACTION_CHECKBOX = ".app__checkbox input";
const REDACTION_HINT = "#export-html-redaction-hint";
const NOTEBOOK_BUTTON = "button*=Notebook view";
const SCAN_VIEW_BUTTON = "button*=Scan view";
const NOTEBOOK_DEVICE = ".notebook__list .notebook__device";
const NOTEBOOK_NOTE = "#notebook-note";
const SAVE_NOTE_BUTTON = "button*=Save note";
const NOTEBOOK_SAVE_NOTICE = ".notebook__note-actions .app__note";

/** Device names of src-tauri/fixtures/e2e-scripted-report.json, in order. */
const SCAN_FIXTURE_DEVICES = [
  "Scripted Synthetic Adapter",
  "Scripted Legacy Peripheral",
  "Scripted System Root Component",
];

/** Device names of the synthetic import fixture written below. */
const IMPORTED_DEVICES = ["Imported Synthetic Sensor", "Imported Synthetic Controller"];

/** Notebook copy (extension E-01; src/components/NotebookView.tsx). */
const NOTEBOOK_EMPTY_TEXT =
  "No scans recorded yet — run a scan and its devices will appear here.";
const NOTEBOOK_DISCLOSURE_TEXT =
  "Scan history and notes are stored only on this PC. Nothing is uploaded.";
/** The helper line next to the HTML opt-in checkbox (lib/redact.ts). */
const REDACTION_HELPER_TEXT =
  "Redacted by default — identifiers are replaced with D01, D02 …";
/** The note the notebook case saves (synthetic; cleared by the next run). */
const NOTEBOOK_NOTE_TEXT = "E2E synthetic note — scripted fixture device.";

type Scenario = "success" | "failure" | "hang" | "malformed";

/**
 * The outcome object deliberately uses `failure` — NOT `error` — for the
 * rejection value: WebdriverIO's protocol layer treats a response whose
 * `value` carries an `error` key as a WebDriver error response and throws it
 * (observed in attempt 2). `failure` keeps the envelope a plain success
 * value.
 */
interface InvokeOutcome {
  ok: boolean;
  value?: unknown;
  failure?: unknown;
}

interface CaseResult {
  title: string;
  state: string;
}

const caseResults: CaseResult[] = [];
const runNotes: string[] = [];

/**
 * Known-benign console noise produced by the test infrastructure itself (not
 * by the app): every embedded-plugin async-script / direct-eval completion
 * posts `{handler, id, result, error: null}` through the WebView2 message
 * channel; Tauri's IPC message parser also receives it, ignores the unknown
 * fields, trips over `error: null` where a u32 callback id is expected, and
 * evals `console.error("JSON error: invalid type: null, expected u32 …")`
 * into the page. The plugin still processes its own message normally, so the
 * line is cosmetic; it is filtered here (and counted in the results JSON) so
 * the console check stays meaningful for real app errors.
 */
const HARNESS_CONSOLE_NOISE = /^JSON error: invalid type: null, expected u32 at line 1 column \d+$/;

function partitionConsoleErrors(raw: string[]): { appErrors: string[]; harnessNoise: string[] } {
  const appErrors: string[] = [];
  const harnessNoise: string[] = [];
  for (const entry of raw) {
    if (HARNESS_CONSOLE_NOISE.test(entry)) {
      harnessNoise.push(entry);
    } else {
      appErrors.push(entry);
    }
  }
  return { appErrors, harnessNoise };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Writes the scenario the NEXT scan must use (control file > env queue). */
function setScenario(scenario: Scenario): void {
  fs.mkdirSync(path.dirname(SCENARIO_FILE), { recursive: true });
  fs.writeFileSync(SCENARIO_FILE, `${scenario}\n`, "utf8");
}

async function elementText(selector: string): Promise<string> {
  return (await $(selector).getText()).trim();
}

async function waitForText(selector: string, contains: string, timeout = 20000): Promise<void> {
  await browser.waitUntil(async () => (await elementText(selector)).includes(contains), {
    timeout,
    timeoutMsg: `element ${selector} never contained: ${contains}`,
  });
}

async function rowNames(): Promise<string[]> {
  const elements = await $$(ROW_NAMES);
  const names: string[] = [];
  for (const element of elements) {
    names.push(await element.getText());
  }
  return names;
}

/** Rendered text of every notebook device row (extension E-01), in order. */
async function notebookRowTexts(): Promise<string[]> {
  const elements = await $$(NOTEBOOK_DEVICE);
  const texts: string[] = [];
  for (const element of elements) {
    texts.push(await element.getText());
  }
  return texts;
}

/**
 * Invokes a Tauri command from the real page context via the internal IPC
 * bridge (the same bridge the app itself uses), capturing success or the
 * rejection value. Runs through WebDriver's async-script endpoint.
 */
async function invokeFromPage(
  command: string,
  args?: Record<string, unknown>,
): Promise<InvokeOutcome> {
  const outcome = await browser.executeAsync(
    (
      cmd: string,
      invokeArgs: Record<string, unknown> | undefined,
      done: (value: InvokeOutcome) => void,
    ) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__?: {
            invoke: (name: string, payload?: unknown) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!internals) {
        done({ ok: false, error: "__TAURI_INTERNALS__ is missing" });
        return;
      }
      internals.invoke(cmd, invokeArgs).then(
        (value) => done({ ok: true, value }),
        (error: unknown) => {
          let normalized: unknown;
          if (typeof error === "string") {
            // Command errors arrive as JSON strings ("{code,message}");
            // ACL denials arrive as plain strings. Parse when possible.
            try {
              normalized = JSON.parse(error);
            } catch {
              normalized = error;
            }
          } else {
            try {
              normalized = JSON.parse(JSON.stringify(error));
            } catch {
              normalized = String(error);
            }
          }
          done({ ok: false, failure: normalized });
        },
      );
    },
    command,
    args,
  );
  return outcome as InvokeOutcome;
}

async function screenshot(name: string): Promise<void> {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, `${name}.png`);
    await browser.saveScreenshot(file);
    runNotes.push(`screenshot ok: ${file}`);
  } catch (error) {
    runNotes.push(`screenshot failed (${name}): ${String(error)}`);
  }
}

async function readConsoleErrors(): Promise<string[]> {
  return (await browser.execute(
    () => (window as unknown as { __e2eConsoleErrors?: string[] }).__e2eConsoleErrors ?? [],
  )) as string[];
}

/** The synthetic report the fake open dialog will "pick" for import. */
function importFixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-08T00:00:00Z",
    system: { os: "E2E import machine", build: "0000", architecture: "ARM64" },
    devices: [
      {
        id: "IMPORT001",
        name: IMPORTED_DEVICES[0],
        deviceClass: "Sensors",
        bus: "USB",
        status: "observed",
        windowsStatus: "OK",
        errorCode: 0,
        notes: [],
      },
      {
        id: "IMPORT002",
        name: IMPORTED_DEVICES[1],
        deviceClass: "USB",
        bus: "USB",
        status: "review",
        windowsStatus: "Error",
        errorCode: 10,
        notes: ["Windows device error 10"],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

before(async () => {
  fs.mkdirSync(path.dirname(SCENARIO_FILE), { recursive: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  fs.writeFileSync(IMPORT_REPORT_PATH, JSON.stringify(importFixture(), null, 2), "utf8");
  setScenario("success");

  // The window must exist and have rendered the app shell.
  await browser.waitUntil(async () => $(APP_ROOT).isExisting(), {
    timeout: 30000,
    timeoutMsg: "the DriverLens app root never rendered",
  });

  // Pin the session to the main window. Besides being explicit about which
  // window we drive, this suppresses the service's per-lookup auto-focus
  // probe (`ensureActiveWindowFocus`), which needs the optional
  // `tauri-plugin-wdio` bridge that this E2E binary deliberately does not
  // ship — without the switch, every element lookup burns a 5 s timeout
  // (observed in attempt 1). Wrapped defensively: if the switch is
  // unavailable the suite still runs, just slower.
  try {
    await (
      browser as unknown as { tauri: { switchWindow: (label: string) => Promise<void> } }
    ).tauri.switchWindow("main");
    runNotes.push("switchWindow('main') ok — auto-focus probe suppressed");
  } catch (error) {
    runNotes.push(
      `switchWindow('main') failed; auto-focus probe stays active (slower run): ${String(error)}`,
    );
  }

  // Console-error collector: installed once; read back by the last case.
  await browser.execute(() => {
    const w = window as unknown as {
      __e2eConsoleErrors?: string[];
      __e2eCollectorInstalled?: boolean;
    };
    if (w.__e2eCollectorInstalled) return;
    w.__e2eCollectorInstalled = true;
    w.__e2eConsoleErrors = [];
    const push = (entry: string) => {
      try {
        w.__e2eConsoleErrors!.push(entry);
      } catch {
        /* ignore */
      }
    };
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      push(args.map((value) => String(value)).join(" "));
      original(...args);
    };
    window.addEventListener("error", (event) => push(`window.onerror: ${String(event.message)}`));
    window.addEventListener("unhandledrejection", (event) =>
      push(`unhandledrejection: ${String((event as PromiseRejectionEvent).reason)}`),
    );
  });
});

afterEach(function () {
  const test = (this as { currentTest?: { title?: string; state?: string } }).currentTest;
  caseResults.push({ title: test?.title ?? "unknown", state: test?.state ?? "unknown" });
});

after(async function () {
  let consoleErrors: string[] = [];
  let harnessConsoleNoise: string[] = [];
  try {
    const partitioned = partitionConsoleErrors(await readConsoleErrors());
    consoleErrors = partitioned.appErrors;
    harnessConsoleNoise = partitioned.harnessNoise;
  } catch (error) {
    runNotes.push(`could not read console errors at teardown: ${String(error)}`);
  }
  const summary = {
    suite: "DriverLens native E2E (embedded WebDriver server, scripted fake collectors)",
    collected: caseResults.length,
    passed: caseResults.filter((result) => result.state === "passed").length,
    failed: caseResults.filter((result) => result.state === "failed").length,
    skipped: caseResults.filter(
      (result) => result.state === "pending" || result.state === "skipped",
    ).length,
    consoleErrors,
    consoleErrorsRaw: consoleErrors.length + harnessConsoleNoise.length,
    harnessConsoleNoise,
    cases: caseResults,
    notes: runNotes,
  };
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2), "utf8");
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("DriverLens native window (real IPC, scripted collectors)", () => {
  it("startup: app chrome renders and the report panel starts empty", async () => {
    await expect($("h1")).toHaveText(expect.stringContaining("DriverLens"));
    await expect($("h1 .chip")).toHaveText("Prototype");
    await expect($(META)).toHaveText("No report loaded.");
    await expect($(SCAN_STATUS)).toHaveText(expect.stringContaining("Ready."));
    await expect($(".app__empty")).toHaveText(
      "No report loaded. Open a saved report or load the sample.",
    );
  });

  it("html export: disabled with no report; the redaction hint and checkbox defaults are visible", async () => {
    // With no report loaded the HTML export is unavailable: the button and
    // the opt-in checkbox are disabled, and the checkbox starts OFF.
    const exportButton = await $(EXPORT_HTML_BUTTON);
    expect(await exportButton.isEnabled()).toBe(false);
    const checkbox = await $(REDACTION_CHECKBOX);
    expect(await checkbox.isEnabled()).toBe(false);
    expect(await checkbox.isSelected()).toBe(false);
    // The redaction-default helper line is visible next to the checkbox.
    expect(await elementText(REDACTION_HINT)).toBe(REDACTION_HELPER_TEXT);
  });

  it("sample: loading the bundled sample shows the fictional-sample chip", async () => {
    await (await $(SAMPLE_BUTTON)).click();
    await waitForText(META, "Sample data");
    await expect($(SAMPLE_CHIP)).toHaveText("Fictional sample data");
    await expect($(REPORT_STATUS)).toHaveText(
      expect.stringContaining("Sample report loaded; these devices are fictional."),
    );
    expect(await rowNames()).toEqual([
      "Contoso USB Serial Adapter (synthetic)",
      "Adventure Works Legacy Controller (synthetic)",
    ]);
  });

  it("import: the native open dialog path imports a synthetic report through real IPC", async () => {
    await (await $(OPEN_BUTTON)).click();
    await waitForText(REPORT_STATUS, "Local report loaded");
    await waitForText(META, "2 of 2 devices");
    expect(await rowNames()).toEqual(IMPORTED_DEVICES);
    // The imported report is not the sample: the fictional chip is gone.
    expect(await $(SAMPLE_CHIP).isExisting()).toBe(false);
  });

  it("scan success: scripted synthetic devices appear via get_report with the fake marker", async () => {
    setScenario("success");
    await (await $(SCAN_BUTTON)).click();
    await waitForText(SCAN_STATUS, "Scan complete");
    await browser.waitUntil(async () => (await $$("tr.device-row")).length === 3, {
      timeout: 20000,
      timeoutMsg: "the device table never showed the 3 scripted devices",
    });
    expect(await rowNames()).toEqual(SCAN_FIXTURE_DEVICES);
    await expect($(META)).toHaveText(expect.stringContaining("Local inventory"));
    await waitForText(SCAN_STATUS, "collected locally");

    // The report arrived over real IPC and it is the scripted fake's output.
    const report = await invokeFromPage("get_report");
    expect(report.ok).toBe(true);
    const payload = report.value as Record<string, unknown> & {
      devices?: Array<{ id: string }>;
    };
    expect(payload[FAKE_MARKER_FIELD]).toBe(FAKE_MARKER_VALUE);
    expect((payload.devices ?? []).map((device) => device.id)).toEqual([
      "E2E001",
      "E2E002",
      "E2E003",
    ]);
    await screenshot("scan-success");
  });

  it("failed scan: a nonzero collector exit shows the honest error and keeps the report", async () => {
    setScenario("failure");
    await (await $(SCAN_BUTTON)).click();
    await waitForText(SCAN_STATUS, "The collector exited with a nonzero status.");
    await expect($(SCAN_STATUS)).toHaveText(expect.stringContaining("(code: exit_failure)"));
    // The previously accepted report is still displayed.
    expect(await rowNames()).toEqual(SCAN_FIXTURE_DEVICES);
  });

  it("repeated scan: scanning again after a failure completes and refreshes the report", async () => {
    setScenario("success");
    await (await $(SCAN_BUTTON)).click();
    await waitForText(SCAN_STATUS, "Scan complete");
    await browser.waitUntil(async () => (await $$("tr.device-row")).length === 3, {
      timeout: 20000,
      timeoutMsg: "the repeated scan never delivered its report",
    });
  });

  it("simultaneous scans: duplicate start is busy at the IPC level and in the UI", async () => {
    setScenario("hang");

    // Start a hanging scan from the page (not through the component), then
    // attempt a duplicate start: the Rust single-flight lock must answer busy.
    const first = await invokeFromPage("scan_devices");
    expect(first.ok).toBe(true);
    expect((first.value as { state?: string } | undefined)?.state).toBe("running");

    const second = await invokeFromPage("scan_devices");
    expect(second.ok).toBe(false);
    const busy = second.failure as { code?: string; message?: string };
    expect(busy.code).toBe("busy");
    expect(busy.message).toBe("A scan is already running.");

    // The UI's own duplicate start surfaces the busy notice and resyncs.
    await (await $(SCAN_BUTTON)).click();
    await waitForText(SCAN_STATUS, "A scan is already running");
    await (await $(CANCEL_BUTTON)).waitForDisplayed({ timeout: 10000 });
    await screenshot("busy-notice");

    // Clean up: cancel the hanging scripted scan (previous report retained).
    await (await $(CANCEL_BUTTON)).click();
    await waitForText(SCAN_STATUS, "Scan cancelled");
    expect(await rowNames()).toEqual(SCAN_FIXTURE_DEVICES);
  });

  it("cancellation: cancelling a hanging scan reaches the Cancelled state", async () => {
    setScenario("hang");
    await (await $(SCAN_BUTTON)).click();
    await waitForText(SCAN_STATUS, "Reading Windows device and driver metadata");
    await (await $(CANCEL_BUTTON)).click();
    await waitForText(SCAN_STATUS, "Scan cancelled — no new report was accepted");
    const text = await elementText(SCAN_STATUS);
    expect(text).not.toContain("(code:");
    // No new report was accepted; the previous one is still displayed.
    expect(await rowNames()).toEqual(SCAN_FIXTURE_DEVICES);
    await screenshot("cancelled");
  });

  it("timeout: a hanging scan hits the E2E deadline and reports the timeout error", async () => {
    setScenario("hang");
    await (await $(SCAN_BUTTON)).click();
    await waitForText(SCAN_STATUS, "The scan timed out", 30000);
    await expect($(SCAN_STATUS)).toHaveText(expect.stringContaining("(code: timeout)"));
    expect(await rowNames()).toEqual(SCAN_FIXTURE_DEVICES);
  });

  it("unauthorized IPC: unlisted commands are denied and forged args are inert", async () => {
    for (const command of ["read_anything", "run_program"]) {
      const outcome = await invokeFromPage(command);
      expect(outcome.ok).toBe(false);
      expect(typeof outcome.failure).toBe("string");
      expect(outcome.failure as string).toContain("not allowed");
    }

    // Forged arguments on an allowed read-only command change nothing.
    const forged = await invokeFromPage("get_report", {
      path: "C:\\evil-report.json",
      command: "read_anything",
      ids: ["NOT-A-DEVICE"],
      outputPath: "C:\\evil-output.json",
    });
    expect(forged.ok).toBe(true);
    const payload = forged.value as Record<string, unknown> & {
      devices?: Array<{ id: string }>;
    };
    expect((payload.devices ?? []).length).toBe(3);
    expect(JSON.stringify(forged.value)).not.toContain("evil");
    expect(payload[FAKE_MARKER_FIELD]).toBe(FAKE_MARKER_VALUE);
  });

  it("filtering + export: the filtered file matches the selection exactly", async () => {
    // Filter the table down to exactly one scripted device.
    await (await $(SEARCH_INPUT)).setValue("Legacy");
    await waitForText(META, "1 of 3 devices");
    expect(await rowNames()).toEqual(["Scripted Legacy Peripheral"]);

    // Filtered export through the real command (fake save dialog picks the
    // destination; validation, filtering and writing are production code).
    await (await $(EXPORT_FILTERED_BUTTON)).click();
    await waitForText(REPORT_STATUS, "Filtered report exported");
    expect(fs.existsSync(EXPORT_REPORT_PATH)).toBe(true);
    const filtered = JSON.parse(fs.readFileSync(EXPORT_REPORT_PATH, "utf8")) as Record<
      string,
      unknown
    > & { devices?: Array<{ id: string }> };
    expect(filtered.schemaVersion).toBe(1);
    expect(filtered.filterNote).toBe("Filtered export from DriverLens");
    expect((filtered.devices ?? []).map((device) => device.id)).toEqual(["E2E002"]);
    expect(filtered[FAKE_MARKER_FIELD]).toBe(FAKE_MARKER_VALUE);
    await screenshot("filtered-export");

    // Full export: same command without ids — everything, no filterNote.
    await (await $(EXPORT_FULL_BUTTON)).click();
    await waitForText(REPORT_STATUS, "Full report exported");
    const full = JSON.parse(fs.readFileSync(EXPORT_REPORT_PATH, "utf8")) as Record<
      string,
      unknown
    > & { devices?: Array<{ id: string }> };
    expect((full.devices ?? []).length).toBe(3);
    expect(full.filterNote).toBeUndefined();
    expect(full[FAKE_MARKER_FIELD]).toBe(FAKE_MARKER_VALUE);

    // Clean up the written artifacts — nothing may linger.
    fs.rmSync(EXPORT_REPORT_PATH, { force: true });
  });

  it("html export: redacted by default; the opt-in keeps identifiers (real command, real file)", async () => {
    // A report exists (the scripted scan fixture): the export button and the
    // opt-in checkbox are enabled, and the checkbox is still OFF (default).
    const exportButton = await $(EXPORT_HTML_BUTTON);
    expect(await exportButton.isEnabled()).toBe(true);
    const checkbox = await $(REDACTION_CHECKBOX);
    expect(await checkbox.isEnabled()).toBe(true);
    expect(await checkbox.isSelected()).toBe(false);

    fs.rmSync(HTML_REPORT_PATH, { force: true });

    // Default export: the written document is the redacted one — ordinals
    // instead of digests, the "What is redacted" note, no raw digests.
    await exportButton.click();
    await waitForText(REPORT_STATUS, "HTML report exported");
    expect(fs.existsSync(HTML_REPORT_PATH)).toBe(true);
    const redacted = fs.readFileSync(HTML_REPORT_PATH, "utf8");
    expect(redacted).toContain("<title>DriverLens report</title>");
    expect(redacted).toContain("DriverLens 0.2.0");
    expect(redacted).toContain("What is redacted");
    expect(redacted).toContain("D01");
    expect(redacted).toContain("Scripted Synthetic Adapter");
    expect(redacted).not.toContain("E2E001");
    await screenshot("html-export-redacted");

    // Opt-in: identifiers kept, the redaction note dropped.
    await checkbox.click();
    expect(await checkbox.isSelected()).toBe(true);
    await exportButton.click();
    await browser.waitUntil(
      () => {
        try {
          return fs.readFileSync(HTML_REPORT_PATH, "utf8").includes("E2E001");
        } catch {
          return false;
        }
      },
      {
        timeout: 15000,
        timeoutMsg: "the opt-in HTML export never wrote the device identifiers",
      },
    );
    const withIdentifiers = fs.readFileSync(HTML_REPORT_PATH, "utf8");
    expect(withIdentifiers).toContain("E2E001");
    expect(withIdentifiers).not.toContain("What is redacted");

    // Clean up the written artifact — nothing may linger.
    fs.rmSync(HTML_REPORT_PATH, { force: true });
  });

  it("notebook: empty state, a scripted scan records devices with versions, and a note persists", async () => {
    // Deterministic start: clear the app's own notebook store through the
    // real IPC command (the store the Clear-notebook flow manages). The E2E
    // binary keeps this store under e2e/.run/notebook
    // (DRIVERLENS_E2E_NOTEBOOK_DIR) — never the real user store.
    const cleared = await invokeFromPage("clear_notebook");
    expect(cleared.ok).toBe(true);

    // Notebook view: the disclosure copy, the empty state, and a disabled
    // Clear button (there is nothing to clear yet).
    await (await $(NOTEBOOK_BUTTON)).click();
    await (await $(".notebook")).waitForDisplayed({ timeout: 15000 });
    await waitForText(".notebook .app__note", NOTEBOOK_DISCLOSURE_TEXT);
    const emptyState = await $(".notebook .app__empty");
    await emptyState.waitForDisplayed({ timeout: 10000 });
    await expect(emptyState).toHaveText(NOTEBOOK_EMPTY_TEXT);
    expect(await (await $(".notebook .app__panel-head button")).isEnabled()).toBe(false);
    await screenshot("notebook-empty");

    // Run a real scripted scan from the scan view (the same UI path the scan
    // cases drive), then return: the accepted scan is recorded with its
    // driver versions.
    await (await $(SCAN_VIEW_BUTTON)).click();
    setScenario("success");
    await (await $(SCAN_BUTTON)).click();
    await waitForText(SCAN_STATUS, "Scan complete");
    await browser.waitUntil(async () => (await $$("tr.device-row")).length === 3, {
      timeout: 20000,
      timeoutMsg: "the notebook-case scan never delivered its 3 devices",
    });

    await (await $(NOTEBOOK_BUTTON)).click();
    await browser.waitUntil(async () => (await $$(NOTEBOOK_DEVICE)).length === 3, {
      timeout: 20000,
      timeoutMsg: "the notebook never showed the scan's 3 recorded devices",
    });
    const rows = await notebookRowTexts();
    expect(rows.length).toBe(3);
    // Most-recently-seen first, ties broken by key: the fixture order, each
    // row carrying the current driver version next to the VID:PID.
    expect(rows[0]).toContain("Scripted Synthetic Adapter");
    expect(rows[0]).toContain("0403:6001 · 1.0");
    expect(rows[0]).toContain("Last seen");
    expect(rows[1]).toContain("Scripted Legacy Peripheral");
    expect(rows[1]).toContain("· 0.9");
    expect(rows[2]).toContain("Scripted System Root Component");
    expect(rows[2]).toContain("· 1.0");

    // Note save through the real command: select the first device, write a
    // note, save it.
    await (await $$(NOTEBOOK_DEVICE))[0].click();
    const noteField = await $(NOTEBOOK_NOTE);
    await noteField.waitForDisplayed({ timeout: 10000 });
    await noteField.setValue(NOTEBOOK_NOTE_TEXT);
    await (await $(SAVE_NOTE_BUTTON)).click();
    await browser.waitUntil(
      async () => {
        const notice = await $(NOTEBOOK_SAVE_NOTICE);
        if (!(await notice.isExisting())) return false;
        return (await notice.getText()).includes("Note saved.");
      },
      { timeout: 15000, timeoutMsg: "the note save never reported success" },
    );

    // Persistence within the session: leave the view and return — the
    // component refetches the store, so what it shows is what was stored.
    await (await $(SCAN_VIEW_BUTTON)).click();
    await (await $(NOTEBOOK_BUTTON)).click();
    await browser.waitUntil(async () => (await $$(NOTEBOOK_DEVICE)).length === 3, {
      timeout: 20000,
      timeoutMsg: "the notebook never reloaded its recorded devices",
    });
    const reloaded = await notebookRowTexts();
    expect(reloaded[0]).toContain("Has note");
    await (await $$(NOTEBOOK_DEVICE))[0].click();
    const reloadedField = await $(NOTEBOOK_NOTE);
    await reloadedField.waitForDisplayed({ timeout: 10000 });
    expect(await reloadedField.getValue()).toBe(NOTEBOOK_NOTE_TEXT);

    // And the store itself (real IPC read) carries the note.
    const stored = await invokeFromPage("get_notebook");
    expect(stored.ok).toBe(true);
    const view = stored.value as { devices?: Array<{ name: string; note: string }> };
    const record = (view.devices ?? []).find(
      (device) => device.name === "Scripted Synthetic Adapter",
    );
    expect(record?.note).toBe(NOTEBOOK_NOTE_TEXT);
    await screenshot("notebook");
  });

  it("console stayed clean throughout the run", async () => {
    const { appErrors, harnessNoise } = partitionConsoleErrors(await readConsoleErrors());
    runNotes.push(
      `console: ${appErrors.length} app error(s); ${harnessNoise.length} known harness line(s) filtered`,
    );
    expect(appErrors).toEqual([]);
  });
});
