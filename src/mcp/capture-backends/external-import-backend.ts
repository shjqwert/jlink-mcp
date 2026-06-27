import { available, capability, type BackendProbeContext, type CaptureBackend, unavailable } from "./capture-backend";

export function createExternalImportBackend(): CaptureBackend {
  const cap = capability("external-import", 4, "offline import from external tools", {
    requiresFirmware: false,
    requiresTargetCodeChange: false,
    supportsRead: false,
    supportsWrite: false,
    supportsStreaming: false,
    supportsRunWhileTargetRunning: false,
    supportsExperimentExport: true,
  });

  return {
    capability: cap,
    probe(context: BackendProbeContext = {}) {
      return context.mode === "offline-import"
        ? available(cap, "available for offline import")
        : unavailable(cap, "external import is offline-only");
    },
  };
}
