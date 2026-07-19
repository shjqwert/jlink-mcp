import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ResolvedSymbol } from "../artifact/symbol-catalog";
import { appendJcapV1Sample, readJcapV1Raw } from "../jcap/jcap-v1";
import { ArtifactVariableService, type TypedSymbolResolver, type VariableRefInput } from "./artifact-operations";
import { DirectMcuService } from "./direct-operations";
import {
  HssAdapterError,
  HSS_EFFECTIVE_LIMITS,
  type HssCapabilityFacts,
  type HssCaptureControlFiles,
  type HssCaptureLaunch,
  type HssHelperAdapter,
  type HssMemoryRequest,
  type HssMemoryResponse,
  type HssMemoryTransaction,
  type HssRuntimeFacts,
  type HssTimebase,
} from "./hss-helper-adapter";
import { HssOperations, type HssCaptureInput } from "./hss-operations";
import { ProbeQueue, ProbeQueueError } from "./probe-queue";
import { TargetStore, type StoredTarget } from "./target-store";

interface Fixture {
  root: string;
  projectRoot: string;
  store: TargetStore;
  queue: ProbeQueue;
  artifacts: ArtifactVariableService;
  hss: HssOperations;
  adapter: FakeHssAdapter;
  target: StoredTarget;
  ref(index: number): VariableRefInput;
}

test("HSS planning enforces ten variables, 1 kHz, and 60 seconds without creating a package", async () => {
  const fixture = await createFixture();
  try {
    const ten = captureInput(fixture, 10, 1_000, 60);
    const planned = await fixture.hss.plan(ten);
    assert.equal(planned.ok, true);
    assert.deepEqual((planned.data as { limits: unknown }).limits, HSS_EFFECTIVE_LIMITS);
    assert.equal((planned.data as { requestedSamples: number }).requestedSamples, 60_000);
    assert.equal(readdirSync(join(fixture.root, "output")).length, 0);

    const eleven = await fixture.hss.plan(captureInput(fixture, 11, 100, 1));
    assert.equal(eleven.error?.code, "HSS_VARIABLE_BOUNDS");
    const rate = await fixture.hss.plan(captureInput(fixture, 1, 1_001, 1));
    assert.equal(rate.error?.code, "HSS_RATE_BOUNDS");
    const duration = await fixture.hss.plan(captureInput(fixture, 1, 100, 61));
    assert.equal(duration.error?.code, "HSS_DURATION_BOUNDS");

    fixture.adapter.maxFreq = 99;
    const unsupported = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(unsupported.error?.code, "HSS_RATE_UNSUPPORTED");
    assert.equal(readdirSync(join(fixture.root, "output")).length, 0);

    await fixture.store.setArtifactMatch(fixture.projectRoot, "unverified", "test-invalidation", {
      targetGeneration: fixture.target.generation,
      probeSerial: fixture.target.probeSerial,
      artifactGeneration: fixture.target.artifact!.generation,
    });
    const unverified = await fixture.hss.plan(captureInput(fixture, 1, 100, 1));
    assert.equal(unverified.error?.code, "ARTIFACT_NOT_VERIFIED");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fake HSS lifecycle owns the Probe, routes declared writes, restores, and publishes queryable JCAP", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 2, 100, 1));
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const captureId = String((started.data as { captureId: string }).captureId);
    const packageDir = String((started.data as { packageDir: string }).packageDir);
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial)?.kind, "hss");

    await assert.rejects(
      () => fixture.queue.runExclusive(fixture.target.probeSerial, async () => true),
      (error: unknown) => error instanceof ProbeQueueError && error.code === "CAPTURE_ACTIVE",
    );

    const undeclared = await fixture.artifacts.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(3), value: 99 });
    assert.equal(undeclared.error?.code, "VARIABLE_NOT_IN_CAPTURE");
    assert.equal(fixture.adapter.writeCount, 0);

    fixture.adapter.failNextWriteBeforeIssue = true;
    const preIssueFailure = await fixture.artifacts.writeVariable({
      projectRoot: fixture.projectRoot,
      ref: fixture.ref(0),
      value: 10,
      captureOld: true,
      restore: true,
    });
    assert.equal(preIssueFailure.error?.code, "FAKE_WRITE_REJECTED", JSON.stringify(preIssueFailure.error));
    assert.equal(fixture.adapter.writeCount, 0);
    assert.equal(fixture.adapter.valueAt(0x20000000), 7);

    const defaultWrite = await fixture.artifacts.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 11 });
    assert.equal(defaultWrite.ok, true, JSON.stringify(defaultWrite.error));
    assert.equal(defaultWrite.verification?.status, "executed_unverified");
    assert.equal((defaultWrite.data as { oldHex: string | null }).oldHex, null);
    assert.equal((defaultWrite.data as { readbackHex: string | null }).readbackHex, null);

    const declared = await fixture.artifacts.writeVariable({
      projectRoot: fixture.projectRoot,
      ref: fixture.ref(0),
      value: 42,
      captureOld: true,
      verify: true,
      restore: true,
      comparator: { mode: "exact" },
    });
    assert.equal(declared.ok, true, JSON.stringify(declared.error));
    assert.equal((declared.data as { old: number }).old, 11);
    assert.equal((declared.data as { readback: number }).readback, 42);
    assert.equal(((declared.data as { restore: { readback: number } }).restore).readback, 11);
    assert.equal(fixture.adapter.valueAt(0x20000000), 11);
    assert.equal(fixture.adapter.writeCount, 3);

    const stopped = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
    assert.equal((stopped.capture as { state: string }).state, "stopped");
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial), undefined);
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "capture.json", "raw"]);
    assert.deepEqual(readdirSync(join(packageDir, "raw")).sort(), ["events.bin", "samples.bin"]);

    const raw = readJcapV1Raw(packageDir);
    const writeEvents = raw.events.filter((event) => event.type === "variable_write");
    assert.equal(writeEvents.length, 3);
    const defaultEvent = writeEvents[1];
    const writeEvent = writeEvents[2];
    assert.deepEqual((defaultEvent.old as { state: string }).state, "not_requested");
    assert.deepEqual((defaultEvent.readback as { state: string }).state, "not_requested");
    assert.equal(defaultEvent.selector, "var0");
    assert.equal(defaultEvent.tick, defaultEvent.operationEndTick);
    assert.ok(BigInt(String(defaultEvent.operationEndTick)) >= BigInt(String(defaultEvent.operationStartTick)));
    assert.deepEqual((writeEvent.old as { state: string }).state, "captured");
    assert.equal(writeEvent.tick, writeEvent.operationEndTick);
    assert.deepEqual(writeEvent.sampleAlignment, { method: "terminal_raw_nearest", status: "derive_on_rebuild" });
    assert.equal(Object.hasOwn(writeEvent, "neighbors"), false);

    const summary = await fixture.hss.captureSummary(captureId);
    assert.equal(summary.ok, true);
    const series = await fixture.hss.captureSeries({ captureId, variables: ["var0"], startTick: "0", endTick: "100000000", bucketCount: 4 });
    assert.equal(series.ok, true);
    const window = await fixture.hss.captureEventWindow({ captureId, eventId: writeEvent.eventId, variables: ["var0"], beforeMs: 20, afterMs: 20, bucketCount: 4 });
    assert.equal(window.ok, true);
    const indexedWrite = (window.data as { event: Record<string, unknown> }).event;
    assert.deepEqual(indexedWrite.sampleAlignment, { method: "terminal_raw_nearest", status: "resolved" });
    assert.ok(indexedWrite.neighbors && (indexedWrite.neighbors as { before: unknown }).before);
    assert.ok(indexedWrite.neighbors && (indexedWrite.neighbors as { after: unknown }).after);
    const eventOnlyWindow = await fixture.hss.captureEventWindow({ captureId, eventId: writeEvent.eventId, variables: [], beforeMs: 20, afterMs: 20, bucketCount: 4 });
    assert.equal(eventOnlyWindow.ok, true);
    assert.deepEqual((eventOnlyWindow.data as { series: { series: unknown[] } }).series.series, []);
    const rebuilt = await fixture.hss.captureRebuild(captureId);
    assert.equal(rebuilt.ok, true);
    assert.deepEqual(rebuilt.requestedEffects, ["read_authoritative_capture", "build_temporary_capture_index", "atomically_publish_capture_db"]);
    assert.equal(rebuilt.observedEffects.includes("capture_db_atomically_published"), true);
    assert.equal(rebuilt.observedEffects.includes("raw_identities_revalidated"), true);
    const exported = await fixture.hss.captureExport(captureId);
    assert.equal(exported.ok, true);
    assert.deepEqual(exported.requestedEffects, ["read_bounded_capture_rows", "create_external_csv"]);
    assert.equal(exported.observedEffects.includes("external_csv_created"), true);
    assert.equal(String((exported.data as { exportFile: string }).exportFile).startsWith(join(fixture.root, "output", "exports")), true);
    const notInterrupted = await fixture.hss.recover({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(notInterrupted.error?.code, "CAPTURE_NOT_INTERRUPTED");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("dead fake helper becomes interrupted and recovers the trustworthy Raw prefix without changing Raw hashes", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true);
    const captureId = String((started.data as { captureId: string }).captureId);
    const packageDir = String((started.data as { packageDir: string }).packageDir);
    fixture.adapter.crashLatest();
    const stopped = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId });
    assert.equal((stopped.capture as { state: string }).state, "interrupted");
    const before = rawHashes(packageDir);
    const recovered = await fixture.hss.recover({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(recovered.ok, true, JSON.stringify(recovered.error));
    assert.deepEqual(rawHashes(packageDir), before);
    assert.equal(((recovered.data as { index: { indexStatus: string } }).index).indexStatus, "ready");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("durable write response survives event persistence failure and is reconciled before another write", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true);
    const packageDir = String((started.data as { packageDir: string }).packageDir);
    const eventsFile = join(packageDir, "raw", "events.bin");
    const eventsBefore = readFileSync(eventsFile);
    rmSync(eventsFile, { force: true });
    mkdirSync(eventsFile);
    const written = await fixture.artifacts.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 12 });
    assert.equal(written.error?.code, "CAPTURE_EVENT_PERSIST_FAILED");
    assert.equal(written.observedEffects.includes("target_memory_written"), true);
    assert.equal(written.observedEffects.includes("capture_event_appended"), false);
    rmSync(eventsFile, { recursive: true, force: true });
    writeFileSync(eventsFile, eventsBefore, { flag: "wx" });

    const reconciled = await fixture.artifacts.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
    assert.equal(reconciled.error?.code, "HSS_MEMORY_LATE_RESPONSE_RECONCILED");
    assert.equal(fixture.adapter.writeCount, 1);
    const recoveryEvent = readJcapV1Raw(packageDir).events.find((event) => event.type === "variable_write");
    assert.equal((recoveryEvent?.requested as { value: number }).value, 12);
    assert.deepEqual(recoveryEvent?.recoveredTransaction, { source: "durable_hss_memory_receipt", phase: "write" });

    const retried = await fixture.artifacts.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
    assert.equal(retried.ok, true, JSON.stringify(retried.error));
    assert.equal(fixture.adapter.writeCount, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("event persistence before receipt ACK is recovered idempotently without duplicating the write event", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true);
    const packageDir = String((started.data as { packageDir: string }).packageDir);
    fixture.adapter.failNextMemoryAcknowledge = true;
    const written = await fixture.artifacts.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 12 });
    assert.equal(written.ok, true, JSON.stringify(written.error));
    assert.equal(written.warnings.some((warning) => warning.includes("receipt cleanup is pending")), true);
    assert.equal(readJcapV1Raw(packageDir).events.filter((event) => event.type === "variable_write").length, 1);

    const reconciled = await fixture.artifacts.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
    assert.equal(reconciled.error?.code, "HSS_MEMORY_LATE_RESPONSE_RECONCILED");
    assert.equal(fixture.adapter.writeCount, 1);
    assert.equal(readJcapV1Raw(packageDir).events.filter((event) => event.type === "variable_write").length, 1);

    const retried = await fixture.artifacts.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
    assert.equal(retried.ok, true, JSON.stringify(retried.error));
    assert.equal(fixture.adapter.writeCount, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("active status propagates malformed durable receipt failures instead of reporting success", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true);
    const captureId = String((started.data as { captureId: string }).captureId);
    fixture.adapter.failMemoryReceiptInspection = true;
    const status = await fixture.hss.status({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(status.ok, false);
    assert.equal(status.error?.code, "HSS_MEMORY_RECEIPT_INVALID");
    assert.equal(status.error?.stateUnknown, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a reconciled late IPC response never claims that the current restore was issued", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true);
    const captureId = String((started.data as { captureId: string }).captureId);
    const packageDir = String((started.data as { packageDir: string }).packageDir);
    fixture.adapter.failNextRestoreBeforeDispatch = true;
    const written = await fixture.artifacts.writeVariable({
      projectRoot: fixture.projectRoot,
      ref: fixture.ref(0),
      value: 12,
      captureOld: true,
      restore: true,
    });
    assert.equal(written.error?.code, "HSS_MEMORY_LATE_RESPONSE_RECONCILED");
    assert.equal(fixture.adapter.writeCount, 1);
    assert.equal(fixture.adapter.valueAt(0x20000000), 12);

    await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId });
    const event = readJcapV1Raw(packageDir).events.find((candidate) => candidate.type === "variable_write")!;
    assert.equal(event.writeIssued, true);
    assert.deepEqual(event.restore, { state: "failed", attempted: true, writeIssued: false, stateUnknown: true, readback: null, readbackHex: null });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a reconciled late IPC response never attributes an unissued current write", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true);
    const captureId = String((started.data as { captureId: string }).captureId);
    const packageDir = String((started.data as { packageDir: string }).packageDir);
    fixture.adapter.failNextWriteBeforeDispatch = true;
    const written = await fixture.artifacts.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
    assert.equal(written.error?.code, "HSS_MEMORY_LATE_RESPONSE_RECONCILED");
    assert.equal(fixture.adapter.writeCount, 0);
    assert.equal(fixture.adapter.valueAt(0x20000000), 7);

    await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId });
    const event = readJcapV1Raw(packageDir).events.find((candidate) => candidate.type === "variable_write")!;
    assert.equal(event.writeIssued, false);
    assert.equal(event.stateUnknown, true);
    assert.equal((event.requested as { value: number }).value, 13);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a live reused PID with the wrong capture identity is never adopted as Probe owner", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const captureId = String((started.data as { captureId: string }).captureId);
    const owner = fixture.queue.getOwner(fixture.target.probeSerial)!;
    assert.equal(fixture.queue.releaseOwner(fixture.target.probeSerial, owner.token), true);
    const sessionDir = join(fixture.root, "session-work", readdirSync(join(fixture.root, "session-work"))[0]);
    const readyFile = join(sessionDir, "helper.ready.json");
    const ready = JSON.parse(readFileSync(readyFile, "utf8")) as Record<string, unknown>;
    writeFileSync(readyFile, JSON.stringify({ ...ready, helperNonce: "53000000-0000-4000-8000-000000000001" }));

    const status = await fixture.hss.status({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(status.error?.code, "HSS_HELPER_IDENTITY_UNVERIFIED");
    assert.equal(status.error?.stateUnknown, true);
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial), undefined);
  } finally {
    fixture.adapter.crashLatest();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("failed startup cleanup never terminates a live PID whose capture identity cannot be verified", async () => {
  const fixture = await createFixture();
  let captureId: string | undefined;
  try {
    fixture.adapter.failReadyWithReusedPid = true;
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.error?.code, "HSS_READY_INVALID");
    captureId = String((started.data as { captureId: string }).captureId);
    assert.equal(fixture.adapter.terminateCount, 0);
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial)?.kind, "hss");
    assert.equal((started.capture as { state: string }).state, "stopping");

    fixture.adapter.crashLatest();
    const settled = await fixture.hss.status({ projectRoot: fixture.projectRoot, captureId });
    assert.equal((settled.capture as { state: string }).state, "interrupted");
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial), undefined);
  } finally {
    fixture.adapter.crashLatest();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(): Promise<Fixture> {
  const testsRoot = join(process.cwd(), "test-output");
  mkdirSync(testsRoot, { recursive: true });
  const root = mkdtempSync(join(testsRoot, "hss-operations-"));
  const projectRoot = join(root, "project");
  const stateRoot = join(root, "state");
  const outputRoot = join(root, "output");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });
  const artifactPath = join(projectRoot, "firmware.elf");
  writeFileSync(artifactPath, elfFixture());
  const store = new TargetStore(stateRoot);
  const target = await store.configure({
    projectRoot,
    device: "TEST_DEVICE",
    probeSerial: "12345678",
    interface: "SWD",
    speed: 4_000,
    artifactPath,
    memoryRegions: [
      { start: 0x08000000, length: 0x20000, kind: "flash", writable: false },
      { start: 0x20000000, length: 0x10000, kind: "ram", writable: true },
    ],
  });
  await store.setArtifactMatch(projectRoot, "verified", "fake-hss-test", { targetGeneration: target.generation, probeSerial: target.probeSerial, artifactGeneration: target.artifact!.generation });
  const current = store.require(projectRoot);
  const queue = new ProbeQueue(join(root, "queue"));
  const direct = new DirectMcuService(store, queue, async () => { throw new Error("direct backend must not be used by capture-aware tests"); });
  const artifacts = new ArtifactVariableService(store, direct, stateRoot, new FixtureResolver());
  const adapter = new FakeHssAdapter();
  const hss = new HssOperations(store, queue, artifacts, adapter, outputRoot, stateRoot, join(root, "session-work"));
  artifacts.setCaptureWriteDelegate(hss);
  return {
    root,
    projectRoot,
    store,
    queue,
    artifacts,
    hss,
    adapter,
    target: current,
    ref(index: number) { return { artifactGeneration: current.artifact!.generation, qualifiedName: `var${index}`, layoutHash: layoutHash(index) }; },
  };
}

function captureInput(fixture: Fixture, count: number, rateHz: number, durationSec: number): HssCaptureInput {
  return { projectRoot: fixture.projectRoot, rateHz, durationSec, variables: Array.from({ length: count }, (_, index) => ({ ref: fixture.ref(index) })) };
}

class FixtureResolver implements TypedSymbolResolver {
  async resolve(target: StoredTarget, selector: string): Promise<ResolvedSymbol> {
    const match = /^var(\d+)$/.exec(selector);
    if (!match || !target.artifact) throw new Error(`unknown fixture symbol: ${selector}`);
    const index = Number(match[1]);
    const address = 0x20000000 + index * 4;
    return {
      ref: { artifactGeneration: target.artifact.generation, qualifiedName: selector, layoutHash: layoutHash(index) },
      rootAddress: address,
      rootSize: 4,
      memberOffset: 0,
      address,
      type: "uint32",
      size: 4,
      region: "ram",
      hssEligible: true,
      source: "elf-dwarf",
      confidence: "dwarf",
      endian: "little",
    };
  }

  async search(): Promise<Array<Record<string, unknown>>> { return []; }
}

class FakeHssAdapter implements HssHelperAdapter {
  readonly backend = "fake-hss" as const;
  private nextPid = 50_000;
  private qpc = 1_000_000n;
  private qpcEpochMs = Date.now();
  private readonly alive = new Set<number>();
  private readonly pidForControl = new Map<string, number>();
  private readonly records = new Map<string, Array<Record<string, unknown>>>();
  private readonly captureForControl = new Map<string, { packageDir: string; symbols: string[]; nextSampleIndex: number; lastTick: bigint }>();
  private readonly sampleTimers = new Map<number, NodeJS.Timeout>();
  private readonly memory = new Map<number, Buffer>([[0x20000000, u32(7)]]);
  private readonly memoryTransactions = new Map<string, HssMemoryTransaction[]>();
  private nextRequestId = 1;
  writeCount = 0;
  maxFreq = 1_000;
  failNextWriteBeforeIssue = false;
  failNextWriteBeforeDispatch = false;
  failNextRestoreBeforeDispatch = false;
  failNextMemoryAcknowledge = false;
  failMemoryReceiptInspection = false;
  failReadyWithReusedPid = false;
  terminateCount = 0;
  private ignoreNextStopRequest = false;

  async inspectRuntime(): Promise<HssRuntimeFacts> {
    return { backend: this.backend, available: true, helperPath: "fake-helper", runtimePath: "fake-runtime", helperSha256: "2".repeat(64), runtimeSha256: "1".repeat(64), helperVersion: "1", helperProtocolVersion: 1, architecture: process.arch, abi: { fake: true } };
  }

  async capability(_target: StoredTarget, runtime?: HssRuntimeFacts): Promise<HssCapabilityFacts> {
    return { ...(runtime ?? await this.inspectRuntime()), available: true, hardware: { maxBlocks: 10, maxFreq: this.maxFreq, flags: 0, raw: [10, this.maxFreq, 0] }, effective: HSS_EFFECTIVE_LIMITS, observed: { fake: true } };
  }

  async qpcTimebase(): Promise<HssTimebase> {
    this.qpcEpochMs = Date.now();
    return { qpcCounter: this.qpc.toString(), qpcFrequency: "1000000" };
  }

  async launchCapture(_runtime: HssRuntimeFacts, control: HssCaptureControlFiles): Promise<HssCaptureLaunch> {
    const plan = JSON.parse(readFileSync(control.planPath, "utf8")) as { captureId: string; helperInstanceNonce: string; outputFile: string; symbols: Array<{ name: string }> };
    const packageDir = join(plan.outputFile, "..", "..");
    for (let sampleIndex = 0; sampleIndex < 12; sampleIndex += 1) {
      appendJcapV1Sample(packageDir, {
        sampleIndex,
        tick: String(sampleIndex * 10_000_000),
        statusFlags: 1,
        values: Object.fromEntries(plan.symbols.map((symbol, index) => [symbol.name, sampleIndex + index])),
      });
    }
    const pid = this.nextPid++;
    writeFileSync(control.pidFile, JSON.stringify({ captureId: plan.captureId, helperNonce: plan.helperInstanceNonce, pid }), { encoding: "utf8", flag: "wx" });
    writeFileSync(control.readyFile, JSON.stringify({ status: "ready", captureId: plan.captureId, helperNonce: plan.helperInstanceNonce, pid, qpcCounter: this.qpc.toString(), heartbeatSequence: 0 }), { encoding: "utf8", flag: "wx" });
    this.alive.add(pid);
    this.pidForControl.set(control.planPath, pid);
    this.records.set(control.planPath, []);
    this.captureForControl.set(control.planPath, { packageDir, symbols: plan.symbols.map((symbol) => symbol.name), nextSampleIndex: 12, lastTick: 110_000_000n });
    const timer = setInterval(() => {
      if (!this.alive.has(pid)) { clearInterval(timer); return; }
      try { this.appendCaptureSample(control, 10_000_000n); }
      catch { clearInterval(timer); }
    }, 10);
    timer.unref();
    this.sampleTimers.set(pid, timer);
    return { pid, launchedAt: new Date().toISOString(), captureId: plan.captureId, helperNonce: plan.helperInstanceNonce };
  }

  async waitUntilReady(control: HssCaptureControlFiles, launch: HssCaptureLaunch): Promise<void> {
    const ready = JSON.parse(readFileSync(control.readyFile, "utf8")) as { status?: string; captureId?: string; helperNonce?: string; pid?: number };
    if (this.failReadyWithReusedPid) {
      this.failReadyWithReusedPid = false;
      this.ignoreNextStopRequest = true;
      writeFileSync(control.readyFile, JSON.stringify({ ...ready, helperNonce: "53000000-0000-4000-8000-000000000001" }));
      throw new HssAdapterError("HSS_READY_INVALID", "fixture replaced the Helper PID with an unrelated live process", false, true);
    }
    if (ready.status !== "ready" || ready.pid !== launch.pid || ready.captureId !== launch.captureId || ready.helperNonce !== launch.helperNonce) throw new Error("fake Helper readiness mismatch");
  }

  async requestMemory(control: HssCaptureControlFiles, request: HssMemoryRequest): Promise<HssMemoryResponse> {
    const elapsedQpc = 1_000_000n + BigInt(Math.max(0, Date.now() - this.qpcEpochMs)) * 1_000n;
    if (this.qpc < elapsedQpc) this.qpc = elapsedQpc;
    const requestId = `56000000-0000-4000-8000-${String(this.nextRequestId++).padStart(12, "0")}`;
    if (request.op === "resume") return { requestId, status: "ok" };
    const address = Number.parseInt(request.address ?? "", 16);
    const length = request.length ?? 0;
    if (request.op === "read") {
      const bytes = this.memory.get(address) ?? Buffer.alloc(length);
      return { requestId, status: "ok", bytesHex: bytes.subarray(0, length).toString("hex") };
    }
    if (this.failNextWriteBeforeDispatch) {
      this.failNextWriteBeforeDispatch = false;
      throw new HssAdapterError("HSS_MEMORY_LATE_RESPONSE_RECONCILED", "fixture reconciled a prior response before dispatch", true, true, false);
    }
    if (this.failNextWriteBeforeIssue) {
      this.failNextWriteBeforeIssue = false;
      const response = { requestId, status: "error" as const, errorCode: "FAKE_WRITE_REJECTED", reason: "fixture rejected the write before issue", writeIssued: false };
      this.rememberMemoryTransaction(control, request, response);
      return response;
    }
    if (this.failNextRestoreBeforeDispatch && this.writeCount > 0) {
      this.failNextRestoreBeforeDispatch = false;
      throw new HssAdapterError("HSS_MEMORY_LATE_RESPONSE_RECONCILED", "fixture reconciled a prior response before dispatch", true, true, false);
    }
    const before = this.qpc += 1_000n;
    const bytes = Buffer.from(request.bytesHex ?? "", "hex");
    this.memory.set(address, bytes);
    this.writeCount += 1;
    const after = this.qpc += 1_000n;
    this.appendCaptureSample(control, (after - 1_000_000n) * 1_000n);
    const response = { requestId, status: "ok" as const, writeIssued: true, operationBeforeQpcCounter: before.toString(), operationAfterQpcCounter: after.toString() };
    this.rememberMemoryTransaction(control, request, response);
    return response;
  }

  listMemoryTransactions(control: HssCaptureControlFiles): HssMemoryTransaction[] {
    if (this.failMemoryReceiptInspection) throw new HssAdapterError("HSS_MEMORY_RECEIPT_INVALID", "fixture receipt is malformed", false, true, false);
    return structuredClone(this.memoryTransactions.get(control.planPath) ?? []);
  }

  acknowledgeMemoryTransactions(control: HssCaptureControlFiles, requestIds: readonly string[]): void {
    if (this.failNextMemoryAcknowledge) {
      this.failNextMemoryAcknowledge = false;
      throw new HssAdapterError("HSS_MEMORY_ACK_CLEANUP_FAILED", "fixture retained the durable receipt after event persistence", true, true, false);
    }
    const acknowledged = new Set(requestIds);
    this.memoryTransactions.set(control.planPath, (this.memoryTransactions.get(control.planPath) ?? []).filter((transaction) => !acknowledged.has(transaction.request.requestId)));
  }

  async requestStop(control: HssCaptureControlFiles): Promise<void> {
    if (this.ignoreNextStopRequest) {
      this.ignoreNextStopRequest = false;
      return;
    }
    const pid = this.pidForControl.get(control.planPath)!;
    this.alive.delete(pid);
    this.stopSampling(pid);
    this.records.set(control.planPath, [{ record: "result", status: "stopped", missingSamples: 0, droppedSamples: 0, overflows: 0, readErrors: 0, timeouts: 0 }]);
  }

  terminate(pid: number): void { this.terminateCount += 1; this.alive.delete(pid); this.stopSampling(pid); }

  isAlive(pid: number): boolean { return this.alive.has(pid); }

  isCaptureAlive(control: HssCaptureControlFiles, pid: number, captureId: string, helperNonce: string): boolean {
    if (!this.isAlive(pid)) return false;
    try {
      const ready = JSON.parse(readFileSync(control.readyFile, "utf8")) as { captureId?: string; helperNonce?: string; pid?: number };
      return ready.pid === pid && ready.captureId === captureId && ready.helperNonce === helperNonce;
    } catch { return false; }
  }

  async confirmCaptureAlive(control: HssCaptureControlFiles, pid: number, captureId: string, helperNonce: string): Promise<boolean> {
    return this.isCaptureAlive(control, pid, captureId, helperNonce);
  }

  readRecords(control: HssCaptureControlFiles): Array<Record<string, unknown>> { return this.records.get(control.planPath) ?? []; }

  private rememberMemoryTransaction(control: HssCaptureControlFiles, request: HssMemoryRequest, response: HssMemoryResponse): void {
    if (request.op !== "write") return;
    const now = new Date().toISOString();
    const transaction: HssMemoryTransaction = {
      formatVersion: 1,
      request: { formatVersion: 1, requestId: response.requestId, createdAt: now, ...structuredClone(request) },
      response: structuredClone(response),
      receivedAt: now,
    };
    this.memoryTransactions.set(control.planPath, [...(this.memoryTransactions.get(control.planPath) ?? []), transaction]);
  }

  crashLatest(): void { const pid = this.nextPid - 1; this.alive.delete(pid); this.stopSampling(pid); }

  valueAt(address: number): number { return (this.memory.get(address) ?? Buffer.alloc(4)).readUInt32LE(); }

  private appendCaptureSample(control: HssCaptureControlFiles, requestedTick: bigint): void {
    const capture = this.captureForControl.get(control.planPath);
    if (!capture) return;
    const tick = requestedTick > capture.lastTick ? requestedTick : capture.lastTick + 10_000_000n;
    appendJcapV1Sample(capture.packageDir, {
      sampleIndex: capture.nextSampleIndex,
      tick: tick.toString(),
      statusFlags: 1,
      values: Object.fromEntries(capture.symbols.map((symbol, index) => [symbol, capture.nextSampleIndex + index])),
    });
    capture.nextSampleIndex += 1;
    capture.lastTick = tick;
  }

  private stopSampling(pid: number): void {
    const timer = this.sampleTimers.get(pid);
    if (timer) clearInterval(timer);
    this.sampleTimers.delete(pid);
  }
}

function layoutHash(index: number): string {
  return createHash("sha256").update(`var${index}`).digest("hex");
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function rawHashes(packageDir: string): Record<string, string> {
  return Object.fromEntries(["samples.bin", "events.bin"].map((name) => [name, createHash("sha256").update(readFileSync(join(packageDir, "raw", name))).digest("hex")]));
}

function elfFixture(): Buffer {
  const data = Buffer.alloc(0x108);
  data.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 0);
  data[4] = 1;
  data[5] = 1;
  data.writeUInt32LE(52, 28);
  data.writeUInt16LE(52, 40);
  data.writeUInt16LE(32, 42);
  data.writeUInt16LE(2, 44);
  writeProgramHeader(data, 52, 0x100, 0x08000000, 0x08000000, 4, 8, 5);
  writeProgramHeader(data, 84, 0x104, 0x20000000, 0x08000100, 4, 4, 6);
  data.set(Buffer.from([0x11, 0x22, 0x33, 0x44]), 0x100);
  data.set(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]), 0x104);
  return data;
}

function writeProgramHeader(buffer: Buffer, offset: number, fileOffset: number, virtualAddress: number, physicalAddress: number, fileSize: number, memorySize: number, flags: number): void {
  buffer.writeUInt32LE(1, offset);
  buffer.writeUInt32LE(fileOffset, offset + 4);
  buffer.writeUInt32LE(virtualAddress, offset + 8);
  buffer.writeUInt32LE(physicalAddress, offset + 12);
  buffer.writeUInt32LE(fileSize, offset + 16);
  buffer.writeUInt32LE(memorySize, offset + 20);
  buffer.writeUInt32LE(flags, offset + 24);
  buffer.writeUInt32LE(4, offset + 28);
}
