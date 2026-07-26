import { z } from "zod";
import { DebugSequenceExecutor, type DebugSequenceInput } from "../runtime/debug-sequence";
import { HssOperations, type HssCaptureInput } from "../runtime/hss-operations";
import type { RegisterEnvelopeTool } from "./tool-contract";
import { acceptanceRunId, projectRootInput, variableRef } from "./tool-schemas";

export function registerHssTools(
  register: RegisterEnvelopeTool,
  services: { hss: HssOperations; sequence: DebugSequenceExecutor },
): void {
  const hssVariable = z.object({
    ref: variableRef,
    alias: z.string().min(1).max(128).optional(),
    unit: z.string().min(1).max(64).optional(),
  }).strict();
  const hssQualityOracle = z.object({
    ref: variableRef,
    expectedIncrement: z.number().int().min(1).max(0xffff_ffff)
      .describe("Expected unsigned counter increment between adjacent valid samples."),
    tolerance: z.number().int().min(0).max(0xffff_ffff)
      .describe("Allowed unsigned deviation from expectedIncrement before reporting counter ambiguity or gaps."),
  }).strict().describe("Optional target-counter evidence for diagnosing sample continuity. It is not a universal capture quality verdict and requires a monotonic target counter.");
  const hssWriteVariables = z.array(variableRef).max(32).optional()
    .describe("Typed RAM variables permitted for writes while this capture owns the Probe. They do not consume the ten periodic sampling slots.");
  const hssCapture = {
    ...projectRootInput,
    variables: z.array(hssVariable).min(1).max(10)
      .describe("One to ten periodic sample variables. Capability-only dry runs still require a non-empty real variable selector; never send an empty array."),
    writeVariables: hssWriteVariables,
    rateHz: z.number().int().min(1).max(1_000),
    durationSec: z.number().int().min(1).max(60),
    qualityOracle: hssQualityOracle.optional(),
    dryRun: z.boolean()
      .describe("When true, validate capability, symbols, target state, and link-rate facts without starting capture. Repeat preflight after capture parameters change.")
      .default(false),
    runId: acceptanceRunId.optional(),
  };
  const hssSelector = { ...projectRootInput, captureId: z.string().uuid().optional() };
  register("hss_start", hssCapture, (input) => services.hss.start(input as unknown as HssCaptureInput));
  register("hss_status", hssSelector, (input) => services.hss.status({
    projectRoot: String(input.projectRoot),
    captureId: input.captureId as string | undefined,
  }));
  register("hss_stop", hssSelector, (input) => services.hss.stop({
    projectRoot: String(input.projectRoot),
    captureId: input.captureId as string | undefined,
  }));
  register("hss_recover", hssSelector, (input) => services.hss.recover({
    projectRoot: String(input.projectRoot),
    captureId: input.captureId as string | undefined,
  }));

  const sequenceStep = z.discriminatedUnion("action", [
    z.object({
      atMs: z.number().int().min(0).max(30_000),
      action: z.literal("hss_start"),
      variables: z.array(hssVariable).min(1).max(10),
      writeVariables: hssWriteVariables,
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
    z.object({
      atMs: z.number().int().min(0).max(30_000),
      action: z.literal("read_variable"),
      ref: variableRef,
    }).strict(),
    z.object({ atMs: z.number().int().min(0).max(30_000), action: z.literal("hss_stop") }).strict(),
  ]);
  const sequenceCleanup = z.discriminatedUnion("action", [
    z.object({ action: z.literal("restore_variable"), ref: variableRef, value: z.number() }).strict(),
    z.object({ action: z.literal("hss_stop") }).strict(),
  ]);
  register("debug_sequence_execute", {
    ...projectRootInput,
    steps: z.array(sequenceStep).min(2).max(32),
    cleanup: z.array(sequenceCleanup).max(4).optional(),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  }, (input, signal) => services.sequence.execute(input as unknown as DebugSequenceInput, signal));
}
