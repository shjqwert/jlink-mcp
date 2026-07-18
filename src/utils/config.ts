import * as vscode from "vscode";
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

export interface ExtensionConfig {
  jlink: JLinkConfig;
}

function findJLinkInstallDir(): string {
  const candidates = [
    "/opt/SEGGER/JLink",
    "/usr/local/SEGGER/JLink",
    "/Applications/SEGGER/JLink",
    "C:\\Program Files\\SEGGER\\JLink",
    "C:\\Program Files (x86)\\SEGGER\\JLink",
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  // Also check with version suffix
  for (const base of ["/opt/SEGGER", "/Applications/SEGGER", "/usr/local/SEGGER", "C:\\Program Files\\SEGGER", "C:\\Program Files (x86)\\SEGGER"]) {
    if (fs.existsSync(base)) {
      try {
        const entries = fs.readdirSync(base).filter((e) => e.startsWith("JLink"));
        if (entries.length > 0) {
          return path.join(base, entries.sort().reverse()[0]);
        }
      } catch {
        // ignore
      }
    }
  }
  return "";
}

export function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("jlinkMcp");

  return {
    jlink: {
      installDir: cfg.get<string>("jlink.installDir") || findJLinkInstallDir(),
      device: cfg.get<string>("jlink.device") || "Unspecified",
      interface: cfg.get<"SWD" | "JTAG">("jlink.interface") || "SWD",
      speed: cfg.get<number>("jlink.speed") || 4000,
      serialNumber: cfg.get<string>("jlink.serialNumber") || undefined,
      gdbPort: cfg.get<number>("jlink.gdbPort") || 2331,
      rttTelnetPort: cfg.get<number>("jlink.rttTelnetPort") || 19021,
      swoTelnetPort: cfg.get<number>("jlink.swoTelnetPort") || 2332,
    },
  };
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
