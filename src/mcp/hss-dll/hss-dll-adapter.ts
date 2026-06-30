import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { HSS_CANDIDATE_FUNCTIONS, hssApiCandidateReport } from "./hss-api-candidate";
import { requireHssReadOnlyVariables } from "./hss-symbols";

export interface HssDllDiscovery {
  searchPaths: string[];
  selectedDllPath?: string;
  dllExists: boolean;
  exports: Record<string, boolean>;
  exportsFound: boolean;
  officialSdkHeaderFound: false;
  publicPrototypeCandidate: true;
}

export interface HssHelperOptions {
  env?: Record<string, string | undefined>;
  helperPath?: string;
  helperArgsPrefix?: string[];
  timeoutMs?: number;
}

export interface HssDllPreflightInput {
  dllPath?: string;
  device?: string;
  interface?: "SWD" | "JTAG";
  speedKhz?: number;
  serial?: string;
}

export interface HssDllVariable {
  name: string;
  address: string;
  size: number;
  type?: string;
}

export function hssDllSearchPaths(env: Record<string, string | undefined> = process.env, explicit?: string): string[] {
  const paths = [
    explicit,
    env.JLINK_MCP_HSS_DLL_PATH,
    env.JLINK_INSTALL_DIR ? path.join(env.JLINK_INSTALL_DIR, "JLink_x64.dll") : undefined,
    "C:\\Program Files\\SEGGER\\JLink\\JLink_x64.dll",
    "C:\\Program Files\\SEGGER\\JLink_V884\\JLink_x64.dll",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return [...new Set(paths)];
}

export function discoverHssDll(input: HssDllPreflightInput = {}, env: Record<string, string | undefined> = process.env): HssDllDiscovery {
  const searchPaths = hssDllSearchPaths(env, input.dllPath);
  const selectedDllPath = searchPaths.find((candidate) => fs.existsSync(candidate));
  const text = selectedDllPath ? fs.readFileSync(selectedDllPath).toString("latin1") : "";
  const exports = Object.fromEntries(HSS_CANDIDATE_FUNCTIONS.map((name) => [name, text.includes(name)]));
  return {
    searchPaths,
    selectedDllPath,
    dllExists: Boolean(selectedDllPath),
    exports,
    exportsFound: HSS_CANDIDATE_FUNCTIONS.every((name) => exports[name]),
    officialSdkHeaderFound: false,
    publicPrototypeCandidate: true,
  };
}

export async function hssDllPreflight(input: HssDllPreflightInput = {}, options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const discovery = discoverHssDll(input, env);
  const helperPath = resolveHssHelperPath(env, options.helperPath);
  const helperExists = fs.existsSync(helperPath);
  const device = input.device ?? env.JLINK_DEVICE;
  const runConnectPreflight = Boolean(device)
    && discovery.dllExists
    && discovery.exportsFound
    && helperExists;
  const base = {
    status: discovery.dllExists && discovery.exportsFound ? "candidate" : "blocked",
    hssStatus: "blocked_missing_adapter",
    reason: "HSS DLL candidate found; benchmark remains blocked until GetCaps/Read/Benchmark evidence passes",
    candidateApi: hssApiCandidateReport(false),
    discovery,
    getcapsAllowed: discovery.dllExists && discovery.exportsFound,
    helperPath,
    helperExists,
    benchmarkReady: false,
    jscopeUsed: false,
  };
  if (!discovery.selectedDllPath || !helperExists) return base;
  const helperPreflight = await runHssHelperCommand("preflight", ["--dll", discovery.selectedDllPath], options);
  const connectPreflight = runConnectPreflight
    ? await runHssHelperCommand("connect-preflight", [
      "--dll", discovery.selectedDllPath,
      "--device", device!,
      "--interface", input.interface ?? "SWD",
      "--speed", String(input.speedKhz ?? Number(env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000)),
      ...(input.serial ? ["--serial", input.serial] : []),
    ], options)
    : undefined;
  return {
    ...base,
    helperPreflight,
    connectPreflight,
    safetyStatus: connectPreflight && connectPreflight.targetWasHalted === true ? "HSS_SAFETY_FAIL" : "not_evaluated",
  };
}

export async function hssDllGetCaps(input: HssDllPreflightInput = {}, options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const discovery = discoverHssDll(input, env);
  if (!discovery.selectedDllPath || !discovery.exportsFound) {
    return { status: "error", errorCode: "HSS_DLL_EXPORTS_MISSING", reason: "JLink_x64.dll or required JLINK_HSS_* exports were not found", discovery };
  }
  return runHssHelperCommand("getcaps", ["--dll", discovery.selectedDllPath], options);
}

export async function hssDllSmoke(input: HssDllPreflightInput & {
  elf?: string;
  symbol: string;
  address?: string;
  size?: number;
  durationSec?: number;
  periodUs?: number;
}, options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  requireHssReadOnlyVariables([input.symbol]);
  const gate = await requireExperimentalDllReady(input, options);
  if (gate) return gate;
  return runHssHelperCommand("hss-smoke", [
    "--dll", discoverHssDll(input, options.env ?? process.env).selectedDllPath!,
    "--device", input.device ?? process.env.JLINK_DEVICE ?? "",
    "--interface", input.interface ?? "SWD",
    "--speed", String(input.speedKhz ?? Number(process.env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000)),
    "--symbol", input.symbol,
    "--address", input.address ?? "",
    "--size", String(input.size ?? 4),
    "--duration", String(input.durationSec ?? 5),
    "--period-us", String(input.periodUs ?? 1000),
    ...(input.elf ? ["--elf", input.elf] : []),
  ], options);
}

export async function hssDllBenchmark(input: HssDllPreflightInput & {
  variables: HssDllVariable[];
  durationSec?: number;
  periodUs?: number;
}, options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  requireHssReadOnlyVariables(input.variables.map((variable) => variable.name));
  const gate = await requireExperimentalDllReady(input, options);
  if (gate) return gate;
  return runHssHelperCommand("hss-benchmark", [
    "--dll", discoverHssDll(input, options.env ?? process.env).selectedDllPath!,
    "--device", input.device ?? process.env.JLINK_DEVICE ?? "",
    "--interface", input.interface ?? "SWD",
    "--speed", String(input.speedKhz ?? Number(process.env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000)),
    "--variables", JSON.stringify(input.variables),
    "--duration", String(input.durationSec ?? 30),
    "--period-us", String(input.periodUs ?? 1000),
  ], options);
}

export function resolveHssHelperPath(env: Record<string, string | undefined> = process.env, explicit?: string): string {
  if (explicit) return explicit;
  if (env.JLINK_MCP_HSS_HELPER_PATH) return env.JLINK_MCP_HSS_HELPER_PATH;
  const bundled = path.resolve(__dirname, "..", "..", "..", "native", "hss-helper", "bin", "hss_helper.exe");
  return fs.existsSync(bundled) ? bundled : path.join(process.cwd(), "native", "hss-helper", "bin", "hss_helper.exe");
}

export function runHssHelperCommand(command: string, args: string[], options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const helperPath = resolveHssHelperPath(env, options.helperPath);
  if (!fs.existsSync(helperPath)) {
    return Promise.resolve({ status: "error", errorCode: "HSS_HELPER_MISSING", helperPath, reason: "native HSS helper is not built" });
  }
  const helperArgs = [...(options.helperArgsPrefix ?? []), command, ...args];
  return new Promise((resolve) => {
    const child = spawn(helperPath, helperArgs, { windowsHide: true, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: "error", errorCode: "HSS_HELPER_TIMEOUT", helperPath, command, stderr, reason: "native HSS helper timed out" });
    }, options.timeoutMs ?? 10000);
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ status: "error", errorCode: "HSS_HELPER_SPAWN_FAILED", helperPath, command, reason: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        resolve({ helperExitCode: code, ...parsed });
      } catch {
        resolve({ status: "error", errorCode: "HSS_HELPER_JSON_PARSE_FAILED", helperPath, command, exitCode: code, stdout, stderr, reason: "native HSS helper did not return JSON" });
      }
    });
  });
}

async function requireExperimentalDllReady(input: HssDllPreflightInput, options: HssHelperOptions): Promise<Record<string, unknown> | null> {
  const env = options.env ?? process.env;
  const discovery = discoverHssDll(input, env);
  if (!discovery.selectedDllPath || !discovery.exportsFound) return { status: "error", errorCode: "HSS_DLL_EXPORTS_MISSING", reason: "JLink_x64.dll or required JLINK_HSS_* exports were not found", discovery };
  return null;
}
