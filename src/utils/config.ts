import * as path from "path";
import * as fs from "fs";

export interface JLinkConfig {
  /** Path to SEGGER J-Link installation directory */
  installDir: string;
  /** Target device name (e.g., "NRF52840_XXAA", "STM32F407VG") */
  device: string;
  /** Interface: SWD or JTAG */
  interface: "SWD" | "JTAG";
  /** Connection speed in kHz */
  speed: number;
  /** Serial number of J-Link (optional, for multi-probe setups) */
  serialNumber?: string;
  /** GDB server port */
  gdbPort: number;
  /** RTT telnet port */
  rttTelnetPort: number;
  /** SWO telnet port */
  swoTelnetPort: number;
}

export interface AppConfig {
  jlink: JLinkConfig;
}

const VERSIONED_JLINK_DIR = /^JLink_V(\d+)[A-Za-z0-9._-]*$/i;

/** Find a usable J-Link installation without binding callers to a machine-specific path. */
export function findJLinkInstallDir(device: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = configuredJLinkInstallDir(env);
  if (configured) return configured;

  const candidates: string[] = [];
  for (const root of jLinkInstallRoots(env)) {
    candidates.push(path.join(root, "JLink"));
    try {
      for (const entry of fs.readdirSync(root)) {
        if (VERSIONED_JLINK_DIR.test(entry)) candidates.push(path.join(root, entry));
      }
    } catch { /* absent or unreadable installation root */ }
  }
  return selectJLinkInstallDir(candidates, device);
}

/** Select the best discovered installation for the requested device. */
export function selectJLinkInstallDir(candidates: readonly string[], device?: string): string {
  const installations = [...new Set(candidates)].filter(isJLinkInstallation);
  if (!installations.length) return "";
  const requestedDevice = device?.trim();
  const supported = requestedDevice ? installations.filter((candidate) => manifestDeclaresDevice(candidate, requestedDevice)) : [];
  return rankJLinkInstallations(supported.length ? supported : installations)[0] ?? "";
}

function configuredJLinkInstallDir(env: NodeJS.ProcessEnv): string {
  return env.JLINK_INSTALL_DIR?.trim() || env.JLINK_HOME?.trim() || "";
}

function jLinkInstallRoots(env: NodeJS.ProcessEnv): string[] {
  const programFiles = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.join(value, "SEGGER"));
  return [...new Set([
    "/opt/SEGGER", "/usr/local/SEGGER", "/Applications/SEGGER",
    ...programFiles,
  ])];
}

function isJLinkInstallation(installDir: string): boolean {
  try {
    if (!fs.statSync(installDir).isDirectory()) return false;
    return ["JLink.exe", "JLinkExe", "JLinkGDBServerCL.exe", "JLinkGDBServer", "JLinkGDBServerCLExe"].some((file) => fs.existsSync(path.join(installDir, file)));
  } catch {
    return false;
  }
}

function manifestDeclaresDevice(installDir: string, device: string): boolean {
  try {
    const manifest = fs.readFileSync(path.join(installDir, "JLinkDevices.xml"), "utf8");
    return new RegExp(`\\bName\\s*=\\s*["']${escapeRegex(device)}["']`, "i").test(manifest);
  } catch {
    return false;
  }
}

function rankJLinkInstallations(installations: readonly string[]): string[] {
  return [...installations].sort((left, right) => {
    const versionDelta = installationVersion(right) - installationVersion(left);
    return versionDelta || path.basename(right).localeCompare(path.basename(left), undefined, { sensitivity: "base", numeric: true });
  });
}

function installationVersion(installDir: string): number {
  const version = path.basename(installDir).match(VERSIONED_JLINK_DIR)?.[1];
  return version ? Number.parseInt(version, 10) : -1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const configuredInterface = env.JLINK_INTERFACE?.toUpperCase();
  const device = env.JLINK_DEVICE || "Unspecified";
  return {
    jlink: {
      installDir: findJLinkInstallDir(device, env),
      device,
      interface: configuredInterface === "JTAG" ? "JTAG" : "SWD",
      speed: positiveInteger(env.JLINK_SPEED, 4000),
      serialNumber: env.JLINK_SERIAL || undefined,
      gdbPort: positiveInteger(env.JLINK_GDB_PORT, 2331),
      rttTelnetPort: positiveInteger(env.JLINK_RTT_PORT, 19021),
      swoTelnetPort: positiveInteger(env.JLINK_SWO_PORT, 2332),
    },
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getJLinkExePath(config: JLinkConfig): string {
  const exe = process.platform === "win32" ? "JLink.exe" : "JLinkExe";
  return config.installDir ? path.join(config.installDir, exe) : exe;
}

export function getJLinkGDBServerPath(config: JLinkConfig): string {
  const exe =
    process.platform === "win32"
      ? "JLinkGDBServerCL.exe"
      : "JLinkGDBServerCLExe";
  return config.installDir ? path.join(config.installDir, exe) : exe;
}

export function getJLinkRTTClientPath(config: JLinkConfig): string {
  const exe =
    process.platform === "win32" ? "JLinkRTTClient.exe" : "JLinkRTTClientExe";
  return config.installDir ? path.join(config.installDir, exe) : exe;
}
