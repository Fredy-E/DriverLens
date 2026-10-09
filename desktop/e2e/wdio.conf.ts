/**
 * Native E2E WebdriverIO configuration — DriverLens desktop (Task 12).
 *
 * Drives the feature-gated E2E binary (`--features wdio-e2e`) through the
 * `embedded` driver provider: the app itself hosts the W3C WebDriver server
 * (`tauri-plugin-wdio-webdriver` 1.5.0), so no external driver
 * (tauri-driver / msedgedriver) is needed on any platform. The service
 * spawns the app with `TAURI_WEBDRIVER_PORT` set and polls
 * `http://127.0.0.1:<port>/status` until ready.
 *
 * The app runs against SCRIPTED FAKE collectors only (src-tauri/src/
 * e2e_harness.rs): the DRIVERLENS_E2E_* environment below configures the
 * scenario queue, the fake dialog paths and the fast scan deadline. No real
 * device inventory can ever be collected by this suite.
 *
 * Run: `npm --prefix desktop run test:native` (see docs/NATIVE-E2E.md).
 */
import type { Options } from "@wdio/types";

import {
  E2E_BINARY,
  E2E_TIMEOUT_MS,
  EXPORT_REPORT_PATH,
  IMPORT_REPORT_PATH,
  SCENARIO_FILE,
} from "./run-paths";

export const config: Options.Testrunner = {
  runner: "local",

  specs: ["./driverlens.spec.ts"],
  exclude: [],

  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: E2E_BINARY,
      },
    },
  ],

  logLevel: "info",
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 2,

  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    // Long enough for the timeout case (deadline + polling) on slow machines.
    timeout: 180000,
  },

  reporters: ["spec"],

  services: [
    [
      "@wdio/tauri-service",
      {
        // Embedded W3C WebDriver server inside the app — no external driver,
        // no msedgedriver arch questions on ARM64.
        driverProvider: "embedded",
        appBinaryPath: E2E_BINARY,
        startTimeout: 120000,
        statusPollTimeout: 5000,
        commandTimeout: 60000,
        // The app's stdout/stderr surface in the WDIO log (diagnostics).
        captureBackendLogs: true,
        captureFrontendLogs: false,
        env: {
          // Fallback scenario queue; the spec's control file (below) takes
          // precedence per spawn so one session can exercise all scenarios.
          DRIVERLENS_E2E_SCENARIO: "success",
          DRIVERLENS_E2E_SCENARIO_FILE: SCENARIO_FILE,
          DRIVERLENS_E2E_OPEN_PATH: IMPORT_REPORT_PATH,
          DRIVERLENS_E2E_SAVE_PATH: EXPORT_REPORT_PATH,
          DRIVERLENS_E2E_TIMEOUT_MS: E2E_TIMEOUT_MS,
        },
      },
    ],
  ],
};
