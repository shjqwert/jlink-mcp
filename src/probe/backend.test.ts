import assert from "node:assert/strict";
import test from "node:test";
import { ProbeBackend, ProbeErrorCode, type CommandResult, type GDBServerInfo } from "./backend";
import { createProbeBackend } from "./factory";
import { ProcessManager } from "../utils/process-manager";

test("parseMemoryDump accepts J-Link prompt-prefixed memory lines", () => {
  const probe = new TestProbe();
  const raw = "J-Link>20006B30 = 00 00 00 00                                       ....\r";
  const expected = [
    { address: "0x20006B30", hex: "00 00 00 00", ascii: "...." },
  ];
  assert.deepEqual(probe.parseMemoryDump(raw), expected);
});

test("probe factory rejects non-J-Link runtime input", () => {
  assert.throws(
    () => createProbeBackend({ type: "openocd" } as never, new ProcessManager()),
    /Unsupported probe type: openocd\. Supported: jlink/
  );
});

test("parseMemoryDump accepts mem16 and mem32 lines without ASCII columns", () => {
  const probe = new TestProbe();
  assert.deepEqual(probe.parseMemoryDump("20000000 = 2211 4433\n20000004 = 88776655"), [
    { address: "0x20000000", hex: "2211 4433", ascii: "" },
    { address: "0x20000004", hex: "88776655", ascii: "" },
  ]);
});

test("withPreflight returns a read-only failure without recovery or command issue", async () => {
  const probe = new PreflightFailureProbe();
  const result = await probe.withPreflight("read", async () => {
    probe.commandCalls += 1;
    return ok();
  });
  assert.equal(result.success, false);
  assert.equal(probe.commandCalls, 0);
  assert.equal(result.lastSuccessfulStage, "probe_connected");
});

test("state and fault decoding fall back to structured helper output when rawOutput is JSON", async () => {
  const probe = new MemoryOutputProbe();
  probe.memoryResult = {
    success: true,
    rawOutput: '{"status":"ok","samples":[{"bytes":"00000200"}]}',
    output: "e000edf0 = 00 00 02 00",
  };
  const state = await probe.observeTargetState();
  assert.equal(state.state, "halted");
  assert.equal(state.source, "dhcsr");

  probe.memoryResult = {
    success: true,
    rawOutput: '{"status":"ok","samples":[{"bytes":"0100000002000000030000000400000005000000"}]}',
    output: "e000ed28 = 01 00 00 00 02 00 00 00 03 00 00 00 04 00 00 00 05 00 00 00",
  };
  const faults = await probe.readFaultRegisters();
  assert.deepEqual(faults.raw, { cfsr: 1, hfsr: 2, mmfar: 4, bfar: 5 });
});

test("target-state observation fails closed when debug-state preservation is unsupported", async () => {
  const state = await new TestProbe().observeTargetState({ preserveDebugStateOnClose: true });
  assert.equal(state.state, "unknown");
  assert.equal(state.result.errorCode, ProbeErrorCode.NON_INTRUSIVE_READ_UNAVAILABLE);
  assert.equal(state.result.stateUnknown, true);
});

class TestProbe extends ProbeBackend {
  readonly type = "jlink" as const;
  readonly displayName = "test";
  async getDeviceInfo(): Promise<CommandResult> { return ok(); }
  async halt(): Promise<CommandResult> { return ok(); }
  async resume(): Promise<CommandResult> { return ok(); }
  async reset(): Promise<CommandResult> { return ok(); }
  async step(): Promise<CommandResult> { return ok(); }
  async readMemory(): Promise<CommandResult> { return ok(); }
  async writeMemory(): Promise<CommandResult> { return ok(); }
  async readAllRegisters(): Promise<CommandResult> { return ok(); }
  async readRegister(): Promise<CommandResult> { return ok(); }
  async flash(): Promise<CommandResult> { return ok(); }
  async erase(): Promise<CommandResult> { return ok(); }
  async setBreakpoint(): Promise<CommandResult> { return ok(); }
  async clearBreakpoints(): Promise<CommandResult> { return ok(); }
  async startGDBServer(): Promise<{ success: boolean; message: string }> { return { success: true, message: "ok" }; }
  async stopGDBServer(): Promise<{ success: boolean; message: string }> { return { success: true, message: "ok" }; }
  isGDBServerRunning(): boolean { return false; }
  getGDBServerStatus(): GDBServerInfo { return { running: false, gdbPort: 0, rttTelnetPort: -1 }; }
  getGDBServerOutput(): string[] { return []; }
  async executeRaw(): Promise<CommandResult> { return ok(); }
  isDeviceConfigured(): boolean { return true; }
  getDeviceName(): string { return "test"; }
  setDevice(): void {}
  async listDevices(): Promise<CommandResult> { return ok(); }
  dispose(): void {}
}

class PreflightFailureProbe extends TestProbe {
  commandCalls = 0;
  override async preflight(): Promise<CommandResult> {
    return { success: false, rawOutput: "unreachable", output: "unreachable", lastSuccessfulStage: "probe_connected" };
  }
}

class MemoryOutputProbe extends TestProbe {
  memoryResult: CommandResult = ok();
  override async readMemory(): Promise<CommandResult> { return this.memoryResult; }
}

function ok(): CommandResult {
  return { success: true, rawOutput: "", output: "" };
}
