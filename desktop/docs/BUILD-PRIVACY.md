# Build path-privacy (desktop, development-only)

A raw Tauri/Rust production build can embed local machine paths (cargo registry
paths, workspace paths) into the executable — locally observed as
compiler-emitted registry paths in the first local build before remapping
(see `docs/UI-PREVIEW-VERIFICATION.md`, Artifact bytes section).
That is a path-privacy defect, not a functional one. The scanner below is
path-only: it checks machine-local path bytes and E2E markers in UTF-8/UTF-16LE
and makes no claim about credentials, reports, or device data, which a
path-only byte check cannot prove absent.

## Prerequisite for privacy-accepted binaries

Current candidate note: the `0.3.0-preview.1` artifacts named in
`docs/UI-PREVIEW-VERIFICATION.md` were built with equivalent compiler
`--remap-path-prefix` remapping before this wrapper existed, then verified to
zero checked path strings. They did not run through `build:private`.

Future/CI route: every future production or feature-E2E binary that is meant
to be privacy-accepted MUST be built through the `build:private` wrapper,
never through a raw `npm run tauri -- build ...` invocation:

```bash
# From desktop/ (bash / MSYS shown; PowerShell equivalent below):
npm run build:private -- --target aarch64-pc-windows-msvc --no-bundle

# Feature-gated E2E binary (separate artifact; the CLI honors
# CARGO_TARGET_DIR, which the wrapper inherits untouched):
export CARGO_TARGET_DIR="$(pwd -W)/src-tauri/target-e2e"  # native Windows path in Git Bash
npm run build:private -- --target aarch64-pc-windows-msvc --no-bundle --features wdio-e2e
```

```powershell
npm run build:private -- --target aarch64-pc-windows-msvc --no-bundle
$env:CARGO_TARGET_DIR="$PWD/src-tauri/target-e2e"
npm run build:private -- --target aarch64-pc-windows-msvc --no-bundle --features wdio-e2e
```

## How the wrapper works (`scripts/build-private.cjs`)

- Resolves the installed Tauri CLI entry (`node_modules/@tauri-apps/cli/tauri.js`,
  per that package's bin manifest) and spawns it with an arg array
  (`shell: false`). All caller args (`--target`, `--no-bundle`, `--features`,
  ...) pass through; the child exit code is propagated.
- Computes generic sensitive prefixes for the current machine — OS home,
  `CARGO_HOME` (or `<home>/.cargo`), the desktop workspace, the OS temp dir —
  in backslash AND forward-slash form, longest first, and appends one
  single-argv `--remap-path-prefix=FROM=/build-machine` entry per variant to
  `CARGO_ENCODED_RUSTFLAGS` (0x1F-separated, so entries with spaces or Unicode
  survive intact). Pre-existing encoded entries are preserved verbatim.
- Refuses with a static actionable message when legacy `RUSTFLAGS` is set to a
  non-blank value (space-separated flags cannot be merged safely, so refusing
  beats silently dropping them): unset it or migrate its entries to
  `CARGO_ENCODED_RUSTFLAGS` and re-run.
- Logs counts only. Env values, tokens, and path contents are never printed,
  and the script contains no literal source paths.

## Production scan (`scripts/verify-binary-privacy.cjs`)

After a production build, scan the EXTRACTED executable (never the compressed
installer — compression hides embedded strings, so an archive is not a valid
negative scan):

```bash
node scripts/verify-binary-privacy.cjs src-tauri/target/aarch64-pc-windows-msvc/release/driverlens-desktop.exe
```

The scanner fails closed (exit 1) on UTF-8 or UTF-16LE bytes of any
machine-local path, on any known E2E-only marker (`driverlens-wdio-e2e`,
`wdio-e2e`, `DRIVERLENS_E2E_*` prefix rule, `TAURI_WEBDRIVER_PORT`, the E2E
WebDriver plugin name, `e2eScriptedFake`) in a production binary, and on
missing/unreadable input.
Harmless generic labels (`src-tauri`, `main.rs`, `rustc`, ...) never match.
Reports carry counts and static labels only. The scanner is production-only:
the feature E2E binary legitimately contains E2E markers and is not scanned.

## CI wiring (`.github/workflows/desktop-verify.yml`)

Tier 1 builds production through `build:private` and then runs this scanner on
the built release exe (required step, no soft failures). Tier 2 builds the
feature E2E binary through `build:private` with the isolated
`CARGO_TARGET_DIR` unchanged (no production scan there — see above). All
pre-existing suites (cargo tests, typecheck, vitest, vite build, bundle/CSP
static tests, PE-machine/resources parity, legacy browser-edition invariants,
native E2E) are unchanged.

Note: the CI wiring in this file is static until a CI run executes it; nothing
here claims a fresh green CI run. Contract tests live in
`desktop/tests/build-privacy.test.ts` (default vitest suite, no new
dependencies).
