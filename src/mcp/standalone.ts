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
 *   JCAP roots: JLINK_MCP_STORAGE_ROOT, JLINK_MCP_EVIDENCE_ROOT
 */

// Provide a minimal vscode stub (only needed for config.ts imports that reference vscode)
const vscodeStub = {
  workspace: {
    getConfiguration: (_section: string) => ({
      get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    }),
  },
};

const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...args: any[]) {
  if (request === "vscode") return request;
  return originalResolve.call(this, request, ...args);
};
require.cache["vscode"] = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub } as any;

import { JLinkMcpServer } from "./server";
import { ProbeFactoryConfig } from "../probe/factory";
import { initLogger } from "../utils/logger";
import { runTrustValidate } from "./trust/trust-cli";
import { runApprovalBrokerCli, startApprovalBrokerIpc } from "./approval-broker";
import { dirname } from "node:path";
export { JcapV0QueryService, jcapCaptureEventWindow, jcapCaptureExportCsv, jcapCaptureList, jcapCaptureSeries, jcapCaptureSummary, rebuildJcapV0Index, verifyJcapV0Index, writeJcapV0Raw } from "./jcap/jcap-v0";

// Stderr logger for standalone mode
initLogger({ appendLine(msg: string) { process.stderr.write(msg + "\n"); } } as any);

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
  const args = process.argv.slice(2);
  if (args[0] === "approve") {
    process.exitCode = await runApprovalBrokerCli(args.slice(1));
    return;
  }
  if (args[0] === "trust" && args[1] === "validate") {
    process.exitCode = await runTrustValidate(args.slice(2));
    return;
  }
  const probeConfig = buildProbeConfig();
  process.stderr.write(`Starting MCP server with probe: ${probeConfig.type}\n`);
  const approvalBroker = await startApprovalBrokerIpc();

  const server = new JLinkMcpServer(
    probeConfig,
    undefined, // rttPort derived from probe
    env("GDB_PATH") || "arm-none-eabi-gdb",
    {
      storageRoot: env("JLINK_MCP_STORAGE_ROOT"),
      evidenceRoot: env("JLINK_MCP_EVIDENCE_ROOT"),
    }
  );

  const shutdown = async () => { await server.dispose(); await approvalBroker.close(); process.exit(0); };
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
