import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";
import type { ProbeBackend } from "../probe/backend";
import { createProbeBackend, type ProbeFactoryConfig } from "../probe/factory";
import { log } from "../utils/logger";
import { ProcessManager } from "../utils/process-manager";
import { AcceptanceEvidenceStore, readRepositoryIdentity } from "./acceptance/evidence";
import { DirectMcuService } from "./runtime/direct-operations";
import { ArtifactVariableService } from "./runtime/artifact-operations";
import { SvdRegisterService } from "./runtime/svd-operations";
import { createOperationEnvelope, failEnvelope, type OperationEnvelope } from "./runtime/operation-envelope";
import { ProbeQueue } from "./runtime/probe-queue";
import { MemorySessionManager } from "./runtime/memory-session";
import { SessionOperations } from "./runtime/session-operations";
import { TargetRuntimeRegistry } from "./runtime/target-runtime";
import { TargetStore } from "./runtime/target-store";
import { HssOperations } from "./runtime/hss-operations";
import { DebugSequenceExecutor } from "./runtime/debug-sequence";
import { VariableAccessRouter } from "./runtime/variable-access-router";
import { CaptureQueryOperations } from "./runtime/capture-query-operations";
import {
  AGENT_TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  type AgentToolName,
  type RegisterEnvelopeTool,
} from "./tools/tool-contract";
import { acceptanceRunId } from "./tools/tool-schemas";
import { registerTargetTools } from "./tools/register-target-tools";
import { registerSessionTools } from "./tools/register-session-tools";
import { registerHssTools } from "./tools/register-hss-tools";
import { registerCaptureTools } from "./tools/register-capture-tools";
import { JLINK_MCP_VERSION } from "./version";

export { AGENT_TOOL_NAMES } from "./tools/tool-contract";

export interface JLinkMcpServerOptions {
  cwd?: string;
  storageRoot?: string;
  evidenceRoot?: string;
  queueRoot?: string;
}

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
  private readonly variables: VariableAccessRouter;
  private readonly registers: SvdRegisterService;
  private readonly sessions: SessionOperations;
  private readonly hss: HssOperations;
  private readonly captures: CaptureQueryOperations;
  private readonly sequence: DebugSequenceExecutor;
  private readonly evidence: AcceptanceEvidenceStore;
  private readonly implemented = new Set<AgentToolName>();

  constructor(probeConfig?: ProbeFactoryConfig, options: JLinkMcpServerOptions = {}) {
    this.discoveryProbe = createProbeBackend(probeConfig ?? { type: "jlink" }, this.discoveryProcesses);
    const cwd = options.cwd ?? process.cwd();
    const stateRoot = options.storageRoot ?? join(cwd, ".jlink-mcp");
    const evidenceRoot = options.evidenceRoot ?? join(cwd, "test-output");
    this.targets = new TargetStore(stateRoot);
    this.queue = new ProbeQueue(options.queueRoot);
    this.memorySessions = new MemorySessionManager(this.queue);
    this.direct = new DirectMcuService(this.targets, this.queue, (target) => this.runtimes.get(target), undefined, this.memorySessions);
    this.artifacts = new ArtifactVariableService(this.targets);
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
      this.memorySessions,
    );
    this.captures = new CaptureQueryOperations(
      evidenceRoot,
      <T>(runId: string, operation: () => Promise<T>) => this.evidence.guardRunMutation(runId, operation),
    );
    this.variables = new VariableAccessRouter(this.targets, this.artifacts, this.direct, this.hss);
    this.sequence = new DebugSequenceExecutor(this.variables, this.hss);
    this.server = new McpServer({ name: "jlink-mcp", version: JLINK_MCP_VERSION });
    this.registerTools();
    this.registerResources();
  }

  private registerTools(): void {
    const register = this.registerEnvelopeTool.bind(this) as RegisterEnvelopeTool;
    registerTargetTools(register, {
      discoveryProbe: this.discoveryProbe,
      direct: this.direct,
      runtimes: this.runtimes,
      artifacts: this.artifacts,
      variables: this.variables,
      registers: this.registers,
    });

    registerSessionTools(register, {
      targets: this.targets,
      sessions: this.sessions,
      direct: this.direct,
    });

    registerHssTools(register, { hss: this.hss, sequence: this.sequence });
    registerCaptureTools(register, { captures: this.captures });

    const missing = AGENT_TOOL_NAMES.filter((name) => !this.implemented.has(name));
    if (missing.length) throw new Error(`missing concrete MCP tool handlers: ${missing.join(", ")}`);
  }

  private registerEnvelopeTool(
    name: AgentToolName,
    inputSchema: Record<string, z.ZodType>,
    handler: (input: Record<string, unknown>, signal?: AbortSignal) => OperationEnvelope | Promise<OperationEnvelope>,
  ): void {
    if (this.implemented.has(name)) throw new Error(`duplicate MCP tool handler: ${name}`);
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
