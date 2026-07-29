import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import { ProbeBackend, ProbeState, ProbeErrorCode, CommandResult, GDBServerInfo, CaptureProbeConfig, type ProbeCoreRegisterWriteResult, type ProbeMemoryTransactionInput, type ProbeMemoryTransactionResult, type TargetStateObservationOptions } from "./backend";
import { ProcessManager, terminateChildProcess } from "../utils/process-manager";
import { log, logError } from "../utils/logger";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { findJLinkInstallDir } from "../utils/config";

export interface JLinkConfig {
  installDir: string;
  jlinkExePath?: string;
  gdbServerExePath?: string;
  /** Test/package override; defaults to the bundled native helper. */
  memoryHelperPath?: string;
  device: string;
  gdbDevice?: string;
  interface: "SWD" | "JTAG";
  speed: number;
  serialNumber?: string;
  gdbPort: number;
  rttTelnetPort: number;
  swoTelnetPort: number;
}

const GDB_SERVER_PROCESS = "jlink-gdb-server";
export type JLinkSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
const PROBE_ONLY_RAW_COMMANDS = new Set(["showemulist", "showconf"]);

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

function fatalJLinkCommandDiagnostic(raw: string): string | undefined {
  return raw.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^(?:\*+\s*error:\s*)?verification of ramcode failed\b/i.test(line)
      || /^failed to (?:prepare for programming|download ramcode)\b/i.test(line)
      || /^\*+\s*error:\s*failed to verify\s+@\s+address\s+0x[0-9a-f]+\b/i.test(line)
      || /\bunknown command\.\s*['"]?\?['"]?\s+for help\./i.test(line));
}

function jlinkCommandResponse(raw: string, command: string): string | undefined {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const prompts = [...normalized.matchAll(/(?:^|\n)J-Link(?:\[\d+\])?>/gi)];
  const expected = command.trim().replace(/\s+/g, " ").toLowerCase();
  for (let index = 0; index < prompts.length; index += 1) {
    const start = prompts[index].index ?? 0;
    const end = prompts[index + 1]?.index ?? normalized.length;
    const section = normalized.slice(start, end).replace(/^\n/, "");
    const firstLine = section.split("\n", 1)[0];
    const promptEnd = firstLine.indexOf(">");
    if (promptEnd < 0) continue;
    const echoed = firstLine.slice(promptEnd + 1).trim().replace(/\s+/g, " ").toLowerCase();
    if (echoed === expected) return section;
  }
  return undefined;
}

function jlinkRegisterReadbackAfterWriteEcho(raw: string, token: string): string | undefined {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const registerName = token.startsWith("\"") && token.endsWith("\"") ? token.slice(1, -1) : token;
  const escaped = registerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignment = new RegExp(
    `(?:^|\\n)((?:J-Link(?:\\[\\d+\\])?>)+[ \\t]*${escaped}[ \\t]*=[ \\t]*(0x)?[0-9a-f]{1,8}\\b[^\\n]*)`,
    "gi",
  );
  let writeEchoSeen = false;
  for (const match of normalized.matchAll(assignment)) {
    if (!match[2]) writeEchoSeen = true;
    else if (writeEchoSeen) return match[1];
  }
  return undefined;
}

export class JLinkBackend extends ProbeBackend {
  readonly type = "jlink" as const;
  readonly displayName = "SEGGER J-Link";

  private config: JLinkConfig;
  private processManager: ProcessManager;
  private gdbOutputBuffer: string[] = [];

  private appendGdbOutput(line: string): void {
    this.gdbOutputBuffer.push(line);
    if (this.gdbOutputBuffer.length > 1000) this.gdbOutputBuffer.splice(0, this.gdbOutputBuffer.length - 1000);
  }
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
      gdbDevice: config.gdbDevice,
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
  private async execRaw(commands: string[], timeoutMs = 30000, options: { exitOnError?: boolean } = {}): Promise<CommandResult> {
    this.connectionGeneration += 1;
    const autoConnect = commands.length > 0
      && commands.every((command) => PROBE_ONLY_RAW_COMMANDS.has(command.trim().toLowerCase()))
      ? "0"
      : "1";
    const args = [
      "-device", this.config.device,
      "-if", this.config.interface,
      "-speed", String(this.config.speed),
      "-autoconnect", autoConnect,
      "-ExitOnError", options.exitOnError === false ? "0" : "1",
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
        const fatalDiagnostic = fatalJLinkCommandDiagnostic(`${stdout}\n${stderr}`);
        const result: CommandResult = {
          success: code === 0 && !processError && !fatalDiagnostic,
          rawOutput: stdout,
          output: stripBoilerplate(stdout),
          stderr,
          error: processError
            ? `Failed to spawn JLinkExe: ${processError.message}`
            : fatalDiagnostic
              ? `J-Link reported a fatal command diagnostic: ${fatalDiagnostic}`
              : stderr || undefined,
          exitCode: code,
          exitSignal: signal,
        };
        if (processError) result.errorCode = ProbeErrorCode.PROBE_NOT_FOUND;
        if (fatalDiagnostic) {
          result.errorCode = ProbeErrorCode.JLINK_COMMAND_FAILED;
          result.stateUnknown = true;
          result.suggestedAction = "Treat the requested J-Link operation as failed and explicitly verify target state before further target use.";
        }
        // Classify errors from output
        if (!result.success && !fatalDiagnostic) {
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

  private async accessMemoryNonIntrusive(
    address: number,
    length: number,
    accessSize: 1 | 2 | 4,
    writeBytes?: Buffer,
    transaction?: ProbeMemoryTransactionInput,
    preserveDebugStateOnClose = false,
  ): Promise<CommandResult> {
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
    if (preserveDebugStateOnClose) args.push("--preserve-debug-state-on-close", "true");
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
          debugDeinitSkipped?: boolean;
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
        const debugClosePolicyMissing = preserveDebugStateOnClose && response.debugDeinitSkipped !== true;
        const operationFailed = writeBytes
          ? response.status !== "ok" || response.writeFailed || response.closeFailed || response.targetWritten !== true
            || response.memoryCacheDisabled !== true || debugClosePolicyMissing
          : response.status !== "ok" || response.readFailed || !response.samples?.[0]?.valid
            || response.memoryCacheDisabled !== true || debugClosePolicyMissing;
        if (operationFailed) {
          const identityFailure = response.errorCode === "JLINK_PROBE_IDENTITY_MISMATCH" || response.errorCode === "JLINK_SELECT_SN_FAILED";
          const fallback = response.memoryCacheDisabled !== true
            ? "memory helper did not prove that J-Link DLL caching was disabled"
            : debugClosePolicyMissing
              ? "memory helper did not prove that close-time debug de-initialization was skipped"
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
  protected override async readTargetStateRegister(options: TargetStateObservationOptions): Promise<CommandResult> {
    return this.accessMemoryNonIntrusive(0xE000EDF0, 4, 4, undefined, undefined, options.preserveDebugStateOnClose === true);
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
    return this.executeDirect(["exec SetSkipDebugDeInit = 1", "regs"]);
  }
  async readRegister(name: string): Promise<CommandResult> {
    if (!/^(?:r(?:1[0-5]|[0-9])|pc|sp|lr|xpsr|control|primask|basepri|faultmask|msp|psp|msplim|psplim)$/i.test(name)) {
      return { success: false, rawOutput: "", output: "unknown or non-core register", error: "unknown or non-core register", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    }
    return this.executeDirect(["exec SetSkipDebugDeInit = 1", `rreg ${jlinkCoreRegisterToken(name)}`]);
  }
  async writeCoreRegister(name: string, value: number): Promise<CommandResult> {
    if (!/^(?:r(?:1[0-5]|[0-9])|pc|sp|lr|xpsr|control|primask|basepri|faultmask|msp|psp|msplim|psplim)$/i.test(name)) {
      return { success: false, rawOutput: "", output: "unknown or non-core register", error: "unknown or non-core register", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    }
    return this.executeDirect([`wreg ${jlinkCoreRegisterToken(name)}, 0x${value.toString(16)}`]);
  }

  override async writeCoreRegisterTransaction(name: string, value: number): Promise<ProbeCoreRegisterWriteResult> {
    if (!/^(?:r(?:1[0-5]|[0-9])|pc|sp|lr|xpsr|control|primask|basepri|faultmask|msp|psp|msplim|psplim)$/i.test(name)) {
      return {
        command: { success: false, rawOutput: "", output: "unknown or non-core register", error: "unknown or non-core register", errorCode: ProbeErrorCode.INVALID_ARGUMENT, writeIssued: false },
      };
    }
    if (!this.beginHardwareOperation()) {
      return {
        command: {
          success: false,
          rawOutput: "",
          output: `Probe is exclusively owned by ${this.getExclusiveOwner()}`,
          error: "Capture owns the probe",
          errorCode: ProbeErrorCode.PROBE_BUSY,
          writeIssued: false,
          stateUnknown: false,
        },
      };
    }
    try {
      return await this.acquireLock(() => this.execCoreRegisterTransaction(jlinkCoreRegisterToken(name), value));
    } finally {
      this.endHardwareOperation();
    }
  }

  override getConnectionGeneration(): number { return this.connectionGeneration; }

  async flash(filePath: string, baseAddress?: number): Promise<CommandResult> {
    if (!filePath || /[\0\r\n\"]/.test(filePath)) return { success: false, rawOutput: "", output: "", error: "invalid flash path", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    const address = path.extname(filePath).toLowerCase() === ".bin" ? baseAddress : 0;
    if (address === undefined) return { success: false, rawOutput: "", output: "", error: "raw BIN flash requires a base address", errorCode: ProbeErrorCode.INVALID_ARGUMENT };
    return this.executeDirect(["r", "halt", `loadfile "${filePath}" 0x${address.toString(16)} noreset`], 180000);
  }

  override async verifyFirmware(filePath: string, baseAddress?: number): Promise<CommandResult> {
    if (!filePath || /[\0\r\n\"]/.test(filePath)) {
      return {
        success: false,
        rawOutput: "",
        output: "",
        error: "invalid firmware Verify-only path",
        errorCode: ProbeErrorCode.INVALID_ARGUMENT,
        writeIssued: false,
        stateUnknown: false,
      };
    }
    let prepared: PreparedVerifyBins;
    try {
      prepared = prepareVerifyBins(filePath, baseAddress);
    } catch (error) {
      return {
        success: false,
        rawOutput: "",
        output: "",
        error: error instanceof Error ? error.message : String(error),
        errorCode: ProbeErrorCode.INVALID_ARGUMENT,
        writeIssued: false,
        stateUnknown: false,
      };
    }
    try {
      // Commander has no generic Verify command. VerifyBin is the documented
      // read-only comparison primitive. Keep ExitOnError disabled so the final
      // halt runs after both a match and a mismatch before the session closes.
      const commands = [
        "halt",
        ...prepared.bins.map((item) => `VerifyBin "${item.path}" 0x${item.address.toString(16)}`),
        "halt",
      ];
      const result = await this.execRaw(commands, 180000, { exitOnError: false });
      const diagnostics = `${result.rawOutput}\n${result.stderr ?? ""}\n${result.error ?? ""}`;
      const failureDiagnostic = verifyOnlyFailureDiagnostic(diagnostics);
      if (failureDiagnostic) {
        return {
          ...result,
          success: false,
          error: `SEGGER VerifyBin failed: ${failureDiagnostic}`,
          errorCode: ProbeErrorCode.JLINK_COMMAND_FAILED,
          writeIssued: false,
          stateUnknown: true,
        };
      }
      const mismatch = verifyOnlyMismatchDiagnostic(diagnostics);
      return {
        ...result,
        success: mismatch ? false : result.success,
        error: mismatch ? "SEGGER VerifyBin reported a content mismatch" : result.error,
        errorCode: mismatch ? ProbeErrorCode.JLINK_VERIFY_MISMATCH : result.errorCode,
        writeIssued: false,
        stateUnknown: mismatch ? false : result.stateUnknown,
        suggestedAction: mismatch ? "The target firmware does not match the configured image." : result.suggestedAction,
      };
    } finally {
      prepared.cleanup();
    }
  }
  async erase(): Promise<CommandResult> {
    return this.executeDirect(["r", "halt", "erase 0 0 noreset"]);
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

  private async execCoreRegisterTransaction(token: string, value: number, timeoutMs = 30000): Promise<ProbeCoreRegisterWriteResult> {
    const writeCommand = `wreg ${token}, 0x${value.toString(16)}`;
    const readbackCommand = `rreg ${token}`;
    let result: CommandResult;
    try {
      // J-Link V8.84 can buffer all Commander output while an interactive
      // Windows stdin pipe remains open. Submit the complete transaction and
      // close stdin, matching the batch path used by proven direct operations.
      // Commander normally de-initializes the debug unit when the connection
      // closes. Preserve the verified core-register state for the next attach;
      // SetRestartOnClose=0 in execRaw independently keeps the target halted.
      result = await this.execRaw([
        "exec SetSkipDebugDeInit = 1",
        writeCommand,
        readbackCommand,
      ], timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start J-Link core-register transaction";
      return {
        command: {
          success: false,
          rawOutput: "",
          output: "",
          error: message,
          errorCode: ProbeErrorCode.PROBE_NOT_FOUND,
          writeIssued: false,
          stateUnknown: false,
        },
      };
    }

    const writeRaw = jlinkCommandResponse(result.rawOutput, writeCommand);
    const readbackRaw = jlinkCommandResponse(result.rawOutput, readbackCommand)
      ?? jlinkRegisterReadbackAfterWriteEcho(result.rawOutput, token);
    const fatalDiagnostic = fatalJLinkCommandDiagnostic(`${result.rawOutput}\n${result.stderr ?? ""}`);
    const knownPreDispatchFailure = result.errorCode === ProbeErrorCode.PROBE_NOT_FOUND
      && /^Failed to spawn JLinkExe:/i.test(result.error ?? "");
    // The complete stdin script (including wreg) is closed before waiting.
    // A timeout or unclassified vendor failure is therefore an uncertain
    // mutation unless the vendor proved it failed during attach/spawn.
    const writeIssued = !knownPreDispatchFailure;
    const writeCompleted = !fatalDiagnostic
      && Boolean(writeRaw)
      && (Boolean(readbackRaw) || result.success);
    const command: CommandResult = result.success || writeCompleted
      ? {
        ...result,
        success: true,
        rawOutput: writeRaw ?? result.rawOutput,
        output: stripBoilerplate(writeRaw ?? result.rawOutput),
        error: undefined,
        errorCode: undefined,
        writeIssued: true,
        stateUnknown: false,
      }
      : {
        ...result,
        success: false,
        rawOutput: writeRaw ?? result.rawOutput,
        output: stripBoilerplate(writeRaw ?? result.rawOutput),
        writeIssued,
        stateUnknown: Boolean(writeIssued || result.stateUnknown),
      };

    if (!writeIssued) return { command };

    const readback: CommandResult = result.success && readbackRaw && !fatalDiagnostic
      ? {
        ...result,
        success: true,
        rawOutput: readbackRaw,
        output: stripBoilerplate(readbackRaw),
        error: undefined,
        errorCode: undefined,
        writeIssued: true,
        stateUnknown: false,
      }
      : {
        ...result,
        success: false,
        rawOutput: readbackRaw ?? "",
        output: stripBoilerplate(readbackRaw ?? ""),
        error: result.error ?? "J-Link same-connection register readback did not complete",
        errorCode: result.errorCode ?? ProbeErrorCode.JLINK_COMMAND_FAILED,
        writeIssued: true,
        stateUnknown: true,
      };
    return { command, readback };
  }

  // ── GDB Server ───────────────────────────────────────────────────

  private gdbServerArgs(): string[] {
    const args = [
      "-device", this.config.gdbDevice ?? this.config.device,
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
            this.appendGdbOutput(line);
          }
        });
        managed.process.stderr?.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n").filter(Boolean)) {
            logError(`[GDB Server] ${line}`);
            this.appendGdbOutput(`[ERR] ${line}`);
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

interface VerifySegment {
  address: number;
  data: Buffer;
}

function verifyOnlyFailureDiagnostic(raw: string): string | undefined {
  return verifyOnlyDiagnosticLines(raw)
    .find((line) => (
      /^(?:\*+\s*)?error:/i.test(line)
      || /^(?:could not|cannot|failed to)\s+(?:read|access|connect|halt)\b/i.test(line)
      || /\bunknown command\.\s*['"]?\?['"]?\s+for help\./i.test(line)
    ) && !isVerifyOnlyMismatchLine(line));
}

function verifyOnlyMismatchDiagnostic(raw: string): boolean {
  return verifyOnlyDiagnosticLines(raw).some(isVerifyOnlyMismatchLine);
}

function verifyOnlyDiagnosticLines(raw: string): string[] {
  return raw.split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:J-Link>\s*)+/i, "").trim())
    .filter(Boolean);
}

function isVerifyOnlyMismatchLine(line: string): boolean {
  return /(?:failed to verify|verify failed)\s+@\s+address\s+0x[0-9a-f]+\b/i.test(line)
    || /contents?\s+(?:differ|do not match)\b/i.test(line);
}

interface PreparedVerifyBins {
  bins: Array<{ path: string; address: number }>;
  cleanup(): void;
}

function prepareVerifyBins(filePath: string, baseAddress?: number): PreparedVerifyBins {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".bin") {
    if (!Number.isSafeInteger(baseAddress) || baseAddress === undefined || baseAddress < 0 || baseAddress > 0xffff_ffff) {
      throw new Error("raw BIN Verify-only requires an unsigned 32-bit base address");
    }
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) throw new Error("raw BIN Verify-only requires a non-empty regular file");
    if (baseAddress + stats.size > 0x1_0000_0000) throw new Error("raw BIN data exceeds the 32-bit target address space");
    return { bins: [{ path: filePath, address: baseAddress }], cleanup: () => undefined };
  }

  const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const segments = extension === ".hex" || extension === ".ihex"
    ? parseIntelHexVerifySegments(source)
    : [".srec", ".s19", ".s28", ".s37", ".mot"].includes(extension)
      ? parseSrecVerifySegments(source)
      : undefined;
  if (!segments) throw new Error("firmware Verify-only supports Intel HEX, S-record, or raw BIN inputs only");
  if (segments.length === 0) throw new Error("firmware Verify-only input contains no data records");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jlink-verify-"));
  try {
    const bins = segments.map((segment, index) => {
      const binPath = path.join(root, `segment-${index}.bin`);
      fs.writeFileSync(binPath, segment.data, { flag: "wx" });
      fs.chmodSync(binPath, 0o400);
      return { path: binPath, address: segment.address };
    });
    return {
      bins,
      cleanup: () => {
        try { fs.rmSync(root, { recursive: true, force: true }); }
        catch (error) { logError(`J-Link Verify-only staging cleanup failed for ${root}`, error); }
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function parseSrecVerifySegments(source: string): VerifySegment[] {
  const records: VerifySegment[] = [];
  let terminationSeen = false;
  for (const line of source.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    if (terminationSeen) throw new Error("S-record contains data after its termination record");
    const match = line.match(/^S([0-9])([0-9A-Fa-f]+)$/);
    if (!match || match[2].length % 2 !== 0) throw new Error("S-record contains an invalid record");
    const type = Number(match[1]);
    if (type === 4) throw new Error("S-record type S4 is reserved");
    const bytes = Buffer.from(match[2], "hex");
    const addressBytes = [0, 1, 5, 9].includes(type) ? 2 : [2, 6, 8].includes(type) ? 3 : 4;
    if (bytes.length < addressBytes + 2 || bytes[0] !== bytes.length - 1) throw new Error("S-record length is invalid");
    if ((bytes.reduce((sum, value) => sum + value, 0) & 0xff) !== 0xff) throw new Error("S-record checksum validation failed");
    if ([1, 2, 3].includes(type)) {
      const address = bytes.subarray(1, 1 + addressBytes).readUIntBE(0, addressBytes);
      const data = bytes.subarray(1 + addressBytes, -1);
      if (address + data.length > 0x1_0000_0000) throw new Error("S-record data exceeds the 32-bit target address space");
      if (data.length > 0) records.push({ address, data: Buffer.from(data) });
    }
    if ([7, 8, 9].includes(type)) terminationSeen = true;
  }
  if (!terminationSeen) throw new Error("S-record termination record is missing");
  return mergeVerifySegments(records);
}

function parseIntelHexVerifySegments(source: string): VerifySegment[] {
  const records: VerifySegment[] = [];
  let base = 0;
  let eofSeen = false;
  for (const line of source.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    if (eofSeen || !/^:[0-9A-Fa-f]+$/.test(line) || (line.length - 1) % 2 !== 0) throw new Error("Intel HEX contains an invalid record");
    const bytes = Buffer.from(line.slice(1), "hex");
    if (bytes.length < 5 || bytes.length !== bytes[0] + 5) throw new Error("Intel HEX record length is invalid");
    if (bytes.reduce((sum, value) => (sum + value) & 0xff, 0) !== 0) throw new Error("Intel HEX checksum validation failed");
    const offset = bytes.readUInt16BE(1);
    const type = bytes[3];
    const data = bytes.subarray(4, -1);
    if (type === 0) {
      const address = base + offset;
      if (address > 0xffff_ffff || address + data.length > 0x1_0000_0000) throw new Error("Intel HEX data address exceeds the 32-bit target address space");
      if (data.length > 0) records.push({ address, data: Buffer.from(data) });
    } else if (type === 1) {
      if (data.length !== 0 || offset !== 0) throw new Error("Intel HEX EOF record is invalid");
      eofSeen = true;
    } else if (type === 2) {
      if (data.length !== 2 || offset !== 0) throw new Error("Intel HEX segment-address record is invalid");
      base = data.readUInt16BE(0) << 4;
    } else if (type === 4) {
      if (data.length !== 2 || offset !== 0) throw new Error("Intel HEX linear-address record is invalid");
      base = data.readUInt16BE(0) * 0x1_0000;
    } else if ([3, 5].includes(type)) {
      if (data.length !== 4 || offset !== 0) throw new Error("Intel HEX start-address record is invalid");
    } else {
      throw new Error(`Intel HEX record type ${type} is unsupported`);
    }
  }
  if (!eofSeen) throw new Error("Intel HEX EOF record is missing");
  return mergeVerifySegments(records);
}

function mergeVerifySegments(records: VerifySegment[]): VerifySegment[] {
  const sorted = [...records].sort((left, right) => left.address - right.address);
  const groups: Array<{ address: number; length: number; chunks: Buffer[] }> = [];
  for (const record of sorted) {
    const previous = groups.at(-1);
    if (!previous) {
      groups.push({ address: record.address, length: record.data.length, chunks: [record.data] });
      continue;
    }
    const previousEnd = previous.address + previous.length;
    if (record.address < previousEnd) throw new Error("firmware Verify-only input contains overlapping data records");
    if (record.address === previousEnd) {
      previous.chunks.push(record.data);
      previous.length += record.data.length;
    } else {
      groups.push({ address: record.address, length: record.data.length, chunks: [record.data] });
    }
  }
  return groups.map((group) => ({ address: group.address, data: Buffer.concat(group.chunks, group.length) }));
}

function jlinkCoreRegisterToken(name: string): string {
  switch (name.toUpperCase()) {
    case "PC":
    case "R15":
      return "\"R15 (PC)\"";
    case "LR":
    case "R14":
      return "R14";
    case "SP":
    case "R13":
      return "\"R13 (SP)\"";
    default:
      return name.toUpperCase();
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

const GDB_READINESS_TAIL_BYTES = 16 * 1024;
const GDB_READY_PATTERN = /Waiting for (?:GDB )?connection|Listening on TCP\/IP port|Waiting for connection from GDB/i;

export function waitForGdbServerReady(processHandle: ChildProcess, timeoutMs: number): Promise<{ ready: boolean; message: string }> {
  return new Promise((resolveReady) => {
    let settled = false;
    let stdoutTail = "";
    let stderrTail = "";
    let timeout: NodeJS.Timeout | undefined;
    const appendTail = (current: string, chunk: Buffer | string): string => {
      const bytes = Buffer.from(`${current}${chunk.toString()}`, "utf8");
      return bytes.subarray(Math.max(0, bytes.length - GDB_READINESS_TAIL_BYTES)).toString("utf8");
    };
    const diagnostics = (reason: string): string => {
      const stdout = stdoutTail.trim();
      const stderr = stderrTail.trim();
      return `${reason}; stdoutTail=${JSON.stringify(stdout)}; stderrTail=${JSON.stringify(stderr)}`;
    };
    const finish = (ready: boolean, message: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      processHandle.stdout?.off("data", onStdout);
      processHandle.stderr?.off("data", onStderr);
      processHandle.off("exit", onExit);
      processHandle.off("error", onError);
      resolveReady({ ready, message });
    };
    const onStdout = (chunk: Buffer | string) => {
      stdoutTail = appendTail(stdoutTail, chunk);
      if (GDB_READY_PATTERN.test(stdoutTail)) finish(true, "ready output observed on stdout");
    };
    const onStderr = (chunk: Buffer | string) => {
      stderrTail = appendTail(stderrTail, chunk);
      if (GDB_READY_PATTERN.test(stderrTail)) finish(true, "ready output observed on stderr");
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(false, diagnostics(`process exited with code ${code} signal ${signal ?? "none"}`));
    const onError = (error: Error) => finish(false, diagnostics(`process error: ${error.message}`));
    processHandle.stdout?.on("data", onStdout);
    processHandle.stderr?.on("data", onStderr);
    processHandle.once("exit", onExit);
    processHandle.once("error", onError);
    timeout = setTimeout(() => finish(false, diagnostics(`no readiness output within ${timeoutMs}ms`)), timeoutMs);
  });
}
