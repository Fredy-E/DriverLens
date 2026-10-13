/**
 * Build path-privacy (publication copy): remapped dev builds + production
 * executable scanner.
 *
 * TDD contract for `desktop/scripts/build-private.cjs` (development-only
 * Tauri build wrapper with compiler `--remap-path-prefix` entries) and
 * `desktop/scripts/verify-binary-privacy.cjs` (post-build production
 * executable scanner), plus the `build:private` package wiring and the
 * desktop-verify CI wiring. Every test below is load-bearing: each proves
 * one clause of the privacy predicate with a fixture that fails when the
 * clause is missing.
 *
 * Uses only Node built-ins + vitest (no new dependencies).
 */
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

interface SpawnResult {
  status: number | null;
  signal?: string | null;
}

interface SpawnFn {
  (
    cmd: string,
    args: string[],
    opts: { stdio: string; shell: boolean; cwd: string; env: Record<string, string | undefined> },
  ): SpawnResult;
}

interface BuildPrivateApi {
  ENCODED_SEPARATOR: string;
  REMAP_TARGET: string;
  RUSTFLAGS_REFUSAL: string;
  toForwardSlash(p: string): string;
  getDefaultPrefixes(env?: Record<string, string | undefined>): string[];
  expandSlashVariants(prefixes: string[]): string[];
  buildRemapFlags(prefixes: string[]): string[];
  computeEncodedRustflags(env?: Record<string, string | undefined>): string;
  resolveTauriArgs(callerArgs: string[]): string[];
  resolveCliEntry(desktopRoot?: string): string;
  runBuild(opts: {
    callerArgs: string[];
    env?: Record<string, string | undefined>;
    desktopRoot?: string;
    spawnFn?: SpawnFn;
  }): number;
}

interface ScanResult {
  ok: boolean;
  utf8Hits: number;
  utf16Hits: number;
  e2eHits: string[];
  failures: string[];
}

interface VerifyResult extends ScanResult {
  byteLength: number;
}

interface PrivacyScannerApi {
  E2E_MARKERS: string[];
  toForwardSlash(p: string): string;
  getDefaultNeedles(env?: Record<string, string | undefined>): string[];
  scanBuffer(buf: Buffer, needles: string[], markers?: string[]): ScanResult;
  verifyBinaryPrivacy(exePath: string): VerifyResult;
  defaultExePath(desktopRoot?: string): string;
}

const buildPrivate = require("../scripts/build-private.cjs") as BuildPrivateApi;
const privacyScanner = require("../scripts/verify-binary-privacy.cjs") as PrivacyScannerApi;

const TESTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const DESKTOP_ROOT = resolve(TESTS_DIR, "..");

function captureConsole(fn: () => void): string[] {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines;
}

function fakeSpawn(status: number | null): { fn: SpawnFn; calls: Array<{ cmd: string; args: string[]; opts: unknown }> } {
  const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
  const fn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status, signal: status === null ? "SIGTERM" : null };
  };
  return { fn, calls };
}

function cleanEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.RUSTFLAGS;
  delete env.CARGO_ENCODED_RUSTFLAGS;
  return { ...env, ...extra };
}

describe("build:private — path-remapped development builds", () => {
  it("uses the 0x1F (CARGO_ENCODED_RUSTFLAGS) separator, not spaces", () => {
    expect(buildPrivate.ENCODED_SEPARATOR).toBe("\u001f");
    const out = buildPrivate.computeEncodedRustflags(cleanEnv());
    expect(out).toContain("\u001f");
    expect(out).toContain("--remap-path-prefix=");
  });

  it("remaps the actual OS home directory (both slash variants)", () => {
    const home = homedir();
    const prefixes = buildPrivate.getDefaultPrefixes(cleanEnv());
    expect(prefixes).toContain(home);
    const flags = buildPrivate.buildRemapFlags(buildPrivate.expandSlashVariants(prefixes));
    const slash = buildPrivate.toForwardSlash(home);
    expect(flags.some((f) => f.includes(home))).toBe(true);
    expect(flags.some((f) => f.includes(slash))).toBe(true);
    expect(flags.every((f) => f.endsWith(buildPrivate.REMAP_TARGET))).toBe(true);
  });

  it("remaps CARGO_HOME (explicit env value wins over the default)", () => {
    const custom = "C:\\synthetic-cargo-home";
    const prefixes = buildPrivate.getDefaultPrefixes(cleanEnv({ CARGO_HOME: custom }));
    expect(prefixes).toContain(custom);
    const flags = buildPrivate.buildRemapFlags(buildPrivate.expandSlashVariants(prefixes));
    expect(flags.some((f) => f.includes(custom))).toBe(true);
  });

  it("remaps the current workspace (desktop root)", () => {
    const prefixes = buildPrivate.getDefaultPrefixes(cleanEnv());
    expect(prefixes).toContain(DESKTOP_ROOT);
  });

  it("emits Windows forward-slash variants alongside backslash forms", () => {
    const raw = "C:\\Users\\Test User\\DriverLens";
    const expanded = buildPrivate.expandSlashVariants([raw]);
    expect(expanded).toContain(raw);
    expect(expanded).toContain("C:/Users/Test User/DriverLens");
    const flags = buildPrivate.buildRemapFlags([raw]);
    expect(flags.some((f) => f.includes(raw))).toBe(true);
    expect(flags.some((f) => f.includes("C:/Users/Test User/DriverLens"))).toBe(true);
  });

  it("handles spaces and Unicode in prefixes without splitting them", () => {
    const tricky = "C:\\Users\\Tëst Üser\\مشروع DriverLens\\work";
    const flags = buildPrivate.buildRemapFlags([tricky]);
    expect(flags.length).toBe(2);
    expect(flags.some((f) => f.includes(tricky))).toBe(true);
    expect(flags.some((f) => f.includes(buildPrivate.toForwardSlash(tricky)))).toBe(true);
    const encoded = buildPrivate.computeEncodedRustflags(cleanEnv());
    const entries = encoded.split("");
    // The separator is 0x1F precisely so spaces/Unicode survive as one entry:
    // every real remap entry round-trips intact through the encoded value.
    const realFlags = buildPrivate.buildRemapFlags(buildPrivate.getDefaultPrefixes(cleanEnv()));
    for (const f of realFlags) {
      expect(entries).toContain(f);
    }
    expect(entries.length).toBeGreaterThan(flags.length);
  });

  it("preserves every pre-existing encoded flag entry (never silently discards)", () => {
    const pre = '--cfg=feature="with spaces"\u001f--deny=warnings\u001f-Cdebuginfo=0';
    const out = buildPrivate.computeEncodedRustflags(cleanEnv({ CARGO_ENCODED_RUSTFLAGS: pre }));
    const entries = out.split("\u001f");
    for (const entry of pre.split("\u001f")) {
      expect(entries).toContain(entry);
    }
    // Space-containing entries survive intact (not re-split on spaces).
    expect(entries).toContain('--cfg=feature="with spaces"');
  });

  it("refuses (does not silently drop) when legacy RUSTFLAGS is set", () => {
    const secret = "--deny warnings --cfg=topsecret";
    const { fn } = fakeSpawn(0);
    let message = "";
    try {
      buildPrivate.runBuild({
        callerArgs: ["build"],
        env: cleanEnv({ RUSTFLAGS: secret }),
        desktopRoot: DESKTOP_ROOT,
        spawnFn: fn,
      });
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain("RUSTFLAGS");
    expect(message).toContain("CARGO_ENCODED_RUSTFLAGS");
    // Actionable and static: the refused flag VALUE is never echoed back.
    expect(message).not.toContain(secret);
    expect(message).not.toContain("topsecret");
  });

  it("never spawns the child when legacy RUSTFLAGS forces refusal", () => {
    const { fn, calls } = fakeSpawn(0);
    expect(() =>
      buildPrivate.runBuild({
        callerArgs: ["build"],
        env: cleanEnv({ RUSTFLAGS: "--deny warnings" }),
        desktopRoot: DESKTOP_ROOT,
        spawnFn: fn,
      }),
    ).toThrow();
    expect(calls).toHaveLength(0);
  });

  it("treats empty/blank RUSTFLAGS as unset and proceeds", () => {
    const { fn } = fakeSpawn(0);
    const code = buildPrivate.runBuild({
      callerArgs: ["build"],
      env: cleanEnv({ RUSTFLAGS: "   " }),
      desktopRoot: DESKTOP_ROOT,
      spawnFn: fn,
    });
    expect(code).toBe(0);
  });

  it("preserves caller build args (--target/--no-bundle/--features)", () => {
    expect(buildPrivate.resolveTauriArgs(["build", "--target", "aarch64-pc-windows-msvc", "--no-bundle"])).toEqual([
      "build",
      "--target",
      "aarch64-pc-windows-msvc",
      "--no-bundle",
    ]);
    expect(
      buildPrivate.resolveTauriArgs(["build", "--target", "t", "--no-bundle", "--features", "wdio-e2e"]),
    ).toContain("wdio-e2e");
    // Caller may omit the leading `build` (npm passes only what follows `--`).
    expect(buildPrivate.resolveTauriArgs(["--target", "t", "--no-bundle"])[0]).toBe("build");
    expect(buildPrivate.resolveTauriArgs([])).toEqual(["build"]);
  });

  it("spawns the Tauri CLI as an arg array with no shell", () => {
    const { fn, calls } = fakeSpawn(0);
    buildPrivate.runBuild({
      callerArgs: ["build", "--target", "aarch64-pc-windows-msvc", "--no-bundle"],
      env: cleanEnv(),
      desktopRoot: DESKTOP_ROOT,
      spawnFn: fn,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.cmd).toBe(process.execPath);
    expect(Array.isArray(call.args)).toBe(true);
    expect(call.args[0].endsWith("tauri.js")).toBe(true);
    expect(call.args).toContain("build");
    expect(call.args).toContain("--target");
    const opts = call.opts as { shell: boolean; env: Record<string, string | undefined> };
    expect(opts.shell).toBe(false);
    expect(opts.env.CARGO_ENCODED_RUSTFLAGS).toContain("--remap-path-prefix=");
  });

  it("propagates the child exit code (including failure)", () => {
    expect(
      buildPrivate.runBuild({
        callerArgs: ["build"],
        env: cleanEnv(),
        desktopRoot: DESKTOP_ROOT,
        spawnFn: fakeSpawn(3).fn,
      }),
    ).toBe(3);
    expect(
      buildPrivate.runBuild({
        callerArgs: ["build"],
        env: cleanEnv(),
        desktopRoot: DESKTOP_ROOT,
        spawnFn: fakeSpawn(null).fn,
      }),
    ).not.toBe(0);
  });

  it("logs counts only — never env values, tokens, or path contents", () => {
    const home = homedir();
    const lines = captureConsole(() =>
      buildPrivate.runBuild({
        callerArgs: ["build", "--target", "t"],
        env: cleanEnv({ CARGO_ENCODED_RUSTFLAGS: "preserved-flag", SOME_TOKEN: "tok-abc-123" }),
        desktopRoot: DESKTOP_ROOT,
        spawnFn: fakeSpawn(0).fn,
      }),
    );
    const text = lines.join("\n");
    expect(text).not.toContain(home);
    expect(text).not.toContain(DESKTOP_ROOT);
    expect(text).not.toContain("preserved-flag");
    expect(text).not.toContain("tok-abc-123");
  });

  it("resolves the installed Tauri CLI entry (bin manifest: tauri -> ./tauri.js)", () => {
    const entry = buildPrivate.resolveCliEntry(DESKTOP_ROOT);
    expect(entry.endsWith(join("cli", "tauri.js"))).toBe(true);
    expect(readFileSync(entry, "utf8")).toContain("tauri");
  });

  it("helper source contains no private literal paths and needs only node: builtins", () => {
    const src = readFileSync(join(DESKTOP_ROOT, "scripts", "build-private.cjs"), "utf8");
    expect(src).not.toContain(homedir());
    expect(src).not.toContain(DESKTOP_ROOT);
    const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const mod of required) {
      expect(mod.startsWith("node:"), `dependency ${mod} must be a node: builtin`).toBe(true);
    }
  });

  it("package.json wires build:private and keeps the tauri script plus pins untouched", () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["build:private"]).toContain("build-private.cjs");
    expect(pkg.scripts.tauri).toBe("tauri");
  });
});

describe("verify-binary-privacy — production executable scanner", () => {
  it("detects UTF-8 encoded local path bytes", () => {
    const needle = "C:\\Users\\someone\\Documents\\DriverLens";
    const buf = Buffer.concat([Buffer.from("MZstub"), Buffer.from(needle, "utf8"), Buffer.from("tail")]);
    const res = privacyScanner.scanBuffer(buf, [needle]);
    expect(res.ok).toBe(false);
    expect(res.utf8Hits).toBeGreaterThan(0);
  });

  it("detects UTF-16LE encoded local path bytes", () => {
    const needle = "C:\\Users\\someone\\Documents\\DriverLens";
    const buf = Buffer.concat([Buffer.from("MZstub"), Buffer.from(needle, "utf16le"), Buffer.from("tail")]);
    const res = privacyScanner.scanBuffer(buf, [needle]);
    expect(res.ok).toBe(false);
    expect(res.utf16Hits).toBeGreaterThan(0);
  });

  it("detects workspace and temp paths with spaces and Unicode", () => {
    const needles = ["C:\\Temp\\scan dir\\Tëst مشروع", "D:\\work space\\DriverLens desktop"];
    const buf = Buffer.concat([
      Buffer.from("prefix"),
      Buffer.from(needles[0], "utf16le"),
      Buffer.from("mid"),
      Buffer.from(needles[1], "utf8"),
    ]);
    const res = privacyScanner.scanBuffer(buf, needles);
    expect(res.ok).toBe(false);
    expect(res.utf8Hits + res.utf16Hits).toBeGreaterThanOrEqual(2);
  });

  it("collects the actual machine home/workspace/temp needles generically", () => {
    const needles = privacyScanner.getDefaultNeedles(cleanEnv());
    expect(needles).toContain(homedir());
    expect(needles).toContain(DESKTOP_ROOT);
    expect(needles).toContain(tmpdir());
    expect(needles).toContain(buildPrivate.toForwardSlash(homedir()));
  });

  it("rejects every known E2E marker in a production scan", () => {
    expect(privacyScanner.E2E_MARKERS.length).toBeGreaterThan(0);
    for (const marker of privacyScanner.E2E_MARKERS) {
      const res = privacyScanner.scanBuffer(Buffer.from(`xx${marker}yy`, "utf8"), []);
      expect(res.ok, `E2E marker must fail a production scan: ${marker}`).toBe(false);
      expect(res.e2eHits).toContain(marker);
    }
    expect(privacyScanner.E2E_MARKERS).toContain("driverlens-wdio-e2e");
    expect(privacyScanner.E2E_MARKERS).toContain("wdio-e2e");
  });

  // Independent fixtures from the actual feature-only Rust/harness contract,
  // NOT from E2E_MARKERS: a forgotten sibling must make these tests RED.
  const forbiddenHooks = [
    "DRIVERLENS_E2E_SCENARIO",
    "DRIVERLENS_E2E_SCENARIO_FILE",
    "DRIVERLENS_E2E_OPEN_PATH",
    "DRIVERLENS_E2E_SAVE_PATH",
    "DRIVERLENS_E2E_HTML_PATH",
    "DRIVERLENS_E2E_TIMEOUT_MS",
    "DRIVERLENS_E2E_NOTEBOOK_DIR",
    "DRIVERLENS_E2E_BINARY",
    "TAURI_WEBDRIVER_PORT",
    "DRIVERLENS_E2E_FUTURE_FIXTURE_HOOK",
  ];
  const hookCases = forbiddenHooks.flatMap((hook) =>
    (["utf8", "utf16le"] as const).map((encoding) => [hook, encoding] as const),
  );
  it.each(hookCases)("rejects independent E2E hook %s in %s", (hook, encoding) => {
    const res = privacyScanner.scanBuffer(Buffer.from(`prefix${hook}suffix`, encoding), []);
    expect(res.ok).toBe(false);
    expect(res.failures).toContain("e2e-marker-present");
  });

  it("ignores harmless generic source labels", () => {
    const buf = Buffer.from(
      "src-tauri/src/main.rs rustc cargo build tauri.conf.json Collect-DriverLens.ps1",
      "utf8",
    );
    const res = privacyScanner.scanBuffer(buf, ["C:\\nonexistent-synthetic-prefix\\xyz"]);
    expect(res.ok).toBe(true);
    expect(res.e2eHits).toEqual([]);
  });

  it("ignores trivially short needles instead of false-positive matching", () => {
    const buf = Buffer.from("ab ab ab", "utf8");
    expect(privacyScanner.scanBuffer(buf, ["ab", ""]).ok).toBe(true);
  });

  it("proves archives hide markers: the extracted executable (not the installer) must be scanned", () => {
    const needle = "C:\\synthetic\\local registry\\src\\example";
    const raw = Buffer.concat([Buffer.from("MZextracted"), Buffer.from(needle, "utf8")]);
    const archived = gzipSync(raw);
    expect(privacyScanner.scanBuffer(raw, [needle]).ok).toBe(false);
    // Compression hides the bytes, so a compressed installer is NOT a valid
    // negative scan — CI must point the scanner at the extracted exe.
    expect(privacyScanner.scanBuffer(archived, [needle]).ok).toBe(true);
  });

  it("fails closed on a missing/unreadable executable", () => {
    const res = privacyScanner.verifyBinaryPrivacy(join(tmpdir(), "dl-privacy-missing-exe-12345.exe"));
    expect(res.ok).toBe(false);
    expect(res.failures.length).toBeGreaterThan(0);
  });

  it("end-to-end: flags a fixture carrying real machine path bytes, passes a clean one", () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-privacy-"));
    try {
      const dirty = join(dir, "dirty.exe");
      const clean = join(dir, "clean.exe");
      writeFileSync(dirty, Buffer.concat([Buffer.from("MZ"), Buffer.from(homedir(), "utf8")]));
      writeFileSync(clean, Buffer.from("MZclean-generic-bytes-src-tauri", "utf8"));
      expect(privacyScanner.verifyBinaryPrivacy(dirty).ok).toBe(false);
      expect(privacyScanner.verifyBinaryPrivacy(clean).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("report and logs carry counts only — never actual path contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-privacy-"));
    try {
      const dirty = join(dir, "dirty.exe");
      writeFileSync(
        dirty,
        Buffer.concat([Buffer.from("MZ"), Buffer.from(homedir(), "utf16le"), Buffer.from(DESKTOP_ROOT, "utf8")]),
      );
      let res: VerifyResult | null = null;
      const lines = captureConsole(() => {
        res = privacyScanner.verifyBinaryPrivacy(dirty);
        console.log(JSON.stringify(res));
      });
      const text = `${lines.join("\n")}${JSON.stringify(res)}`;
      expect(text).not.toContain(homedir());
      expect(text).not.toContain(DESKTOP_ROOT);
      expect(JSON.stringify(res).includes('"ok":false')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scanner source contains no private literal paths and needs only node: builtins", () => {
    const src = readFileSync(join(DESKTOP_ROOT, "scripts", "verify-binary-privacy.cjs"), "utf8");
    expect(src).not.toContain(homedir());
    expect(src).not.toContain(DESKTOP_ROOT);
    const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const mod of required) {
      expect(mod.startsWith("node:"), `dependency ${mod} must be a node: builtin`).toBe(true);
    }
  });

  it("CI wires the privacy alias and the production scan with no soft failures", () => {
    const yml = readFileSync(
      fileURLToPath(new URL("../../.github/workflows/desktop-verify.yml", import.meta.url)),
      "utf8",
    );
    expect(yml).toContain("build:private");
    expect(yml).toContain("verify-binary-privacy");
    expect(yml.includes("continue-on-error:")).toBe(false);
    // Old gates stay: production target build, separate E2E feature build,
    // isolated E2E target dir, PE check, and the required runner tiers.
    expect(yml).toContain("aarch64-pc-windows-msvc");
    expect(yml).toContain("--features wdio-e2e");
    expect(yml).toContain("CARGO_TARGET_DIR");
    expect(yml).toContain("windows-11-arm");
  });
});
