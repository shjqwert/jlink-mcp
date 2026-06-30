import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { HSS_SAFETY_FALSE, type HssRequestedSymbol } from "./hss-contract";
import { resolveHssDebugArtifact } from "./debug-artifact";
import { hssProjectPaths, resolveInsideProject } from "./project-paths";
import { HSS_ERROR, HssError } from "./hss-errors";

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

export interface HssCapturePlanInput {
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
}

export async function buildHssCapturePlan(input: HssCapturePlanInput = {}, cwd = process.cwd(), startReady = false): Promise<HssCapturePlan> {
  const requestedRateHz = input.requestedRateHz ?? 1000;
  const durationSec = input.durationSec ?? 3;
  const segmentSizeMb = input.segmentSizeMb ?? 64;
  if (!Number.isInteger(requestedRateHz) || requestedRateHz < 1 || requestedRateHz > 16000) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "requestedRateHz must be 1..16000");
  if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 60) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "durationSec must be 1..60");
  if (!Number.isInteger(segmentSizeMb) || segmentSizeMb < 16 || segmentSizeMb > 512) throw new HssError(HSS_ERROR.PATH_OUTSIDE_CWD, "segmentSizeMb must be 16..512");
  const symbols = input.symbols?.length ? input.symbols : HM_C095_HSS_VARIABLES;
  if (symbols.length > 10) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "HSS MVP-A supports at most 10 variables");
  const artifact = await resolveHssDebugArtifact({ artifactFile: input.artifactFile, mapFile: input.mapFile, symbols, cwd });
  const paths = hssProjectPaths(cwd);
  const captureId = randomUUID();
  const outputDir = input.outputSubdir
    ? resolveInsideProject(input.outputSubdir, cwd)
    : join(paths.capturesDir, captureId);
  const recordSize = 24 + artifact.symbols.length * 4;
  const estimatedSamples = requestedRateHz * durationSec;
  const plan: HssCapturePlan = {
    planId: randomUUID(),
    backend: "jlink-hss",
    projectRoot: paths.projectRoot,
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
  };
  await mkdir(outputDir, { recursive: true });
  return plan;
}
