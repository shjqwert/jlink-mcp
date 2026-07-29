import assert from "node:assert/strict";
import test from "node:test";
import type { DirectMcuService } from "../runtime/direct-operations";
import { createOperationEnvelope, failEnvelope, finishEnvelope } from "../runtime/operation-envelope";
import type { SessionOperations } from "../runtime/session-operations";
import type { StoredTarget, TargetStore } from "../runtime/target-store";
import { gdbOpen, type SessionToolServices } from "./register-session-tools";

test("gdb_open rejects an implicit exact-device attach before starting a Server", async () => {
  let starts = 0;
  const result = await gdbOpen(services(target(), {
    gdbServerStart: async () => {
      starts += 1;
      return finishEnvelope(createOperationEnvelope("gdb_server_start"), true);
    },
  }), "D:\\fixture", false);

  assert.equal(result.error?.code, "GDB_ATTACH_PROFILE_REQUIRED");
  assert.equal(result.error?.writeIssued, false);
  assert.equal(starts, 0);
});

test("gdb_open preserves an attach fault while closing the same-process client and Server", async () => {
  let stops = 0;
  const clientFailure = failEnvelope(createOperationEnvelope("gdb_connect"), {
    code: "TARGET_FAULTED_DURING_GDB_ATTACH",
    stage: "gdb_connect",
    message: "fixture HardFault_Handler",
    retryable: false,
    writeIssued: true,
    stateUnknown: false,
  });
  clientFailure.observedEffects.push("gdb_client_connected", "target_fault_observed");
  const stopped = finishEnvelope(createOperationEnvelope("gdb_server_stop"), true);
  stopped.observedEffects.push("gdb_client_disconnected", "gdb_server_stopped", "gdb_owner_released");

  const result = await gdbOpen(services(target("Cortex-M4"), {
    gdbServerStart: async () => finishEnvelope(createOperationEnvelope("gdb_server_start"), true),
    gdbConnect: async () => clientFailure,
    gdbServerStop: async () => {
      stops += 1;
      return stopped;
    },
  }), "D:\\fixture", false);

  assert.equal(result.error?.code, "TARGET_FAULTED_DURING_GDB_ATTACH");
  assert.equal(stops, 1);
  assert.match(result.warnings.join("\n"), /managed Server were closed/i);
  assert.ok(result.observedEffects.includes("gdb_owner_released"));
});

test("gdb_open preserves the attach fault but promotes failed cleanup state uncertainty", async () => {
  const clientFailure = failEnvelope(createOperationEnvelope("gdb_connect"), {
    code: "TARGET_FAULTED_DURING_GDB_ATTACH",
    stage: "gdb_connect",
    message: "fixture HardFault_Handler",
    retryable: false,
    writeIssued: true,
    stateUnknown: false,
  });
  const cleanupFailure = failEnvelope(createOperationEnvelope("gdb_server_stop"), {
    code: "GDB_SERVER_STOP_FAILED",
    stage: "cleanup",
    message: "fixture Server ownership could not be released",
    retryable: true,
    writeIssued: false,
    stateUnknown: true,
  });
  cleanupFailure.requestedEffects.push("gdb_client_disconnect", "gdb_server_stop");
  cleanupFailure.observedEffects.push("gdb_client_disconnect_failed");

  const result = await gdbOpen(services(target("Cortex-M4"), {
    gdbServerStart: async () => finishEnvelope(createOperationEnvelope("gdb_server_start"), true),
    gdbConnect: async () => clientFailure,
    gdbServerStop: async () => cleanupFailure,
  }), "D:\\fixture", false);

  assert.equal(result.error?.code, "TARGET_FAULTED_DURING_GDB_ATTACH");
  assert.equal(result.error?.stateUnknown, true);
  assert.ok(result.requestedEffects.includes("gdb_server_stop"));
  assert.ok(result.observedEffects.includes("gdb_client_disconnect_failed"));
  assert.match(result.warnings.join("\n"), /cleanup also failed/i);
});

function target(gdbDevice?: string): StoredTarget {
  return {
    projectRoot: "D:\\fixture",
    generation: "target-generation",
    device: "Z20K146M",
    gdbDevice,
    probeSerial: "123456",
    interface: "SWD",
    speed: 1000,
    artifact: { path: "D:\\fixture\\app.elf", generation: "artifact-generation" },
    liveArtifactMatch: { status: "verified", source: "fixture", timestamp: new Date(0).toISOString() },
  } as StoredTarget;
}

function services(
  configured: StoredTarget,
  sessions: Partial<SessionOperations>,
): SessionToolServices {
  return {
    targets: { require: () => configured } as unknown as TargetStore,
    sessions: sessions as SessionOperations,
    direct: {} as DirectMcuService,
  };
}
