/**
 * Stylesheet accessibility contract (Task 13): WCAG contrast math for the
 * token pairs the UI actually uses, the prefers-reduced-motion switch, and
 * the :focus-visible indicator rules.
 *
 * HONEST SCOPE: this is a static parse of src/styles.css plus the WCAG 2.x
 * relative-luminance formula, scripted here. It does NOT render pixels —
 * actual on-screen rendering, the real focus ring, and OS-level reduced
 * motion are deferred to the native/manual matrix (see
 * notes/ACCESSIBILITY-PRIVACY-NOTES.md). Disabled controls (opacity 0.55)
 * are exempt from WCAG 1.4.3/1.4.11 contrast requirements and are excluded
 * from the pair table; they are called out in the notes instead.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** Resolve a `:root` custom property; fails loudly when the token is gone. */
function token(name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(CSS);
  expect(match, `token ${name} must be declared in :root`).not.toBeNull();
  return match![1].toLowerCase();
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

/** WCAG 2.x relative luminance. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio (1..21). */
function contrast(fg: string, bg: string): number {
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function resolve(value: string): string {
  return value.startsWith("--") ? token(value) : value;
}

/** Extract the inner text of a CSS block (brace-matched, not regex-guessed). */
function cssBlock(header: string): string {
  const start = CSS.indexOf(header);
  expect(start, `${header} must exist in styles.css`).toBeGreaterThanOrEqual(0);
  const open = CSS.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < CSS.length; i += 1) {
    if (CSS[i] === "{") depth += 1;
    else if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${header}`);
}

interface Pair {
  label: string;
  fg: string;
  bg: string;
  min: number;
}

/**
 * Every text/background pair the UI actually paints, with AA as the floor
 * (4.5:1 normal text). Pairs marked with a literal color are checked to still
 * exist in the sheet, so silent color drift cannot dodge the table.
 */
const PAIRS: Pair[] = [
  { label: "body text on page background", fg: "--dl-text", bg: "--dl-bg", min: 4.5 },
  { label: "panel text on panel", fg: "--dl-text", bg: "--dl-panel", min: 4.5 },
  { label: "muted text on panel", fg: "--dl-muted", bg: "--dl-panel", min: 4.5 },
  { label: "muted text on page background", fg: "--dl-muted", bg: "--dl-bg", min: 4.5 },
  { label: "muted text on stats card", fg: "--dl-muted", bg: "#0f1c31", min: 4.5 },
  { label: "muted text on table header", fg: "--dl-muted", bg: "--dl-th-bg", min: 4.5 },
  { label: "muted text on expanded evidence row", fg: "--dl-muted", bg: "#0d1829", min: 4.5 },
  { label: "accent (evidence toggle) on panel", fg: "--dl-accent", bg: "--dl-panel", min: 4.5 },
  { label: "badge text on badge fill", fg: "--dl-badge-text", bg: "--dl-badge-bg", min: 4.5 },
  {
    label: "unknown-status badge text (muted) on badge fill",
    fg: "--dl-muted",
    bg: "--dl-badge-bg",
    min: 4.5,
  },
  { label: "warning badge text on warning fill", fg: "--dl-warn-text", bg: "--dl-warn-bg", min: 4.5 },
  { label: "error status text on panel", fg: "--dl-error-text", bg: "--dl-panel", min: 4.5 },
  { label: "error status text on page background", fg: "--dl-error-text", bg: "--dl-bg", min: 4.5 },
  { label: "primary button label on primary fill", fg: "#ffffff", bg: "#2364d7", min: 4.5 },
  { label: "primary button label on primary hover fill", fg: "#ffffff", bg: "#2f70e0", min: 4.5 },
  { label: "secondary button label on button fill", fg: "--dl-text", bg: "--dl-button-bg", min: 4.5 },
  { label: "secondary button label on hover fill", fg: "--dl-text", bg: "#213854", min: 4.5 },
  { label: "input placeholder on input fill", fg: "#8094b4", bg: "--dl-input-bg", min: 4.5 },
  { label: "stats value on stats card", fg: "#d7e8ff", bg: "#0f1c31", min: 4.5 },
];

describe("styles.css — WCAG contrast for the token pairs in use", () => {
  it("computes the ratios from the real tokens and holds AA for every text pair", () => {
    const failures: string[] = [];
    const rows: string[] = [];
    for (const pair of PAIRS) {
      const fg = resolve(pair.fg);
      const bg = resolve(pair.bg);
      // Literal colors must still exist in the sheet (no silent drift).
      if (!pair.fg.startsWith("--")) expect(CSS.toLowerCase()).toContain(fg);
      if (!pair.bg.startsWith("--")) expect(CSS.toLowerCase()).toContain(bg);
      const ratio = contrast(fg, bg);
      rows.push(`${ratio.toFixed(2)}:1  ${pair.label} (${fg} on ${bg}, AA min ${pair.min})`);
      if (ratio < pair.min) {
        failures.push(`${pair.label}: ${ratio.toFixed(2)}:1 (needs ${pair.min}:1)`);
      }
    }
    // The full computed table lands in the evidence log for review.
    console.log("WCAG contrast table (computed from styles.css tokens):\n" + rows.join("\n"));
    expect(failures, `pairs below AA:\n${failures.join("\n")}`).toEqual([]);
  });
});

/**
 * Light-scheme rendered semantic pairs (review fix §1).
 *
 * Proves every legacy --dl-* functional component honors the light scheme as
 * RENDERED pairs — body/gutters, buttons/hover, inputs, table headers,
 * muted/error/badge/warn text, stats/details — not token presence alone.
 * Dark :root values above stay exact; these expectations read the light media
 * block's redefined tokens + hardcoded light fills and hold the same AA floor.
 */
function lightToken(name: string): string {
  const light = cssBlock("@media (prefers-color-scheme: light)");
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(light);
  expect(match, `light token ${name} must be redefined in the light scheme block`).not.toBeNull();
  return match![1].toLowerCase();
}

const LIGHT_PAIRS: Pair[] = [
  { label: "light body text on page background", fg: "#1d2b44", bg: "#f2f5fa", min: 4.5 },
  { label: "light panel text on panel", fg: "#1d2b44", bg: "#ffffff", min: 4.5 },
  { label: "light muted text on panel", fg: "#4d617e", bg: "#ffffff", min: 4.5 },
  { label: "light muted text on page background", fg: "#4d617e", bg: "#f2f5fa", min: 4.5 },
  { label: "light muted text on stats card", fg: "#4d617e", bg: "#ffffff", min: 4.5 },
  { label: "light muted text on table header", fg: "#4d617e", bg: "#e3eaf5", min: 4.5 },
  { label: "light muted text on expanded evidence row", fg: "#4d617e", bg: "#eef2f9", min: 4.5 },
  { label: "light accent (evidence toggle) on panel", fg: "#204fb0", bg: "#ffffff", min: 4.5 },
  { label: "light badge text on badge fill", fg: "#204fb0", bg: "#e6eefb", min: 4.5 },
  { label: "light unknown-status badge text (muted) on badge fill", fg: "#4d617e", bg: "#e6eefb", min: 4.5 },
  { label: "light warning badge text on warning fill", fg: "#5c4a0a", bg: "#fdf0d0", min: 4.5 },
  { label: "light error status text on panel", fg: "#a4262c", bg: "#ffffff", min: 4.5 },
  { label: "light error status text on page background", fg: "#a4262c", bg: "#f2f5fa", min: 4.5 },
  { label: "light primary button label on primary fill", fg: "#ffffff", bg: "#2364d7", min: 4.5 },
  { label: "light primary button label on primary hover fill", fg: "#ffffff", bg: "#2f70e0", min: 4.5 },
  { label: "light secondary button label on button fill", fg: "#1d2b44", bg: "#ffffff", min: 4.5 },
  { label: "light secondary button label on hover fill", fg: "#1d2b44", bg: "#dbe5f3", min: 4.5 },
  { label: "light input placeholder on input fill", fg: "#4d617e", bg: "#ffffff", min: 4.5 },
  { label: "light stats value on stats card", fg: "#1d2b44", bg: "#ffffff", min: 4.5 },
  { label: "light table header text on header fill", fg: "#1d2b44", bg: "#e3eaf5", min: 4.5 },
];

describe("styles.css — light-scheme rendered semantic pairs (AA, no dark islands)", () => {
  it("redefines every legacy functional token for light (body/gutters/buttons/inputs/headers/text)", () => {
    const expected: Record<string, string> = {
      "--dl-bg": "#f2f5fa",
      "--dl-panel": "#ffffff",
      "--dl-border": "#ccd8e9",
      "--dl-text": "#1d2b44",
      "--dl-muted": "#4d617e",
      "--dl-accent": "#204fb0",
      "--dl-th-bg": "#e3eaf5",
      "--dl-button-bg": "#ffffff",
      "--dl-badge-bg": "#e6eefb",
      "--dl-badge-border": "#9db8dd",
      "--dl-badge-text": "#204fb0",
      "--dl-warn-bg": "#fdf0d0",
      "--dl-warn-border": "#a68a2e",
      "--dl-warn-text": "#5c4a0a",
      "--dl-error-text": "#a4262c",
      "--dl-input-bg": "#ffffff",
    };
    for (const [name, value] of Object.entries(expected)) {
      expect(lightToken(name), `light ${name}`).toBe(value);
    }
    // Body gutters must actually be light (luminance gate mirrors the parent sandbox).
    expect(relativeLuminance(lightToken("--dl-bg"))).toBeGreaterThan(0.5);
  });

  it("holds AA for every light rendered pair (semantic, not token presence)", () => {
    const light = cssBlock("@media (prefers-color-scheme: light)");
    // Literal light fills must still exist in the light block (no silent drift).
    for (const literal of [
      "#f2f5fa",
      "#ffffff",
      "#e3eaf5",
      "#eef2f9",
      "#e6eefb",
      "#fdf0d0",
      "#dbe5f3",
      "#1d2b44",
      "#4d617e",
      "#204fb0",
      "#5c4a0a",
      "#a4262c",
    ]) {
      expect(light.toLowerCase(), `light block must still paint ${literal}`).toContain(literal);
    }
    const failures: string[] = [];
    const rows: string[] = [];
    for (const pair of LIGHT_PAIRS) {
      const ratio = contrast(pair.fg, pair.bg);
      rows.push(`${ratio.toFixed(2)}:1  ${pair.label} (${pair.fg} on ${pair.bg}, AA min ${pair.min})`);
      if (ratio < pair.min) failures.push(`${pair.label}: ${ratio.toFixed(2)}:1 (needs ${pair.min}:1)`);
    }
    console.log("WCAG light contrast table (rendered semantic pairs):\n" + rows.join("\n"));
    expect(failures, `light pairs below AA:\n${failures.join("\n")}`).toEqual([]);
  });

  it("paints every hardcoded dark fill light (stats/detail/placeholder/hover/header text)", () => {
    const light = cssBlock("@media (prefers-color-scheme: light)");
    // Each legacy component that paints a hardcoded dark hex in the base sheet
    // must have an explicit light override — otherwise it stays a dark island.
    expect(light).toMatch(/\.stats__item\s*\{[^}]*background:\s*#ffffff/);
    expect(light).toMatch(/\.stats__value\s*\{[^}]*color:\s*#1d2b44/);
    expect(light).toMatch(/\.notebook__detail\s*\{[^}]*background:\s*#ffffff/);
    expect(light).toMatch(/\.device-detail\s+td\s*\{[^}]*background:\s*#eef2f9/);
    expect(light).toMatch(/\.input::placeholder\s*\{[^}]*color:\s*#4d617e/);
    expect(light).toMatch(/\.button:hover[^{]*\{[^}]*background:\s*#dbe5f3/);
    expect(light).toMatch(/\.app__table\s+th\s*\{[^}]*color:\s*var\(--dl-text\)/);
    expect(light).toMatch(/\.button\s*\{[^}]*border-color:\s*#9db1cc/);
  });
});

describe("styles.css — the navy/cyan DriverLens palette stays locked", () => {
  it("keeps the exact dark-navy tokens (drift into another tool's blue fails here)", () => {
    expect(token("--dl-bg")).toBe("#080e19");
    expect(token("--dl-panel")).toBe("#101a2b");
    expect(token("--dl-blue")).toBe("#266deb");
    expect(token("--dl-accent")).toBe("#72adff");
    expect(token("--dl-text")).toBe("#dce6f8");
    expect(token("--dl-muted")).toBe("#95a8c8");
  });

  it("keeps a very dark, blue-leaning background and a cool (cyan-leaning) accent", () => {
    expect(relativeLuminance(token("--dl-bg"))).toBeLessThan(0.02);
    const [r, g, b] = channels(token("--dl-accent"));
    expect(b).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(r);
    const [bgR, , bgB] = channels(token("--dl-bg"));
    expect(bgB).toBeGreaterThan(bgR); // navy, not neutral gray
  });
});

describe("styles.css — prefers-reduced-motion (static parse)", () => {
  it("switches off every animation the sheet declares", () => {
    const reduced = cssBlock("@media (prefers-reduced-motion: reduce)");
    const outsideReduced = CSS.replace(reduced, "");

    // The base sheet animates exactly one selector (the scan spinner)...
    const animated = [...outsideReduced.matchAll(/([^}{]+)\{[^}]*animation:\s*([^;}]+)[^}]*\}/g)]
      .map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), value: m[2].trim() }));
    expect(animated.map((a) => a.selector)).toEqual([".scan__spinner"]);
    expect(animated[0].value).toContain("dl-spin");
    expect(outsideReduced).toContain("@keyframes dl-spin");

    // ...and the reduced-motion block disables exactly that selector.
    const disabled = [...reduced.matchAll(/([^}{]+)\{[^}]*animation:\s*none[^}]*\}/g)].map((m) =>
      m[1].trim().replace(/\s+/g, " ")
    );
    expect(disabled).toEqual([".scan__spinner"]);
    expect(reduced).toContain("scroll-behavior: auto !important");
  });
});

describe("styles.css — keyboard focus indicator", () => {
  it("declares an outline for :focus-visible on every focusable control type", () => {
    const ruleStart = CSS.indexOf("button:focus-visible");
    expect(ruleStart).toBeGreaterThanOrEqual(0);
    const ruleEnd = CSS.indexOf("}", ruleStart);
    const rule = CSS.slice(ruleStart, ruleEnd);
    for (const selector of [
      "button:focus-visible",
      "input:focus-visible",
      "select:focus-visible",
      "a:focus-visible",
    ]) {
      expect(rule, "focus rule must cover every control type").toContain(selector);
    }
    expect(rule).toContain("outline: 2px solid var(--dl-accent)");
    expect(rule).toContain("outline-offset: 3px");
    // Nothing in the sheet removes the outline (a classic a11y regression).
    expect(CSS).not.toMatch(/outline:\s*(none|0)\b/);
  });
});
