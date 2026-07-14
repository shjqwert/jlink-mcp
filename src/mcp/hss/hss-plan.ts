import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { HSS_SAFETY_FALSE, type HssRequestedSymbol, type HssTargetIdentity } from "./hss-contract";
import { resolveHssDebugArtifact } from "./debug-artifact";
import { hssProjectPaths, resolveInsideProject } from "./project-paths";
import { HSS_ERROR, HssError } from "./hss-errors";
import { resolveHssTargetIdentity, type HssTargetIdentityInput } from "./target-identity";
import type { HssRuntimeIdentity, HssScriptIdentity } from "../hss-dll/hss-dll-adapter";
import type { HssScriptSpec } from "../trust/trust-profile";

export const HM_C095_HSS_VARIABLES = [
  { name: "g_hssDbgCounterFocIsr", unit: "count" },
  { name: "g_hssDbgSawFocIsr" },
  { name: "g_hssDbgToggleFocIsr" },
  { name: "g_hssDbgPatternFocIsr" },
  { name: "g_hssDbgRawAdcM1U" },
  { name: "g_hssDbgRawAdcM1V" },
  { name: "g_hssDbgRawAdcM2U" },
  { name: "g_hssDbgRawAdcM2V" },
  { name: "g_hssDbgOffsetM1U" },
  { name: "g_hssDbgOffsetM1V" },
] satisfies HssRequestedSymbol[];

export interface HssCapturePlanInput extends HssTargetIdentityInput {
  dllPath?: string;
  interface?: "SWD" | "JTAG";
  speedKhz?: number;
  serial?: string;
  readMode?: "periodic" | "drain";
  resumeBeforeStart?: boolean;
  script?: HssScriptSpec;
  jlinkScriptFile?: string;
  approvedJlinkScriptSha256?: string;
  resetBeforeCapture?: boolean;
  resetPlanTtlMs?: number;
  minimumRecoveryMs?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  requiredConsecutiveRunningChecks?: number;
  artifactFile?: string;
  mapFile?: string;
  symbols?: HssRequestedSymbol[];
  requestedRateHz?: number;
  durationSec?: number;
  segmentSizeMb?: number;
  sessionName?: string;
  outputSubdir?: string;
  dryRun?: boolean;
}

export interface HssCapturePlan {
  planId: string;
  backend: "jlink-hss";
  projectRoot: string;
  target: HssTargetIdentity;
  artifact: {
    file: string;
    mapFile?: string;
    resolver: "elf-dwarf" | "iar-map" | "mixed";
    sha256: string;
  };
  symbols: Awaited<ReturnType<typeof resolveHssDebugArtifact>>["symbols"];
  sampling: {
    requestedRateHz: number;
    durationSec: number;
    estimatedSamples: number;
    estimatedBytes: number;
    segmentSizeMb: number;
  };
  output: {
    captureId: string;
    outputDir: string;
    metadataFile: string;
    firstSegmentFile: string;
    planFile: string;
  };
  hmC095: {
    focIsrFreqHz: 16000;
    expectedCounterDelta: number;
  };
  safety: typeof HSS_SAFETY_FALSE;
  startReady: boolean;
  readMode: "periodic" | "drain";
  resumeBeforeStart: boolean;
  resetBeforeCapture: boolean;
  stabilityPolicy: {
    minimumRecoveryMs: number;
    timeoutMs: number;
    pollIntervalMs: number;
    requiredConsecutiveRunningChecks: number;
  };
  scriptIdentity?: HssScriptIdentity & { validated: true; approvalSha256: string };
  runtimeIdentity?: HssRuntimeIdentity;
  resetOperation?: {
    operation: "reset";
    risk: "R3";
    planId: string;
    captureId: string;
    targetId: string;
    artifactSha256: string;
    layoutSha256: string;
    policySha256: string;
    runtimeIdentitySha256: string;
    scriptApprovalSha256: string;
    sessionId: string;
    createdAt: string;
    expiresAt: string;
    ttlMs: number;
    operationDigest: string;
    consumed: boolean;
  };
}

export async function buildHssCapturePlan(
  input: HssCapturePlanInput = {},
  cwd = process.cwd(),
  startReady = false,
  targetIdentity?: HssTargetIdentity,
): Promise<HssCapturePlan> {
  const requestedRateHz = input.requestedRateHz ?? 1000;
  const durationSec = input.durationSec ?? 3;
  const segmentSizeMb = input.segmentSizeMb ?? 64;
  const readMode = input.readMode ?? "periodic";
  const resumeBeforeStart = input.resumeBeforeStart ?? false;
  const resetBeforeCapture = input.resetBeforeCapture ?? false;
  const stabilityPolicy = {
    minimumRecoveryMs: input.minimumRecoveryMs ?? 250,
    timeoutMs: input.timeoutMs ?? 10000,
    pollIntervalMs: input.pollIntervalMs ?? 100,
    requiredConsecutiveRunningChecks: input.requiredConsecutiveRunningChecks ?? 3,
  };
  if (!Number.isInteger(requestedRateHz) || requestedRateHz < 1 || requestedRateHz > 16000) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "requestedRateHz must be 1..16000");
  if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 60) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "durationSec must be 1..60");
  if (!Number.isInteger(segmentSizeMb) || segmentSizeMb < 16 || segmentSizeMb > 512) throw new HssError(HSS_ERROR.PATH_OUTSIDE_CWD, "segmentSizeMb must be 16..512");
  if (readMode !== "periodic" && readMode !== "drain") throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "readMode must be periodic or drain");
  if (!Number.isInteger(input.resetPlanTtlMs ?? 60000) || (input.resetPlanTtlMs ?? 60000) < 1 || (input.resetPlanTtlMs ?? 60000) > 3600000) throw new HssError(HSS_ERROR.RESET_PLAN_INVALID, "resetPlanTtlMs must be 1..3600000");
  if (!Number.isInteger(stabilityPolicy.minimumRecoveryMs) || stabilityPolicy.minimumRecoveryMs < 0 || stabilityPolicy.minimumRecoveryMs > 60000) throw new HssError(HSS_ERROR.RESET_PLAN_INVALID, "minimumRecoveryMs must be 0..60000");
  if (!Number.isInteger(stabilityPolicy.timeoutMs) || stabilityPolicy.timeoutMs < 1 || stabilityPolicy.timeoutMs > 60000) throw new HssError(HSS_ERROR.RESET_PLAN_INVALID, "timeoutMs must be 1..60000");
  if (!Number.isInteger(stabilityPolicy.pollIntervalMs) || stabilityPolicy.pollIntervalMs < 10 || stabilityPolicy.pollIntervalMs > 1000) throw new HssError(HSS_ERROR.RESET_PLAN_INVALID, "pollIntervalMs must be 10..1000");
  if (!Number.isInteger(stabilityPolicy.requiredConsecutiveRunningChecks) || stabilityPolicy.requiredConsecutiveRunningChecks < 2 || stabilityPolicy.requiredConsecutiveRunningChecks > 100) throw new HssError(HSS_ERROR.RESET_PLAN_INVALID, "requiredConsecutiveRunningChecks must be 2..100");
  const target = targetIdentity ?? await resolveHssTargetIdentity(input, { cwd });
  const symbols = input.symbols?.length ? input.symbols : HM_C095_HSS_VARIABLES;
  if (symbols.length > 10) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "HSS MVP-A supports at most 10 variables");
  const artifact = await resolveHssDebugArtifact({ artifactFile: input.artifactFile, mapFile: input.mapFile, symbols, cwd });
  const paths = hssProjectPaths(cwd);
  const captureId = randomUUID();
  const baseDir = input.outputSubdir
    ? resolveInsideProject(input.outputSubdir, cwd)
    : paths.capturesDir;
  const outputDir = join(baseDir, captureId);
  const recordSize = 24 + artifact.symbols.length * 4;
  const estimatedSamples = requestedRateHz * durationSec;
  const plan: HssCapturePlan = {
    planId: randomUUID(),
    backend: "jlink-hss",
    projectRoot: paths.projectRoot,
    target,
    artifact: {
      file: artifact.artifactFile,
      mapFile: artifact.mapFile,
      resolver: artifact.resolver,
      sha256: artifact.sha256,
    },
    symbols: artifact.symbols,
    sampling: {
      requestedRateHz,
      durationSec,
      estimatedSamples,
      estimatedBytes: estimatedSamples * recordSize,
      segmentSizeMb,
    },
    output: {
      captureId,
      outputDir,
      metadataFile: join(outputDir, "capture.json"),
      firstSegmentFile: join(outputDir, "capture_0001.bin"),
      planFile: join(outputDir, "plan.json"),
    },
    hmC095: {
      focIsrFreqHz: 16000,
      expectedCounterDelta: 16000 / requestedRateHz,
    },
    safety: HSS_SAFETY_FALSE,
    startReady,
    readMode,
    resumeBeforeStart,
    resetBeforeCapture,
    stabilityPolicy,
  };
  await mkdir(outputDir, { recursive: true });
  return plan;
}
