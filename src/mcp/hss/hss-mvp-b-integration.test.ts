import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ProcessManager } from "../../utils/process-manager";
import { JLinkBackend } from "../../probe/jlink";
import { HssCaptureService } from "./hss-capture-service";
import type { HssVariableMemoryIo } from "./hss-memory-io";
import { encodeHssValues } from "./hss-typed-value";
import { HSS_STATUS_FLAGS } from "./hss-status-flags";

test("MVP-B fake backend completes scalar, array element, and array slice write workflow", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const memory = new FakeMemory();
  memory.set(0x20000000, encodeHssValues("int32", [0], "little"));
  memory.set(0x20000010 + 4, encodeHssValues("int16", [0], "little"));
  memory.set(0x20000020 + 8, encodeHssValues("int16", [0, 0, 0, 0], "little"));
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    memoryIo: memory,
  });
  try {
    await writeProject(root);
    await writePolicy(root);
    await writeFile(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", "utf8");
    await writeFile(helper, fakeHelperSource(), "utf8");
    const start = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "Debug_IqRef", type: "int32" }],
      requestedRateHz: 100,
      durationSec: 1,
    });
    assert.equal(start.ok, true);
    const captureId = (start.data as { captureId: string }).captureId;
    const scalarPlan = await service.variableWritePlan({ captureId, targetRef: { kind: "scalar", path: "Debug_IqRef" }, value: 120 });
    const scalarExec = await service.variableWriteExecute({ writePlanId: scalarPlan.data!.writePlanId });
    assert.equal(scalarExec.ok, true);
    assert.equal(scalarExec.data!.readback, 120);
    const elementPlan = await service.variableWritePlan({ captureId, targetRef: { kind: "array_element", path: "Debug_TargetTable", index: 2 }, value: 120 });
    const elementExec = await service.variableWriteExecute({ writePlanId: elementPlan.data!.writePlanId });
    assert.equal(elementExec.data!.readback, 120);
    const slicePlan = await service.variableWritePlan({ captureId, targetRef: { kind: "array_slice", path: "Debug_ProfileTable", startIndex: 4 }, values: [100, 120, 140, 160] });
    const sliceExec = await service.variableWriteExecute({ writePlanId: slicePlan.data!.writePlanId });
    assert.deepEqual(sliceExec.data!.readbackValues, [100, 120, 140, 160]);
    assert.deepEqual([...memory.get(0x20000020 + 8, 8)], [...encodeHssValues("int16", [100, 120, 140, 160], "little")]);
    await service.captureStop({ captureId });
    const metadataFile = join(root, ".jlink-mcp", "captures", captureId, "capture.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    assert.equal(existsSync(join(root, ".jlink-mcp", "captures", captureId, "capture.events.jsonl")), true);
    assert.equal(existsSync(join(root, ".jlink-mcp", "captures", captureId, "capture.flags.jsonl")), true);
    assert.equal(metadata.events.filter((event: { type?: string }) => event.type === "variable_write").length, 3);
    assert.ok(metadata.flagIntervals.length >= 6);
    const query = await service.captureQuery({ captureId, mode: "event_window", eventId: scalarExec.data!.eventId, windowBeforeMs: 50, windowAfterMs: 50, includeRawSamples: true, hmC095Profile: false });
    assert.equal(query.ok, true);
    assert.ok(((query.data as { eventWindow: { sampleCount: number } }).eventWindow.sampleCount) > 0);
    const exported = await service.captureExport({ captureId, eventAware: true, eventId: scalarExec.data!.eventId, windowBeforeMs: 50, windowAfterMs: 50 });
    assert.equal(exported.ok, true);
    assert.match(await readFile((exported.data as { csvFile: string }).csvFile, "utf8"), /eventMarker,eventId/);
    const audit = await readAudit(root);
    assert.match(audit, /variable_write_plan/);
    assert.match(audit, /variable_write_execute/);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

class FakeMemory implements HssVariableMemoryIo {
  private readonly memory = new Map<number, Buffer>();
  set(address: number, bytes: Buffer): void { this.memory.set(address, Buffer.from(bytes)); }
  get(address: number, length: number): Buffer { return Buffer.from(this.memory.get(address) ?? Buffer.alloc(length)); }
  async read(address: number, length: number): Promise<Buffer> { return this.get(address, length); }
  async write(address: number, bytes: Buffer): Promise<void> { this.set(address, bytes); }
}

async function writeProject(root: string): Promise<void> {
  const exe = join(root, "Appl", "Debug", "Exe");
  const list = join(root, "Appl", "Debug", "List");
  await mkdir(exe, { recursive: true });
  await mkdir(list, { recursive: true });
  await writeFile(join(exe, "FOC_SCM.out"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]));
  await writeFile(join(list, "FOC_SCM.map"), [
    "Debug_IqRef              0x2000'0000     0x4  Data  Gb  app.o [1]",
    "Debug_TargetTable        0x2000'0010     0x8  Data  Gb  app.o [1]",
    "Debug_ProfileTable       0x2000'0020     0x20 Data  Gb  app.o [1]",
  ].join("\n"), "utf8");
}

async function writePolicy(root: string): Promise<void> {
  await mkdir(join(root, ".jlink-mcp"), { recursive: true });
  await writeFile(join(root, ".jlink-mcp", "policy.json"), JSON.stringify({
    version: 2,
    requireReadback: true,
    variableWriteAllowlist: [
      { path: "Debug_IqRef", kind: "scalar", type: "int32", min: -1000, max: 1000, maxWriteOps: 3 },
      { path: "Debug_TargetTable", kind: "fixed_array", elementType: "int16", arrayLength: 4, allowedIndices: [2], min: -1000, max: 1000, maxWriteOps: 3 },
      { path: "Debug_ProfileTable", kind: "fixed_array", elementType: "int16", arrayLength: 16, allowedIndexRange: { start: 4, end: 7 }, min: -1000, max: 1000, allowArraySliceWrite: true, maxElementsPerWrite: 4, maxElementsTotal: 4, maxWriteOps: 3 },
    ],
  }), "utf8");
}

function fakeHelperSource(): string {
  return `
const fs = require("fs");
const command = process.argv[2];
if (command === "preflight") { console.log(JSON.stringify({ status: "ok", exportsFound: true })); process.exit(0); }
if (command === "connect-preflight") { console.log(JSON.stringify({ status: "ok", targetWasHalted: false, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false })); process.exit(0); }
if (command === "getcaps") { console.log(JSON.stringify({ status: "ok", caps: { maxBlocks: 16, maxFreq: 1000 } })); process.exit(0); }
const plan = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const records = [];
for (let i = 0; i < plan.requestedRateHz * plan.durationSec; i++) {
  const record = Buffer.alloc(28);
  record.writeBigUInt64LE(BigInt(i), 0);
  record.writeBigInt64LE(BigInt(Math.round(i * 1000000000 / plan.requestedRateHz)), 8);
  record.writeUInt32LE(${HSS_STATUS_FLAGS.valid}, 16);
  record.writeUInt32LE(0, 20);
  record.writeUInt32LE(i, 24);
  records.push(record);
}
fs.writeFileSync(plan.outputFile, Buffer.concat(records));
setTimeout(() => console.log(JSON.stringify({ status: "ok", captureId: plan.captureId, requestedRateHz: plan.requestedRateHz, actualRateHz: plan.requestedRateHz, durationSec: plan.durationSec, sampleCount: records.length, validSamples: records.length, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, readMode: plan.readMode, resumeBeforeStart: false, resumeIssued: false, targetWasHaltedBeforeResume: false, targetWasHaltedAfterResume: false, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, hssSampleHeaderBytes: 4, hssSampleStrideBytes: 8, bytesPerSample: 4, hssBlockCount: 1, readBufferBytes: 4096, firstChangedOffset: 0, firstChangedBytes: "00000000", headerChangedRatio: 1, payloadChangedRatio: 1, payloadFirstChangedOffset: 4, payloadFirstChangedBytes: "01000000" })), 500);
`;
}

async function readAudit(root: string): Promise<string> {
  const auditRoot = join(root, ".jlink-mcp", "audit");
  const sessions = await import("node:fs/promises").then((fs) => fs.readdir(auditRoot));
  const chunks = await Promise.all(sessions.map((session) => readFile(join(auditRoot, session, "audit.jsonl"), "utf8").catch(() => "")));
  return chunks.join("\n");
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-mvp-b-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
