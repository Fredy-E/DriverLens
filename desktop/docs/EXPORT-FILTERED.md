# Filtered export with `ids` — design note (Task 10)

Status: implemented and verified. Evidence: `cargo test` (scan::tests::filtered_export\_*,
`tests/ipc_boundary.rs::ipc_filtered_export_accepts_only_ids`) and the adapter suite
(`desktop/tests/native-adapter.test.ts`). Full logs in `driverlens-v2/evidence/export-extension.log`.

## Wire shape

`export_report` keeps its fixed name and gains exactly one OPTIONAL argument:

```
invoke("export_report")            → full export (stored report, unchanged, byte-for-byte)
invoke("export_report", { ids: [ … ] })  → filtered export
```

- `ids` is a `string[]` of device digests (`devices[].id`). Absent key or `null` → `None` → full export.
  (Tauri deserializes a missing key for `Option<T>` as `None`; verified in tauri 2.12.1
  `ipc/command.rs::deserialize_option` and by the IPC tests, which still exercise the no-argument call.)
- An explicit empty array is a filtered export of zero devices (`devices: []`), not a full export —
  the UI only produces it deliberately (the button label shows the match count).

## Selection semantics (server side, `scan.rs::filter_report_devices`)

1. **Validate before the dialog**: more than `MAX_DEVICES` (20 000) ids, or any id not present in the
   current in-memory report, is refused with `{ code: "invalid_selection", message }` **before** the
   save dialog opens. Messages count the unknowns ("1 of 2 …") and never echo device data.
2. **Exact set, report order**: the written `devices` array is the stored devices filtered by set
   membership — report order, deduplicated, no reordering, no mutation of the stored report.
3. Unknown/extra element contents pass through untouched: selection never edits a device object.

## schemaVersion compatibility and `filterNote`

- The document is `{ ...report, devices: <selection>, filterNote: "Filtered export from DriverLens" }` —
  the exact payload shape of the browser edition (`work/DriverLens/app.js:14`), including the note text.
- `filterNote` is a schemaVersion-1-compatible extension: the contract tolerates unknown top-level
  fields (forward compatibility within v1 — see `src/contracts/report.ts` and `src-tauri/src/report.rs`),
  so a filtered export **revalidates as a schemaVersion 1 report** (asserted in the Rust tests via
  `validate_report_str`). The constant lives in `scan.rs::FILTERED_EXPORT_NOTE`.
- A full export is the stored value unchanged and carries **no** `filterNote`.

## Reading the current report back (`get_report`)

A completed scan and an import both store their validated report in the same
in-memory slot — exactly the value `export_report` writes. `get_report`, a
sixth read-only, argument-free command, returns that stored report, or `null`
when none exists:

```
invoke("get_report")  → the current stored report (last accepted scan or import), or null
```

- Boundary: registered in `build.rs`'s `AppManifest::commands` (so
  `tauri-build` autogenerates the `allow-get-report` / `deny-get-report` pair)
  and granted to the `main` window only via `allow-get-report` in
  `capabilities/default.json`. Forged arguments are ignored end-to-end —
  verified by `tests/ipc_boundary.rs::ipc_get_report_returns_the_scan_report_and_ignores_forged_arguments`
  (null before any report, the synthetic scan's report after, no extra spawn,
  denial on capability-less windows and remote origins kept intact).
- The returned value is exactly what a full `export_report()` would write
  (stored JSON passthrough, `schemaVersion` normalized). It cannot start,
  cancel or influence anything: no process spawn, no dialog, and no path ever
  travels through it.
- UI flow: when a scan reaches Complete, `ScanControls` fetches the report
  once per generation (a complete state first observed at mount — e.g. a scan
  that finished earlier — is honored too), revalidates it with the same
  contract validator imports use, and hands it to the App's shared report
  path (`handleReportLoaded`), so the device table, stats, search/filters and
  both export buttons all operate on the scan's report. On a fetch or
  validation failure the scan panel says so and the table keeps its previous
  state — nothing is ever guessed into view.
- Sample chip semantics are unchanged (browser parity): the 'Fictional sample
  data' chip renders only while the displayed report is the bundled sample
  (`report.sample === true`); a real scan report replaces it.

## Security boundary (unchanged properties)

- Ids are opaque display strings: compared only as strings. They are never resolved, joined to a path,
  opened, or evaluated; the destination still comes exclusively from the native save dialog (its own
  overwrite confirmation remains the only one).
- The renderer holds no dialog/filesystem permission; the ACL is per command name
  (`allow-export-report`), so adding an argument required **no** `build.rs` / `capabilities` change
  (verified against `src-tauri/build.rs` + `capabilities/default.json`, and by the sibling-owned
  static suite `desktop/tests/bundle.test.cjs`).
- Best effort is bounded: `ids.len() <= MAX_DEVICES` plus O(devices + ids) set work.

## UI flow (`src/components/ReportActions.tsx`)

- `Export full` calls `exportReport()` with no argument. `Export filtered (N)` sends `idsForExport(filtered)`
  from `src/lib/selection.ts` (report order, deduplicated) — the same filtered result set the table renders,
  so the export can never disagree with what is on screen.
- Rejections surface as `Export failed — <message> (code)`; dialogs cancelled → explicit no-op notice.

## Resolution note

The former limitation — no command returned the current report, so a fresh scan could only be counted,
never displayed — is fixed by `get_report` (see "Reading the current report back" above): after a scan
completes, its report is fetched, revalidated and displayed through the same table path as imports.
