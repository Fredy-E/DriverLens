/**
 * Print readability regression (desktop print defect).
 *
 * The parent-authored `parent-qa/desktop-print-gates.cjs` sandbox proved the
 * defect on the real stylesheet: in print emulation the dark stats label
 * fails printed AA (1.6668), the light-on-dark stats value (1.2444) and badge
 * (1.7654) fail paper-white AA (backgrounds-off paper), and interactive
 * input/select controls stay visible in both schemes.
 *
 * This suite is a STATIC parse of src/styles.css plus WCAG 2.x math — it does
 * not render pixels. It locks the paper-safe contract the gate checks at
 * runtime:
 * - `@media print` must hide `.filters` and every interactive
 *   input/select/textarea/button while keeping evidence selectors visible;
 * - stats value/label, badge/chip and evidence/detail/notebook/table pairs
 *   must be dark-on-light with AA >= 4.5 both as printed AND as paper-white
 *   (backgrounds-off), so readability never depends on print-backgrounds.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function channels(hex: string): [number, number, number] {
  const v = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex.toLowerCase()).map((n) =>
    n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const hi = Math.max(luminance(fg), luminance(bg));
  const lo = Math.min(luminance(fg), luminance(bg));
  return (hi + 0.05) / (lo + 0.05);
}

/** Brace-matched inner text of a CSS at-rule header. */
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

function printCss(): string {
  return cssBlock("@media print");
}

/** True when the print block hides `selector` with display:none. */
function hidesInPrint(selector: string): boolean {
  const print = printCss();
  // Split into rule chunks: "selectors { declarations }".
  const rules = print.split("}");
  return rules.some((chunk) => {
    const parts = chunk.split("{");
    if (parts.length < 2) return false;
    const selectors = parts[0];
    const decls = parts[1];
    if (!/display\s*:\s*none/i.test(decls)) return false;
    // Match the exact selector as a selector-list member (allows grouping).
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s,])${escaped}(\\s*[,\\s{])`).test(`${selectors} `);
  });
}

/** Extract the last `property: #hex` for `selector` inside @media print. */
function printDecl(selector: string, property: "color" | "background"): string | null {
  const print = printCss();
  const rules = print.split("}");
  let found: string | null = null;
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selRe = new RegExp(`(^|[\\s,])${escaped}(\\s*[,\\s])`);
  // NOTE: `color` must not match the `color` inside `border-color`.
  const propRe =
    property === "color"
      ? /(?:^|[;\s{])color\s*:\s*(#[0-9a-fA-F]{6})/g
      : /(?:^|[;\s{])background\s*:\s*(#[0-9a-fA-F]{6})/g;
  for (const chunk of rules) {
    const parts = chunk.split("{");
    if (parts.length < 2) continue;
    if (!selRe.test(`${parts[0]} `)) continue;
    const decls = `;${parts[1]}`;
    let m: RegExpExecArray | null;
    propRe.lastIndex = 0;
    while ((m = propRe.exec(decls)) !== null) {
      found = m[1].toLowerCase();
    }
  }
  return found;
}

describe("print stylesheet — filter toolbar and interactive controls are hidden", () => {
  it("hides the .filters toolbar in print", () => {
    expect(hidesInPrint(".filters"), "@media print must contain `.filters { display: none }`").toBe(true);
  });

  it("hides every interactive control type (input/select/textarea/button) in print", () => {
    for (const sel of ["input", "select", "textarea", "button"]) {
      expect(hidesInPrint(sel), `@media print must hide \`${sel}\` with display:none`).toBe(true);
    }
  });

  it("keeps evidence selectors out of the print display:none rules", () => {
    for (const sel of [".app__table", ".workbench__evidence", ".stats", ".evidence", ".badge"]) {
      expect(hidesInPrint(sel), `print must NOT hide evidence \`${sel}\``).toBe(false);
    }
  });
});

describe("print stylesheet — stats/badge readable on paper (backgrounds-off safe)", () => {
  it("paints the stats card light with dark value/label (AA printed and on white)", () => {
    const itemBg = printDecl(".stats__item", "background");
    const valueFg = printDecl(".stats__value", "color");
    const labelFg = printDecl(".stats__label", "color");
    expect(itemBg, ".stats__item needs an explicit light print background").not.toBeNull();
    expect(valueFg, ".stats__value needs an explicit dark print color").not.toBeNull();
    expect(labelFg, ".stats__label needs an explicit dark print color").not.toBeNull();
    // Printed pair (foreground on the printed card fill).
    expect(contrast(valueFg!, itemBg!), `stats value ${valueFg} on ${itemBg} must hold AA`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(labelFg!, itemBg!), `stats label ${labelFg} on ${itemBg} must hold AA`).toBeGreaterThanOrEqual(4.5);
    // Paper pair (backgrounds-off: decorative fills are not printed, white paper shows).
    expect(contrast(valueFg!, "#ffffff"), `stats value ${valueFg} on white paper must hold AA`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(labelFg!, "#ffffff"), `stats label ${labelFg} on white paper must hold AA`).toBeGreaterThanOrEqual(4.5);
    // Paper fills must actually be paper-safe (near-white, never a dark tile).
    expect(luminance(itemBg!)).toBeGreaterThan(0.5);
  });

  it("paints badge/chip light with dark text (AA printed and on white)", () => {
    const badgeFg = printDecl(".badge", "color");
    const badgeBg = printDecl(".badge", "background");
    expect(badgeFg, ".badge needs an explicit dark print color").not.toBeNull();
    expect(badgeBg, ".badge needs an explicit light print background").not.toBeNull();
    expect(contrast(badgeFg!, badgeBg!), `badge ${badgeFg} on ${badgeBg} must hold AA`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(badgeFg!, "#ffffff"), `badge ${badgeFg} on white paper must hold AA`).toBeGreaterThanOrEqual(4.5);
    expect(luminance(badgeBg!)).toBeGreaterThan(0.5);
  });
});

describe("print stylesheet — evidence/detail/notebook/table readable on paper", () => {
  it("paints evidence, detail rows, notebook detail and table cells dark-on-light (AA)", () => {
    const print = printCss();
    // Every legacy dark fill that carries reading text needs an explicit print override.
    for (const sel of [".device-detail td", ".notebook__detail", ".app__table td"]) {
      const bg = printDecl(sel, "background");
      expect(bg, `${sel} needs an explicit light print background`).not.toBeNull();
      expect(luminance(bg!)).toBeGreaterThan(0.5);
    }
    for (const sel of [".evidence dd", ".notebook__device-name", ".app__table td"]) {
      const fg = printDecl(sel, "color");
      expect(fg, `${sel} needs an explicit dark print color`).not.toBeNull();
      expect(contrast(fg!, "#ffffff"), `${sel} ${fg} on white paper must hold AA`).toBeGreaterThanOrEqual(4.5);
    }
    // Warn badge keeps a light warn pair (never pale-on-dark in print).
    const warnFg = printDecl(".badge--warn", "color");
    const warnBg = printDecl(".badge--warn", "background");
    expect(warnFg, ".badge--warn needs an explicit dark print color").not.toBeNull();
    expect(warnBg, ".badge--warn needs an explicit light print background").not.toBeNull();
    expect(contrast(warnFg!, warnBg!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(warnFg!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(print, "print must keep the table header light pair").toMatch(/\.app__table\s+th\s*\{[^}]*background:\s*#[0-9a-fA-F]{6}/);
  });
});
