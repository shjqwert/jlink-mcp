import { z } from "zod";
import { DirectMcuService } from "../runtime/direct-operations";
import { createOperationEnvelope, failEnvelope, type OperationEnvelope } from "../runtime/operation-envelope";
import { SessionOperations } from "../runtime/session-operations";
import { TargetStore, type StoredTarget } from "../runtime/target-store";
import type { RegisterEnvelopeTool } from "./tool-contract";
import { actionInputFailure, relabelEnvelope } from "./tool-envelope";
import { projectRootInput, userConfirmation } from "./tool-schemas";

interface SessionToolServices {
  targets: TargetStore;
  sessions: SessionOperations;
  direct: DirectMcuService;
}

export function registerSessionTools(register: RegisterEnvelopeTool, services: SessionToolServices): void {
  register("gdb_open", projectRootInput, (input) => gdbOpen(services, String(input.projectRoot)));
  register("gdb_command", {
    ...projectRootInput,
    command: z.string().min(1),
    timeoutMs: z.number().int().min(1).max(120_000).default(15_000),
    userConfirmed: userConfirmation,
  }, (input) => services.sessions.gdbCommand(
    String(input.projectRoot),
    String(input.command),
    Number(input.timeoutMs),
    Boolean(input.userConfirmed),
  ));
  register("gdb_wait", {
    ...projectRootInput,
    timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
  }, (input) => services.sessions.gdbWait(String(input.projectRoot), Number(input.timeoutMs)));
  register("gdb_backtrace", {
    ...projectRootInput,
    full: z.boolean().default(false),
  }, (input) => services.sessions.gdbBacktrace(String(input.projectRoot), Boolean(input.full)));
  register("gdb_close", projectRootInput, async (input) =>
    relabelEnvelope(await services.sessions.gdbServerStop(String(input.projectRoot)), "gdb_close"));

  register("rtt_open", projectRootInput, async (input) =>
    relabelEnvelope(await services.sessions.rttConnect(String(input.projectRoot)), "rtt_open"));
  register("rtt_read", {
    ...projectRootInput,
    count: z.number().int().min(1).max(1000).default(50),
  }, (input) => services.sessions.rttRead(String(input.projectRoot), Number(input.count)));
  register("rtt_search", {
    ...projectRootInput,
    level: z.string().optional(),
    module: z.string().optional(),
    pattern: z.string().optional(),
    count: z.number().int().min(1).max(1000).default(100),
  }, (input) => services.sessions.rttSearch(
    String(input.projectRoot),
    input as { level?: string; module?: string; pattern?: string; count?: number },
  ));
  register("rtt_clear", projectRootInput,
    (input) => services.sessions.rttClear(String(input.projectRoot)));
  register("rtt_close", projectRootInput, async (input) =>
    relabelEnvelope(await services.sessions.rttDisconnect(String(input.projectRoot)), "rtt_close"));
  register("diagnose_crash", projectRootInput,
    (input) => diagnoseCrash(services, String(input.projectRoot)));
}

async function gdbOpen(services: SessionToolServices, projectRoot: string): Promise<OperationEnvelope> {
  let target: StoredTarget;
  try {
    target = services.targets.require(projectRoot);
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

  const server = await services.sessions.gdbServerStart(target.projectRoot);
  if (!server.ok) return relabelEnvelope(server, "gdb_open");
  const client = await services.sessions.gdbConnect(target.projectRoot, target.artifact.path);
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

async function diagnoseCrash(services: SessionToolServices, projectRoot: string): Promise<OperationEnvelope> {
  const managedBacktrace = await services.sessions.managedGdbBacktrace(projectRoot);
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
  return relabelEnvelope(await services.direct.diagnoseCrash(projectRoot), "diagnose_crash");
}

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
