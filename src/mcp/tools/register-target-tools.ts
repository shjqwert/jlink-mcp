import { z } from "zod";
import type { ProbeBackend } from "../../probe/backend";
import { ArtifactVariableService } from "../runtime/artifact-operations";
import {
  DirectMcuService,
  type CoreRegisterWriteInput,
  type EraseInput,
  type FlashInput,
  type MemoryReadInput,
  type MemoryWriteInput,
  type ProbeCommandInput,
} from "../runtime/direct-operations";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "../runtime/operation-envelope";
import { SvdRegisterService, type RegisterWriteInput } from "../runtime/svd-operations";
import { TargetRuntimeRegistry } from "../runtime/target-runtime";
import type { TargetConfigureInput } from "../runtime/target-store";
import type { VariableRefInput, VariableWriteInput } from "../runtime/variable-access-contract";
import { VariableAccessRouter } from "../runtime/variable-access-router";
import type { RegisterEnvelopeTool } from "./tool-contract";
import { actionInputFailure, relabelEnvelope } from "./tool-envelope";
import { projectRootInput, userConfirmation, variableRef } from "./tool-schemas";

interface TargetToolServices {
  discoveryProbe: ProbeBackend;
  direct: DirectMcuService;
  runtimes: TargetRuntimeRegistry;
  artifacts: ArtifactVariableService;
  variables: VariableAccessRouter;
  registers: SvdRegisterService;
}

export function registerTargetTools(register: RegisterEnvelopeTool, services: TargetToolServices): void {
  const uint32 = z.number().int().min(0).max(0xffff_ffff);
  const accessWidth = z.union([z.literal(8), z.literal(16), z.literal(32)]);
  const variableNonObserveComparator = z.union([
    z.object({ mode: z.literal("exact") }).describe("Require the verification read to equal the requested typed value exactly."),
    z.object({
      mode: z.literal("tolerance"),
      absTolerance: z.number().nonnegative().describe("Maximum absolute numeric difference."),
      relTolerance: z.number().nonnegative().describe("Maximum relative numeric difference."),
    }).describe("Accept a finite numeric value within the configured absolute or relative tolerance."),
    z.object({
      mode: z.literal("range"),
      min: z.number().finite().describe("Minimum accepted typed readback value."),
      max: z.number().finite().describe("Maximum accepted typed readback value."),
    }).refine(({ min, max }) => min <= max, "min must not exceed max")
      .describe("Accept an explicitly bounded dynamic readback without weakening the default exact comparator."),
    z.object({
      mode: z.literal("masked"),
      maskHex: z.string().regex(/^(?:[0-9a-fA-F]{2})+$/).describe("Byte mask applied to requested and observed encoded values before comparison."),
    }).describe("Compare only bits selected by maskHex."),
  ]).describe("Single-read verification comparator.");
  const variableComparator = z.union([
    variableNonObserveComparator,
    z.object({
      mode: z.literal("observe"),
      durationMs: z.number().int().min(1).max(60_000).describe("Maximum observation window in milliseconds."),
      maxPolls: z.number().int().min(1).max(1_000).describe("Maximum verification reads within the observation window."),
      intervalMs: z.number().int().min(1).max(10_000).describe("Delay between verification reads in milliseconds."),
      comparator: variableNonObserveComparator.describe("Comparator applied to each observed value."),
    }).describe("Poll until a value matches or the bounded observation window ends."),
  ]).describe("How the post-write value is verified; this does not change whether a write is issued.");

  register("list_devices", {}, async () => listDevices(services.discoveryProbe));
  register("target_configure", {
    projectRoot: z.string().min(1),
    device: z.string().min(1),
    gdbDevice: z.string().min(1).optional().describe(
      "Explicit non-invasive J-Link device/profile used by GDB Server attach and read-only core-register snapshots. Keep device as the exact MCU for Flash/Erase; use a validated core-only profile when the exact-device script has attach side effects.",
    ),
    probeSerial: z.string().min(1),
    interface: z.enum(["SWD", "JTAG"]),
    speed: z.number().int().min(1).max(50_000),
    artifactPath: z.string().optional(),
    mapPath: z.string().optional(),
    svdPath: z.string().optional(),
    jlinkPath: z.string().optional(),
    gdbServerPath: z.string().optional(),
    gdbPath: z.string().optional(),
    ports: z.object({
      gdb: z.number().int().min(1).max(65535).optional(),
      rtt: z.number().int().min(1).max(65535).optional(),
      swo: z.number().int().min(1).max(65535).optional(),
    }).optional(),
    artifactFlashImages: z.array(z.object({
      path: z.string().min(1),
      baseAddress: uint32.optional(),
    })).max(64).optional(),
    memoryRegions: z.array(z.object({
      start: uint32,
      length: z.number().int().positive().max(0x1_0000_0000),
      kind: z.enum(["ram", "flash", "rom", "peripheral", "unknown"]),
      writable: z.boolean(),
    })).max(128).optional(),
  }, async (input) => {
    const result = await services.direct.configure(input as unknown as TargetConfigureInput);
    const previousGeneration = typeof result.before?.targetGeneration === "string"
      ? result.before.targetGeneration
      : undefined;
    if (
      result.ok
      && result.target
      && previousGeneration
      && await services.runtimes.invalidate(result.target.projectRoot, previousGeneration)
    ) {
      result.observedEffects.push("process_local_target_runtime_disposed");
    }
    return result;
  });
  register("target_status", {
    ...projectRootInput,
    firmwareVerification: z.enum(["none", "segger_verify_only"])
      .describe("Use segger_verify_only to compare every configured flash image without downloading, erasing, programming, or changing memory.")
      .default("none"),
  }, async (input) => input.firmwareVerification === "segger_verify_only"
    ? relabelEnvelope(await services.direct.verifyFirmware(String(input.projectRoot)), "target_status")
    : services.direct.status(String(input.projectRoot)));

  register("artifact_probe", {
    ...projectRootInput,
    explicitArtifact: z.string().min(1).optional(),
    explicitMap: z.string().min(1).optional(),
    maxFiles: z.number().int().min(1).max(100_000).optional(),
    maxDepth: z.number().int().min(0).max(64).optional(),
    maxCandidates: z.number().int().min(1).max(4096).optional(),
  }, (input) => services.artifacts.artifactProbe(input as never));
  register("symbol_search", {
    ...projectRootInput,
    query: z.string().min(1).max(256),
    limit: z.number().int().min(1).max(128).default(64),
  }, (input) => services.artifacts.symbolSearch(
    String(input.projectRoot),
    String(input.query),
    Number(input.limit),
  ));
  register("symbol_resolve", {
    ...projectRootInput,
    selector: z.string().min(1).max(1024),
  }, (input) => services.artifacts.symbolResolve(
    String(input.projectRoot),
    String(input.selector),
  ));
  register("read_variable", { ...projectRootInput, ref: variableRef },
    (input) => services.variables.readVariable(
      String(input.projectRoot),
      input.ref as VariableRefInput,
    ));
  register("write_variable", {
    ...projectRootInput,
    ref: variableRef,
    value: z.number(),
    captureOld: z.boolean().default(true),
    verify: z.boolean().default(true),
    restore: z.boolean().default(false),
    verificationConnection: z.enum(["same_session", "independent_session"])
      .describe("Use same_session for transaction-local readback, or independent_session to reconnect and verify persistence through a separate runtime.")
      .default("same_session"),
    comparator: variableComparator.default({ mode: "exact" }),
  }, (input) => services.variables.writeVariable(input as unknown as VariableWriteInput));

  register("read_memory", {
    ...projectRootInput,
    address: uint32,
    width: accessWidth,
    byteCount: z.number().int().min(1).max(4096),
  }, (input) => services.direct.readMemory(input as unknown as MemoryReadInput));
  register("write_memory", {
    ...projectRootInput,
    address: uint32,
    width: accessWidth,
    byteCount: z.number().int().min(1).max(4096),
    dataHex: z.string().min(2),
    captureOld: z.boolean().default(false),
    verify: z.boolean().default(true),
  }, (input) => services.direct.writeMemory(input as unknown as MemoryWriteInput));
  register("core_register_access", {
    ...projectRootInput,
    action: z.enum(["read", "read_all", "write"]),
    name: z.string().min(1).max(32).optional().describe(
      "Supported core name: R followed by an index from 0 through 15, PC, LR, SP, XPSR, CONTROL, PRIMASK, BASEPRI, FAULTMASK, MSP, PSP, MSPLIM, or PSPLIM. PC/R15 and SP/R13 use J-Link display-name tokens; LR/R14 uses the supported R14 token.",
    ),
    value: uint32.optional(),
    verify: z.boolean().default(false),
    verificationConnection: z.enum(["same_session", "independent_session"])
      .describe("same_session verifies the write in one Probe transaction; independent_session requires an explicit backend guarantee for cross-connection GPR persistence.")
      .default("same_session"),
  }, async (input) => {
    const projectRoot = String(input.projectRoot);
    if (input.action === "read") {
      if (
        typeof input.name !== "string" || input.value !== undefined || input.verify !== false
        || input.verificationConnection !== "same_session"
      ) {
        return actionInputFailure("core_register_access", "action=read requires name and accepts no value or verify options");
      }
      return relabelEnvelope(await services.direct.readCoreRegister(projectRoot, input.name), "core_register_access");
    }
    if (input.action === "read_all") {
      if (
        input.name !== undefined || input.value !== undefined || input.verify !== false
        || input.verificationConnection !== "same_session"
      ) {
        return actionInputFailure("core_register_access", "action=read_all accepts no name, value, or verify options");
      }
      return relabelEnvelope(await services.direct.readCoreRegisters(projectRoot), "core_register_access");
    }
    if (typeof input.name !== "string" || typeof input.value !== "number") {
      return actionInputFailure("core_register_access", "action=write requires name and value");
    }
    return relabelEnvelope(await services.direct.writeCoreRegister({
      projectRoot,
      name: input.name,
      value: input.value,
      verify: Boolean(input.verify),
      verificationConnection: input.verificationConnection as CoreRegisterWriteInput["verificationConnection"],
    } as CoreRegisterWriteInput), "core_register_access");
  });
  register("peripheral_register_access", {
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
      return relabelEnvelope(await services.registers.readRegister(projectRoot, input.selector), "peripheral_register_access");
    }
    if (input.action === "read_many") {
      if (
        !Array.isArray(input.selectors) || input.selector !== undefined || input.value !== undefined
        || input.captureOld !== false || input.restore !== false
      ) return actionInputFailure("peripheral_register_access", "action=read_many requires selectors only");
      return relabelEnvelope(await services.registers.readRegisters(
        projectRoot,
        input.selectors as string[],
      ), "peripheral_register_access");
    }
    if (typeof input.selector !== "string" || typeof input.value !== "number" || input.selectors !== undefined) {
      return actionInputFailure("peripheral_register_access", "action=write requires selector and value");
    }
    return relabelEnvelope(await services.registers.writeRegister({
      projectRoot,
      selector: input.selector,
      value: input.value,
      captureOld: Boolean(input.captureOld),
      verify: Boolean(input.verify),
      restore: Boolean(input.restore),
      comparator: input.comparator as RegisterWriteInput["comparator"],
    }), "peripheral_register_access");
  });

  register("target_control", {
    ...projectRootInput,
    action: z.enum(["halt", "resume", "reset", "reset_halt"]),
  }, async (input) => {
    const action = input.action as "halt" | "resume" | "reset" | "reset_halt";
    const envelope = relabelEnvelope(
      await services.direct.control(action, String(input.projectRoot)),
      "target_control",
    );
    envelope.data = {
      action,
      ...(isRecord(envelope.data) ? envelope.data : { result: envelope.data }),
    };
    return envelope;
  });
  register("flash", {
    ...projectRootInput,
    path: z.string().min(1),
    baseAddress: uint32.optional(),
    userConfirmed: userConfirmation,
  }, (input) => services.direct.flash(input as unknown as FlashInput));
  register("erase", {
    ...projectRootInput,
    verifyBlank: z.boolean().default(false),
    userConfirmed: userConfirmation,
  }, (input) => services.direct.erase(input as unknown as EraseInput));
  register("probe_command", {
    ...projectRootInput,
    commands: z.array(z.string().min(1)).min(1).max(100),
    userConfirmed: userConfirmation,
  }, (input) => services.direct.probeCommand(input as unknown as ProbeCommandInput));
}

async function listDevices(discoveryProbe: ProbeBackend): Promise<OperationEnvelope> {
  const envelope = createOperationEnvelope("list_devices");
  try {
    envelope.before = { probe: discoveryProbe.getStatus() };
    const result = await discoveryProbe.listDevices();
    envelope.after = { probe: discoveryProbe.getStatus() };
    envelope.data = { output: result.output, rawOutput: result.rawOutput, error: result.error };
    envelope.verification = { status: "observed", method: "J-Link ShowEmuList" };
    if (!result.success) {
      return failEnvelope(envelope, {
        code: result.errorCode ?? "PROBE_DISCOVERY_FAILED",
        stage: "discovery",
        message: result.error || result.output || "Probe discovery failed",
        retryable: true,
        writeIssued: false,
        stateUnknown: false,
      });
    }
    return finishEnvelope(envelope, true);
  } catch (error) {
    return failEnvelope(envelope, {
      code: "PROBE_DISCOVERY_FAILED",
      stage: "discovery",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      writeIssued: false,
      stateUnknown: false,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
