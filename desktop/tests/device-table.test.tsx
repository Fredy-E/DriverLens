// @vitest-environment jsdom
/**
 * DeviceTable interaction tests (jsdom): bounded rendering at the
 * 20,000-device cap, no-match/empty states, disabled controls, evidence
 * expansion (mouse + keyboard), badge semantics, and the hostile-string
 * escaping guarantee. All data is synthetic.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DeviceTable from "../src/components/DeviceTable";
import type { Device, DeviceStatus } from "../src/contracts/report";
import { DEFAULT_QUERY, type DeviceQuery } from "../src/lib/filters";
import { statusLabel } from "../src/lib/format";
import { device, HOSTILE_REPORT, largeReport, LOCAL_REPORT } from "./fixtures/reports";

afterEach(() => {
  cleanup();
});

function renderTable(
  devices: Device[],
  overrides: Partial<Parameters<typeof DeviceTable>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <DeviceTable
      devices={devices}
      query={DEFAULT_QUERY}
      onQueryChange={() => {}}
      hasReport
      {...overrides}
    />
  );
}

describe("DeviceTable — bounded rendering", () => {
  it("renders only one page (50 rows) of a 20,000-device report", () => {
    const report = largeReport(20_000);
    const { container } = renderTable(report.devices);

    expect(container.querySelectorAll("tr.device-row")).toHaveLength(50);
    // Total DOM rows stay bounded: header + 50 rows + pager-less.
    expect(container.querySelectorAll("tr").length).toBeLessThan(60);
    expect(screen.getByText(/Page 1 of 400/)).toBeTruthy();
    expect(screen.getByText(/rows 1–50 of 20,000 matched/)).toBeTruthy();
    expect(screen.getByText("Synthetic device 0")).toBeTruthy();
    expect(screen.queryByText("Synthetic device 50")).toBeNull();
  });

  it("pages forward without rendering earlier rows", async () => {
    const user = userEvent.setup();
    const report = largeReport(20_000);
    const { container } = renderTable(report.devices);

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Page 2 of 400/)).toBeTruthy();
    expect(screen.getByText("Synthetic device 50")).toBeTruthy();
    expect(container.querySelectorAll("tr.device-row")).toHaveLength(50);
    expect(screen.queryByText("Synthetic device 0")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText(/Page 1 of 400/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("clamps to the last page instead of rendering nothing", async () => {
    const user = userEvent.setup();
    const report = largeReport(75); // two pages: 50 + 25
    renderTable(report.devices);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Page 2 of 2/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Synthetic device 74")).toBeTruthy();
  });
});

describe("DeviceTable — empty and disabled states", () => {
  it("shows the no-match message for an empty filtered list", () => {
    renderTable([]);
    expect(screen.getByText("No devices match these filters.")).toBeTruthy();
    expect(screen.queryByText(/Page 1 of/)).toBeNull();
  });

  it("shows the no-report message and disables every control without a report", () => {
    renderTable([], { hasReport: false });
    expect(screen.getByText("No report loaded. Open a saved report or load the sample.")).toBeTruthy();
    expect((screen.getByRole("searchbox", { name: "Search devices" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Review status" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Architecture" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Bus" }) as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("DeviceTable — evidence and badges", () => {
  it("renders the full evidence panel for a device (INF, targets, kernel binary, service, status, error code)", async () => {
    const user = userEvent.setup();
    renderTable([LOCAL_REPORT.devices[0]]);

    await user.click(screen.getByRole("button", { name: "Evidence" }));

    expect(screen.getByText("Device digest")).toBeTruthy();
    expect(screen.getByText("LOCAL001")).toBeTruthy();
    expect(screen.getByText("contoso.inf")).toBeTruthy();
    expect(screen.getByText("ARM64, x64")).toBeTruthy();
    expect(screen.getByText("contoso.sys")).toBeTruthy();
    expect(screen.getByText("ContosoSvc")).toBeTruthy();
    expect(screen.getByText("OK")).toBeTruthy();
    // errorCode 0 must render as the real value 0, not "Unknown".
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText("Signed")).toBeTruthy();
    expect(screen.getByText("No notes reported")).toBeTruthy();
  });

  it("keeps unknown evidence visually distinct (muted) from real evidence", async () => {
    const user = userEvent.setup();
    renderTable([LOCAL_REPORT.devices[2]]); // LOCAL003: almost everything absent

    await user.click(screen.getByRole("button", { name: "Evidence" }));

    // Absent values render as muted fallbacks...
    const muted = document.querySelectorAll(".evidence .muted");
    expect(muted.length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText("Not present").className).toContain("muted");
    // ...while real values never get the muted class.
    renderTable([LOCAL_REPORT.devices[0]]);
    await user.click(screen.getAllByRole("button", { name: "Evidence" })[1]);
    expect(screen.getByText("ContosoSvc").closest(".muted")).toBeNull();
  });

  it("shows review vs observed as text badges with distinct styling", () => {
    const { container } = renderTable(LOCAL_REPORT.devices);
    const warn = container.querySelector(".badge--warn");
    expect(warn?.textContent).toBe("Needs review");
    const badges = [...container.querySelectorAll(".badge")].map((badge) => badge.textContent);
    expect(badges).toContain("Observed");
    expect(badges).toContain("ARM64"); // architecture badge stays a plain badge
  });

  it("renders review notes inside the evidence panel", async () => {
    const user = userEvent.setup();
    renderTable([LOCAL_REPORT.devices[1]]);
    await user.click(screen.getByRole("button", { name: "Evidence" }));
    expect(screen.getByText("Windows device error 10")).toBeTruthy();
    expect(screen.getByText("Driver metadata reports unsigned")).toBeTruthy();
  });

  it("toggles evidence with the keyboard (Enter and Space)", async () => {
    const user = userEvent.setup();
    const { container } = renderTable([LOCAL_REPORT.devices[0]]);
    const toggle = screen.getByRole("button", { name: "Evidence" });

    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    await user.keyboard("{Enter}");
    expect(container.querySelector("tr.device-detail")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await user.keyboard(" ");
    expect(container.querySelector("tr.device-detail")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("DeviceTable — query plumbing", () => {
  it("reports search and select changes through onQueryChange", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn<(query: DeviceQuery) => void>();

    // A tiny stateful harness: the controls are controlled components, so
    // the test must feed state back exactly like App does.
    function Harness() {
      const [query, setQuery] = useState<DeviceQuery>(DEFAULT_QUERY);
      return (
        <DeviceTable
          devices={LOCAL_REPORT.devices}
          query={query}
          hasReport
          onQueryChange={(next) => {
            onQueryChange(next);
            setQuery(next);
          }}
        />
      );
    }
    render(<Harness />);

    await user.type(screen.getByRole("searchbox", { name: "Search devices" }), "usb");
    expect(onQueryChange).toHaveBeenLastCalledWith({ ...DEFAULT_QUERY, search: "usb" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Review status" }), "review");
    expect(onQueryChange).toHaveBeenLastCalledWith({
      ...DEFAULT_QUERY,
      search: "usb",
      status: "review",
    });

    await user.selectOptions(screen.getByRole("combobox", { name: "Architecture" }), "ARM64");
    expect(onQueryChange).toHaveBeenLastCalledWith({
      ...DEFAULT_QUERY,
      search: "usb",
      status: "review",
      architecture: "ARM64",
    });

    await user.selectOptions(screen.getByRole("combobox", { name: "Bus" }), "ACPI");
    expect(onQueryChange).toHaveBeenLastCalledWith({
      ...DEFAULT_QUERY,
      search: "usb",
      status: "review",
      architecture: "ARM64",
      bus: "ACPI",
    });
  });
});

describe("DeviceTable — imported strings are text, never markup", () => {
  it("escapes script-like strings everywhere (name, provider, inf, notes, binary)", async () => {
    const user = userEvent.setup();
    const { container } = renderTable(HOSTILE_REPORT.devices);

    // No injected elements of any kind.
    expect(container.querySelector("script, style, img, iframe, svg")).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();

    // The hostile strings are present as literal text.
    expect(screen.getByText('"><script>window.__pwned = 1;</script>')).toBeTruthy();
    expect(container.textContent).toContain("<img src=x onerror=window.__pwned=2>");

    // Even after expanding the evidence (notes are rendered then).
    await user.click(screen.getByRole("button", { name: "Evidence" }));
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>window.__pwned=7</script>")).toBeTruthy();
    expect(container.innerHTML).not.toContain("<script>window.__pwned=7");
    expect(container.innerHTML).toContain("&lt;script&gt;window.__pwned=7");
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });
});

describe("DeviceTable — unknown evidence renders honestly", () => {
  /** The dd following a dt in the expanded evidence list. */
  function evidenceValue(label: string): HTMLElement {
    const term = screen.getByText(label, { selector: "dt" });
    return term.nextElementSibling as HTMLElement;
  }

  it("renders absent signed/architecture/windowsStatus as muted Unknown — never false/Observed", async () => {
    const user = userEvent.setup();
    const bare = device({ id: "BARE001", name: "Bare Evidence Device" }); // every optional field absent
    const { container } = renderTable([bare]);
    await user.click(screen.getByRole("button", { name: "Evidence" }));

    // Signature tri-state: absent is Unknown and must never claim "Unsigned".
    expect(evidenceValue("Signature").textContent).toBe("Unknown");
    expect(evidenceValue("Signature").querySelector(".muted")).not.toBeNull();
    expect(screen.queryByText("Unsigned")).toBeNull();
    expect(screen.queryByText("Signed")).toBeNull();

    expect(evidenceValue("Architecture").textContent).toBe("Unknown");
    expect(evidenceValue("Architecture").querySelector(".muted")).not.toBeNull();
    expect(evidenceValue("Windows status").textContent).toBe("Unknown");
    expect(evidenceValue("Windows status").querySelector(".muted")).not.toBeNull();
    expect(evidenceValue("Error code").textContent).toBe("Unknown");
    expect(evidenceValue("Error code").querySelector(".muted")).not.toBeNull();
    expect(evidenceValue("Service").textContent).toBe("Unknown");
    expect(evidenceValue("Kernel binary").textContent).toBe("Not resolved");
    expect(evidenceValue("INF targets").textContent).toBe("Unknown");

    // The row-level status badge is the contract's real value, not a fallback
    // (scoped to the row: the Status filter's <option> also reads "Observed").
    const statusBadge = container.querySelector("tbody tr.device-row td:last-child .badge");
    expect(statusBadge?.textContent).toBe("Observed");
  });

  it("keeps a real errorCode 0 distinct from a missing one", async () => {
    const user = userEvent.setup();
    renderTable([LOCAL_REPORT.devices[0]]); // errorCode: 0
    await user.click(screen.getByRole("button", { name: "Evidence" }));
    const zero = evidenceValue("Error code");
    expect(zero.textContent).toBe("0");
    expect(zero.querySelector(".muted")).toBeNull();
  });

  it("renders a missing errorCode as muted Unknown (distinct from 0)", async () => {
    const user = userEvent.setup();
    renderTable([device({ id: "NOERR01", name: "No Error Code Device" })]);
    await user.click(screen.getByRole("button", { name: "Evidence" }));
    const missing = evidenceValue("Error code");
    expect(missing.textContent).toBe("Unknown");
    expect(missing.querySelector(".muted")).not.toBeNull();
  });

  it("renders an unexpected status value as a muted Unknown badge, never a guessed Observed", () => {
    const drift = {
      ...device({ id: "DRIFT001", name: "Contract Drift Device", architecture: "x64" }),
      status: "mystery" as DeviceStatus,
    };
    const { container } = renderTable([drift]);
    const statusCell = container.querySelector("tbody tr.device-row td:last-child") as HTMLElement;
    expect(statusCell.textContent).toBe("Unknown");
    expect(statusCell.querySelector(".badge.muted")).not.toBeNull();
    // No badge in the row may claim "Observed" (the Status filter's <option>
    // reads "Observed" too, so scope the check to the row's badges).
    const rowBadges = [...container.querySelectorAll("tbody tr.device-row .badge")].map(
      (badge) => badge.textContent
    );
    expect(rowBadges).not.toContain("Observed");
  });

  it("statusLabel is total: only the contract union yields a definitive label", () => {
    expect(statusLabel("observed")).toBe("Observed");
    expect(statusLabel("review")).toBe("Needs review");
    // Contract drift (a value outside the closed union) — honest fallback.
    expect(statusLabel("mystery" as DeviceStatus)).toBe("Unknown");
  });
});
