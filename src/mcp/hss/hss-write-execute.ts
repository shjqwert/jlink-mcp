import { randomUUID } from "node:crypto";
import type { HssScalarType } from "./hss-contract";
import { HSS_ERROR, HssError } from "./hss-errors";
import type { HssVariableMemoryIo } from "./hss-memory-io";
import { decodeHssValues, encodeHssValues, hssBytesEqual, type HssTargetEndian } from "./hss-typed-value";
import type { HssVariableWritePlan, HssWriteTargetRef } from "./hss-write-plan";

export interface HssVariableWriteExecuteInput {
  writePlanId?: string;
  artifactFile?: string;
  mapFile?: string;
  target?: string;
  targetRef?: HssWriteTargetRef;
  type?: HssScalarType;
  value?: number;
  values?: number[];
  dryRun?: boolean;
}

export interface HssVariableWriteExecuteResult {
  writeId: string;
  eventId: string;
  captureId: string;
  targetRef: HssVariableWritePlan["targetRef"];
  canonicalTarget: string;
  oldValue?: number;
  oldValues?: number[];
  newValue?: number;
  newValues?: number[];
  readback?: number;
  readbackValues?: number[];
  readbackOk: boolean;
  mismatches: Array<{ index: number; expected: number; readback: number }>;
  hostWriteStartUs?: number;
  hostWriteEndUs?: number;
  captureWriteStartUs?: number;
  captureWriteEndUs?: number;
  writeStartUs: number;
  writeEndUs: number;
  sampleIndexNear: number | null;
  risk: HssVariableWritePlan["risk"];
  consumedWriteOps: number;
  consumedElements: number;
  dryRun?: boolean;
  queueStages?: Array<{ stage: string; timeUs: number }>;
}

export async function executeHssVariableWritePlan(plan: HssVariableWritePlan, io: HssVariableMemoryIo, endian: HssTargetEndian, dryRun = false, setStage: (stage: "PRE_READ_OLD" | "WRITING" | "READBACK") => void = () => undefined): Promise<HssVariableWriteExecuteResult> {
  if (!plan.executable) throw new HssError(HSS_ERROR.POLICY_RISK_NOT_EXECUTABLE, "write plan risk is not executable", { writePlanId: plan.writePlanId, risk: plan.risk, operationPlanRequired: true });
  const type = (plan.dataType ?? plan.elementType) as HssScalarType;
  const values = plan.newValues ?? [plan.newValue as number];
  const address = plan.address ?? plan.elementAddress;
  const accessSize = (plan.byteSize ?? plan.elementSize) as 1 | 2 | 4;
  if (address === undefined) throw new HssError(HSS_ERROR.WRITE_MEMORY_FAILED, "write plan has no address", { writePlanId: plan.writePlanId });
  const writeStartUs = nowUs();
  const encoded = encodeHssValues(type, values, endian);
  if (dryRun) {
    return resultFor(plan, [], values, [], writeStartUs, nowUs(), true, [], true);
  }
  let oldBytes: Buffer;
  try {
    setStage("PRE_READ_OLD");
    oldBytes = await io.read(address, plan.writeByteCount);
  } catch (error) {
    throw hssStageError(error, HSS_ERROR.OLD_VALUE_READ_FAILED, "old value read failed", false);
  }
  const oldValues = decodeHssValues(type, oldBytes, endian);
  try {
    setStage("WRITING");
    await io.write(address, encoded, accessSize);
  } catch (error) {
    throw hssStageError(error, HSS_ERROR.UNKNOWN_WRITE_STATE, "write memory failed; target state is unknown", true);
  }
  let readbackBytes: Buffer;
  try {
    setStage("READBACK");
    readbackBytes = await io.read(address, plan.writeByteCount);
  } catch (error) {
    const result = resultFor(plan, oldValues, values, [], writeStartUs, nowUs(), false, [], false);
    throw new HssError(HSS_ERROR.READBACK_FAILED, "readback failed after write; target state is unknown", { ...result, reason: error instanceof Error ? error.message : String(error), writeIssued: true });
  }
  const readbackValues = decodeHssValues(type, readbackBytes, endian);
  const mismatches = mismatchValues(values, readbackValues);
  if (!hssBytesEqual(encoded, readbackBytes)) {
    const result = resultFor(plan, oldValues, values, readbackValues, writeStartUs, nowUs(), false, mismatches, false);
    throw new HssError(HSS_ERROR.READBACK_MISMATCH, "readback does not match written bytes; target state is unknown", { ...result, writeIssued: true });
  }
  return resultFor(plan, oldValues, values, readbackValues, writeStartUs, nowUs(), true, [], false);
}

function resultFor(plan: HssVariableWritePlan, oldValues: number[], newValues: number[], readbackValues: number[], writeStartUs: number, writeEndUs: number, readbackOk: boolean, mismatches: Array<{ index: number; expected: number; readback: number }>, dryRun: boolean): HssVariableWriteExecuteResult {
  const slice = plan.targetRef.kind === "array_slice";
  return {
    writeId: `wr_${randomUUID()}`,
    eventId: `evt_${randomUUID()}`,
    captureId: plan.captureId,
    targetRef: plan.targetRef,
    canonicalTarget: plan.canonicalTarget,
    oldValue: !slice && oldValues.length ? oldValues[0] : undefined,
    oldValues: slice ? oldValues : undefined,
    newValue: !slice ? newValues[0] : undefined,
    newValues: slice ? newValues : undefined,
    readback: !slice && readbackValues.length ? readbackValues[0] : undefined,
    readbackValues: slice ? readbackValues : undefined,
    readbackOk,
    mismatches,
    hostWriteStartUs: writeStartUs,
    hostWriteEndUs: writeEndUs,
    writeStartUs,
    writeEndUs,
    sampleIndexNear: null,
    risk: plan.risk,
    consumedWriteOps: dryRun ? 0 : 1,
    consumedElements: dryRun ? 0 : plan.writeElementCount,
    dryRun: dryRun || undefined,
  };
}

function mismatchValues(expected: number[], actual: number[]): Array<{ index: number; expected: number; readback: number }> {
  const mismatches: Array<{ index: number; expected: number; readback: number }> = [];
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] !== actual[index]) mismatches.push({ index, expected: expected[index], readback: actual[index] });
  }
  return mismatches;
}

function hssStageError(error: unknown, code: typeof HSS_ERROR[keyof typeof HSS_ERROR], message: string, writeIssued: boolean): HssError {
  if (error instanceof HssError && error.code === code) return error;
  return new HssError(code, message, { reason: error instanceof Error ? error.message : String(error), writeIssued });
}

function nowUs(): number {
  return Date.now() * 1000;
}
