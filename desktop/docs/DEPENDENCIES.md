# DriverLens desktop — pinned dependencies (Task 5)

**Record date:** 2026-10-08.
**Environment used for resolution + verification:** Windows 11 (ARM64), Node.js **26.7.0**, npm **11.19.0**, rustc/cargo **1.98.0** (`aarch64-pc-windows-msvc`).
**Scope:** the `desktop/` scaffold only — React + TypeScript + Vite frontend and the Tauri 2 Rust shell.

Every npm version below is an **exact pin** (no `^`, no `~`) in `desktop/package.json`; `desktop/package-lock.json` (lockfileVersion 3, 606 entries including non-Windows optionals) fixes the full transitive tree. Rust crates use caret requirements (`"2"`, `"1"`) as agreed in Task 5 — the committed `desktop/src-tauri/Cargo.lock` (421 packages) is the pin.

## npm packages

| Package | Version (exact) | Role | `engines` (declared) | Why this one | Source |
|---|---|---|---|---|---|
| react | 19.3.0 | dependency | `>=0.10.0` | UI runtime for the desktop frontend; version line agreed for the desktop edition (Task 5 pin list). | https://www.npmjs.com/package/react/v/19.3.0 |
| react-dom | 19.3.0 | dependency | — | DOM renderer; version-locked 1:1 with `react`. | https://www.npmjs.com/package/react-dom/v/19.3.0 |
| @tauri-apps/api | 2.12.1 | dependency | — | Frontend-side Tauri core JS API (windows/events/IPC) for the app shell. | https://www.npmjs.com/package/@tauri-apps/api/v/2.12.1 |
| @tauri-apps/plugin-dialog | 2.8.1 | dependency | — | JS bindings for native dialogs; pairs with the `tauri-plugin-dialog` Rust crate (also 2.8.1). | https://www.npmjs.com/package/@tauri-apps/plugin-dialog/v/2.8.1 |
| @tauri-apps/cli | 2.12.1 | devDependency | `>=10` | `tauri` dev/build CLI used via `npm run tauri`; verified on this machine (`tauri-cli 2.12.1`). | https://www.npmjs.com/package/@tauri-apps/cli/v/2.12.1 |
| @types/react | 19.3.0 | devDependency | — | TypeScript typings matching `react` 19.3.0. | https://www.npmjs.com/package/@types/react/v/19.3.0 |
| @types/react-dom | 19.3.0 | devDependency | — | TypeScript typings matching `react-dom` 19.3.0. | https://www.npmjs.com/package/@types/react-dom/v/19.3.0 |
| @vitejs/plugin-react | 6.1.2 | devDependency | `^20.19.0 \|\| >=22.12.0` | React fast-refresh + JSX transform for Vite; peer-requires `vite ^8.0.0` (verified via `npm view`). | https://www.npmjs.com/package/@vitejs/plugin-react/v/6.1.2 |
| vite | 8.3.4 | devDependency | `^20.19.0 \|\| >=22.12.0` | Dev server (fixed port 1420 for Tauri) and production build (`vite build`). | https://www.npmjs.com/package/vite/v/8.3.4 |
| vitest | 5.0.3 | devDependency | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | Unit test runner for `npm run test`; peers accept `vite ^6.4 \|\| ^7 \|\| ^8` (verified). | https://www.npmjs.com/package/vitest/v/5.0.3 |
| webdriverio | 9.32.0 | devDependency | `>=18.20.0` | WDIO core for desktop E2E; **9.x required** because `@wdio/tauri-service` 1.5.0 peers `webdriverio ^9.0.0` (verified via `npm view`). WDIO 10 deliberately not used. | https://www.npmjs.com/package/webdriverio/v/9.32.0 |
| @wdio/cli | 9.32.0 | devDependency | `>=18.20.0` | WDIO runner CLI; lockstep with `webdriverio` 9.32.0. | https://www.npmjs.com/package/@wdio/cli/v/9.32.0 |
| @wdio/local-runner | 9.32.0 | devDependency | `>=18.20.0` | Local process runner for WDIO; lockstep with `webdriverio` 9.32.0. | https://www.npmjs.com/package/@wdio/local-runner/v/9.32.0 |
| @wdio/mocha-framework | 9.32.0 | devDependency | `>=18.20.0` | Mocha adapter for WDIO specs; lockstep with `webdriverio` 9.32.0. | https://www.npmjs.com/package/@wdio/mocha-framework/v/9.32.0 |
| @wdio/spec-reporter | 9.32.0 | devDependency | `>=18.20.0` | Console reporter for WDIO runs; lockstep with `webdriverio` 9.32.0. | https://www.npmjs.com/package/@wdio/spec-reporter/v/9.32.0 |
| @wdio/tauri-service | 1.5.0 | devDependency | `>=18.20.0` | Tauri-specific WDIO service (drives the native app binary); the package that fixes the whole WDIO set at 9.32.0. | https://www.npmjs.com/package/@wdio/tauri-service/v/1.5.0 |
| typescript | 5.9.3 | devDependency | `>=14.17` | Typechecker (`tsc --noEmit`). Chosen over the npm `latest` dist-tag 7.0.2 — see decision note below. | https://www.npmjs.com/package/typescript/v/5.9.3 |

Project-level floor: `engines.node: ">=22"` (locked by `desktop/tests/scaffold.test.ts`, together with the exact-pin invariant for all deps/devDeps).

## Rust crates (desktop/src-tauri/Cargo.toml)

| Crate | Requirement | Resolved (Cargo.lock) | MSRV (`rust-version`) | Why | Source |
|---|---|---|---|---|---|
| tauri | `"2"` | 2.12.1 | **1.90** | Core Tauri 2 runtime (window, event loop, IPC, context generation). | https://crates.io/crates/tauri/2.12.1 |
| tauri-build | `"2"` | 2.7.1 | 1.90 | Build-script codegen (`tauri_build::build()` in `build.rs`). | https://crates.io/crates/tauri-build/2.7.1 |
| tauri-plugin-dialog | `"2"` | 2.8.1 | 1.90 | Native dialogs; initialized via `tauri_plugin_dialog::init()` in `src/lib.rs`. | https://crates.io/crates/tauri-plugin-dialog/2.8.1 |
| serde | `"1"` (feature `derive`) | 1.0.229 | 1.56 | (De)serialization for future command payloads. | https://crates.io/crates/serde/1.0.229 |
| serde_json | `"1"` | 1.0.151 | 1.71 | JSON values for future command payloads. | https://crates.io/crates/serde_json/1.0.151 |

MSRV note: the highest requirement across resolved crates is **1.90** (Tauri family); the installed toolchain (rustc 1.98.0) satisfies it. MSRVs read from the fetched crate manifests in the local cargo registry cache after `cargo check`.

## Decisions

1. **TypeScript 5.9.3, not 7.0.2.** `npm view typescript dist-tags` reports `latest: 7.0.2`; the latest stable 5.x is 5.9.3. Task 5 policy prefers the 5.x line unless a `tsc --noEmit` smoke run proves 7.x clean. A smoke run was performed for the record: `npx -p typescript@7.0.2 tsc --version` → `Version 7.0.2`; `npx -p typescript@7.0.2 tsc --noEmit -p desktop/tsconfig.json` → **fails** (exit 1) with exactly one error: `TS2882: Cannot find module or type declarations for side-effect import of './styles.css'`. TS 7 checks side-effect imports by default; making the scaffold 7.x-clean would need `vite/client` asset declarations (e.g. `src/vite-env.d.ts`). 5.9.3 passes `tsc --noEmit` cleanly, so **5.9.3 is the pin**; a 7.x migration can be a separate, deliberate upgrade task. (Smoke log: scratch dir `driverlens-task5-ts7-smoke.log`.)
2. **Single `tsconfig.json`; no `tsconfig.node.json`.** `vite.config.ts` contains no Node-only imports (the create-tauri-app reference uses `node:process` for `TAURI_DEV_HOST`, which is exactly why its template needs `@types/node` or a `@ts-expect-error`), so it is included directly in the root program: `npm run typecheck` covers `src/`, `tests/` and `vite.config.ts` in one `tsc --noEmit` pass.
3. **WDIO pinned at 9.32.0 (not 10.x).** Verified: `@wdio/tauri-service@1.5.0` peerDependencies = `webdriverio ^9.0.0`; the whole @wdio set is kept in lockstep so no mixed-major adapter issues can arise.
4. **No `--force` and no `--legacy-peer-deps`.** The install resolved with zero peer conflicts on first attempt (546 packages added; all 17 pins resolved exactly as specified in the lockfile).
5. **Icons.** The Tauri icon set (`desktop/src-tauri/icons/`, 16 files) is copied from a throwaway `create-tauri-app` react-ts reference scaffold generated in a session scratch directory; it is the default Tauri icon artwork, not DriverLens branding.
6. **CSP** is left at the template default (`"csp": null`) per Task 5; production CSP hardening is a later task.

## Verification evidence (all exit codes 0)

Evidence directory: `driverlens-v2/evidence/`

- `scaffold-install.log` — `npm --prefix desktop install` → exit 0 (546 packages, no peer conflicts).
- `scaffold-frontend.log` — `npm --prefix desktop run build` → exit 0 (vite 8.3.4, 16 modules, `dist/index.html` emitted), `npm --prefix desktop run typecheck` → exit 0, `npm --prefix desktop run test` → exit 0 (vitest 5.0.3: 4/4 tests in `tests/scaffold.test.ts`).
- `scaffold-cargo-check.log` — `cargo check --manifest-path desktop/src-tauri/Cargo.toml` → exit 0 ("Finished `dev` profile … in 4m 22s"; tauri v2.12.1, tauri-plugin-dialog v2.8.1 compiled).

## Known advisories and deferrals

- `npm audit` reports 21 high-severity advisories in transitive **dev** dependencies (WDIO/driver tooling and legacy `glob`). Not auto-remediated: `npm audit fix --force` would change the pins; upgrade should be a separate, deliberate task.
- npm 11 warned that install scripts for `esbuild`, `edgedriver`, `geckodriver` are "not yet covered by allowScripts". Build/typecheck/test and cargo check were verified working; browser-driver scripts only matter for live E2E runs in a later task.
- `desktop/src-tauri/.gitignore` — **resolved (Task 18 staging pass).** It now contains `target/`, `target-e2e/` and `/gen/schemas`. The reference template also ignores `/gen/schemas` (generated capability schemas): `cargo check` generated `src-tauri/gen/schemas/` during Task 5 verification, and the entry keeps those generated files local — any tauri build regenerates them. `target-e2e/` is the native E2E build's separate cargo target dir (see `NATIVE-E2E.md`); it was added in the same pass so the E2E build output can never enter the repository.
- `[profile.release]` size tuning (lto/strip) is intentionally not included — out of Task 5 scope.
- No `tauri build` and no application launch were performed; that is Task 6.

## Task 10 additions — UI test dependencies (jsdom + Testing Library)

**Record date:** 2026-10-08. **Installed with:** `npm install --save-dev --save-exact` (exact pins, no `^`/`~`; the scaffold invariant test in `desktop/tests/scaffold.test.ts` enforces exact pins for every dependency and devDependency). The lockfile was updated in place; no other pins changed.

| Package | Version (exact) | Role | Why this one | Source |
|---|---|---|---|---|
| jsdom | 30.1.2 | devDependency | DOM implementation for the component interaction tests (import flows, keyboard activation, disabled states, bounded rendering, escaping). | https://www.npmjs.com/package/jsdom/v/30.1.2 |
| @testing-library/react | 16.3.3 | devDependency | React 19 rendering + event helpers (`render`, `screen`, `act`); peer-requires `@testing-library/dom ^10.0.0` (verified via `npm view`). | https://www.npmjs.com/package/@testing-library/react/v/16.3.3 |
| @testing-library/dom | 10.4.2 | devDependency | The peer dependency above (role/name queries, `within`); pinned explicitly so the tree cannot drift. | https://www.npmjs.com/package/@testing-library/dom/v/10.4.2 |
| @testing-library/user-event | 14.6.7 | devDependency | Realistic keyboard/pointer simulation — required by the explicit "keyboard interaction" coverage (Tab order, Enter/Space activation) that `fireEvent` alone cannot model. | https://www.npmjs.com/package/@testing-library/user-event/v/14.6.7 |

**Necessity decision (vetted, not default):** the pure logic suites (search/filter/stats/pagination/selection/scan-messages/adapter) run in the default node environment with zero DOM dependencies. jsdom + Testing Library were added ONLY because the approved scope lists component-level interaction coverage (keyboard, import flows, disabled states, escaped script-like strings, busy duplicate-start, error-code rendering) that cannot be honestly verified without a DOM. Nothing else was added — no jest-dom (plain property assertions are used), no user-event extra drivers, and jsdom's optional `canvas` peer is intentionally absent (not needed by these tests).

**Compatibility (verified):** RTL 16.3.3 peers `react ^18 || ^19` ✓ (19.3.0), engines `node >=18` ✓; jsdom 30.1.2 engines `^22.22.2 || ^24.15.0 || >=26.0.0` ✓ (Node 26.7.0); user-event 14.6.7 peers `@testing-library/dom >=7.21.4` ✓ (10.4.2).

**Configuration:** `desktop/vite.config.ts` now imports `defineConfig` from `vitest/config` (so the `test` block is typed) and excludes `tests/bundle.test.cjs` — a standalone `node:test` suite (Task 11) that vitest cannot collect; the vitest default excludes are re-listed because an explicit `exclude` replaces them. Environment selection is per file: component suites start with `// @vitest-environment jsdom`; everything else keeps the fast node default.

## Task 12 additions — native WebDriver E2E

**Record date:** 2026-10-08. **Installed with:** `npm install --save-dev --save-exact tsx@4.23.15` (exact pin; the scaffold invariant test in `desktop/tests/scaffold.test.ts` enforces exact pins for every dependency and devDependency). The lockfile was updated in place; no other pins changed.

| Package | Version (exact) | Role | Why this one | Source |
|---|---|---|---|---|
| tsx | 4.23.15 | devDependency | TypeScript executor for the WDIO config/specs (`desktop/e2e/wdio.conf.ts`, `desktop/e2e/driverlens.spec.ts`). | https://www.npmjs.com/package/tsx/v/4.23.15 |

**Necessity decision (vetted, not default):** WDIO 9.32.0 loads `.ts` config files and specs by resolving and importing `tsx` from its own module graph (`@wdio/cli` build: `resolve("tsx", import.meta.url); await import(tsxPath)`); without it, `wdio run e2e/wdio.conf.ts` fails at startup. tsx 4.23.15 is the current stable line and was verified against Node 26.7.0 (`npx tsx --version` → `tsx v4.23.15`, smoke eval OK). Nothing else was added — the whole `@wdio/*` set (9.32.0) and `@wdio/tauri-service` 1.5.0 were already pinned in Task 5.

**Rust side:** the E2E binary adds `tauri-plugin-wdio-webdriver = "=1.5.0"` as an **optional** dependency behind the `wdio-e2e` cargo feature (crates.io, MIT; exact pin; the `wdio-e2e` feature is the only thing that activates it). Default `cargo build` / `cargo test` / release builds do not compile it — see `desktop/docs/NATIVE-E2E.md` for the build command (`CARGO_TARGET_DIR=src-tauri/target-e2e`, so the verified release artifact is never overwritten).

**E2E build command (documented, not scripted):**

```bash
cd desktop
CARGO_TARGET_DIR="$PWD/src-tauri/target-e2e" \
  npm run tauri -- build --target aarch64-pc-windows-msvc --no-bundle --features wdio-e2e
```

**Run:** `npm --prefix desktop run test:native` (script `test:native` → `wdio run e2e/wdio.conf.ts`).
