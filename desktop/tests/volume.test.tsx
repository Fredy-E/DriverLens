// @vitest-environment jsdom
/**
 * Volume regression (Task 13): the 20,000-device cap through the bounded
 * rendering path. Structural bounds (50-row pages, bounded DOM) are exact;
 * the elapsed-time budgets are deliberately coarse guards against an
 * O(report) regression, not benchmarks — a failure means something got
 * dramatically slower, not that a threshold needs tuning. All data is
 * synthetic.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import DeviceTable from "../src/components/DeviceTable";
import { DEFAULT_QUERY, filterDevices } from "../src/lib/filters";
import { paginate } from "../src/lib/pagination";
import { largeReport } from "./fixtures/reports";

afterEach(() => {
  cleanup();
});

const CAP = 20_000;
/** Coarse regression budget (see header). */
const BUDGET_MS = 2_000;

describe("20,000-device volume", () => {
  it("filters and searches the cap within a bounded budget (pure)", () => {
    const report = largeReport(CAP);
    expect(report.devices).toHaveLength(CAP);

    const started = performance.now();
    const matches = filterDevices(report.devices, {
      ...DEFAULT_QUERY,
      search: "synthetic device 19999",
    });
    const reviewOnly = filterDevices(report.devices, { ...DEFAULT_QUERY, status: "review" });
    const page = paginate(matches, 1);
    const elapsed = performance.now() - started;

    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe("BULK019999");
    expect(reviewOnly).toHaveLength(5_000);
    expect(page.items).toHaveLength(1);
    console.log(
      `pure filter+search+paginate over ${CAP} devices: ${elapsed.toFixed(1)} ms (budget ${BUDGET_MS / 4} ms)`
    );
    expect(elapsed).toBeLessThan(BUDGET_MS / 4);
  });

  it("renders only one bounded page of the cap and pages without DOM growth", async () => {
    const user = userEvent.setup();
    const report = largeReport(CAP);

    const started = performance.now();
    const { container } = render(
      <DeviceTable
        devices={report.devices}
        query={DEFAULT_QUERY}
        onQueryChange={() => {}}
        hasReport
      />
    );
    const elapsed = performance.now() - started;

    expect(container.querySelectorAll("tr.device-row")).toHaveLength(50);
    expect(container.querySelectorAll("tr")).toHaveLength(51); // header + one page
    const nodesOnFirstPage = container.querySelectorAll("*").length;
    console.log(
      `initial render of one page of ${CAP}: ${elapsed.toFixed(1)} ms, ${nodesOnFirstPage} DOM nodes`
    );
    expect(nodesOnFirstPage).toBeLessThan(2_000);
    expect(elapsed).toBeLessThan(BUDGET_MS);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Page 2 of 400/)).toBeTruthy();
    expect(container.querySelectorAll("tr.device-row")).toHaveLength(50);
    // Page two costs the same bounded node count: no accumulation.
    expect(container.querySelectorAll("*").length).toBeLessThan(2_000);
  });
});
