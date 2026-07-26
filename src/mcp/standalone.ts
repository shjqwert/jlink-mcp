#!/usr/bin/env node
/**
 * Standalone MCP server entry point.
 * Run with: node out/mcp/standalone.js
 *
 * Environment variables:
 *   PROBE_TYPE       - "jlink" (default)
 *
 *   J-Link:
 *     JLINK_DEVICE, JLINK_INSTALL_DIR, JLINK_INTERFACE, JLINK_SPEED,
 *     JLINK_SERIAL, JLINK_GDB_PORT, JLINK_RTT_PORT, JLINK_SWO_PORT
 *   Local roots: JLINK_MCP_STORAGE_ROOT, JLINK_MCP_EVIDENCE_ROOT, JLINK_MCP_QUEUE_ROOT
 */

import { JLinkMcpServer } from "./server";
import { ProbeFactoryConfig } from "../probe/factory";
import { initLogger } from "../utils/logger";
import { dirname } from "node:path";

// Stderr logger for standalone mode
initLogger({ appendLine(msg: string) { process.stderr.write(msg + "\n"); } });

function env(key: string): string | undefined { return process.env[key]; }
function buildProbeConfig(): ProbeFactoryConfig {
  const probeType = env("PROBE_TYPE") || "jlink";
  if (probeType !== "jlink") {
    throw new Error(`Unsupported PROBE_TYPE: ${probeType}. Supported: jlink`);
  }
  const dllPath = env("JLINK_DLL_PATH");
  return {
    type: "jlink",
    jlink: {
      device: env("JLINK_DEVICE") || "Unspecified",
      installDir: env("JLINK_INSTALL_DIR") || (dllPath ? dirname(dllPath) : undefined),
      interface: (env("JLINK_INTERFACE") as "SWD" | "JTAG") || undefined,
      speed: env("JLINK_SPEED") ? Number(env("JLINK_SPEED")) : undefined,
      serialNumber: env("JLINK_SERIAL"),
      gdbPort: env("JLINK_GDB_PORT") ? Number(env("JLINK_GDB_PORT")) : undefined,
      rttTelnetPort: env("JLINK_RTT_PORT") ? Number(env("JLINK_RTT_PORT")) : undefined,
      swoTelnetPort: env("JLINK_SWO_PORT") ? Number(env("JLINK_SWO_PORT")) : undefined,
    },
  };
}

async function main() {
  if (process.argv[2] === "doctor") {
    const { runDoctor } = await import("./doctor");
    const report = await runDoctor();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "ok") process.exitCode = 1;
    return;
  }
  const probeConfig = buildProbeConfig();
  process.stderr.write(`Starting MCP server with probe: ${probeConfig.type}\n`);

  const server = new JLinkMcpServer(probeConfig, {
    storageRoot: env("JLINK_MCP_STORAGE_ROOT"),
    evidenceRoot: env("JLINK_MCP_EVIDENCE_ROOT"),
    queueRoot: env("JLINK_MCP_QUEUE_ROOT"),
  });

  const shutdown = async () => { await server.dispose(); process.exit(0); };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  await server.startStdio();
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
  });
}
