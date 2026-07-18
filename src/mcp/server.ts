import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProbeBackend } from "../probe/backend";
import { createProbeBackend, ProbeFactoryConfig } from "../probe/factory";
import { GDBClient } from "../gdb/gdb-client";
import { RTTClient, ParsedLogLine } from "../rtt/rtt-client";
import { ProcessManager } from "../utils/process-manager";
import { log } from "../utils/logger";
import { HssCaptureService } from "./hss/hss-capture-service";
import { hssProjectPaths } from "./hss/project-paths";
import { JcapBoundsError, JcapCaptureNotFoundError, JcapV0QueryService } from "./jcap/jcap-v0";
import type { HssVariableWritePlanInput } from "./hss/hss-write-plan";
import type { HssVariableWriteExecuteInput } from "./hss/hss-write-execute";
import { rttChannelListTool, rttChannelReadTool } from "./rtt-channel/rtt-channel-tools";
import { canonicalR4Args, erasePlan, executeR4Operation, flashPlan, gdbCommandPlan, probeCommandPlan, unverifiedVariableWritePlan, type R4PlanInput } from "./risk-operations";
import type { R4ExecuteTool } from "./approval-broker";
import { ANALYSIS_PROFILES, DISCOVERY_CATALOG, discoveryToolConfig, OFFLINE_JCAP_PROMPT } from "./discovery";

export interface JLinkMcpServerOptions {
  cwd?: string;
  storageRoot?: string;
  evidenceRoot?: string;
}

export class JLinkMcpServer {
  private server: McpServer;
  private processManager: ProcessManager;
  private probe: ProbeBackend;
  private gdb: GDBClient;
  private rttClient: RTTClient;
  private jcapCapture: JcapV0QueryService;
  private hssCapture: HssCaptureService;

  constructor(probeConfig?: ProbeFactoryConfig, rttPort?: number, gdbPath?: string, options: JLinkMcpServerOptions = {}) {
    this.processManager = new ProcessManager();
    this.probe = createProbeBackend(
      probeConfig || { type: "jlink" },
      this.processManager
    );

    const effectiveGdbPath = gdbPath || "arm-none-eabi-gdb";
    this.gdb = new GDBClient(effectiveGdbPath, () => this.probe.getExclusiveOwner() ? `Probe is exclusively owned by ${this.probe.getExclusiveOwner()}` : null);
    this.hssCapture = new HssCaptureService(this.probe, options);
    this.jcapCapture = new JcapV0QueryService(hssProjectPaths(options.cwd).capturesDir);
    const effectiveRttPort = rttPort ?? this.probe.getRTTPort();
    this.rttClient = new RTTClient("localhost", effectiveRttPort > 0 ? effectiveRttPort : 19021);
    this.server = new McpServer({
      name: "jlink-mcp",
      version: "0.3.2",
    });

    this.registerTools();
    this.registerResources();
    this.registerPrompts();
  }

  /**
   * Returns an MCP error response if device is not configured, or null if OK.
   * Call at the top of any tool handler that talks to hardware.
   */
  private requireDevice(): { content: [{ type: "text"; text: string }] } | null {
    const owner = this.probe.getExclusiveOwner();
    if (owner) {
      return { content: [{ type: "text", text: `ERROR: Probe is exclusively owned by ${owner}. Only capture status/stop/control and non-hardware queries are available.` }] };
    }
    if (!this.probe.isDeviceConfigured()) {
      return {
        content: [{
          type: "text",
          text: `ERROR: No target device configured for ${this.probe.displayName}.\n\nBefore using debugging tools, you must set the target device. Please:\n1. Call list_devices to scan for connected probes\n2. Call set_device with the correct device name (e.g., "nRF52840_XXAA", "STM32F407VG")\n\nCommon device names: nRF52840_XXAA, nRF5340_xxAA_APP, STM32F407VG, STM32L476RG, STM32H743ZI, RP2040_M0_0`,
        }],
      };
    }
    return null;
  }

  private registerTools(): void {
    const probe = this.probe;

    // ═══════════════════════════════════════════════════════════════
    // DEVICE CONFIGURATION (always available, even without device set)
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "list_devices",
      "Scan for connected debug probes and show what hardware is attached. Use this first if you don't know what device is connected.",
      {},
      async () => {
        const result = await probe.listDevices();
        const lines = [
          `Probe: ${probe.displayName}`,
          `Currently configured device: ${probe.getDeviceName()}`,
          `Device configured: ${probe.isDeviceConfigured() ? "Yes" : "NO - use set_device to configure"}`,
          "",
          "--- Scan Results ---",
          result.output || result.rawOutput || "(no output)",
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    );

    this.server.tool(
      "set_device",
      "Set the target device name at runtime. Required before any debugging commands will work. Examples: 'nRF52840_XXAA', 'nRF5340_xxAA_APP', 'STM32F407VG', 'STM32L476RG'.",
      {
        device: z.string().describe("Target device name (e.g., 'nRF52840_XXAA', 'STM32F407VG')"),
      },
      async ({ device }) => {
        probe.setDevice(device);
        return { content: [{ type: "text", text: `Device set to "${device}". You can now use all debugging tools.` }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // COMPOSITE / WORKFLOW TOOLS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "start_debug_session",
      `One-call setup: starts GDB server via ${probe.displayName}, connects RTT (if supported), waits for initial output. This is the recommended first tool to call. If no device is configured, use list_devices and set_device first.`,
      {},
      async () => {
        const guard = this.requireDevice();
        if (guard) return guard;
        const steps: string[] = [];

        if (!probe.isGDBServerRunning()) {
          const gdbResult = await probe.startGDBServer();
          steps.push(gdbResult.success ? `GDB Server: started (${probe.displayName})` : `GDB Server: ${gdbResult.message}`);
          if (!gdbResult.success) return { content: [{ type: "text", text: steps.join("\n") }] };
          await sleep(2000);
        } else {
          steps.push("GDB Server: already running");
        }

        if (probe.supportsRTT() && !this.rttClient.isConnected()) {
          try {
            this.rttClient.clearBuffer(); // Clear stale buffers from previous sessions
            await this.rttClient.connect();
            probe.rttConnected = true;
            steps.push(`RTT: connected (port ${probe.getRTTPort()})`);
            await sleep(1500);
          } catch (err) {
            probe.rttConnected = false;
            steps.push(`RTT: failed - ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (!probe.supportsRTT()) {
          steps.push(`RTT: not supported by ${probe.displayName}`);
        } else {
          steps.push("RTT: already connected");
        }

        const lines = this.rttClient.getLines(100);
        if (lines.length > 0) {
          steps.push(`\n--- Device Output (${lines.length} lines) ---`);
          steps.push(lines.join("\n"));
        } else {
          steps.push("\nNo RTT output yet.");
        }

        return { content: [{ type: "text", text: steps.join("\n") }] };
      }
    );

    this.server.tool(
      "snapshot",
      "Capture complete device state: CPU registers (compact), fault status, recent RTT output, and stack dump.",
      { rttLines: z.number().min(0).max(200).optional().describe("RTT lines to include (default 30)") },
      async ({ rttLines }) => {
        const guard = this.requireDevice();
        if (guard) return guard;
        const sections: string[] = [];

        const regResult = await probe.readAllRegisters();
        const regs = probe.parseRegisters(regResult.rawOutput);
        if (regs) {
          sections.push("## Registers");
          sections.push(probe.formatRegistersCompact(regs));
        } else {
          sections.push("## Registers\n" + (regResult.output || "Failed to read"));
        }

        const faultData = await probe.readFaultRegisters();
        sections.push("\n## Fault Status");
        sections.push(faultData.decoded);

        if (regs?.["SP"]) {
          const sp = parseInt(regs["SP"], 16);
          if (!isNaN(sp) && sp > 0) {
            const stackResult = await probe.readMemory(sp, 64);
            const stackDump = probe.parseMemoryDump(stackResult.rawOutput);
            if (stackDump.length > 0) {
              sections.push("\n## Stack (64 bytes from SP)");
              sections.push(stackDump.map((d) => `${d.address}: ${d.hex}  ${d.ascii}`).join("\n"));
            }
          }
        }

        const lines = this.rttClient.getLines(rttLines ?? 30);
        if (lines.length > 0) {
          sections.push(`\n## RTT Output (last ${lines.length} lines)`);
          sections.push(lines.join("\n"));
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      }
    );

    this.server.tool(
      "diagnose_crash",
      "Auto-read and decode ARM Cortex-M fault registers (CFSR, HFSR, MMFAR, BFAR), exception stack frame, and recent errors.",
      {},
      async () => {
        const guard = this.requireDevice();
        if (guard) return guard;
        const sections: string[] = ["## Crash Diagnosis"];

        const regResult = await probe.readAllRegisters();
        const regs = probe.parseRegisters(regResult.rawOutput);
        if (regs) {
          sections.push("\n### CPU State");
          sections.push(probe.formatRegistersCompact(regs));
          const ipsr = regs["IPSR"];
          if (ipsr && ipsr !== "0x000" && ipsr !== "0x00000000") {
            sections.push(`\n⚠ CPU is in exception handler (IPSR=${ipsr})`);
          }
        }

        const faultData = await probe.readFaultRegisters();
        sections.push("\n### Fault Registers");
        sections.push(`CFSR=0x${faultData.raw.cfsr.toString(16).padStart(8, "0")} HFSR=0x${faultData.raw.hfsr.toString(16).padStart(8, "0")} MMFAR=0x${faultData.raw.mmfar.toString(16).padStart(8, "0")} BFAR=0x${faultData.raw.bfar.toString(16).padStart(8, "0")}`);
        sections.push("\n### Decoded Faults");
        sections.push(faultData.decoded);

        if (regs) {
          const spAddr = regs["PSP"] && regs["PSP"] !== "0x00000000"
            ? parseInt(regs["PSP"], 16)
            : parseInt(regs["MSP"] || "0", 16);
          if (spAddr > 0 && spAddr < 0xFFFFFFFF) {
            const frameResult = await probe.readMemory(spAddr, 32);
            const frameDump = probe.parseMemoryDump(frameResult.rawOutput);
            if (frameDump.length > 0) {
              sections.push("\n### Exception Stack Frame");
              const allBytes = frameDump.map((d) => d.hex).join(" ");
              const bytes = allBytes.split(/\s+/).filter(Boolean);
              if (bytes.length >= 32) {
                const frameRegs = ["R0", "R1", "R2", "R3", "R12", "LR", "PC", "xPSR"];
                for (let i = 0; i < frameRegs.length; i++) {
                  const offset = i * 4;
                  if (offset + 3 < bytes.length) {
                    const val = [bytes[offset+3], bytes[offset+2], bytes[offset+1], bytes[offset]].join("");
                    sections.push(`  ${frameRegs[i].padEnd(5)} = 0x${val}`);
                  }
                }
                if (bytes.length >= 28) {
                  const faultPC = [bytes[27], bytes[26], bytes[25], bytes[24]].join("");
                  sections.push(`\n→ Faulting instruction at PC=0x${faultPC}`);
                }
              } else {
                sections.push(frameDump.map((d) => `${d.address}: ${d.hex}`).join("\n"));
              }
            }
          }
        }

        const errLines = this.rttClient.search({ level: "err", count: 10 });
        const wrnLines = this.rttClient.search({ level: "wrn", count: 5 });
        if (errLines.length > 0 || wrnLines.length > 0) {
          sections.push("\n### Recent Errors/Warnings from RTT");
          for (const l of [...errLines, ...wrnLines]) {
            sections.push(`  [${l.level === "err" ? "ERR" : "WRN"}] ${l.module || "?"}: ${l.message}`);
          }
        }

        return { content: [{ type: "text", text: sections.join("\n") }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // DEVICE CONTROL
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("device_info",
      `Get connected device info via ${probe.displayName}. Returns probe type, target CPU, and compact register summary.`,
      {},
      async () => {
        const guard = this.requireDevice();
        if (guard) return guard;
        const result = await probe.getDeviceInfo();
        const regs = probe.parseRegisters(result.rawOutput);
        if (regs) {
          return { content: [{ type: "text", text: `Probe: ${probe.displayName}\n\n${probe.formatRegistersCompact(regs)}` }] };
        }
        return { content: [{ type: "text", text: result.output || result.rawOutput }] };
      }
    );

    this.discoveredTool("halt", {},
      async () => {
        const r = await this.hssCapture.cpuControl("halt");
        return { content: [{ type: "text", text: r.ok ? "CPU halted" : `Failed: ${r.error?.code}: ${r.error?.message}` }], structuredContent: { ...r } };
      }
    );

    this.discoveredTool("resume", {},
      async () => {
        const r = await this.hssCapture.cpuControl("resume");
        return { content: [{ type: "text", text: r.ok ? "CPU resumed" : `Failed: ${r.error?.code}: ${r.error?.message}` }], structuredContent: { ...r } };
      }
    );

    this.discoveredTool("reset",
      { halt: z.boolean().optional().describe("Halt after reset (default: false)") },
      async ({ halt }) => {
        const r = await this.hssCapture.cpuControl("reset", { halt: halt ?? false });
        return { content: [{ type: "text", text: r.ok ? `Device reset${halt ? " (halted)" : " (running)"}` : `Failed: ${r.error?.code}: ${r.error?.message}` }], structuredContent: { ...r } };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // MEMORY
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("read_memory", "Read memory from the target. Returns clean hex dump.",
      {
        address: z.string().describe("Hex address (e.g., '0x20000000')"),
        length: z.number().min(1).max(4096).describe("Bytes to read (max 4096)"),
      },
      async ({ address, length }) => {
        const g = this.requireDevice(); if (g) return g;
        const addr = parseInt(address, 16);
        if (isNaN(addr)) return { content: [{ type: "text", text: "Error: invalid hex address" }] };
        const r = await probe.readMemory(addr, length);
        const dump = probe.parseMemoryDump(r.rawOutput);
        if (dump.length > 0) return { content: [{ type: "text", text: dump.map((d) => `${d.address}: ${d.hex}  ${d.ascii}`).join("\n") }] };
        return { content: [{ type: "text", text: r.output || "Could not read memory" }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // REGISTERS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("read_registers", "Read all CPU registers (compact format, FP only if non-zero).", {},
      async () => {
        const g = this.requireDevice(); if (g) return g;
        const r = await probe.readAllRegisters();
        const regs = probe.parseRegisters(r.rawOutput);
        if (regs) return { content: [{ type: "text", text: probe.formatRegistersCompact(regs) }] };
        return { content: [{ type: "text", text: r.output }] };
      }
    );

    this.server.tool("read_register", "Read a specific CPU register by name",
      { register: z.string().describe("Register name (e.g., 'PC', 'SP', 'R0')") },
      async ({ register }) => {
        const g = this.requireDevice(); if (g) return g;
        const r = await probe.readRegister(register);
        return { content: [{ type: "text", text: r.output || r.rawOutput }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // FLASH
    // ═══════════════════════════════════════════════════════════════

    this.discoveredTool("flash_plan",
      {
        filePath: z.string().describe("Path to firmware file (.hex, .bin, .elf)"),
        baseAddress: z.string().optional().describe("Base address for .bin files (hex)"),
      },
      async ({ filePath, baseAddress }) => this.r4PlanResponse("flash", { filePath, ...(baseAddress !== undefined ? { baseAddress: this.parseBaseAddress(baseAddress) } : {}) })
    );
    this.discoveredTool("flash",
      {
        filePath: z.string().describe("Path to firmware file (.hex, .bin, .elf)"),
        baseAddress: z.string().optional().describe("Base address for .bin files (hex)"),
        challengeId: z.string().uuid(),
      },
      async ({ filePath, baseAddress, challengeId }) => {
        const g = this.requireDevice(); if (g) return g;
        const addr = baseAddress === undefined ? undefined : this.parseBaseAddress(baseAddress);
        return this.r4ExecuteResponse("flash", { filePath, ...(addr !== undefined ? { baseAddress: addr } : {}) }, challengeId, () => probe.flash(filePath, addr));
      }
    );

    this.discoveredTool("erase_plan", {}, async () => this.r4PlanResponse("erase", {}));
    this.discoveredTool("erase", { challengeId: z.string().uuid() },
      async ({ challengeId }) => {
        const g = this.requireDevice(); if (g) return g;
        return this.r4ExecuteResponse("erase", {}, challengeId, () => probe.erase());
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // GDB SERVER
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("gdb_server_start", `Start ${probe.displayName} GDB server`, {},
      async () => { const g = this.requireDevice(); if (g) return g; const r = await probe.startGDBServer(); return { content: [{ type: "text", text: r.message }] }; }
    );

    this.server.tool("gdb_server_stop", `Stop ${probe.displayName} GDB server and disconnect RTT`, {},
      async () => { const g = this.requireDevice(); if (g) return g; this.rttClient.disconnect(); probe.rttConnected = false; const r = probe.stopGDBServer(); return { content: [{ type: "text", text: r.message }] }; }
    );

    this.server.tool("gdb_server_status", "Get GDB server and RTT status", {},
      async () => {
        const status = { probeState: probe.getStatus(), rtt: this.rttClient.getStats() };
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // GDB (source-level debugging)
    // ═══════════════════════════════════════════════════════════════

    this.server.tool(
      "gdb_connect",
      "Connect a GDB client to the running GDB server. Enables source-level debugging: backtraces, variable inspection, conditional breakpoints, stepping by source line. Optionally load an ELF file for symbol info.",
      {
        elfFile: z.string().optional().describe("Path to .elf file with debug symbols (enables source-level debugging)"),
        host: z.string().optional().describe("GDB server host (default: localhost)"),
        port: z.number().optional().describe("GDB server port (default: 2331)"),
      },
      async ({ elfFile, host, port }) => {
        // Auto-start GDB server if not running
        if (!probe.isGDBServerRunning()) {
          const g = this.requireDevice(); if (g) return g;
          const startResult = await probe.startGDBServer();
          if (!startResult.success) return { content: [{ type: "text", text: `Failed to start GDB server: ${startResult.message}` }] };
          await sleep(2000); // Wait for server to bind port
        }
        const gdbPort = port ?? probe.getGDBServerStatus().gdbPort;
        const result = await this.gdb.connect(host ?? "localhost", gdbPort, elfFile);
        return { content: [{ type: "text", text: result.success ? result.output : `Failed: ${result.error || result.output}` }] };
      }
    );

    this.discoveredTool(
      "gdb_command_plan",
      {
        command: z.string().describe("One canonical GDB command"),
        timeout: z.number().optional().describe("Timeout in ms (default 15000)"),
      },
      async ({ command, timeout }) => this.r4PlanResponse("gdb_command", { command, timeout: timeout ?? 15000 })
    );
    this.discoveredTool(
      "gdb_command",
      {
        command: z.string().describe("GDB command to execute"),
        timeout: z.number().optional().describe("Timeout in ms for run commands (default 15000)"),
        challengeId: z.string().uuid(),
      },
      async ({ command, timeout, challengeId }) => {
        const effectiveTimeout = timeout ?? 15000;
        return this.r4ExecuteResponse("gdb_command", { command, timeout: effectiveTimeout }, challengeId, () => this.gdb.command(command, effectiveTimeout));
      }
    );

    this.server.tool(
      "gdb_wait",
      "Poll for target stop after a continue/step that timed out. Returns the stop reason (breakpoint hit, signal, finished stepping, etc.) when the target halts.",
      {
        timeout: z.number().optional().describe("How long to wait in ms (default 30000)"),
      },
      async ({ timeout }) => {
        if (!this.gdb.isConnected()) {
          return { content: [{ type: "text", text: "GDB not connected" }] };
        }
        const result = await this.gdb.wait(timeout ?? 30000);
        return { content: [{ type: "text", text: result.stopReason === "running" ? "Target still running" : `${result.output}` }] };
      }
    );

    this.server.tool(
      "gdb_load",
      "Load an ELF file into GDB for symbols only. Flashing must use flash_plan, one protected local CLI approval, then flash.",
      {
        elfFile: z.string().describe("Path to .elf file with debug symbols"),
        flash: z.boolean().optional().describe("Deprecated: flashing through gdb_load is rejected; use flash_plan then flash"),
      },
      async ({ elfFile, flash }) => {
        if (flash) return { content: [{ type: "text", text: "gdb_load never flashes. Use flash_plan, approve the exact challenge once in the protected local CLI, then call flash." }] };
        const loadSymbols = await this.gdb.loadSymbols(elfFile);
        return { content: [{ type: "text", text: `Symbols loaded: ${loadSymbols.output}\n\nBacktraces and variable inspection will now show source file:line info.` }] };
      }
    );

    this.server.tool(
      "gdb_backtrace",
      "Get a stack backtrace. With debug symbols loaded, shows function names, file paths, and line numbers.",
      {
        full: z.boolean().optional().describe("Include local variables in each frame (default false)"),
      },
      async ({ full }) => {
        const result = await this.gdb.backtrace(full ?? false);
        return { content: [{ type: "text", text: result.output || "(no backtrace available)" }] };
      }
    );

    this.server.tool(
      "gdb_disconnect",
      "Disconnect the GDB client (does not stop the GDB server)",
      {},
      async () => {
        this.gdb.disconnect();
        return { content: [{ type: "text", text: "GDB client disconnected" }] };
      }
    );

    this.registerAnalysisTools();
    this.registerJcapCaptureTools();
    this.registerRttChannelTools();
    this.registerHssCaptureTools();

    // ═══════════════════════════════════════════════════════════════
    // RTT
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("rtt_connect", `Connect to RTT${probe.supportsRTT() ? "" : " (not supported by " + probe.displayName + ")"}`, {},
      async () => {
        const guard = this.requireDevice(); if (guard) return guard;
        if (!probe.supportsRTT()) return { content: [{ type: "text", text: `RTT is not supported by ${probe.displayName}` }] };
        if (!probe.isGDBServerRunning()) return { content: [{ type: "text", text: "GDB server must be running for RTT. Use start_debug_session or gdb_server_start first." }] };
        try {
          this.rttClient.clearBuffer();
          await this.rttClient.connect();
          probe.rttConnected = true;
          return { content: [{ type: "text", text: "Connected to RTT" }] };
        }
        catch (err) { probe.rttConnected = false; return { content: [{ type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` }] }; }
      }
    );

    this.server.tool("rtt_disconnect", "Disconnect from RTT", {},
      async () => { this.rttClient.disconnect(); probe.rttConnected = false; return { content: [{ type: "text", text: "Disconnected from RTT" }] }; }
    );

    this.server.tool("rtt_read", "Read recent RTT log lines (clean, parsed Zephyr format)",
      { count: z.number().min(1).max(500).optional().describe("Lines to read (default 50)") },
      async ({ count }) => {
        if (!this.rttClient.isConnected()) return { content: [{ type: "text", text: "RTT not connected. Use start_debug_session first." }] };
        const lines = this.rttClient.getLines(count ?? 50);
        return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No RTT output yet." }] };
      }
    );

    this.server.tool("rtt_search", "Search/filter RTT logs by level, module, or regex",
      {
        level: z.string().optional().describe("Log level: 'err', 'wrn', 'inf', 'dbg'"),
        module: z.string().optional().describe("Module name (partial match)"),
        pattern: z.string().optional().describe("Regex or text pattern"),
        count: z.number().min(1).max(500).optional().describe("Max results (default 50)"),
      },
      async ({ level, module, pattern, count }) => {
        const results = this.rttClient.search({ level, module, pattern, count: count ?? 50 });
        if (results.length === 0) return { content: [{ type: "text", text: "No matches found" }] };
        return { content: [{ type: "text", text: `Found ${results.length} matches:\n${results.map(formatLogLine).join("\n")}` }] };
      }
    );

    this.server.tool("rtt_clear", "Clear RTT buffer", {},
      async () => { this.rttClient.clearBuffer(); return { content: [{ type: "text", text: "RTT buffer cleared" }] }; }
    );

    // ═══════════════════════════════════════════════════════════════
    // RAW / CONFIG
    // ═══════════════════════════════════════════════════════════════

    this.discoveredTool("probe_command_plan",
      { commands: z.array(z.string()).describe("Canonical probe commands") },
      async ({ commands }) => this.r4PlanResponse("probe_command", { commands })
    );
    this.discoveredTool("probe_command",
      { commands: z.array(z.string()).describe("Canonical probe commands"), challengeId: z.string().uuid() },
      async ({ commands, challengeId }) => {
        const g = this.requireDevice(); if (g) return g;
        return this.r4ExecuteResponse("probe_command", { commands }, challengeId, () => probe.executeRaw(commands));
      }
    );

    this.server.tool("get_config", "Get current probe and server configuration", {},
      async () => {
        return { content: [{ type: "text", text: JSON.stringify({ probe: probe.type, displayName: probe.displayName, supportsRTT: probe.supportsRTT(), gdbServer: probe.getGDBServerStatus() }, null, 2) }] };
      }
    );
  }

  private registerAnalysisTools(): void {
    const result = async (operation: () => Promise<unknown> | unknown) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }] };
      } catch (error) {
        const code = error instanceof JcapBoundsError
          ? "bounds_error"
          : error instanceof JcapCaptureNotFoundError
            ? "capture_not_found"
            : "analysis_error";
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", code, message: error instanceof Error ? error.message : String(error) }) }] };
      }
    };

    this.discoveredTool("analysis_profiles", {}, async () => result(() => ANALYSIS_PROFILES));
    this.discoveredTool(
      "analysis_run",
      {
        captureId: z.string().uuid(),
        profile: z.enum(["generic_control", "generic_state_machine"]),
        signalRoles: z.record(z.string().min(1).max(256), z.enum(["command", "feedback", "state"])).refine((roles) => Object.keys(roles).length <= 16, "at most 16 signal roles"),
        eventId: z.string().uuid().optional(),
        beforeMs: z.number().int().min(0).max(60000).optional(),
        afterMs: z.number().int().min(0).max(60000).optional(),
        startTick: z.string().regex(/^\d+$/).optional(),
        endTick: z.string().regex(/^\d+$/).optional(),
      },
      async (input) => result(() => this.jcapCapture.analysisRun(input)),
    );
  }

  private registerJcapCaptureTools(): void {
    const result = async (operation: () => Promise<unknown>) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await operation()) }] };
      } catch (error) {
        const code = error instanceof JcapBoundsError
          ? "bounds_error"
          : error instanceof JcapCaptureNotFoundError
            ? "capture_not_found"
            : "jcap_error";
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", code, message: error instanceof Error ? error.message : String(error) }) }] };
      }
    };

    const captureId = { captureId: z.string().uuid().describe("Indexed JCAP capture UUID under the configured captures root") };
    this.discoveredTool("capture_list", {
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(1024).optional(),
    }, async (input) => result(() => this.jcapCapture.list(input)));
    this.discoveredTool("capture_summary", captureId,
      async (input) => result(() => this.jcapCapture.summary(input)));
    this.discoveredTool("capture_series", {
      ...captureId,
      variables: z.array(z.string().min(1).max(256)).min(1).max(32),
      startTick: z.string().regex(/^\d+$/),
      endTick: z.string().regex(/^\d+$/),
      bucketCount: z.number().int().min(1).max(4096),
    }, async (input) => result(() => this.jcapCapture.series(input)));
    this.discoveredTool("capture_event_window", {
      ...captureId,
      eventId: z.string().uuid(),
      variables: z.array(z.string().min(1).max(256)).max(16),
      beforeMs: z.number().int().min(0).max(60000),
      afterMs: z.number().int().min(0).max(60000),
      bucketCount: z.number().int().min(1).max(2048),
    }, async (input) => result(() => this.jcapCapture.eventWindow(input)));
    this.discoveredTool("capture_index_rebuild", captureId,
      async (input) => result(() => this.jcapCapture.rebuild(input)));
    this.discoveredTool("capture_export", captureId,
      async (input) => result(() => this.jcapCapture.exportCsv(input)));
  }

  private discoveredTool<Args extends Record<string, z.ZodType>>(name: string, inputSchema: Args, callback: ToolCallback<Args>): void {
    this.server.registerTool(name, { ...discoveryToolConfig(name), inputSchema }, callback);
  }

  private registerRttChannelTools(): void {
    const result = async (operation: () => Promise<unknown> | unknown) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", reason: error instanceof Error ? error.message : String(error) }, null, 2) }] };
      }
    };

    this.server.tool("rtt_channel_list", "List RTT channels from a provided control-block snapshot.", {
      controlBlockAddress: z.string().optional(),
      upChannels: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string().optional(), direction: z.literal("up"), size: z.number().optional() })).optional(),
      downChannels: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string().optional(), direction: z.literal("down"), size: z.number().optional() })).optional(),
    }, async (input) => result(() => rttChannelListTool({ controlBlockAddress: input.controlBlockAddress, upChannels: input.upChannels ?? [], downChannels: input.downChannels ?? [] })));
    this.server.tool("rtt_channel_read", "Read an RTT up-channel from a caller-provided read-only ring snapshot.", {
      selector: z.union([z.number().int().nonnegative(), z.string()]),
      controlBlockAddress: z.string(),
      upChannels: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string().optional(), direction: z.literal("up"), size: z.number().optional() })).min(1),
      ring: z.object({ bufferHex: z.string(), rdOff: z.number().int().nonnegative(), wrOff: z.number().int().nonnegative() }).strict(),
      maxBytes: z.number().int().positive().max(65536).optional(),
    }, async ({ selector, controlBlockAddress, upChannels, ring, maxBytes }) => result(() => rttChannelReadTool({
      snapshot: { controlBlockAddress, upChannels, downChannels: [] },
      selector,
      ring: { buffer: Buffer.from(ring.bufferHex, "hex"), rdOff: ring.rdOff, wrOff: ring.wrOff },
      maxBytes,
    })));

  }

  private registerHssCaptureTools(): void {
    const result = async (operation: () => Promise<unknown>) => {
      return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }] };
    };
    const hssDllInput = {
      dllPath: z.string().optional(),
      device: z.string().optional(),
      targetId: z.string().optional(),
      projectRoot: z.string().optional(),
      projectConfigFile: z.string().optional(),
      interface: z.enum(["SWD", "JTAG"]).optional(),
      speedKhz: z.number().int().positive().optional(),
      serial: z.string().optional(),
      script: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("none") }).strict(),
        z.object({ mode: z.literal("file"), path: z.string().min(1) }).strict(),
      ]),
    };
    const scalarType = z.enum(["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32"]);
    const symbolRef = z.object({
      artifactGeneration: z.string().regex(/^[0-9a-f]{64}$/i),
      qualifiedName: z.string().min(1),
      memberPath: z.string().min(1).optional(),
      layoutHash: z.string().regex(/^[0-9a-f]{64}$/i),
    }).strict();
    const variableRef = z.object({
      source: z.enum(["symbol", "hot_variable"]),
      ref: symbolRef,
    }).strict();
    const addressRange = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
    const planInput = {
      artifactFile: z.string().optional(),
      mapFile: z.string().optional(),
      variableRefs: z.array(variableRef).min(1).max(10),
      nonvolatileRanges: z.array(addressRange).min(1).max(64).optional(),
      ramRanges: z.array(addressRange).min(1).max(64).optional(),
      requestedRateHz: z.number().int().min(1).max(16000).optional(),
      durationSec: z.number().int().min(1).max(60).optional(),
      segmentSizeMb: z.number().int().min(16).max(512).optional(),
      sessionName: z.string().optional(),
      outputSubdir: z.string().optional(),
      dryRun: z.boolean().optional(),
      readMode: z.enum(["periodic", "drain"]).optional(),
      resumeBeforeStart: z.boolean().optional(),
      resetBeforeCapture: z.boolean().optional(),
      resetPlanTtlMs: z.number().int().min(1).max(3600000).optional(),
      minimumRecoveryMs: z.number().int().min(0).max(60000).optional(),
      timeoutMs: z.number().int().min(1).max(60000).optional(),
      pollIntervalMs: z.number().int().min(10).max(1000).optional(),
      requiredConsecutiveRunningChecks: z.number().int().min(2).max(100).optional(),
    };
    const captureId = { captureId: z.string().uuid() };
    const writeTargetRef = z.object({
      kind: z.enum(["scalar", "array_element", "array_slice"]),
      path: z.string().min(1),
      index: z.number().int().optional(),
      startIndex: z.number().int().optional(),
    }).strict();

    this.discoveredTool("artifact_probe", {
      artifactFile: z.string().optional(),
      mapFile: z.string().optional(),
    }, async (input) => result(() => this.hssCapture.artifactProbe(input)));
    this.discoveredTool("symbol_search", {
      artifactGeneration: z.string().regex(/^[0-9a-f]{64}$/i),
      query: z.string().min(1).max(256),
      limit: z.number().int().min(1).max(128).optional(),
    }, async (input) => result(() => this.hssCapture.symbolSearch(input)));
    this.discoveredTool("symbol_resolve", {
      artifactGeneration: z.string().regex(/^[0-9a-f]{64}$/i),
      selector: z.string().min(1).max(512),
      type: scalarType,
    }, async (input) => result(() => this.hssCapture.symbolResolve(input)));
    this.discoveredTool("hot_variable_add", {
      ref: symbolRef,
    }, async (input) => result(() => this.hssCapture.hotVariableAdd(input)));
    this.discoveredTool("hot_variable_list", {},
      async () => result(() => this.hssCapture.hotVariableList()));
    this.discoveredTool("hot_variable_refresh", {
      refs: z.array(symbolRef).min(1).max(128),
    }, async (input) => result(() => this.hssCapture.hotVariableRefresh(input)));

    this.discoveredTool("hss_capability_probe", hssDllInput,
      async (input) => result(() => this.hssCapture.capabilityProbe(input)));
    this.discoveredTool("hss_capture_plan", {
      ...hssDllInput,
      ...planInput,
    },
      async (input) => result(() => this.hssCapture.capturePlan(input)));
    this.discoveredTool("hss_capture_start", {
      planId: z.string().uuid(),
      ...hssDllInput,
    }, async (input) => result(() => this.hssCapture.captureStart(input)));
    this.discoveredTool("hss_capture_status", captureId,
      async (input) => result(() => this.hssCapture.captureStatus(input)));
    this.discoveredTool("hss_capture_stop", captureId,
      async (input) => result(() => this.hssCapture.captureStop(input)));
    this.discoveredTool("hss_capture_query", {
      ...captureId,
      metadataFile: z.string().optional(),
      variables: z.array(z.string()).min(1).max(10).optional(),
      startSec: z.number().nonnegative().optional(),
      endSec: z.number().nonnegative().optional(),
      buckets: z.number().int().min(1).max(2000).optional(),
      includeRawSamples: z.boolean().optional(),
      maxSamples: z.number().int().min(1).max(100000).optional(),
      hmC095Profile: z.boolean().optional(),
      mode: z.literal("event_window").optional(),
      eventId: z.string().optional(),
      windowBeforeMs: z.number().nonnegative().optional(),
      windowAfterMs: z.number().nonnegative().optional(),
      flagFilter: z.object({
        exclude: z.array(z.enum(["write_in_progress", "write_nearby", "backend_busy"])).optional(),
        includeNearby: z.boolean().optional(),
      }).strict().optional(),
      summary: z.array(z.enum(["avg", "min", "max", "first", "last", "delta"])).optional(),
    }, async (input) => result(() => this.hssCapture.captureQuery(input)));
    this.discoveredTool("hss_capture_export", {
      ...captureId,
      metadataFile: z.string().optional(),
      format: z.literal("csv").optional(),
      variables: z.array(z.string()).min(1).max(10).optional(),
      eventAware: z.boolean().optional(),
      eventId: z.string().optional(),
      windowBeforeMs: z.number().nonnegative().optional(),
      windowAfterMs: z.number().nonnegative().optional(),
    }, async (input) => result(() => this.hssCapture.captureExport(input)));
    this.discoveredTool("hss_session_recover", {
      captureId: z.string().uuid().optional(),
    }, async (input) => result(() => this.hssCapture.sessionRecover(input)));
    this.discoveredTool("variable_write_plan", {
      captureId: z.string().uuid().optional(),
      artifactFile: z.string().optional(),
      mapFile: z.string().optional(),
      target: z.string().optional(),
      targetRef: writeTargetRef.optional(),
      type: scalarType.optional(),
      value: z.number().optional(),
      values: z.array(z.number()).optional(),
      expiresInMs: z.number().int().positive().max(3600000).optional(),
    }, async (input) => result(() => this.variableWritePlan(input as HssVariableWritePlanInput)));
    this.discoveredTool("variable_write_execute", {
      writePlanId: z.string().startsWith("op_"),
      dryRun: z.boolean().optional(),
      challengeId: z.string().uuid().optional(),
    }, async (input) => result(() => this.variableWriteExecute(input as HssVariableWriteExecuteInput)));
  }

  private async variableWritePlan(input: HssVariableWritePlanInput) {
    const envelope = await this.hssCapture.variableWritePlan(input);
    if (!envelope.ok || envelope.data?.risk !== "R4") return envelope;
    const binding = await this.hssCapture.variableWriteApprovalBinding(envelope.data.writePlanId);
    const challenge = unverifiedVariableWritePlan(binding);
    envelope.risk = { level: "R4", requiresUserApproval: true };
    return { ...envelope, data: { ...envelope.data, challenge } };
  }

  private async variableWriteExecute(input: HssVariableWriteExecuteInput) {
    if (!input.writePlanId || this.hssCapture.variableWriteRisk(input.writePlanId) === "R2") return this.hssCapture.variableWriteExecute(input);
    const outcome = await executeR4Operation({ challengeId: input.challengeId ?? "", cwd: undefined }, {
      revalidate: () => this.hssCapture.variableWriteApprovalBinding(input.writePlanId!),
      execute: (approval) => this.hssCapture.executeR4VariableWrite(input.writePlanId!, approval),
    });
    return { operation: "variable_write_execute", risk: { level: "R4", requiresUserApproval: true }, ...outcome };
  }

  private async r4PlanResponse(tool: R4ExecuteTool, args: Record<string, unknown>) {
    try {
      const input = await this.r4PlanInput(tool, args);
      const challenge = tool === "flash" ? flashPlan(input) : tool === "erase" ? erasePlan(input) : tool === "gdb_command" ? gdbCommandPlan(input) : probeCommandPlan(input);
      return { content: [{ type: "text" as const, text: JSON.stringify({ risk: { level: "R4", requiresUserApproval: true }, challenge }, null, 2) }] };
    } catch (error) { return this.r4ErrorResponse(error); }
  }

  private async r4ExecuteResponse(tool: R4ExecuteTool, args: Record<string, unknown>, challengeId: string, execute: () => Promise<unknown>) {
    try {
      const outcome = await executeR4Operation({ challengeId }, {
        revalidate: () => this.r4PlanInput(tool, args),
        execute,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ risk: { level: "R4", requiresUserApproval: true }, ...outcome }, null, 2) }] };
    } catch (error) { return this.r4ErrorResponse(error); }
  }

  private async r4PlanInput(tool: R4ExecuteTool, args: Record<string, unknown>): Promise<R4PlanInput> {
    if (this.probe.type !== "jlink") throw new Error("R4 hardware mutation is available only through the J-Link backend");
    if (!this.probe.isDeviceConfigured()) throw new Error("target device must be configured before creating an R4 challenge");
    if (tool === "gdb_command" && !this.gdb.isConnected()) throw new Error("GDB must be connected before creating an R4 raw-command challenge");
    const canonicalArgs = canonicalR4Args(tool, args);
    return this.hssCapture.r4Binding(tool as Exclude<R4ExecuteTool, "variable_write_execute">, canonicalArgs, tool === "gdb_command" ? this.gdb.getConnectionGeneration() : undefined);
  }

  private parseBaseAddress(value: string): number {
    const parsed = Number.parseInt(value, 16);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("baseAddress must be a non-negative hexadecimal integer");
    return parsed;
  }

  private r4ErrorResponse(error: unknown) {
    const typed = error as { code?: string; message?: string };
    return { content: [{ type: "text" as const, text: JSON.stringify({ risk: { level: "R4", requiresUserApproval: true }, ok: false, error: { code: typed.code ?? "approval_required", message: typed.message ?? String(error) } }, null, 2) }] };
  }

  private registerResources(): void {
    this.server.resource("discovery-catalog", "jlink://discovery/catalog",
      { description: "Deterministic J-Link MCP workflow, tool facts, and R2/R3/R4/R5 enforcement model", mimeType: "application/json" },
      async () => ({ contents: [{ uri: "jlink://discovery/catalog", text: JSON.stringify(DISCOVERY_CATALOG, null, 2), mimeType: "application/json" }] })
    );

    this.server.resource("rtt-output", "rtt://output",
      { description: "Clean RTT output (ANSI stripped, Zephyr logs parsed)", mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "rtt://output", text: this.rttClient.getLines(200).join("\n"), mimeType: "text/plain" }] })
    );

    this.server.resource("gdb-server-log", "probe://gdb-server-log",
      { description: `Recent ${this.probe.displayName} GDB server output`, mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "probe://gdb-server-log", text: this.probe.getGDBServerOutput(200).join("\n"), mimeType: "text/plain" }] })
    );

    this.server.resource("system-status", "probe://status",
      { description: "Overall system status", mimeType: "application/json" },
      async () => {
        const status = { probe: this.probe.type, displayName: this.probe.displayName, gdbServer: this.probe.getGDBServerStatus(), rtt: this.rttClient.getStats(), runningProcesses: this.processManager.listRunning() };
        return { contents: [{ uri: "probe://status", text: JSON.stringify(status, null, 2), mimeType: "application/json" }] };
      }
    );
  }

  private registerPrompts(): void {
    const probeName = this.probe.displayName;

    this.server.prompt("offline-jcap-analysis", "Use the deterministic Artifact-to-JCAP capture, query, analysis, and risk workflow.", {},
      async () => ({ messages: [{ role: "user", content: { type: "text", text: OFFLINE_JCAP_PROMPT } }] })
    );

    this.server.prompt("debug-embedded", "Start an embedded debugging session.", {},
      async () => ({
        messages: [{ role: "user", content: { type: "text", text:
`You are an embedded debugging assistant with a ${probeName} debug probe.

## IMPORTANT: Device setup
If no device is configured, you MUST do this first:
1. Call **list_devices** to scan for connected probes
2. Call **set_device** with the target name (e.g., "nRF52840_XXAA", "STM32F407VG", "STM32L073RZ")
Then call **start_debug_session** to begin.

## Key tools:
- **list_devices** - Scan for connected probes (always works, even without device set)
- **set_device** - Set target device name (REQUIRED before debugging)
- **start_debug_session** - One-call setup: GDB server + RTT + boot log
- **snapshot** - Full device state in one call
- **diagnose_crash** - Auto-decode fault registers
- **gdb_connect** / **gdb_command** - Full GDB debugging (source-level with .elf symbols)
- **gdb_load** - Load .elf for symbols only; programming requires flash_plan → trusted local broker → flash
- **rtt_read** / **rtt_search** - Device logs (${this.probe.supportsRTT() ? "supported" : "not supported by " + probeName})
- **read_memory** / **read_registers** - Inspect device state
- halt/resume/reset - CPU control
- flash/erase - Firmware programming

## HSS capture and indexed JCAP queries
For continuous variables, never loop **gdb_command**. Use **hss_capture_plan**, **hss_capture_start**, **hss_capture_status**, and **hss_capture_stop** for the production capture lifecycle. After terminal finalization, use bounded **capture_summary**, **capture_series**, **capture_event_window**, **capture_index_rebuild**, and explicit **capture_export** against Indexed JCAP; these query tools do not access hardware.
Never infer control addresses/values or alter SWD speed, rate, variables, or backend after validation failure.

## ARM Cortex-M memory map:
- 0x00000000: Vector table
- 0x20000000: SRAM
- 0xE000ED28: CFSR (fault status)

Start by checking list_devices, then set_device, then start_debug_session.` }}],
      })
    );

    this.server.prompt("crash-analysis", "Diagnose a crash. Use diagnose_crash tool.", {},
      async () => ({
        messages: [{ role: "user", content: { type: "text", text: "My device crashed. Use diagnose_crash first, then explain what happened." } }],
      })
    );

    this.server.prompt("analyze-rtt-output", "Analyze RTT output for errors and anomalies", {},
      async () => {
        const lines = this.rttClient.getLines(200);
        const errs = this.rttClient.search({ level: "err", count: 20 });
        const wrns = this.rttClient.search({ level: "wrn", count: 20 });
        const sections = [];
        if (errs.length > 0) sections.push("## Errors:\n" + errs.map(formatLogLine).join("\n"));
        if (wrns.length > 0) sections.push("## Warnings:\n" + wrns.map(formatLogLine).join("\n"));
        sections.push("## Full log:\n" + (lines.length > 0 ? lines.join("\n") : "(No RTT data)"));
        return { messages: [{ role: "user", content: { type: "text", text: `Analyze this RTT output for faults, errors, anomalies:\n\n${sections.join("\n\n")}` } }] };
      }
    );

    this.server.prompt("peripheral-inspect", "Inspect peripheral registers",
      { peripheral: z.string().optional().describe("Peripheral name"), baseAddress: z.string().optional().describe("Base address hex") },
      async ({ peripheral, baseAddress }) => ({
        messages: [{ role: "user", content: { type: "text", text: `Inspect ${peripheral || "peripheral"} registers.${baseAddress ? ` Base: ${baseAddress}.` : ""} Use read_memory to read the block and decode bit fields.` } }],
      })
    );
  }

  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    log("MCP Server started on stdio");
  }

  async dispose(): Promise<void> {
    await this.hssCapture.dispose();
    this.gdb.disconnect();
    this.rttClient.disconnect();
    this.probe.dispose();
    this.processManager.killAll();
  }
}

function formatLogLine(l: ParsedLogLine): string {
  if (l.deviceTime && l.level && l.module) return `[${l.deviceTime}] <${l.level}> ${l.module}: ${l.message}`;
  return l.message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
