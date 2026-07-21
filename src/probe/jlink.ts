import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { ProbeBackend, ProbeState, ProbeErrorCode, CommandResult, GDBServerInfo, CaptureProbeConfig, type ProbeMemoryTransactionInput, type ProbeMemoryTransactionResult } from "./backend";
import { ProcessManager, terminateChildProcess } from "../utils/process-manager";
import { log, logError } from "../utils/logger";
import * as path from "path";
import * as fs from "fs";
import { findJLinkInstallDir } from "../utils/config";

export interface JLinkConfig {
  installDir: string;
  jlinkExePath?: string;
  gdbServerExePath?: string;
  /** Test/package override; defaults to the bundled native helper. */
  memoryHelperPath?: string;
  device: string;
  interface: "SWD" | "JTAG";
  speed: number;
  serialNumber?: string;
  gdbPort: number;
  rttTelnetPort: number;
  swoTelnetPort: number;
}

const GDB_SERVER_PROCESS = "jlink-gdb-server";
export type JLinkSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

// Lines that are JLink connection boilerplate
const BOILERPLATE_PATTERNS = [
  /^SEGGER J-Link Commander/, /^DLL version/, /^J-Link Commander will now exit/,
  /^Connecting to J-Link via USB/, /^Firmware: J-Link/, /^Hardware version:/,
  /^J-Link uptime/, /^S\/N:/, /^License\(s\):/, /^USB speed mode:/, /^VTref=/,
  /^Device ".*" selected/, /^Connecting to target via SWD/, /^Connecting to target via JTAG/,
  /^ConfigTargetSettings\(\)/, /^InitTarget\(\)/, /^Found SW-DP with ID/, /^DPIDR:/,
  /^CoreSight/, /^AP map detection/, /^AP\[\d+\]:/, /^CPUID register:/,
  /^Feature set:/, /^Cache:/, /^Found Cortex-/, /^FPUnit:/,
  /^Security extension: /, /^Secure debug:/, /^ROMTbl\[\d+\]/, /^\[\d+\]\[\d+\]:/,
  /^Memory zones:/, /^\s+Zone:/, /^Cortex-M\d+ identified/, /^Type "connect"/,
  /^Please specify/, /^Specify target/, /^$/, /^J-Link>/, /^J-Link\[\d+\]:/,
  /^Syntax:/, /^Sleep\(\d+\)/, /^Script processing completed/,
];

function stripBoilerplate(raw: string): string {
  return raw.split("\n")
    .filter((line) => {
      const t = line.trim();
      return t && !BOILERPLATE_PATTERNS.some((p) => p.test(t));
    })
    .join("\n").trim();
}

export class JLinkBackend extends ProbeBackend {
  readonly type = "jlink" as const;
  readonly displayName = "SEGGER J-Link";

  private config: JLinkConfig;
  private processManager: ProcessManager;
  private gdbOutputBuffer: string[] = [];
  private connectionGeneration = 0;
  private readonly spawnProcess: JLinkSpawn;

  constructor(config: Partial<JLinkConfig>, processManager: ProcessManager, spawnProcess: JLinkSpawn = spawn) {
    super();
    this.processManager = processManager;
    this.spawnProcess = spawnProcess;
    const device = config.device || "Unspecified";
    this.config = {
      installDir: config.installDir || findJLinkInstallDir(device),
      jlinkExePath: config.jlinkExePath,
      gdbServerExePath: config.gdbServerExePath,
      memoryHelperPath: config.memoryHelperPath,
      device,
      interface: config.interface || "SWD",
      speed: config.speed || 4000,
      serialNumber: config.serialNumber,
      gdbPort: config.gdbPort || 2331,
      rttTelnetPort: config.rttTelnetPort || 19021,
      swoTelnetPort: config.swoTelnetPort || 2332,
    };
  }

  private get jlinkExe(): string {
    if (this.config.jlinkExePath) return this.config.jlinkExePath;
    const exe = process.platform === "win32" ? "JLink.exe" : "JLinkExe";
    return this.config.installDir ? path.join(this.config.installDir, exe) : exe;
  }

  private get gdbServerExe(): string {
    if (this.config.gdbServerExePath) return this.config.gdbServerExePath;
    const exe = process.platform === "win32" ? "JLinkGDBServerCL.exe" : "JLinkGDBServerCLExe";
    return this.config.installDir ? path.join(this.config.installDir, exe) : exe;
  }

  /**
   * Raw JLinkExe execution. Does NOT include preflight/locking.
   * Public methods add only in-process exclusion and the requested command.
   */
  private async execRaw(commands: string[], timeoutMs = 30000): Promise<CommandResult> {
    this.connectionGeneration += 1;
    const args = [
      "-device", this.config.device,
      "-if", this.config.interface,
      "-speed", String(this.config.speed),
      "-autoconnect", "1",
      "-ExitOnError", "1",
      "-NoGui", "1",
    ];
    if (this.config.serialNumber) {
      args.push("-SelectEmuBySN", this.config.serialNumber);
    }

    log(`[J-Link] ${commands.join("; ")}`);

    return new Promise<CommandResult>((resolve) => {
      const proc = this.spawnProcess(this.jlinkExe, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      let settled = false;
      let timedOut = false;
      let processError: Error | undefined;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(result);
      };

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      // J-Link Commander otherwise resumes the target when it closes. Keep the
      // target state under the explicit command/envelope contract.
      proc.stdin?.write(["exec SetRestartOnClose = 0", ...commands, "exit"].join("\n") + "\n");
      proc.stdin?.end();

      proc.on("error", (err) => {
        logError("J-Link spawn error", err);
        this.setState(ProbeState.DISCONNECTED);
        processError = err;
      });
      proc.on("close", (code, signal) => {
        if (timedOut) {
          finish({ success: false, rawOutput: stdout, output: stripBoilerplate(stdout), stderr, error: `J-Link timed out after ${timeoutMs}ms; process close was observed before the Probe queue was released`, errorCode: ProbeErrorCode.TIMEOUT, exitCode: code, exitSignal: signal });
          return;
        }
        if (code !== 0) logError(`J-Link exited with code ${code}`);
        const result: CommandResult = { success: code === 0 && !processError, rawOutput: stdout, output: stripBoilerplate(stdout), stderr, error: processError ? `Failed to spawn JLinkExe: ${processError.message}` : stderr || undefined, exitCode: code, exitSignal: signal };
        if (processError) result.errorCode = ProbeErrorCode.PROBE_NOT_FOUND;
        // Classify errors from output
        if (!result.success) {
          const raw = stdout.toLowerCase();
          if (raw.includes("inittarget() returned error") || raw.includes("could not connect") || raw.includes("cannot connect")) {
            result.errorCode = ProbeErrorCode.TARGET_UNREACHABLE;
            result.lastSuccessfulStage = "probe_connected";
            result.suggestedAction = "Target attach failed. Try: reset with halt, reduce speed, or power cycle.";
          } else if (raw.includes("failed to open dll") || raw.includes("no j-link") || raw.includes("no emulators found")) {
            result.errorCode = ProbeErrorCode.PROBE_NOT_FOUND;
            result.suggestedAction = "No J-Link probe found. Check USB connection.";
          }
        }
        finish(result);
      });

      timeout = setTimeout(() => {
        timedOut = true;
        void terminateChildProcess(proc, { terminateWaitMs: 1_000 });
      }, timeoutMs);
    });
  }

  private async accessMemoryNonIntrusive(address: number, length: number, accessSize: 1 | 2 | 4, writeBytes?: Buffer, transaction?: ProbeMemoryTransactionInput): Promise<CommandResult> {
    if (!Number.isSafeInteger(address) || address < 0 || address > 0xffff_ffff
      || !Number.isSafeInteger(length) || length < 1 || length > 4096
      || address + length > 0x1_0000_0000
      || (writeBytes !== undefined && writeBytes.length !== length)) {
      return { success: false, rawOutput: "", output: "", error: "memory range is invalid", errorCode: ProbeErrorCode.INVALID_ARGUMENT, writeIssued: writeBytes ? false : undefined, stateUnknown: false };
    }
    const helper = this.config.memoryHelperPath ?? path.resolve(__dirname, "..", "..", "native", "hss-helper", "bin", "hss_helper.exe");
    const dll = ["JLink_x64.dll", "JLinkARM.dll"].map((name) => path.join(this.config.installDir, name)).find((candidate) => fs.existsSync(candidate));
    if (process.platform !== "win32" || !fs.existsSync(helper) || !dll || !/^\d+$/.test(this.config.serialNumber ?? "")) {
      return {
        success: false,
        rawOutput: "",
        output: "",
        error: "non-intrusive memory access requires the bundled helper, an explicit numeric Probe serial, and a configured J-Link DLL directory",
        errorCode: ProbeErrorCode.NON_INTRUSIVE_READ_UNAVAILABLE,
        suggestedAction: "Configure target_configure with an explicit J-Link executable path from the installed SEGGER directory.",
        writeIssued: writeBytes ? false : undefined,
        stateUnknown: false,
      };
    }
    const args = [
      writeBytes ? "write-ram-probe" : "read-ram-probe",
      "--dll", dll,
      "--device", this.config.device,
      "--interface", this.config.interface,
      "--serial", this.config.serialNumber!,
      "--speed", String(this.config.speed),
      "--address", `0x${address.toString(16)}`,
      "--size", String(length),
      "--access-size", String(accessSize),
    ];
    if (writeBytes) args.push("--bytes-hex", writeBytes.toString("hex"));
    else args.push("--samples", "1", "--interval-ms", "0");
    if (transaction) {
      args.push(
        "--capture-old", String(transaction.captureOld),
        "--verify-reads", String(transaction.verifyReads),
        "--verify-interval-ms", String(transaction.verifyIntervalMs),
        "--verify-duration-ms", String(transaction.verifyDurationMs),
        "--restore", String(transaction.restore),
        "--expected-target-state", transaction.expectedTargetState,
      );
    }
    const transactionTimeoutMs = transaction
      ? Math.min(70_000, Math.max(30_000, Math.max(transaction.verifyDurationMs, transaction.verifyReads * transaction.verifyIntervalMs) + 10_000))
      : 30_000;
    return new Promise<CommandResult>((resolveResult) => {
      const proc = this.spawnProcess(helper, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let processError: Error | undefined;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        void terminateChildProcess(proc, { terminateWaitMs: 1_000 });
      }, transactionTimeoutMs);
      timeout.unref();
      proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
      proc.on("error", (error) => { processError = error; });
      proc.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (timedOut) {
          resolveResult({ success: false, rawOutput: stdout, output: "", stderr, error: "non-intrusive J-Link memory helper timed out", errorCode: ProbeErrorCode.TIMEOUT, exitCode: code, exitSignal: signal, writeIssued: writeBytes ? true : undefined, stateUnknown: true });
          return;
        }
        if (processError || code !== 0) {
          resolveResult({ success: false, rawOutput: stdout, output: "", stderr, error: processError?.message ?? `memory helper exited ${String(code)}`, errorCode: ProbeErrorCode.NON_INTRUSIVE_READ_UNAVAILABLE, exitCode: code, exitSignal: signal, writeIssued: writeBytes ? !processError : undefined, stateUnknown: !processError });
          return;
        }
        let response: {
          status?: string;
          errorCode?: string;
          reason?: string;
          readFailed?: boolean;
          probeSerial?: number;
          targetWasHaltedRaw?: number;
          targetWasHaltedAfterOperationRaw?: number;
          targetWasHaltedAfterReadRaw?: number;
          targetWritten?: boolean;
          writeFailed?: boolean;
          writeReturnCode?: number;
          writeIssued?: boolean;
          memoryCacheDisabled?: boolean;
          closeFailed?: boolean;
          stateUnknown?: boolean;
          samples?: Array<{ valid?: boolean; bytes?: string }>;
        };
        try {
          response = JSON.parse(stdout.trim()) as typeof response;
        } catch (error) {
          resolveResult({ success: false, rawOutput: stdout, output: "", stderr, error: `memory helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, errorCode: ProbeErrorCode.STATE_DESYNC, exitCode: code, exitSignal: signal, writeIssued: writeBytes ? true : undefined, stateUnknown: true });
          return;
        }
        const operationFailed = writeBytes
          ? response.status !== "ok" || response.writeFailed || response.closeFailed || response.targetWritten !== true
            || response.memoryCacheDisabled !== true
          : response.status !== "ok" || response.readFailed || !response.samples?.[0]?.valid
            || response.memoryCacheDisabled !== true;
        if (operationFailed) {
          const identityFailure = response.errorCode === "JLINK_PROBE_IDENTITY_MISMATCH" || response.errorCode === "JLINK_SELECT_SN_FAILED";
          const fallback = response.memoryCacheDisabled !== true
            ? "memory helper did not prove that J-Link DLL caching was disabled"
            : writeBytes ? "JLINKARM_WriteMem failed" : "JLINKARM_ReadMem failed";
          resolveResult({ success: false, rawOutput: stdout, output: "", stderr, error: response.reason ?? response.errorCode ?? fallback, errorCode: identityFailure ? ProbeErrorCode.PROBE_IDENTITY_MISMATCH : ProbeErrorCode.TARGET_UNREACHABLE, exitCode: code, exitSignal: signal, writeIssued: writeBytes ? response.writeIssued === true : false, stateUnknown: response.stateUnknown ?? true });
          return;
        }
        if (response.probeSerial !== Number(this.config.serialNumber)) {
          resolveResult({ success: false, rawOutput: stdout, output: "", stderr, error: "memory helper connected to a different J-Link serial", errorCode: ProbeErrorCode.PROBE_IDENTITY_MISMATCH, exitCode: code, exitSignal: signal, writeIssued: false, stateUnknown: true });
          return;
        }
        const before = response.targetWasHaltedRaw;
        const after = response.targetWasHaltedAfterOperationRaw ?? response.targetWasHaltedAfterReadRaw;
        if ((before !== 0 && before !== 1) || (after !== 0 && after !== 1)) {
          resolveResult({ success: false, rawOutput: stdout, output: "", stderr, error: "target run state could not be proven around non-intrusive memory access", errorCode: ProbeErrorCode.STATE_DESYNC, exitCode: code, exitSignal: signal, writeIssued: writeBytes ? response.writeIssued === true : false, stateUnknown: true });
          return;
        }
        if (before !== after) {
          resolveResult({ success: false, rawOutput: stdout, output: "", stderr, error: `memory access changed target run state (${before === 1 ? "halted" : "running"} -> ${after === 1 ? "halted" : "running"})`, errorCode: ProbeErrorCode.HIDDEN_STATE_CHANGE, exitCode: code, exitSignal: signal, writeIssued: writeBytes ? response.writeIssued === true : false, stateUnknown: false });
          return;
        }
        if (writeBytes) {
          resolveResult({
            success: true,
            rawOutput: stdout,
            output: `wrote ${writeBytes.length} bytes at 0x${address.toString(16)}`,
            stderr,
            exitCode: code,
            exitSignal: signal,
            writeIssued: true,
            stateUnknown: false,
          });
          return;
        }
        const bytesHex = response.samples![0].bytes ?? "";
        if (!new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(bytesHex)) {
          resolveResult({ success: false, rawOutput: stdout, output: "", stderr, error: "memory helper returned an invalid byte count", errorCode: ProbeErrorCode.STATE_DESYNC, exitCode: code, exitSignal: signal, stateUnknown: true });
          return;
        }
        const bytes = bytesHex.match(/../g) ?? [];
        resolveResult({
          success: true,
          rawOutput: stdout,
          output: `${address.toString(16).padStart(8, "0")} = ${bytes.join(" ")}`,
          stderr,
          exitCode: code,
          exitSignal: signal,
        });
      });
    });
  }

  /**
   * Read-only reachability check. It never resets, halts, changes speed,
   * stops a session, or retries under reset.
   */
  async preflight(): Promise<CommandResult | null> {
    const result = await this.execRaw([`mem 0xE000EDF0, 4`]);
    if (!result.success) {
      return {
        success: false,
        rawOutput: result.rawOutput,
        output: "Preflight failed: cannot read DHCSR. Target may be unreachable.",
        error: result.error,
        errorCode: ProbeErrorCode.TARGET_UNREACHABLE,
        lastSuccessfulStage: "probe_connected",
        suggestedAction: "Try reset with halt, reduce SWD speed, or power cycle.",
      };
    }
    this.setState(ProbeState.TARGET_ATTACHED);
    return null;
  }

  // ── ProbeBackend implementation ──────────────────────────────────
  // Public methods execute only the requested command. The MCP execution
  // layer owns validation, serialization, and read-only observations.

  async getDeviceInfo(): Promise<CommandResult> {
    return this.executeDirect(["regs"]);
  }
  async halt(): Promise<CommandResult> {
    return this.executeDirect(["halt"]);
  }
  async resume(): Promise<CommandResult> {
    return this.executeDirect(["go"]);
  }
  async reset(halt = false): Promise<CommandResult> {
    return this.executeDirect(halt ? ["r", "halt"] : ["r", "go"]);
  }
  async step(): Promise<CommandResult> {
    return this.executeDirect(["s"]);
  }

  async readMemory(address: number, length: number, accessSize: 1 | 2 | 4 = 1): Promise<CommandResult> {
    if (length % accessSize !== 0) return { success: false, rawOutput: "", output: "", error: "memory read length is unaligned", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    return this.accessMemoryNonIntrusive(address, length, accessSize);
  }
  async writeMemory(address: number, value: number): Promise<CommandResult> {
    const bytes = Buffer.allocUnsafe(4);
    bytes.writeUInt32LE(value >>> 0);
    return this.accessMemoryNonIntrusive(address, bytes.length, 4, bytes);
  }
  async writeMemoryBytes(address: number, bytes: Buffer, accessSize: 1 | 2 | 4): Promise<CommandResult> {
    if (bytes.length === 0 || bytes.length % accessSize !== 0 || address % accessSize !== 0) {
      return { success: false, rawOutput: "", output: "", error: "memory write is empty or unaligned", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    }
    return this.accessMemoryNonIntrusive(address, bytes.length, accessSize, bytes);
  }
  async writeMemoryTransaction(input: ProbeMemoryTransactionInput): Promise<ProbeMemoryTransactionResult> {
    const command = await this.accessMemoryNonIntrusive(input.address, input.bytes.length, input.accessSize, input.bytes, input);
    let response: {
      oldBytes?: string;
      readbacks?: Array<{ bytes?: string; atUnixMs?: number }>;
      verificationStartedAtUnixMs?: number;
      verificationEndedAtUnixMs?: number;
      restoreIssued?: boolean;
      restoreReadbackBytes?: string;
      restoreReadFailed?: boolean;
      restoreWriteFailed?: boolean;
      targetWasHaltedRaw?: number;
      targetWasHaltedAfterOperationRaw?: number;
    } = {};
    try { response = JSON.parse(command.rawOutput.trim()) as typeof response; }
    catch { /* command retains the authoritative transport failure */ }
    const oldBytes = transactionBytes(response.oldBytes, input.bytes.length);
    const readbacks = Array.isArray(response.readbacks)
      ? response.readbacks.map(({ bytes }) => transactionBytes(bytes, input.bytes.length)).filter((bytes): bytes is Buffer => Boolean(bytes))
      : [];
    const readbackObservedAt = Array.isArray(response.readbacks)
      ? response.readbacks.flatMap(({ bytes, atUnixMs }) => transactionBytes(bytes, input.bytes.length) && transactionTimestamp(atUnixMs) ? [transactionTimestamp(atUnixMs)!] : [])
      : [];
    const restoreReadback = transactionBytes(response.restoreReadbackBytes, input.bytes.length);
    return {
      command,
      ...(oldBytes ? { oldBytes } : {}),
      readbacks,
      ...(readbackObservedAt.length === readbacks.length ? { readbackObservedAt } : {}),
      ...(transactionTimestamp(response.verificationStartedAtUnixMs) ? { verificationStartedAt: transactionTimestamp(response.verificationStartedAtUnixMs)! } : {}),
      ...(transactionTimestamp(response.verificationEndedAtUnixMs) ? { verificationEndedAt: transactionTimestamp(response.verificationEndedAtUnixMs)! } : {}),
      ...(restoreReadback ? { restoreReadback } : {}),
      restoreIssued: response.restoreIssued === true,
      restoreVerified: response.restoreIssued === true && response.restoreWriteFailed !== true && response.restoreReadFailed !== true
        && Boolean(oldBytes && restoreReadback?.equals(oldBytes)),
      ...(response.targetWasHaltedRaw === 0 || response.targetWasHaltedRaw === 1
        ? { targetStateBefore: response.targetWasHaltedRaw === 1 ? "halted" as const : "running" as const }
        : {}),
      ...(response.targetWasHaltedAfterOperationRaw === 0 || response.targetWasHaltedAfterOperationRaw === 1
        ? { targetStateAfter: response.targetWasHaltedAfterOperationRaw === 1 ? "halted" as const : "running" as const }
        : {}),
    };
  }
  async readMemoryForExclusiveOwner(owner: string, address: number, length: number): Promise<CommandResult> {
    if (this.getExclusiveOwner() !== owner) return this.ownerMemoryRejected(owner);
    return this.acquireLock(() => this.execRaw([`mem 0x${address.toString(16)}, ${length}`]));
  }
  async writeMemoryForExclusiveOwner(owner: string, address: number, bytes: Buffer, accessSize: 1 | 2 | 4): Promise<CommandResult> {
    if (this.getExclusiveOwner() !== owner) return this.ownerMemoryRejected(owner);
    const commands: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += accessSize) {
      const chunk = bytes.subarray(offset, offset + accessSize);
      if (chunk.length !== accessSize) return { success: false, rawOutput: "", output: "unaligned write byte count", error: "unaligned write byte count" };
      const value = accessSize === 1 ? chunk.readUInt8(0) : accessSize === 2 ? chunk.readUInt16LE(0) : chunk.readUInt32LE(0);
      commands.push(`w${accessSize} 0x${(address + offset).toString(16)}, 0x${value.toString(16)}`);
    }
    return this.acquireLock(() => this.execRaw(commands));
  }

  async readAllRegisters(): Promise<CommandResult> {
    return this.executeDirect(["regs"]);
  }
  async readRegister(name: string): Promise<CommandResult> {
    if (!/^(?:r(?:1[0-5]|[0-9])|pc|sp|lr|xpsr|control|primask|basepri|faultmask|msp|psp|msplim|psplim)$/i.test(name)) {
      return { success: false, rawOutput: "", output: "unknown or non-core register", error: "unknown or non-core register", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    }
    return this.executeDirect([`rreg ${name}`]);
  }
  async writeCoreRegister(name: string, value: number): Promise<CommandResult> {
    if (!/^(?:r(?:1[0-5]|[0-9])|pc|sp|lr|xpsr|control|primask|basepri|faultmask|msp|psp|msplim|psplim)$/i.test(name)) {
      return { success: false, rawOutput: "", output: "unknown or non-core register", error: "unknown or non-core register", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    }
    return this.executeDirect([`wreg ${name}, 0x${value.toString(16)}`]);
  }

  override getConnectionGeneration(): number { return this.connectionGeneration; }

  async flash(filePath: string, baseAddress?: number): Promise<CommandResult> {
    if (!filePath || /[\0\r\n\"]/.test(filePath)) return { success: false, rawOutput: "", output: "", error: "invalid flash path", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    const address = path.extname(filePath).toLowerCase() === ".bin" ? baseAddress : 0;
    if (address === undefined) return { success: false, rawOutput: "", output: "", error: "raw BIN flash requires a base address", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    return this.executeDirect([`loadfile "${filePath}" 0x${address.toString(16)} noreset`], 180000);
  }
  async erase(): Promise<CommandResult> {
    return this.executeDirect(["erase 0 0 noreset"]);
  }

  async setBreakpoint(address: number): Promise<CommandResult> {
    return this.executeDirect([`SetBP 0x${address.toString(16)}`]);
  }
  async clearBreakpoints(): Promise<CommandResult> {
    return this.executeDirect(["ClrBP"]);
  }

  async executeRaw(commands: string[]): Promise<CommandResult> {
    return this.executeDirect(commands);
  }

  private async executeDirect(commands: string[], timeoutMs = 30000): Promise<CommandResult> {
    if (!this.beginHardwareOperation()) {
      return { success: false, rawOutput: "", output: `Probe is exclusively owned by ${this.getExclusiveOwner()}`, error: "Capture owns the probe", errorCode: ProbeErrorCode.PROBE_BUSY };
    }
    try {
      return await this.acquireLock(() => this.execRaw(commands, timeoutMs));
    } finally {
      this.endHardwareOperation();
    }
  }

  // ── GDB Server ───────────────────────────────────────────────────

  private gdbServerArgs(): string[] {
    const args = [
      "-device", this.config.device,
      "-if", this.config.interface,
      "-speed", String(this.config.speed),
      "-port", String(this.config.gdbPort),
      "-RTTTelnetPort", String(this.config.rttTelnetPort),
      "-SWOPort", String(this.config.swoTelnetPort),
      "-vd", "-noreset", "-nohalt", "-noir", "-LocalhostOnly", "1", "-nosinglerun", "-NoGui", "1",
    ];
    if (this.config.serialNumber) args.push("-select", `USB=${this.config.serialNumber}`);
    return args;
  }

  async startGDBServer(): Promise<{ success: boolean; message: string }> {
    if (!this.beginHardwareOperation()) return { success: false, message: `Probe is exclusively owned by ${this.getExclusiveOwner()}` };
    try {
      if (this.processManager.get(GDB_SERVER_PROCESS)) {
        return { success: true, message: "GDB Server is already running" };
      }

      const args = this.gdbServerArgs();

      try {
        this.connectionGeneration += 1;
        const managed = this.processManager.spawn(GDB_SERVER_PROCESS, this.gdbServerExe, args);
        managed.process.stdout?.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n").filter(Boolean)) {
            log(`[GDB Server] ${line}`);
            this.gdbOutputBuffer.push(line);
            if (this.gdbOutputBuffer.length > 1000) this.gdbOutputBuffer.shift();
          }
        });
        managed.process.stderr?.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n").filter(Boolean)) {
            logError(`[GDB Server] ${line}`);
            this.gdbOutputBuffer.push(`[ERR] ${line}`);
          }
        });
        const readiness = await waitForGdbServerReady(managed.process, 15_000);
        if (!readiness.ready || !this.processManager.get(GDB_SERVER_PROCESS)) {
          await this.processManager.killAndWait(GDB_SERVER_PROCESS);
          this.setState(ProbeState.PROBE_CONNECTED);
          return { success: false, message: `GDB Server did not become ready: ${readiness.message}` };
        }
        this.setState(ProbeState.GDB_RUNNING);
        return { success: true, message: `GDB Server started on port ${this.config.gdbPort}, RTT telnet on port ${this.config.rttTelnetPort}` };
      } catch (err) {
        logError("Failed to start GDB Server", err);
        return { success: false, message: `Failed to start GDB Server: ${err instanceof Error ? err.message : String(err)}` };
      }
    } finally {
      this.endHardwareOperation();
    }
  }

  async stopGDBServer(): Promise<{ success: boolean; message: string }> {
    if (this.getExclusiveOwner()) return { success: false, message: `Probe is exclusively owned by ${this.getExclusiveOwner()}` };
    const stopped = await this.processManager.killAndWait(GDB_SERVER_PROCESS);
    if (!stopped.exited) return { success: false, message: "GDB Server did not exit after termination was requested" };
    this.gdbOutputBuffer = [];
    this.rttConnected = false;
    if (stopped.found) this.setState(ProbeState.PROBE_CONNECTED);
    return { success: true, message: stopped.found ? "GDB Server stopped" : "GDB Server was not running" };
  }

  isGDBServerRunning(): boolean { return !!this.processManager.get(GDB_SERVER_PROCESS); }

  getGDBServerStatus(): GDBServerInfo {
    const managed = this.processManager.get(GDB_SERVER_PROCESS);
    const processId = managed?.process.pid;
    return {
      running: Boolean(managed),
      processId: Number.isSafeInteger(processId) && Number(processId) > 0 ? processId : undefined,
      gdbPort: this.config.gdbPort,
      rttTelnetPort: this.config.rttTelnetPort,
    };
  }

  getGDBServerOutput(lines = 50): string[] { return this.gdbOutputBuffer.slice(-lines); }

  // ── Device configuration ─────────────────────────────────────────

  isDeviceConfigured(): boolean {
    return !!this.config.device && this.config.device !== "Unspecified";
  }

  getDeviceName(): string { return this.config.device; }

  setDevice(device: string): void {
    log(`[J-Link] Device set to: ${device}`);
    this.config.device = device;
  }

  async listDevices(): Promise<CommandResult> {
    if (!this.beginHardwareOperation()) {
      return { success: false, rawOutput: "", output: "Probe is exclusively owned by capture", error: "Capture owns the probe", errorCode: ProbeErrorCode.PROBE_BUSY };
    }
    // Run ShowEmuList without specifying a device to see connected probes
    const args = ["-NoGui", "1"];
    return new Promise<CommandResult>((resolve) => {
      const proc = this.spawnProcess(this.jlinkExe, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      let settled = false;
      let timedOut = false;
      let processError: Error | undefined;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(result);
      };
      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.stdin?.write("ShowEmuList\nexit\n");
      proc.stdin?.end();
      proc.on("error", (err) => {
        processError = err;
      });
      proc.on("close", (code, signal) => {
        finish(timedOut
          ? { success: false, rawOutput: stdout, output: stripBoilerplate(stdout), stderr, error: "J-Link discovery timed out; process close was observed", errorCode: ProbeErrorCode.TIMEOUT, exitCode: code, exitSignal: signal }
          : { success: code === 0 && !processError, rawOutput: stdout, output: stripBoilerplate(stdout), stderr, error: processError ? `Failed to run JLinkExe: ${processError.message}` : stderr || undefined, errorCode: processError ? ProbeErrorCode.PROBE_NOT_FOUND : undefined, exitCode: code, exitSignal: signal });
      });
      timeout = setTimeout(() => {
        timedOut = true;
        void terminateChildProcess(proc, { terminateWaitMs: 1_000 });
      }, 10_000);
    }).finally(() => this.endHardwareOperation());
  }

  // ── RTT ──────────────────────────────────────────────────────────

  supportsRTT(): boolean { return true; }
  getRTTPort(): number { return this.config.rttTelnetPort; }

  getCaptureConfig(): CaptureProbeConfig {
    return {
      gdbServerPath: this.gdbServerExe,
      jlinkExePath: this.jlinkExe,
      device: this.config.device,
      interface: this.config.interface,
      speed: this.config.speed,
      serialNumber: this.config.serialNumber,
      gdbPort: this.config.gdbPort,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  dispose(): void {
    this.processManager.kill(GDB_SERVER_PROCESS);
    this.setState(ProbeState.DISCONNECTED);
  }
}

function transactionBytes(value: string | undefined, expectedLength: number): Buffer | undefined {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${expectedLength * 2}}$`).test(value)) return undefined;
  return Buffer.from(value, "hex");
}

function transactionTimestamp(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function waitForGdbServerReady(processHandle: ChildProcess, timeoutMs: number): Promise<{ ready: boolean; message: string }> {
  return new Promise((resolveReady) => {
    let settled = false;
    const finish = (ready: boolean, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      processHandle.stdout?.off("data", onData);
      processHandle.off("exit", onExit);
      processHandle.off("error", onError);
      resolveReady({ ready, message });
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      if (/Waiting for (?:GDB )?connection|Listening on TCP\/IP port|Waiting for connection from GDB/i.test(text)) finish(true, "ready output observed");
    };
    const onExit = (code: number | null) => finish(false, `process exited with code ${code}`);
    const onError = (error: Error) => finish(false, error.message);
    processHandle.stdout?.on("data", onData);
    processHandle.once("exit", onExit);
    processHandle.once("error", onError);
    const timeout = setTimeout(() => finish(false, `no readiness output within ${timeoutMs}ms`), timeoutMs);
  });
}
