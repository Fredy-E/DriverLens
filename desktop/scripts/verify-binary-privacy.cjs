#!/usr/bin/env node
"use strict";

/**
 * DriverLens desktop — production executable privacy scanner.
 *
 * Usage (from desktop/):
 *   node scripts/verify-binary-privacy.cjs [path-to-executable]
 *
 * Default target is the Tier 1 production executable:
 *   src-tauri/target/aarch64-pc-windows-msvc/release/driverlens-desktop.exe
 *
 * Fails closed (exit 1) when the executable bytes contain, in UTF-8 OR
 * UTF-16LE form, any actual machine-local path (OS home, CARGO_HOME, the
 * workspace roots, the OS temp directory — each in backslash and
 * forward-slash form), or any known E2E-only marker in a production scan.
 * Missing/unreadable input also fails. A compressed installer archive is NOT
 * a valid scan target — compression hides embedded strings — so CI must point
 * this scanner at the extracted executable, never at the installer/zip.
 *
 * Deliberately narrow: harmless generic source labels (`src-tauri`,
 * `main.rs`, `rustc`, collector file names, ...) never match because only
 * full machine-local path needles and the explicit E2E marker list below are
 * checked. Reports carry counts and static labels only — never path contents.
 *
 * Uses only Node built-ins (no new dependencies).
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// E2E-only markers: present only in `--features wdio-e2e` binaries
// (embedded WebDriver server, scripted synthetic collectors, env hooks).
// A production executable must contain none of them.
// `DRIVERLENS_E2E_` is a prefix rule covering every DRIVERLENS_E2E_* hook
// (SCENARIO, SCENARIO_FILE, OPEN_PATH, SAVE_PATH, HTML_PATH, TIMEOUT_MS,
// NOTEBOOK_DIR, BINARY, plus future hooks); `TAURI_WEBDRIVER_PORT` covers
// the embedded WebDriver server port.
const E2E_MARKERS = [
  "driverlens-wdio-e2e",
  "wdio-e2e",
  "DRIVERLENS_E2E_NOTEBOOK_DIR",
  "DRIVERLENS_E2E_BINARY",
  "DRIVERLENS_E2E_",
  "TAURI_WEBDRIVER_PORT",
  "tauri-plugin-wdio-webdriver",
  "e2eScriptedFake",
];

// Static failure labels: safe to log, carry no path contents.
const FAIL_UTF8 = "local-path-bytes-present (utf8)";
const FAIL_UTF16 = "local-path-bytes-present (utf16le)";
const FAIL_E2E = "e2e-marker-present";
const FAIL_UNREADABLE = "unreadable-input";

const MIN_NEEDLE_LEN = 4;

function toForwardSlash(p) {
  return String(p).replace(/\\/g, "/");
}

function dedupeNonEmpty(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== "string" || item.length < MIN_NEEDLE_LEN || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Generic machine-local needles for this machine: home, cargo home, the
 * desktop workspace plus the repo root above it, and the OS temp directory —
 * each with its Windows forward-slash variant. Computed, never hard-coded.
 */
function getDefaultNeedles(env) {
  const e = env || process.env;
  const home = os.homedir();
  const cargoHome = (e && e.CARGO_HOME) || path.join(home, ".cargo");
  const desktopRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(desktopRoot, "..");
  const tmp = os.tmpdir();
  const raw = [desktopRoot, repoRoot, cargoHome, home, tmp];
  const out = [];
  for (const prefix of dedupeNonEmpty(raw)) {
    out.push(prefix);
    const slash = toForwardSlash(prefix);
    if (slash !== prefix && slash.length >= MIN_NEEDLE_LEN) out.push(slash);
  }
  return dedupeNonEmpty(out);
}

/**
 * Scan raw bytes for needle/marker strings in UTF-8 and UTF-16LE encodings.
 * Returns counts and static labels only.
 */
function scanBuffer(buf, needles, markers) {
  const haystack = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const clean = dedupeNonEmpty(needles || []);
  let utf8Hits = 0;
  let utf16Hits = 0;
  for (const needle of clean) {
    if (haystack.includes(Buffer.from(needle, "utf8"))) utf8Hits += 1;
    if (haystack.includes(Buffer.from(needle, "utf16le"))) utf16Hits += 1;
  }
  const e2eHits = [];
  for (const marker of markers || E2E_MARKERS) {
    if (haystack.includes(Buffer.from(marker, "utf8")) || haystack.includes(Buffer.from(marker, "utf16le"))) {
      e2eHits.push(marker);
    }
  }
  const failures = [];
  if (utf8Hits > 0) failures.push(FAIL_UTF8);
  if (utf16Hits > 0) failures.push(FAIL_UTF16);
  if (e2eHits.length > 0) failures.push(FAIL_E2E);
  return { ok: failures.length === 0, utf8Hits, utf16Hits, e2eHits, failures };
}

/** Default Tier 1 production executable path for a desktop checkout. */
function defaultExePath(desktopRoot) {
  const root = desktopRoot || path.resolve(__dirname, "..");
  return path.join(root, "src-tauri", "target", "aarch64-pc-windows-msvc", "release", "driverlens-desktop.exe");
}

/** Fail-closed file scan: unreadable input reports failure, never success. */
function verifyBinaryPrivacy(exePath) {
  let bytes = null;
  try {
    bytes = fs.readFileSync(exePath);
  } catch (err) {
    return { ok: false, byteLength: 0, utf8Hits: 0, utf16Hits: 0, e2eHits: [], failures: [FAIL_UNREADABLE] };
  }
  const res = scanBuffer(bytes, getDefaultNeedles(process.env), E2E_MARKERS);
  return { ok: res.ok, byteLength: bytes.length, utf8Hits: res.utf8Hits, utf16Hits: res.utf16Hits, e2eHits: res.e2eHits, failures: res.failures };
}

function main() {
  const exePath = process.argv[2] || defaultExePath();
  const res = verifyBinaryPrivacy(exePath);
  // Counts and static labels only: the basename locates the artifact without
  // leaking the machine-local checkout path.
  console.log(
    JSON.stringify(
      {
        ok: res.ok,
        artifact: path.basename(exePath),
        byteLength: res.byteLength,
        utf8Hits: res.utf8Hits,
        utf16Hits: res.utf16Hits,
        e2eHits: res.e2eHits,
        failures: res.failures,
      },
      null,
      2,
    ),
  );
  if (!res.ok) {
    console.error(`verify-binary-privacy: FAIL (${res.failures.join("; ")})`);
    process.exitCode = 1;
  } else {
    console.log("verify-binary-privacy: OK (no local paths, no E2E markers).");
  }
}

module.exports = {
  E2E_MARKERS,
  toForwardSlash,
  getDefaultNeedles,
  scanBuffer,
  verifyBinaryPrivacy,
  defaultExePath,
};

if (require.main === module) main();
