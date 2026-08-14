import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNonIntrusiveConnectPreflight,
  HssAdapterError,
  NativeHssHelperAdapter,
  hssTargetStateFromConnectPreflight,
  selectHssAttachDevice,
  type HssCaptureControlFiles,
  type HssMemoryRequest,
} from "./hss-helper-adapter";

const captureId = "51000000-0000-4000-8000-000000000001";
const helperNonce = "52000000-0000-4000-8000-000000000001";
const operationId1 = "54000000-0000-4000-8000-000000000001";
const operationId2 = "54000000-0000-4000-8000-000000000002";

test("HSS helper uses the explicit runtime attach profile without a core allowlist", () => {
  assert.equal(selectHssAttachDevice({ device: "Z20K146M", gdbDevice: "Cortex-M4" }), "Cortex-M4");
  assert.equal(selectHssAttachDevice({ device: "Z20K146M", gdbDevice: " Other " }), "Other");
  for (const gdbDevice of [undefined, "", "   "]) {
    assert.throws(
      () => selectHssAttachDevice({ device: "Z20K146M", gdbDevice }),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_ATTACH_PROFILE_REQUIRED" && !error.stateUnknown,
    );
  }
});

test("HSS connect preflight accepts only explicit halted-state observations", () => {
  assert.equal(hssTargetStateFromConnectPreflight({ targetWasHaltedRaw: 0 }), "running");
  assert.equal(hssTargetStateFromConnectPreflight({ targetWasHaltedRaw: 1 }), "halted");
  for (const raw of [-2, -1, undefined]) {
    assert.throws(
      () => hssTargetStateFromConnectPreflight({ targetWasHalted: false, targetWasHaltedRaw: raw }),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_TARGET_STATE_UNKNOWN" && error.stateUnknown,
    );
  }
});

test("HSS connect preflight requires a non-intrusive attach policy without inferring reset continuity", () => {
  assert.doesNotThrow(() => assertNonIntrusiveConnectPreflight({
    nonIntrusiveAttach: true,
    debugDeinitSkipped: true,
    targetReset: false,
    targetResetContinuity: "unverified",
    targetWritten: false,
    flashIssued: false,
    resetIssued: false,
    haltIssued: false,
  }));
  for (const observed of [
    { targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false },
    { nonIntrusiveAttach: true, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false },
    { nonIntrusiveAttach: true, debugDeinitSkipped: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false },
    { nonIntrusiveAttach: false, debugDeinitSkipped: true, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false },
    { nonIntrusiveAttach: true, debugDeinitSkipped: true, targetWritten: false, flashIssued: false, resetIssued: true, haltIssued: false },
  ]) {
    assert.throws(
      () => assertNonIntrusiveConnectPreflight(observed),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_CONNECT_PREFLIGHT_SIDE_EFFECT" && error.stateUnknown,
    );
  }
});

test("native adapter rejects an unpinned Helper before executing it", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-identity-"));
  const helperPath = path.join(root, "hss_helper.exe");
  const runtimePath = path.join(root, "JLink_x64.dll");
  try {
    writeFileSync(helperPath, "not-the-pinned-helper");
    writeFileSync(runtimePath, "runtime");
    const adapter = new NativeHssHelperAdapter(helperPath);
    const observed = await adapter.inspectRuntime({
      jlinkPath: { path: path.join(root, "JLink.exe") },
    } as never);
    assert.equal(observed.available, false);
    assert.equal(observed.errorCode, "HSS_HELPER_IDENTITY_MISMATCH");
    assert.equal(observed.helperPath, helperPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native adapter accepts only an exact live Helper ready journal", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-ready-"));
  const control = controlFiles(root);
  const adapter = new NativeHssHelperAdapter();
  try {
    writeFileSync(control.readyFile, JSON.stringify({
      status: "ready",
      captureId,
      helperNonce,
      pid: process.pid,
      qpcCounter: "123",
      heartbeatSequence: 0,
      initialTargetState: "halted",
      expectedTargetState: "running",
      resumeIssued: true,
      targetState: "running",
    }));
    const launch = {
      pid: process.pid,
      launchedAt: new Date().toISOString(),
      captureId,
      helperNonce,
      initialTargetState: "halted" as const,
      expectedTargetState: "running" as const,
      resumeBeforeStart: true,
    };
    await adapter.waitUntilReady(control, launch, 100);
    writeFileSync(control.readyFile, JSON.stringify({ status: "ready", captureId: "53000000-0000-4000-8000-000000000001", helperNonce, pid: process.pid, qpcCounter: "123", heartbeatSequence: 0 }));
    await assert.rejects(
      () => adapter.waitUntilReady(control, launch, 100),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_READY_INVALID",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native adapter binds one terminal startup failure to the launched Helper", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-terminal-"));
  const control = controlFiles(root);
  const adapter = new NativeHssHelperAdapter();
  const pid = 2_000_000_000;
  const launch = {
    pid,
    launchedAt: new Date().toISOString(),
    captureId,
    helperNonce,
    initialTargetState: "halted" as const,
    expectedTargetState: "running" as const,
    resumeBeforeStart: true,
  };
  try {
    writeFileSync(control.pidFile, JSON.stringify({ captureId, helperNonce, pid }));
    writeFileSync(control.stdoutPath, [
      JSON.stringify({ record: "lifecycle", captureId, phase: "hss_start" }),
      JSON.stringify({
        record: "result",
        status: "error",
        errorCode: "HSS_START_FAILED",
        reason: "JLINK_HSS_Start failed",
        captureId,
        hssStartIssued: true,
        targetReset: false,
        targetWritten: false,
        flashIssued: false,
        resetIssued: false,
        haltIssued: false,
        writeIssued: false,
      }),
    ].join("\n"));
    await assert.rejects(
      () => adapter.waitUntilReady(control, launch, 100),
      (error: unknown) => {
        if (!(error instanceof HssAdapterError)) return false;
        const evidence = error.evidence as { terminalResultBound?: boolean; helperDead?: boolean; binding?: { helperNonceMatched?: boolean } } | undefined;
        return error.code === "HSS_START_FAILED"
          && error.stateUnknown
          && !error.currentRequestIssued
          && evidence?.terminalResultBound === true
          && evidence.helperDead === true
          && evidence.binding?.helperNonceMatched === true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native adapter rejects unbound or ambiguous terminal startup failures", async () => {
  const cases = [
    {
      owner: { captureId: "53000000-0000-4000-8000-000000000001", helperNonce, pid: 2_000_000_000 },
      records: [{ record: "result", status: "error", errorCode: "HSS_START_FAILED", reason: "wrong capture", captureId }],
    },
    {
      owner: { captureId, helperNonce, pid: 2_000_000_000 },
      records: [
        { record: "result", status: "error", errorCode: "HSS_START_FAILED", reason: "first", captureId },
        { record: "result", status: "error", errorCode: "HSS_START_FAILED", reason: "second", captureId },
      ],
    },
    {
      owner: { captureId, helperNonce: "53000000-0000-4000-8000-000000000001", pid: 2_000_000_000 },
      records: [{ record: "result", status: "error", errorCode: "HSS_START_FAILED", reason: "wrong nonce", captureId }],
    },
    {
      owner: { captureId, helperNonce, pid: 2_000_000_000 },
      records: [{ record: "result", status: "error", errorCode: "HSS_START_FAILED", reason: "wrong pid", captureId, helperPid: 1234 }],
    },
    {
      owner: { captureId, helperNonce, pid: 2_000_000_000 },
      records: [{ record: "result", status: "ok", captureId }],
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    const root = mkdtempSync(path.join(os.tmpdir(), `hss-adapter-terminal-invalid-${index}-`));
    const control = controlFiles(root);
    const adapter = new NativeHssHelperAdapter();
    const launch = {
      pid: 2_000_000_000,
      launchedAt: new Date().toISOString(),
      captureId,
      helperNonce,
      initialTargetState: "halted" as const,
      expectedTargetState: "running" as const,
      resumeBeforeStart: true,
    };
    try {
      writeFileSync(control.pidFile, JSON.stringify(fixture.owner));
      writeFileSync(control.stdoutPath, fixture.records.map((record) => JSON.stringify(record)).join("\n"));
      await assert.rejects(
        () => adapter.waitUntilReady(control, launch, 100),
        (error: unknown) => error instanceof HssAdapterError
          && error.code === "HSS_HELPER_EXITED_BEFORE_READY"
          && error.stateUnknown
          && error.evidence === undefined,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("native adapter rejects malformed and oversized startup diagnostics", async () => {
  for (const [name, stdout] of [
    ["malformed", "{not-json"],
    ["oversized", "x".repeat(1024 * 1024 + 1)],
  ] as const) {
    const root = mkdtempSync(path.join(os.tmpdir(), `hss-adapter-terminal-${name}-`));
    const control = controlFiles(root);
    const adapter = new NativeHssHelperAdapter();
    const launch = {
      pid: 2_000_000_000,
      launchedAt: new Date().toISOString(),
      captureId,
      helperNonce,
      initialTargetState: "halted" as const,
      expectedTargetState: "running" as const,
      resumeBeforeStart: true,
    };
    try {
      writeFileSync(control.pidFile, JSON.stringify({ captureId, helperNonce, pid: launch.pid }));
      writeFileSync(control.stdoutPath, stdout);
      await assert.rejects(
        () => adapter.waitUntilReady(control, launch, 100),
        (error: unknown) => error instanceof HssAdapterError
          && error.code === "HSS_HELPER_EXITED_BEFORE_READY"
          && error.stateUnknown
          && error.evidence === undefined,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("native adapter rejects a v2 capture plan before spawning the Helper", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-plan-version-"));
  const control = controlFiles(root);
  const adapter = new NativeHssHelperAdapter();
  const helperPath = path.resolve("native", "hss-helper", "prebuilt", "windows-x64", "hss_helper.exe");
  const runtimePath = path.join(root, "JLink_x64.dll");
  try {
    writeFileSync(runtimePath, "runtime");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    writeFileSync(control.planPath, JSON.stringify({
      planFormatVersion: 2,
      captureId,
      helperInstanceNonce: helperNonce,
      initialTargetState: "halted",
      expectedTargetState: "running",
      resumeBeforeStart: true,
    }));
    await assert.rejects(
      () => adapter.launchCapture({
        backend: "jlink-hss",
        available: true,
        helperPath,
        runtimePath,
        helperSha256: createHash("sha256").update(readFileSync(helperPath)).digest("hex"),
        runtimeSha256: digest("runtime"),
        helperProtocolVersion: 3,
      }, control),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_PLAN_INVALID",
    );
    assert.equal(existsSync(control.pidFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture liveness requires the exact identity and an advancing Helper heartbeat before adoption", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-heartbeat-"));
  const control = controlFiles(root);
  const adapter = new NativeHssHelperAdapter();
  try {
    writeFileSync(control.readyFile, JSON.stringify({ status: "ready", captureId, helperNonce, pid: process.pid, qpcCounter: "100", heartbeatSequence: 7 }));
    assert.equal(adapter.isCaptureAlive(control, process.pid, captureId, helperNonce), true);
    assert.equal(adapter.isCaptureAlive(control, process.pid, captureId, "53000000-0000-4000-8000-000000000001"), false);
    const advance = setTimeout(() => {
      writeFileSync(control.readyFile, JSON.stringify({ status: "ready", captureId, helperNonce, pid: process.pid, qpcCounter: "101", heartbeatSequence: 8 }));
    }, 25);
    assert.equal(await adapter.confirmCaptureAlive(control, process.pid, captureId, helperNonce, 250), true);
    clearTimeout(advance);
    assert.equal(await adapter.confirmCaptureAlive(control, process.pid, captureId, helperNonce, 50), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timed-out IPC reconciles a late response without issuing or attributing the next write", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-ipc-"));
  const control = controlFiles(root);
  const adapter = new NativeHssHelperAdapter();
  try {
    const firstResponder = respondOnce(control, 40);
    await assert.rejects(
      () => adapter.requestMemory(control, writeRequest("01000000", 1, operationId1), 10),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_REQUEST_TIMEOUT" && error.currentRequestIssued && error.stateUnknown,
    );
    assert.equal((await firstResponder).bytesHex, "01000000");

    await assert.rejects(
      () => adapter.requestMemory(control, writeRequest("02000000", 2, operationId2), 100),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_LATE_RESPONSE_RECONCILED" && !error.currentRequestIssued && error.stateUnknown,
    );
    assert.equal(existsSync(control.requestFile), false);
    assert.equal(existsSync(control.claimFile), false);
    const recovered = adapter.listMemoryTransactions(control);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].request.eventContext?.kind !== "target_control" ? recovered[0].request.eventContext?.requestedValue : undefined, 1);
    adapter.acknowledgeMemoryTransactions(control, [recovered[0].request.requestId]);

    const secondResponder = respondOnce(control, 0);
    const response = await adapter.requestMemory(control, writeRequest("02000000", 2, operationId2), 500);
    assert.equal(response.status, "ok");
    assert.equal((await secondResponder).bytesHex, "02000000");
    assert.equal(adapter.listMemoryTransactions(control).length, 1);
    adapter.acknowledgeMemoryTransactions(control, [response.requestId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("timed-out resume is durably reconciled before another target-control request", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-resume-ipc-"));
  const control = controlFiles(root);
  const adapter = new NativeHssHelperAdapter();
  try {
    const firstResponder = respondResumeOnce(control, 40);
    await assert.rejects(
      () => adapter.requestMemory(control, resumeRequest("continue", operationId1), 10),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_REQUEST_TIMEOUT" && error.currentRequestIssued && error.stateUnknown,
    );
    assert.equal(await firstResponder, "continue");

    await assert.rejects(
      () => adapter.requestMemory(control, resumeRequest("resume", operationId2), 100),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_LATE_RESPONSE_RECONCILED" && !error.currentRequestIssued && error.stateUnknown,
    );
    assert.equal(existsSync(control.requestFile), false);
    assert.equal(existsSync(control.claimFile), false);
    const recovered = adapter.listMemoryTransactions(control);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].request.op, "resume");
    assert.equal(recovered[0].request.eventContext?.kind, "target_control");
    assert.equal(recovered[0].response.resumeIssued, true);
    adapter.acknowledgeMemoryTransactions(control, [recovered[0].request.requestId]);

    const secondResponder = respondResumeOnce(control, 0);
    const response = await adapter.requestMemory(control, resumeRequest("resume", operationId2), 500);
    assert.equal(response.status, "ok");
    assert.equal(response.afterState, "running");
    assert.equal(await secondResponder, "resume");
    assert.equal(adapter.listMemoryTransactions(control).length, 1);
    adapter.acknowledgeMemoryTransactions(control, [response.requestId]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IPC crash windows remain fail-closed and never publish a replacement request", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-crash-windows-"));
  const control = controlFiles(root);
  const adapter = new NativeHssHelperAdapter();
  const nextRequest = { captureId, op: "read" as const, address: "0x20000000", length: 4, accessSize: 4 as const };
  try {
    const publishedRead = "55000000-0000-4000-8000-000000000001";
    writeFileSync(control.requestFile, JSON.stringify({ formatVersion: 1, requestId: publishedRead, createdAt: new Date().toISOString(), ...nextRequest }));
    await assert.rejects(
      () => adapter.requestMemory(control, nextRequest, 25),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_REQUEST_PENDING" && !error.stateUnknown && !error.currentRequestIssued,
    );
    assert.equal(JSON.parse(readFileSync(control.requestFile, "utf8")).requestId, publishedRead);
    rmSync(control.requestFile);

    writeFileSync(control.requestFile, JSON.stringify({ formatVersion: 1, requestId: "55000000-0000-4000-8000-000000000002", createdAt: new Date().toISOString(), ...writeRequest("01000000", 1, operationId1) }));
    await assert.rejects(
      () => adapter.requestMemory(control, nextRequest, 25),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_REQUEST_PENDING" && error.stateUnknown && !error.currentRequestIssued,
    );
    rmSync(control.requestFile);

    writeFileSync(control.claimFile, JSON.stringify({ formatVersion: 1, requestId: "55000000-0000-4000-8000-000000000003", createdAt: new Date().toISOString(), ...writeRequest("01000000", 1, operationId1) }));
    await assert.rejects(
      () => adapter.requestMemory(control, nextRequest, 25),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_REQUEST_INDETERMINATE" && error.stateUnknown && !error.currentRequestIssued,
    );
    assert.equal(existsSync(control.claimFile), true);
    rmSync(control.claimFile);

    const lateRead = "55000000-0000-4000-8000-000000000004";
    writeFileSync(control.claimFile, JSON.stringify({ formatVersion: 1, requestId: lateRead, createdAt: new Date().toISOString(), ...nextRequest }));
    writeFileSync(control.responseFile, JSON.stringify({ requestId: lateRead, status: "ok", op: "read", bytesHex: "00000000", writeIssued: false }));
    await assert.rejects(
      () => adapter.requestMemory(control, nextRequest, 25),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_LATE_RESPONSE_RECONCILED" && !error.stateUnknown && !error.currentRequestIssued,
    );
    assert.equal(existsSync(control.responseFile), false);
    assert.equal(existsSync(control.requestFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live Helper response journals are rejected above the 1 MiB bound", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-response-bound-"));
  const control = controlFiles(root);
  const adapter = new NativeHssHelperAdapter();
  try {
    const responder = (async () => {
      while (!existsSync(control.requestFile)) await delay(2);
      const request = JSON.parse(readFileSync(control.requestFile, "utf8")) as { requestId: string };
      renameSync(control.requestFile, control.claimFile);
      writeFileSync(control.responseFile, JSON.stringify({ requestId: request.requestId, status: "ok", writeIssued: true, padding: "x".repeat(1024 * 1024) }), { encoding: "utf8", flag: "wx" });
    })();
    await assert.rejects(
      () => adapter.requestMemory(control, writeRequest("01000000", 1, operationId1), 500),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_RESPONSE_INVALID" && error.currentRequestIssued && error.stateUnknown,
    );
    await responder;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("combined durable transaction receipts are rejected above the 1 MiB recovery bound", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hss-adapter-receipt-bound-"));
  const control = controlFiles(root);
  const adapter = new NativeHssHelperAdapter();
  const requestId = "55000000-0000-4000-8000-000000000005";
  try {
    writeFileSync(control.claimFile, JSON.stringify({
      formatVersion: 1,
      requestId,
      createdAt: new Date().toISOString(),
      ...writeRequest("01000000", 1, operationId1),
      padding: "x".repeat(600_000),
    }));
    writeFileSync(control.responseFile, JSON.stringify({ requestId, status: "ok", writeIssued: true, padding: "y".repeat(600_000) }));
    assert.throws(
      () => adapter.listMemoryTransactions(control),
      (error: unknown) => error instanceof HssAdapterError && error.code === "HSS_MEMORY_RECEIPT_LIMIT" && error.stateUnknown,
    );
    assert.equal(existsSync(control.claimFile), true);
    assert.equal(existsSync(control.responseFile), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeRequest(bytesHex: string, requestedValue: number, operationId: string): HssMemoryRequest {
  return {
    captureId,
    op: "write",
    operationId,
    eventContext: { logicalIdentity: "counter", requestedValue, phase: "write", endian: "little" },
    address: "0x20000000",
    length: 4,
    accessSize: 4,
    bytesHex,
  };
}

function resumeRequest(requestedAction: "resume" | "continue", operationId: string): HssMemoryRequest {
  return {
    captureId,
    op: "resume",
    operationId,
    eventContext: { kind: "target_control", requestedAction, canonicalAction: "resume" },
  };
}

function controlFiles(root: string): HssCaptureControlFiles {
  const file = (name: string) => path.join(root, name);
  return {
    planPath: file("capture-plan.json"),
    pidFile: file("helper.owner.json"),
    readyFile: file("helper.ready.json"),
    stdoutPath: file("helper.stdout.ndjson"),
    stderrPath: file("helper.stderr.log"),
    stopFile: file("stop.request"),
    requestFile: file("memory.request.json"),
    claimFile: file("memory.request.claimed.json"),
    responseFile: file("memory.response.json"),
  };
}

async function respondOnce(control: HssCaptureControlFiles, delayMs: number): Promise<{ bytesHex: string }> {
  const deadline = Date.now() + 1_000;
  while (!existsSync(control.requestFile)) {
    if (Date.now() >= deadline) throw new Error("fixture request did not appear");
    await delay(2);
  }
  const request = JSON.parse(readFileSync(control.requestFile, "utf8")) as { requestId: string; bytesHex: string };
  renameSync(control.requestFile, control.claimFile);
  await delay(delayMs);
  writeFileSync(control.responseFile, JSON.stringify({ requestId: request.requestId, status: "ok", writeIssued: true }), { encoding: "utf8", flag: "wx" });
  return { bytesHex: request.bytesHex };
}

async function respondResumeOnce(control: HssCaptureControlFiles, delayMs: number): Promise<"resume" | "continue"> {
  const deadline = Date.now() + 1_000;
  while (!existsSync(control.requestFile)) {
    if (Date.now() >= deadline) throw new Error("fixture request did not appear");
    await delay(2);
  }
  const request = JSON.parse(readFileSync(control.requestFile, "utf8")) as {
    requestId: string;
    eventContext: { requestedAction: "resume" | "continue" };
  };
  renameSync(control.requestFile, control.claimFile);
  await delay(delayMs);
  writeFileSync(control.responseFile, JSON.stringify({
    requestId: request.requestId,
    status: "ok",
    op: "resume",
    beforeState: "halted",
    afterState: "running",
    resumeIssued: true,
    operationBeforeQpcCounter: "10",
    operationAfterQpcCounter: "20",
  }), { encoding: "utf8", flag: "wx" });
  return request.eventContext.requestedAction;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
