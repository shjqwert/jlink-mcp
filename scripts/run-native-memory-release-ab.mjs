import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { ProbeQueue } from "../out/mcp/runtime/probe-queue.js";

const options = parseArgs(process.argv.slice(2));
const helperPath = resolve(required(options, "helper"));
const dllPath = resolve(required(options, "dll"));
const device = required(options, "device");
const serial = required(options, "serial");
const speed = Number(required(options, "speed"));
const rounds = Number(options.rounds ?? "3");
const releaseMode = options.mode ?? "terminate";

if (!Number.isSafeInteger(speed) || speed < 1) throw new Error("--speed must be a positive integer");
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("--rounds must be an integer from 1 to 10");
if (releaseMode !== "terminate" && releaseMode !== "close") throw new Error("--mode must be terminate or close");

const helperSha256 = sha256(helperPath);
const dllSha256 = sha256(dllPath);
const queue = new ProbeQueue();
const existingOwner = queue.getOwner(serial);
if (existingOwner) throw new Error(`probe ${serial} already has owner ${existingOwner.kind}:${existingOwner.token}`);

const evidence = {
  startedAt: new Date().toISOString(),
  helperPath,
  helperSha256,
  dllPath,
  dllSha256,
  device,
  serial,
  speedKhz: speed,
  releaseMode,
  requestedRounds: rounds,
  completedRounds: 0,
  rounds: [],
  finalReleaseObserved: false,
  ok: false,
};

let active;
try {
  const execution = await queue.runExclusive(serial, async () => {
    active = await openSession();
    evidence.initialReady = active.ready;
    evidence.initialBoundary = await observe(active);

    for (let index = 1; index <= rounds; index += 1) {
      const round = { round: index };
      round.baseline = await resetAndVerify(active);
      round.release = await release(active);
      active = undefined;

      const observer = await openSession();
      active = observer;
      round.observerReady = observer.ready;
      round.postRelease = await observe(observer);
      evidence.rounds.push(round);
      if (!healthy(round.postRelease)) {
        throw new Error(`round ${index} post-release fault gate failed: ${JSON.stringify(round.postRelease)}`);
      }
      evidence.completedRounds = index;
    }

    evidence.finalBaseline = await resetAndVerify(active);
    evidence.finalRelease = await release(active);
    active = undefined;
    const finalObserver = await openSession();
    active = finalObserver;
    evidence.finalPostRelease = await observe(finalObserver);
    if (!healthy(evidence.finalPostRelease)) {
      throw new Error(`final post-release fault gate failed: ${JSON.stringify(evidence.finalPostRelease)}`);
    }
    evidence.finalReleaseObserved = true;
    evidence.cleanupBaseline = await resetAndVerify(finalObserver);
    evidence.cleanupRelease = await release(finalObserver);
    active = undefined;
    evidence.cleanupReleaseObserved = false;
    evidence.postCleanupState = "unobserved";
  });
  evidence.queueSequence = execution.queueSequence;
  evidence.testVerdict = "inconclusive";
  evidence.diagnosticVerdict = "release_transitions_passed";
  evidence.releaseTransitionsVerified = true;
  evidence.stateUnknown = true;
  evidence.ok = false;
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  evidence.stateUnknown = true;
  if (active) {
    try {
      evidence.failureCleanup = await terminate(active);
    } catch (cleanupError) {
      evidence.failureCleanupError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    }
    active = undefined;
  }
} finally {
  evidence.endedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (evidence.ok !== true) process.exitCode = 2;

async function openSession() {
  const child = spawn(helperPath, [
    "memory-session",
    "--dll", dllPath,
    "--device", device,
    "--interface", "SWD",
    "--serial", serial,
    "--speed", String(speed),
  ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const inbox = lineInbox(child);
  await once(child, "spawn", 5_000);
  child.stdin.write('{"op":"activate"}\n');
  const ready = await inbox.next(15_000);
  if (ready.status !== "ready") throw new Error(`helper startup failed: ${JSON.stringify(ready)}`);
  if (String(ready.probeSerial) !== serial || ready.device !== device || ready.attachDevice !== device
      || ready.interface !== "SWD" || ready.speedKhz !== speed || ready.targetState === "unknown"
      || ready.debugDeinitSkipped !== true
      || ready.memoryCacheDisabled !== true || ready.nonIntrusiveAttach !== true) {
    throw new Error(`helper ready identity or policy mismatch: ${JSON.stringify(ready)}`);
  }
  return { child, inbox, ready };
}

async function request(session, operation) {
  const id = randomUUID();
  session.child.stdin.write(`${JSON.stringify({ id, ...operation })}\n`);
  const response = await session.inbox.next(10_000);
  if (response.id !== id) throw new Error(`response id mismatch: ${JSON.stringify(response)}`);
  return response;
}

async function resetAndVerify(session) {
  const reset = await request(session, { op: "reset" });
  if (reset.status !== "ok" || reset.targetStateAfter !== "running" || reset.writeIssued !== true || reset.stateUnknown !== false) {
    throw new Error(`ResetNoHalt failed: ${JSON.stringify(reset)}`);
  }
  const observed = await observe(session);
  if (!healthy(observed)) throw new Error(`post-reset fault gate failed: ${JSON.stringify(observed)}`);
  return { reset, observed };
}

async function observe(session) {
  const stateBefore = await request(session, { op: "state" });
  const startedAt = Date.now();
  const samples = [];
  let threadModeObserved = false;
  let disallowedException;
  const delays = [0, 1, 3, 2, 5, 1, 7, 2];
  for (let index = 0; index < 32; index += 1) {
    const icsr = await readU32(session, "0xe000ed04");
    const cfsr = await readU32(session, "0xe000ed28");
    const hfsr = await readU32(session, "0xe000ed2c");
    const vectActive = icsr & 0x1ff;
    samples.push({ elapsedMs: Date.now() - startedAt, icsr, vectActive, cfsr, hfsr });
    if (cfsr !== 0 || hfsr !== 0) break;
    if (vectActive === 0) threadModeObserved = true;
    else if (!allowedTransientException(vectActive)) {
      disallowedException = vectActive;
      break;
    }
    if (Date.now() - startedAt >= 250 && samples.length >= 16 && threadModeObserved) break;
    if (Date.now() - startedAt >= 500) break;
    await delay(delays[index % delays.length]);
  }
  const stateAfter = samples.some((sample) => sample.cfsr !== 0 || sample.hfsr !== 0) || disallowedException !== undefined
    ? undefined
    : await request(session, { op: "state" });
  return { stateBefore, stateAfter, elapsedMs: Date.now() - startedAt, threadModeObserved, disallowedException, samples };
}

function healthy(observed) {
  return stateRunning(observed.stateBefore)
    && stateRunning(observed.stateAfter)
    && observed.threadModeObserved === true
    && observed.disallowedException === undefined
    && observed.elapsedMs >= 250
    && observed.samples.length >= 16
    && observed.samples.every((sample) => sample.cfsr === 0 && sample.hfsr === 0);
}

function stateRunning(state) {
  return state?.status === "ok" && state.targetStateAfter === "running" && state.stateUnknown === false;
}

function allowedTransientException(vectActive) {
  return vectActive >= 16 || vectActive === 11 || vectActive === 14 || vectActive === 15;
}

async function readU32(session, address) {
  const response = await request(session, { op: "read", address, size: 4, accessSize: 4 });
  if (response.status !== "ok"
    || response.stateUnknown !== false
    || response.targetStateBefore !== "running"
    || response.targetStateAfter !== "running"
    || !/^[0-9a-fA-F]{8}$/.test(String(response.bytesHex ?? ""))) {
    throw new Error(`read ${address} failed: ${JSON.stringify(response)}`);
  }
  return Buffer.from(response.bytesHex, "hex").readUInt32LE(0);
}

async function release(session) {
  return releaseMode === "close" ? close(session) : terminate(session);
}

async function close(session) {
  const response = await request(session, { op: "close" });
  const exit = await waitForExit(session.child, 10_000);
  if (response.status !== "ok" || response.api !== "JLINKARM_Close" || response.targetStateAfter !== "unknown" || response.stateUnknown !== true) {
    throw new Error(`close response invalid: ${JSON.stringify(response)}`);
  }
  return { response, exit };
}

async function terminate(session) {
  session.child.stdin.cork();
  const accepted = session.child.kill("SIGTERM");
  if (!accepted) throw new Error(`TerminateProcess was not accepted for pid ${session.child.pid}`);
  const exit = await waitForExit(session.child, 10_000);
  return { pid: session.child.pid, accepted, exit };
}

function lineInbox(child) {
  const pending = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-65536); });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let value;
    try { value = JSON.parse(line); }
    catch { value = { status: "invalid-json", line }; }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else pending.push(value);
  });
  return {
    next(timeoutMs) {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      return new Promise((resolveNext, rejectNext) => {
        const waiter = {
          resolve(value) { clearTimeout(timer); resolveNext(value); },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectNext(new Error(`helper response timeout; stderr=${stderr}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exitCode: child.exitCode, signalCode: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`helper pid ${child.pid} did not exit`)), timeoutMs);
    child.once("close", (exitCode, signalCode) => {
      clearTimeout(timer);
      resolveExit({ exitCode, signalCode });
    });
  });
}

function once(emitter, event, timeoutMs) {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(() => rejectEvent(new Error(`${event} timeout`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolveEvent(args);
    });
    emitter.once("error", (error) => {
      clearTimeout(timer);
      rejectEvent(error);
    });
  });
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith("--") || args[index + 1] === undefined) throw new Error(`invalid argument ${String(key)}`);
    parsed[key.slice(2)] = args[index + 1];
  }
  return parsed;
}

function required(value, key) {
  const result = value[key];
  if (!result) throw new Error(`--${key} is required`);
  return result;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
