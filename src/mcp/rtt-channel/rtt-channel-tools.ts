import { listRttChannels, requireRttChannel } from "./rtt-control-block";
import { readRttRing, writeRttRing } from "./rtt-ring-buffer";
import type { RttChannelSelector, RttChannelSnapshot, RttRingState } from "./rtt-channel-types";

export function rttChannelListTool(snapshot: RttChannelSnapshot): ReturnType<typeof listRttChannels> {
  return listRttChannels(snapshot);
}

export function rttChannelReadTool(input: {
  snapshot: RttChannelSnapshot;
  selector: RttChannelSelector;
  ring?: RttRingState;
  maxBytes?: number;
}): { channel: number; dataHex: string; nextRdOff: number } {
  const channel = requireRttChannel(input.snapshot, "up", input.selector);
  if (!input.ring) throw new Error("direct RTT up-buffer transport not configured");
  const read = readRttRing(input.ring, input.maxBytes);
  return { channel: channel.index, dataHex: Buffer.from(read.data).toString("hex"), nextRdOff: read.nextRdOff };
}

export function rttChannelWriteTool(input: {
  snapshot: RttChannelSnapshot;
  selector: RttChannelSelector;
  ring?: RttRingState;
  data: Uint8Array;
}): { channel: number; ok: boolean; nextWrOff: number; reason?: string } {
  const channel = requireRttChannel(input.snapshot, "down", input.selector);
  if (!input.ring) throw new Error("direct RTT down-buffer transport not configured");
  const write = writeRttRing(input.ring, input.data);
  return { channel: channel.index, ok: write.ok, nextWrOff: write.nextWrOff, reason: write.reason };
}
