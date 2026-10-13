#!/usr/bin/env node
"use strict";

/**
 * DriverLens desktop — development-only privacy build wrapper (build:private).
 *
 * Invokes the installed Tauri build CLI with compiler path-remapping so the
 * produced executable does not embed local registry/source path strings
 * (locally observed before remapping; see ../docs/UI-PREVIEW-VERIFICATION.md).
 *
 * Usage (from desktop/):
 *   npm run build:private -- --target aarch64-pc-windows-msvc --no-bundle
 *   npm run build:private -- --target aarch64-pc-windows-msvc --no-bundle --features wdio-e2e
 *
 * Source-only development script: it changes no runtime source, only the
 * compiler flags of the spawned build. The Tauri CLI entry is resolved from
 * the installed `@tauri-apps/cli` package (bin manifest: `tauri` ->
 * `./tauri.js`); the child is spawned with an arg array and `shell: false`.
 * All caller build args (`--target` / `--no-bundle` / `--features` / ...) are
 * passed through untouched, every other environment variable is inherited,
 * and the child exit code is propagated.
 *
 * Remapping (automatic, generic — no literal source paths in this file):
 *   - the actual OS home directory (`os.homedir()`),
 *   - `CARGO_HOME` (or `<home>/.cargo` when unset),
 *   - the current workspace (the desktop/ directory holding this script),
 *   - the OS temp directory (`os.tmpdir()`),
 *   each in backslash AND forward-slash form (Windows embeds either), longest
 *   prefix first, all mapped to a neutral `/build-machine` target.
 * Pre-existing `CARGO_ENCODED_RUSTFLAGS` entries (0x1F-separated) are
 * preserved verbatim and the remaps are appended with the same separator, so
 * entries containing spaces or Unicode survive as single compiler args.
 *
 * Legacy `RUSTFLAGS` (space-separated) cannot be merged safely — splitting it
 * on spaces would corrupt entries containing spaces — so when it is set to a
 * non-blank value this script REFUSES with an actionable static message
 * instead of silently dropping it. The message and all logs are static:
 * no env values, tokens, or path contents are ever printed.
 *
 * Uses only Node built-ins (no new dependencies).
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// 0x1F unit separator: the CARGO_ENCODED_RUSTFLAGS element separator.
const ENCODED_SEPARATOR = "\x1f";
// Neutral remap target: carries no machine/user information.
const REMAP_TARGET = "/build-machine";
// Static refusal text: names the variables, never their values.
const RUSTFLAGS_REFUSAL =
  "build:private refuses to run with RUSTFLAGS set: unset RUSTFLAGS or migrate its entries " +
  "to CARGO_ENCODED_RUSTFLAGS (0x1F-separated) so no compiler flag is silently dropped, then re-run.";

function toForwardSlash(p) {
  return String(p).replace(/\\/g, "/");
}

function dedupeNonEmpty(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== "string" || item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Generic sensitive prefixes for this machine: home, cargo home, workspace, temp. */
function getDefaultPrefixes(env) {
  const e = env || process.env;
  const home = os.homedir();
  const cargoHome = (e && e.CARGO_HOME) || path.join(home, ".cargo");
  const workspace = path.resolve(__dirname, "..");
  const tmp = os.tmpdir();
  // Longest first so nested prefixes (workspace under home) remap precisely.
  return dedupeNonEmpty([workspace, cargoHome, home, tmp]).sort((a, b) => b.length - a.length);
}

/** Each prefix in its native form plus the Windows forward-slash variant. */
function expandSlashVariants(prefixes) {
  const out = [];
  for (const prefix of dedupeNonEmpty(prefixes)) {
    out.push(prefix);
    const slash = toForwardSlash(prefix);
    if (slash !== prefix) out.push(slash);
  }
  return dedupeNonEmpty(out);
}

/**
 * One single-argv `--remap-path-prefix=FROM=TO` element per variant. The
 * `=`-joined single-element form (not the space-separated pair) is required:
 * with the 0x1F separator each entry becomes exactly one rustc argv element,
 * so prefixes containing spaces or Unicode stay intact.
 */
function buildRemapFlags(prefixes) {
  const flags = [];
  for (const prefix of expandSlashVariants(prefixes)) {
    flags.push(`--remap-path-prefix=${prefix}=${REMAP_TARGET}`);
  }
  return flags;
}

/**
 * Merge preserved caller flags with fresh remaps. Throws the static
 * RUSTFLAGS_REFUSAL when legacy RUSTFLAGS is set to a non-blank value.
 */
function computeEncodedRustflags(env) {
  const e = env || process.env;
  const legacy = e ? e.RUSTFLAGS : undefined;
  if (legacy !== undefined && legacy !== null && String(legacy).trim() !== "") {
    throw new Error(RUSTFLAGS_REFUSAL);
  }
  const preserved = String((e && e.CARGO_ENCODED_RUSTFLAGS) || "")
    .split(ENCODED_SEPARATOR)
    .filter((entry) => entry.length > 0);
  return [...preserved, ...buildRemapFlags(getDefaultPrefixes(e))].join(ENCODED_SEPARATOR);
}

/** Caller args pass through; a missing leading `build` is restored. */
function resolveTauriArgs(callerArgs) {
  const args = (callerArgs || []).slice();
  while (args.length > 0 && args[0] === "--") args.shift();
  if (args.length === 0 || String(args[0]).startsWith("-")) args.unshift("build");
  return args;
}

/** Installed CLI entry (`@tauri-apps/cli` bin manifest: tauri -> ./tauri.js). */
function resolveCliEntry(desktopRoot) {
  const root = desktopRoot || path.resolve(__dirname, "..");
  const entry = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      "build:private cannot find the installed Tauri CLI entry " +
        "(node_modules/@tauri-apps/cli/tauri.js); run `npm ci` inside desktop/ and re-run.",
    );
  }
  return entry;
}

/**
 * Run the remapped build. `spawnFn` defaults to `spawnSync` and is injectable
 * for tests. Returns the child exit code (nonzero when signalled).
 */
function runBuild(opts) {
  const o = opts || {};
  const desktopRoot = o.desktopRoot || path.resolve(__dirname, "..");
  const env = o.env || process.env;
  const tauriArgs = resolveTauriArgs(o.callerArgs);
  // Throws before any spawn when legacy RUSTFLAGS would be silently dropped.
  const encoded = computeEncodedRustflags(env);
  const cliEntry = resolveCliEntry(desktopRoot);
  const preservedCount = String(env.CARGO_ENCODED_RUSTFLAGS || "")
    .split(ENCODED_SEPARATOR)
    .filter((entry) => entry.length > 0).length;
  const remapCount = buildRemapFlags(getDefaultPrefixes(env)).length;
  const spawnFn = o.spawnFn || require("node:child_process").spawnSync;
  console.log(
    `build:private: launching tauri build with path-remapped compiler flags ` +
      `(${remapCount} remap entries, ${preservedCount} preserved entries).`,
  );
  const result = spawnFn(process.execPath, [cliEntry, ...tauriArgs], {
    stdio: "inherit",
    shell: false,
    cwd: desktopRoot,
    env: { ...env, CARGO_ENCODED_RUSTFLAGS: encoded },
  });
  const code = typeof result.status === "number" ? result.status : 1;
  console.log(`build:private: tauri build finished (exit ${code}).`);
  return code;
}

function main() {
  try {
    process.exitCode = runBuild({ callerArgs: process.argv.slice(2), env: process.env });
  } catch (err) {
    // Static messages only: never print env values or paths.
    console.error(err && err.message ? err.message : "build:private failed before launching the build.");
    process.exitCode = String((err && err.message) || "").includes("RUSTFLAGS") ? 2 : 1;
  }
}

module.exports = {
  ENCODED_SEPARATOR,
  REMAP_TARGET,
  RUSTFLAGS_REFUSAL,
  toForwardSlash,
  getDefaultPrefixes,
  expandSlashVariants,
  buildRemapFlags,
  computeEncodedRustflags,
  resolveTauriArgs,
  resolveCliEntry,
  runBuild,
};

if (require.main === module) main();
