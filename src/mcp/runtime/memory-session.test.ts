import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ProbeBackend } from "../../probe/backend";
import { findMemorySessionHelper, isValidMemorySessionReady, MemorySessionError, MemorySessionManager, resetPersistentMemorySession, requireMemorySessionAttachDevice, selectMemorySessionAttachDevice, verifyMemorySessionHelper, type MemorySessionLauncher, type MemorySessionRuntimeFacts, type PersistentMemorySession } from "./memory-session";
import { ProbeQueue } from "./probe-queue";
import { TargetStore, type StoredTarget } from "./target-store";

test("persistent memory session uses the explicit runtime attach profile without changing target identity", () => {
  assert.equal(selectMemorySessionAttachDevice({ device: "Z20K146M", gdbDevice: "Cortex-M4" }), "Cortex-M4");
  assert.equal(selectMemorySessionAttachDevice({ device: "Z20K146M", gdbDevice: undefined }), "Z20K146M");
  assert.equal(selectMemorySessionAttachDevice({ device: "Z20K146M", gdbDevice: "  " }), "Z20K146M");
});

test("persistent memory session accepts readiness only with bound debug-deinit preservation evidence", () => {
  const target = { device: "Z20K146M", gdbDevice: "Cortex-M4", probeSerial: "69401227", interface: "SWD" as const, speed: 1000 };
  const ready: Record<string, unknown> = {
    status: "ready",
    command: "memory-session",
    probeSerial: 69401227,
    device: "Cortex-M4",
    attachDevice: "Cortex-M4",
    interface: "SWD",
    speedKhz: 1000,
    targetState: "running",
    nonIntrusiveAttach: true,
    targetReset: false,
    targetWritten: false,
    haltIssued: false,
    memoryCacheDisabled: true,
    debugDeinitSkipped: true,
  };
  assert.equal(isValidMemorySessionReady(ready, target), true);
  assert.equal(isValidMemorySessionReady({ ...ready, device: "Z20K146M" }, target), false);
  assert.equal(isValidMemorySessionReady({ ...ready, attachDevice: "Z20K146M" }, target), false);
  assert.equal(isValidMemorySessionReady({ ...ready, debugDeinitSkipped: false }, target), false);
  for (const field of ["nonIntrusiveAttach", "targetReset", "targetWritten", "haltIssued"] as const) {
    const unsafe = { ...ready, [field]: field === "nonIntrusiveAttach" ? false : true };
    assert.equal(isValidMemorySessionReady(unsafe, target), false, field);
    const absent = { ...ready };
    delete absent[field];
    assert.equal(isValidMemorySessionReady(absent, target), false, `missing ${field}`);
  }
  const missing = { ...ready };
  delete missing.debugDeinitSkipped;
  assert.equal(isValidMemorySessionReady(missing, target), false);
});

test("persistent memory session ignores a cwd Helper shadow and rejects it before execution", () => {
  const originalCwd = process.cwd();
  const root = mkdtempSync(join(os.tmpdir(), "memory-session-helper-shadow-"));
  const shadow = join(root, "native", "hss-helper", "bin", "hss_helper.exe");
  try {
    mkdirSync(join(root, "native", "hss-helper", "bin"), { recursive: true });
    writeFileSync(shadow, "not-the-pinned-helper");
    process.chdir(root);
    assert.notEqual(findMemorySessionHelper(), shadow);
    assert.throws(
      () => verifyMemorySessionHelper(shadow),
      (error: unknown) => error instanceof MemorySessionError
        && error.code === "MEMORY_SESSION_HELPER_IDENTITY_MISMATCH"
        && !error.stateUnknown
        && !error.dispatched,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("native memory session refuses an implicit exact-device attach before helper launch", async (context) => {
  const { target, queue, manager, launcher } = await fixture(context, 10_000);
  const withoutProfile = { ...target, gdbDevice: undefined };
  assert.throws(
    () => requireMemorySessionAttachDevice(withoutProfile),
    (error: unknown) => error instanceof MemorySessionError
      && error.code === "MEMORY_ATTACH_PROFILE_REQUIRED"
      && !error.stateUnknown
      && !error.dispatched,
  );
  await assert.rejects(
    queue.runExclusive(target.probeSerial, async (metadata) => manager.probeFor(withoutProfile, metadata)),
    (error: unknown) => error instanceof MemorySessionError
      && error.code === "MEMORY_ATTACH_PROFILE_REQUIRED"
      && !error.stateUnknown
      && !error.dispatched,
  );
  assert.equal(launcher.opens, 0);
  assert.equal(queue.getOwner(target.probeSerial), undefined);
});

test("reset resumes in the same persistent session only after a known halted ResetNoHalt mismatch", async () => {
  const operations: string[] = [];
  const result = await resetPersistentMemorySession(async (body) => {
    operations.push(String(body.op));
    if (body.op === "reset") {
      return {
        status: "error",
        errorCode: "JLINK_CONTROL_STATE_MISMATCH",
        api: "JLINKARM_IsHalted",
        targetStateBefore: "running",
        targetStateAfter: "halted",
        writeIssued: true,
        stateUnknown: false,
      };
    }
    return {
      status: "ok",
      api: "JLINKARM_Go",
      targetStateBefore: "halted",
      targetStateAfter: "running",
      writeIssued: true,
      stateUnknown: false,
    };
  });

  assert.equal(result.success, true);
  assert.equal(result.writeIssued, true);
  assert.equal(result.stateUnknown, false);
  assert.deepEqual(operations, ["reset", "resume"]);
  assert.match(result.output, /reset_no_halt_resume_fallback/);
});

test("reset does not resume when the post-reset state is unknown", async () => {
  const operations: string[] = [];
  const result = await resetPersistentMemorySession(async (body) => {
    operations.push(String(body.op));
    return {
      status: "error",
      errorCode: "JLINK_STATE_OBSERVATION_FAILED",
      api: "JLINKARM_IsHalted",
      targetStateAfter: "unknown",
      writeIssued: true,
      stateUnknown: true,
    };
  });

  assert.equal(result.success, false);
  assert.equal(result.stateUnknown, true);
  assert.deepEqual(operations, ["reset"]);
});

test("reset reports a known halted failure when the bounded resume also stays halted", async () => {
  const operations: string[] = [];
  const result = await resetPersistentMemorySession(async (body) => {
    operations.push(String(body.op));
    return body.op === "reset"
      ? {
        status: "error",
        errorCode: "JLINK_CONTROL_STATE_MISMATCH",
        api: "JLINKARM_IsHalted",
        targetStateAfter: "halted",
        writeIssued: true,
        stateUnknown: false,
      }
      : {
        status: "error",
        errorCode: "JLINK_CONTROL_STATE_MISMATCH",
        api: "JLINKARM_IsHalted",
        targetStateAfter: "halted",
        writeIssued: true,
        stateUnknown: false,
      };
  });

  assert.equal(result.success, false);
  assert.equal(result.writeIssued, true);
  assert.equal(result.stateUnknown, false);
  assert.deepEqual(operations, ["reset", "resume"]);
});

test("persistent memory session reuses one native connection and publishes a durable owner", async (context) => {
  const { target, queue, manager, launcher } = await fixture(context, 10_000);
  let first!: ProbeBackend | undefined;
  let second!: ProbeBackend | undefined;
  await queue.runExclusive(target.probeSerial, async (metadata) => {
    first = await manager.probeFor(target, metadata);
    second = await manager.probeFor(target, metadata);
  });

  assert.equal(first, second);
  assert.equal(launcher.opens, 1);
  assert.equal(queue.getOwner(target.probeSerial)?.kind, "memory");
  assert.equal(queue.getOwner(target.probeSerial)?.resourcePid, 7001);

  await queue.runExclusive(target.probeSerial, async () => {
    assert.equal((await manager.closeForTarget(target))?.targetStateBeforeClose, "unknown");
  }, { allowedOwnerKinds: ["memory"], ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation } });
  assert.equal(launcher.sessions[0].closeCalls, 1);
  assert.equal(queue.getOwner(target.probeSerial), undefined);
});

test("memory startup persists the native PID before helper readiness completes", async (context) => {
  const { target, queue } = await fixture(context, 10_000);
  const launcher = new BlockingLauncher(7999);
  const manager = new MemorySessionManager(queue, launcher, 10_000);
  const opening = queue.runExclusive(target.probeSerial, async (metadata) => manager.probeFor(target, metadata));

  await waitUntil(() => queue.getOwner(target.probeSerial)?.resourcePid === 7999);
  assert.deepEqual(queue.getOwner(target.probeSerial)?.details?.runtime, {
    helperSha256: "a".repeat(64),
    runtimeSha256: "b".repeat(64),
  });
  launcher.finishStart();
  await opening;
  assert.equal(queue.getOwner(target.probeSerial)?.resourcePid, 7999);
  assert.equal(queue.getOwner(target.probeSerial)?.details?.startup, undefined);
  assert.equal(queue.getOwner(target.probeSerial)?.details?.phase, "native_memory_session_active");
});

test("owner activation failure releases ownership when helper exit was confirmed", async (context) => {
  const { target, queue } = await fixture(context, 10_000);
  const session = new FakeSession(7997);
  session.closeErrorAfterExit = new MemorySessionError(
    "MEMORY_SESSION_TIMEOUT",
    "close request timed out after helper exit",
    true,
    true,
    false,
    session.pid,
  );
  const manager = new MemorySessionManager(queue, {
    async open(_target, onStarted) {
      onStarted?.(session.pid, session.runtime);
      return session;
    },
  }, 10_000);
  failOwnerActivationUpdate(queue);

  await assert.rejects(
    queue.runExclusive(target.probeSerial, async (metadata) => manager.probeFor(target, metadata)),
    (error: unknown) => error instanceof MemorySessionError
      && error.code === "MEMORY_SESSION_OWNER_UPDATE_FAILED"
      && !error.retainOwner,
  );
  assert.equal(queue.getOwner(target.probeSerial), undefined);
});

test("owner activation failure retains ownership when helper exit is unconfirmed", async (context) => {
  const { target, queue } = await fixture(context, 10_000);
  const session = new FakeSession(7996);
  session.closeError = new MemorySessionError(
    "MEMORY_SESSION_CLOSE_UNCONFIRMED",
    "native memory helper did not exit after close",
    true,
    true,
    true,
    session.pid,
  );
  const manager = new MemorySessionManager(queue, {
    async open(_target, onStarted) {
      onStarted?.(session.pid, session.runtime);
      return session;
    },
  }, 10_000);
  failOwnerActivationUpdate(queue);

  await assert.rejects(
    queue.runExclusive(target.probeSerial, async (metadata) => manager.probeFor(target, metadata)),
    (error: unknown) => error instanceof MemorySessionError
      && error.code === "MEMORY_SESSION_STARTUP_EXIT_UNCONFIRMED"
      && error.retainOwner,
  );
  assert.equal(queue.getOwner(target.probeSerial)?.resourcePid, session.pid);
});

test("an unproven startup failure retains the resource owner fail-closed", async (context) => {
  const { target, queue } = await fixture(context, 10_000);
  const manager = new MemorySessionManager(queue, new UnprovenStartupFailureLauncher(), 10_000);

  await assert.rejects(
    queue.runExclusive(target.probeSerial, async (metadata) => manager.probeFor(target, metadata)),
    (error: unknown) => error instanceof MemorySessionError && error.code === "MEMORY_SESSION_STARTUP_EXIT_UNCONFIRMED",
  );
  assert.equal(queue.getOwner(target.probeSerial)?.kind, "memory");
  assert.equal(queue.getOwner(target.probeSerial)?.resourcePid, 7998);
});

test("persistent memory session idle timeout releases the Probe for a competing owner", async (context) => {
  const { target, queue, manager, launcher } = await fixture(context, 10);
  await queue.runExclusive(target.probeSerial, async (metadata) => {
    await manager.probeFor(target, metadata);
  });

  await waitUntil(() => queue.getOwner(target.probeSerial) === undefined);
  assert.equal(launcher.sessions[0].closeCalls, 1);
  await queue.runExclusive(target.probeSerial, async (metadata) => {
    const owner = queue.claimOwner(target.probeSerial, { kind: "gdb", projectRoot: target.projectRoot, targetGeneration: target.generation }, metadata.leaseToken);
    queue.releaseOwner(target.probeSerial, owner.token);
  });
});

test("an indeterminate memory session remains fail-closed and is never reused", async (context) => {
  const { target, queue, manager, launcher } = await fixture(context, 10_000);
  await queue.runExclusive(target.probeSerial, async (metadata) => {
    await manager.probeFor(target, metadata);
  });
  launcher.sessions[0].reusable = false;
  launcher.sessions[0].closeError = new Error("helper exit unconfirmed");

  await assert.rejects(
    queue.runExclusive(target.probeSerial, async (metadata) => manager.probeFor(target, metadata), {
      allowedOwnerKinds: ["memory"],
      ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation },
    }),
    /helper exit unconfirmed/,
  );
  assert.equal(launcher.opens, 1);
  assert.equal(queue.getOwner(target.probeSerial)?.kind, "memory");
});

test("unusable-session retirement never reports success while a stale memory owner remains", async (context) => {
  const { target, queue, manager } = await fixture(context, 10_000);
  await queue.runExclusive(target.probeSerial, async (metadata) => {
    queue.claimOwner(target.probeSerial, {
      kind: "memory",
      projectRoot: target.projectRoot,
      targetGeneration: target.generation,
      details: { backend: "native_memory_session" },
    }, metadata.leaseToken);
  });

  await assert.rejects(
    manager.retireIfUnusableForTarget(target),
    (error: unknown) => error instanceof MemorySessionError
      && error.code === "MEMORY_SESSION_OWNER_RELEASE_UNCONFIRMED"
      && error.retainOwner,
  );
  assert.equal(queue.getOwner(target.probeSerial)?.kind, "memory");
});

test("a different Target cannot tear down a local persistent memory owner", async (context) => {
  const { target, store, queue, manager, launcher } = await fixture(context, 10_000);
  await queue.runExclusive(target.probeSerial, async (metadata) => {
    await manager.probeFor(target, metadata);
  });
  const otherProject = join(target.projectRoot, "..", "other-project");
  mkdirSync(otherProject, { recursive: true });
  const other = await store.configure({ projectRoot: otherProject, device: "TEST", gdbDevice: "Cortex-M4", probeSerial: "654321", interface: "SWD", speed: 1000 });

  await assert.rejects(
    queue.runExclusive(other.probeSerial, async (metadata) => manager.probeFor(other, metadata)),
    /MEMORY_SESSION_ACTIVE|local persistent memory session/,
  );
  assert.equal(launcher.sessions[0].closeCalls, 0);
  assert.equal(queue.getOwner(target.probeSerial)?.kind, "memory");
});

async function fixture(context: TestContext, idleTimeoutMs: number): Promise<{ target: StoredTarget; store: TargetStore; queue: ProbeQueue; manager: MemorySessionManager; launcher: FakeLauncher }> {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-mcp-memory-session-${context.name.replace(/[^a-z0-9]+/gi, "-")}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const store = new TargetStore(join(root, "state"));
  const target = await store.configure({ projectRoot, device: "TEST", gdbDevice: "Cortex-M4", probeSerial: "123456", interface: "SWD", speed: 1000 });
  const queue = new ProbeQueue(join(root, "queue"));
  const launcher = new FakeLauncher();
  return { target, store, queue, launcher, manager: new MemorySessionManager(queue, launcher, idleTimeoutMs) };
}

class FakeLauncher implements MemorySessionLauncher {
  opens = 0;
  readonly sessions: FakeSession[] = [];

  async open(_target: StoredTarget, onStarted?: (pid: number, runtime: MemorySessionRuntimeFacts) => void): Promise<PersistentMemorySession> {
    const session = new FakeSession(7000 + ++this.opens);
    this.sessions.push(session);
    onStarted?.(session.pid, session.runtime);
    return session;
  }
}

class BlockingLauncher implements MemorySessionLauncher {
  readonly session: FakeSession;
  private releaseStart?: () => void;

  constructor(pid: number) { this.session = new FakeSession(pid); }

  async open(_target: StoredTarget, onStarted?: (pid: number, runtime: MemorySessionRuntimeFacts) => void): Promise<PersistentMemorySession> {
    onStarted?.(this.session.pid, this.session.runtime);
    await new Promise<void>((resolveStart) => { this.releaseStart = resolveStart; });
    return this.session;
  }

  finishStart(): void { this.releaseStart?.(); }
}

class UnprovenStartupFailureLauncher implements MemorySessionLauncher {
  async open(_target: StoredTarget, onStarted?: (pid: number, runtime: MemorySessionRuntimeFacts) => void): Promise<PersistentMemorySession> {
    onStarted?.(7998, startupRuntime());
    throw new Error("fixture cannot prove child exit");
  }
}

class FakeSession implements PersistentMemorySession {
  readonly probe = {} as ProbeBackend;
  readonly runtime: MemorySessionRuntimeFacts = {
    helperPath: "helper.exe",
    runtimePath: "JLink_x64.dll",
    helperSha256: "a".repeat(64),
    runtimeSha256: "b".repeat(64),
  };
  closeCalls = 0;
  reusable = true;
  closeError?: Error;
  closeErrorAfterExit?: Error;
  private alive = true;
  private readonly listeners = new Set<() => void>();

  constructor(readonly pid: number) {}

  isAlive(): boolean { return this.alive; }
  isReusable(): boolean { return this.alive && this.reusable; }
  onExit(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
    this.alive = false;
    for (const listener of this.listeners) listener();
    this.listeners.clear();
    if (this.closeErrorAfterExit) throw this.closeErrorAfterExit;
  }
}

function failOwnerActivationUpdate(queue: ProbeQueue): void {
  const updateOwnerResource = queue.updateOwnerResource.bind(queue);
  let updates = 0;
  queue.updateOwnerResource = (...args: Parameters<ProbeQueue["updateOwnerResource"]>) => {
    updates += 1;
    if (updates === 2) throw new Error("fixture owner activation update failed");
    return updateOwnerResource(...args);
  };
}

function startupRuntime(): MemorySessionRuntimeFacts {
  return {
    helperPath: "helper.exe",
    runtimePath: "JLink_x64.dll",
    helperSha256: "a".repeat(64),
    runtimeSha256: "b".repeat(64),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(predicate(), true, "condition did not become true before timeout");
}
