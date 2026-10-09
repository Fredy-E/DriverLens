import { describe, expect, it } from "vitest";

import { PAGE_SIZE, paginate } from "../src/lib/pagination";

/**
 * Pagination is the bounded-rendering mechanism for the 20,000-device cap:
 * it must be pure, total (any requested page is clamped), and never hand the
 * table more than one page of rows.
 */

describe("paginate", () => {
  it("uses a 50-row page by default", () => {
    expect(PAGE_SIZE).toBe(50);
    expect(paginate(Array.from({ length: 120 }, (_, i) => i), 1)).toMatchObject({
      page: 1,
      pageCount: 3,
      total: 120,
      from: 1,
      to: 50,
    });
  });

  it("renders only one page of a 20,000-row list", () => {
    const items = Array.from({ length: 20_000 }, (_, i) => i);
    const page = paginate(items, 1);
    expect(page.items).toHaveLength(PAGE_SIZE);
    expect(page.items[0]).toBe(0);
    expect(page.items[49]).toBe(49);
    expect(page.pageCount).toBe(400);

    const last = paginate(items, 400);
    expect(last.items).toHaveLength(PAGE_SIZE);
    expect(last.items[0]).toBe(19_950);
    expect(last.to).toBe(20_000);
  });

  it("clamps out-of-range and nonsense page numbers instead of returning nothing", () => {
    const items = ["a", "b", "c"];
    expect(paginate(items, 0).page).toBe(1);
    expect(paginate(items, -5).page).toBe(1);
    expect(paginate(items, Number.NaN).page).toBe(1);
    expect(paginate(items, 99).page).toBe(1); // 3 items → 1 page
    expect(paginate(Array.from({ length: 120 }, (_, i) => i), 99).page).toBe(3);
    // Fractional page numbers are truncated, then clamped.
    expect(paginate(Array.from({ length: 120 }, (_, i) => i), 2.9).page).toBe(2);
  });

  it("reports an honest empty first page for an empty list", () => {
    const page = paginate([], 1);
    expect(page.items).toEqual([]);
    expect(page.page).toBe(1);
    expect(page.pageCount).toBe(1);
    expect(page.total).toBe(0);
    expect(page.from).toBe(0);
    expect(page.to).toBe(0);
  });

  it("keeps slice boundaries exact at page edges", () => {
    const items = Array.from({ length: 101 }, (_, i) => i);
    const second = paginate(items, 2);
    expect(second.items[0]).toBe(50);
    expect(second.from).toBe(51);
    expect(second.to).toBe(100);
    const third = paginate(items, 3);
    expect(third.items).toEqual([100]);
    expect(third.to).toBe(101);
  });
});
