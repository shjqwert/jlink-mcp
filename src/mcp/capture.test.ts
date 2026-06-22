import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CAPTURE_IPC_VERSION,
  decodeCaptureIpc,
  encodeCaptureIpc,
  projectControlConfigSchema,
} from "./capture-contract";
import { loadProjectControlConfig, parseGdbSections, parseGdbSymbolOutput, validateSelector } from "../gdb/elf-resolver";
import {
  CaptureService,
  queryCaptureFile,
  readCaptureHeader,
  selectProbeSerial,
  selectSessionArtifacts,
  transitionCaptureState,
  validateRequestedSymbols,
  writeCaptureCsv,
  validateServerIdentity,
} from "./capture";
import { JLinkBackend } from "../probe/jlink";
import { ProcessManager } from "../utils/process-manager";

const execFileAsync = promisify(execFile);

test("capture contracts round-trip and reject unsafe control input", () => {
  const message = {
    version: CAPTURE_IPC_VERSION,
    id: "request-1",
    type: "prepare",
    payload: { symbols: [{ name: "motor.c::state.speed" }] },
  } as const;
  assert.deepEqual(decodeCaptureIpc(encodeCaptureIpc(message).trim()), message);
  assert.throws(() => decodeCaptureIpc('{"version":2,"id":"x","type":"prepare","payload":{}}'));

  const config = projectControlConfigSchema.parse({
    version: 1,
    commands: {
      start: {
        selector: "motor.c::command.enable",
        type: "uint32",
        value: 1,
        verify: { selector: "motor.c::state.running", type: "uint32", operator: "eq", value: 1 },
      },
      stop: {
        selector: "motor.c::command.enable",
        type: "uint32",
        value: 0,
        verify: { selector: "motor.c::state.running", type: "uint32", operator: "eq", value: 0 },
      },
    },
  });
  assert.equal(config.preStartMs, 500);
  assert.equal(config.postStopMs, 1000);
  assert.throws(() => projectControlConfigSchema.parse({
    ...config,
    commands: {
      ...config.commands,
      start: { ...config.commands.start, address: 0x20000000 },
    },
  }));
  assert.throws(() => projectControlConfigSchema.parse({
    ...config,
    commands: {
      ...config.commands,
      start: { ...config.commands.start, selector: "command->enable" },
    },
  }));
});

test("capture artifact query preserves spikes and CSV preserves special floats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jlink-mcp-test-"));
  const binary = join(directory, "capture.jlcp");
  const csv = join(directory, "capture.csv");
  try {
    await writeFile(binary, syntheticCapture());
    const header = await readCaptureHeader(binary);
    assert.equal(header.frameCount, 3n);
    assert.deepEqual(header.symbols.map((symbol) => symbol.type), ["float32", "uint32"]);
    const query = await queryCaptureFile(binary, { variables: ["spike"], buckets: 1 }) as {
      buckets: Array<{ values: Record<string, { min: number; max: number; average: number }> }>;
    };
    assert.equal(query.buckets[0].values.spike.min, 1);
    assert.equal(query.buckets[0].values.spike.max, 100);
    assert.equal(query.buckets[0].values.spike.average, 103 / 3);

    await writeCaptureCsv(binary, csv);
    const exported = await readFile(csv, "utf8");
    assert.match(exported, /NaN/);
    assert.match(exported, /Infinity/);
    assert.match(exported, /-Infinity/);
    assert.match(exported.split(/\r?\n/, 1)[0], /"signal,""raw"""/);
    await assert.rejects(() => writeCaptureCsv(binary, csv), { code: "EEXIST" });
    assert.equal(await readFile(csv, "utf8"), exported);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture state transitions and deletion matching fail closed", () => {
  assert.equal(transitionCaptureState("idle", "preparing"), "preparing");
  assert.equal(transitionCaptureState("preparing", "armed"), "armed");
  assert.throws(() => transitionCaptureState("armed", "completed"));
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const prefix = `2026-06-21T12-34-56-789Z-${id}`;
  assert.deepEqual(selectSessionArtifacts([
    `${prefix}.jlcp`,
    `${prefix}.metadata.json`,
    `${prefix}.native.json`,
    `${prefix}.csv`,
    `${prefix}.txt`,
    `unrelated-${id}.json`,
    "unrelated.jlcp",
  ], id), [`${prefix}.jlcp`, `${prefix}.metadata.json`, `${prefix}.native.json`, `${prefix}.csv`]);
  assert.throws(() => selectSessionArtifacts(["capture.jlcp"], "*"));
  assert.throws(() => validateRequestedSymbols([{ name: "a", alias: "b" }, { name: "b" }]), /Duplicate capture name or alias/);
  assert.throws(() => validateRequestedSymbols([{ name: "a".repeat(256) }]), /255-byte/);
});

test("probe ownership rejects conflicts and cannot preempt an active operation", async () => {
  const probe = new JLinkBackend({ device: "TEST" }, new ProcessManager());
  assert.equal(probe.acquireExclusive("capture:test"), true);
  const blocked = await probe.withPreflight("test", async () => ({ success: true, rawOutput: "", output: "ok" }), true);
  assert.equal(blocked.success, false);
  assert.match(blocked.output, /exclusively owned/);
  probe.releaseExclusive("capture:test");

  let finish!: () => void;
  const active = probe.withPreflight("test", () => new Promise((resolve) => {
    finish = () => resolve({ success: true, rawOutput: "", output: "ok" });
  }), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probe.acquireExclusive("capture:test"), false);
  finish();
  assert.equal((await active).success, true);
  assert.equal(probe.acquireExclusive("capture:test"), true);
  probe.releaseExclusive("capture:test");
});

test("probe selection and server identity fail closed", () => {
  assert.equal(selectProbeSerial("123", ["456"]), "123");
  assert.equal(selectProbeSerial(undefined, ["123"]), "123");
  assert.throws(() => selectProbeSerial(undefined, ["123", "456"]), /Multiple J-Link probes/);
  assert.throws(() => selectProbeSerial(undefined, []), /No J-Link probe/);
  const identity = validateServerIdentity([
    "SEGGER J-Link GDB Server V8.84",
    "Hardware version: J-Link CE",
    "VTref=3.300V",
    "S/N: 123",
  ], "target is running", "Z20K146MC", "123");
  assert.equal(identity.voltage, 3.3);
  assert.match(identity.model, /J-Link CE/);
  assert.throws(() => validateServerIdentity(["SEGGER J-Link GDB Server V8.84"], "target is running", "Z20K146MC", "123"), /voltage/);
});

test("capture list and delete stay inside the selected directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jlink-mcp-storage-"));
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const prefix = `2026-06-21T12-34-56-789Z-${id}`;
  const binaryFile = join(directory, `${prefix}.jlcp`);
  const metadataFile = join(directory, `${prefix}.metadata.json`);
  const service = new CaptureService(new JLinkBackend({ device: "TEST" }, new ProcessManager()), new ProcessManager(), "arm-none-eabi-gdb");
  try {
    await writeFile(binaryFile, syntheticCapture());
    await writeFile(metadataFile, JSON.stringify({
      version: 1,
      sessionId: id,
      state: "stopped",
      elfPath: "C:\\firmware.elf",
      elfSha256: "0".repeat(64),
      device: "TEST",
      probeModel: "test",
      swdRateKhz: 4000,
      gdbServerPath: "JLinkGDBServerCL.exe",
      gdbServerVersion: "test",
      rspCapabilities: [],
      symbols: [],
      timing: {},
      events: [],
      failures: [],
      resets: [],
      terminationReason: "test",
      binaryFile,
    }));
    assert.equal((await service.list(directory)).length, 1);
    await assert.rejects(() => service.delete("*"));
    const deleted = await service.delete(id) as { deleted: string[] };
    assert.equal(deleted.deleted.length, 2);
    assert.equal((await service.list(directory)).length, 0);

    const recoveredId = "223e4567-e89b-42d3-a456-426614174000";
    const recoveredPrefix = `2026-06-21T12-34-57-789Z-${recoveredId}`;
    const recoveredBinary = join(directory, `${recoveredPrefix}.jlcp`);
    await writeFile(recoveredBinary, syntheticCapture());
    await writeFile(join(directory, `${recoveredPrefix}.native.json`), JSON.stringify({
      version: 1,
      sessionId: recoveredId,
      state: "failed",
      elfPath: "C:\\firmware.elf",
      elfSha256: "0".repeat(64),
      configPath: "C:\\.jlink-mcp.json",
      device: "TEST",
      probeModel: "test",
      probeSerial: "123",
      swdRateKhz: 4000,
      gdbServerPath: "JLinkGDBServerCL.exe",
      gdbServerVersion: "test",
      binaryFile: recoveredBinary,
      terminationReason: "parent_or_ipc_lost",
      capabilities: "PacketSize=4000",
    }));
    const recovered = await service.list(directory);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].recoveredFromNativeSidecar, true);
    assert.equal((await service.delete(recoveredId) as { deleted: string[] }).deleted.length, 2);
  } finally {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function syntheticCapture(): Buffer {
  const header = Buffer.alloc(52);
  header.write("JLCP", 0, "ascii");
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(52, 8);
  header.writeBigInt64LE(1_000_000n, 12);
  header.writeUInt32LE(2, 20);
  header.writeUInt32LE(184, 24);
  header.writeBigUInt64LE(3n, 28);
  header.writeBigUInt64LE(1n, 36);
  header.writeUInt32LE(2, 44);

  const symbols = Buffer.alloc(464 * 2);
  writeSymbol(symbols, 0, "signal", "signal,\"raw\"", 0x20000000n, 7);
  writeSymbol(symbols, 464, "spike", "spike", 0x20000004n, 6);
  const frames = Buffer.alloc(184 * 3);
  const floatValues = [NaN, Infinity, -Infinity];
  const spikeValues = [1, 100, 2];
  for (let index = 0; index < 3; index += 1) {
    const offset = index * 184;
    const qpc = BigInt(1000 + index * 1000);
    frames.writeBigUInt64LE(BigInt(index), offset);
    frames.writeBigInt64LE(qpc, offset + 8);
    frames.writeBigInt64LE(qpc - 25n, offset + 16);
    frames.writeBigInt64LE(qpc + 25n, offset + 24);
    frames.writeBigInt64LE(qpc, offset + 32);
    frames.writeBigInt64LE(50n, offset + 40);
    frames.writeUInt32LE(1, offset + 52);
    frames.writeFloatLE(floatValues[index], offset + 56);
    frames.writeUInt32LE(spikeValues[index], offset + 60);
  }
  const event = Buffer.alloc(316);
  event.writeBigInt64LE(3000n, 0);
  event.writeUInt32LE(1, 8);
  event.write("termination", 12, "utf8");
  event.write("test", 60, "utf8");
  return Buffer.concat([header, symbols, frames, event]);
}

function writeSymbol(buffer: Buffer, offset: number, name: string, alias: string, address: bigint, type: number): void {
  buffer.write(name, offset, "utf8");
  buffer.write(alias, offset + 256, "utf8");
  buffer.writeBigUInt64LE(address, offset + 448);
  buffer.writeUInt32LE(4, offset + 456);
  buffer.writeUInt32LE(type, offset + 460);
}

test("ELF parser accepts writable aligned scalars and rejects unsafe selectors", () => {
  const sections = parseGdbSections("  [ 1] 0x20000000 -> 0x20000100 at 0x00001000: .data ALLOC LOAD DATA HAS_CONTENTS");
  assert.equal(sections.length, 1);
  assert.deepEqual(parseGdbSymbolOutput(
    "__JL_BEGIN_0__\n__JL_ADDR_0__=0x20000004\n__JL_SIZE_0__=4\ntype = volatile uint32_t\n__JL_END_0__",
    [{ name: "motor.c::state.speed" }],
    sections,
  )[0], { name: "motor.c::state.speed", address: 0x20000004, size: 4, type: "uint32" });
  assert.throws(() => validateSelector("motor->speed"));
  assert.throws(() => validateSelector("motor.values[0]"));
  assert.throws(() => validateSelector("source.c\necho injected::value"));
  assert.throws(() => validateSelector("source.c;quit::value"));
  assert.throws(() => parseGdbSymbolOutput(
    "__JL_BEGIN_0__\n__JL_ADDR_0__=0x40000000\n__JL_SIZE_0__=4\ntype = uint32_t\n__JL_END_0__",
    [{ name: "peripheral" }],
    [{ name: ".data", start: 0x40000000, end: 0x40000100, flags: ["ALLOC", "LOAD", "DATA"] }],
  ));
});

test("project control config must be strict and Git-tracked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jlink-mcp-config-"));
  const configFile = join(directory, ".jlink-mcp.json");
  try {
    await execFileAsync("git", ["init", "-q", directory]);
    await writeFile(configFile, JSON.stringify(projectControlConfigSchema.parse({
      version: 1,
      commands: {
        start: { selector: "motor.command", type: "uint32", value: 1, verify: { selector: "motor.running", type: "uint32", operator: "eq", value: 1 } },
        stop: { selector: "motor.command", type: "uint32", value: 0, verify: { selector: "motor.running", type: "uint32", operator: "eq", value: 0 } },
      },
    })));
    await assert.rejects(() => loadProjectControlConfig(configFile), /must be tracked/);
    await execFileAsync("git", ["-C", directory, "add", ".jlink-mcp.json"]);
    const loaded = await loadProjectControlConfig(configFile);
    assert.equal(loaded.config.commands.start.value, 1);
    assert.equal(loaded.config.commands.stop.timeoutMs, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
