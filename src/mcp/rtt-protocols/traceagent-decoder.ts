import { crc16Ccitt, traceAgentMagic, traceAgentSampleType, traceAgentVersion, traceAgentWriteType } from "./traceagent-codec";
import type { ExperimentRecord, SignalDefinition } from "../experiment-contract";

export interface TraceAgentSampleFrame {
  sequence: number;
  timeMs: number;
  valuesById: Record<number, number>;
}

export interface TraceAgentAckFrame {
  cmdId: number;
  status: number;
  signalId: number;
  readback: number;
}

export interface DecodedTraceAgentStream {
  frames: number;
  sampleFrames: number;
  ackFrames: number;
  invalidFrames: number;
  crcFailures: number;
  discardedBytes: number;
  sequenceGaps: number;
  duplicateSeqs: number;
  firstSeq?: number;
  lastSeq?: number;
  samples: TraceAgentSampleFrame[];
  acks: TraceAgentAckFrame[];
}

export function decodeTraceAgentStream(bytes: Uint8Array): DecodedTraceAgentStream {
  const result: DecodedTraceAgentStream = {
    frames: 0,
    sampleFrames: 0,
    ackFrames: 0,
    invalidFrames: 0,
    crcFailures: 0,
    discardedBytes: 0,
    sequenceGaps: 0,
    duplicateSeqs: 0,
    samples: [],
    acks: [],
  };

  let offset = 0;
  let lastSeq: number | undefined;
  while (offset + 8 <= bytes.length) {
    if (bytes[offset] !== traceAgentMagic[0] || bytes[offset + 1] !== traceAgentMagic[1]) {
      result.discardedBytes += 1;
      offset += 1;
      continue;
    }
    if (bytes[offset + 2] !== traceAgentVersion) {
      result.invalidFrames += 1;
      offset += 2;
      continue;
    }

    const type = bytes[offset + 3];
    const total = traceAgentFrameLength(bytes, offset);
    if (total === 0 || offset + total > bytes.length) break;
    const crcOffset = offset + total - 2;
    const expectedCrc = readUInt16LE(bytes, crcOffset);
    const actualCrc = crc16Ccitt(bytes.subarray(offset + 2, crcOffset));
    if (expectedCrc !== actualCrc) {
      result.crcFailures += 1;
      result.invalidFrames += 1;
      offset += total;
      continue;
    }

    result.frames += 1;
    if (type === traceAgentSampleType) {
      const sample = parseSampleFrame(bytes, offset);
      result.sampleFrames += 1;
      result.samples.push(sample);
      if (lastSeq !== undefined) {
        if (sample.sequence === lastSeq) result.duplicateSeqs += 1;
        else if (sample.sequence > lastSeq + 1) result.sequenceGaps += sample.sequence - lastSeq - 1;
      } else {
        result.firstSeq = sample.sequence;
      }
      lastSeq = sample.sequence;
      result.lastSeq = sample.sequence;
    } else if (type === traceAgentWriteType) {
      result.ackFrames += 1;
      result.acks.push(parseTraceAgentAck(bytes.subarray(offset, offset + total)));
    }
    offset += total;
  }

  if (offset < bytes.length) result.discardedBytes += bytes.length - offset;
  return result;
}

export function parseTraceAgentAck(frame: Uint8Array): TraceAgentAckFrame {
  if (frame.length < 20) throw new Error("TraceAgent ACK frame too short");
  return {
    cmdId: readUInt32LE(frame, 6),
    status: readUInt16LE(frame, 10),
    signalId: readUInt16LE(frame, 12),
    readback: readUInt32LE(frame, 14),
  };
}

export function traceAgentStreamToExperiment(input: {
  decoded: DecodedTraceAgentStream;
  experimentId: string;
  target: ExperimentRecord["target"];
  backend: string;
  signals: Array<SignalDefinition & { id: number }>;
}): ExperimentRecord {
  const signals = input.signals.map(({ id: _id, ...signal }) => signal);
  const byId = new Map(input.signals.map((signal) => [signal.id, signal]));
  const samples = input.decoded.samples.map((sample) => {
    const values: Record<string, number> = {};
    for (const [idText, value] of Object.entries(sample.valuesById)) {
      const signal = byId.get(Number(idText));
      if (!signal) continue;
      values[signal.name] = signal.type === "float32" ? uint32ToFloat32(value) : value;
    }
    return { timeMs: sample.timeMs, values };
  });
  const durationMs = samples.length > 1 ? samples.at(-1)!.timeMs - samples[0].timeMs : 0;

  return {
    experimentId: input.experimentId,
    createdAt: new Date(0).toISOString(),
    source: "imported",
    target: input.target,
    capture: {
      backend: input.backend,
      actualRateHz: durationMs > 0 ? (samples.length - 1) * 1000 / durationMs : 0,
      durationMs,
      quality: {
        frames_total: input.decoded.frames,
        crc_failures: input.decoded.crcFailures,
        sequence_gaps: input.decoded.sequenceGaps,
        duplicate_sequences: input.decoded.duplicateSeqs,
        discarded_bytes: input.decoded.discardedBytes,
      },
    },
    signals,
    events: [],
    timeWindowMs: samples.length > 0 ? [samples[0].timeMs, samples.at(-1)!.timeMs] : [0, 0],
    samples,
  };
}

function traceAgentFrameLength(bytes: Uint8Array, offset: number): number {
  const type = bytes[offset + 3];
  if (type === traceAgentSampleType) {
    if (offset + 18 > bytes.length) return 0;
    const count = readUInt16LE(bytes, offset + 16);
    return 18 + count * 6 + 2;
  }
  if (type === traceAgentWriteType) return 20;
  const length = readUInt16LE(bytes, offset + 4);
  return 6 + length + 2;
}

function parseSampleFrame(bytes: Uint8Array, offset: number): TraceAgentSampleFrame {
  const count = readUInt16LE(bytes, offset + 16);
  const valuesById: Record<number, number> = {};
  let cursor = offset + 18;
  for (let i = 0; i < count; i += 1) {
    valuesById[readUInt16LE(bytes, cursor)] = readUInt32LE(bytes, cursor + 2);
    cursor += 6;
  }
  return {
    sequence: readUInt32LE(bytes, offset + 6),
    timeMs: readUInt32LE(bytes, offset + 10) / 1000,
    valuesById,
  };
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function uint32ToFloat32(value: number): number {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer.readFloatLE(0);
}
