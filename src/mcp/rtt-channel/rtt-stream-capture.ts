import type { DecodedTraceAgentStream } from "../rtt-protocols/traceagent-decoder";

export function rttStreamQuality(decoded: DecodedTraceAgentStream): {
  framesTotal: number;
  crcFailures: number;
  sequenceGaps: number;
  duplicateSeqs: number;
  discardedBytes: number;
  successRate: number;
} {
  const failed = decoded.crcFailures + decoded.invalidFrames;
  const total = decoded.frames + failed;
  return {
    framesTotal: decoded.frames,
    crcFailures: decoded.crcFailures,
    sequenceGaps: decoded.sequenceGaps,
    duplicateSeqs: decoded.duplicateSeqs,
    discardedBytes: decoded.discardedBytes,
    successRate: total === 0 ? 0 : decoded.frames / total,
  };
}
