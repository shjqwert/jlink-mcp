import type { ProbeBackend } from "../../probe/backend";
import { ArtifactVariableService } from "./artifact-operations";
import {
  DirectMcuService,
  type CoreRegisterWriteInput,
  type EraseInput,
  type FlashInput,
  type MemoryReadInput,
  type MemoryWriteInput,
  type ProbeCommandInput,
} from "./direct-operations";
import { DebugSequenceExecutor, type DebugSequenceInput } from "./debug-sequence";
import { HssOperations, type HssCaptureInput } from "./hss-operations";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "./operation-envelope";
import { CaptureQueryOperations, type CaptureEventWindowInput, type CaptureSeriesInput } from "./capture-query-operations";
import { SessionOperations } from "./session-operations";
import { SvdRegisterService, type RegisterWriteInput } from "./svd-operations";
import { TargetRuntimeRegistry } from "./target-runtime";
import { TargetStore, type TargetConfigureInput } from "./target-store";
import type { VariableWriteInput } from "./variable-access-contract";
import { VariableAccessRouter } from "./variable-access-router";
import { diagnoseCrash, gdbOpen } from "../tools/register-session-tools";
import { listDevices } from "../tools/register-target-tools";
import { relabelEnvelope } from "../tools/tool-envelope";

export interface TaskOperationServices {
  discoveryProbe: ProbeBackend;
  targets: TargetStore;
  direct: DirectMcuService;
  runtimes: TargetRuntimeRegistry;
  artifacts: ArtifactVariableService;
  variables: VariableAccessRouter;
  registers: SvdRegisterService;
  sessions: SessionOperations;
  hss: HssOperations;
  captures: CaptureQueryOperations;
  sequence: DebugSequenceExecutor;
}

export class TaskOperations {
  constructor(private readonly services: TaskOperationServices) {}

  async project(action: string, projectRoot: string | undefined, params: Record<string, unknown>): Promise<OperationEnvelope> {
    if (action === "devices") return relabelEnvelope(await listDevices(this.services.discoveryProbe), "project");
    const root = requireProjectRoot("project", projectRoot);
    if (action === "configure") {
      const result = await this.services.direct.configure({
        ...pickParams(params, [
          "device", "gdbDevice", "probeSerial", "interface", "speed", "artifactPath", "mapPath", "svdPath",
          "jlinkPath", "gdbServerPath", "gdbPath", "ports", "artifactFlashImages", "memoryRegions",
        ]),
        projectRoot: root,
      } as unknown as TargetConfigureInput);
      const previousGeneration = typeof result.before?.targetGeneration === "string"
        ? result.before.targetGeneration
        : undefined;
      if (
        result.ok
        && result.target
        && previousGeneration
        && await this.services.runtimes.invalidate(result.target.projectRoot, previousGeneration)
      ) result.observedEffects.push("process_local_target_runtime_disposed");
      return relabelEnvelope(result, "project");
    }
    if (action === "status") return relabelEnvelope(await this.services.direct.status(root), "project");
    if (action === "verify") return relabelEnvelope(await this.services.direct.verifyFirmware(root), "project");
    if (action === "artifacts") {
      return relabelEnvelope(await this.services.artifacts.artifactProbe({
        ...pickParams(params, ["explicitArtifact", "explicitMap", "maxFiles", "maxDepth", "maxCandidates"]),
        projectRoot: root,
      } as never), "project");
    }
    return invalidAction("project", action);
  }

  async inspect(projectRoot: string, action: string, params: Record<string, unknown>): Promise<OperationEnvelope> {
    if (action === "symbol_search") {
      return relabelEnvelope(await this.services.artifacts.symbolSearch(
        projectRoot,
        requireString("inspect", params, "query"),
        optionalInteger(params.limit, 64),
      ), "inspect");
    }
    if (action === "symbol_resolve") {
      return relabelEnvelope(await this.services.artifacts.symbolResolve(
        projectRoot,
        requireString("inspect", params, "selector"),
      ), "inspect");
    }
    if (action === "variable") {
      return relabelEnvelope(await this.services.variables.readVariable(
        projectRoot,
        requireString("inspect", params, "ref"),
      ), "inspect");
    }
    if (action === "memory") {
      return relabelEnvelope(await this.services.direct.readMemory({
        ...pickParams(params, ["address", "width", "byteCount"]),
        projectRoot,
      } as unknown as MemoryReadInput), "inspect");
    }
    if (action === "core") {
      const name = optionalString(params.name);
      const result = name
        ? await this.services.direct.readCoreRegister(projectRoot, name)
        : await this.services.direct.readCoreRegisters(projectRoot);
      return relabelEnvelope(result, "inspect");
    }
    if (action === "peripheral") {
      const selectors = Array.isArray(params.selectors)
        ? params.selectors.map(String)
        : [requireString("inspect", params, "selector")];
      const result = selectors.length === 1
        ? await this.services.registers.readRegister(projectRoot, selectors[0])
        : await this.services.registers.readRegisters(projectRoot, selectors);
      return relabelEnvelope(result, "inspect");
    }
    return invalidAction("inspect", action);
  }

  async write(projectRoot: string, action: string, params: Record<string, unknown>): Promise<OperationEnvelope> {
    if (action === "variable") {
      return relabelEnvelope(await this.services.variables.writeVariable({
        ...pickParams(params, ["ref", "value", "captureOld", "verify", "restore", "verificationConnection", "comparator"]),
        projectRoot,
      } as unknown as VariableWriteInput), "write");
    }
    if (action === "memory") {
      return relabelEnvelope(await this.services.direct.writeMemory({
        ...pickParams(params, ["address", "width", "byteCount", "dataHex", "captureOld", "verify"]),
        projectRoot,
      } as unknown as MemoryWriteInput), "write");
    }
    if (action === "core") {
      return relabelEnvelope(await this.services.direct.writeCoreRegister({
        ...pickParams(params, ["name", "value", "verify", "verificationConnection"]),
        projectRoot,
      } as unknown as CoreRegisterWriteInput), "write");
    }
    if (action === "peripheral") {
      return relabelEnvelope(await this.services.registers.writeRegister({
        ...pickParams(params, ["selector", "value", "captureOld", "verify", "restore", "comparator"]),
        projectRoot,
      } as unknown as RegisterWriteInput), "write");
    }
    return invalidAction("write", action);
  }

  async control(projectRoot: string, action: string): Promise<OperationEnvelope> {
    if (!["halt", "resume", "reset", "reset_halt"].includes(action)) return invalidAction("control", action);
    return relabelEnvelope(await this.services.direct.control(
      action as "halt" | "resume" | "reset" | "reset_halt",
      projectRoot,
    ), "control");
  }

  async program(projectRoot: string, action: string, params: Record<string, unknown>): Promise<OperationEnvelope> {
    if (action === "flash") {
      return relabelEnvelope(await this.services.direct.flash({
        ...pickParams(params, ["path", "baseAddress"]),
        projectRoot,
      } as unknown as FlashInput), "program");
    }
    if (action === "erase") {
      return relabelEnvelope(await this.services.direct.erase({
        ...pickParams(params, ["verifyBlank"]),
        projectRoot,
      } as unknown as EraseInput), "program");
    }
    return invalidAction("program", action);
  }

  async debug(projectRoot: string, action: string, params: Record<string, unknown>): Promise<OperationEnvelope> {
    if (action === "open") {
      return relabelEnvelope(await gdbOpen(
        this.services,
        projectRoot,
        optionalBoolean(params.restoreRunningStateAfterAttach, false),
      ), "debug");
    }
    if (action === "run_to") return this.runTo(projectRoot, params);
    if (action === "breakpoints") {
      return relabelEnvelope(await this.services.sessions.gdbBreakpointList(
        projectRoot,
        optionalInteger(params.timeoutMs, 15_000),
      ), "debug");
    }
    if (action === "delete_breakpoint") {
      return relabelEnvelope(await this.services.sessions.gdbBreakpointDelete(
        projectRoot,
        requireInteger("debug", params, "breakpointId"),
        optionalInteger(params.timeoutMs, 15_000),
      ), "debug");
    }
    if (action === "wait") {
      return relabelEnvelope(await this.services.sessions.gdbWait(
        projectRoot,
        optionalInteger(params.timeoutMs, 30_000),
      ), "debug");
    }
    if (action === "backtrace") {
      return relabelEnvelope(await this.services.sessions.gdbBacktrace(
        projectRoot,
        optionalBoolean(params.full, false),
      ), "debug");
    }
    if (action === "close") {
      return relabelEnvelope(await this.services.sessions.gdbServerStop(projectRoot), "debug");
    }
    return invalidAction("debug", action);
  }

  async trace(projectRoot: string, action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<OperationEnvelope> {
    if (action === "rtt_window") return this.rttWindow(projectRoot, params, signal);
    if (action === "rtt_open") return relabelEnvelope(await this.services.sessions.rttConnect(projectRoot), "trace");
    if (action === "rtt_read") {
      return relabelEnvelope(await this.services.sessions.rttRead(projectRoot, optionalInteger(params.count, 50)), "trace");
    }
    if (action === "rtt_search") {
      return relabelEnvelope(await this.services.sessions.rttSearch(projectRoot, {
        level: optionalString(params.level),
        module: optionalString(params.module),
        pattern: optionalString(params.pattern),
        count: optionalInteger(params.count, 100),
      }), "trace");
    }
    if (action === "rtt_clear") return relabelEnvelope(await this.services.sessions.rttClear(projectRoot), "trace");
    if (action === "rtt_close") return relabelEnvelope(await this.services.sessions.rttDisconnect(projectRoot), "trace");
    if (action === "hss_window") {
      const durationSec = optionalInteger(params.durationSec, 1);
      if (durationSec < 1 || durationSec > 30) return inputFailure("trace", "params.durationSec must be 1..30 for hss_window");
      if (!Array.isArray(params.variables) || params.variables.length === 0) {
        return inputFailure("trace", "params.variables must contain at least one typed variable selector");
      }
      const capture = {
        ...pickParams(params, ["variables", "writeVariables", "rateHz", "qualityOracle"]),
        durationSec,
      } as unknown as Omit<HssCaptureInput, "projectRoot" | "dryRun" | "runId">;
      const sequence: DebugSequenceInput = {
        projectRoot,
        steps: [
          { atMs: 0, action: "hss_start", ...capture },
          { atMs: durationSec * 1_000, action: "hss_stop" },
        ],
        cleanup: [{ action: "hss_stop" }],
        timeoutMs: Math.min(60_000, durationSec * 1_000 + 30_000),
      };
      return relabelEnvelope(await this.services.sequence.execute(sequence, signal), "trace");
    }
    if (action === "hss_start") {
      return relabelEnvelope(await this.services.hss.start({
        ...pickParams(params, ["variables", "writeVariables", "rateHz", "durationSec", "qualityOracle", "dryRun"]),
        projectRoot,
      } as unknown as HssCaptureInput), "trace");
    }
    if (action === "hss_status") return relabelEnvelope(await this.services.hss.status({ projectRoot, captureId: optionalString(params.captureId) }), "trace");
    if (action === "hss_stop") return relabelEnvelope(await this.services.hss.stop({ projectRoot, captureId: optionalString(params.captureId) }), "trace");
    if (action === "hss_recover") return relabelEnvelope(await this.services.hss.recover({ projectRoot, captureId: optionalString(params.captureId) }), "trace");
    return invalidAction("trace", action);
  }

  async capture(action: string, params: Record<string, unknown>): Promise<OperationEnvelope> {
    if (action === "list") return relabelEnvelope(await this.services.captures.list(pickParams(params, ["limit", "cursor"])), "capture");
    if (action === "summary") return relabelEnvelope(await this.services.captures.summary(requireString("capture", params, "captureId")), "capture");
    if (action === "series") return relabelEnvelope(await this.services.captures.series(
      pickParams(params, ["captureId", "variables", "startTick", "endTick", "bucketCount"]) as unknown as CaptureSeriesInput,
    ), "capture");
    if (action === "event_window") return relabelEnvelope(await this.services.captures.eventWindow(
      pickParams(params, ["captureId", "eventId", "variables", "beforeMs", "afterMs", "bucketCount"]) as unknown as CaptureEventWindowInput,
    ), "capture");
    if (action === "export_csv") return relabelEnvelope(await this.services.captures.exportCsv(requireString("capture", params, "captureId")), "capture");
    return invalidAction("capture", action);
  }

  diagnoseCrash(projectRoot: string): Promise<OperationEnvelope> {
    return diagnoseCrash(this.services, projectRoot);
  }

  async raw(projectRoot: string, action: string, params: Record<string, unknown>): Promise<OperationEnvelope> {
    if (action === "gdb") {
      return relabelEnvelope(await this.services.sessions.gdbCommand(
        projectRoot,
        requireString("raw", params, "command"),
        optionalInteger(params.timeoutMs, 15_000),
      ), "raw");
    }
    if (action === "probe") {
      return relabelEnvelope(await this.services.direct.probeCommand({
        ...pickParams(params, ["commands"]),
        projectRoot,
      } as unknown as ProbeCommandInput), "raw");
    }
    return invalidAction("raw", action);
  }

  private async runTo(projectRoot: string, params: Record<string, unknown>): Promise<OperationEnvelope> {
    const location = requireString("debug", params, "location");
    if (!/^[^\s"\\]{1,512}$/.test(location)) {
      return inputFailure("debug", "params.location must be one bounded GDB symbol, address, or file:line token without whitespace");
    }
    const timeoutMs = optionalInteger(params.timeoutMs, 30_000);
    const steps: OperationEnvelope[] = [];
    let cleanupRequired = false;
    try {
      const opened = await gdbOpen(this.services, projectRoot, false, true);
      steps.push(opened);
      if (opened.ok) {
        cleanupRequired = true;
        const breakpoint = await this.services.sessions.gdbCommand(projectRoot, `-break-insert -- ${location}`, 15_000);
        steps.push(breakpoint);
        if (breakpoint.ok) {
          const breakpointId = breakpointNumber(breakpoint);
          if (!breakpointId) {
            steps.push(taskFailure("debug", "DEBUG_BREAKPOINT_ID_MISSING", "managed_debug_workflow", "GDB inserted the managed breakpoint without returning its numeric identity", false, { writeIssued: true }));
            steps.push(await this.services.sessions.gdbAbortManagedBreakpoint(projectRoot, 15_000));
          } else {
            const resumeRequired = retainedManagedAttachHalt(opened);
            const resumed = resumeRequired
              ? await this.services.sessions.gdbCommand(projectRoot, "-exec-continue --all", 15_000)
              : undefined;
            if (resumed) steps.push(resumed);
            if (!resumed || resumed.ok) {
              const stopped = await this.services.sessions.gdbWait(projectRoot, timeoutMs);
              steps.push(stopped);
              if (managedBreakpointHit(stopped, breakpointId)) {
                steps.push(await this.services.sessions.gdbBacktrace(projectRoot, optionalBoolean(params.full, false)));
                const deleted = await this.services.sessions.gdbBreakpointDelete(projectRoot, breakpointId, 15_000);
                steps.push(deleted);
                if (deleted.ok) steps.push(await this.services.sessions.gdbBreakpointList(projectRoot, 15_000));
              } else {
                const stop = managedStopFacts(stopped);
                steps.push(taskFailure(
                  "debug",
                  stop.state === "running" ? "DEBUG_RUN_TO_TIMEOUT" : "DEBUG_RUN_TO_UNEXPECTED_STOP",
                  "managed_debug_workflow",
                  stop.state === "running"
                    ? `target did not reach managed breakpoint #${breakpointId} within ${timeoutMs}ms`
                    : `target stopped for ${stop.reason ?? "an unknown reason"}, not managed breakpoint #${breakpointId}`,
                  false,
                ));
                steps.push(await this.services.sessions.gdbAbortManagedBreakpoint(projectRoot, 15_000));
              }
            } else {
              steps.push(await this.services.sessions.gdbAbortManagedBreakpoint(projectRoot, 15_000));
            }
          }
        } else if (gdbCommandDispatched(breakpoint)) {
          steps.push(await this.services.sessions.gdbAbortManagedBreakpoint(projectRoot, 15_000));
        }
      }
    } catch (error) {
      cleanupRequired = true;
      steps.push(taskFailure(
        "debug",
        "DEBUG_WORKFLOW_EXCEPTION",
        "managed_debug_workflow",
        error instanceof Error ? error.message : String(error),
        false,
        { writeIssued: true, stateUnknown: true },
      ));
    } finally {
      if (cleanupRequired) {
        try { steps.push(await this.services.sessions.gdbServerStop(projectRoot)); }
        catch (error) {
          steps.push(taskFailure(
            "gdb_server_stop",
            "DEBUG_CLEANUP_EXCEPTION",
            "managed_debug_cleanup",
            error instanceof Error ? error.message : String(error),
            false,
            { stateUnknown: true },
          ));
        }
      }
    }
    return composeWorkflow("debug", { action: "run_to", location }, steps);
  }

  private async rttWindow(projectRoot: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<OperationEnvelope> {
    const durationMs = optionalInteger(params.durationMs, 1_000);
    if (durationMs < 0 || durationMs > 60_000) return inputFailure("trace", "params.durationMs must be 0..60000");
    const steps: OperationEnvelope[] = [];
    let wasConnected = false;
    let openedHere = false;
    try {
      wasConnected = await this.services.sessions.rttIsConnected(projectRoot);
      if (!wasConnected) {
        const opened = await this.services.sessions.rttConnect(projectRoot);
        steps.push(opened);
        openedHere = opened.ok;
      }
      if (wasConnected || openedHere) {
        await abortableDelay(durationMs, signal);
        const hasFilter = [params.level, params.module, params.pattern].some((value) => typeof value === "string");
        steps.push(hasFilter
          ? await this.services.sessions.rttSearch(projectRoot, {
            level: optionalString(params.level),
            module: optionalString(params.module),
            pattern: optionalString(params.pattern),
            count: optionalInteger(params.count, 100),
          })
          : await this.services.sessions.rttRead(projectRoot, optionalInteger(params.count, 100)));
      }
    } catch (error) {
      steps.push(taskFailure("trace", "RTT_WINDOW_CANCELLED", "wait", error instanceof Error ? error.message : String(error), true));
    } finally {
      if (openedHere) {
        try { steps.push(await this.services.sessions.rttDisconnect(projectRoot)); }
        catch (error) {
          steps.push(taskFailure(
            "rtt_disconnect",
            "RTT_CLEANUP_EXCEPTION",
            "rtt_cleanup",
            error instanceof Error ? error.message : String(error),
            true,
          ));
        }
      }
    }
    return composeWorkflow("trace", { action: "rtt_window", durationMs, preservedExistingSession: wasConnected }, steps);
  }
}

function requireProjectRoot(tool: string, projectRoot: string | undefined): string {
  if (!projectRoot) throw new Error(`${tool} requires a bound project root`);
  return projectRoot;
}

function requireString(tool: string, params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${tool}.params.${field} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireInteger(tool: string, params: Record<string, unknown>, field: string): number {
  const value = params[field];
  if (!Number.isSafeInteger(value)) throw new Error(`${tool}.params.${field} must be an integer`);
  return Number(value);
}

function optionalInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? Number(value) : fallback;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickParams(params: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of allowed) {
    if (Object.hasOwn(params, field)) result[field] = params[field];
  }
  return result;
}

function invalidAction(tool: string, action: string): OperationEnvelope {
  return inputFailure(tool, `unsupported action: ${action}`);
}

function inputFailure(tool: string, message: string): OperationEnvelope {
  return taskFailure(tool, "ACTION_INPUT_INVALID", "validation", message, false);
}

function taskFailure(
  tool: string,
  code: string,
  stage: string,
  message: string,
  retryable: boolean,
  options: { writeIssued?: boolean; stateUnknown?: boolean } = {},
): OperationEnvelope {
  return failEnvelope(createOperationEnvelope(tool), {
    code,
    stage,
    message,
    retryable,
    writeIssued: options.writeIssued ?? false,
    stateUnknown: options.stateUnknown ?? false,
  });
}

function composeWorkflow(
  tool: string,
  summary: Record<string, unknown>,
  steps: OperationEnvelope[],
): OperationEnvelope {
  const envelope = createOperationEnvelope(tool);
  const failed = steps.find((step) => !step.ok);
  for (const step of steps) {
    envelope.requestedEffects.push(...step.requestedEffects);
    envelope.observedEffects.push(...step.observedEffects);
    envelope.outputFiles.push(...step.outputFiles);
    envelope.warnings.push(...step.warnings);
    if (step.target) envelope.target = step.target;
    if (step.probe) envelope.probe = step.probe;
    if (step.artifact) envelope.artifact = step.artifact;
    if (step.svd) envelope.svd = step.svd;
    if (step.capture) envelope.capture = step.capture;
  }
  envelope.requestedEffects = distinct(envelope.requestedEffects);
  envelope.observedEffects = distinct(envelope.observedEffects);
  envelope.outputFiles = distinct(envelope.outputFiles);
  envelope.warnings = distinct(envelope.warnings);
  envelope.data = {
    ...summary,
    steps: steps.map((step) => ({
      tool: step.tool,
      operationId: step.operationId,
      ok: step.ok,
      verification: step.verification,
      before: step.before,
      after: step.after,
      observedEffects: step.observedEffects,
      data: step.data,
      error: step.error,
    })),
  };
  envelope.verification = failed
    ? { status: "failed", method: "managed_task_workflow" }
    : { status: "verified", method: "managed_task_workflow" };
  if (failed) {
    const failure = failed.error ?? {
      code: "TASK_STEP_FAILED",
      stage: "managed_task_workflow",
      message: `${failed.tool} failed without a structured error`,
      retryable: false,
      writeIssued: false,
      stateUnknown: true,
    };
    return failEnvelope(envelope, {
      ...failure,
      writeIssued: steps.some(workflowStepIssuedWrite),
      stateUnknown: failure.stateUnknown || steps.some((step) => !step.ok && step.error?.stateUnknown === true),
      retryable: false,
    });
  }
  return finishEnvelope(envelope, true);
}

function workflowStepIssuedWrite(step: OperationEnvelope): boolean {
  if (step.error?.writeIssued) return true;
  return step.ok && (step.tool === "gdb_command" || step.tool === "gdb_breakpoint_delete");
}

function breakpointNumber(envelope: OperationEnvelope): number | undefined {
  if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) return undefined;
  const data = envelope.data as Record<string, unknown>;
  for (const text of [data.output, data.rawOutput]) {
    if (typeof text !== "string") continue;
    const match = /(?:Breakpoint\s+|bkpt=\{[^}\r\n]*number=")(\d+)/i.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

function retainedManagedAttachHalt(envelope: OperationEnvelope): boolean {
  if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) return false;
  const client = (envelope.data as Record<string, unknown>).client;
  return Boolean(client)
    && typeof client === "object"
    && !Array.isArray(client)
    && (client as Record<string, unknown>).retainedClassifiedAttachHaltForManagedBreakpoint === true
    && (client as Record<string, unknown>).targetExecutionStateAfterConnect === "halted";
}

function managedBreakpointHit(envelope: OperationEnvelope, breakpointId: number): boolean {
  const facts = managedStopFacts(envelope);
  const observedBreakpointId = facts.reason?.match(/(?:^|\s)breakpoint #(\d+)(?=\s|$)/)?.[1];
  return envelope.ok
    && facts.state === "halted"
    && typeof facts.reason === "string"
    && /^breakpoint-hit(?:\s|$)/.test(facts.reason)
    && observedBreakpointId === String(breakpointId);
}

function gdbCommandDispatched(envelope: OperationEnvelope): boolean {
  return Boolean(envelope.data)
    && typeof envelope.data === "object"
    && !Array.isArray(envelope.data)
    && (envelope.data as Record<string, unknown>).commandDispatched === true;
}

function managedStopFacts(envelope: OperationEnvelope): { state?: string; reason?: string } {
  if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) return {};
  const data = envelope.data as Record<string, unknown>;
  return {
    state: typeof data.observedTargetExecutionState === "string" ? data.observedTargetExecutionState : undefined,
    reason: typeof data.stopReason === "string" ? data.stopReason : undefined,
  };
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("operation cancelled"));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("operation cancelled"));
    }, { once: true });
  });
}
