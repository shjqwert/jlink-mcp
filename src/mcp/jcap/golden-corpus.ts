import type { JcapV0Event, JcapV0Provenance, JcapV0Sample } from "./jcap-v0";

const sha = (digit: string) => digit.repeat(64);

export const JCAP_V0_GOLDEN: { provenance: JcapV0Provenance; samples: JcapV0Sample[]; events: JcapV0Event[] } = {
  provenance: {
    captureId: "00000000-0000-4000-8000-000000000001",
    sessionName: "golden",
    backend: "jlink-hss",
    runtime: { dllSha256: sha("1"), helperSha256: sha("2"), adapterSha256: sha("3") },
    target: { targetId: "GOLDEN_MCU", probeSerial: "123", interface: "SWD", speedKhz: 4000 },
    script: { mode: "file", path: "C:\\trust\\script.jlink", sha256: sha("4") },
    reset: { resetBeforeCapture: true, operationDigest: sha("5"), result: "succeeded", stabilizationElapsedMs: 20 },
  },
  samples: [
    { sampleIndex: 0, tick: "10000000", statusFlags: 1, values: { counter: 10, feedback: 1.5 } },
    { sampleIndex: 1, tick: "20000000", statusFlags: 1, values: { counter: 11, feedback: 2.5 } },
    { sampleIndex: 2, tick: "30000000", statusFlags: 1, values: { counter: 12, feedback: 2 } },
  ],
  events: [
    { eventId: "10000000-0000-4000-8000-000000000001", eventSequence: 0, type: "lifecycle", tick: "0", state: "planned" },
    { eventId: "10000000-0000-4000-8000-000000000002", eventSequence: 1, type: "target_control", tick: "5000000", operation: "reset", result: "succeeded", operationDigest: sha("5") },
    { eventId: "10000000-0000-4000-8000-000000000003", eventSequence: 2, type: "lifecycle", tick: "9000000", state: "active", resetEventId: "10000000-0000-4000-8000-000000000002" },
    { eventId: "10000000-0000-4000-8000-000000000004", eventSequence: 3, type: "variable_write", tick: "20000000", variable: "counter", oldValue: 10, newValue: 11, readback: 11 },
    { eventId: "10000000-0000-4000-8000-000000000005", eventSequence: 4, type: "lifecycle", tick: "31000000", state: "finalizing" },
    { eventId: "10000000-0000-4000-8000-000000000006", eventSequence: 5, type: "lifecycle", tick: "32000000", state: "completed" },
  ],
};

export const JCAP_V0_PRESTART_FAILURE: { provenance: JcapV0Provenance; samples: JcapV0Sample[]; events: JcapV0Event[] } = {
  provenance: { ...JCAP_V0_GOLDEN.provenance, captureId: "00000000-0000-4000-8000-000000000002", script: { mode: "none" } },
  samples: [],
  events: [
    { eventId: "20000000-0000-4000-8000-000000000001", eventSequence: 0, type: "lifecycle", tick: "0", state: "planned" },
    { eventId: "20000000-0000-4000-8000-000000000002", eventSequence: 1, type: "fault", tick: "1", code: "HSS_START_FAILED" },
    { eventId: "20000000-0000-4000-8000-000000000003", eventSequence: 2, type: "lifecycle", tick: "2", state: "failed", reason: "HSS_START_FAILED" },
  ],
};
