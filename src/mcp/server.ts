import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProbeBackend } from "../probe/backend";
import { createProbeBackend, type ProbeFactoryConfig } from "../probe/factory";
import { log } from "../utils/logger";
import { ProcessManager } from "../utils/process-manager";
import { AcceptanceEvidenceStore, readRepositoryIdentity } from "./acceptance/evidence";
import { DirectMcuService } from "./runtime/direct-operations";
import { ArtifactVariableService } from "./runtime/artifact-operations";
import { SvdRegisterService } from "./runtime/svd-operations";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "./runtime/operation-envelope";
import { ProbeQueue } from "./runtime/probe-queue";
import { MemorySessionManager } from "./runtime/memory-session";
import { SessionOperations } from "./runtime/session-operations";
import { TargetRuntimeRegistry } from "./runtime/target-runtime";
import { TargetStore } from "./runtime/target-store";
import { HssOperations } from "./runtime/hss-operations";
import { DebugSequenceExecutor } from "./runtime/debug-sequence";
import { VariableAccessRouter } from "./runtime/variable-access-router";
import { CaptureQueryOperations } from "./runtime/capture-query-operations";
import { OperationDetailStore, type OperationDetailPutResult } from "./runtime/operation-detail-store";
import { TaskOperations } from "./runtime/task-operations";
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
import { registerTaskTools } from "./tools/register-task-tools";
import {
  ADVANCED_TOOL_NAMES,
  COMPACT_TOOL_NAMES,
  TASK_TOOL_DESCRIPTIONS,
  type RegisterTaskTool,
  type TaskToolName,
} from "./tools/task-tool-contract";
import { DEFAULT_MCP_PROFILE, type McpProfile, usesLegacySurface } from "./profile";
import { DEFAULT_MCP_RESULT_MODE, type McpResultMode } from "./result-mode";
import { operationToolResult } from "./runtime/operation-result";
import { JLINK_MCP_VERSION } from "./version";

export { AGENT_TOOL_NAMES } from "./tools/tool-contract";
export { ADVANCED_TOOL_NAMES, COMPACT_TOOL_NAMES } from "./tools/task-tool-contract";
export { MCP_PROFILES, parseMcpProfile } from "./profile";
export { MCP_RESULT_MODES, parseMcpResultMode } from "./result-mode";

export interface JLinkMcpServerOptions {
  cwd?: string;
  storageRoot?: string;
  evidenceRoot?: string;
  queueRoot?: string;
  profile?: McpProfile;
  resultMode?: McpResultMode;
}

interface ProjectContext {
  projectRoot: string;
  stateRoot: string;
  evidenceRoot: string;
  targets: TargetStore;
  direct: DirectMcuService;
  artifacts: ArtifactVariableService;
  variables: VariableAccessRouter;
  registers: SvdRegisterService;
  sessions: SessionOperations;
  hss: HssOperations;
  captures: CaptureQueryOperations;
  sequence: DebugSequenceExecutor;
  evidence: AcceptanceEvidenceStore;
}

class ProjectInitializationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectInitializationError";
  }
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
  private readonly queue: ProbeQueue;
  private readonly memorySessions: MemorySessionManager;
  private readonly runtimes = new TargetRuntimeRegistry();
  private readonly options: JLinkMcpServerOptions;
  private readonly profile: McpProfile;
  private readonly resultMode?: McpResultMode;
  private readonly operationDetails = new OperationDetailStore();
  private projectContext?: ProjectContext;
  private readonly implemented = new Set<string>();

  constructor(probeConfig?: ProbeFactoryConfig, options: JLinkMcpServerOptions = {}) {
    this.options = options;
    this.profile = options.profile ?? DEFAULT_MCP_PROFILE;
    this.resultMode = options.resultMode;
    this.discoveryProbe = createProbeBackend(probeConfig ?? { type: "jlink" }, this.discoveryProcesses);
    this.queue = new ProbeQueue(options.queueRoot);
    this.memorySessions = new MemorySessionManager(this.queue);
    this.server = new McpServer({ name: "jlink-mcp", version: JLINK_MCP_VERSION });
    this.registerTools();
    this.registerResources();
  }

  private registerTools(): void {
    if (!usesLegacySurface(this.profile)) {
      this.registerTaskSurface();
      return;
    }
    this.registerLegacySurface();
  }

  private registerLegacySurface(): void {
    const register = this.registerEnvelopeTool.bind(this) as RegisterEnvelopeTool;
    register("mcp_init", {
      projectRoot: z.string().min(1).describe("Existing absolute root of the engineering project to initialize for this MCP process."),
    }, (input) => this.initializeProject(String(input.projectRoot)));

    const current = () => this.requireProjectContext();
    registerTargetTools(register, {
      discoveryProbe: this.discoveryProbe,
      get direct() { return current().direct; },
      runtimes: this.runtimes,
      get artifacts() { return current().artifacts; },
      get variables() { return current().variables; },
      get registers() { return current().registers; },
    });

    registerSessionTools(register, {
      get targets() { return current().targets; },
      get sessions() { return current().sessions; },
      get direct() { return current().direct; },
    });

    registerHssTools(register, {
      get hss() { return current().hss; },
      get sequence() { return current().sequence; },
    });
    registerCaptureTools(register, { get captures() { return current().captures; } });

    const missing = AGENT_TOOL_NAMES.filter((name) => !this.implemented.has(name));
    if (missing.length) throw new Error(`missing concrete MCP tool handlers: ${missing.join(", ")}`);
  }

  private registerTaskSurface(): void {
    const current = () => this.requireProjectContext();
    const operations = new TaskOperations({
      discoveryProbe: this.discoveryProbe,
      get targets() { return current().targets; },
      get direct() { return current().direct; },
      runtimes: this.runtimes,
      get artifacts() { return current().artifacts; },
      get variables() { return current().variables; },
      get registers() { return current().registers; },
      get sessions() { return current().sessions; },
      get hss() { return current().hss; },
      get captures() { return current().captures; },
      get sequence() { return current().sequence; },
    });
    const register = this.registerTaskTool.bind(this) as RegisterTaskTool;
    registerTaskTools(register, {
      operations,
      getProjectRoot: () => current().projectRoot,
      project: (action, projectRoot, params, signal) => this.handleTaskProject(operations, action, projectRoot, params, signal),
    }, this.profile === "advanced");
    const expected = this.profile === "advanced" ? ADVANCED_TOOL_NAMES : COMPACT_TOOL_NAMES;
    const missing = expected.filter((name) => !this.implemented.has(name));
    if (missing.length) throw new Error(`missing compact MCP tool handlers: ${missing.join(", ")}`);
  }

  private registerEnvelopeTool(
    name: AgentToolName,
    inputSchema: Record<string, z.ZodType>,
    handler: (input: Record<string, unknown>, signal?: AbortSignal) => OperationEnvelope | Promise<OperationEnvelope>,
  ): void {
    if (this.implemented.has(name)) throw new Error(`duplicate MCP tool handler: ${name}`);
    this.implemented.add(name);
    const schemaWithRunId = name === "mcp_init" || Object.hasOwn(inputSchema, "runId")
      ? inputSchema
      : { ...inputSchema, runId: acceptanceRunId.optional() };
    this.server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: schemaWithRunId }, async (input, extra) => {
      const gateFailure = this.projectGateFailure(name, input as Record<string, unknown>);
      if (gateFailure) return this.wireToolResult(gateFailure);
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
          const recorded = await this.requireProjectContext().evidence.executeAndRecordMcpCommand(requestedRunId, name, input as Record<string, unknown>, execute);
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
      return this.wireToolResult(envelope);
    });
  }

  private registerTaskTool(
    name: TaskToolName,
    inputSchema: Record<string, z.ZodType>,
    handler: (input: Record<string, unknown>, signal?: AbortSignal) => OperationEnvelope | Promise<OperationEnvelope>,
  ): void {
    if (this.implemented.has(name)) throw new Error(`duplicate MCP tool handler: ${name}`);
    this.implemented.add(name);
    this.server.registerTool(name, { description: TASK_TOOL_DESCRIPTIONS[name], inputSchema }, async (input, extra) => {
      if (name !== "project" && !this.projectContext) {
        return this.taskToolResult(failEnvelope(createOperationEnvelope(name), {
          code: "PROJECT_NOT_BOUND",
          stage: "project_binding",
          message: "call project with action=bind or configure before using project-scoped tools",
          retryable: false,
          writeIssued: false,
          stateUnknown: false,
        }));
      }
      let envelope: OperationEnvelope;
      try {
        envelope = await handler(input as Record<string, unknown>, extra.signal);
      } catch (error) {
        envelope = failEnvelope(createOperationEnvelope(name), {
          code: /\.params\.|unsupported action|bound project root/.test(error instanceof Error ? error.message : String(error))
            ? "ACTION_INPUT_INVALID"
            : "INTERNAL_ERROR",
          stage: "dispatch",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          writeIssued: false,
          stateUnknown: false,
        });
      }
      return this.taskToolResult(envelope);
    });
  }

  private taskToolResult(envelope: OperationEnvelope) {
    return this.wireToolResult(envelope);
  }

  private wireToolResult(envelope: OperationEnvelope) {
    const mode = this.resultMode ?? DEFAULT_MCP_RESULT_MODE;
    let diagnosticRef: string | undefined;
    if (mode === "normal" && (!envelope.ok || envelope.error?.stateUnknown === true)) {
      const stored = this.operationDetails.put(envelope);
      if (stored.available) diagnosticRef = `jlink://operation/${envelope.operationId}`;
    }
    return operationToolResult(envelope, mode, diagnosticRef);
  }

  private async handleTaskProject(
    operations: TaskOperations,
    action: string,
    requestedRoot: string | undefined,
    params: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<OperationEnvelope> {
    if (action === "devices") return operations.project(action, undefined, params);
    const initialized = await this.bindTaskProject(requestedRoot);
    if (!initialized.ok || action === "bind") return relabelTaskEnvelope(initialized, "project");
    return operations.project(action, this.requireProjectContext().projectRoot, params);
  }

  private async bindTaskProject(requestedRoot: string | undefined): Promise<OperationEnvelope> {
    if (requestedRoot) return this.initializeProject(requestedRoot);
    if (this.projectContext) return this.initializeProject(this.projectContext.projectRoot);
    let roots: string[] | undefined;
    try { roots = await this.clientProjectRoots(); }
    catch (error) {
      return projectBindingFailure(error);
    }
    if (!roots || roots.length !== 1) {
      const envelope = createOperationEnvelope("project");
      envelope.data = { clientProjectRoots: roots ?? [], rootCount: roots?.length ?? 0 };
      return failEnvelope(envelope, {
        code: "PROJECT_ROOT_REQUIRED",
        stage: "project_binding",
        message: "provide projectRoot because the MCP client did not declare exactly one usable file workspace root",
        retryable: false,
        writeIssued: false,
        stateUnknown: false,
      });
    }
    return this.initializeProject(roots[0]);
  }

  private async initializeProject(projectRootInput: string): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope("mcp_init");
    envelope.requestedEffects = ["initialize_project_local_mcp_state"];
    let initializationWriteIssued = false;
    try {
      const projectRoot = canonicalProjectRoot(projectRootInput);
      if (this.projectContext) {
        if (pathKey(this.projectContext.projectRoot) !== pathKey(projectRoot)) {
          throw new ProjectInitializationError(
            "MCP_ALREADY_INITIALIZED",
            "this MCP process is already initialized for " + this.projectContext.projectRoot,
            { initializedProjectRoot: this.projectContext.projectRoot, requestedProjectRoot: projectRoot },
          );
        }
        envelope.data = projectContextData(this.projectContext, false);
        envelope.verification = { status: "verified", method: "canonical_project_root_match" };
        return finishEnvelope(envelope, true);
      }

      await this.assertClientProjectRoot(projectRoot);
      const initializedAncestor = findInitializedAncestor(projectRoot);
      if (initializedAncestor) {
        throw new ProjectInitializationError(
          "PROJECT_NESTED_UNDER_INITIALIZED_ROOT",
          "projectRoot is nested under an existing .jlink-mcp root: " + initializedAncestor,
          { initializedProjectRoot: initializedAncestor, requestedProjectRoot: projectRoot },
        );
      }

      const stateRoot = resolve(this.options.storageRoot ?? join(projectRoot, ".jlink-mcp"));
      const evidenceRoot = resolve(this.options.evidenceRoot ?? join(projectRoot, "test-output"));
      const stateRootExisted = existsSync(stateRoot);
      const targets = new TargetStore(stateRoot);
      initializationWriteIssued = true;
      const direct = new DirectMcuService(targets, this.queue, (target) => this.runtimes.get(target), undefined, this.memorySessions);
      const artifacts = new ArtifactVariableService(targets);
      const registers = new SvdRegisterService(targets, direct);
      const sessions = new SessionOperations(targets, this.queue, (target) => this.runtimes.get(target), this.memorySessions);
      const evidence = new AcceptanceEvidenceStore(evidenceRoot, readRepositoryIdentity(projectRoot).commit);
      const hss = new HssOperations(
        targets,
        this.queue,
        artifacts,
        undefined,
        evidenceRoot,
        stateRoot,
        undefined,
        this.memorySessions,
        this.profile === "acceptance",
      );
      const captures = new CaptureQueryOperations(
        evidenceRoot,
        <T>(runId: string, operation: () => Promise<T>) => evidence.guardRunMutation(runId, operation),
      );
      const variables = new VariableAccessRouter(targets, artifacts, direct, hss);
      const sequence = new DebugSequenceExecutor(variables, hss);
      this.projectContext = {
        projectRoot,
        stateRoot,
        evidenceRoot,
        targets,
        direct,
        artifacts,
        variables,
        registers,
        sessions,
        hss,
        captures,
        sequence,
        evidence,
      };
      if (!stateRootExisted) envelope.observedEffects.push("project_state_root_created");
      envelope.observedEffects.push("project_context_initialized");
      envelope.data = projectContextData(this.projectContext, !stateRootExisted);
      envelope.verification = { status: "verified", method: "canonical_project_root_and_lazy_output_initialization" };
      return finishEnvelope(envelope, true);
    } catch (error) {
      const initializationError = error instanceof ProjectInitializationError ? error : undefined;
      if (initializationError?.details) envelope.data = initializationError.details;
      return failEnvelope(envelope, {
        code: initializationError?.code ?? "PROJECT_INITIALIZATION_FAILED",
        stage: "project_initialization",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        writeIssued: initializationWriteIssued,
        stateUnknown: false,
      });
    }
  }

  private async assertClientProjectRoot(projectRoot: string): Promise<void> {
    const roots = await this.clientProjectRoots();
    if (!roots) return;
    if (roots.length && !roots.some((root) => pathKey(root) === pathKey(projectRoot))) {
      throw new ProjectInitializationError(
        "PROJECT_ROOT_NOT_CLIENT_ROOT",
        "projectRoot must exactly match one of the workspace roots declared by the MCP client",
        { requestedProjectRoot: projectRoot, clientProjectRoots: roots },
      );
    }
  }

  private async clientProjectRoots(): Promise<string[] | undefined> {
    if (!this.server.server.getClientCapabilities()?.roots) return undefined;
    try {
      const listed = await this.server.server.listRoots();
      return [...new Set(listed.roots.flatMap(({ uri }) => {
        try { return uri.startsWith("file:") ? [canonicalProjectRoot(fileURLToPath(uri))] : []; }
        catch { return []; }
      }))];
    } catch (error) {
      throw new ProjectInitializationError(
        "CLIENT_ROOTS_UNAVAILABLE",
        "the MCP client declared workspace roots but they could not be read: " + (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  private projectGateFailure(name: AgentToolName, input: Record<string, unknown>): OperationEnvelope | undefined {
    if (name === "mcp_init" || (name === "list_devices" && typeof input.runId !== "string")) return undefined;
    if (!this.projectContext) {
      return failEnvelope(createOperationEnvelope(name), {
        code: "PROJECT_NOT_INITIALIZED",
        stage: "project_initialization",
        message: "call mcp_init with the absolute engineering project root before using project-scoped tools",
        retryable: false,
        writeIssued: false,
        stateUnknown: false,
      });
    }
    if (typeof input.projectRoot !== "string") return undefined;
    try {
      const requestedRoot = canonicalProjectRoot(input.projectRoot);
      if (pathKey(requestedRoot) === pathKey(this.projectContext.projectRoot)) return undefined;
      const envelope = createOperationEnvelope(name);
      envelope.data = { initializedProjectRoot: this.projectContext.projectRoot, requestedProjectRoot: requestedRoot };
      return failEnvelope(envelope, {
        code: "PROJECT_ROOT_MISMATCH",
        stage: "project_initialization",
        message: "projectRoot does not match the root selected by mcp_init",
        retryable: false,
        writeIssued: false,
        stateUnknown: false,
      });
    } catch (error) {
      return failEnvelope(createOperationEnvelope(name), {
        code: "INVALID_PROJECT_ROOT",
        stage: "project_initialization",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        writeIssued: false,
        stateUnknown: false,
      });
    }
  }

  private requireProjectContext(): ProjectContext {
    if (!this.projectContext) {
      throw new ProjectInitializationError("PROJECT_NOT_INITIALIZED", "call mcp_init before using project-scoped tools");
    }
    return this.projectContext;
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

    if ((this.resultMode ?? DEFAULT_MCP_RESULT_MODE) === "normal") {
      this.server.resource(
        "operation-detail",
        new ResourceTemplate("jlink://operation/{operationId}", { list: undefined }),
        { description: "Full bounded process-local diagnostics for a failed or uncertain normal result", mimeType: "application/json" },
        async (uri, variables) => {
          const operationId = String(variables.operationId ?? "");
          const text = this.operationDetails.get(operationId)
            ?? JSON.stringify({ ok: false, error: { code: "OPERATION_DETAIL_NOT_FOUND", message: "detail expired or is not owned by this MCP process" } });
          return { contents: [{ uri: uri.toString(), text, mimeType: "application/json" }] };
        },
      );
    }
  }

  private compactToolResult(envelope: OperationEnvelope) {
    const detail = this.operationDetails.put(envelope);
    return compactToolResult(envelope, detail);
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

function canonicalProjectRoot(projectRoot: string): string {
  if (!projectRoot || !isAbsolute(projectRoot)) {
    throw new ProjectInitializationError("INVALID_PROJECT_ROOT", "projectRoot must be an existing absolute directory");
  }
  let canonical: string;
  try { canonical = normalize(realpathSync.native(projectRoot)); }
  catch { throw new ProjectInitializationError("PROJECT_ROOT_NOT_FOUND", "projectRoot does not exist: " + projectRoot); }
  if (!statSync(canonical).isDirectory()) {
    throw new ProjectInitializationError("INVALID_PROJECT_ROOT", "projectRoot must identify a directory");
  }
  return canonical;
}

function findInitializedAncestor(projectRoot: string): string | undefined {
  let current = dirname(projectRoot);
  while (true) {
    const marker = join(current, ".jlink-mcp");
    if (existsSync(marker) && statSync(marker).isDirectory()) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function pathKey(path: string): string {
  return process.platform === "win32" ? normalize(path).toLowerCase() : normalize(path);
}

function projectContextData(context: ProjectContext, stateRootCreated: boolean): Record<string, unknown> {
  return {
    projectRoot: context.projectRoot,
    stateRoot: context.stateRoot,
    evidenceRoot: context.evidenceRoot,
    stateRootCreated,
    evidenceRootCreated: false,
  };
}

const COMPACT_RESULT_MAX_BYTES = 6 * 1024;

export function compactToolResult(
  envelope: OperationEnvelope,
  detail: OperationDetailPutResult = { available: true, complete: true, storedBytes: 0 },
) {
  const detailsUri = `jlink://operation/${envelope.operationId}`;
  const result: Record<string, unknown> = {
    ok: envelope.ok,
    operationId: envelope.operationId,
    tool: envelope.tool,
    verification: compactVerification(envelope.verification),
    data: boundedCompactData(envelope.data, 2_048),
    detailsUri,
  };
  if (envelope.requestedEffects.length) result.requestedEffects = envelope.requestedEffects.slice(0, 6).map((effect) => truncate(effect, 120));
  if (envelope.observedEffects.length) result.observedEffects = envelope.observedEffects.slice(0, 6).map((effect) => truncate(effect, 120));
  if (envelope.outputFiles.length) result.outputFiles = envelope.outputFiles.slice(0, 4).map((path) => truncate(path, 200));
  if (envelope.warnings.length) result.warnings = envelope.warnings.slice(0, 4).map((warning) => truncate(warning, 200));
  if (!detail.complete) result.details = {
    available: detail.available,
    complete: false,
    storedBytes: detail.storedBytes,
    originalBytes: detail.originalBytes,
    reason: detail.reason,
  };
  if (envelope.error) result.error = {
    code: truncate(envelope.error.code, 96),
    stage: truncate(envelope.error.stage, 96),
    message: truncate(envelope.error.message, 512),
    retryable: envelope.error.retryable,
    writeIssued: envelope.error.writeIssued,
    stateUnknown: envelope.error.stateUnknown,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > COMPACT_RESULT_MAX_BYTES) {
    result.data = { omitted: true, reason: "compact_result_budget", detailsUri };
    result.verification = {
      status: truncate(envelope.verification.status, 96),
      method: envelope.verification.method ? truncate(envelope.verification.method, 160) : undefined,
      detailsOmitted: envelope.verification.details !== undefined,
    };
  }
  return {
    isError: !envelope.ok,
    content: [{
      type: "text" as const,
      text: `${envelope.ok ? "OK" : "ERROR"} ${envelope.tool} ${envelope.operationId}; details: ${detailsUri}`,
    }],
    structuredContent: result,
  };
}

function boundedCompactData(data: unknown, maxBytes: number): unknown {
  let json: string;
  try { json = JSON.stringify(data) ?? "null"; }
  catch { return { omitted: true, reason: "not_json_serializable" }; }
  const bytes = Buffer.byteLength(json);
  if (bytes <= maxBytes) return data;
  return { omitted: true, reason: "available_via_details_uri", byteLength: bytes };
}

function compactVerification(verification: OperationEnvelope["verification"]): Record<string, unknown> {
  const result: Record<string, unknown> = { status: truncate(verification.status, 96) };
  if (verification.method) result.method = truncate(verification.method, 160);
  if (verification.details !== undefined) result.details = boundedCompactData(verification.details, 512);
  return result;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function relabelTaskEnvelope(envelope: OperationEnvelope, tool: string): OperationEnvelope {
  envelope.tool = tool;
  return envelope;
}

function projectBindingFailure(error: unknown): OperationEnvelope {
  const envelope = createOperationEnvelope("project");
  const initializationError = error instanceof ProjectInitializationError ? error : undefined;
  if (initializationError?.details) envelope.data = initializationError.details;
  return failEnvelope(envelope, {
    code: initializationError?.code ?? "PROJECT_BINDING_FAILED",
    stage: "project_binding",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    writeIssued: false,
    stateUnknown: false,
  });
}
