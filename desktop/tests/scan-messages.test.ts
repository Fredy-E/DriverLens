import { describe, expect, it } from "vitest";

import type { ScanErrorCode } from "../src/adapters/native";
import {
  SCAN_STATE_LABELS,
  commandErrorText,
  scanCancelledMessage,
  scanCompleteMessage,
  scanErrorGuidance,
  scanIdleMessage,
  scanRunningMessage,
} from "../src/lib/scan-messages";

/**
 * The snapshot carries only an `errorCode`; these functions are the entire
 * user-facing vocabulary for terminal scan states. Every code must map to a
 * clear message, and `executable_missing` must carry the explicit
 * PowerShell 7 guidance.
 */

const ALL_CODES: ScanErrorCode[] = [
  "busy",
  "executable_missing",
  "timeout",
  "cancelled",
  "exit_failure",
  "output_missing",
  "too_large",
  "invalid_report",
  "invalid_selection",
  "io",
];

describe("scan state messages", () => {
  it("labels all five lifecycle states", () => {
    expect(Object.keys(SCAN_STATE_LABELS).sort()).toEqual(
      ["cancelled", "complete", "error", "idle", "running"].sort()
    );
  });

  it("keeps the browser edition's running string verbatim", () => {
    expect(scanRunningMessage()).toBe("Reading Windows device and driver metadata…");
  });

  it("renders the idle message as a ready state, not an error", () => {
    expect(scanIdleMessage()).toContain("Ready");
    expect(scanIdleMessage().toLowerCase()).not.toContain("fail");
  });

  it("shows the device count on Complete and allows a new scan", () => {
    expect(
      scanCompleteMessage({ state: "complete", generation: 1, deviceCount: 412 })
    ).toContain("412 devices");
    expect(
      scanCompleteMessage({ state: "complete", generation: 1, deviceCount: 1 })
    ).toContain("1 device");
    expect(scanCompleteMessage({ state: "complete", generation: 1 })).toContain("Scan complete");
  });

  it("says the previous report is unchanged on cancel", () => {
    expect(scanCancelledMessage()).toContain("unchanged");
  });

  it("maps every error code to a non-empty, code-specific message", () => {
    const messages = new Set<string>();
    for (const code of ALL_CODES) {
      const text = scanErrorGuidance(code);
      expect(text.length, code).toBeGreaterThan(20);
      messages.add(text);
    }
    expect(messages.size).toBe(ALL_CODES.length);
  });

  it("gives explicit PowerShell 7 guidance for executable_missing", () => {
    const text = scanErrorGuidance("executable_missing");
    expect(text).toContain("PowerShell 7");
    expect(text).toContain("pwsh.exe");
    expect(text).toContain("DRIVERLENS_POWERSHELL");
    expect(text.toLowerCase()).toContain("winget install");
  });

  it("explains a missing report and an invalid export selection", () => {
    expect(scanErrorGuidance("output_missing").toLowerCase()).toContain("no report");
    expect(scanErrorGuidance("invalid_selection").toLowerCase()).toContain("current report");
  });

  it("has a defensive message for an unknown code", () => {
    expect(scanErrorGuidance("future_code" as ScanErrorCode)).toContain("future_code");
    expect(scanErrorGuidance(undefined)).toContain("unknown reason");
  });
});

describe("commandErrorText", () => {
  it("prefers the backend's own message and appends the code when absent", () => {
    expect(
      commandErrorText({ code: "io", message: "An unexpected operating system error occurred." }, "io")
    ).toBe("An unexpected operating system error occurred. (io)");
  });

  it("does not duplicate a code already present in the message", () => {
    expect(commandErrorText({ code: "io", message: "failed: io" }, "io")).toBe("failed: io");
  });

  it("passes string rejections (ACL denials) through as-is", () => {
    expect(commandErrorText("Command scan_devices not allowed.", undefined)).toBe(
      "Command scan_devices not allowed."
    );
  });

  it("never throws on junk", () => {
    expect(commandErrorText(undefined, undefined)).toBe("The operation failed.");
    expect(commandErrorText({}, "busy")).toBe("The operation failed (busy).");
    expect(commandErrorText(42, undefined)).toBe("The operation failed.");
  });
});
