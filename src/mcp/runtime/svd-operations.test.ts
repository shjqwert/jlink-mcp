import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ProbeBackend } from "../../probe/backend";
import { ProbeErrorCode, type CommandResult } from "../../probe/backend";
import { DirectMcuService } from "./direct-operations";
import { ProbeQueue } from "./probe-queue";
import { SvdRegisterService } from "./svd-operations";
import { TargetStore } from "./target-store";

test("peripheral tools require an explicit SVD and issue no fallback memory access", async (context) => {
  const fixture = await createFixture(context, "missing", false);
  const result = await fixture.service.readRegister(fixture.projectRoot, "GPIO.CTRL");
  assert.equal(result.error?.code, "SVD_NOT_CONFIGURED");
  assert.deepEqual(fixture.probe.actions, []);
});

test("read_registers resolves fields and executes one bounded batch lease", async (context) => {
  const fixture = await createFixture(context, "batch", true);
  fixture.probe.memory.set(0x40000000, Buffer.from("05000000", "hex"));
  fixture.probe.memory.set(0x40000004, Buffer.from("07000000", "hex"));
  const result = await fixture.service.readRegisters(fixture.projectRoot, ["GPIO.CTRL.MODE", "GPIO.STATUS"]);
  assert.equal(result.ok, true);
  assert.equal(typeof result.queueSequence, "number");
  const values = (result.data as { results: Array<Record<string, unknown>> }).results;
  assert.equal(values[0].fieldValue, 2);
  assert.equal(values[1].rawValue, 7);
  assert.deepEqual(fixture.probe.actions, ["read:40000000:4", "read:40000004:4"]);
});

test("whole-register and field writes obey reserved-bit and RMW semantics", async (context) => {
  const whole = await createFixture(context, "whole", true);
  const written = await whole.service.writeRegister({ projectRoot: whole.projectRoot, selector: "GPIO.CTRL", value: 5 });
  assert.equal(written.ok, true);
  assert.equal(written.verification.status, "verified");
  assert.deepEqual(whole.probe.actions, ["write:40000000:4", "read:40000000:4"]);
  assert.match(written.warnings.join("\n"), /system-level effects remain unknown/);
  const reserved = await whole.service.writeRegister({ projectRoot: whole.projectRoot, selector: "GPIO.CTRL", value: 0x80000000 });
  assert.equal(reserved.error?.code, "SVD_RESERVED_BITS_UNSAFE");

  const field = await createFixture(context, "field", true);
  field.probe.memory.set(0x40000000, Buffer.from("01000000", "hex"));
  const changed = await field.service.writeRegister({ projectRoot: field.projectRoot, selector: "GPIO.CTRL.MODE", value: 3 });
  assert.equal(changed.ok, true);
  assert.equal((changed.data as { requestedRegisterValue: number }).requestedRegisterValue, 7);
  assert.deepEqual(field.probe.actions, ["read:40000000:4", "write:40000000:4", "read:40000000:4"]);
});

test("SVD readAction and W1C semantics are blocked before hardware access", async (context) => {
  const fixture = await createFixture(context, "unsafe", true);
  const destructive = await fixture.service.readRegister(fixture.projectRoot, "GPIO.LATCH");
  const w1c = await fixture.service.writeRegister({ projectRoot: fixture.projectRoot, selector: "GPIO.FLAGS.DONE", value: 1 });
  assert.equal(destructive.error?.code, "SVD_READ_ACTION_UNSAFE");
  assert.equal(w1c.error?.code, "SVD_MODIFIED_WRITE_UNSUPPORTED");
  assert.deepEqual(fixture.probe.actions, []);
});

test("field access rejects dangerous sibling read and write semantics", async (context) => {
  const fixture = await createFixture(context, "sibling-semantics", true);
  const read = await fixture.service.readRegister(fixture.projectRoot, "GPIO.SIDE.SAFE");
  const readModifyWrite = await fixture.service.writeRegister({ projectRoot: fixture.projectRoot, selector: "GPIO.SIDE.SAFE", value: 1 });
  const w1cSibling = await fixture.service.writeRegister({ projectRoot: fixture.projectRoot, selector: "GPIO.FLAGS.MODE", value: 1 });
  const writeOnceSibling = await fixture.service.writeRegister({ projectRoot: fixture.projectRoot, selector: "GPIO.ONCE.SAFE", value: 1 });
  assert.equal(read.error?.code, "SVD_READ_ACTION_UNSAFE");
  assert.equal(readModifyWrite.error?.code, "SVD_RMW_UNSAFE");
  assert.equal(w1cSibling.error?.code, "SVD_MODIFIED_WRITE_UNSUPPORTED");
  assert.equal(writeOnceSibling.error?.code, "SVD_RMW_UNSAFE");
  assert.deepEqual(fixture.probe.actions, []);
});

test("a readable field cannot override a write-only containing register", async (context) => {
  const fixture = await createFixture(context, "field-register-access", true);
  const result = await fixture.service.readRegister(fixture.projectRoot, "GPIO.WRITE_ONLY.FIELD");
  assert.equal(result.error?.code, "SVD_READ_NOT_ALLOWED");
  assert.deepEqual(fixture.probe.actions, []);
});

test("write-only registers allow unverified writes but reject read-dependent options", async (context) => {
  const fixture = await createFixture(context, "write-only", true);
  const written = await fixture.service.writeRegister({ projectRoot: fixture.projectRoot, selector: "GPIO.COMMAND", value: 1, verify: false });
  assert.equal(written.ok, true);
  assert.equal(written.verification.status, "executed_unverified");
  for (const option of [{ captureOld: true }, { verify: true }, { restore: true }]) {
    const result = await fixture.service.writeRegister({ projectRoot: fixture.projectRoot, selector: "GPIO.COMMAND", value: 1, ...option });
    assert.equal(result.error?.code, "SVD_READ_NOT_ALLOWED");
  }
  assert.deepEqual(fixture.probe.actions, ["write:40000010:4"]);
});

test("SVD hash is revalidated inside the Probe lease", async (context) => {
  const fixture = await createFixture(context, "stale", true);
  fixture.beforeRuntime = () => writeFileSync(fixture.svdPath, validSvd().replace("Fixture", "Changed"), "utf8");
  const result = await fixture.service.writeRegister({ projectRoot: fixture.projectRoot, selector: "GPIO.CTRL", value: 1 });
  assert.equal(result.error?.code, "SVD_GENERATION_STALE");
  assert.deepEqual(fixture.probe.actions, []);
});

test("non-intrusive peripheral read failure returns HALT_REQUIRED without halt", async (context) => {
  const fixture = await createFixture(context, "halt-required", true);
  fixture.probe.readResult = { success: false, rawOutput: "running read unavailable", output: "", error: "running read unavailable", errorCode: ProbeErrorCode.NON_INTRUSIVE_READ_UNAVAILABLE };
  const result = await fixture.service.readRegister(fixture.projectRoot, "GPIO.STATUS");
  assert.equal(result.error?.code, "HALT_REQUIRED");
  assert.deepEqual(fixture.probe.actions, ["read:40000004:4"]);
});

test("non-intrusive SVD field RMW failure returns HALT_REQUIRED without writing", async (context) => {
  const fixture = await createFixture(context, "rmw-halt-required", true);
  fixture.probe.readResult = { success: false, rawOutput: "running read unavailable", output: "", error: "running read unavailable", errorCode: ProbeErrorCode.NON_INTRUSIVE_READ_UNAVAILABLE };
  const result = await fixture.service.writeRegister({ projectRoot: fixture.projectRoot, selector: "GPIO.CTRL.MODE", value: 1 });
  assert.equal(result.error?.code, "HALT_REQUIRED");
  assert.equal(result.error?.writeIssued, false);
  assert.deepEqual(fixture.probe.actions, ["read:40000000:4"]);
});

test("identical SVD content remains path-specific across projects", async (context) => {
  const fixture = await createFixture(context, "cache-project-a", true);
  const projectB = join(fixture.projectRoot, "..", "project-b");
  mkdirSync(projectB, { recursive: true });
  const svdPathB = join(projectB, "device.svd");
  writeFileSync(svdPathB, validSvd(), "utf8");
  await fixture.targets.configure({ projectRoot: projectB, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 1000, svdPath: svdPathB });
  const first = await fixture.service.readRegister(fixture.projectRoot, "GPIO.STATUS");
  const second = await fixture.service.readRegister(projectB, "GPIO.STATUS");
  assert.equal((first.data as { svd: { path: string } }).svd.path, fixture.svdPath);
  assert.equal((second.data as { svd: { path: string } }).svd.path, svdPathB);
});

async function createFixture(context: TestContext, name: string, withSvd: boolean) {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-svd-ops-${name}-${process.pid}-${Date.now()}`);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  context.after(() => { /* test temp remains outside project sources */ });
  const svdPath = join(projectRoot, "device.svd");
  if (withSvd) writeFileSync(svdPath, validSvd(), "utf8");
  const targets = new TargetStore(join(root, "state"));
  await targets.configure({ projectRoot, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 1000, ...(withSvd ? { svdPath } : {}) });
  const probe = new MemoryProbe();
  const queue = new ProbeQueue(join(root, "queue"));
  const fixture: { beforeRuntime?: () => void } = {};
  const direct = new DirectMcuService(targets, queue, async () => {
    fixture.beforeRuntime?.();
    fixture.beforeRuntime = undefined;
    return { probe: probe as unknown as ProbeBackend };
  });
  const service = new SvdRegisterService(targets, direct);
  return Object.assign(fixture, { projectRoot, svdPath, targets, probe, queue, direct, service });
}

class MemoryProbe {
  actions: string[] = [];
  memory = new Map<number, Buffer>();
  readResult?: CommandResult;

  async observeTargetState() { return { state: "running" as const, source: "fixture", result: ok() }; }
  async readMemory(address: number, length: number) {
    this.actions.push(`read:${address.toString(16)}:${length}`);
    if (this.readResult) return this.readResult;
    const bytes = this.memory.get(address)?.subarray(0, length) ?? Buffer.alloc(length);
    const rawOutput = `${address.toString(16).padStart(8, "0")} = ${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join(" ")}`;
    return { success: true, rawOutput, output: rawOutput };
  }
  async writeMemoryBytes(address: number, bytes: Buffer) {
    this.actions.push(`write:${address.toString(16)}:${bytes.length}`);
    this.memory.set(address, Buffer.from(bytes));
    return ok();
  }
  parseMemoryDump(output: string) {
    const match = output.match(/^([0-9a-fA-F]+)\s*=\s*(.*)$/);
    return match ? [{ address: match[1], hex: match[2] }] : [];
  }
}

function ok(): CommandResult {
  return { success: true, rawOutput: "", output: "ok" };
}

function validSvd(): string {
  return `<?xml version="1.0"?>
<device><name>Fixture</name><cpu><name>CM4</name><endian>little</endian></cpu><size>32</size><access>read-write</access>
<peripherals><peripheral><name>GPIO</name><baseAddress>0x40000000</baseAddress><registers>
<register><name>CTRL</name><addressOffset>0</addressOffset><resetValue>0</resetValue><resetMask>7</resetMask><fields>
<field><name>ENABLE</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
<field><name>MODE</name><bitOffset>1</bitOffset><bitWidth>2</bitWidth></field></fields></register>
<register><name>STATUS</name><addressOffset>4</addressOffset><access>read-only</access><resetValue>0</resetValue><resetMask>0xffffffff</resetMask></register>
<register><name>LATCH</name><addressOffset>8</addressOffset><readAction>clear</readAction><resetValue>0</resetValue><resetMask>0xffffffff</resetMask></register>
<register><name>FLAGS</name><addressOffset>12</addressOffset><resetValue>0</resetValue><resetMask>3</resetMask><fields>
<field><name>DONE</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><modifiedWriteValues>oneToClear</modifiedWriteValues></field>
<field><name>MODE</name><bitOffset>1</bitOffset><bitWidth>1</bitWidth></field></fields></register>
<register><name>COMMAND</name><addressOffset>16</addressOffset><access>write-only</access><resetValue>0</resetValue><resetMask>0xffffffff</resetMask></register>
<register><name>WRITE_ONLY</name><addressOffset>20</addressOffset><access>write-only</access><resetValue>0</resetValue><resetMask>1</resetMask><fields>
<field><name>FIELD</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><access>read-only</access></field></fields></register>
<register><name>SIDE</name><addressOffset>24</addressOffset><resetValue>0</resetValue><resetMask>3</resetMask><fields>
<field><name>SAFE</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
<field><name>CLEAR</name><bitOffset>1</bitOffset><bitWidth>1</bitWidth><readAction>clear</readAction></field></fields></register>
<register><name>ONCE</name><addressOffset>28</addressOffset><resetValue>0</resetValue><resetMask>3</resetMask><fields>
<field><name>SAFE</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
<field><name>LOCK</name><bitOffset>1</bitOffset><bitWidth>1</bitWidth><access>read-writeOnce</access></field></fields></register>
</registers></peripheral></peripherals></device>`;
}
