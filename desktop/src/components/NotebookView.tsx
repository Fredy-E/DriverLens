/**
 * USB Device Notebook view (extension E-01).
 *
 * Reads the local-only notebook store through `get_notebook` (fetched on
 * mount — nothing is fetched until this view is opened), lists every device
 * recorded by past scans (name, VID:PID, current driver version, status, last
 * seen, and a version-change indicator like `14.0.1 -> 14.0.2 (2026-10-09)`),
 * and edits per-device notes through `save_device_note`. `clear_notebook` is
 * guarded by an explicit confirm step.
 *
 * Everything here is keyboard operable and labelled: the device list is a set
 * of real buttons (Tab to reach, Enter/Space to select, `aria-pressed` for the
 * selection), the note editor is a labelled textarea with a Save button, and
 * the clear flow is two buttons (confirm / keep). The store lives only on
 * this PC; nothing is uploaded.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearNotebook,
  getNotebook,
  isScanError,
  saveDeviceNote,
  type NotebookDevice,
  type NotebookView as NotebookData,
} from "../adapters/native";
import { formatDateTime, latestChange, versionChangeLabel, vidPidLabel } from "../lib/notebook-format";
import { commandErrorText } from "../lib/scan-messages";

/** Local-only disclosure shown at the top of the view. */
export const NOTEBOOK_DISCLOSURE =
  "Scan history and notes are stored only on this PC. Nothing is uploaded.";

/** Empty-state copy: no scan has recorded anything yet. */
export const NOTEBOOK_EMPTY =
  "No scans recorded yet — run a scan and its devices will appear here.";

/** Note cap, mirrored by the Rust store (`MAX_NOTE_CHARS`). */
export const NOTEBOOK_NOTE_MAX = 4000;

interface Notice {
  tone: "info" | "error";
  text: string;
}

export default function NotebookView() {
  const [data, setData] = useState<NotebookData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<Notice | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearNotice, setClearNotice] = useState<Notice | null>(null);
  /** False after unmount: late async resolutions must not set state. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await getNotebook();
      if (!alive.current) return;
      setData(next);
      setLoadError(null);
    } catch (error) {
      if (!alive.current) return;
      setLoadError(commandErrorText(error, isScanError(error) ? error.code : undefined));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected =
    data === null ? null : data.devices.find((device) => device.key === selectedKey) ?? null;

  const select = useCallback((device: NotebookDevice) => {
    setSelectedKey(device.key);
    setDraft(device.note);
    setSaveNotice(null);
  }, []);

  const save = useCallback(async () => {
    if (selected === null || saving) return;
    const key = selected.key;
    setSaving(true);
    setSaveNotice(null);
    try {
      await saveDeviceNote(key, draft);
      if (!alive.current) return;
      // The save succeeded, so reflecting the draft in the list is exact.
      setData((current) =>
        current === null
          ? current
          : {
              ...current,
              devices: current.devices.map((device) =>
                device.key === key ? { ...device, note: draft } : device
              ),
            }
      );
      setSaveNotice({ tone: "info", text: "Note saved." });
    } catch (error) {
      if (!alive.current) return;
      setSaveNotice({
        tone: "error",
        text: `Save failed — ${commandErrorText(
          error,
          isScanError(error) ? error.code : undefined
        )}`,
      });
    } finally {
      if (alive.current) setSaving(false);
    }
  }, [draft, saving, selected]);

  const doClear = useCallback(async () => {
    if (clearing) return;
    setClearing(true);
    setClearNotice(null);
    try {
      await clearNotebook();
      if (!alive.current) return;
      setConfirmClear(false);
      setSelectedKey(null);
      setDraft("");
      setSaveNotice(null);
      await load();
      if (!alive.current) return;
      setClearNotice({ tone: "info", text: "Notebook cleared." });
    } catch (error) {
      if (!alive.current) return;
      setClearNotice({
        tone: "error",
        text: `Clear failed — ${commandErrorText(
          error,
          isScanError(error) ? error.code : undefined
        )}`,
      });
    } finally {
      if (alive.current) setClearing(false);
    }
  }, [clearing, load]);

  const empty = data !== null && data.devices.length === 0;

  return (
    <section className="app__panel notebook" aria-labelledby="notebook-title">
      <div className="app__panel-head">
        <h2 id="notebook-title">Notebook</h2>
        <button
          type="button"
          className="button"
          onClick={() => {
            setConfirmClear(true);
            setClearNotice(null);
          }}
          disabled={clearing || empty || data === null}
          title="Remove the scan history and notes stored on this PC."
        >
          Clear notebook
        </button>
      </div>
      <p className="app__note">{NOTEBOOK_DISCLOSURE}</p>

      {loadError !== null ? (
        <p className="app__note app__note--error" role="status">
          The notebook could not be read — {loadError}
        </p>
      ) : data === null ? (
        <p className="app__note" role="status">
          Loading the notebook…
        </p>
      ) : empty ? (
        <p className="app__empty">{NOTEBOOK_EMPTY}</p>
      ) : (
        <div className="notebook__layout">
          <ul className="notebook__list" aria-label="Notebook devices">
            {data.devices.map((device) => {
              const change = latestChange(device, "version");
              return (
                <li key={device.key}>
                  <button
                    type="button"
                    className="notebook__device"
                    aria-pressed={selectedKey === device.key}
                    onClick={() => select(device)}
                  >
                    <span className="notebook__device-name">
                      {device.name || "Unnamed device"}
                    </span>
                    <span className="notebook__device-meta mono">
                      {vidPidLabel(device.vid, device.pid)} ·{" "}
                      {device.current.version || "Version unknown"}
                    </span>
                    <span className="notebook__device-meta">
                      {device.current.windowsStatus || "status unknown"} · Last seen{" "}
                      {formatDateTime(device.lastSeen)}
                    </span>
                    {change !== null ? (
                      <span className="badge notebook__change">
                        {versionChangeLabel(change)}
                      </span>
                    ) : null}
                    {device.note !== "" ? (
                      <span className="notebook__device-meta">Has note</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="notebook__detail">
            {selected === null ? (
              <p className="app__note">Select a device to read or edit its note.</p>
            ) : (
              <div className="field">
                <label className="field__label" htmlFor="notebook-note">
                  Note for {selected.name || "Unnamed device"}
                </label>
                <textarea
                  id="notebook-note"
                  className="input notebook__textarea"
                  rows={5}
                  maxLength={NOTEBOOK_NOTE_MAX}
                  value={draft}
                  placeholder="What should you remember about this device?"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="notebook__note-actions">
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => {
                      void save();
                    }}
                    disabled={saving}
                  >
                    {saving ? "Saving…" : "Save note"}
                  </button>
                  {saveNotice !== null ? (
                    <span
                      className={
                        saveNotice.tone === "error" ? "app__note app__note--error" : "app__note"
                      }
                      role="status"
                    >
                      {saveNotice.text}
                    </span>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {confirmClear ? (
        <div className="notebook__confirm" role="group" aria-label="Confirm clearing the notebook">
          <p className="app__note">
            Clear the notebook? This removes the scan history and notes stored on this PC. This
            cannot be undone.
          </p>
          <div className="notebook__actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                void doClear();
              }}
              disabled={clearing}
            >
              {clearing ? "Clearing…" : "Yes, clear notebook"}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setConfirmClear(false)}
              disabled={clearing}
            >
              Keep notebook
            </button>
          </div>
        </div>
      ) : null}

      {clearNotice !== null ? (
        <p
          className={clearNotice.tone === "error" ? "app__note app__note--error" : "app__note"}
          role="status"
        >
          {clearNotice.text}
        </p>
      ) : null}
    </section>
  );
}
