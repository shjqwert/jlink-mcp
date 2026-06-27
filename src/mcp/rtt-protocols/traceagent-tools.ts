import { encodeTraceAgentWriteCommand, frameHex } from "./traceagent-codec";
import { decodeTraceAgentStream, parseTraceAgentAck } from "./traceagent-decoder";

export interface TraceAgentSignalPolicy {
  signal: string;
  signalId: number;
  type: "uint16" | "uint32";
  allowedValues: number[];
  downChannel: string;
  upChannel: string;
}

export const hmC095TraceAgentPolicy: TraceAgentSignalPolicy = {
  signal: "guwWdgFlg",
  signalId: 13,
  type: "uint16",
  allowedValues: [0, 1],
  downChannel: "AI_CMD",
  upChannel: "AI_TRACE",
};

const dangerousSelectors = [
  /^bMotorStarted$/,
  /^AppMotorDbg\.c::gstMotorDbg\./,
  /^AppMotorCtrl\.c::gstMotorCtrl\./,
  /^Debug_IqRef_Probe$/,
  /^Debug_DirCmd_Probe$/,
  /^Debug_State_Probe$/,
  /^Debug_LossSyncReason_Probe$/,
];

export interface TraceAgentTransport {
  write(frame: Uint8Array, downChannel: string): Promise<void> | void;
  readAck?(cmdId: number, upChannel: string): Promise<Uint8Array> | Uint8Array;
}

export async function traceagentWriteSignal(input: {
  signal: string;
  value: number;
  cmdId: number;
  policy?: TraceAgentSignalPolicy;
  transport?: TraceAgentTransport;
}): Promise<{ status: "ok" | "rejected" | "unavailable"; frameHex?: string; reason?: string; readback?: number }> {
  const policy = input.policy ?? hmC095TraceAgentPolicy;
  const reject = validateTraceAgentWrite(policy, input.signal, input.value);
  if (reject) return { status: "rejected", reason: reject };

  const frame = encodeTraceAgentWriteCommand({ cmdId: input.cmdId, signalId: policy.signalId, value: input.value });
  if (!input.transport) return { status: "unavailable", reason: "direct RTT channel transport not configured", frameHex: frameHex(frame) };

  await input.transport.write(frame, policy.downChannel);
  const ackFrame = await input.transport.readAck?.(input.cmdId, policy.upChannel);
  if (!ackFrame) return { status: "unavailable", reason: "TraceAgent ACK transport not configured", frameHex: frameHex(frame) };
  const decoded = decodeTraceAgentStream(ackFrame);
  const ack = decoded.acks[0] ?? parseTraceAgentAck(ackFrame);
  if (ack.status !== 0) return { status: "rejected", reason: `TraceAgent ACK rejected with status ${ack.status}`, frameHex: frameHex(frame), readback: ack.readback };
  if (ack.readback !== input.value) return { status: "rejected", reason: `TraceAgent readback mismatch: ${ack.readback}`, frameHex: frameHex(frame), readback: ack.readback };
  return { status: "ok", frameHex: frameHex(frame), readback: ack.readback };
}

export function validateTraceAgentWrite(policy: TraceAgentSignalPolicy, signal: string, value: number): string | null {
  if (dangerousSelectors.some((pattern) => pattern.test(signal))) return "dangerous variable rejected before hardware send";
  if (signal !== policy.signal) return "signal is not allowlisted";
  if (!Number.isInteger(value)) return "value must be an integer";
  if (!policy.allowedValues.includes(value)) return "value outside allowlist";
  return null;
}

export function traceagentDecodeStream(bytes: Uint8Array): ReturnType<typeof decodeTraceAgentStream> {
  return decodeTraceAgentStream(bytes);
}
