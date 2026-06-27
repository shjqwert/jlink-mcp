export const traceAgentMagic = Buffer.from([0xAA, 0x55]);
export const traceAgentVersion = 1;
export const traceAgentSampleType = 1;
export const traceAgentWriteType = 4;

export function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0xFFFF;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

export function encodeTraceAgentWriteCommand(input: { cmdId: number; signalId: number; value: number }): Buffer {
  if (!Number.isInteger(input.cmdId) || input.cmdId < 0) throw new Error("cmdId must be a nonnegative integer");
  if (!Number.isInteger(input.signalId) || input.signalId < 0 || input.signalId > 0xFFFF) throw new Error("signalId must be uint16");
  if (!Number.isInteger(input.value) || input.value < 0 || input.value > 0xFFFFFFFF) throw new Error("value must be uint32");

  const frame = Buffer.alloc(20);
  traceAgentMagic.copy(frame, 0);
  frame[2] = traceAgentVersion;
  frame[3] = traceAgentWriteType;
  frame.writeUInt16LE(8, 4);
  frame.writeUInt32LE(input.cmdId, 6);
  frame.writeUInt16LE(input.cmdId & 0xFFFF, 10);
  frame.writeUInt16LE(input.signalId, 12);
  frame.writeUInt32LE(input.value, 14);
  frame.writeUInt16LE(crc16Ccitt(frame.subarray(2, 18)), 18);
  return frame;
}

export function frameHex(frame: Uint8Array): string {
  return [...frame].map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}
