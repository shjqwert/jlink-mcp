import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { HSS_SAFETY_FALSE, type HssRequestedSymbol, type HssTargetIdentity } from "./hss-contract";
import { resolveHssDebugArtifact } from "./debug-artifact";
import { hssProjectPaths } from "./project-paths";
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

interface HmC095Rate {
  focIsrFreqHz: number;
  rateToleranceRatio: number;
  rateDerivation: Record<string, unknown>;
}

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
  storageRoot: string;
  evidenceRoot: string;
  target: HssTargetIdentity;
  artifact: {
    file: string;
    mapFile?: string;
    mapSha256?: string;
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
    packageDir: string;
    sessionDir: string;
    outputDir: string;
    metadataFile: string;
    firstSegmentFile: string;
    planFile: string;
  };
  hmC095: {
    focIsrFreqHz: number;
    expectedCounterDelta: number;
    counterSymbol: "g_hssDbgCounterFocIsr";
    counterAddress: string;
    counterType: "uint32";
    incrementsPerFocUpdate: 1;
    modulus: "4294967296";
    rateToleranceRatio: number;
    rateDerivation: Record<string, unknown>;
    observationWindowMs: 100;
    adjacentDeltaMin: 0;
    adjacentDeltaMax: number;
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
    minimumRecoveryMs: input.minimumRecoveryMs ?? 1000,
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
  const counter = artifact.symbols.find((symbol) => symbol.name === "g_hssDbgCounterFocIsr");
  if (!counter || counter.type !== "uint32" || counter.size !== 4) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "HSS requires the dynamically resolved uint32 g_hssDbgCounterFocIsr counter");
  const hmRate = deriveHmC095Rate(cwd);
  const paths = hssProjectPaths(cwd);
  const captureId = randomUUID();
  if (input.outputSubdir) throw new HssError(HSS_ERROR.PATH_OUTSIDE_CWD, "JCAP captures use the fixed storageRoot/captures location");
  const outputDir = join(paths.capturesDir, `${captureId}.jcap`);
  const sessionDir = join(paths.sessionsDir, captureId);
  const recordSize = 24 + artifact.symbols.length * 4;
  const estimatedSamples = requestedRateHz * durationSec;
  const plan: HssCapturePlan = {
    planId: randomUUID(),
    backend: "jlink-hss",
    projectRoot: paths.projectRoot,
    storageRoot: paths.storageRoot,
    evidenceRoot: paths.evidenceRoot,
    target,
    artifact: {
      file: artifact.artifactFile,
      mapFile: artifact.mapFile,
      ...(artifact.mapFile ? { mapSha256: createHash("sha256").update(readFileSync(artifact.mapFile)).digest("hex") } : {}),
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
      packageDir: outputDir,
      sessionDir,
      outputDir,
      metadataFile: join(sessionDir, "session.json"),
      firstSegmentFile: join(outputDir, "raw", "samples.bin"),
      planFile: join(sessionDir, "plan.json"),
    },
    hmC095: {
      focIsrFreqHz: hmRate.focIsrFreqHz,
      expectedCounterDelta: hmRate.focIsrFreqHz / requestedRateHz,
      counterSymbol: "g_hssDbgCounterFocIsr",
      counterAddress: counter.address,
      counterType: "uint32",
      incrementsPerFocUpdate: 1,
      modulus: "4294967296",
      rateToleranceRatio: hmRate.rateToleranceRatio,
      rateDerivation: hmRate.rateDerivation,
      observationWindowMs: 100,
      adjacentDeltaMin: 0,
      adjacentDeltaMax: Math.ceil((hmRate.focIsrFreqHz / requestedRateHz) * (1 + hmRate.rateToleranceRatio)) + 1,
    },
    safety: HSS_SAFETY_FALSE,
    startReady,
    readMode,
    resumeBeforeStart,
    resetBeforeCapture,
    stabilityPolicy,
  };
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
  return plan;
}

function deriveHmC095Rate(cwd: string): HmC095Rate {
  const files = {
    mcu: join(cwd, "EB_Project", "config", "Mcu.xdm"),
    parcc: join(cwd, "Appl", "Source", "BSW", "Src", "Parcc_Drv_PBcfg.c"),
    pwm: join(cwd, "Appl", "Source", "BSW", "Src", "Mcpwm_Pwm_Drv_PBcfg.c"),
    tdg: join(cwd, "Appl", "Source", "BSW", "Src", "Tdg_Adc_Drv_PBcfg.c"),
    tmu: join(cwd, "Appl", "Source", "BSW", "Src", "Tmu_Drv_Cfg.c"),
  };
  if (!Object.values(files).every(existsSync)) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "HM_C095 timing configuration is incomplete");
  const text = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, readFileSync(file, "utf8")])) as Record<keyof typeof files, string>;
  const number = (source: string, pattern: RegExp, label: string) => {
    const value = Number(source.match(pattern)?.[1]);
    if (!Number.isFinite(value) || value <= 0) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `HM_C095 timing ${label} is unavailable`);
    return value;
  };
  const parccDivider = (module: "MCPWM1" | "TDG1") => number(
    text.parcc,
    new RegExp(`Start of\\s+PARCC_${module}[\\s\\S]*?[Cc]lock divider[\\s\\S]*?ClockDividerType\\)(\\d+)U`),
    `${module} PARCC divider`,
  ) + 1;
  const foscHz = number(text.mcu, /McuFOSCClockFrequency[^>]*?value="([0-9.E+-]+)"/, "FOSC frequency");
  const pwmPeriod = number(text.pwm, /Pwm_Drv_I1_Counter0_Cfg[\s\S]*?\.PwmPeriod\s*=\s*(\d+)U/, "PWM1 period");
  const pwmDivider = number(text.pwm, /Pwm_Drv_Inst1_Cfg[\s\S]*?\.ClkDiv\s*=\s*MCPWM_PWM_DRV_CLK_DIVIDE_(\d+)/, "PWM1 divider");
  const tdgPrescalerCode = number(text.tdg, /Tdg_Adc_Drv_Config_1[\s\S]*?ClockDivideType\)(\d+)U/, "TDG1 prescaler code");
  const tdgPrescaler = 2 ** tdgPrescalerCode;
  const tdgOffset = number(text.tdg, /DelayOutputConfig_Group1_Channel0[\s\S]*?\{[\s\S]*?TDG_ADC_DRV_DELAY_OUTPUT_0,[\s\S]*?(\d+)U/, "TDG1 offset");
  const tdgMod = number(text.tdg, /Tdg_Adc_Drv_Config_1[\s\S]*?(\d+)U,\s*\/\* ModulateValue \*\//, "TDG1 modulator");
  if (!/MCPWM_PWM_DRV_MODE_COMBINE_SYM_CENTER_ALIGNED/.test(text.pwm)
      || !/TMU_DRV_INPUT_CHANNEL_MCPWM1_INIT_TRIG0[\s\S]*?TMU_DRV_OUTPUT_CHANNEL_TDG1_TRIG_IN/.test(text.tmu)
      || !/Tdg_Adc_Drv_GroupConfig_1[\s\S]*?\(boolean\)FALSE/.test(text.tdg)
      || tdgOffset > tdgMod) {
    throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "HM_C095 timing trigger topology is unsupported");
  }
  const pwmHz = foscHz / parccDivider("MCPWM1") / pwmDivider / (2 * pwmPeriod);
  const tdgTickHz = foscHz / parccDivider("TDG1") / tdgPrescaler;
  const triggerStride = Math.ceil(((tdgOffset + 1) / tdgTickHz) * pwmHz);
  const focIsrFreqHz = pwmHz / triggerStride;
  if (!Number.isSafeInteger(focIsrFreqHz) || triggerStride < 1) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "HM_C095 derived counter rate is not a safe integer");
  return {
    focIsrFreqHz,
    rateToleranceRatio: 0.5,
    rateDerivation: {
      source: "hm-c095-generated-config",
      foscHz,
      pwmParccDivider: parccDivider("MCPWM1"),
      pwmDivider,
      pwmPeriod,
      pwmCenterAlignedFactor: 2,
      pwmHz,
      tdgParccDivider: parccDivider("TDG1"),
      tdgPrescaler,
      tdgOffset,
      tdgMod,
      triggerStride,
      formula: "fCounter=fFOSC/(pwmParcc*pwmDivider*2*pwmPeriod)/ceil((tdgOffset+1)*fPWM/(fFOSC/tdgParcc/tdgPrescaler))",
      configSha256: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, createHash("sha256").update(readFileSync(file)).digest("hex")])),
    },
  };
}
