export interface RttChannelInfo {
  index: number;
  name?: string;
  direction: "up" | "down";
  size?: number;
}

export interface RttRingState {
  buffer: Uint8Array;
  rdOff: number;
  wrOff: number;
}

export interface RttChannelSnapshot {
  controlBlockAddress?: string;
  upChannels: RttChannelInfo[];
  downChannels: RttChannelInfo[];
}

export type RttChannelSelector = number | string;
