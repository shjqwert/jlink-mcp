import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ProbeBackend } from "../../probe/backend";
import type { ResolvedSymbol } from "../artifact/symbol-catalog";
import { HSS_STATUS_FLAGS } from "../hss/hss-status-flags";
import { appendJcapV1Sample, readJcapV1Raw } from "../jcap/jcap-v1";
import { ArtifactVariableService, type TypedSymbolResolver } from "./artifact-operations";
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
  type HssTargetState,
  type HssTimebase,
} from "./hss-helper-adapter";
import { HssOperations, type HssCaptureInput } from "./hss-operations";
import { CaptureQueryOperations } from "./capture-query-operations";
import {
  MemorySessionManager,
  type MemorySessionLauncher,
  type MemorySessionRuntimeFacts,
  type PersistentMemorySession,
} from "./memory-session";
import { ProbeQueue, ProbeQueueError } from "./probe-queue";
import { TargetStore, type StoredTarget } from "./target-store";
import type { VariableAccess, VariableRefInput } from "./variable-access-contract";
import { VariableAccessRouter } from "./variable-access-router";

interface Fixture {
  root: string;
  projectRoot: string;
  store: TargetStore;
  queue: ProbeQueue;
  artifacts: ArtifactVariableService;
  variables: VariableAccess;
  hss: HssOperations;
  captures: CaptureQueryOperations;
  adapter: FakeHssAdapter;
  memorySessions?: MemorySessionManager;
  memoryLauncher?: FixtureMemorySessionLauncher;
  resolver: FixtureResolver;
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
    assert.equal((planned.data as { configuredInterface: string }).configuredInterface, "SWD");
    assert.equal((planned.data as { configuredSpeedKHz: number }).configuredSpeedKHz, 4_000);
    assert.equal(readdirSync(join(fixture.root, "output")).length, 0);

    const dryRun = await fixture.hss.start({ ...captureInput(fixture, 2, 100, 1), dryRun: true });
    assert.equal(dryRun.ok, true, JSON.stringify(dryRun.error));
    assert.equal((dryRun.data as { dryRun: boolean }).dryRun, true);
    assert.equal((dryRun.data as { requestedSamples: number }).requestedSamples, 100);
    assert.deepEqual((dryRun.data as { frameLayout: unknown }).frameLayout, {
      hssSampleHeaderBytes: 4,
      valueBytes: 8,
      hssSampleStrideBytes: 12,
      values: [
        { logicalIdentity: "var0", type: "uint32", bytes: 4 },
        { logicalIdentity: "var1", type: "uint32", bytes: 4 },
      ],
    });
    assert.equal((dryRun.data as { estimatedDataBytes: number }).estimatedDataBytes, 1_200);
    assert.equal(fixture.adapter.launchCount, 0, "dry-run must not launch an HSS capture Helper");
    assert.equal(readdirSync(join(fixture.root, "output")).length, 0, "dry-run must not create a JCAP package");
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial), undefined, "dry-run must not retain Probe ownership");

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
    const unverifiedDryRun = await fixture.hss.start({ ...captureInput(fixture, 1, 100, 1), dryRun: true });
    assert.equal(unverifiedDryRun.error?.code, "ARTIFACT_NOT_VERIFIED");
    assert.equal(fixture.adapter.launchCount, 0, "a rejected dry-run must not launch a Helper");
    assert.equal(readdirSync(join(fixture.root, "output")).length, 0, "a rejected dry-run must not create a JCAP package");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a foreign memory owner blocks HSS before runtime inspection or Helper launch", async () => {
  const fixture = await createFixture("uint32", true);
  try {
    let owner!: ReturnType<ProbeQueue["claimOwner"]>;
    await fixture.queue.runExclusive(fixture.target.probeSerial, async (metadata) => {
      owner = fixture.queue.claimOwner(fixture.target.probeSerial, {
        kind: "memory",
        projectRoot: fixture.target.projectRoot,
        targetGeneration: fixture.target.generation,
      }, metadata.leaseToken);
    });
    const dryRun = await fixture.hss.start({ ...captureInput(fixture, 1, 100, 1), dryRun: true });
    assert.equal(dryRun.ok, false);
    assert.equal(dryRun.error?.code, "MEMORY_SESSION_ACTIVE");
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, false);
    assert.equal(started.error?.code, "MEMORY_SESSION_ACTIVE");
    assert.equal((started.probe?.owner as { token: string }).token, owner.token);
    assert.equal(fixture.adapter.inspectCount, 0);
    assert.equal(fixture.adapter.launchCount, 0);
    fixture.queue.releaseOwner(fixture.target.probeSerial, owner.token);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS dry-run releases the current process memory session without changing target state", async () => {
  const fixture = await createFixture("uint32", true);
  try {
    fixture.adapter.targetState = "halted";
    await fixture.queue.runExclusive(fixture.target.probeSerial, async (metadata) => {
      await fixture.memorySessions!.probeFor(fixture.target, metadata);
    });
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial)?.kind, "memory");

    const dryRun = await fixture.hss.start({ ...captureInput(fixture, 1, 100, 1), dryRun: true });

    assert.equal(dryRun.ok, true, JSON.stringify(dryRun.error));
    assert.equal(fixture.memoryLauncher!.sessions[0].closeCalls, 1);
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial), undefined);
    assert.deepEqual((dryRun.data as { memorySessionClose: unknown }).memorySessionClose, {
      targetStateBeforeClose: "halted",
      targetStateAfterReconnect: "halted",
    });
    assert.equal((dryRun.before?.owner as { kind: string }).kind, "memory");
    assert.equal(dryRun.after?.owner, null);
    assert.equal(dryRun.observedEffects.includes("local_memory_session_closed"), true);
    assert.equal(fixture.adapter.targetState, "halted");
    assert.equal(fixture.adapter.launchCount, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fake HSS lifecycle owns the Probe, routes declared writes, restores, and publishes queryable JCAP", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 2, 100, 1, "acceptance-run"));
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const captureId = String((started.data as { captureId: string }).captureId);
    const packageDir = String((started.data as { packageDir: string }).packageDir);
    assert.equal(packageDir.startsWith(join(fixture.root, "output", "acceptance-run", "captures")), true);
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial)?.kind, "hss");

    await assert.rejects(
      () => fixture.queue.runExclusive(fixture.target.probeSerial, async () => true),
      (error: unknown) => error instanceof ProbeQueueError && error.code === "CAPTURE_ACTIVE",
    );

    const undeclared = await fixture.variables.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(3), value: 99 });
    assert.equal(undeclared.error?.code, "VARIABLE_NOT_IN_CAPTURE");
    assert.equal(fixture.adapter.writeCount, 0);

    fixture.adapter.failNextWriteBeforeIssue = true;
    const preIssueFailure = await fixture.variables.writeVariable({
      projectRoot: fixture.projectRoot,
      ref: fixture.ref(0),
      value: 10,
      captureOld: true,
      restore: true,
    });
    assert.equal(preIssueFailure.error?.code, "FAKE_WRITE_REJECTED", JSON.stringify(preIssueFailure.error));
    assert.equal(fixture.adapter.writeCount, 0);
    assert.equal(fixture.adapter.valueAt(0x20000000), 7);

    const defaultWrite = await fixture.variables.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 11 });
    assert.equal(defaultWrite.ok, true, JSON.stringify(defaultWrite.error));
    assert.equal(defaultWrite.verification?.status, "verified");
    assert.equal((defaultWrite.data as { oldHex: string | null }).oldHex, "07000000");
    assert.equal((defaultWrite.data as { readbackHex: string | null }).readbackHex, "0b000000");
    assert.equal((defaultWrite.data as { verificationConnection: string }).verificationConnection, "capture_owner");
    assert.equal((defaultWrite.data as { verificationSource: string }).verificationSource, "capture_owner_readback");
    assert.equal((defaultWrite.data as { targetConsumption: string }).targetConsumption, "not_observed");

    const declared = await fixture.variables.writeVariable({
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
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal((stopped.capture as { state: string }).state, "stopped");
    assert.equal((stopped.capture as { actualRateHz: number }).actualRateHz, 56);
    assert.equal((stopped.capture as { sampleRatio: number }).sampleRatio, 0.56);
    assert.equal((stopped.capture as { sampleThresholdMet: boolean }).sampleThresholdMet, false);
    assert.equal((stopped.capture as { readStatistics: { emptyReads: number } }).readStatistics.emptyReads, 44);
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial), undefined);
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "capture.json", "raw"]);
    assert.deepEqual(readdirSync(join(packageDir, "raw")).sort(), ["events.bin", "samples.bin"]);

    const raw = readJcapV1Raw(packageDir);
    const writeEvents = raw.events.filter((event) => event.type === "variable_write");
    assert.equal(writeEvents.length, 3);
    const defaultEvent = writeEvents[1];
    const writeEvent = writeEvents[2];
    assert.deepEqual((defaultEvent.old as { state: string }).state, "captured");
    assert.deepEqual((defaultEvent.readback as { state: string }).state, "observed");
    assert.equal(defaultEvent.selector, "var0");
    assert.equal(defaultEvent.tick, defaultEvent.operationEndTick);
    assert.ok(BigInt(String(defaultEvent.operationEndTick)) >= BigInt(String(defaultEvent.operationStartTick)));
    assert.deepEqual((writeEvent.old as { state: string }).state, "captured");
    assert.equal(writeEvent.tick, writeEvent.operationEndTick);
    assert.deepEqual(writeEvent.sampleAlignment, { method: "terminal_raw_nearest", status: "derive_on_rebuild" });
    assert.equal(Object.hasOwn(writeEvent, "neighbors"), false);

    const summary = await fixture.captures.summary(captureId);
    assert.equal(summary.ok, true);
    const series = await fixture.captures.series({ captureId, variables: ["var0"], startTick: "0", endTick: "100000000", bucketCount: 4 });
    assert.equal(series.ok, true);
    const window = await fixture.captures.eventWindow({ captureId, eventId: writeEvent.eventId, variables: ["var0"], beforeMs: 20, afterMs: 20, bucketCount: 4 });
    assert.equal(window.ok, true);
    const indexedWrite = (window.data as { event: Record<string, unknown> }).event;
    assert.deepEqual(indexedWrite.sampleAlignment, { method: "terminal_raw_nearest", status: "resolved" });
    assert.ok(indexedWrite.neighbors && (indexedWrite.neighbors as { before: unknown }).before);
    assert.ok(indexedWrite.neighbors && (indexedWrite.neighbors as { after: unknown }).after);
    const eventOnlyWindow = await fixture.captures.eventWindow({ captureId, eventId: writeEvent.eventId, variables: [], beforeMs: 20, afterMs: 20, bucketCount: 4 });
    assert.equal(eventOnlyWindow.ok, true);
    assert.deepEqual((eventOnlyWindow.data as { series: { series: unknown[] } }).series.series, []);
    const exported = await fixture.captures.exportCsv(captureId);
    assert.equal(exported.ok, true);
    assert.deepEqual(exported.requestedEffects, ["read_bounded_capture_rows", "repair_capture_index_if_required", "create_external_csv"]);
    assert.equal(exported.observedEffects.includes("external_csv_created"), true);
    assert.equal(String((exported.data as { exportFile: string }).exportFile).startsWith(join(fixture.root, "output", "acceptance-run", "exports")), true);
    const notInterrupted = await fixture.hss.recover({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(notInterrupted.error?.code, "CAPTURE_NOT_INTERRUPTED");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("active HSS writes fail closed for unconfigured, unknown, crossing, and non-RAM regions", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const captureId = String((started.data as { captureId: string }).captureId);
    const cases: Array<{ name: string; code: string; memoryRegions: StoredTarget["memoryRegions"] }> = [
      { name: "unconfigured", code: "MEMORY_REGION_NOT_VERIFIED", memoryRegions: [] },
      { name: "unknown", code: "MEMORY_REGION_NOT_VERIFIED", memoryRegions: [{ start: 0x20000000, length: 4, kind: "unknown", writable: true }] },
      {
        name: "cross-region",
        code: "MEMORY_RANGE_CROSSES_REGION",
        memoryRegions: [
          { start: 0x20000000, length: 2, kind: "ram", writable: true },
          { start: 0x20000002, length: 2, kind: "peripheral", writable: true },
        ],
      },
      { name: "RAM/peripheral conflict", code: "SYMBOL_REGION_CONFLICT", memoryRegions: [{ start: 0x20000000, length: 4, kind: "peripheral", writable: true }] },
    ];

    for (const scenario of cases) {
      const target = { ...fixture.target, memoryRegions: scenario.memoryRegions };
      const resolved = await fixture.resolver.resolve(target, "var0");
      const result = await fixture.hss.tryWriteVariable(
        { projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 9 },
        target,
        resolved,
        u32(9),
        { mode: "exact", type: "uint32", endian: "little" },
      );

      assert.equal(result?.error?.code, scenario.code, scenario.name);
      assert.equal(result?.error?.writeIssued, false, scenario.name);
      assert.equal(fixture.adapter.writeCount, 0, scenario.name);
      assert.equal(fixture.queue.getOwner(fixture.target.probeSerial)?.kind, "hss", scenario.name);
    }

    const stopped = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS scalar preparation preserves capture and write role errors", async () => {
  const fixture = await createFixture();
  try {
    fixture.resolver.overrides.set(0, { hssEligible: false });
    assert.equal((await fixture.hss.plan(captureInput(fixture, 1, 100, 1))).error?.code, "HSS_VARIABLE_INELIGIBLE");

    fixture.resolver.overrides.set(0, { endian: "big" });
    assert.equal((await fixture.hss.plan(captureInput(fixture, 1, 100, 1))).error?.code, "HSS_ENDIAN_UNSUPPORTED");

    fixture.resolver.overrides.set(0, { type: "float64" as never, size: 8 });
    assert.equal((await fixture.hss.plan(captureInput(fixture, 1, 100, 1))).error?.code, "HSS_SCALAR_UNSUPPORTED");

    fixture.resolver.overrides.set(0, {
      ref: {
        artifactGeneration: fixture.target.artifact!.generation,
        qualifiedName: "x".repeat(257),
        layoutHash: layoutHash(0),
      },
    });
    assert.equal((await fixture.hss.plan(captureInput(fixture, 1, 100, 1))).error?.code, "HSS_VARIABLE_NAME_TOO_LONG");

    fixture.resolver.overrides.clear();
    fixture.resolver.overrides.set(1, { hssEligible: false });
    const writeRole = await fixture.hss.plan({
      ...captureInput(fixture, 1, 100, 1),
      writeVariables: [fixture.ref(1)],
    });
    assert.equal(writeRole.error?.code, "HSS_WRITE_VARIABLE_INELIGIBLE");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS dry-run and start restore an unexpected halted-to-running transition and fail closed", async () => {
  const fixture = await createFixture();
  try {
    fixture.adapter.targetState = "halted";
    fixture.adapter.capabilityStateAfter = "running";

    const dryRun = await fixture.hss.start({ ...captureInput(fixture, 1, 100, 1), dryRun: true });
    assert.equal(dryRun.error?.code, "HSS_TARGET_STATE_CHANGED");
    assert.equal(fixture.adapter.targetState, "halted");
    assert.equal(fixture.adapter.restoreCount, 1);

    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.error?.code, "HSS_TARGET_STATE_CHANGED");
    assert.equal(fixture.adapter.targetState, "halted");
    assert.equal(fixture.adapter.restoreCount, 2);
    assert.equal(fixture.adapter.launchCount, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS stop restores the authorized halted-to-running capture transition", async () => {
  const fixture = await createFixture();
  try {
    fixture.adapter.targetState = "halted";
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true, JSON.stringify(started.error));
    assert.equal(fixture.adapter.resumeCount, 1);
    assert.equal(fixture.adapter.lastPlan?.initialTargetState, "halted");
    assert.equal(fixture.adapter.lastPlan?.expectedTargetState, "running");
    assert.equal(fixture.adapter.lastPlan?.resumeBeforeStart, true);
    assert.equal(started.observedEffects.includes("target_resumed_for_hss"), true);
    fixture.adapter.stopStateAfter = "running";

    const stopped = await fixture.hss.stop({
      projectRoot: fixture.projectRoot,
      captureId: String((started.data as { captureId: string }).captureId),
    });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
    assert.equal(fixture.adapter.targetState, "halted");
    assert.equal(fixture.adapter.restoreCount, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS startup failure restores halted state after the helper exits", async () => {
  const fixture = await createFixture();
  try {
    fixture.adapter.targetState = "halted";
    fixture.adapter.failReadyAndExitStateAfter = "running";
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.error?.code, "HSS_HELPER_EXITED_BEFORE_READY");
    assert.equal(fixture.adapter.targetState, "halted");
    assert.equal(fixture.adapter.restoreCount, 1);
    assert.equal(fixture.adapter.launchCount, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS startup failure retains the owner until halted state restoration succeeds", async () => {
  const fixture = await createFixture();
  try {
    fixture.adapter.targetState = "halted";
    fixture.adapter.failReadyAndExitStateAfter = "running";
    fixture.adapter.failRestore = true;
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.error?.code, "HSS_TARGET_STATE_RESTORE_FAILED");
    const captureId = String((started.data as { captureId: string }).captureId);
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial)?.details?.captureId, captureId);
    const pending = JSON.parse(readFileSync(join(fixture.root, "state", "hss-sessions", `${captureId}.json`), "utf8")) as {
      statePreservationPending?: boolean;
    };
    assert.equal(pending.statePreservationPending, true);

    fixture.adapter.failRestore = false;
    const status = await fixture.hss.status({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(status.ok, true, JSON.stringify(status.error));
    assert.equal(fixture.adapter.targetState, "halted");
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial), undefined);
    assert.equal((status.data as { session: { statePreservationPending?: boolean } }).session.statePreservationPending, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS constructor resumes terminal target-state settlement after a process restart", async () => {
  const fixture = await createFixture();
  try {
    fixture.adapter.targetState = "halted";
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const captureId = String((started.data as { captureId: string }).captureId);
    const stopped = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
    const sessionFile = join(fixture.root, "state", "hss-sessions", `${captureId}.json`);
    const terminal = JSON.parse(readFileSync(sessionFile, "utf8")) as Record<string, unknown>;
    writeFileSync(sessionFile, JSON.stringify({ ...terminal, statePreservationPending: true }));

    new HssOperations(
      fixture.store,
      fixture.queue,
      fixture.artifacts,
      fixture.adapter,
      join(fixture.root, "output"),
      join(fixture.root, "state"),
      join(fixture.root, "session-work"),
    );
    await waitFor(() => {
      const recovered = JSON.parse(readFileSync(sessionFile, "utf8")) as { statePreservationPending?: boolean };
      return recovered.statePreservationPending === false;
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS terminal settlement restores the authorized halted state after an already-exited helper", async () => {
  const fixture = await createFixture();
  try {
    fixture.adapter.targetState = "halted";
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true, JSON.stringify(started.error));
    fixture.adapter.targetState = "running";
    fixture.adapter.crashLatest();

    const stopped = await fixture.hss.stop({
      projectRoot: fixture.projectRoot,
      captureId: String((started.data as { captureId: string }).captureId),
    });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
    assert.equal(fixture.adapter.targetState, "halted");
    assert.equal(fixture.adapter.restoreCount, 1);
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial), undefined);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS never resumes an initially running target to repair a state mismatch", async () => {
  const fixture = await createFixture();
  try {
    fixture.adapter.targetState = "running";
    fixture.adapter.capabilityStateAfter = "halted";
    const dryRun = await fixture.hss.start({ ...captureInput(fixture, 1, 100, 1), dryRun: true });
    assert.equal(dryRun.error?.code, "HSS_TARGET_STATE_CHANGED");
    assert.equal(fixture.adapter.restoreCount, 0);
    assert.equal(fixture.adapter.targetState, "halted");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS surfaces native running-state restoration evidence after capability failure", async () => {
  const fixture = await createFixture();
  try {
    fixture.adapter.targetState = "running";
    fixture.adapter.capabilityFailure = {
      code: "HSS_TARGET_STATE_CHANGED",
      reason: "capability attach halted the target before restoration",
      observed: {
        initialTargetStateRaw: 0,
        observedTargetStateRaw: 1,
        finalTargetStateRaw: 0,
        restorationAttempted: true,
        resumeIssued: true,
        restored: true,
        stateUnknown: false,
      },
    };

    const dryRun = await fixture.hss.start({ ...captureInput(fixture, 1, 100, 1), dryRun: true });
    const helperEvidence = (dryRun.data as { helperEvidence?: Record<string, unknown> })?.helperEvidence;
    assert.equal(dryRun.error?.code, "HSS_TARGET_STATE_CHANGED");
    assert.equal(dryRun.error?.stateUnknown, false);
    assert.equal(helperEvidence?.resumeIssued, true);
    assert.equal(helperEvidence?.restored, true);
    assert.equal(helperEvidence?.finalTargetStateRaw, 0);
    assert.equal(fixture.adapter.targetState, "running");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS planning warns about a high estimated load without rejecting or changing the requested rate", async () => {
  const fixture = await createFixture("uint32", false, 1_000);
  try {
    const planned = await fixture.hss.plan(captureInput(fixture, 10, 1_000, 10));
    assert.equal(planned.ok, true, JSON.stringify(planned.error));
    assert.equal((planned.data as { rateHz: number }).rateHz, 1_000);
    assert.equal((planned.data as { configuredSpeedKHz: number }).configuredSpeedKHz, 1_000);
    assert.equal((planned.data as { linkRate: { warning: boolean } }).linkRate.warning, true);
    assert.equal(planned.warnings.some((warning) => warning.startsWith("LINK_SPEED_MAY_LIMIT_RATE")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS writeVariables permit immutable capture-owner writes without consuming sample slots", async () => {
  const fixture = await createFixture();
  try {
    const started = await fixture.hss.start({
      ...captureInput(fixture, 1, 100, 1),
      writeVariables: [fixture.ref(2)],
    });
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const captureId = String((started.data as { captureId: string }).captureId);
    const packageDir = String((started.data as { packageDir: string }).packageDir);
    const metadata = JSON.parse(readFileSync(join(packageDir, "capture.json"), "utf8")) as {
      variables: Array<{ logicalIdentity: string }>;
    };
    assert.deepEqual(metadata.variables.map(({ logicalIdentity }) => logicalIdentity), ["var0"]);
    assert.equal(fixture.adapter.lastPlan?.planFormatVersion, 3);
    assert.equal(fixture.adapter.lastPlan?.initialTargetState, "running");
    assert.equal(fixture.adapter.lastPlan?.expectedTargetState, "running");
    assert.equal(fixture.adapter.lastPlan?.resumeBeforeStart, false);
    assert.deepEqual(fixture.adapter.lastPlan?.symbols.map(({ name }) => name), ["var0"]);
    assert.deepEqual(fixture.adapter.lastPlan?.writeSymbols.map(({ name }) => name), ["var2"]);

    const readWriteOnly = await fixture.variables.readVariable(fixture.projectRoot, fixture.ref(2));
    assert.equal(readWriteOnly.ok, true, JSON.stringify(readWriteOnly.error));
    assert.equal((readWriteOnly.data as { typedValue: number }).typedValue, 0);

    const writeOnly = await fixture.variables.writeVariable({
      projectRoot: fixture.projectRoot,
      ref: fixture.ref(2),
      value: 1,
      captureOld: true,
      verify: true,
      restore: true,
    });
    assert.equal(writeOnly.ok, true, JSON.stringify(writeOnly.error));
    assert.equal((writeOnly.data as { verificationConnection: string }).verificationConnection, "capture_owner");
    assert.equal(fixture.adapter.valueAt(0x20000008), 0);

    const undeclared = await fixture.variables.writeVariable({
      projectRoot: fixture.projectRoot,
      ref: fixture.ref(3),
      value: 1,
    });
    assert.equal(undeclared.error?.code, "VARIABLE_NOT_IN_CAPTURE");

    const stopped = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    const raw = readJcapV1Raw(packageDir);
    assert.equal(raw.events.filter((event) => event.type === "variable_write").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS writeVariables enforce the direct runtime bound before symbol resolution", async () => {
  const fixture = await createFixture();
  try {
    const planned = await fixture.hss.plan({
      ...captureInput(fixture, 1, 100, 1),
      writeVariables: Array.from({ length: 33 }, () => fixture.ref(2)),
    });
    assert.equal(planned.ok, false);
    assert.equal(planned.error?.code, "HSS_WRITE_VARIABLE_BOUNDS");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS quality reports no-source captures as partial and indexes target-counter gaps", async () => {
  const fixture = await createFixture();
  try {
    const withoutOracle = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(withoutOracle.ok, true, JSON.stringify(withoutOracle.error));
    const noSourceId = String((withoutOracle.data as { captureId: string }).captureId);
    const noSourceStop = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId: noSourceId });
    assert.equal(noSourceStop.ok, true, JSON.stringify(noSourceStop));
    const noSourceMetadata = readJcapV1Raw(String((withoutOracle.data as { packageDir: string }).packageDir)).metadata;
    assert.equal(noSourceMetadata.qualityStatus, "partial");
    assert.equal(noSourceMetadata.qualitySource, "jlink");
    assert.deepEqual(noSourceMetadata.quality, { missingSamples: 44, droppedSamples: 0, overflows: 0, readErrors: 0, timeouts: 0 });

    fixture.adapter.counterGapAt = 5;
    fixture.adapter.counterGapFrames = 2;
    const withOracle = await fixture.hss.start({
      ...captureInput(fixture, 1, 100, 1),
      qualityOracle: { ref: fixture.ref(0), expectedIncrement: 1, tolerance: 0 },
    });
    assert.equal(withOracle.ok, true, JSON.stringify(withOracle.error));
    const captureId = String((withOracle.data as { captureId: string }).captureId);
    const packageDir = String((withOracle.data as { packageDir: string }).packageDir);
    const stopped = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
    const raw = readJcapV1Raw(packageDir);
    assert.equal(raw.metadata.qualityStatus, "reported");
    assert.equal(raw.metadata.qualitySource, "target_counter");
    assert.equal(raw.metadata.quality.missingSamples, 2);
    assert.equal(raw.metadata.quality.droppedSamples, null);
    assert.equal(raw.metadata.quality.overflows, null);
    const quality = raw.events.find((event) => event.type === "quality")!;
    assert.deepEqual(quality.inferredDroppedBeforeSampleIndexes, [5]);
    assert.deepEqual((quality.qualityEvidence as { configuration: Record<string, unknown> }).configuration, {
      logicalIdentity: "var0", expectedIncrement: 1, tolerance: 0, modulus: 4_294_967_296,
    });
    const series = await fixture.captures.series({ captureId, variables: ["var0"], startTick: "0", endTick: "120000000", bucketCount: 12 });
    assert.equal(series.ok, true, JSON.stringify(series.error));
    assert.equal((series.data as { series: Array<{ statusFlags: number }> }).series
      .some((bucket) => (bucket.statusFlags & HSS_STATUS_FLAGS.dropped_before_this_sample) !== 0), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS quality strips sensitive Helper provenance before publishing the quality event", async () => {
  const fixture = await createFixture();
  try {
    fixture.adapter.resultQualityEvidence = {
      dll: "sensitive-dll",
      jlinkScriptFile: "sensitive-script",
      jlinkScriptExecOutput: "sensitive-output",
      helperVersion: "fixture-helper",
    };
    const started = await fixture.hss.start(captureInput(fixture, 1, 100, 1));
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const captureId = String((started.data as { captureId: string }).captureId);
    const packageDir = String((started.data as { packageDir: string }).packageDir);
    const stopped = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId });
    assert.equal(stopped.ok, true, JSON.stringify(stopped.error));

    const raw = readJcapV1Raw(packageDir);
    const quality = raw.events.find((event) => event.type === "quality")!;
    const provenance = quality.qualityEvidence as Record<string, unknown>;
    assert.equal(provenance.dll, undefined);
    assert.equal(provenance.jlinkScriptFile, undefined);
    assert.equal(provenance.jlinkScriptExecOutput, undefined);
    assert.equal(provenance.helperVersion, "fixture-helper");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HSS quality oracle rejects counter modulo and reset ambiguity without losing ordinary bounded evidence", async () => {
  const fixture = await createFixture("uint8");
  try {
    const normal = await fixture.hss.start({
      ...captureInput(fixture, 1, 100, 1),
      qualityOracle: { ref: fixture.ref(0), expectedIncrement: 1, tolerance: 0 },
    });
    assert.equal(normal.ok, true, JSON.stringify(normal.error));
    const normalId = String((normal.data as { captureId: string }).captureId);
    const normalStop = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId: normalId });
    assert.equal(normalStop.ok, true, JSON.stringify(normalStop.error));
    const normalMetadata = readJcapV1Raw(String((normal.data as { packageDir: string }).packageDir)).metadata;
    assert.equal(normalMetadata.qualityStatus, "reported", "sample timing rules out a 256-frame alias for adjacent 100 Hz samples");

    fixture.adapter.initialSampleTickStep = 257_000_000n;
    const alias = await fixture.hss.start({
      ...captureInput(fixture, 1, 1_000, 1),
      qualityOracle: { ref: fixture.ref(0), expectedIncrement: 1, tolerance: 0 },
    });
    assert.equal(alias.ok, true, JSON.stringify(alias.error));
    const aliasId = String((alias.data as { captureId: string }).captureId);
    const aliasStop = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId: aliasId });
    assert.equal(aliasStop.ok, true, JSON.stringify(aliasStop.error));
    const aliasRaw = readJcapV1Raw(String((alias.data as { packageDir: string }).packageDir));
    assert.equal(aliasRaw.metadata.qualityStatus, "partial");
    const aliasQuality = aliasRaw.events.find((event) => event.type === "quality")!;
    assert.equal((aliasQuality.qualityEvidence as { diagnostics: string[] }).diagnostics.includes("counter_modulo_alias_ambiguous"), true);

    fixture.adapter.initialSampleTickStep = 10_000_000n;
    fixture.adapter.counterStart = 250;
    fixture.adapter.counterIncrement = 7;
    fixture.adapter.counterModulus = 256;
    const wrapped = await fixture.hss.start({
      ...captureInput(fixture, 1, 100, 1),
      qualityOracle: { ref: fixture.ref(0), expectedIncrement: 7, tolerance: 0 },
    });
    assert.equal(wrapped.ok, true, JSON.stringify(wrapped.error));
    const wrappedId = String((wrapped.data as { captureId: string }).captureId);
    const wrappedStop = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId: wrappedId });
    assert.equal(wrappedStop.ok, true, JSON.stringify(wrappedStop.error));
    const wrappedRaw = readJcapV1Raw(String((wrapped.data as { packageDir: string }).packageDir));
    assert.equal(wrappedRaw.metadata.qualityStatus, "partial");
    assert.equal(wrappedRaw.metadata.qualitySource, "target_counter");
    assert.deepEqual(wrappedRaw.metadata.quality, { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null });
    const quality = wrappedRaw.events.find((event) => event.type === "quality")!;
    assert.equal((quality.qualityEvidence as { diagnostics: string[] }).diagnostics.includes("counter_wrap_or_reset_ambiguous"), true);

    fixture.adapter.counterStart = 0;
    fixture.adapter.counterIncrement = 15;
    fixture.adapter.counterModulus = undefined;
    const tolerance = await fixture.hss.start({
      ...captureInput(fixture, 1, 100, 1),
      qualityOracle: { ref: fixture.ref(0), expectedIncrement: 10, tolerance: 5 },
    });
    assert.equal(tolerance.ok, true, JSON.stringify(tolerance.error));
    const toleranceId = String((tolerance.data as { captureId: string }).captureId);
    const toleranceStop = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId: toleranceId });
    assert.equal(toleranceStop.ok, true, JSON.stringify(toleranceStop.error));
    const toleranceRaw = readJcapV1Raw(String((tolerance.data as { packageDir: string }).packageDir));
    assert.equal(toleranceRaw.metadata.qualityStatus, "partial");
    const toleranceQuality = toleranceRaw.events.find((event) => event.type === "quality")!;
    assert.equal((toleranceQuality.qualityEvidence as { diagnostics: string[] }).diagnostics.includes("counter_delta_ambiguous"), true);

    fixture.adapter.initialSampleTickStep = 260_000_000n;
    fixture.adapter.counterIncrement = 9;
    fixture.adapter.counterModulus = 256;
    const wrappedTolerance = await fixture.hss.start({
      ...captureInput(fixture, 1, 100, 1),
      qualityOracle: { ref: fixture.ref(0), expectedIncrement: 10, tolerance: 5 },
    });
    assert.equal(wrappedTolerance.ok, true, JSON.stringify(wrappedTolerance.error));
    const wrappedToleranceId = String((wrappedTolerance.data as { captureId: string }).captureId);
    const wrappedToleranceStop = await fixture.hss.stop({ projectRoot: fixture.projectRoot, captureId: wrappedToleranceId });
    assert.equal(wrappedToleranceStop.ok, true, JSON.stringify(wrappedToleranceStop.error));
    const wrappedToleranceRaw = readJcapV1Raw(String((wrappedTolerance.data as { packageDir: string }).packageDir));
    assert.equal(wrappedToleranceRaw.metadata.qualityStatus, "partial");
    const wrappedToleranceQuality = wrappedToleranceRaw.events.find((event) => event.type === "quality")!;
    assert.equal((wrappedToleranceQuality.qualityEvidence as { diagnostics: string[] }).diagnostics.includes("counter_modulo_alias_ambiguous"), true);
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
    const written = await fixture.variables.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 12 });
    assert.equal(written.error?.code, "CAPTURE_EVENT_PERSIST_FAILED");
    assert.equal(written.observedEffects.includes("target_memory_written"), true);
    assert.equal(written.observedEffects.includes("capture_event_appended"), false);
    rmSync(eventsFile, { recursive: true, force: true });
    writeFileSync(eventsFile, eventsBefore, { flag: "wx" });

    const reconciled = await fixture.variables.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
    assert.equal(reconciled.error?.code, "HSS_MEMORY_LATE_RESPONSE_RECONCILED");
    assert.equal(fixture.adapter.writeCount, 1);
    const recoveryEvent = readJcapV1Raw(packageDir).events.find((event) => event.type === "variable_write");
    assert.equal((recoveryEvent?.requested as { value: number }).value, 12);
    assert.deepEqual(recoveryEvent?.recoveredTransaction, { source: "durable_hss_memory_receipt", phase: "write" });

    const retried = await fixture.variables.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
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
    const written = await fixture.variables.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 12 });
    assert.equal(written.ok, true, JSON.stringify(written.error));
    assert.equal(written.warnings.some((warning) => warning.includes("receipt cleanup is pending")), true);
    assert.equal(readJcapV1Raw(packageDir).events.filter((event) => event.type === "variable_write").length, 1);

    const reconciled = await fixture.variables.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
    assert.equal(reconciled.error?.code, "HSS_MEMORY_LATE_RESPONSE_RECONCILED");
    assert.equal(fixture.adapter.writeCount, 1);
    assert.equal(readJcapV1Raw(packageDir).events.filter((event) => event.type === "variable_write").length, 1);

    const retried = await fixture.variables.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
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
    assert.equal(started.ok, true, JSON.stringify(started.error));
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
    const written = await fixture.variables.writeVariable({
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
    const written = await fixture.variables.writeVariable({ projectRoot: fixture.projectRoot, ref: fixture.ref(0), value: 13 });
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
    assert.equal((settled.capture as { state: string }).state, "interrupted", JSON.stringify(settled.error));
    assert.equal(fixture.queue.getOwner(fixture.target.probeSerial), undefined);
  } finally {
    fixture.adapter.crashLatest();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(counterType: "uint8" | "uint32" = "uint32", withMemorySessions = false, speed = 4_000): Promise<Fixture> {
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
    speed,
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
  const resolver = new FixtureResolver(counterType);
  const artifacts = new ArtifactVariableService(store, resolver);
  const adapter = new FakeHssAdapter();
  const memoryLauncher = withMemorySessions ? new FixtureMemorySessionLauncher() : undefined;
  const memorySessions = memoryLauncher ? new MemorySessionManager(queue, memoryLauncher, 10_000) : undefined;
  const hss = new HssOperations(store, queue, artifacts, adapter, outputRoot, stateRoot, join(root, "session-work"), memorySessions);
  const captures = new CaptureQueryOperations(outputRoot);
  const variables = new VariableAccessRouter(store, artifacts, direct, hss);
  return {
    root,
    projectRoot,
    store,
    queue,
    artifacts,
    variables,
    hss,
    captures,
    adapter,
    memorySessions,
    memoryLauncher,
    resolver,
    target: current,
    ref(index: number) { return { artifactGeneration: current.artifact!.generation, qualifiedName: `var${index}`, layoutHash: layoutHash(index) }; },
  };
}

function captureInput(fixture: Fixture, count: number, rateHz: number, durationSec: number, runId?: string): HssCaptureInput {
  return { projectRoot: fixture.projectRoot, rateHz, durationSec, variables: Array.from({ length: count }, (_, index) => ({ ref: fixture.ref(index) })), ...(runId ? { runId } : {}) };
}

class FixtureMemorySessionLauncher implements MemorySessionLauncher {
  readonly sessions: FixtureMemorySession[] = [];

  async open(_target: StoredTarget, onStarted?: (pid: number, runtime: MemorySessionRuntimeFacts) => void): Promise<PersistentMemorySession> {
    const session = new FixtureMemorySession(70_000 + this.sessions.length);
    this.sessions.push(session);
    onStarted?.(session.pid, session.runtime);
    return session;
  }
}

class FixtureMemorySession implements PersistentMemorySession {
  readonly runtime: MemorySessionRuntimeFacts = {
    helperPath: "helper.exe",
    runtimePath: "JLink_x64.dll",
    helperSha256: "a".repeat(64),
    runtimeSha256: "b".repeat(64),
  };
  readonly probe = {
    observeTargetState: async () => ({
      state: "halted" as const,
      source: "dhcsr" as const,
      result: { success: true, rawOutput: "", output: "halted" },
    }),
  } as ProbeBackend;
  closeCalls = 0;
  private alive = true;
  private readonly listeners = new Set<() => void>();

  constructor(readonly pid: number) {}

  isAlive(): boolean { return this.alive; }
  isReusable(): boolean { return this.alive; }
  onExit(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.alive = false;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fixture condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

class FixtureResolver implements TypedSymbolResolver {
  readonly overrides = new Map<number, Partial<ResolvedSymbol>>();

  constructor(private readonly counterType: "uint8" | "uint32") {}

  async resolve(target: StoredTarget, selector: string): Promise<ResolvedSymbol> {
    const match = /^var(\d+)$/.exec(selector);
    if (!match || !target.artifact) throw new Error(`unknown fixture symbol: ${selector}`);
    const index = Number(match[1]);
    const type = index === 0 ? this.counterType : "uint32";
    const size = type === "uint8" ? 1 : 4;
    const address = 0x20000000 + index * 4;
    return {
      ref: { artifactGeneration: target.artifact.generation, qualifiedName: selector, layoutHash: layoutHash(index) },
      rootAddress: address,
      rootSize: size,
      memberOffset: 0,
      address,
      type,
      size,
      region: "ram",
      hssEligible: true,
      source: "elf-dwarf",
      confidence: "dwarf",
      endian: "little",
      ...this.overrides.get(index),
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
  private readonly captureForControl = new Map<string, { packageDir: string; symbols: string[]; declared: Array<{ address: number; size: number }>; nextSampleIndex: number; lastTick: bigint }>();
  private readonly sampleTimers = new Map<number, NodeJS.Timeout>();
  private readonly memory = new Map<number, Buffer>([[0x20000000, u32(7)]]);
  private readonly memoryTransactions = new Map<string, HssMemoryTransaction[]>();
  private nextRequestId = 1;
  writeCount = 0;
  launchCount = 0;
  lastPlan?: {
    planFormatVersion: number;
    initialTargetState: "running" | "halted";
    expectedTargetState: "running";
    resumeBeforeStart: boolean;
    symbols: Array<{ name: string; address: string; size: number; type: string }>;
    writeSymbols: Array<{ name: string; address: string; size: number; type: string }>;
  };
  inspectCount = 0;
  maxFreq = 1_000;
  failNextWriteBeforeIssue = false;
  failNextWriteBeforeDispatch = false;
  failNextRestoreBeforeDispatch = false;
  failNextMemoryAcknowledge = false;
  failMemoryReceiptInspection = false;
  failReadyWithReusedPid = false;
  failReadyAndExitStateAfter?: HssTargetState;
  terminateCount = 0;
  targetState: HssTargetState = "running";
  capabilityStateAfter?: HssTargetState;
  capabilityFailure?: { code: string; reason: string; observed: Record<string, unknown> };
  stopStateAfter?: HssTargetState;
  restoreCount = 0;
  resumeCount = 0;
  failRestore = false;
  counterGapAt?: number;
  counterGapFrames = 0;
  counterStart = 0;
  counterIncrement = 1;
  counterModulus?: number;
  initialSampleTickStep = 10_000_000n;
  resultQualityEvidence?: Record<string, unknown>;
  private ignoreNextStopRequest = false;

  async inspectRuntime(): Promise<HssRuntimeFacts> {
    this.inspectCount += 1;
    return { backend: this.backend, available: true, helperPath: "fake-helper", runtimePath: "fake-runtime", helperSha256: "2".repeat(64), runtimeSha256: "1".repeat(64), helperVersion: "1", helperProtocolVersion: 3, architecture: process.arch, abi: { fake: true } };
  }

  async capability(_target: StoredTarget, runtime?: HssRuntimeFacts): Promise<HssCapabilityFacts> {
    if (this.capabilityStateAfter) this.targetState = this.capabilityStateAfter;
    if (this.capabilityFailure) {
      return {
        ...(runtime ?? await this.inspectRuntime()),
        available: false,
        effective: HSS_EFFECTIVE_LIMITS,
        errorCode: this.capabilityFailure.code,
        reason: this.capabilityFailure.reason,
        observed: structuredClone(this.capabilityFailure.observed),
      };
    }
    return { ...(runtime ?? await this.inspectRuntime()), available: true, hardware: { maxBlocks: 10, maxFreq: this.maxFreq, flags: 0, raw: [10, this.maxFreq, 0] }, effective: HSS_EFFECTIVE_LIMITS, observed: { fake: true } };
  }

  async observeTargetState(): Promise<HssTargetState> { return this.targetState; }

  async restoreHaltedState(): Promise<"halted"> {
    this.restoreCount += 1;
    if (this.failRestore) throw new Error("fixture halted-state restoration failed");
    this.targetState = "halted";
    return "halted";
  }

  async qpcTimebase(): Promise<HssTimebase> {
    this.qpcEpochMs = Date.now();
    return { qpcCounter: this.qpc.toString(), qpcFrequency: "1000000" };
  }

  async launchCapture(_runtime: HssRuntimeFacts, control: HssCaptureControlFiles): Promise<HssCaptureLaunch> {
    this.launchCount += 1;
    const plan = JSON.parse(readFileSync(control.planPath, "utf8")) as {
      planFormatVersion: number;
      captureId: string;
      helperInstanceNonce: string;
      outputFile: string;
      initialTargetState: "running" | "halted";
      expectedTargetState: "running";
      resumeBeforeStart: boolean;
      symbols: Array<{ name: string; address: string; size: number; type: string }>;
      writeSymbols: Array<{ name: string; address: string; size: number; type: string }>;
    };
    if (plan.planFormatVersion !== 3 || plan.expectedTargetState !== "running"
      || plan.resumeBeforeStart !== (plan.initialTargetState === "halted")
      || this.targetState !== plan.initialTargetState
      || !Array.isArray(plan.symbols) || !Array.isArray(plan.writeSymbols)) {
      throw new Error("fake Helper plan contract mismatch");
    }
    if (plan.resumeBeforeStart) {
      this.resumeCount += 1;
      this.targetState = "running";
    }
    this.lastPlan = structuredClone(plan);
    const packageDir = join(plan.outputFile, "..", "..");
    for (let sampleIndex = 0; sampleIndex < 12; sampleIndex += 1) {
      appendJcapV1Sample(packageDir, {
        sampleIndex,
        tick: (BigInt(sampleIndex) * this.initialSampleTickStep).toString(),
        statusFlags: 1,
        values: this.sampleValues(plan.symbols, sampleIndex),
      });
    }
    const pid = this.nextPid++;
    writeFileSync(control.pidFile, JSON.stringify({ captureId: plan.captureId, helperNonce: plan.helperInstanceNonce, pid }), { encoding: "utf8", flag: "wx" });
    writeFileSync(control.readyFile, JSON.stringify({
      status: "ready",
      captureId: plan.captureId,
      helperNonce: plan.helperInstanceNonce,
      pid,
      qpcCounter: this.qpc.toString(),
      heartbeatSequence: 0,
      initialTargetState: plan.initialTargetState,
      expectedTargetState: plan.expectedTargetState,
      resumeIssued: plan.resumeBeforeStart,
      targetState: plan.expectedTargetState,
    }), { encoding: "utf8", flag: "wx" });
    this.alive.add(pid);
    this.pidForControl.set(control.planPath, pid);
    this.records.set(control.planPath, []);
    this.captureForControl.set(control.planPath, {
      packageDir,
      symbols: plan.symbols.map((symbol) => symbol.name),
      declared: [...plan.symbols, ...plan.writeSymbols].map((symbol) => ({
        address: Number.parseInt(symbol.address, 16),
        size: symbol.size,
      })),
      nextSampleIndex: 12,
      lastTick: 11n * this.initialSampleTickStep,
    });
    const timer = setInterval(() => {
      if (!this.alive.has(pid)) { clearInterval(timer); return; }
      try { this.appendCaptureSample(control, 10_000_000n); }
      catch { clearInterval(timer); }
    }, 10);
    timer.unref();
    this.sampleTimers.set(pid, timer);
    return {
      pid,
      launchedAt: new Date().toISOString(),
      captureId: plan.captureId,
      helperNonce: plan.helperInstanceNonce,
      initialTargetState: plan.initialTargetState,
      expectedTargetState: plan.expectedTargetState,
      resumeBeforeStart: plan.resumeBeforeStart,
    };
  }

  async waitUntilReady(control: HssCaptureControlFiles, launch: HssCaptureLaunch): Promise<void> {
    const ready = JSON.parse(readFileSync(control.readyFile, "utf8")) as { status?: string; captureId?: string; helperNonce?: string; pid?: number };
    if (this.failReadyAndExitStateAfter) {
      this.targetState = this.failReadyAndExitStateAfter;
      this.failReadyAndExitStateAfter = undefined;
      this.alive.delete(launch.pid);
      this.stopSampling(launch.pid);
      throw new HssAdapterError("HSS_HELPER_EXITED_BEFORE_READY", "fixture helper exited before readiness", false, true);
    }
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
    const declared = this.captureForControl.get(control.planPath)?.declared ?? [];
    if (!declared.some((descriptor) => descriptor.address === address && descriptor.size === length)) {
      return { requestId, status: "error", errorCode: "VARIABLE_NOT_IN_CAPTURE", reason: "memory request does not exactly match an immutable capture-session descriptor", writeIssued: false };
    }
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
    if (this.stopStateAfter) this.targetState = this.stopStateAfter;
    this.stopSampling(pid);
    this.records.set(control.planPath, [{
      record: "result",
      status: "stopped",
      configuredInterface: "SWD",
      configuredSpeedKHz: 4_000,
      requestedRateHz: 100,
      actualRateHz: 56,
      sampleCount: 56,
      requestedSamples: 100,
      sampleRatio: 0.56,
      sampleThresholdMet: false,
      readAttempts: 100,
      emptyReads: 44,
      shortReads: 0,
      missingSamples: 44,
      droppedSamples: 0,
      overflows: 0,
      readErrors: 0,
      timeouts: 0,
      rawWriteTimeNsTotal: 56_000,
      rawWriteTimeNsMax: 2_000,
      rawWriteTimeNsAverage: 1_000,
      qualityEvidence: this.resultQualityEvidence,
    }]);
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
      values: this.sampleValues(capture.symbols.map((name) => ({ name })), capture.nextSampleIndex),
    });
    capture.nextSampleIndex += 1;
    capture.lastTick = tick;
  }

  private stopSampling(pid: number): void {
    const timer = this.sampleTimers.get(pid);
    if (timer) clearInterval(timer);
    this.sampleTimers.delete(pid);
  }

  private sampleValues(symbols: Array<{ name: string }>, sampleIndex: number): Record<string, number> {
    const counterOffset = this.counterGapAt !== undefined && sampleIndex >= this.counterGapAt ? this.counterGapFrames : 0;
    const counterRaw = this.counterStart + sampleIndex * this.counterIncrement + counterOffset;
    const counter = this.counterModulus === undefined ? counterRaw : ((counterRaw % this.counterModulus) + this.counterModulus) % this.counterModulus;
    return Object.fromEntries(symbols.map((symbol, index) => [symbol.name, symbol.name === "var0" ? counter : sampleIndex + index]));
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
