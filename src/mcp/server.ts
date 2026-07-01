import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ProbeBackend } from "../probe/backend";
import { createProbeBackend, ProbeFactoryConfig } from "../probe/factory";
import { GDBClient } from "../gdb/gdb-client";
import { RTTClient, ParsedLogLine } from "../rtt/rtt-client";
import { TelnetProxy } from "../telnet/telnet-proxy";
import { ProcessManager } from "../utils/process-manager";
import { log } from "../utils/logger";
import { analysisProfilesTool, experimentAnalyzeTool, experimentCompareTool } from "./analysis/tools";
import { evidenceForCodegraphTool } from "./bridge/tools";
import { CaptureService } from "./capture";
import { captureBackendBenchmarkTool, captureBackendListTool, captureBackendProbeTool, captureBackendSelectTool, captureImportExperimentTool } from "./capture-backends/backend-router";
import { HssCaptureService } from "./hss/hss-capture-service";
import type { HssVariableWritePlanInput } from "./hss/hss-write-plan";
import { hssDllBenchmark, hssDllGetCaps, hssDllPreflight, hssDllSmoke } from "./hss-dll/hss-dll-adapter";
import { parseRttRingAddresses, readDirectRttRing, writeDirectRttRing, type DirectRttMemoryIo } from "./rtt-channel/direct-rtt-memory-transport";
import { rttChannelListTool, rttChannelReadTool, rttChannelWriteTool } from "./rtt-channel/rtt-channel-tools";
import { RspMemoryIo } from "./rtt-channel/rsp-memory-transport";
import { traceagentDecodeStream, traceagentWriteSignal } from "./rtt-protocols/traceagent-tools";

export class JLinkMcpServer {
  private server: McpServer;
  private processManager: ProcessManager;
  private probe: ProbeBackend;
  private gdb: GDBClient;
  private rttClient: RTTClient;
  private telnetProxy: TelnetProxy;
  private capture: CaptureService;
  private hssCapture: HssCaptureService;

  constructor(probeConfig?: ProbeFactoryConfig, rttPort?: number, telnetConfig?: { listenPort?: number; sourceHost?: string; sourcePort?: number }, gdbPath?: string) {
    this.processManager = new ProcessManager();
    this.probe = createProbeBackend(
      probeConfig || { type: "jlink" },
      this.processManager
    );

    const effectiveGdbPath = gdbPath || "arm-none-eabi-gdb";
    this.gdb = new GDBClient(effectiveGdbPath, () => this.probe.getExclusiveOwner() ? `Probe is exclusively owned by ${this.probe.getExclusiveOwner()}` : null);
    this.capture = new CaptureService(this.probe, this.processManager, effectiveGdbPath);
    this.hssCapture = new HssCaptureService(this.probe);
    const effectiveRttPort = rttPort ?? this.probe.getRTTPort();
    this.rttClient = new RTTClient("localhost", effectiveRttPort > 0 ? effectiveRttPort : 19021);
    this.telnetProxy = new TelnetProxy(
      telnetConfig?.listenPort ?? 19400,
      telnetConfig?.sourceHost ?? "localhost",
      telnetConfig?.sourcePort ?? (effectiveRttPort > 0 ? effectiveRttPort : 19021)
    );

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

    this.server.tool("halt", "Halt the target CPU", {},
      async () => {
        const g = this.requireDevice(); if (g) return g;
        const r = await probe.halt();
        return { content: [{ type: "text", text: r.success ? "CPU halted" : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("resume", "Resume the target CPU", {},
      async () => {
        const g = this.requireDevice(); if (g) return g;
        const r = await probe.resume();
        return { content: [{ type: "text", text: r.success ? "CPU resumed" : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("reset", "Reset the target device",
      { halt: z.boolean().optional().describe("Halt after reset (default: false)") },
      async ({ halt }) => {
        const g = this.requireDevice(); if (g) return g;
        const r = await probe.reset(halt ?? false);
        return { content: [{ type: "text", text: r.success ? `Device reset${halt ? " (halted)" : " (running)"}` : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("step", "Step one CPU instruction",
      {},
      async () => {
        const g = this.requireDevice(); if (g) return g;
        const r = await probe.step();
        const regs = probe.parseRegisters(r.rawOutput);
        if (regs) return { content: [{ type: "text", text: `Stepped. PC=${regs["PC"] || "?"} LR=${regs["LR"] || "?"} SP=${regs["SP"] || "?"}` }] };
        return { content: [{ type: "text", text: r.output }] };
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

    this.server.tool("write_memory", "Write a 32-bit value to memory",
      {
        address: z.string().describe("Hex address"),
        value: z.string().describe("Hex value (e.g., '0xDEADBEEF')"),
      },
      async ({ address, value }) => {
        const g = this.requireDevice(); if (g) return g;
        const addr = parseInt(address, 16), val = parseInt(value, 16);
        if (isNaN(addr) || isNaN(val)) return { content: [{ type: "text", text: "Error: invalid hex" }] };
        const r = await probe.writeMemory(addr, val);
        return { content: [{ type: "text", text: r.success ? `Wrote 0x${val.toString(16)} to 0x${addr.toString(16)}` : `Failed: ${r.output}` }] };
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

    this.server.tool("flash", "Flash firmware to the target device",
      {
        filePath: z.string().describe("Path to firmware file (.hex, .bin, .elf)"),
        baseAddress: z.string().optional().describe("Base address for .bin files (hex)"),
      },
      async ({ filePath, baseAddress }) => {
        const g = this.requireDevice(); if (g) return g;
        const addr = baseAddress ? parseInt(baseAddress, 16) : undefined;
        const r = await probe.flash(filePath, addr);
        return { content: [{ type: "text", text: r.success ? `Flashed ${filePath}` : `Flash failed: ${r.output}` }] };
      }
    );

    this.server.tool("erase", "Erase target flash memory", {},
      async () => {
        const g = this.requireDevice(); if (g) return g;
        const r = await probe.erase();
        return { content: [{ type: "text", text: r.success ? "Chip erased" : `Erase failed: ${r.output}` }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // BREAKPOINTS
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("set_breakpoint", "Set a hardware breakpoint",
      { address: z.string().describe("Hex address") },
      async ({ address }) => {
        const addr = parseInt(address, 16);
        const g = this.requireDevice(); if (g) return g;
        const r = await probe.setBreakpoint(addr);
        return { content: [{ type: "text", text: r.success ? `Breakpoint set at 0x${addr.toString(16)}` : `Failed: ${r.output}` }] };
      }
    );

    this.server.tool("clear_breakpoints", "Clear all breakpoints", {},
      async () => { const g = this.requireDevice(); if (g) return g; await probe.clearBreakpoints(); return { content: [{ type: "text", text: "Breakpoints cleared" }] }; }
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

    this.server.tool("gdb_server_status", "Get GDB server, RTT, and telnet proxy status", {},
      async () => {
        const status = { probeState: probe.getStatus(), rtt: this.rttClient.getStats(), telnetProxy: this.telnetProxy.getStatus() };
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

    this.server.tool(
      "gdb_command",
      "Send any GDB command and get the response. For execution commands (continue, step, next, finish, until), blocks until the target stops or times out. If the target doesn't stop, use gdb_wait to poll. Examples: 'bt' (backtrace), 'info threads', 'print myVar', 'break main', 'continue', 'next', 'step', 'finish', 'info registers', 'x/10xw 0x20000000'",
      {
        command: z.string().describe("GDB command to execute"),
        timeout: z.number().optional().describe("Timeout in ms for run commands (default 15000)"),
      },
      async ({ command, timeout }) => {
        // Don't early-return if disconnected — gdb.command() will auto-reconnect
        const result = await this.gdb.command(command, timeout ?? 15000);
        let text = result.output;
        if (result.stopReason && result.stopReason !== "running") {
          text += `\n\nStopped: ${result.stopReason}`;
        }
        if (result.error) text += `\nError: ${result.error}`;
        return { content: [{ type: "text", text: text || "(no output)" }] };
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
      "Load an ELF file into GDB. By default loads symbols only (for source-level debugging: backtraces with file:line, variable names). Set flash=true to also program it onto the target.",
      {
        elfFile: z.string().describe("Path to .elf file with debug symbols"),
        flash: z.boolean().optional().describe("Also flash the ELF to the target (default: false, symbols only)"),
      },
      async ({ elfFile, flash }) => {
        const loadSymbols = await this.gdb.loadSymbols(elfFile);
        if (!flash) {
          return { content: [{ type: "text", text: `Symbols loaded: ${loadSymbols.output}\n\nBacktraces and variable inspection will now show source file:line info. Use flash=true to also program the target.` }] };
        }
        const loadFlash = await this.gdb.command("load", 60000);
        return { content: [{ type: "text", text: `Symbols: ${loadSymbols.output}\nFlash: ${loadFlash.output}` }] };
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
    this.registerCaptureTools();
    this.registerCaptureBackendTools();
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

    this.server.tool("rtt_send", "Send data to device via RTT down-channel",
      {
        data: z.string().describe("Data to send"),
        channel: z.number().int().nonnegative().optional().describe("Optional RTT down-channel index. Omit for legacy channel-0 telnet behavior."),
        channelName: z.string().optional().describe("Optional RTT down-channel name. Omit for legacy channel-0 telnet behavior."),
        downRing: z.object({
          bufferAddress: z.union([z.string(), z.number()]),
          size: z.number().int().positive().max(65536),
          rdOffAddress: z.union([z.string(), z.number()]),
          wrOffAddress: z.union([z.string(), z.number()]),
        }).strict().optional(),
      },
      async ({ data, channel, channelName, downRing }) => {
        const guard = this.requireDevice(); if (guard) return guard;
        if (channel !== undefined || channelName !== undefined) {
          if (downRing) {
            return this.directRttResult(async () => {
              const io = await this.createDirectRttMemoryIo();
              try {
                const written = await writeDirectRttRing(io, parseRttRingAddresses(downRing), Buffer.from(data, "utf8"));
                return { status: written.ok ? "ok" : "rejected", requestedChannel: channelName ?? channel, ...written };
              } finally {
                await io.dispose?.();
              }
            });
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: "unavailable",
                reason: "direct RTT channel transport not configured",
                requestedChannel: channelName ?? channel,
                legacyChannel0Used: false,
              }, null, 2),
            }],
          };
        }
        const sent = this.rttClient.send(data);
        return { content: [{ type: "text", text: sent ? `Sent ${data.length} bytes` : "Failed: RTT not connected" }] };
      }
    );

    this.server.tool("rtt_clear", "Clear RTT buffer", {},
      async () => { this.rttClient.clearBuffer(); return { content: [{ type: "text", text: "RTT buffer cleared" }] }; }
    );

    // ═══════════════════════════════════════════════════════════════
    // TELNET PROXY
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("telnet_proxy_start", "Start TCP proxy for Trice/Pigweed detokenizer", {},
      async () => { const r = await this.telnetProxy.start(); return { content: [{ type: "text", text: r.message }] }; }
    );
    this.server.tool("telnet_proxy_stop", "Stop telnet proxy", {},
      async () => { this.telnetProxy.stop(); return { content: [{ type: "text", text: "Telnet proxy stopped" }] }; }
    );
    this.server.tool("telnet_proxy_status", "Get telnet proxy status", {},
      async () => { return { content: [{ type: "text", text: JSON.stringify(this.telnetProxy.getStatus(), null, 2) }] }; }
    );
    this.server.tool("telnet_proxy_read", "Read raw data from telnet proxy buffer",
      { lines: z.number().min(1).max(500).optional().describe("Lines (default 100)") },
      async ({ lines }) => {
        const data = this.telnetProxy.getBuffer(lines ?? 100);
        return { content: [{ type: "text", text: data.length > 0 ? data.join("\n") : "No data" }] };
      }
    );

    // ═══════════════════════════════════════════════════════════════
    // RAW / CONFIG
    // ═══════════════════════════════════════════════════════════════

    this.server.tool("probe_command", `Execute raw ${probe.displayName} commands`,
      { commands: z.array(z.string()).describe("Commands to execute") },
      async ({ commands }) => {
        const g = this.requireDevice(); if (g) return g;
        const r = await probe.executeRaw(commands);
        return { content: [{ type: "text", text: r.output || "(no output)" }] };
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
      return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }] };
    };

    this.server.tool("analysis_profiles", "List offline experiment analysis profiles.", {},
      async () => result(() => analysisProfilesTool()));
    this.server.tool(
      "experiment_analyze",
      "Analyze a saved experiment, fixture, capture metadata file, or captureId/outputDir with a read-only generic profile.",
      {
        experimentId: z.string().optional(),
        fixturePath: z.string().optional(),
        experimentPath: z.string().optional(),
        metadataFile: z.string().optional(),
        captureId: z.string().optional(),
        outputDir: z.string().optional(),
        analysisProfile: z.string(),
        signals: z.array(z.string()).optional(),
        signalRoles: z.record(z.string(), z.enum(["command", "feedback", "error", "state", "fault", "limit", "counter", "timestamp", "event", "raw", "derived"])).optional(),
        windowMs: z.tuple([z.number(), z.number()]).optional(),
        maxSamples: z.number().optional(),
      },
      async (input) => result(() => experimentAnalyzeTool(input)),
    );
    this.server.tool(
      "experiment_compare",
      "Compare two saved experiments, fixtures, or capture metadata files with the same read-only generic profile.",
      {
        baselineExperimentId: z.string().optional(),
        baselineExperimentPath: z.string().optional(),
        baselineMetadataFile: z.string().optional(),
        candidateExperimentId: z.string().optional(),
        candidateExperimentPath: z.string().optional(),
        candidateMetadataFile: z.string().optional(),
        analysisProfile: z.string(),
        metrics: z.array(z.string()).optional(),
        signalRoles: z.record(z.string(), z.enum(["command", "feedback", "error", "state", "fault", "limit", "counter", "timestamp", "event", "raw", "derived"])).optional(),
        windowMs: z.tuple([z.number(), z.number()]).optional(),
        maxSamples: z.number().optional(),
      },
      async (input) => result(() => experimentCompareTool(input)),
    );
    this.server.tool(
      "evidence_for_codegraph",
      "Generate Runtime Evidence and CodeGraph query suggestions from offline experiment or capture-backed analysis without calling CodeGraph.",
      {
        experimentId: z.string().optional(),
        fixturePath: z.string().optional(),
        experimentPath: z.string().optional(),
        metadataFile: z.string().optional(),
        captureId: z.string().optional(),
        outputDir: z.string().optional(),
        signalRoles: z.record(z.string(), z.enum(["command", "feedback", "error", "state", "fault", "limit", "counter", "timestamp", "event", "raw", "derived"])).optional(),
        analysisResult: z.unknown(),
      },
      async (input) => result(() => evidenceForCodegraphTool(input)),
    );
  }

  private registerCaptureTools(): void {
    const result = async (operation: () => Promise<unknown>) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    };

    this.server.tool(
      "capture_prepare",
      "Resolve reviewed ELF scalars, verify target Flash/running-state/background RSP reads, calibrate at the configured SWD rate, and arm one capture. Never starts the motor or resets on preparation failure.",
      {
        elfFile: z.string().describe("Absolute path to the exact target ELF"),
        configFile: z.string().describe("Absolute path to the user-confirmed, Git-tracked .jlink-mcp.json"),
        symbols: z.array(z.object({
          name: z.string().min(1).max(255).describe("Global/static scalar or fixed member selector"),
          alias: z.string().min(1).max(127).optional(),
          unit: z.string().max(63).optional(),
        }).strict()).min(1).max(32),
        rateHz: z.number().int().min(1).max(1000).optional(),
        durationSec: z.number().int().min(1).max(600).optional(),
        resetOnFailure: z.boolean().optional().describe("Defaults false; permits one hardware reset only after capture begins and verified stop fails"),
        outputDir: z.string().optional().describe("Optional writable absolute output directory"),
      },
      async (input) => result(() => this.capture.prepare(input)),
    );

    const sessionSchema = { sessionId: z.string().uuid().describe("Exact capture session ID") };
    this.server.tool("capture_start", "Start sampling for an armed session. This does not start the motor.", sessionSchema,
      async ({ sessionId }) => result(() => this.capture.start(sessionId)));
    this.server.tool("capture_status", "Read capture state and metrics without touching another probe session.", sessionSchema,
      async ({ sessionId }) => result(() => this.capture.status(sessionId)));
    this.server.tool("capture_stop", "Safely stop a session; if the motor is verified running, write and verify the reviewed stop mapping before post-stop capture.", sessionSchema,
      async ({ sessionId }) => result(() => this.capture.stop(sessionId)));
    this.server.tool(
      "capture_control",
      "Send only the reviewed start/stop command. Invoke start only after the user explicitly requested motor operation in this current session; sampling must already be running. No address or replacement value is accepted.",
      { sessionId: z.string().uuid(), command: z.enum(["start", "stop"]) },
      async ({ sessionId, command }) => result(() => this.capture.control(sessionId, command)),
    );
    this.server.tool(
      "capture_query",
      "Return at most 2000 ordered min/max/average time buckets from a terminal capture.",
      {
        sessionId: z.string().uuid(),
        variables: z.array(z.string()).min(1).max(32).optional(),
        startSec: z.number().nonnegative().optional(),
        endSec: z.number().nonnegative().optional(),
        buckets: z.number().int().min(1).max(2000).optional(),
      },
      async (input) => result(() => this.capture.query(input)),
    );
    this.server.tool("capture_export", "Export one terminal capture to non-overwriting CSV plus same-name JSON metadata.", sessionSchema,
      async ({ sessionId }) => result(() => this.capture.export(sessionId)));
    this.server.tool("capture_list", "List persisted captures in the default or explicitly selected absolute output directory.",
      { outputDir: z.string().optional() }, async ({ outputDir }) => result(() => this.capture.list(outputDir)));
    this.server.tool("capture_delete", "Delete exactly one terminal session; wildcards, bulk deletion, active sessions, and path escape are rejected.", sessionSchema,
      async ({ sessionId }) => result(() => this.capture.delete(sessionId)));
  }

  private registerCaptureBackendTools(): void {
    const result = async (operation: () => Promise<unknown> | unknown) => {
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", reason: error instanceof Error ? error.message : String(error) }, null, 2) }] };
      }
    };

    this.server.tool("capture_backend_list", "List runtime capture backends and HSS-first priority order.", {},
      async () => result(() => captureBackendListTool()));
    this.server.tool("capture_backend_probe", "Probe capture backend availability without modifying MCU firmware.", {
      preferredBackend: z.enum(["jlink-hss", "direct-rtt-channel", "memory-poll-rsp", "external-import"]).optional(),
      mode: z.enum(["realtime", "offline-import"]).optional(),
    }, async (input) => result(() => captureBackendProbeTool(input)));
    this.server.tool("capture_backend_select", "Select the available backend that would be used for capture.", {
      preferredBackend: z.enum(["jlink-hss", "direct-rtt-channel", "memory-poll-rsp", "external-import"]).optional(),
      mode: z.enum(["realtime", "offline-import"]).optional(),
    }, async (input) => result(() => captureBackendSelectTool(input)));
    this.server.tool("capture_backend_benchmark", "Run backend benchmark when a configured adapter is available.", {
      backendName: z.enum(["jlink-hss", "direct-rtt-channel", "memory-poll-rsp", "external-import"]).optional(),
      variables: z.array(z.string()).optional(),
      requestedRateHz: z.number().positive().optional(),
      durationSec: z.number().positive().optional(),
    }, async (input) => result(() => captureBackendBenchmarkTool(input)));
    this.server.tool("capture_import_experiment", "Register an offline external capture import.", {
      sourcePath: z.string(),
      format: z.enum(["csv", "json", "experiment"]),
    }, async (input) => result(() => captureImportExperimentTool(input)));

    const hssDllPreflightSchema = {
      dllPath: z.string().optional(),
      device: z.string().optional(),
      interface: z.enum(["SWD", "JTAG"]).optional(),
      speedKhz: z.number().int().positive().optional(),
      serial: z.string().optional(),
    };
    this.server.tool("hss_dll_preflight", "Probe experimental JLink_x64.dll HSS candidate symbols without using JScope.", hssDllPreflightSchema,
      async (input) => result(() => hssDllPreflight(input)));
    this.server.tool("hss_dll_getcaps", "Call JLINK_HSS_GetCaps for a candidate JLink_x64.dll.", {
      dllPath: z.string().optional(),
    }, async (input) => result(() => hssDllGetCaps(input)));
    this.server.tool("hss_dll_smoke", "Run HSS Start/Read/Stop smoke for one read-only variable.", {
      ...hssDllPreflightSchema,
      elf: z.string().optional(),
      symbol: z.string(),
      address: z.string().optional(),
      size: z.number().int().positive().optional(),
      durationSec: z.number().positive().optional(),
      periodUs: z.number().int().positive().optional(),
    }, async (input) => result(() => hssDllSmoke(input)));
    this.server.tool("hss_dll_benchmark", "Run HSS benchmark for read-only variables.", {
      ...hssDllPreflightSchema,
      variables: z.array(z.object({
        name: z.string(),
        address: z.string(),
        size: z.number().int().positive(),
        type: z.string().optional(),
      }).strict()).min(1).max(10),
      durationSec: z.number().positive().optional(),
      periodUs: z.number().int().positive().optional(),
    }, async (input) => result(() => hssDllBenchmark(input)));

    this.server.tool("rtt_channel_list", "List RTT channels from a provided control-block snapshot.", {
      controlBlockAddress: z.string().optional(),
      upChannels: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string().optional(), direction: z.literal("up"), size: z.number().optional() })).optional(),
      downChannels: z.array(z.object({ index: z.number().int().nonnegative(), name: z.string().optional(), direction: z.literal("down"), size: z.number().optional() })).optional(),
    }, async (input) => result(() => rttChannelListTool({ controlBlockAddress: input.controlBlockAddress, upChannels: input.upChannels ?? [], downChannels: input.downChannels ?? [] })));
    const ringSchema = z.object({
      bufferAddress: z.union([z.string(), z.number()]),
      size: z.number().int().positive().max(65536),
      rdOffAddress: z.union([z.string(), z.number()]),
      wrOffAddress: z.union([z.string(), z.number()]),
    }).strict();

    this.server.tool("rtt_channel_read", "Read an RTT up-channel through direct RTT ring memory.", {
      selector: z.union([z.number().int().nonnegative(), z.string()]),
      ring: ringSchema.optional(),
      maxBytes: z.number().int().positive().max(65536).optional(),
    }, async ({ selector, ring, maxBytes }) => {
      if (!ring) return result(() => rttChannelReadTool({ snapshot: { upChannels: [], downChannels: [] }, selector }));
      return this.directRttResult(async () => {
        const io = await this.createDirectRttMemoryIo();
        try {
          const read = await readDirectRttRing(io, parseRttRingAddresses(ring), maxBytes);
          return { status: "ok", selector, dataHex: Buffer.from(read.data).toString("hex"), ...read };
        } finally {
          await io.dispose?.();
        }
      });
    });
    this.server.tool("rtt_channel_write", "Write an RTT down-channel through direct RTT ring memory.", {
      selector: z.union([z.number().int().nonnegative(), z.string()]),
      dataHex: z.string(),
      ring: ringSchema.optional(),
    }, async ({ selector, dataHex, ring }) => {
      if (!ring) return result(() => rttChannelWriteTool({ snapshot: { upChannels: [], downChannels: [] }, selector, data: Buffer.from(dataHex, "hex") }));
      return this.directRttResult(async () => {
        const io = await this.createDirectRttMemoryIo();
        try {
          const write = await writeDirectRttRing(io, parseRttRingAddresses(ring), Buffer.from(dataHex, "hex"));
          return { status: write.ok ? "ok" : "rejected", selector, ...write };
        } finally {
          await io.dispose?.();
        }
      });
    });

    this.server.tool("rtt_stream_capture", "Capture an RTT stream when a direct RTT transport is configured.", {
      channel: z.number().int().nonnegative().optional(),
      channelName: z.string().optional(),
      durationSec: z.number().positive().optional(),
      pollIntervalMs: z.number().int().positive().max(1000).optional(),
      ring: ringSchema.optional(),
    }, async (input) => {
      if (!input.ring) return result(() => ({
        status: "unavailable",
        reason: "direct RTT stream transport not configured",
        requestedChannel: input.channelName ?? input.channel ?? null,
        durationSec: input.durationSec ?? null,
      }));
      return this.directRttResult(async () => {
        const data = await this.captureDirectRttStream(parseRttRingAddresses(input.ring!), input.durationSec ?? 1, input.pollIntervalMs ?? 20);
        const decoded = traceagentDecodeStream(data);
        return { status: "ok", requestedChannel: input.channelName ?? input.channel ?? null, bytes: data.length, decoded };
      });
    });
    this.server.tool("rtt_stream_decode", "Decode a TraceAgent RTT byte stream from hex.", {
      dataHex: z.string(),
    }, async ({ dataHex }) => result(() => traceagentDecodeStream(Buffer.from(dataHex, "hex"))));
    this.server.tool("traceagent_decode_stream", "Decode a TraceAgent RTT byte stream from hex.", {
      dataHex: z.string(),
    }, async ({ dataHex }) => result(() => traceagentDecodeStream(Buffer.from(dataHex, "hex"))));
    this.server.tool("traceagent_write_signal", "Encode and optionally send an allowlisted TraceAgent signal write.", {
      signal: z.string(),
      value: z.number(),
      cmdId: z.number().int().nonnegative(),
      downRing: ringSchema.optional(),
      upRing: ringSchema.optional(),
      timeoutMs: z.number().int().positive().max(5000).optional(),
      pollIntervalMs: z.number().int().positive().max(1000).optional(),
    }, async (input) => {
      if (!input.downRing || !input.upRing) return result(() => traceagentWriteSignal(input));
      return this.directRttResult(async () => {
        const io = await this.createDirectRttMemoryIo();
        try {
          const downRing = parseRttRingAddresses(input.downRing!);
          const upRing = parseRttRingAddresses(input.upRing!);
          return traceagentWriteSignal({
            ...input,
            transport: {
              write: async (frame) => {
                const written = await writeDirectRttRing(io, downRing, frame);
                if (!written.ok) throw new Error(written.reason ?? "direct RTT down ring write failed");
              },
              readAck: async () => this.waitForTraceAgentAck(io, upRing, input.timeoutMs ?? 1000, input.pollIntervalMs ?? 20),
            },
          });
        } finally {
          await io.dispose?.();
        }
      });
    });
  }

  private registerHssCaptureTools(): void {
    const result = async (operation: () => Promise<unknown>) => {
      return { content: [{ type: "text" as const, text: JSON.stringify(await operation(), null, 2) }] };
    };
    const hssDllInput = {
      dllPath: z.string().optional(),
      device: z.string().optional(),
      interface: z.enum(["SWD", "JTAG"]).optional(),
      speedKhz: z.number().int().positive().optional(),
      serial: z.string().optional(),
    };
    const symbolSchema = z.object({
      name: z.string().min(1),
      alias: z.string().optional(),
      type: z.enum(["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32"]).optional(),
      unit: z.string().optional(),
    }).strict();
    const planInput = {
      artifactFile: z.string().optional(),
      mapFile: z.string().optional(),
      symbols: z.array(symbolSchema).min(1).max(10).optional(),
      requestedRateHz: z.number().int().min(1).max(16000).optional(),
      durationSec: z.number().int().min(1).max(60).optional(),
      segmentSizeMb: z.number().int().min(16).max(512).optional(),
      sessionName: z.string().optional(),
      outputSubdir: z.string().optional(),
      dryRun: z.boolean().optional(),
      readMode: z.enum(["periodic", "drain"]).optional(),
      resumeBeforeStart: z.boolean().optional(),
    };
    const captureId = { captureId: z.string().uuid() };
    const writeTargetRef = z.object({
      kind: z.enum(["scalar", "array_element", "array_slice"]),
      path: z.string().min(1),
      index: z.number().int().optional(),
      startIndex: z.number().int().optional(),
    }).strict();

    this.server.tool("hss_capability_probe", "Probe read-only J-Link HSS MVP-A availability without reset, halt, flash, raw-command, or target-memory writes.", hssDllInput,
      async (input) => result(() => this.hssCapture.capabilityProbe(input)));
    this.server.tool("hss_capture_plan", "Resolve HM_C095 IAR variables and build a read-only HSS capture plan under process.cwd().", {
      ...hssDllInput,
      ...planInput,
    },
      async (input) => result(() => this.hssCapture.capturePlan(input)));
    this.server.tool("hss_capture_start", "Start one read-only HSS MVP-A capture from a planId or plan input. No RSP fallback.", {
      planId: z.string().uuid().optional(),
      ...hssDllInput,
      ...planInput,
    }, async (input) => result(() => this.hssCapture.captureStart(input)));
    this.server.tool("hss_capture_status", "Return live or terminal HSS MVP-A capture status.", captureId,
      async (input) => result(() => this.hssCapture.captureStatus(input)));
    this.server.tool("hss_capture_stop", "Stop/finalize one read-only HSS MVP-A capture.", captureId,
      async (input) => result(() => this.hssCapture.captureStop(input)));
    this.server.tool("hss_capture_query", "Query a terminal HSS MVP-A capture and run HM_C095 validation metrics.", {
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
    this.server.tool("hss_capture_export", "Export a terminal HSS MVP-A capture to CSV under .jlink-mcp/exports.", {
      ...captureId,
      metadataFile: z.string().optional(),
      format: z.literal("csv").optional(),
      variables: z.array(z.string()).min(1).max(10).optional(),
    }, async (input) => result(() => this.hssCapture.captureExport(input)));
    this.server.tool("variable_write_plan", "Plan an allowlisted capture-time RAM scalar or fixed-array write for the active HSS capture. This does not write target memory.", {
      ...captureId,
      target: z.string().optional(),
      targetRef: writeTargetRef.optional(),
      value: z.number().optional(),
      values: z.array(z.number()).optional(),
      expiresInMs: z.number().int().positive().max(3600000).optional(),
    }, async (input) => result(() => this.hssCapture.variableWritePlan(input as HssVariableWritePlanInput)));
    this.server.tool("variable_write_execute", "Execute a previously planned active-capture variable write through the HSS write queue with old-value read and readback verification.", {
      writePlanId: z.string().startsWith("wp_"),
      dryRun: z.boolean().optional(),
    }, async (input) => result(() => this.hssCapture.variableWriteExecute(input)));
  }

  private directRttResult(operation: () => Promise<unknown>) {
    return operation()
      .then((value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }))
      .catch((error) => ({ content: [{ type: "text" as const, text: JSON.stringify({ status: "error", reason: error instanceof Error ? error.message : String(error) }, null, 2) }] }));
  }

  private async createDirectRttMemoryIo(): Promise<DirectRttMemoryIo> {
    if (this.probe.type !== "jlink") throw new Error("direct RTT ring memory access currently requires the J-Link backend");
    if (!this.probe.isGDBServerRunning()) {
      throw new Error("direct RTT ring access requires a running J-Link GDB server for persistent non-resetting memory access");
    }
    const config = this.probe.getCaptureConfig();
    if (!config) throw new Error("direct RTT ring access requires capture-capable probe configuration");
    return RspMemoryIo.connect({ host: "127.0.0.1", port: config.gdbPort });
  }

  private async captureDirectRttStream(ring: ReturnType<typeof parseRttRingAddresses>, durationSec: number, pollIntervalMs: number): Promise<Buffer> {
    if (durationSec > 60) throw new Error("rtt_stream_capture durationSec max is 60");
    const io = await this.createDirectRttMemoryIo();
    const chunks: Buffer[] = [];
    try {
      const deadline = Date.now() + durationSec * 1000;
      while (Date.now() < deadline) {
        const read = await readDirectRttRing(io, ring);
        if (read.data.length > 0) chunks.push(Buffer.from(read.data));
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      await io.dispose?.();
    }
    return Buffer.concat(chunks);
  }

  private async waitForTraceAgentAck(io: DirectRttMemoryIo, ring: ReturnType<typeof parseRttRingAddresses>, timeoutMs: number, pollIntervalMs: number): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const read = await readDirectRttRing(io, ring);
      if (read.data.length > 0) {
        chunks.push(Buffer.from(read.data));
        const data = Buffer.concat(chunks);
        if (traceagentDecodeStream(data).ackFrames > 0) return data;
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error("TraceAgent ACK timeout");
  }

  private registerResources(): void {
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
        const status = { probe: this.probe.type, displayName: this.probe.displayName, gdbServer: this.probe.getGDBServerStatus(), rtt: this.rttClient.getStats(), telnetProxy: this.telnetProxy.getStatus(), runningProcesses: this.processManager.listRunning() };
        return { contents: [{ uri: "probe://status", text: JSON.stringify(status, null, 2), mimeType: "application/json" }] };
      }
    );
  }

  private registerPrompts(): void {
    const probeName = this.probe.displayName;

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
- **gdb_load** - Load .elf for symbols (set flash=true to also program)
- **rtt_read** / **rtt_search** - Device logs (${this.probe.supportsRTT() ? "supported" : "not supported by " + probeName})
- **read_memory** / **read_registers** - Inspect device state
- halt/resume/reset/step - CPU control
- flash/erase - Firmware programming

## Variable capture and motor safety
For continuous variables, never loop **gdb_command**. Use this exact sequence:
1. **capture_prepare** with the exact ELF and user-confirmed, Git-tracked .jlink-mcp.json
2. Confirm **armed**, then call **capture_start**
3. Call **capture_control start** only when the user explicitly requested motor operation in this current session
4. Use **capture_control stop** or **capture_stop** and verify the stopped state
5. Use **capture_query** and **capture_export** for results
Never infer control addresses/values or alter SWD speed, rate, variables, or backend after calibration failure.

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
    await this.capture.dispose();
    this.gdb.disconnect();
    this.rttClient.disconnect();
    this.telnetProxy.stop();
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
