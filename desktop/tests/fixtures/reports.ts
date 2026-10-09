/**
 * Synthetic report fixtures for the frontend tests. Everything here is
 * invented data — no real inventory is ever read, mocked, or fabricated to
 * look real (names say "Test"/"Local" on purpose).
 */
import type { Device, Report } from "../../src/contracts/report";
import sampleJson from "./sample.json";

/** A device with the required fields defaulted. */
export function device(overrides: Partial<Device> & { id: string; name: string }): Device {
  return { status: "observed", ...overrides };
}

/** A non-sample ("local inventory") report with varied evidence. */
export const LOCAL_REPORT: Report = {
  schemaVersion: 1,
  sample: false,
  generatedAt: "2026-10-08T00:00:00Z",
  system: { os: "Test Windows", build: "26100", architecture: "ARM64" },
  warnings: [],
  devices: [
    device({
      id: "LOCAL001",
      name: "Test USB Serial Adapter",
      deviceClass: "Ports",
      bus: "USB",
      vid: "04D8",
      pid: "000A",
      provider: "Contoso",
      version: "1.0.0.0",
      inf: "contoso.inf",
      signed: true,
      packageTargets: ["ARM64", "x64"],
      architecture: "ARM64",
      kernelBinary: "contoso.sys",
      service: "ContosoSvc",
      windowsStatus: "OK",
      errorCode: 0,
      notes: [],
    }),
    device({
      id: "LOCAL002",
      name: "Legacy Controller",
      deviceClass: "USB",
      bus: "PCI",
      vid: "FFFF",
      pid: null,
      provider: "Adventure Works",
      version: "0.9",
      inf: "aw.inf",
      signed: false,
      packageTargets: ["x64"],
      architecture: "x64",
      kernelBinary: "aw.sys",
      service: "AwSvc",
      status: "review",
      windowsStatus: "Error",
      errorCode: 10,
      notes: ["Windows device error 10", "Driver metadata reports unsigned"],
    }),
    device({
      id: "LOCAL003",
      name: "Test System Component",
      deviceClass: "System",
      bus: "ACPI",
      provider: "",
      version: "",
      signed: null,
      packageTargets: [],
      architecture: "Unknown",
      kernelBinary: "",
      service: "",
      status: "observed",
      notes: [],
    }),
  ],
};

/** The browser edition's bundled fictional sample (sample: true). */
export const SAMPLE_REPORT: Report = sampleJson as unknown as Report;

/**
 * A synthetic "scan result" report: what a live scan's report looks like to
 * the UI (no `sample` flag, so no fictional-sample chip). Used by the
 * completed-scan display tests via a mocked `get_report`.
 */
export const SCAN_REPORT: Report = {
  schemaVersion: 1,
  sample: false,
  generatedAt: "2026-10-08T00:00:00Z",
  system: { os: "Test Windows", build: "26100", architecture: "ARM64" },
  warnings: [],
  devices: [
    device({
      id: "SCAN001",
      name: "Test Scanned Adapter",
      deviceClass: "Ports",
      bus: "USB",
      vid: "04D8",
      pid: "000B",
      provider: "Scanned Provider",
      version: "2.0.0.0",
      inf: "scanned.inf",
      signed: true,
      packageTargets: ["ARM64"],
      architecture: "ARM64",
      kernelBinary: "scanned.sys",
      service: "ScannedSvc",
      windowsStatus: "OK",
      errorCode: 0,
      notes: [],
    }),
    device({
      id: "SCAN002",
      name: "Test Scanned Controller",
      deviceClass: "USB",
      bus: "PCI",
      provider: "Scanned Provider",
      version: "1.1",
      inf: "scanned-controller.inf",
      signed: false,
      packageTargets: ["x64"],
      architecture: "x64",
      kernelBinary: "scanned-controller.sys",
      service: "ScannedCtl",
      status: "review",
      windowsStatus: "Error",
      errorCode: 10,
      notes: ["Driver metadata reports unsigned"],
    }),
    device({
      id: "SCAN003",
      name: "Test Scanned System Component",
      deviceClass: "System",
      bus: "ACPI",
      provider: "Scanned Provider",
      version: "1.0",
      signed: null,
      packageTargets: [],
      architecture: "Unknown",
      kernelBinary: "",
      service: "",
      notes: [],
    }),
  ],
};

/** A report with `count` synthetic devices, for bounded-rendering tests. */
export function largeReport(count: number): Report {
  const devices: Device[] = Array.from({ length: count }, (_, index) =>
    device({
      id: `BULK${String(index).padStart(6, "0")}`,
      name: `Synthetic device ${index}`,
      deviceClass: "System",
      bus: index % 2 === 0 ? "USB" : "PCI",
      provider: `Provider ${index % 5}`,
      version: "1.0",
      inf: `bulk-${index}.inf`,
      architecture: index % 3 === 0 ? "ARM64" : "x64",
      status: index % 4 === 0 ? "review" : "observed",
      notes: [],
    })
  );
  return {
    schemaVersion: 1,
    sample: false,
    generatedAt: "2026-10-08T00:00:00Z",
    system: { os: "Synthetic Windows", build: "Synthetic", architecture: "ARM64" },
    warnings: [],
    devices,
  };
}

/** Script-like hostile strings for the escaping tests. */
export const HOSTILE_REPORT: Report = {
  schemaVersion: 1,
  sample: false,
  generatedAt: "2026-10-08T00:00:00Z",
  system: { os: "Hostile OS <script>window.__pwned=1</script>", build: "0", architecture: "ARM64" },
  warnings: [],
  devices: [
    device({
      id: "EVIL001",
      name: '"><script>window.__pwned = 1;</script>',
      deviceClass: "<style>*{display:none}</style>",
      bus: "USB",
      provider: "<img src=x onerror=window.__pwned=2>",
      version: "</td></tr><script>window.__pwned=3</script>",
      inf: "<iframe src=javascript:window.__pwned=4></iframe>",
      service: "<svg onload=window.__pwned=5>",
      kernelBinary: "<script>window.__pwned=6</script>.sys",
      windowsStatus: "OK",
      errorCode: 0,
      notes: ["<b>bold note</b>", "<script>window.__pwned=7</script>"],
    }),
  ],
};
