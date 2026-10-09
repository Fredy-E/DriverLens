/**
 * Static privacy scan (Task 13): the renderer must reach the native side only
 * through the Tauri IPC wrapper (`src/adapters/native.ts` → `invoke` from
 * `@tauri-apps/api/core`). Executable code in `desktop/src/**` must contain
 * no fetch/XMLHttpRequest/WebSocket/EventSource/sendBeacon, no external URL
 * literals, and no external subresources in index.html.
 *
 * Comments are stripped first (a mention in a comment is not a runtime
 * dependency) — the same heuristic as tests/bundle.test.cjs, applied here so
 * the scan runs inside the vitest suite.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const INDEX_HTML = fileURLToPath(new URL("../index.html", import.meta.url));

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(abs));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) out.push(abs);
  }
  return out.sort();
}

/** Strip block and line comments (URL-safe: `//` after a `:` survives). */
function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  out = out
    .split(/\r?\n/)
    .map((line) => {
      let i = 0;
      for (;;) {
        const idx = line.indexOf("//", i);
        if (idx === -1) return line;
        if (idx > 0 && line[idx - 1] === ":") {
          i = idx + 2;
          continue;
        }
        return line.slice(0, idx);
      }
    })
    .join("\n");
  return out;
}

function rel(file: string): string {
  return relative(SRC_DIR, file).split("\\").join("/");
}

const NETWORK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "fetch()", pattern: /\bfetch\s*\(/ },
  { label: "XMLHttpRequest", pattern: /XMLHttpRequest/ },
  { label: "WebSocket", pattern: /\bWebSocket\b/ },
  { label: "EventSource", pattern: /\bEventSource\b/ },
  { label: "navigator.sendBeacon", pattern: /sendBeacon/ },
  { label: "navigator.serviceWorker", pattern: /serviceWorker/ },
  { label: "importScripts", pattern: /\bimportScripts\b/ },
  { label: "external URL literal", pattern: /https?:\/\// },
];

describe("desktop/src — no non-IPC network primitives in executable code", () => {
  it("contains no fetch/XHR/WebSocket/EventSource/sendBeacon and no external URL literals", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const { label, pattern } of NETWORK_PATTERNS) {
        if (pattern.test(code)) offenders.push(`${rel(file)}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports @tauri-apps only from the single IPC adapter, and only the core invoke API", () => {
    const importers = new Set<string>();
    const specifiers = new Set<string>();
    for (const file of listSourceFiles(SRC_DIR)) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const match of code.matchAll(/from\s+["'](@tauri-apps\/[^"']+)["']/g)) {
        importers.add(rel(file));
        specifiers.add(match[1]);
      }
    }
    expect([...importers]).toEqual(["adapters/native.ts"]);
    expect([...specifiers]).toEqual(["@tauri-apps/api/core"]);
  });

  it("loads no external subresources in index.html", () => {
    const html = readFileSync(INDEX_HTML, "utf8");
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(html).toContain('src="/src/main.tsx"');
  });
});
