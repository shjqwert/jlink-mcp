import { ProbeBackend, ProbeType } from "./backend";
import { JLinkBackend, JLinkConfig } from "./jlink";
import { ProcessManager } from "../utils/process-manager";
import { log } from "../utils/logger";

export interface ProbeFactoryConfig {
  type: "jlink";
  jlink?: Partial<JLinkConfig>;
}

export function createProbeBackend(
  config: ProbeFactoryConfig,
  processManager: ProcessManager
): ProbeBackend {
  const type = (config as { type: string }).type;
  if (type !== "jlink") {
    throw new Error(`Unsupported probe type: ${type}. Supported: jlink`);
  }
  log(`Creating probe backend: ${type}`);

  return new JLinkBackend(config.jlink || {}, processManager);
}

export { ProbeBackend, ProbeType, ProbeState, ProbeErrorCode, ProbeStatus, CommandResult, GDBServerInfo, MemoryDumpLine, CaptureProbeConfig, TargetStateObservation } from "./backend";
export { JLinkBackend, JLinkConfig } from "./jlink";
