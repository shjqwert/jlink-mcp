import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";
import type { ProbeBackend } from "../probe/backend";
import { createProbeBackend, type ProbeFactoryConfig } from "../probe/factory";
import { log } from "../utils/logger";
import { ProcessManager } from "../utils/process-manager";
import { AcceptanceEvidenceStore, readRepositoryIdentity } from "./acceptance/evidence";
import { isValidAcceptanceRunId } from "./acceptance/run-id";
import { DirectMcuService, type CoreRegisterWriteInput, type EraseInput, type FlashInput, type MemoryReadInput, type MemoryWriteInput, type ProbeCommandInput } from "./runtime/direct-operations";
import { ArtifactVariableService, type VariableRefInput, type VariableWriteInput } from "./runtime/artifact-operations";
import { SvdRegisterService, type RegisterWriteInput } from "./runtime/svd-operations";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "./runtime/operation-envelope";
import { ProbeQueue } from "./runtime/probe-queue";
import { MemorySessionManager } from "./runtime/memory-session";
import { SessionOperations } from "./runtime/session-operations";
import { TargetRuntimeRegistry } from "./runtime/target-runtime";
import { TargetStore, type StoredTarget, type TargetConfigureInput } from "./runtime/target-store";
import { HssOperations, type HssCaptureInput } from "./runtime/hss-operations";
import { DebugSequenceExecutor, type DebugSequenceInput } from "./runtime/debug-sequence";
import { JLINK_MCP_VERSION } from "./version";

export interface JLinkMcpServerOptions {
  cwd?: string;
  storageRoot?: string;
  evidenceRoot?: string;
  queueRoot?: string;
}

export const AGENT_TOOL_NAMES = [
  "list_devices", "target_configure", "target_status",
  "artifact_probe", "symbol_search", "symbol_resolve",
  "read_variable", "write_variable", "read_memory", "write_memory", "core_register_access", "peripheral_register_access",
  "target_control", "flash", "erase",
  "hss_start", "hss_status", "hss_stop", "hss_recover",
  "debug_sequence_execute",
  "capture_list", "capture_summary", "capture_series", "capture_event_window", "capture_export_csv",
  "gdb_open", "gdb_command", "gdb_wait", "gdb_backtrace", "gdb_close",
  "rtt_open", "rtt_read", "rtt_search", "rtt_clear", "rtt_close",
  "diagnose_crash", "probe_command",
] as const;

type AgentToolName = typeof AGENT_TOOL_NAMES[number];

export function operationHadIssuedEffects(envelope: Pick<OperationEnvelope, "observedEffects">): boolean {
  return envelope.observedEffects.length > 0;
}

export function applyEvidenceLogFailure(envelope: OperationEnvelope, evidenceError: unknown): OperationEnvelope {
  const message = `Acceptance command logging failed: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}`;
  const writeIssued = operationHadIssuedEffects(envelope) || envelope.error?.writeIssued === true;
  if (envelope.ok) {
    envelope.warnings.push("The requested operation completed before evidence logging failed; do not retry it automatically.");
    return failEnvelope(envelope, {
      code: "EVIDENCE_LOG_FAILED",
      stage: "evidence",
      message,
      retryable: false,
      writeIssued,
      stateUnknown: false,
    });
  }
  envelope.warnings.push(message);
  if (writeIssued && envelope.error) {
    envelope.error.writeIssued = true;
    envelope.error.retryable = false;
    envelope.warnings.push("The failed operation recorded explicit side effects before evidence logging failed; do not retry it automatically.");
  }
  return envelope;
}

const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  list_devices: "List connected J-Link probes without changing target state.",
  target_configure: "Persist one explicit Target configuration for a project root.",
  target_status: "Report persisted Target, Probe, Artifact, SVD, owner, and live state facts.",
  artifact_probe: "Discover and classify bounded Artifact, MAP, and flash-image candidates.",
  symbol_search: "Search the configured Artifact symbol catalog.",
  symbol_resolve: "Resolve one supported typed variable selector.",
  read_variable: "Read one typed variable without implicit target-state changes.",
  write_variable: "Write one typed variable with optional old-value, verification, and restore steps.",
  read_memory: "Read a bounded explicit target memory range.",
  write_memory: "Write a bounded explicit target memory range with optional verification.",
  core_register_access: "Read, list, or write bounded CPU-core registers without implicit target control.",
  peripheral_register_access: "Read or safely write bounded SVD peripheral register selectors.",
  target_control: "Explicitly halt, resume, reset, or reset-and-halt the configured target.",
  flash: "Program and verify an explicit HEX, SREC, or addressed BIN image.",
  erase: "Erase target flash with optional explicit blank verification.",
  hss_start: "Start a directly specified J-Link HSS capture.",
  hss_status: "Report an HSS capture lifecycle and quality counters.",
  hss_stop: "Stop an active HSS capture and finalize available data.",
  hss_recover: "Recover and index the trustworthy prefix of an interrupted HSS capture.",
  debug_sequence_execute: "Synchronously execute multiple HSS/read/write operations on fixed intervals over at least one second and wait until completion. Do not use for a single variable read or write.",
  capture_list: "List bounded local Capture packages and report whether each package is supported JCAP v1, legacy, or invalid.",
  capture_summary: "Return bounded provenance, lifecycle, variables, quality, and counts for a capture.",
  capture_series: "Return bounded aggregate time-series buckets for selected variables and ticks.",
  capture_event_window: "Return one event and bounded neighboring series data.",
  capture_export_csv: "Explicitly export a bounded CSV outside the JCAP package.",
  gdb_open: "Start one managed GDB Server and client using the current Artifact as symbols.",
  gdb_command: "Execute one exact raw GDB command and report unknown effects.",
  gdb_wait: "Wait for an already issued GDB run or step to stop.",
  gdb_backtrace: "Read a backtrace when the target state permits it.",
  gdb_close: "Disconnect the managed GDB client and stop its server without target control.",
  rtt_open: "Connect to an explicitly available existing RTT endpoint.",
  rtt_read: "Read bounded buffered RTT output.",
  rtt_search: "Search bounded buffered RTT output.",
  rtt_clear: "Clear only the local RTT buffer.",
  rtt_close: "Close only the managed RTT client.",
  diagnose_crash: "Collect bounded, no-hidden-side-effect Cortex-M crash evidence from an already halted target.",
  probe_command: "Execute exact raw J-Link Commander commands and report unknown effects.",
};

const projectRootInput = { projectRoot: z.string().min(1).describe("Existing absolute project root configured by target_configure") };
const acceptanceRunId = z.string().refine(isValidAcceptanceRunId, "runId must be a bounded immutable non-reserved directory name");
const uint32 = z.number().int().min(0).max(0xffff_ffff);
const accessWidth = z.union([z.literal(8), z.literal(16), z.literal(32)]);
const variableRef = z.string().min(1).max(1024).describe("Logical typed symbol selector; the server re-resolves it against the current Artifact generation");
const variableNonObserveComparator = z.union([
  z.object({ mode: z.literal("exact") }),
  z.object({ mode: z.literal("tolerance"), absTolerance: z.number().nonnegative(), relTolerance: z.number().nonnegative() }),
  z.object({ mode: z.literal("masked"), maskHex: z.string().regex(/^(?:[0-9a-fA-F]{2})+$/) }),
]);
const variableComparator = z.union([
  variableNonObserveComparator,
  z.object({
    mode: z.literal("observe"),
    durationMs: z.number().int().min(1).max(60_000),
    maxPolls: z.number().int().min(1).max(1_000),
    intervalMs: z.number().int().min(1).max(10_000),
    comparator: variableNonObserveComparator,
  }),
]);

export class JLinkMcpServer {
  private readonly server: McpServer;
  private readonly discoveryProcesses = new ProcessManager();
  private readonly discoveryProbe: ProbeBackend;
  private readonly targets: TargetStore;
  private readonly queue: ProbeQueue;
  private readonly memorySessions: MemorySessionManager;
  private readonly runtimes = new TargetRuntimeRegistry();
  private readonly direct: DirectMcuService;
  private readonly artifacts: ArtifactVariableService;
  private readonly registers: SvdRegisterService;
  private readonly sessions: SessionOperations;
  private readonly hss: HssOperations;
  private readonly sequence: DebugSequenceExecutor;
  private readonly evidence: AcceptanceEvidenceStore;
  private readonly implemented = new Set<AgentToolName>();

  constructor(probeConfig?: ProbeFactoryConfig, _rttPort?: number, _gdbPath?: string, options: JLinkMcpServerOptions = {}) {
    this.discoveryProbe = createProbeBackend(probeConfig ?? { type: "jlink" }, this.discoveryProcesses);
    const cwd = options.cwd ?? process.cwd();
    const stateRoot = options.storageRoot ?? join(cwd, ".jlink-mcp");
    const evidenceRoot = options.evidenceRoot ?? join(cwd, "test-output");
    this.targets = new TargetStore(stateRoot);
    this.queue = new ProbeQueue(options.queueRoot);
    this.memorySessions = new MemorySessionManager(this.queue);
    this.direct = new DirectMcuService(this.targets, this.queue, (target) => this.runtimes.get(target), undefined, this.memorySessions);
    this.artifacts = new ArtifactVariableService(this.targets, this.direct, stateRoot);
    this.registers = new SvdRegisterService(this.targets, this.direct);
    this.sessions = new SessionOperations(this.targets, this.queue, (target) => this.runtimes.get(target), this.memorySessions);
    this.evidence = new AcceptanceEvidenceStore(evidenceRoot, readRepositoryIdentity(cwd).commit);
    this.hss = new HssOperations(
      this.targets,
      this.queue,
      this.artifacts,
      undefined,
      evidenceRoot,
      stateRoot,
      undefined,
      <T>(runId: string, operation: () => Promise<T>) => this.evidence.guardRunMutation(runId, operation),
      this.memorySessions,
    );
    this.artifacts.setCaptureWriteDelegate(this.hss);
    this.sequence = new DebugSequenceExecutor(this.artifacts, this.hss);
    this.server = new McpServer({ name: "jlink-mcp", version: JLINK_MCP_VERSION });
    this.registerTools();
    this.registerResources();
  }

  private registerTools(): void {
    this.registerEnvelopeTool("list_devices", {}, async () => this.listDevices());
    this.registerEnvelopeTool("target_configure", {
      projectRoot: z.string().min(1),
      device: z.string().min(1),
      probeSerial: z.string().min(1),
      interface: z.enum(["SWD", "JTAG"]),
      speed: z.number().int().min(1).max(50_000),
      artifactPath: z.string().optional(),
      mapPath: z.string().optional(),
      svdPath: z.string().optional(),
      jlinkPath: z.string().optional(),
      gdbServerPath: z.string().optional(),
      gdbPath: z.string().optional(),
      ports: z.object({ gdb: z.number().int().min(1).max(65535).optional(), rtt: z.number().int().min(1).max(65535).optional(), swo: z.number().int().min(1).max(65535).optional() }).optional(),
      artifactFlashImages: z.array(z.object({ path: z.string().min(1), baseAddress: uint32.optional() })).max(64).optional(),
      memoryRegions: z.array(z.object({ start: uint32, length: z.number().int().positive().max(0x1_0000_0000), kind: z.enum(["ram", "flash", "rom", "peripheral", "unknown"]), writable: z.boolean() })).max(128).optional(),
    }, async (input) => {
      const result = await this.direct.configure(input as unknown as TargetConfigureInput);
      const previousGeneration = typeof result.before?.targetGeneration === "string" ? result.before.targetGeneration : undefined;
      if (result.ok && result.target && previousGeneration && await this.runtimes.invalidate(result.target.projectRoot, previousGeneration)) {
        result.observedEffects.push("process_local_target_runtime_disposed");
      }
      return result;
    });
    this.registerEnvelopeTool("target_status", projectRootInput, (input) => this.direct.status(String(input.projectRoot)));

    this.registerEnvelopeTool("artifact_probe", {
      ...projectRootInput,
      explicitArtifact: z.string().min(1).optional(),
      explicitMap: z.string().min(1).optional(),
      maxFiles: z.number().int().min(1).max(100_000).optional(),
      maxDepth: z.number().int().min(0).max(64).optional(),
      maxCandidates: z.number().int().min(1).max(4096).optional(),
    }, (input) => this.artifacts.artifactProbe(input as never));
    this.registerEnvelopeTool("symbol_search", { ...projectRootInput, query: z.string().min(1).max(256), limit: z.number().int().min(1).max(128).default(64) },
      (input) => this.artifacts.symbolSearch(String(input.projectRoot), String(input.query), Number(input.limit)));
    this.registerEnvelopeTool("symbol_resolve", { ...projectRootInput, selector: z.string().min(1).max(1024) },
      (input) => this.artifacts.symbolResolve(String(input.projectRoot), String(input.selector)));
    this.registerEnvelopeTool("read_variable", { ...projectRootInput, ref: variableRef },
      (input) => this.artifacts.readVariable(String(input.projectRoot), input.ref as VariableRefInput));
    this.registerEnvelopeTool("write_variable", {
      ...projectRootInput,
      ref: variableRef,
      value: z.number(),
      captureOld: z.boolean().default(true),
      verify: z.boolean().default(true),
      restore: z.boolean().default(false),
      verificationConnection: z.enum(["same_session", "independent_session"]).default("same_session"),
      comparator: variableComparator.default({ mode: "exact" }),
    }, (input) => this.artifacts.writeVariable(input as unknown as VariableWriteInput));
    this.registerEnvelopeTool("read_memory", { ...projectRootInput, address: uint32, width: accessWidth, byteCount: z.number().int().min(1).max(4096) },
      (input) => this.direct.readMemory(input as unknown as MemoryReadInput));
    this.registerEnvelopeTool("write_memory", {
      ...projectRootInput,
      address: uint32,
      width: accessWidth,
      byteCount: z.number().int().min(1).max(4096),
      dataHex: z.string().min(2),
      captureOld: z.boolean().default(false),
      verify: z.boolean().default(true),
    }, (input) => this.direct.writeMemory(input as unknown as MemoryWriteInput));
    this.registerEnvelopeTool("core_register_access", {
      ...projectRootInput,
      action: z.enum(["read", "read_all", "write"]),
      name: z.string().min(1).max(32).optional(),
      value: uint32.optional(),
      verify: z.boolean().default(false),
    }, async (input) => {
      const projectRoot = String(input.projectRoot);
      if (input.action === "read") {
        if (typeof input.name !== "string" || input.value !== undefined || input.verify !== false) {
          return actionInputFailure("core_register_access", "action=read requires name and accepts no value or verify options");
        }
        return relabelEnvelope(await this.direct.readCoreRegister(projectRoot, input.name), "core_register_access");
      }
      if (input.action === "read_all") {
        if (input.name !== undefined || input.value !== undefined || input.verify !== false) return actionInputFailure("core_register_access", "action=read_all accepts no name, value, or verify options");
        return relabelEnvelope(await this.direct.readCoreRegisters(projectRoot), "core_register_access");
      }
      if (typeof input.name !== "string" || typeof input.value !== "number") return actionInputFailure("core_register_access", "action=write requires name and value");
      return relabelEnvelope(await this.direct.writeCoreRegister({ projectRoot, name: input.name, value: input.value, verify: Boolean(input.verify) } as CoreRegisterWriteInput), "core_register_access");
    });
    this.registerEnvelopeTool("peripheral_register_access", {
      ...projectRootInput,
      action: z.enum(["read", "read_many", "write"]),
      selector: z.string().min(3).max(512).optional(),
      selectors: z.array(z.string().min(3).max(512)).min(1).max(32).optional(),
      value: uint32.optional(),
      captureOld: z.boolean().default(false),
      verify: z.boolean().default(true),
      restore: z.boolean().default(false),
      comparator: variableComparator.default({ mode: "exact" }),
    }, async (input) => {
      const projectRoot = String(input.projectRoot);
      if (input.action === "read") {
        if (
          typeof input.selector !== "string" || input.selectors !== undefined || input.value !== undefined
          || input.captureOld !== false || input.restore !== false
        ) return actionInputFailure("peripheral_register_access", "action=read requires selector only");
        return relabelEnvelope(await this.registers.readRegister(projectRoot, input.selector), "peripheral_register_access");
      }
      if (input.action === "read_many") {
        if (
          !Array.isArray(input.selectors) || input.selector !== undefined || input.value !== undefined
          || input.captureOld !== false || input.restore !== false
        ) return actionInputFailure("peripheral_register_access", "action=read_many requires selectors only");
        return relabelEnvelope(await this.registers.readRegisters(projectRoot, input.selectors as string[]), "peripheral_register_access");
      }
      if (typeof input.selector !== "string" || typeof input.value !== "number" || input.selectors !== undefined) return actionInputFailure("peripheral_register_access", "action=write requires selector and value");
      return relabelEnvelope(await this.registers.writeRegister({
        projectRoot,
        selector: input.selector,
        value: input.value,
        captureOld: Boolean(input.captureOld),
        verify: Boolean(input.verify),
        restore: Boolean(input.restore),
        comparator: input.comparator as RegisterWriteInput["comparator"],
      }), "peripheral_register_access");
    });
    this.registerEnvelopeTool("target_control", { ...projectRootInput, action: z.enum(["halt", "resume", "reset", "reset_halt"]) }, async (input) => {
      const action = input.action as "halt" | "resume" | "reset" | "reset_halt";
      const envelope = relabelEnvelope(await this.direct.control(action, String(input.projectRoot)), "target_control");
      envelope.data = { action, ...(isRecord(envelope.data) ? envelope.data : { result: envelope.data }) };
      return envelope;
    });
    const userConfirmation = z.boolean().default(false).describe("Set true only after the user explicitly confirms this exact operation and its effects.");
    this.registerEnvelopeTool("flash", { ...projectRootInput, path: z.string().min(1), baseAddress: uint32.optional(), userConfirmed: userConfirmation },
      (input) => this.direct.flash(input as unknown as FlashInput));
    this.registerEnvelopeTool("erase", { ...projectRootInput, verifyBlank: z.boolean().default(false), userConfirmed: userConfirmation },
      (input) => this.direct.erase(input as unknown as EraseInput));
    this.registerEnvelopeTool("probe_command", { ...projectRootInput, commands: z.array(z.string().min(1)).min(1).max(100), userConfirmed: userConfirmation },
      (input) => this.direct.probeCommand(input as unknown as ProbeCommandInput));

    this.registerEnvelopeTool("gdb_open", projectRootInput, (input) => this.gdbOpen(String(input.projectRoot)));
    this.registerEnvelopeTool("gdb_command", { ...projectRootInput, command: z.string().min(1), timeoutMs: z.number().int().min(1).max(120_000).default(15_000), userConfirmed: userConfirmation },
      (input) => this.sessions.gdbCommand(String(input.projectRoot), String(input.command), Number(input.timeoutMs), Boolean(input.userConfirmed)));
    this.registerEnvelopeTool("gdb_wait", { ...projectRootInput, timeoutMs: z.number().int().min(1).max(120_000).default(30_000) },
      (input) => this.sessions.gdbWait(String(input.projectRoot), Number(input.timeoutMs)));
    this.registerEnvelopeTool("gdb_backtrace", { ...projectRootInput, full: z.boolean().default(false) },
      (input) => this.sessions.gdbBacktrace(String(input.projectRoot), Boolean(input.full)));
    this.registerEnvelopeTool("gdb_close", projectRootInput, async (input) => relabelEnvelope(await this.sessions.gdbServerStop(String(input.projectRoot)), "gdb_close"));

    this.registerEnvelopeTool("rtt_open", projectRootInput, async (input) => relabelEnvelope(await this.sessions.rttConnect(String(input.projectRoot)), "rtt_open"));
    this.registerEnvelopeTool("rtt_read", { ...projectRootInput, count: z.number().int().min(1).max(1000).default(50) },
      (input) => this.sessions.rttRead(String(input.projectRoot), Number(input.count)));
    this.registerEnvelopeTool("rtt_search", {
      ...projectRootInput,
      level: z.string().optional(),
      module: z.string().optional(),
      pattern: z.string().optional(),
      count: z.number().int().min(1).max(1000).default(100),
    }, (input) => this.sessions.rttSearch(String(input.projectRoot), input as { level?: string; module?: string; pattern?: string; count?: number }));
    this.registerEnvelopeTool("rtt_clear", projectRootInput, (input) => this.sessions.rttClear(String(input.projectRoot)));
    this.registerEnvelopeTool("rtt_close", projectRootInput, async (input) => relabelEnvelope(await this.sessions.rttDisconnect(String(input.projectRoot)), "rtt_close"));
    this.registerEnvelopeTool("diagnose_crash", projectRootInput, (input) => this.diagnoseCrash(String(input.projectRoot)));

    const hssVariable = z.object({ ref: variableRef, alias: z.string().min(1).max(128).optional(), unit: z.string().min(1).max(64).optional() }).strict();
    const hssQualityOracle = z.object({
      ref: variableRef,
      expectedIncrement: z.number().int().min(1).max(0xffff_ffff),
      tolerance: z.number().int().min(0).max(0xffff_ffff),
    }).strict();
    const hssCapture = {
      ...projectRootInput,
      variables: z.array(hssVariable).min(1).max(10),
      writeVariables: z.array(variableRef).max(32).optional(),
      rateHz: z.number().int().min(1).max(1_000),
      durationSec: z.number().int().min(1).max(60),
      qualityOracle: hssQualityOracle.optional(),
      dryRun: z.boolean().default(false),
      runId: acceptanceRunId.optional(),
    };
    const hssSelector = { ...projectRootInput, captureId: z.string().uuid().optional() };
    this.registerEnvelopeTool("hss_start", hssCapture, (input) => this.hss.start(input as unknown as HssCaptureInput));
    this.registerEnvelopeTool("hss_status", hssSelector, (input) => this.hss.status({ projectRoot: String(input.projectRoot), captureId: input.captureId as string | undefined }));
    this.registerEnvelopeTool("hss_stop", hssSelector, (input) => this.hss.stop({ projectRoot: String(input.projectRoot), captureId: input.captureId as string | undefined }));
    this.registerEnvelopeTool("hss_recover", hssSelector, (input) => this.hss.recover({ projectRoot: String(input.projectRoot), captureId: input.captureId as string | undefined }));
    const sequenceStep = z.discriminatedUnion("action", [
      z.object({
        atMs: z.number().int().min(0).max(30_000),
        action: z.literal("hss_start"),
        variables: z.array(hssVariable).min(1).max(10),
        writeVariables: z.array(variableRef).max(32).optional(),
        rateHz: z.number().int().min(1).max(1_000),
        durationSec: z.number().int().min(1).max(60),
        qualityOracle: hssQualityOracle.optional(),
      }).strict(),
      z.object({
        atMs: z.number().int().min(0).max(30_000),
        action: z.literal("write_variable"),
        ref: variableRef,
        value: z.number(),
        captureOld: z.boolean().optional(),
        verify: z.boolean().optional(),
        restore: z.boolean().optional(),
      }).strict(),
      z.object({ atMs: z.number().int().min(0).max(30_000), action: z.literal("read_variable"), ref: variableRef }).strict(),
      z.object({ atMs: z.number().int().min(0).max(30_000), action: z.literal("hss_stop") }).strict(),
    ]);
    const sequenceCleanup = z.discriminatedUnion("action", [
      z.object({ action: z.literal("restore_variable"), ref: variableRef, value: z.number() }).strict(),
      z.object({ action: z.literal("hss_stop") }).strict(),
    ]);
    this.registerEnvelopeTool("debug_sequence_execute", {
      ...projectRootInput,
      steps: z.array(sequenceStep).min(2).max(32),
      cleanup: z.array(sequenceCleanup).max(4).optional(),
      timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
    }, (input, signal) => this.sequence.execute(input as unknown as DebugSequenceInput, signal));
    this.registerEnvelopeTool("capture_list", { limit: z.number().int().min(1).max(100).default(50), cursor: z.string().optional() },
      (input) => this.hss.captureList({ limit: Number(input.limit), cursor: input.cursor as string | undefined }));
    this.registerEnvelopeTool("capture_summary", { captureId: z.string().uuid() }, (input) => this.hss.captureSummary(String(input.captureId)));
    this.registerEnvelopeTool("capture_series", {
      captureId: z.string().uuid(),
      variables: z.array(z.string().min(1).max(1024)).min(1).max(32),
      startTick: z.string().regex(/^\d+$/),
      endTick: z.string().regex(/^\d+$/),
      bucketCount: z.number().int().min(1).max(4096),
    }, (input) => this.hss.captureSeries(input as { captureId: string; variables: string[]; startTick: string; endTick: string; bucketCount: number }));
    this.registerEnvelopeTool("capture_event_window", {
      captureId: z.string().uuid(),
      eventId: z.string().uuid(),
      variables: z.array(z.string().min(1).max(1024)).max(16),
      beforeMs: z.number().int().min(0).max(60_000),
      afterMs: z.number().int().min(0).max(60_000),
      bucketCount: z.number().int().min(1).max(2048),
    }, (input) => this.hss.captureEventWindow(input as { captureId: string; eventId: string; variables: string[]; beforeMs: number; afterMs: number; bucketCount: number }));
    this.registerEnvelopeTool("capture_export_csv", { captureId: z.string().uuid() }, (input) => this.hss.captureExport(String(input.captureId)));

    const missing = AGENT_TOOL_NAMES.filter((name) => !this.implemented.has(name));
    if (missing.length) throw new Error(`missing concrete MCP tool handlers: ${missing.join(", ")}`);
  }

  private async gdbOpen(projectRoot: string): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try {
      target = this.targets.require(projectRoot);
      if (!target.artifact) return actionInputFailure("gdb_open", "gdb_open requires a configured ELF Artifact for host-side symbols");
    } catch (error) {
      return failEnvelope(createOperationEnvelope("gdb_open"), {
        code: "TARGET_NOT_CONFIGURED",
        stage: "target_lookup",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        writeIssued: false,
        stateUnknown: false,
      });
    }

    const server = await this.sessions.gdbServerStart(target.projectRoot);
    if (!server.ok) return relabelEnvelope(server, "gdb_open");
    const client = await this.sessions.gdbConnect(target.projectRoot, target.artifact.path);
    const envelope = relabelEnvelope(client, "gdb_open");
    envelope.requestedEffects = distinct([...server.requestedEffects, ...client.requestedEffects]);
    envelope.observedEffects = distinct([...server.observedEffects, ...client.observedEffects]);
    envelope.before ??= server.before;
    envelope.data = { server: server.data, client: client.data };
    if (!client.ok) {
      envelope.warnings.push("GDB Server remains owned after client startup failed; use gdb_close after reviewing the reported target state.");
    }
    return envelope;
  }

  private async diagnoseCrash(projectRoot: string): Promise<OperationEnvelope> {
    const managedBacktrace = await this.sessions.managedGdbBacktrace(projectRoot);
    if (managedBacktrace) {
      const envelope = relabelEnvelope(managedBacktrace, "diagnose_crash");
      const targetExecutionState = isRecord(envelope.before) && typeof envelope.before.targetExecutionState === "string"
        ? envelope.before.targetExecutionState
        : "unknown";
      const backtrace = envelope.data;
      envelope.data = {
        targetExecutionState,
        diagnosis: envelope.ok
          ? {
            status: "partial",
            architecture: "cortex_m_unconfirmed",
            frameStatus: "not_collected",
            collection: "managed_gdb_session",
            backtrace: { status: "available", source: "managed_gdb_session", result: backtrace },
          }
          : {
            status: "partial",
            architecture: "cortex_m_unconfirmed",
            frameStatus: "not_collected",
            collection: "managed_gdb_session",
            backtrace: { status: "unavailable", source: "managed_gdb_session", error: envelope.error ?? null },
          },
      };
      if (envelope.ok) {
        envelope.warnings.push("Direct Cortex-M register collection was skipped because the managed GDB session owns the Probe.");
        envelope.verification = { status: "observed", method: "managed_gdb_backtrace" };
      }
      return envelope;
    }
    return relabelEnvelope(await this.direct.diagnoseCrash(projectRoot), "diagnose_crash");
  }

  private registerEnvelopeTool(
    name: AgentToolName,
    inputSchema: Record<string, z.ZodType>,
    handler: (input: Record<string, unknown>, signal?: AbortSignal) => OperationEnvelope | Promise<OperationEnvelope>,
  ): void {
    this.implemented.add(name);
    const schemaWithRunId = Object.hasOwn(inputSchema, "runId") ? inputSchema : { ...inputSchema, runId: acceptanceRunId.optional() };
    this.server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: schemaWithRunId }, async (input, extra) => {
      const requestedRunId = (input as Record<string, unknown>).runId;
      const execute = async (): Promise<OperationEnvelope> => {
        try { return await handler(input as Record<string, unknown>, extra.signal); }
        catch (error) {
          return failEnvelope(createOperationEnvelope(name), {
            code: "INTERNAL_ERROR",
            stage: "dispatch",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
            writeIssued: false,
            stateUnknown: false,
          });
        }
      };
      let envelope: OperationEnvelope;
      if (typeof requestedRunId !== "string") envelope = await execute();
      else {
        try {
          const recorded = await this.evidence.executeAndRecordMcpCommand(requestedRunId, name, input as Record<string, unknown>, execute);
          envelope = recorded.envelope;
          if (recorded.evidenceError) envelope = applyEvidenceLogFailure(envelope, recorded.evidenceError);
        } catch (error) {
          const coded = error as { code?: unknown };
          const code = typeof coded?.code === "string" ? coded.code : "EVIDENCE_PREFLIGHT_FAILED";
          envelope = failEnvelope(createOperationEnvelope(name), {
            code,
            stage: "evidence_preflight",
            message: error instanceof Error ? error.message : String(error),
            retryable: code === "COMMAND_LOG_BUSY" || code === "EVIDENCE_RUN_BUSY",
            writeIssued: false,
            stateUnknown: false,
          });
        }
      }
      return {
        isError: !envelope.ok,
        content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
        structuredContent: envelope as unknown as Record<string, unknown>,
      };
    });
  }

  private async listDevices(): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope("list_devices");
    try {
      envelope.before = { probe: this.discoveryProbe.getStatus() };
      const result = await this.discoveryProbe.listDevices();
      envelope.after = { probe: this.discoveryProbe.getStatus() };
      envelope.data = { output: result.output, rawOutput: result.rawOutput, error: result.error };
      envelope.verification = { status: "observed", method: "J-Link ShowEmuList" };
      if (!result.success) return failEnvelope(envelope, {
        code: result.errorCode ?? "PROBE_DISCOVERY_FAILED",
        stage: "discovery",
        message: result.error || result.output || "Probe discovery failed",
        retryable: true,
        writeIssued: false,
        stateUnknown: false,
      });
      return finishEnvelope(envelope, true);
    } catch (error) {
      return failEnvelope(envelope, { code: "PROBE_DISCOVERY_FAILED", stage: "discovery", message: error instanceof Error ? error.message : String(error), retryable: true, writeIssued: false, stateUnknown: false });
    }
  }

  private registerResources(): void {
    this.server.resource("rtt-output", "rtt://output",
      { description: "Bounded local RTT output", mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "rtt://output", text: this.runtimes.entries().flatMap((runtime) => runtime.rtt.getLines(200)).slice(-200).join("\n"), mimeType: "text/plain" }] }));

    this.server.resource("gdb-server-log", "probe://gdb-server-log",
      { description: "Recent J-Link GDB Server output", mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "probe://gdb-server-log", text: this.runtimes.entries().flatMap((runtime) => runtime.probe.getGDBServerOutput(200)).slice(-200).join("\n"), mimeType: "text/plain" }] }));

    this.server.resource("probe-status", "probe://status",
      { description: "Current process-local Probe status", mimeType: "application/json" },
      async () => ({ contents: [{ uri: "probe://status", text: JSON.stringify({
        discoveryProbe: this.discoveryProbe.getStatus(),
        targets: this.runtimes.entries().map((runtime) => ({ generation: runtime.targetGeneration, probe: runtime.probe.getStatus(), rtt: runtime.rtt.getStats() })),
        runningDiscoveryProcesses: this.discoveryProcesses.listRunning(),
      }, null, 2), mimeType: "application/json" }] }));
  }

  async startStdio(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
    log("MCP Server started on stdio");
  }

  async dispose(): Promise<void> {
    await this.memorySessions.dispose();
    for (const runtime of this.runtimes.entries()) {
      if (!this.runtimes.canSafelyDispose(runtime)) {
        log(`Skipping GDB Server shutdown for ${runtime.projectRoot}: target state is not explicitly running`);
        continue;
      }
      runtime.gdbServerStopping = true;
      try {
        await runtime.gdb.disconnect();
        runtime.rtt.disconnect();
        const token = runtime.gdbOwnerToken;
        await runtime.processManager.killAndWait("jlink-gdb-server");
        if (!token || runtime.gdbOwnerToken !== token) continue;
        try { this.queue.releaseOwner(runtime.probeSerial, token); } catch { /* owner belongs to another live process or is already gone */ }
        runtime.gdbOwnerToken = undefined;
      } finally {
        runtime.gdbServerStopping = false;
      }
    }
    await this.runtimes.dispose();
    this.discoveryProbe.dispose();
    this.discoveryProcesses.killAll();
  }
}

function relabelEnvelope(envelope: OperationEnvelope, tool: AgentToolName): OperationEnvelope {
  envelope.tool = tool;
  return envelope;
}

function actionInputFailure(tool: AgentToolName, message: string): OperationEnvelope {
  return failEnvelope(createOperationEnvelope(tool), {
    code: "ACTION_INPUT_INVALID",
    stage: "validation",
    message,
    retryable: false,
    writeIssued: false,
    stateUnknown: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}
