import { available, capability, type BackendProbeContext, type CaptureBackend, unavailable } from "./capture-backend";
import { findRttChannel } from "../rtt-channel/rtt-control-block";

export function createDirectRttChannelBackend(): CaptureBackend {
  const cap = capability("direct-rtt-channel", 2, "existing RTT channel ring-buffer access", {
    requiresFirmware: true,
    requiresTargetCodeChange: false,
    requiresSDK: false,
    supportsRead: true,
    supportsWrite: true,
    supportsStreaming: true,
    supportsRunWhileTargetRunning: true,
  });

  return {
    capability: cap,
    probe(context: BackendProbeContext = {}) {
      const rtt = context.rtt;
      if (!rtt?.controlBlockAddress) return unavailable(cap, "RTT control block not found");
      const selector = rtt.requestedChannelName ?? rtt.requestedChannel;
      if (selector !== undefined) {
        const up = findRttChannel(rtt.upChannels, selector);
        const down = findRttChannel(rtt.downChannels, selector);
        if (!up && !down) return unavailable(cap, "requested RTT channel not found");
      }
      if (rtt.upChannels.length === 0 && rtt.downChannels.length === 0) return unavailable(cap, "requested RTT channel not found");
      return available(cap, "RTT control block and channel metadata available");
    },
  };
}
