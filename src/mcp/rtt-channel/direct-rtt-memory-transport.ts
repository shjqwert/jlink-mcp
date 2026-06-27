import { readRttRing, writeRttRing } from "./rtt-ring-buffer";

export interface RttRingAddresses {
  bufferAddress: number;
  size: number;
  rdOffAddress: number;
  wrOffAddress: number;
}

export interface DirectRttMemoryIo {
  readMemory(address: number, length: number): Promise<Uint8Array>;
  writeByte(address: number, value: number): Promise<void>;
  writeUInt32(address: number, value: number): Promise<void>;
  dispose?(): Promise<void> | void;
}

export async function readDirectRttRing(io: DirectRttMemoryIo, ring: RttRingAddresses, maxBytes?: number): Promise<{
  data: Uint8Array;
  rdOff: number;
  wrOff: number;
  nextRdOff: number;
}> {
  const state = await loadRingState(io, ring);
  const read = readRttRing(state, maxBytes);
  if (read.nextRdOff !== state.rdOff) await io.writeUInt32(ring.rdOffAddress, read.nextRdOff);
  return { data: read.data, rdOff: state.rdOff, wrOff: state.wrOff, nextRdOff: read.nextRdOff };
}

export async function writeDirectRttRing(io: DirectRttMemoryIo, ring: RttRingAddresses, data: Uint8Array): Promise<{
  ok: boolean;
  rdOff: number;
  wrOff: number;
  nextWrOff: number;
  reason?: string;
}> {
  const state = await loadRingState(io, ring);
  const write = writeRttRing(state, data);
  if (!write.ok) return { ok: false, rdOff: state.rdOff, wrOff: state.wrOff, nextWrOff: state.wrOff, reason: write.reason };
  for (let i = 0; i < data.length; i += 1) {
    await io.writeByte(ring.bufferAddress + ((state.wrOff + i) % ring.size), data[i]);
  }
  await io.writeUInt32(ring.wrOffAddress, write.nextWrOff);
  return { ok: true, rdOff: state.rdOff, wrOff: state.wrOff, nextWrOff: write.nextWrOff };
}

export function parseHexAddress(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, value.startsWith("0x") ? 16 : 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid address: ${value}`);
  return parsed;
}

export function parseRttRingAddresses(input: {
  bufferAddress: string | number;
  size: number;
  rdOffAddress: string | number;
  wrOffAddress: string | number;
}): RttRingAddresses {
  if (!Number.isInteger(input.size) || input.size <= 0 || input.size > 65536) throw new Error("RTT ring size must be 1..65536");
  return {
    bufferAddress: parseHexAddress(input.bufferAddress),
    size: input.size,
    rdOffAddress: parseHexAddress(input.rdOffAddress),
    wrOffAddress: parseHexAddress(input.wrOffAddress),
  };
}

async function loadRingState(io: DirectRttMemoryIo, ring: RttRingAddresses) {
  const [buffer, rdBytes, wrBytes] = await Promise.all([
    io.readMemory(ring.bufferAddress, ring.size),
    io.readMemory(ring.rdOffAddress, 4),
    io.readMemory(ring.wrOffAddress, 4),
  ]);
  return {
    buffer,
    rdOff: readUInt32LE(rdBytes),
    wrOff: readUInt32LE(wrBytes),
  };
}

function readUInt32LE(bytes: Uint8Array): number {
  if (bytes.length < 4) throw new Error("expected uint32 memory read");
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}
