import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentAnalyzeTool, experimentCompareTool } from "./analysis/tools";
import { evidenceForCodegraphTool } from "./bridge/tools";
import { selectorHints } from "./bridge/queries";
import { readCaptureSamples } from "./capture-storage";
import { captureMetadataToExperimentRecord, loadExperimentForAnalysis } from "./experiment-store";

test("ExperimentStore loads fixture id and rejects fixture path escape", async () => {
  const fixture = await loadExperimentForAnalysis({ experimentId: "generic-control-ideal" });
  assert.equal(fixture.record.source, "fixture");
  assert.equal(fixture.record.experimentId, "fixture_generic_control_ideal");
  const byPath = await loadExperimentForAnalysis({ fixturePath: "generic-control-ideal.experiment.json" });
  assert.equal(byPath.record.experimentId, "fixture_generic_control_ideal");
  await assert.rejects(() => loadExperimentForAnalysis({ fixturePath: "../capture.test.ts" }), /escapes fixture directory/);
});

test("ExperimentStore loads saved .experiment.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jlink-mcp-exp-"));
  try {
    const source = await readFile(join(process.cwd(), "src", "mcp", "fixtures", "generic-control-ideal.experiment.json"), "utf8");
    const experimentPath = join(directory, "saved.experiment.json");
    await writeFile(experimentPath, source);
    const loaded = await loadExperimentForAnalysis({ experimentPath });
    assert.equal(loaded.record.experimentId, "fixture_generic_control_ideal");
    await assert.rejects(() => loadExperimentForAnalysis({ experimentPath: "saved.experiment.json" }), /absolute file path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ExperimentStore converts capture metadata and samples", async () => {
  const { directory, metadataFile, binaryFile, metadata } = await writeSyntheticCapture();
  try {
    const raw = await readCaptureSamples(binaryFile, { maxSamples: 2 });
    assert.deepEqual(raw.samples.map((sample) => sample.values.speed_ref), [0, 10]);
    assert.ok(raw.warnings.some((warning) => /decimated/.test(warning)));

    const plain = await captureMetadataToExperimentRecord(metadata, { metadataFile });
    assert.equal(plain.experimentId, `capture_${metadata.sessionId}`);
    assert.equal(plain.source, "capture");
    assert.equal(plain.target?.device, "TEST_DEVICE");
    assert.equal(plain.capture?.backend, "jlink-gdb-rsp");
    assert.equal(plain.signals.every((signal) => signal.role === "raw"), true);
    assert.equal(plain.samples?.[2].values.speed_rpm, 12);

    const loaded = await loadExperimentForAnalysis({
      metadataFile,
      signalRoles: { speed_ref: "command", speed_rpm: "feedback", fault_code: "fault" },
    });
    assert.deepEqual(loaded.record.signals.map((signal) => [signal.name, signal.role]), [
      ["speed_ref", "command"],
      ["speed_rpm", "feedback"],
      ["fault_code", "fault"],
    ]);
    assert.equal(loaded.record.samples?.[2].values.fault_code, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ExperimentStore rejects capture metadata binaryFile identity mismatches", async () => {
  const { directory, metadataFile, metadata } = await writeSyntheticCapture();
  const otherDirectory = await mkdtemp(join(tmpdir(), "jlink-mcp-other-capture-"));
  try {
    const otherBinary = join(otherDirectory, `2026-06-21T12-34-56-789Z-${metadata.sessionId}.jlcp`);
    await writeFile(otherBinary, syntheticCapture());
    await assert.rejects(
      () => captureMetadataToExperimentRecord({ ...metadata, binaryFile: otherBinary }, { metadataFile }),
      /escapes its metadata directory/,
    );

    const wrongSessionId = "223e4567-e89b-42d3-a456-426614174000";
    const wrongSessionBinary = join(directory, `2026-06-21T12-34-56-789Z-${wrongSessionId}.jlcp`);
    await writeFile(wrongSessionBinary, syntheticCapture());
    await assert.rejects(
      () => captureMetadataToExperimentRecord({ ...metadata, binaryFile: wrongSessionBinary }, { metadataFile }),
      /does not match its sessionId/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(otherDirectory, { recursive: true, force: true });
  }
});

test("ExperimentStore loads capture by exact id and outputDir", async () => {
  const { directory, metadata } = await writeSyntheticCapture();
  try {
    const loaded = await loadExperimentForAnalysis({
      captureId: metadata.sessionId,
      outputDir: directory,
      signalRoles: { speed_ref: "command", speed_rpm: "feedback" },
    });
    assert.equal(loaded.experimentId, `capture_${metadata.sessionId}`);
    await assert.rejects(() => loadExperimentForAnalysis({ captureId: "*", outputDir: directory }), /exact UUID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("analysis and evidence work on converted capture", async () => {
  const { directory, metadataFile } = await writeSyntheticCapture();
  try {
    const analysis = await experimentAnalyzeTool({
      metadataFile,
      analysisProfile: "generic_control",
      signalRoles: { speed_ref: "command", speed_rpm: "feedback", fault_code: "fault" },
    });
    assert.ok(!("error" in analysis));
    assert.ok(analysis.patterns.some((pattern) => pattern.type === "overshoot"));

    const evidence = await evidenceForCodegraphTool({
      metadataFile,
      analysisResult: analysis,
      signalRoles: { speed_ref: "command", speed_rpm: "feedback", fault_code: "fault" },
    });
    assert.ok(!("error" in evidence));
    assert.ok(evidence.queries.some((query) => query.symbols.includes("g_speedRef") && query.symbols.includes("g_speedRpm")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selector parser keeps root symbol and member path", () => {
  assert.deepEqual(selectorHints({
    name: "phase_current",
    selector: "AppMotorDbg.c::gstMotorDbg.fIuPu",
    type: "float32",
    role: "feedback",
  }), {
    name: "phase_current",
    role: "feedback",
    selector: "AppMotorDbg.c::gstMotorDbg.fIuPu",
    symbol: "gstMotorDbg",
    rootSymbol: "gstMotorDbg",
    memberPath: "fIuPu",
    displaySymbol: "gstMotorDbg.fIuPu",
    fileHint: "AppMotorDbg.c",
  });
});

test("experiment_compare treats state_transition as neutral", async () => {
  const result = await experimentCompareTool({
    baselineExperimentId: "generic-fault-transition",
    candidateExperimentId: "generic-fault-transition",
    analysisProfile: "generic_state_machine",
    metrics: ["state_transition"],
  });
  assert.ok(!("error" in result));
  assert.deepEqual(result.metricDiffs, []);
  assert.equal(result.summary.verdict, "warning");
  assert.ok(result.quality.warnings.some((warning) => /neutral/.test(warning)));
});

test("ExperimentStore and analysis bridge stay offline", async () => {
  for (const file of [
    "src/mcp/experiment-store.ts",
    "src/mcp/analysis/tools.ts",
    "src/mcp/bridge/tools.ts",
  ]) {
    const source = await readFile(join(process.cwd(), file), "utf8");
    const imports = source.split(/\r?\n/).filter((line) => line.startsWith("import "));
    assert.equal(imports.some((line) => /@.*codegraph|jlink|gdb|rtt|probe/i.test(line)), false);
    assert.equal(/write_memory|halt\(|resume\(|reset\(|flash\(|startGDBServer|startCapture|capture_control|RTTClient|ProbeBackend/i.test(source), false);
  }
});

async function writeSyntheticCapture(): Promise<{
  directory: string;
  metadataFile: string;
  binaryFile: string;
  metadata: ReturnType<typeof syntheticMetadata>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "jlink-mcp-capture-"));
  const sessionId = "123e4567-e89b-42d3-a456-426614174000";
  const prefix = `2026-06-21T12-34-56-789Z-${sessionId}`;
  const binaryFile = join(directory, `${prefix}.jlcp`);
  const metadataFile = join(directory, `${prefix}.metadata.json`);
  await writeFile(binaryFile, syntheticCapture());
  const metadata = syntheticMetadata(sessionId, binaryFile);
  await writeFile(metadataFile, JSON.stringify(metadata));
  return { directory, metadataFile, binaryFile, metadata };
}

function syntheticMetadata(sessionId: string, binaryFile: string) {
  return {
    version: 1 as const,
    sessionId,
    state: "stopped" as const,
    elfPath: "C:\\firmware.elf",
    elfSha256: "0".repeat(64),
    device: "TEST_DEVICE",
    probeModel: "test",
    probeSerial: "123",
    swdRateKhz: 4000,
    gdbServerPath: "JLinkGDBServerCL.exe",
    gdbServerVersion: "test",
    rspCapabilities: [],
    symbols: [
      { name: "control.c::g_speedRef", alias: "speed_ref", address: 0x20000000, size: 4, type: "float32" as const },
      { name: "sense.c::g_speedRpm", alias: "speed_rpm", address: 0x20000004, size: 4, type: "float32" as const },
      { name: "fault.c::g_faultCode", alias: "fault_code", address: 0x20000008, size: 4, type: "uint32" as const },
    ],
    timing: { actualRateHz: 1 },
    events: [{ qpc: "2000", type: "fault", success: true, detail: "fault_code=3" }],
    failures: [],
    resets: [],
    terminationReason: "test",
    binaryFile,
  };
}

function syntheticCapture(): Buffer {
  const header = Buffer.alloc(52);
  header.write("JLCP", 0, "ascii");
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(52, 8);
  header.writeBigInt64LE(1000n, 12);
  header.writeUInt32LE(3, 20);
  header.writeUInt32LE(184, 24);
  header.writeBigUInt64LE(4n, 28);
  header.writeBigUInt64LE(1n, 36);
  header.writeUInt32LE(2, 44);

  const symbols = Buffer.alloc(464 * 3);
  writeSymbol(symbols, 0, "control.c::g_speedRef", "speed_ref", 0x20000000n, 7);
  writeSymbol(symbols, 464, "sense.c::g_speedRpm", "speed_rpm", 0x20000004n, 7);
  writeSymbol(symbols, 928, "fault.c::g_faultCode", "fault_code", 0x20000008n, 6);
  const frames = Buffer.alloc(184 * 4);
  const values = [
    [0, 0, 0],
    [10, 8, 0],
    [10, 12, 3],
    [10, 10, 3],
  ];
  for (let index = 0; index < values.length; index += 1) {
    const offset = index * 184;
    const qpc = BigInt(index * 1000);
    frames.writeBigUInt64LE(BigInt(index), offset);
    frames.writeBigInt64LE(qpc, offset + 8);
    frames.writeBigInt64LE(qpc, offset + 16);
    frames.writeBigInt64LE(qpc, offset + 24);
    frames.writeBigInt64LE(qpc, offset + 32);
    frames.writeBigInt64LE(10n, offset + 40);
    frames.writeUInt32LE(0, offset + 48);
    frames.writeUInt32LE(1, offset + 52);
    frames.writeUInt32LE(floatBits(values[index][0]), offset + 56);
    frames.writeUInt32LE(floatBits(values[index][1]), offset + 60);
    frames.writeUInt32LE(values[index][2], offset + 64);
  }
  const event = Buffer.alloc(316);
  event.writeBigInt64LE(2000n, 0);
  event.writeUInt32LE(1, 8);
  event.write("fault", 12, "utf8");
  event.write("fault_code=3", 60, "utf8");
  return Buffer.concat([header, symbols, frames, event]);
}

function writeSymbol(buffer: Buffer, offset: number, name: string, alias: string, address: bigint, type: number): void {
  buffer.write(name, offset, "utf8");
  buffer.write(alias, offset + 256, "utf8");
  buffer.writeBigUInt64LE(address, offset + 448);
  buffer.writeUInt32LE(4, offset + 456);
  buffer.writeUInt32LE(type, offset + 460);
}

function floatBits(value: number): number {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeFloatLE(value, 0);
  return bytes.readUInt32LE(0);
}
