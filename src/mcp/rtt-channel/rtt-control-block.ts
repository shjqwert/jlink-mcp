import type { RttChannelInfo, RttChannelSelector, RttChannelSnapshot } from "./rtt-channel-types";

export function findRttChannel<T extends { index: number; name?: string }>(channels: T[], selector: RttChannelSelector): T | undefined {
  return typeof selector === "number"
    ? channels.find((channel) => channel.index === selector)
    : channels.find((channel) => channel.name === selector);
}

export function listRttChannels(snapshot: RttChannelSnapshot): { status: "available" | "unavailable"; reason: string; channels: RttChannelInfo[] } {
  if (!snapshot.controlBlockAddress) return { status: "unavailable", reason: "RTT control block not found", channels: [] };
  return { status: "available", reason: "RTT control block found", channels: [...snapshot.upChannels, ...snapshot.downChannels] };
}

export function requireRttChannel(snapshot: RttChannelSnapshot, direction: "up" | "down", selector: RttChannelSelector): RttChannelInfo {
  if (!snapshot.controlBlockAddress) throw new Error("RTT control block not found");
  const channel = findRttChannel(direction === "up" ? snapshot.upChannels : snapshot.downChannels, selector);
  if (!channel) throw new Error("requested RTT channel not found");
  return channel;
}
