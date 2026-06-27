import type { BackendBenchmarkResult, HssAdapter } from "./capture-backend";
import fs from "fs";
import path from "path";

export interface EnvJlinkHssAdapterOptions {
  installDir?: string;
  projectFile?: string;
}

export class EnvJlinkHssAdapter implements HssAdapter {
  constructor(private readonly options: EnvJlinkHssAdapterOptions = {}) {}

  isAvailable(sdkDir: string): boolean {
    const installDir = (this.options.installDir ?? sdkDir) || findJLinkInstallDir();
    if (!installDir) return false;
    const jscope = path.join(installDir, "JScope.exe");
    const dll = path.join(installDir, "JLink_x64.dll");
    if (!fs.existsSync(jscope) || !fs.existsSync(dll)) return false;
    return dllContainsHssExports(dll);
  }

  projectFile(): string | undefined {
    if (this.options.projectFile && fs.existsSync(this.options.projectFile)) return this.options.projectFile;
    const settings = path.join(process.env.APPDATA ?? "", "SEGGER", "JScopeSettings.ini");
    if (!fs.existsSync(settings)) return undefined;
    const match = fs.readFileSync(settings, "utf8").match(/^Current="([^"]+)"$/m);
    return match && fs.existsSync(match[1]) ? match[1] : undefined;
  }
}

export class FakeJlinkHssAdapter implements HssAdapter {
  constructor(private readonly available: boolean = true) {}

  isAvailable(_sdkDir: string): boolean {
    return this.available;
  }

  benchmark(variables: string[], requestedRateHz: number, durationSec: number): BackendBenchmarkResult {
    return {
      backendName: "jlink-hss",
      variables,
      requestedRateHz,
      actualRateHz: requestedRateHz,
      successRate: 1,
      missedSamples: 0,
      readErrors: 0,
      jitter: { minMs: 0, maxMs: 0, avgMs: 0 },
      durationSec,
      warnings: [],
    };
  }
}

function findJLinkInstallDir(): string {
  const explicit = process.env.JLINK_INSTALL_DIR;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    "C:\\Program Files\\SEGGER\\JLink_V884",
    "C:\\Program Files\\SEGGER\\JLink",
    "C:\\Program Files (x86)\\SEGGER\\JLink",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const segger = "C:\\Program Files\\SEGGER";
  if (!fs.existsSync(segger)) return "";
  try {
    const latest = fs.readdirSync(segger)
      .filter((entry) => entry.startsWith("JLink"))
      .sort()
      .reverse()[0];
    return latest ? path.join(segger, latest) : "";
  } catch {
    return "";
  }
}

function dllContainsHssExports(dll: string): boolean {
  const text = fs.readFileSync(dll).toString("latin1");
  return ["JLINK_HSS_GetCaps", "JLINK_HSS_Start", "JLINK_HSS_Read", "JLINK_HSS_Stop"].every((name) => text.includes(name));
}
