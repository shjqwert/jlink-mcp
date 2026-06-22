import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { ProbeBackend, CaptureProbeConfig } from "../probe/backend";
import { ProcessManager } from "../utils/process-manager";
import { log, logError } from "../utils/logger";
import {
  CaptureMetadata,
  CaptureState,
  CaptureSymbol,
  ProjectControlConfig,
} from "./capture-contract";
import { CaptureHelperClient, HelperResponse } from "./capture-helper-client";
import {
  BinaryHeader,
  captureTiming,
  queryCaptureFile,
  readCaptureHeader,
  readEvents,
  selectSessionArtifacts,
  writeCaptureCsv,
} from "./capture-storage";
export {
  queryCaptureFile,
  readCaptureHeader,
  selectSessionArtifacts,
  writeCaptureCsv,
} from "./capture-storage";
import {
  ElfResolution,
  RequestedCaptureSymbol,
  loadProjectControlConfig,
  resolveElfSymbols,
} from "../gdb/elf-resolver";

const captureServerProcess = "jlink-capture-gdb-server";

export interface CapturePrepareInput {
  elfFile: string;
  configFile: string;
  symbols: RequestedCaptureSymbol[];
  rateHz?: number;
  durationSec?: number;
  resetOnFailure?: boolean;
  outputDir?: string;
}

export interface CaptureQueryInput {
  sessionId: string;
  variables?: string[];
  startSec?: number;
  endSec?: number;
  buckets?: number;
}

const allowedTransitions: Record<CaptureState, CaptureState[]> = {
  idle: ["preparing"],
  preparing: ["armed", "failed"],
  armed: ["capturing", "stopped", "failed"],
  capturing: ["completed", "stopped", "failed"],
  completed: [],
  stopped: [],
  failed: [],
};

export function transitionCaptureState(current: CaptureState, next: CaptureState): CaptureState {
  if (!allowedTransitions[current].includes(next)) throw new Error(`Invalid capture state transition: ${current} -> ${next}`);
  return next;
}

export function validateRequestedSymbols(symbols: RequestedCaptureSymbol[]): void {
  if (symbols.length < 1 || symbols.length > 32) throw new Error("symbols must contain 1..32 entries");
  if (new Set(symbols.map((symbol) => symbol.name)).size !== symbols.length) throw new Error("Duplicate capture selectors are not allowed");
  const identifiers = new Set<string>();
  for (const symbol of symbols) {
    if (Buffer.byteLength(symbol.name, "utf8") > 255) throw new Error("Capture selector exceeds the 255-byte artifact limit");
    if (symbol.alias && Buffer.byteLength(symbol.alias, "utf8") > 127) throw new Error("Capture alias exceeds the 127-byte artifact limit");
    if (symbol.unit && Buffer.byteLength(symbol.unit, "utf8") > 63) throw new Error("Capture unit exceeds the 63-byte artifact limit");
    for (const identifier of [symbol.name, symbol.alias].filter((value): value is string => !!value)) {
      if (identifiers.has(identifier)) throw new Error(`Duplicate capture name or alias: ${identifier}`);
      identifiers.add(identifier);
    }
  }
}

interface Session {
  id: string;
  state: CaptureState;
  outputDir: string;
  binaryFile: string;
  metadataFile: string;
  elf: ElfResolution;
  configPath: string;
  control: ProjectControlConfig;
  probe: CaptureProbeConfig;
  probeSerial: string;
  probeModel: string;
  serverVersion: string;
  capabilities: string[];
  helper?: CaptureHelperClient;
  failures: string[];
  terminationReason: string;
}

interface NativeMetadata {
  version: 1;
  sessionId: string;
  state: "completed" | "stopped" | "failed";
  elfPath: string;
  elfSha256: string;
  configPath: string;
  device: string;
  probeModel: string;
  probeSerial: string;
  swdRateKhz: number;
  gdbServerPath: string;
  gdbServerVersion: string;
  binaryFile: string;
  terminationReason: string;
  capabilities: string;
}

async function listJLinkSerials(executable: string): Promise<{ serials: string[]; output: string }> {
  return new Promise((resolveList, rejectList) => {
    const child = spawn(executable, ["-NoGui", "1"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const timer = setTimeout(() => { child.kill(); rejectList(new Error("J-Link probe discovery timed out")); }, 10000);
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    child.once("error", (error) => { clearTimeout(timer); rejectList(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return rejectList(new Error(`J-Link probe discovery failed: ${output.trim()}`));
      const serials = [...output.matchAll(/(?:S\/N|Serial(?: number)?)\s*[:=]\s*(\d+)/gi)].map((match) => match[1]);
      resolveList({ serials: [...new Set(serials)], output });
    });
    child.stdin.write("ShowEmuList\nexit\n");
    child.stdin.end();
  });
}

export class CaptureService {
  private session: Session | null = null;
  private knownOutputDirs = new Set<string>();
  private finalizing: Promise<void> | null = null;

  constructor(
    private probe: ProbeBackend,
    private processManager: ProcessManager,
    private gdbPath: string,
  ) {
    this.knownOutputDirs.add(join(tmpdir(), "jlink-mcp-captures"));
  }

  async prepare(input: CapturePrepareInput): Promise<Record<string, unknown>> {
    if (this.session && ["preparing", "armed", "capturing"].includes(this.session.state)) throw new Error(`Capture session ${this.session.id} is already active`);
    const probe = this.probe.getCaptureConfig();
    if (!probe) throw new Error("Variable capture currently requires the J-Link backend");
    if (!this.probe.isDeviceConfigured()) throw new Error("A concrete J-Link target device must be configured before capture_prepare");
    if (this.probe.isGDBServerRunning()) throw new Error("The MCP-owned debug GDB server is running; stop it only after explicit user approval, then retry capture_prepare");
    const rateHz = input.rateHz ?? 1000;
    const durationSec = input.durationSec ?? 60;
    if (!Number.isInteger(rateHz) || rateHz < 1 || rateHz > 1000) throw new Error("rateHz must be 1..1000");
    if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 600) throw new Error("durationSec must be 1..600");
    validateRequestedSymbols(input.symbols);

    const outputDir = await prepareOutputDirectory(input.outputDir);
    this.knownOutputDirs.add(outputDir);
    const id = randomUUID();
    const prefix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}`;
    const binaryFile = join(outputDir, `${prefix}.jlcp`);
    const metadataFile = join(outputDir, `${prefix}.metadata.json`);
    const owner = `capture:${id}`;
    if (!this.probe.acquireExclusive(owner)) throw new Error(`Probe is already owned by ${this.probe.getExclusiveOwner()}`);

    let helper: CaptureHelperClient | undefined;
    try {
      const loadedConfig = await loadProjectControlConfig(input.configFile);
      const requested = buildRequestedSymbols(input.symbols, loadedConfig.config);
      const elf = await resolveElfSymbols(this.gdbPath, input.elfFile, requested);
      const resolved = new Map(elf.symbols.map((symbol) => [symbol.name, symbol]));
      validateDeclaredTypes(loadedConfig.config, resolved);

      const discovered = await listJLinkSerials(probe.jlinkExePath);
      const serial = selectProbeSerial(probe.serialNumber, discovered.serials);

      this.session = {
        id,
        state: transitionCaptureState("idle", "preparing"),
        outputDir,
        binaryFile,
        metadataFile,
        elf,
        configPath: loadedConfig.path,
        control: loadedConfig.config,
        probe,
        probeSerial: serial,
        probeModel: "J-Link (model pending server identity)",
        serverVersion: "unknown",
        capabilities: [],
        failures: [],
        terminationReason: "",
      };

      const server = await this.startCaptureServer(probe, serial);
      helper = new CaptureHelperClient(this.processManager, (type, payload) => void this.handleHelperEvent(type, payload));
      this.session.helper = helper;
      await helper.start();
      const response = await helper.request("prepare", {
        host: "127.0.0.1",
        port: probe.gdbPort,
        outputFile: binaryFile,
        rateHz,
        durationSec,
        preStartMs: loadedConfig.config.preStartMs,
        postStopMs: loadedConfig.config.postStopMs,
        resetOnFailure: input.resetOnFailure ?? false,
        symbols: input.symbols.map((symbol) => resolved.get(symbol.name)),
        ramRanges: elf.ramRanges,
        flashSections: elf.flashSections.map((section) => ({ address: section.start, dataHex: section.dataHex })),
        control: helperControlPayload(loadedConfig.config, resolved),
      }, 120000);
      const identity = validateServerIdentity([...server.output, discovered.output], String(response.targetStatus ?? ""), probe.device, serial);
      this.session.probeModel = identity.model;
      this.session.serverVersion = identity.version;
      this.session.capabilities = String(response.capabilities ?? "").split(";").filter(Boolean);
      await helper.request("metadata", {
        version: 1,
        sessionId: id,
        elfPath: elf.elfPath,
        elfSha256: elf.elfSha256,
        configPath: loadedConfig.path,
        device: probe.device,
        probeModel: identity.model,
        probeSerial: serial,
        swdRateKhz: probe.speed,
        gdbServerPath: probe.gdbServerPath,
        gdbServerVersion: identity.version,
      });
      this.session.state = transitionCaptureState(this.session.state, "armed");
      return {
        sessionId: id,
        state: "armed",
        calibration: response.calibration,
        probe: { model: identity.model, serial, voltage: identity.voltage },
        target: { device: probe.device, running: true },
        elfSha256: elf.elfSha256,
        resetOnFailure: input.resetOnFailure ?? false,
        warning: "Motor start remains forbidden until the user explicitly requests it in this current session.",
      };
    } catch (error) {
      if (helper && this.session?.state === "preparing") {
        try { await helper.request("abort_prepare", { reason: "node_preflight_failed" }, 5000); } catch { /* no reset/write path */ }
      }
      await helper?.close(false);
      this.processManager.kill(captureServerProcess);
      this.probe.releaseExclusive(owner);
      if (this.session?.id === id) {
        if (this.session.state === "preparing") this.session.state = transitionCaptureState(this.session.state, "failed");
        this.session.failures.push(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async start(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId, ["armed"]);
    const status = await session.helper!.request("start", {});
    session.state = transitionCaptureState(session.state, "capturing");
    return { sessionId, ...status };
  }

  async status(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId);
    if (session.helper && ["armed", "capturing"].includes(session.state)) {
      const status = await session.helper.request("status", {});
      if (typeof status.state === "string" && status.state !== session.state) session.state = transitionCaptureState(session.state, status.state as CaptureState);
      return { sessionId, ...status };
    }
    return { sessionId, state: session.state, terminationReason: session.terminationReason, binaryFile: session.binaryFile };
  }

  async stop(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId, ["armed", "capturing"]);
    const status = await session.helper!.request("stop", {}, 30000);
    await this.finalizeSession(session, status);
    return { sessionId, ...status };
  }

  async control(sessionId: string, command: "start" | "stop"): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId, command === "start" ? ["capturing"] : ["armed", "capturing"]);
    const status = await session.helper!.request("control", { command }, 30000);
    if (typeof status.state === "string" && status.state !== session.state) session.state = transitionCaptureState(session.state, status.state as CaptureState);
    if (["completed", "stopped", "failed"].includes(session.state)) await this.finalizeSession(session, status);
    return { sessionId, ...status };
  }

  async query(input: CaptureQueryInput): Promise<Record<string, unknown>> {
    const session = await this.findTerminalSession(input.sessionId);
    return { sessionId: input.sessionId, ...await queryCaptureFile(session.binaryFile, input) };
  }

  async export(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.findTerminalSession(sessionId);
    const header = await readCaptureHeader(session.binaryFile);
    const stem = session.binaryFile.slice(0, -extname(session.binaryFile).length);
    const csvFile = `${stem}.csv`;
    const jsonFile = `${stem}.json`;
    await access(session.binaryFile);
    let csvCreated = false;
    let jsonCreated = false;
    try {
      await writeCaptureCsv(session.binaryFile, csvFile);
      csvCreated = true;
      const metadata = await this.buildMetadata(session, header);
      await writeFile(jsonFile, JSON.stringify(metadata, null, 2), { encoding: "utf8", flag: "wx" });
      jsonCreated = true;
      return { sessionId, csvFile, jsonFile, frames: header.frameCount.toString() };
    } catch (error) {
      if (csvCreated) await rm(csvFile, { force: true });
      if (jsonCreated) await rm(jsonFile, { force: true });
      throw error;
    }
  }

  async list(outputDir?: string): Promise<Array<Record<string, unknown>>> {
    const directory = outputDir ? await requireExistingAbsoluteDirectory(outputDir) : await prepareOutputDirectory(undefined);
    this.knownOutputDirs.add(directory);
    const entries = await readdir(directory);
    const results: Array<Record<string, unknown>> = [];
    const listed = new Set<string>();
    for (const name of entries.filter((entry) => entry.endsWith(".metadata.json"))) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, name), "utf8")) as CaptureMetadata;
        if (!metadata.sessionId || !metadata.binaryFile) continue;
        if (!selectSessionArtifacts([name], metadata.sessionId).length) continue;
        const binaryFile = await realpath(metadata.binaryFile);
        if (dirname(binaryFile).toLowerCase() !== directory.toLowerCase()) continue;
        results.push({ sessionId: metadata.sessionId, state: metadata.state, binaryFile, terminationReason: metadata.terminationReason });
        listed.add(metadata.sessionId);
      } catch { /* externally removed or invalid capture is not listed */ }
    }
    for (const name of entries.filter((entry) => entry.endsWith(".native.json"))) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, name), "utf8")) as NativeMetadata;
        if (!validNativeMetadata(metadata) || listed.has(metadata.sessionId) || !selectSessionArtifacts([name], metadata.sessionId).length) continue;
        const binaryFile = await realpath(metadata.binaryFile);
        if (dirname(binaryFile).toLowerCase() !== directory.toLowerCase()) continue;
        await readCaptureHeader(binaryFile);
        results.push({ sessionId: metadata.sessionId, state: metadata.state, binaryFile, terminationReason: metadata.terminationReason, recoveredFromNativeSidecar: true });
      } catch { /* invalid/incomplete sidecar is not listed */ }
    }
    return results;
  }

  async delete(sessionId: string): Promise<Record<string, unknown>> {
    if (!isSessionId(sessionId)) throw new Error("capture_delete requires one exact session UUID");
    if (this.session?.id === sessionId && ["preparing", "armed", "capturing"].includes(this.session.state)) throw new Error("Active capture sessions cannot be deleted");
    for (const directory of this.knownOutputDirs) {
      let entries: string[];
      try { entries = await readdir(directory); } catch { continue; }
      const names = selectSessionArtifacts(entries, sessionId);
      if (names.length === 0) continue;
      for (const name of names) await rm(join(directory, name));
      if (this.session?.id === sessionId) this.session = null;
      return { sessionId, deleted: names.sort() };
    }
    throw new Error(`Capture session not found: ${sessionId}`);
  }

  async dispose(): Promise<void> {
    await this.session?.helper?.close(true);
    await new Promise<void>((resolveReady) => setImmediate(resolveReady));
    if (this.finalizing) await this.finalizing;
    this.processManager.kill(captureServerProcess);
    if (this.session) this.probe.releaseExclusive(`capture:${this.session.id}`);
  }

  private requireSession(id: string, states?: CaptureState[]): Session {
    if (!this.session || this.session.id !== id) throw new Error(`Unknown capture session: ${id}`);
    if (states && !states.includes(this.session.state)) throw new Error(`Operation is invalid in capture state ${this.session.state}`);
    return this.session;
  }

  private async startCaptureServer(config: CaptureProbeConfig, serial: string): Promise<{ output: string[] }> {
    const args = [
      "-device", config.device,
      "-if", config.interface,
      "-speed", String(config.speed),
      "-port", String(config.gdbPort),
      "-vd", "-nohalt", "-noir", "-LocalhostOnly", "1", "-singlerun", "-NoGui",
      "-select", `USB=${serial}`,
    ];
    const managed = this.processManager.spawn(captureServerProcess, config.gdbServerPath, args);
    const output: string[] = [];
    const collector = () => {
      let pending = "";
      return (data: Buffer) => {
        const lines = (pending + data.toString()).split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          output.push(line);
          log(`[Capture GDB Server] ${line}`);
        }
      };
    };
    managed.process.stdout?.on("data", collector());
    managed.process.stderr?.on("data", collector());
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`J-Link GDB Server startup timed out:\n${output.join("\n")}`)), 15000);
      const poll = setInterval(() => {
        if (output.some((line) => /^Connected to target$|Waiting for GDB connection|GDB Server.*ready/i.test(line))) {
          clearInterval(poll); clearTimeout(timeout); resolveReady();
        }
        if (output.some((line) => /cannot connect|failed|no J-Link|already in use/i.test(line))) {
          clearInterval(poll); clearTimeout(timeout); rejectReady(new Error(`J-Link GDB Server rejected capture:\n${output.join("\n")}`));
        }
      }, 50);
      managed.process.once("exit", (code) => { clearInterval(poll); clearTimeout(timeout); rejectReady(new Error(`J-Link GDB Server exited with code ${code}:\n${output.join("\n")}`)); });
    });
    return { output };
  }

  private async handleHelperEvent(type: string, payload: HelperResponse): Promise<void> {
    if (!this.session) return;
    if (type === "capture_complete") {
      await new Promise<void>((resolveReady) => setImmediate(resolveReady));
      try { await this.finalizeSession(this.session, payload); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.session.failures.push(`Finalization failed: ${message}`);
        logError("Capture finalization failed", error);
      }
    }
    if (type === "parent_lost") this.session.failures.push("Native helper reported parent loss");
    if (type === "ipc_failure") this.session.failures.push(`Helper IPC failure: ${String(payload.reason ?? "unknown")}`);
    if (type === "helper_exit") await this.failSessionWithoutHelper(this.session, String(payload.reason ?? "unexpected helper exit"));
  }

  private async failSessionWithoutHelper(session: Session, reason: string): Promise<void> {
    session.failures.push(reason);
    session.terminationReason = "helper_exit";
    if (["preparing", "armed", "capturing"].includes(session.state)) session.state = transitionCaptureState(session.state, "failed");
    this.processManager.kill(captureServerProcess);
    this.probe.releaseExclusive(`capture:${session.id}`);
    session.helper = undefined;
  }

  private async finalizeSession(session: Session, status: HelperResponse): Promise<void> {
    if (this.finalizing) return this.finalizing;
    this.finalizing = this.finishSession(session, status);
    try { await this.finalizing; } finally { this.finalizing = null; }
  }

  private async finishSession(session: Session, status: HelperResponse): Promise<void> {
    if (typeof status.state === "string" && status.state !== session.state) session.state = transitionCaptureState(session.state, status.state as CaptureState);
    if (!["completed", "stopped", "failed"].includes(session.state)) return;
    session.terminationReason = String(status.terminationReason ?? session.terminationReason);
    try {
      const header = await readCaptureHeader(session.binaryFile);
      const metadata = await this.buildMetadata(session, header);
      try { await writeFile(session.metadataFile, JSON.stringify(metadata, null, 2), { encoding: "utf8", flag: "wx" }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await rm(nativeMetadataFile(session.binaryFile), { force: true });
    } finally {
      this.processManager.kill(captureServerProcess);
      this.probe.releaseExclusive(`capture:${session.id}`);
      await session.helper?.close(false);
      session.helper = undefined;
    }
  }

  private async buildMetadata(session: Session, header: BinaryHeader): Promise<CaptureMetadata> {
    const events = await readEvents(session.binaryFile, header);
    const timing = await captureTiming(session.binaryFile, header);
    const eventMisses = events.filter((event) => event.type === "missed_deadline").reduce((sum, event) => sum + (Number.parseInt(event.detail, 10) || 0), 0);
    timing.missedDeadlines = eventMisses;
    timing.scheduledFrames = Math.max(timing.scheduledFrames, timing.collectedFrames + eventMisses);
    return {
      version: 1,
      sessionId: session.id,
      state: session.state as CaptureMetadata["state"],
      elfPath: session.elf.elfPath,
      elfSha256: session.elf.elfSha256,
      device: session.probe.device,
      probeModel: session.probeModel,
      probeSerial: session.probeSerial,
      swdRateKhz: session.probe.speed,
      gdbServerPath: session.probe.gdbServerPath,
      gdbServerVersion: session.serverVersion,
      rspCapabilities: session.capabilities,
      symbols: header.symbols,
      timing,
      events,
      failures: session.failures,
      resets: events.filter((event) => event.type === "reset"),
      terminationReason: session.terminationReason,
      binaryFile: session.binaryFile,
    };
  }

  private async findTerminalSession(sessionId: string): Promise<Session> {
    if (!isSessionId(sessionId)) throw new Error("An exact capture session UUID is required");
    if (this.session?.id === sessionId) {
      if (!["completed", "stopped", "failed"].includes(this.session.state)) throw new Error("Operation requires a terminal capture session");
      return this.session;
    }
    for (const directory of this.knownOutputDirs) {
      let names: string[];
      try { names = await readdir(directory); } catch { continue; }
      const artifacts = selectSessionArtifacts(names, sessionId);
      const metadataName = artifacts.find((name) => name.endsWith(".metadata.json"));
      const nativeName = artifacts.find((name) => name.endsWith(".native.json"));
      if (!metadataName && !nativeName) continue;
      const stored = JSON.parse(await readFile(join(directory, metadataName ?? nativeName!), "utf8")) as CaptureMetadata | NativeMetadata;
      if (stored.sessionId !== sessionId || !["completed", "stopped", "failed"].includes(stored.state) || typeof stored.binaryFile !== "string") throw new Error("Capture metadata is invalid");
      if (!metadataName && !validNativeMetadata(stored as NativeMetadata)) throw new Error("Native capture metadata is invalid");
      const binaryFile = await realpath(stored.binaryFile);
      if (dirname(binaryFile).toLowerCase() !== directory.toLowerCase()) throw new Error("Capture metadata path escapes its output directory");
      const formal = metadataName ? stored as CaptureMetadata : null;
      const native = nativeName && !metadataName ? stored as NativeMetadata : null;
      return {
        id: stored.sessionId,
        state: stored.state,
        outputDir: directory,
        binaryFile,
        metadataFile: join(directory, metadataName ?? `${basename(binaryFile, ".jlcp")}.metadata.json`),
        elf: { elfPath: stored.elfPath, elfSha256: stored.elfSha256, symbols: formal?.symbols ?? [], sections: [], ramRanges: [], flashSections: [] },
        configPath: native?.configPath ?? "",
        control: {} as ProjectControlConfig,
        probe: { gdbServerPath: stored.gdbServerPath, jlinkExePath: "", device: stored.device, interface: "SWD", speed: stored.swdRateKhz, gdbPort: 0 },
        probeSerial: stored.probeSerial ?? "",
        probeModel: stored.probeModel,
        serverVersion: stored.gdbServerVersion,
        capabilities: formal?.rspCapabilities ?? native?.capabilities.split(";").filter(Boolean) ?? [],
        failures: formal?.failures ?? [],
        terminationReason: stored.terminationReason,
      };
    }
    throw new Error(`Capture session not found: ${sessionId}`);
  }
}

function buildRequestedSymbols(capture: RequestedCaptureSymbol[], config: ProjectControlConfig): RequestedCaptureSymbol[] {
  const names = [
    ...capture,
    { name: config.commands.start.selector },
    { name: config.commands.start.verify.selector },
    { name: config.commands.stop.selector },
    { name: config.commands.stop.verify.selector },
  ];
  const unique = new Map<string, RequestedCaptureSymbol>();
  for (const symbol of names) if (!unique.has(symbol.name)) unique.set(symbol.name, symbol);
  return [...unique.values()];
}

function validateDeclaredTypes(config: ProjectControlConfig, symbols: Map<string, CaptureSymbol>): void {
  for (const [name, command] of Object.entries(config.commands)) {
    const target = symbols.get(command.selector);
    const verify = symbols.get(command.verify.selector);
    if (!target || !verify) throw new Error(`Control command ${name} did not resolve from ELF`);
    if (target.type !== command.type) throw new Error(`Control command ${name} declared type does not match ELF`);
    if (verify.type !== command.verify.type) throw new Error(`Control verification ${name} declared type does not match ELF`);
  }
}

function helperControlPayload(config: ProjectControlConfig, symbols: Map<string, CaptureSymbol>): Record<string, unknown> {
  const convert = (name: "start" | "stop") => {
    const command = config.commands[name];
    return {
      target: symbols.get(command.selector),
      value: command.value,
      timeoutMs: command.timeoutMs ?? (name === "start" ? 1000 : 500),
      verify: {
        symbol: symbols.get(command.verify.selector),
        operator: command.verify.operator,
        value: command.verify.value,
      },
    };
  };
  return { start: convert("start"), stop: convert("stop") };
}

async function prepareOutputDirectory(candidate?: string): Promise<string> {
  const requested = candidate ?? join(tmpdir(), "jlink-mcp-captures");
  if (!isAbsolute(requested)) throw new Error("outputDir must be absolute");
  await mkdir(requested, { recursive: true });
  const directory = await realpath(requested);
  const probe = join(directory, `.write-test-${randomUUID()}`);
  await writeFile(probe, "", { flag: "wx" });
  await rm(probe);
  return directory;
}

async function requireExistingAbsoluteDirectory(candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new Error("outputDir must be absolute");
  const directory = await realpath(candidate);
  if (!(await stat(directory)).isDirectory()) throw new Error("outputDir must be a directory");
  return directory;
}

export function selectProbeSerial(configured: string | undefined, candidates: string[]): string {
  if (configured) return configured;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error(`Multiple J-Link probes found; set JLINK_SERIAL explicitly: ${candidates.join(", ")}`);
  throw new Error("No J-Link probe was discovered");
}

export function validateServerIdentity(output: string[], targetStatus: string, device: string, serial: string): { version: string; model: string; voltage: number } {
  const text = output.join("\n") + "\n" + targetStatus;
  const version = text.match(/J-Link GDB Server\s+V?([^\s]+)/i)?.[1] ?? text.match(/V(\d+\.\d+[a-z]?)/i)?.[1];
  const voltageText = text.match(/(?:VTref|VTarget|Target voltage)\s*[:=]\s*([0-9.]+)\s*V?/i)?.[1];
  const voltage = voltageText ? Number(voltageText) : NaN;
  if (!version) throw new Error("J-Link GDB Server version could not be verified");
  if (!Number.isFinite(voltage) || voltage <= 0) throw new Error("Positive target voltage could not be verified");
  if (!device || device === "Unspecified") throw new Error("Target device identity is not configured");
  const model = text.match(/(?:ProductName|Product name|J-Link model)\s*[:=]\s*([^\r\n]+)/i)?.[1]?.trim()
    ?? text.match(/Hardware version\s*[:=]\s*([^\r\n]+)/i)?.[1]?.trim()
    ?? "J-Link";
  if (!text.includes(serial)) log(`[Capture] Server output did not echo serial ${serial}; explicit -select remains authoritative`);
  return { version, model, voltage };
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function nativeMetadataFile(binaryFile: string): string {
  return binaryFile.endsWith(".jlcp") ? `${binaryFile.slice(0, -5)}.native.json` : `${binaryFile}.native.json`;
}

function validNativeMetadata(value: NativeMetadata): boolean {
  return value?.version === 1 && isSessionId(value.sessionId) && ["completed", "stopped", "failed"].includes(value.state)
    && typeof value.binaryFile === "string" && typeof value.elfPath === "string" && /^[0-9a-f]{64}$/i.test(value.elfSha256)
    && typeof value.device === "string" && typeof value.gdbServerPath === "string" && Number.isFinite(value.swdRateKhz);
}
