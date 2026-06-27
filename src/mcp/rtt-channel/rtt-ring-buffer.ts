import type { RttRingState } from "./rtt-channel-types";

export function readRttRing(state: RttRingState, maxBytes = Number.MAX_SAFE_INTEGER): { data: Uint8Array; nextRdOff: number } {
  validateRing(state);
  const available = state.wrOff >= state.rdOff
    ? state.wrOff - state.rdOff
    : state.buffer.length - state.rdOff + state.wrOff;
  const count = Math.min(available, maxBytes);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) out[i] = state.buffer[(state.rdOff + i) % state.buffer.length];
  return { data: out, nextRdOff: (state.rdOff + count) % state.buffer.length };
}

export function writeRttRing(state: RttRingState, data: Uint8Array): { ok: boolean; nextWrOff: number; reason?: string; buffer: Uint8Array } {
  validateRing(state);
  const free = state.rdOff > state.wrOff
    ? state.rdOff - state.wrOff - 1
    : state.buffer.length - state.wrOff + state.rdOff - 1;
  if (data.length > free) return { ok: false, nextWrOff: state.wrOff, reason: "insufficient down buffer space", buffer: state.buffer };

  const buffer = new Uint8Array(state.buffer);
  for (let i = 0; i < data.length; i += 1) buffer[(state.wrOff + i) % buffer.length] = data[i];
  return { ok: true, nextWrOff: (state.wrOff + data.length) % buffer.length, buffer };
}

function validateRing(state: RttRingState): void {
  if (state.buffer.length === 0) throw new Error("RTT ring buffer must not be empty");
  if (!Number.isInteger(state.rdOff) || !Number.isInteger(state.wrOff)) throw new Error("RTT offsets must be integers");
  if (state.rdOff < 0 || state.rdOff >= state.buffer.length || state.wrOff < 0 || state.wrOff >= state.buffer.length) throw new Error("RTT offset outside ring");
}
