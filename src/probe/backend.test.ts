import assert from "node:assert/strict";
import test from "node:test";
import { ProbeBackend, type CommandResult, type GDBServerInfo } from "./backend";
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
  stopGDBServer(): { success: boolean; message: string } { return { success: true, message: "ok" }; }
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

function ok(): CommandResult {
  return { success: true, rawOutput: "", output: "" };
}
