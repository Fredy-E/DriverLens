import { describe, expect, it } from "vitest";

import pkg from "../package.json";

/**
 * Scaffold invariants for the DriverLens desktop edition (Task 5).
 *
 * These assertions lock the pinned dependency surface so accidental range
 * drift (^, ~) or an engine change fails `npm run test` early. When a pin is
 * intentionally upgraded, update package.json AND this test together.
 */
const EXACT_PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

describe("desktop scaffold invariants", () => {
  it("declares engines.node as '>=22'", () => {
    expect(pkg.engines.node).toBe(">=22");
  });

  it("pins react and react-dom to the agreed exact versions", () => {
    expect(pkg.dependencies.react).toBe("19.3.0");
    expect(pkg.dependencies["react-dom"]).toBe("19.3.0");
  });

  it("keeps every runtime dependency pinned to an exact version (no ^/~ ranges)", () => {
    for (const [name, spec] of Object.entries(pkg.dependencies)) {
      expect(spec, `dependency ${name} must be an exact pin`).toMatch(EXACT_PIN);
    }
  });

  it("keeps every development dependency pinned to an exact version (no ^/~ ranges)", () => {
    for (const [name, spec] of Object.entries(pkg.devDependencies)) {
      expect(spec, `devDependency ${name} must be an exact pin`).toMatch(EXACT_PIN);
    }
  });
});
