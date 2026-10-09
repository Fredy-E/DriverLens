/**
 * Notebook adapter tests (extension E-01) — same style as
 * `native-adapter.test.ts`: `@tauri-apps/api/core` is mocked, no Tauri runtime
 * is involved.
 *
 * The three wrappers must invoke EXACT fixed command names: `get_notebook`
 * and `clear_notebook` with ZERO arguments, `save_device_note` with exactly
 * `{ key, text }` (a store lookup key and the note text — never a path, a
 * command, or a destination).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

import {
  clearNotebook,
  getNotebook,
  isScanError,
  saveDeviceNote,
  type NotebookView,
} from "../src/adapters/native";

const invokeMock = vi.mocked(invoke);

function lastCall(): unknown[] {
  expect(invokeMock).toHaveBeenCalledTimes(1);
  return invokeMock.mock.calls[0];
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("native adapter — notebook command names and exact arguments", () => {
  it("getNotebook invokes get_notebook with no arguments", async () => {
    const view: NotebookView = { devices: [], updatedAt: 0 };
    invokeMock.mockResolvedValue(view);
    await expect(getNotebook()).resolves.toEqual(view);
    expect(lastCall()).toEqual(["get_notebook"]);
  });

  it("saveDeviceNote invokes save_device_note with exactly { key, text }", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await expect(saveDeviceNote("SAMPLE001", "Firmware reflashed")).resolves.toEqual({ ok: true });
    expect(lastCall()).toEqual([
      "save_device_note",
      { key: "SAMPLE001", text: "Firmware reflashed" },
    ]);
  });

  it("clearNotebook invokes clear_notebook with no arguments", async () => {
    invokeMock.mockResolvedValue({ ok: true });
    await expect(clearNotebook()).resolves.toEqual({ ok: true });
    expect(lastCall()).toEqual(["clear_notebook"]);
  });

  it("passes a full notebook view through unchanged", async () => {
    const view: NotebookView = {
      devices: [
        {
          key: "SAMPLE001",
          name: "Example USB Serial Adapter",
          vid: "0403",
          pid: "6001",
          bus: "USB",
          deviceClass: "Ports",
          firstSeen: 1_700_000_000_000,
          lastSeen: 1_700_000_100_000,
          observations: [
            {
              at: 1_700_000_000_000,
              version: "14.0.1",
              provider: "Example provider",
              windowsStatus: "OK",
              errorCode: 0,
            },
            {
              at: 1_700_000_100_000,
              version: "14.0.2",
              provider: "Example provider",
              windowsStatus: "OK",
              errorCode: 0,
            },
          ],
          current: {
            version: "14.0.2",
            provider: "Example provider",
            windowsStatus: "OK",
            errorCode: 0,
          },
          changes: [
            { at: 1_700_000_100_000, field: "version", from: "14.0.1", to: "14.0.2" },
          ],
          note: "Bench unit",
        },
      ],
      updatedAt: 1_700_000_100_000,
    };
    invokeMock.mockResolvedValue(view);
    const result = await getNotebook();
    expect(result).toEqual(view);
    expect(result.devices[0].changes[0].field).toBe("version");
  });
});

describe("native adapter — notebook error surface", () => {
  it("propagates unknown_key and note_too_long refusals untouched", async () => {
    const unknownKey = {
      code: "unknown_key",
      message: "No device with that key exists in the notebook.",
    };
    invokeMock.mockRejectedValue(unknownKey);
    await expect(saveDeviceNote("missing", "x")).rejects.toEqual(unknownKey);
    expect(isScanError(unknownKey)).toBe(true);

    const tooLong = { code: "note_too_long", message: "The note exceeds the 4000 character limit." };
    invokeMock.mockRejectedValue(tooLong);
    await expect(saveDeviceNote("SAMPLE001", "x")).rejects.toEqual(tooLong);
    expect(isScanError(tooLong)).toBe(true);
  });

  it("propagates an ACL denial string untouched (not a ScanError)", async () => {
    const denial = "Command get_notebook not allowed.";
    invokeMock.mockRejectedValue(denial);
    await expect(getNotebook()).rejects.toBe(denial);
    await expect(clearNotebook()).rejects.toBe(denial);
  });
});
