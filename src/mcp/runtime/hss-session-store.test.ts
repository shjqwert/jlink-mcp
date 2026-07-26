import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HSS_EFFECTIVE_LIMITS } from "./hss-helper-adapter";
import {
  HssSessionStore,
  HssSessionStoreError,
  isActiveHssSessionState,
  isTerminalHssSessionState,
  type HssSessionRecord,
} from "./hss-session-store";

function fixture(overrides: Partial<HssSessionRecord> = {}): HssSessionRecord {
  const captureId = overrides.captureId ?? randomUUID();
  const createdAt = overrides.createdAt ?? "2026-01-01T00:00:00.000Z";
  return {
    formatVersion: 1,
    captureId,
    projectRoot: "D:\\fixture",
    targetGeneration: "target-generation",
    artifactGeneration: "artifact-generation",
    probeSerial: "123456789",
    state: "capturing",
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    packageDir: join("D:\\captures", `${captureId}.jcap`),
    sessionDir: join("D:\\sessions", captureId),
    control: {
      planPath: "plan.json",
      pidFile: "helper.pid",
      readyFile: "ready.json",
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log",
      stopFile: "stop.request",
      requestFile: "memory.request.json",
      claimFile: "memory.claim.json",
      responseFile: "memory.response.json",
    },
    helperPid: 1234,
    helperNonce: randomUUID(),
    ownerToken: randomUUID(),
    qpcEpochCounter: "0",
    qpcFrequency: "10000000",
    rateHz: 100,
    durationSec: 1,
    descriptors: [],
    runtime: { backend: "fake-hss", available: true },
    capability: { backend: "fake-hss", available: true, effective: HSS_EFFECTIVE_LIMITS },
    ...overrides,
  };
}

function createStore(t: test.TestContext): { root: string; store: HssSessionStore } {
  const root = mkdtempSync(join(tmpdir(), "jlink-hss-session-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: new HssSessionStore(root) };
}

test("session store round-trips records and refreshes updatedAt", (t) => {
  const { store } = createStore(t);
  const record = fixture({ updatedAt: "2000-01-01T00:00:00.000Z" });

  store.write(record);
  const stored = store.read(record.captureId);

  assert.equal(stored.captureId, record.captureId);
  assert.equal(stored.projectRoot, record.projectRoot);
  assert.ok(stored.updatedAt > record.updatedAt);
  assert.deepEqual(store.list().map(({ captureId }) => captureId), [record.captureId]);
});

test("session store validates identifiers, size, and record state", (t) => {
  const { root, store } = createStore(t);

  assert.throws(
    () => store.read("not-a-uuid"),
    (error: unknown) => error instanceof HssSessionStoreError && error.code === "CAPTURE_ID_INVALID",
  );

  const invalidState = fixture();
  writeFileSync(
    join(root, "hss-sessions", `${invalidState.captureId}.json`),
    JSON.stringify({ ...invalidState, state: "unknown" }),
    "utf8",
  );
  assert.throws(
    () => store.read(invalidState.captureId),
    (error: unknown) => error instanceof HssSessionStoreError && error.code === "HSS_SESSION_INVALID",
  );

  const oversized = fixture();
  writeFileSync(
    join(root, "hss-sessions", `${oversized.captureId}.json`),
    "x".repeat(4 * 1024 * 1024 + 1),
    "utf8",
  );
  assert.throws(
    () => store.read(oversized.captureId),
    (error: unknown) => error instanceof HssSessionStoreError && error.code === "HSS_SESSION_INVALID",
  );
});

test("session selection prefers newest or active records as requested", (t) => {
  const { store } = createStore(t);
  const olderActive = fixture({ createdAt: "2026-01-01T00:00:00.000Z" });
  const newerTerminal = fixture({
    captureId: randomUUID(),
    state: "completed",
    createdAt: "2026-01-02T00:00:00.000Z",
    endedAt: "2026-01-02T00:00:01.000Z",
  });

  store.write(olderActive);
  store.write(newerTerminal);

  assert.equal(store.select(olderActive.projectRoot).captureId, newerTerminal.captureId);
  assert.equal(store.select(olderActive.projectRoot, undefined, true).captureId, olderActive.captureId);
  assert.equal(store.active(olderActive.projectRoot)?.captureId, olderActive.captureId);
});

test("session store rejects multiple active records for one project", (t) => {
  const { store } = createStore(t);
  store.write(fixture());
  store.write(fixture());

  assert.throws(
    () => store.active("D:\\fixture"),
    (error: unknown) => error instanceof HssSessionStoreError && error.code === "HSS_SESSION_STATE_INVALID",
  );
});

test("capture exclusivity serializes one capture and permits different captures", async (t) => {
  const { store } = createStore(t);
  const firstCaptureId = randomUUID();
  const secondCaptureId = randomUUID();
  let sameCaptureConcurrent = 0;
  let sameCaptureMaximum = 0;

  const sameCaptureOperation = async (): Promise<void> => {
    sameCaptureConcurrent += 1;
    sameCaptureMaximum = Math.max(sameCaptureMaximum, sameCaptureConcurrent);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    sameCaptureConcurrent -= 1;
  };
  await Promise.all([
    store.withExclusiveCapture(firstCaptureId, sameCaptureOperation),
    store.withExclusiveCapture(firstCaptureId, sameCaptureOperation),
  ]);
  assert.equal(sameCaptureMaximum, 1);

  let differentCaptureConcurrent = 0;
  let differentCaptureMaximum = 0;
  const differentCaptureOperation = async (): Promise<void> => {
    differentCaptureConcurrent += 1;
    differentCaptureMaximum = Math.max(differentCaptureMaximum, differentCaptureConcurrent);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    differentCaptureConcurrent -= 1;
  };
  await Promise.all([
    store.withExclusiveCapture(firstCaptureId, differentCaptureOperation),
    store.withExclusiveCapture(secondCaptureId, differentCaptureOperation),
  ]);
  assert.equal(differentCaptureMaximum, 2);
});

test("capture exclusivity rejects invalid identifiers", async (t) => {
  const { store } = createStore(t);
  await assert.rejects(
    store.withExclusiveCapture("..\\outside", async () => undefined),
    (error: unknown) => error instanceof HssSessionStoreError && error.code === "CAPTURE_ID_INVALID",
  );
});

test("directory leases serialize separate stores that share one state root", async (t) => {
  const { root, store: firstStore } = createStore(t);
  const secondStore = new HssSessionStore(root);
  const captureId = randomUUID();
  let concurrent = 0;
  let maximum = 0;
  const operation = async (): Promise<void> => {
    concurrent += 1;
    maximum = Math.max(maximum, concurrent);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    concurrent -= 1;
  };

  await Promise.all([
    firstStore.withExclusiveCapture(captureId, operation),
    secondStore.withExclusiveCapture(captureId, operation),
  ]);

  assert.equal(maximum, 1);
});

test("capture exclusivity releases memory and directory locks after rejection", async (t) => {
  const { root, store } = createStore(t);
  const secondStore = new HssSessionStore(root);
  const captureId = randomUUID();

  await assert.rejects(
    store.withExclusiveCapture(captureId, async () => {
      throw new Error("fixture failure");
    }),
    /fixture failure/,
  );

  const result = await secondStore.withExclusiveCapture(captureId, async () => "reentered");
  assert.equal(result, "reentered");
});

test("session updates remain usable inside an exclusive capture transaction", async (t) => {
  const { store } = createStore(t);
  const record = fixture();
  store.write(record);

  const updated = await store.withExclusiveCapture(record.captureId, async () => store.update(
    record.captureId,
    (current) => ({ ...current, state: "stopping" }),
  ));

  assert.equal(updated.state, "stopping");
  assert.equal(store.read(record.captureId).state, "stopping");
});

test("session state predicates expose lifecycle categories without mutable sets", () => {
  assert.equal(isActiveHssSessionState("capturing"), true);
  assert.equal(isActiveHssSessionState("completed"), false);
  assert.equal(isTerminalHssSessionState("failed"), true);
  assert.equal(isTerminalHssSessionState("starting"), false);
});
