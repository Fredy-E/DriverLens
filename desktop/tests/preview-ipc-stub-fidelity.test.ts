/**
 * Preview IPC stub fidelity regression (review fix: faithful mocked preview-state capture).
 *
 * The Vite renderer capture runs in a plain browser with NO Tauri runtime, so
 * `invoke()` would reject and ScanControls would honestly render
 * "Could not read the current scan state. Start a scan to resync." The capture
 * harness stubs `window.__TAURI_INTERNALS__.invoke` from
 * tests/fixtures/preview-ipc-stub.json — this suite proves that stub is
 * faithful to the REAL command/type definitions, and that production error
 * handling was NOT touched to beautify the capture:
 *
 * - exactly the ten real commands (lib.rs invoke_handler + adapters/native.ts);
 * - every synthetic payload matches its real shape (ScanSnapshot / Report|null /
 *   NotebookView / OkResponse / ExportSummary|null, camelCase, closed state/code sets);
 * - initial get_scan_state is idle/0 and get_report is null (no invented report);
 * - the genuine resync error DOM + message survive in ScanControls.tsx.
 *
 * Every renderer screenshot taken with this stub is SIMULATED — not native
 * IPC/hardware proof (see evidence IMPLEMENTATION.md + result.json).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STUB = JSON.parse(
  readFileSync(new URL("./fixtures/preview-ipc-stub.json", import.meta.url), "utf8")
) as {
  simulated: boolean;
  commands: Record<string, { args: string[]; synthetic: unknown }>;
};

const ADAPTER = readFileSync(new URL("../src/adapters/native.ts", import.meta.url), "utf8");
const LIB_RS = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const SCAN_CONTROLS = readFileSync(
  new URL("../src/components/ScanControls.tsx", import.meta.url),
  "utf8"
);

/** The ten real commands (commands.rs boundary, lib.rs invoke_handler, adapter wrappers). */
const TEN = [
  "scan_devices",
  "get_scan_state",
  "cancel_scan",
  "open_report",
  "export_report",
  "export_html_report",
  "get_report",
  "get_notebook",
  "save_device_note",
  "clear_notebook",
] as const;

const STATES = ["idle", "running", "complete", "error", "cancelled"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("preview IPC stub fidelity — faithful synthetic mock, genuine error DOM intact", () => {
  it("is explicitly marked simulated (never native IPC/hardware proof)", () => {
    expect(STUB.simulated).toBe(true);
  });

  it("covers exactly the ten real commands — no more, no fewer, no renamed commands", () => {
    expect(Object.keys(STUB.commands).sort()).toEqual([...TEN].sort());
    for (const name of TEN) {
      // Adapter wrapper invokes the fixed command name...
      expect(ADAPTER, `adapter must invoke ${name}`).toContain(`"${name}"`);
      // ...and the Rust invoke_handler registers it.
      expect(LIB_RS, `lib.rs must register ${name}`).toContain(name);
    }
  });

  it("repairs the missing mock without inventing state (idle/0 + null report + empty notebook)", () => {
    const state = STUB.commands["get_scan_state"].synthetic as Record<string, unknown>;
    expect(state).toEqual({ state: "idle", generation: 0 });
    expect(STATES).toContain(state["state"] as string);
    expect(STUB.commands["get_report"].synthetic).toBeNull();
    expect(STUB.commands["get_notebook"].synthetic).toEqual({ devices: [], updatedAt: 0 });
  });

  it("matches every real payload shape (camelCase, closed sets, nullable cancel semantics)", () => {
    // scan_devices synthetic: a Running snapshot (startedMs present only while running).
    const running = STUB.commands["scan_devices"].synthetic as Record<string, unknown>;
    expect(STATES).toContain(running["state"] as string);
    expect(typeof running["generation"]).toBe("number");
    expect(typeof running["startedMs"]).toBe("number");

    // Notebook view: camelCase updatedAt, devices array.
    const notebook = STUB.commands["get_notebook"].synthetic as Record<string, unknown>;
    expect(Array.isArray(notebook["devices"])).toBe(true);
    expect(typeof notebook["updatedAt"]).toBe("number");
    expect("updated_at" in notebook).toBe(false);

    // Write commands: uniform { ok: true }.
    expect(STUB.commands["save_device_note"].synthetic).toEqual({ ok: true });
    expect(STUB.commands["clear_notebook"].synthetic).toEqual({ ok: true });

    // Dialog commands: null = user cancelled (normal outcome, not an error).
    expect(STUB.commands["open_report"].synthetic).toBeNull();
    expect(STUB.commands["export_report"].synthetic).toBeNull();
    expect(STUB.commands["export_html_report"].synthetic).toBeNull();

    // Args mirror the real boundary: only export_report (ids?) and
    // export_html_report (html + suggestedName) and save_device_note (key+text)
    // take arguments; nothing takes a path/destination/program.
    expect(STUB.commands["scan_devices"].args).toEqual([]);
    expect(STUB.commands["get_scan_state"].args).toEqual([]);
    expect(STUB.commands["cancel_scan"].args).toEqual([]);
    expect(STUB.commands["open_report"].args).toEqual([]);
    expect(STUB.commands["get_report"].args).toEqual([]);
    expect(STUB.commands["get_notebook"].args).toEqual([]);
    expect(STUB.commands["clear_notebook"].args).toEqual([]);
    expect(STUB.commands["export_report"].args).toEqual(["ids?"]);
    expect(STUB.commands["export_html_report"].args).toEqual(["html", "suggestedName"]);
    expect(STUB.commands["save_device_note"].args).toEqual(["key", "text"]);
    for (const entry of Object.values(STUB.commands)) {
      for (const arg of entry.args) {
        expect(arg.toLowerCase()).not.toContain("path");
        expect(arg.toLowerCase()).not.toContain("program");
        expect(arg.toLowerCase()).not.toContain("destination");
      }
    }
  });

  it("keeps the genuine resync error DOM and production handling (never hidden for capture)", () => {
    // The honest notice outside Tauri must survive — the fix is the mock, not the UI.
    expect(SCAN_CONTROLS).toContain("Could not read the current scan state. Start a scan to resync.");
    expect(SCAN_CONTROLS).toContain("scan__status--error");
    expect(isRecord(STUB.commands["get_scan_state"].synthetic)).toBe(true);
  });
});
