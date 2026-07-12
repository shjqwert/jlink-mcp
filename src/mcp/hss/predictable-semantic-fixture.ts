export interface PredictableSemanticRecord {
  sampleIndex: bigint;
  timestampTicks: bigint;
  statusFlags: number;
  counter: number;
}

const SAMPLE_INDICES = [40n, 41n, 43n, 44n] as const;
const START_COUNTER = 1000;
const COUNTER_STEP = 7;
const TICK_STEP_NS = 250_000n;
const VALID = 1;
const DROPPED_BEFORE_THIS_SAMPLE = 1 << 4;

// Independent oracle: value = 1000 + 7 * (sampleIndex - 40), tick = 250000 ns * (sampleIndex - 40).
export function createPredictableSemanticFixture(): {
  bytes: Buffer;
  symbolCount: 1;
  recordSize: 28;
  counterStep: number;
  tickStepNs: bigint;
  expected: PredictableSemanticRecord[];
} {
  const expected = SAMPLE_INDICES.map((sampleIndex) => {
    const offset = sampleIndex - SAMPLE_INDICES[0];
    return {
      sampleIndex,
      timestampTicks: offset * TICK_STEP_NS,
      statusFlags: VALID | (sampleIndex === 43n ? DROPPED_BEFORE_THIS_SAMPLE : 0),
      counter: START_COUNTER + Number(offset) * COUNTER_STEP,
    };
  });
  const bytes = Buffer.alloc(expected.length * 28);
  expected.forEach((record, index) => {
    const offset = index * 28;
    bytes.writeBigUInt64LE(record.sampleIndex, offset);
    bytes.writeBigUInt64LE(record.timestampTicks, offset + 8);
    bytes.writeUInt32LE(record.statusFlags, offset + 16);
    bytes.writeUInt32LE(0, offset + 20);
    bytes.writeUInt32LE(record.counter, offset + 24);
  });
  return { bytes, symbolCount: 1, recordSize: 28, counterStep: COUNTER_STEP, tickStepNs: TICK_STEP_NS, expected };
}
