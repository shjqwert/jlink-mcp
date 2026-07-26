import { HSS_STATUS_FLAGS } from "../hss/hss-status-flags";
import type { JcapV1Metadata } from "../jcap/jcap-v1";

export interface PreparedQualityOracle {
  logicalIdentity: string;
  expectedIncrement: number;
  tolerance: number;
  modulus: number;
}

export interface QualityEvidence {
  status: JcapV1Metadata["qualityStatus"];
  source: JcapV1Metadata["qualitySource"];
  counters: JcapV1Metadata["quality"];
  durationValidated: boolean | null;
  provenance: Record<string, unknown>;
  inferredDroppedBeforeSampleIndexes: number[];
}

interface QualityRaw {
  samples: Array<{
    sampleIndex: number;
    tick: string;
    statusFlags: number;
    values: Record<string, number>;
  }>;
  events: Array<Record<string, unknown> & {
    type: string;
    tick: string;
  }>;
}

export function qualityEvidenceFrom(
  result: Record<string, unknown> | undefined,
  raw: QualityRaw | undefined,
  oracle: PreparedQualityOracle | undefined,
  rateHz: number,
  sanitizedProvenance: Record<string, unknown> = {},
): QualityEvidence {
  const names = ["missingSamples", "droppedSamples", "overflows", "readErrors", "timeouts"] as const;
  const counters = Object.fromEntries(names.map((name) => [
    name,
    Number.isSafeInteger(result?.[name]) && Number(result?.[name]) >= 0 ? Number(result![name]) : null,
  ])) as JcapV1Metadata["quality"];
  const durationValidated = result?.durationValidated === true ? true : result?.durationValidated === false ? false : null;
  const rateDiagnostics = Object.fromEntries([
    "configuredInterface",
    "configuredSpeedKHz",
    "requestedRateHz",
    "actualRateHz",
    "sampleCount",
    "requestedSamples",
    "sampleRatio",
    "sampleThresholdMet",
    "readAttempts",
    "emptyReads",
    "shortReads",
    "readErrors",
    "rawWriteTimeNsTotal",
    "rawWriteTimeNsMax",
    "rawWriteTimeNsAverage",
  ].filter((name) => result?.[name] !== undefined).map((name) => [name, result![name]]));
  if (result?.qualitySource === "jlink" && result.qualityCountersValidated === true && names.every((name) => counters[name] !== null)) {
    return {
      status: "reported",
      source: "jlink",
      counters,
      durationValidated,
      provenance: { source: "jlink", countersValidated: true, ...rateDiagnostics, ...sanitizedProvenance },
      inferredDroppedBeforeSampleIndexes: [],
    };
  }
  if (oracle) return targetCounterQualityEvidence(raw, oracle, durationValidated, rateHz);
  if (names.some((name) => counters[name] !== null)) {
    return {
      status: "partial",
      source: "jlink",
      counters,
      durationValidated,
      provenance: { source: "jlink", countersValidated: false, ...rateDiagnostics, ...sanitizedProvenance },
      inferredDroppedBeforeSampleIndexes: [],
    };
  }
  return {
    status: "partial",
    source: "none",
    counters: { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null },
    durationValidated,
    provenance: { source: "none", reason: "no_qualified_quality_source" },
    inferredDroppedBeforeSampleIndexes: [],
  };
}

function targetCounterQualityEvidence(
  raw: QualityRaw | undefined,
  oracle: PreparedQualityOracle,
  durationValidated: boolean | null,
  rateHz: number,
): QualityEvidence {
  const configuration = {
    logicalIdentity: oracle.logicalIdentity,
    expectedIncrement: oracle.expectedIncrement,
    tolerance: oracle.tolerance,
    modulus: oracle.modulus,
  };
  if (!raw) {
    return {
      status: "partial",
      source: "target_counter",
      counters: { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null },
      durationValidated,
      provenance: { source: "target_counter", configuration, diagnostic: "raw_unavailable" },
      inferredDroppedBeforeSampleIndexes: [],
    };
  }
  const writeIntervals = raw.events.flatMap((event) => {
    if (event.type !== "variable_write" || event.logicalIdentity !== oracle.logicalIdentity) return [];
    const start = validTick(event.operationStartTick) ?? validTick(event.tick);
    const end = validTick(event.operationEndTick) ?? validTick(event.tick);
    return start !== undefined && end !== undefined ? [{ start: BigInt(start), end: BigInt(end) }] : [];
  });
  let evaluatedPairs = 0;
  let inferredMissedFrames = 0;
  let ambiguous = false;
  const diagnostics = new Set<string>();
  const inferredDroppedBeforeSampleIndexes: number[] = [];
  for (let index = 1; index < raw.samples.length; index += 1) {
    const previous = raw.samples[index - 1];
    const current = raw.samples[index];
    if (!oracleSampleIsValid(previous) || !oracleSampleIsValid(current)) {
      ambiguous = true;
      diagnostics.add("invalid_sample");
      continue;
    }
    const previousTick = BigInt(previous.tick);
    const currentTick = BigInt(current.tick);
    if (writeIntervals.some((interval) => interval.start <= currentTick && interval.end >= previousTick)) {
      ambiguous = true;
      diagnostics.add("write_interval");
      continue;
    }
    const previousValue = previous.values[oracle.logicalIdentity];
    const currentValue = current.values[oracle.logicalIdentity];
    if (!validCounterValue(previousValue, oracle.modulus) || !validCounterValue(currentValue, oracle.modulus)) {
      ambiguous = true;
      diagnostics.add("counter_value_invalid");
      continue;
    }
    if (currentValue < previousValue) {
      ambiguous = true;
      diagnostics.add("counter_wrap_or_reset_ambiguous");
      continue;
    }
    const delta = currentValue - previousValue;
    const frames = counterFrameCount(delta, oracle);
    if (!frames) {
      ambiguous = true;
      diagnostics.add(delta < oracle.expectedIncrement ? "counter_reset_or_nonadvancing" : "counter_delta_ambiguous");
      continue;
    }
    if (additionalModuloWrapCouldFit(delta, frames, previousTick, currentTick, oracle, rateHz)) {
      ambiguous = true;
      diagnostics.add("counter_modulo_alias_ambiguous");
      continue;
    }
    evaluatedPairs += 1;
    if (frames >= 2) {
      inferredMissedFrames += frames - 1;
      inferredDroppedBeforeSampleIndexes.push(current.sampleIndex);
    }
  }
  if (ambiguous || evaluatedPairs === 0) {
    return {
      status: "partial",
      source: "target_counter",
      counters: { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null },
      durationValidated,
      provenance: {
        source: "target_counter",
        configuration,
        evaluatedPairs,
        diagnostics: [...diagnostics].sort(),
      },
      inferredDroppedBeforeSampleIndexes: [],
    };
  }
  return {
    status: "reported",
    source: "target_counter",
    counters: { missingSamples: inferredMissedFrames, droppedSamples: null, overflows: null, readErrors: null, timeouts: null },
    durationValidated,
    provenance: {
      source: "target_counter",
      configuration,
      evaluatedPairs,
      inferredMissedFrames,
    },
    inferredDroppedBeforeSampleIndexes,
  };
}

function validTick(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
}

function validCounterValue(value: unknown, modulus: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < modulus;
}

function counterFrameCount(delta: number, oracle: PreparedQualityOracle): number | undefined {
  const candidates = counterFrameRange(delta, oracle);
  return candidates && candidates.minimumFrames === candidates.maximumFrames ? candidates.minimumFrames : undefined;
}

function counterFrameRange(
  delta: number,
  oracle: PreparedQualityOracle,
): { minimumFrames: number; maximumFrames: number } | undefined {
  if (delta < 1) return undefined;
  const minimumFrames = Math.max(1, Math.ceil((delta - oracle.tolerance) / oracle.expectedIncrement));
  const maximumFrames = Math.floor((delta + oracle.tolerance) / oracle.expectedIncrement);
  return minimumFrames <= maximumFrames ? { minimumFrames, maximumFrames } : undefined;
}

function additionalModuloWrapCouldFit(
  delta: number,
  frames: number,
  previousTick: bigint,
  currentTick: bigint,
  oracle: PreparedQualityOracle,
  rateHz: number,
): boolean {
  const wrappedCandidates = counterFrameRange(delta + oracle.modulus, oracle);
  if (!wrappedCandidates) return false;
  const minimumWrappedFrames = Math.max(wrappedCandidates.minimumFrames, frames + 1);
  if (minimumWrappedFrames > wrappedCandidates.maximumFrames) return false;
  if (!Number.isSafeInteger(rateHz) || rateHz < 1 || currentTick <= previousTick) return true;
  const elapsedFramesUpperBound = ((currentTick - previousTick) * BigInt(rateHz) + 999_999_999n) / 1_000_000_000n + 1n;
  return BigInt(minimumWrappedFrames) <= elapsedFramesUpperBound;
}

function oracleSampleIsValid(sample: { statusFlags: number }): boolean {
  const invalid = HSS_STATUS_FLAGS.read_error
    | HSS_STATUS_FLAGS.timeout
    | HSS_STATUS_FLAGS.overflow
    | HSS_STATUS_FLAGS.dropped_before_this_sample
    | HSS_STATUS_FLAGS.target_halted
    | HSS_STATUS_FLAGS.write_nearby
    | HSS_STATUS_FLAGS.write_in_progress
    | HSS_STATUS_FLAGS.backend_busy;
  return (sample.statusFlags & HSS_STATUS_FLAGS.valid) !== 0 && (sample.statusFlags & invalid) === 0;
}
