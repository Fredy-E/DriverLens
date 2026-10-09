// @vitest-environment jsdom
/**
 * USB Device Notebook view tests (extension E-01).
 *
 * REAL interface assertions (not static strings): the component fetches the
 * notebook on mount, renders the local-only disclosure, the empty state, the
 * device list (name, VID:PID, current driver version, status, last seen, the
 * version-change indicator), the note editor with a Save button and saved
 * feedback, and the Clear button with its confirm step — all driven through
 * real click/keyboard events. The App-level test proves the view switcher and
 * that the notebook is only fetched when the Notebook view is opened (no
 * startup IPC beyond the read-only scan-state sync).
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/adapters/native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/native")>();
  return {
    ...actual,
    scanDevices: vi.fn(),
    getScanState: vi.fn(),
    getReport: vi.fn(),
    cancelScan: vi.fn(),
    openReport: vi.fn(),
    exportReport: vi.fn(),
    getNotebook: vi.fn(),
    saveDeviceNote: vi.fn(),
    clearNotebook: vi.fn(),
  };
});

import App from "../src/App";
import NotebookView from "../src/components/NotebookView";
import {
  clearNotebook,
  getNotebook,
  getScanState,
  saveDeviceNote,
  type NotebookDevice,
  type NotebookView as NotebookData,
} from "../src/adapters/native";

const getNotebookMock = vi.mocked(getNotebook);
const saveDeviceNoteMock = vi.mocked(saveDeviceNote);
const clearNotebookMock = vi.mocked(clearNotebook);

const DISCLOSURE = "Scan history and notes are stored only on this PC. Nothing is uploaded.";

/** Deterministic UTC timestamps: 2026-10-09 12:00 UTC. */
const T_CHANGE = Date.UTC(2026, 9, 9, 12, 0);
const T_FIRST = Date.UTC(2026, 9, 1, 8, 30);

function device(overrides: Partial<NotebookDevice> = {}): NotebookDevice {
  return {
    key: "SAMPLE001",
    name: "Example USB Serial Adapter",
    vid: "0403",
    pid: "6001",
    bus: "USB",
    deviceClass: "Ports",
    firstSeen: T_FIRST,
    lastSeen: T_CHANGE,
    observations: [
      {
        at: T_CHANGE,
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
    changes: [{ at: T_CHANGE, field: "version", from: "14.0.1", to: "14.0.2" }],
    note: "",
    ...overrides,
  };
}

const VIEW: NotebookData = { devices: [device()], updatedAt: T_CHANGE };

beforeEach(() => {
  getNotebookMock.mockReset();
  saveDeviceNoteMock.mockReset();
  clearNotebookMock.mockReset();
  vi.mocked(getScanState).mockReset();
  vi.mocked(getScanState).mockResolvedValue({ state: "idle", generation: 0 });
});

afterEach(() => {
  cleanup();
});

const user = () => userEvent.setup();

describe("NotebookView — disclosure and empty state", () => {
  it("always shows the local-only disclosure and the empty state when nothing was recorded", async () => {
    getNotebookMock.mockResolvedValue({ devices: [], updatedAt: 0 });
    render(<NotebookView />);

    expect(screen.getByText(DISCLOSURE)).toBeTruthy();
    expect(await screen.findByText(/No scans recorded yet/)).toBeTruthy();
    // Nothing selectable, nothing to save yet.
    expect(screen.queryByRole("button", { name: "Save note" })).toBeNull();
  });

  it("shows a readable notice when the notebook cannot be read", async () => {
    getNotebookMock.mockRejectedValue({ code: "io", message: "The notebook store could not be read." });
    render(<NotebookView />);
    expect(await screen.findByText(/The notebook could not be read/)).toBeTruthy();
  });
});

describe("NotebookView — device list", () => {
  it("lists name, VID:PID, current version, status, last seen and the version change", async () => {
    getNotebookMock.mockResolvedValue(VIEW);
    render(<NotebookView />);

    const item = await screen.findByRole("button", { name: /Example USB Serial Adapter/ });
    expect(item.textContent).toContain("0403:6001");
    expect(item.textContent).toContain("14.0.2");
    expect(item.textContent).toContain("OK");
    expect(item.textContent).toContain("Last seen 2026-10-09 12:00");
    expect(item.textContent).toContain("14.0.1 -> 14.0.2 (2026-10-09)");
    expect(item.getAttribute("aria-pressed")).toBe("false");
  });

  it("marks unknown evidence honestly (no VID/PID, no version, no change)", async () => {
    getNotebookMock.mockResolvedValue({
      devices: [
        device({
          key: "BARE",
          name: "Bare device",
          vid: null,
          pid: null,
          changes: [],
          current: { version: null, provider: null, windowsStatus: null, errorCode: null },
        }),
      ],
      updatedAt: T_CHANGE,
    });
    render(<NotebookView />);

    const item = await screen.findByRole("button", { name: /Bare device/ });
    expect(item.textContent).toContain("VID/PID unknown");
    expect(item.textContent).toContain("Version unknown");
    expect(item.textContent).toContain("status unknown");
  });
});

describe("NotebookView — notes", () => {
  it("selects a device with the keyboard, edits the note and saves it with the exact key and text", async () => {
    getNotebookMock.mockResolvedValue(VIEW);
    saveDeviceNoteMock.mockResolvedValue({ ok: true });
    render(<NotebookView />);

    const item = await screen.findByRole("button", { name: /Example USB Serial Adapter/ });
    item.focus();
    expect(document.activeElement).toBe(item);
    await user().keyboard("{Enter}");
    expect(item.getAttribute("aria-pressed")).toBe("true");

    const textarea = screen.getByRole("textbox", {
      name: "Note for Example USB Serial Adapter",
    }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    await user().type(textarea, "Firmware reflashed on the bench");
    await user().click(screen.getByRole("button", { name: "Save note" }));

    expect(saveDeviceNoteMock).toHaveBeenCalledWith("SAMPLE001", "Firmware reflashed on the bench");
    expect(await screen.findByText("Note saved.")).toBeTruthy();
    // The saved note is reflected in the list state.
    expect(item.textContent).toContain("Has note");
  });

  it("loads an existing note into the editor when the device is selected", async () => {
    getNotebookMock.mockResolvedValue({
      devices: [device({ note: "Bench unit 3" })],
      updatedAt: T_CHANGE,
    });
    render(<NotebookView />);

    await user().click(await screen.findByRole("button", { name: /Example USB Serial Adapter/ }));
    const textarea = screen.getByRole("textbox", {
      name: "Note for Example USB Serial Adapter",
    }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("Bench unit 3");
    expect(textarea.getAttribute("maxlength")).toBe("4000");
  });

  it("surfaces a save refusal without losing the draft", async () => {
    getNotebookMock.mockResolvedValue(VIEW);
    saveDeviceNoteMock.mockRejectedValue({
      code: "unknown_key",
      message: "No device with that key exists in the notebook.",
    });
    render(<NotebookView />);

    await user().click(await screen.findByRole("button", { name: /Example USB Serial Adapter/ }));
    const textarea = screen.getByRole("textbox", {
      name: "Note for Example USB Serial Adapter",
    }) as HTMLTextAreaElement;
    await user().type(textarea, "draft text");
    await user().click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText(/Save failed/)).toBeTruthy();
    expect(screen.getByText(/No device with that key exists/)).toBeTruthy();
    expect(textarea.value).toBe("draft text");
  });
});

describe("NotebookView — clear notebook with a confirm step", () => {
  it("requires an explicit confirmation, supports cancel, and clears on confirm", async () => {
    getNotebookMock
      .mockResolvedValueOnce(VIEW)
      .mockResolvedValue({ devices: [], updatedAt: 0 });
    clearNotebookMock.mockResolvedValue({ ok: true });
    render(<NotebookView />);

    await screen.findByRole("button", { name: /Example USB Serial Adapter/ });
    await user().click(screen.getByRole("button", { name: "Clear notebook" }));

    // Confirm step: nothing has been cleared yet.
    expect(clearNotebookMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Clear the notebook\?/)).toBeTruthy();

    // Cancel keeps everything.
    await user().click(screen.getByRole("button", { name: "Keep notebook" }));
    expect(clearNotebookMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Clear the notebook\?/)).toBeNull();

    // Confirm clears and the view reloads empty.
    await user().click(screen.getByRole("button", { name: "Clear notebook" }));
    await user().click(screen.getByRole("button", { name: "Yes, clear notebook" }));
    expect(clearNotebookMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/No scans recorded yet/)).toBeTruthy();
    expect(await screen.findByText("Notebook cleared.")).toBeTruthy();
  });
});

describe("App — view switcher", () => {
  it("switches between the scan view and the notebook view; the notebook is fetched only when opened", async () => {
    getNotebookMock.mockResolvedValue(VIEW);
    render(<App />);

    // Scan view by default; no notebook IPC at startup.
    expect(await screen.findByRole("button", { name: "Scan this PC" })).toBeTruthy();
    expect(getNotebookMock).not.toHaveBeenCalled();

    await user().click(screen.getByRole("button", { name: "Notebook view" }));
    expect(
      await screen.findByRole("button", { name: /Example USB Serial Adapter/ })
    ).toBeTruthy();
    expect(getNotebookMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Scan this PC" })).toBeNull();
    expect(screen.getByText(DISCLOSURE)).toBeTruthy();

    await user().click(screen.getByRole("button", { name: "Scan view" }));
    expect(await screen.findByRole("button", { name: "Scan this PC" })).toBeTruthy();
    expect(screen.queryByText(DISCLOSURE)).toBeNull();
  });

  it("is operable by keyboard: the switcher is reachable and activates with Enter", async () => {
    getNotebookMock.mockResolvedValue(VIEW);
    render(<App />);
    await screen.findByRole("button", { name: "Scan this PC" });

    const switcher = screen.getByRole("button", { name: "Notebook view" });
    switcher.focus();
    expect(document.activeElement).toBe(switcher);
    await user().keyboard("{Enter}");
    expect(await screen.findByText(DISCLOSURE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notebook view" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });
});
