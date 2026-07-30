import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ProbeQueue, ProbeQueueError } from "./probe-queue";

test("ProbeQueue preserves FIFO and continues after failure", async (context) => {
  const queue = new ProbeQueue(testDirectory(context, "queue-fifo"));
  const events: string[] = [];
  const first = queue.runExclusive("1001", async () => { events.push("first:start"); await delay(20); events.push("first:end"); throw new Error("expected"); });
  const second = queue.runExclusive("1001", async () => { events.push("second:start"); events.push("second:end"); return "ok"; });
  await assert.rejects(first, /expected/);
  const result = await second;
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(result.value, "ok");
  assert.equal(result.queueSequence, 2);
});

test("ProbeQueue permits different Probe serials to execute concurrently", async (context) => {
  const queue = new ProbeQueue(testDirectory(context, "queue-parallel"));
  let active = 0;
  let maximum = 0;
  const work = (serial: string) => queue.runExclusive(serial, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(30);
    active -= 1;
  });
  await Promise.all([work("1001"), work("1002")]);
  assert.equal(maximum, 2);
});

test("ProbeQueue publishes a token-specific guard before lease execution", async (context) => {
  const root = testDirectory(context, "queue-token-guard");
  const serial = "10021";
  const queue = new ProbeQueue(root);
  const leaseDirectory = join(root, createHash("sha256").update(serial).digest("hex"), "lease.lock");
  await queue.runExclusive(serial, async (metadata) => {
    const guardName = `.owner-${createHash("sha256").update(metadata.leaseToken).digest("hex")}.guard`;
    assert.equal(existsSync(join(leaseDirectory, guardName)), true);
  });
  assert.equal(existsSync(leaseDirectory), false);
});

test("ProbeQueue reports explicit long-lived owner errors", async (context) => {
  const queue = new ProbeQueue(testDirectory(context, "queue-owner"));
  let owner!: ReturnType<ProbeQueue["claimOwner"]>;
  await queue.runExclusive("1001", async (metadata) => {
    owner = queue.claimOwner("1001", { kind: "hss", projectRoot: "P", targetGeneration: "G" }, metadata.leaseToken);
  });
  await assert.rejects(
    queue.runExclusive("1001", async () => undefined),
    (error) => error instanceof ProbeQueueError && error.code === "CAPTURE_ACTIVE",
  );
  assert.equal(queue.releaseOwner("1001", owner.token), true);
  await queue.runExclusive("1001", async () => undefined);
});

test("ProbeQueue rejects owner claims made without the active lease token", async (context) => {
  const queue = new ProbeQueue(testDirectory(context, "queue-owner-lease"));
  assert.throws(
    () => queue.claimOwner("1001", { kind: "gdb", projectRoot: "P", targetGeneration: "G" }, "not-a-live-lease"),
    (error) => error instanceof ProbeQueueError && error.code === "LEASE_TOKEN_MISMATCH",
  );
});

test("ProbeQueue serializes separate Node processes and returns actual sequence order", async (context) => {
  const root = testDirectory(context, "queue-processes");
  const logPath = join(root, "events.ndjson");
  const modulePath = join(__dirname, "probe-queue.js");
  const script = [
    "const fs=require('node:fs');",
    "const {ProbeQueue}=require(process.argv[1]);",
    "const root=process.argv[2], log=process.argv[3], id=process.argv[4];",
    "(async()=>{const q=new ProbeQueue(root);const r=await q.runExclusive('1003',async m=>{fs.appendFileSync(log,JSON.stringify({id,kind:'start',sequence:m.queueSequence})+'\\n');await new Promise(r=>setTimeout(r,2));fs.appendFileSync(log,JSON.stringify({id,kind:'end',sequence:m.queueSequence})+'\\n');});process.stdout.write(String(r.queueSequence));})().catch(e=>{process.stderr.write(String(e.stack||e));process.exit(1);});",
  ].join("");
  const children = Array.from({ length: 24 }, (_, index) => String(index))
    .map((id) => runChild(script, [modulePath, root, logPath, id]));
  const sequences = (await Promise.all(children)).map(Number);
  const records = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; sequence: number });
  assert.deepEqual(records.map((record) => record.kind), Array.from({ length: sequences.length }, () => ["start", "end"]).flat());
  assert.deepEqual(records.filter((record) => record.kind === "start").map((record) => record.sequence), [...sequences].sort((a, b) => a - b));
});

test("ProbeQueue recovers a lease left by a crashed process", async (context) => {
  const root = testDirectory(context, "queue-crashed-lease");
  const modulePath = join(__dirname, "probe-queue.js");
  const script = [
    "const {ProbeQueue}=require(process.argv[1]);",
    "const q=new ProbeQueue(process.argv[2]);",
    "q.runExclusive('1004',async()=>{process.stdout.write('held',()=>process.exit(0));await new Promise(()=>{});});",
  ].join("");
  assert.equal(await runChild(script, [modulePath, root]), "held");
  const result = await new ProbeQueue(root).runExclusive("1004", async () => "recovered", { queueTimeoutMs: 5_000 });
  assert.equal(result.value, "recovered");
});

test("ProbeQueue stale readers cannot retire a replacement directory lock", async (context) => {
  const root = testDirectory(context, "queue-stale-reader-aba");
  const serial = "10041";
  const modulePath = join(__dirname, "probe-queue.js");
  const probeDirectory = join(root, createHash("sha256").update(serial).digest("hex"));
  const lockDirectory = join(probeDirectory, "owner-update.lock");
  const staleRead = join(root, "stale-read");
  const resumeStaleReader = join(root, "resume-stale-reader");
  const staleRemovalAttempt = join(root, "stale-removal-attempt");
  const replacementHeld = join(root, "replacement-held");
  const releaseReplacementOwner = join(root, "release-replacement-owner");
  const now = new Date().toISOString();
  const staleToken = randomUUID();
  mkdirSync(lockDirectory, { recursive: true });
  writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({
    sequence: 0,
    pid: 2_147_483_647,
    processInstanceId: "dead-lock-owner",
    processStartedAt: now,
    token: staleToken,
    queuedAt: now,
    heartbeatAt: now,
  }));
  const staleGuardName = `.owner-${createHash("sha256").update(staleToken).digest("hex")}.guard`;
  writeFileSync(join(lockDirectory, staleGuardName), staleToken);
  writeFileSync(join(probeDirectory, "owner.json"), JSON.stringify({
    kind: "hss",
    token: randomUUID(),
    pid: 2_147_483_647,
    processInstanceId: "dead-controller",
    processStartedAt: now,
    heartbeatAt: now,
    projectRoot: "P",
    targetGeneration: "G",
    acquiredAt: now,
    resourcePid: process.pid,
    details: { captureId: "capture-aba" },
  }));

  const staleReaderScript = [
    "const fs=require('node:fs'),path=require('node:path');",
    "const originalRead=fs.readFileSync.bind(fs),originalRename=fs.renameSync.bind(fs);",
    "const modulePath=process.argv[1],root=process.argv[2],serial=process.argv[3],resourcePid=Number(process.argv[4]),staleRead=process.argv[5],resume=process.argv[6],attempt=process.argv[7];",
    "let captured=false;",
    "fs.readFileSync=(file,...args)=>{const value=originalRead(file,...args);if(!captured&&String(file).endsWith(path.join('owner-update.lock','owner.json'))){captured=true;fs.writeFileSync(staleRead,'');while(!fs.existsSync(resume))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return value;};",
    "fs.renameSync=(source,destination)=>{if(captured&&String(source).includes('owner-update.lock')&&String(source).endsWith('.guard'))fs.writeFileSync(attempt,'');return originalRename(source,destination);};",
    "const {ProbeQueue}=require(modulePath);",
    "try{new ProbeQueue(root).adoptOwner(serial,{kind:'hss',projectRoot:'P',targetGeneration:'G',resourcePid,captureId:'capture-aba'});process.stderr.write('stale reader unexpectedly adopted owner');process.exit(1);}catch(e){if(e.code!=='OWNER_ADOPTION_DENIED')throw e;process.stdout.write('blocked');}",
  ].join("");
  const staleReader = runChild(staleReaderScript, [
    modulePath,
    root,
    serial,
    String(process.pid),
    staleRead,
    resumeStaleReader,
    staleRemovalAttempt,
  ]);

  const replacementScript = [
    "const fs=require('node:fs');",
    "const originalRename=fs.renameSync.bind(fs);",
    "const modulePath=process.argv[1],root=process.argv[2],serial=process.argv[3],resourcePid=Number(process.argv[4]),resume=process.argv[5],attempt=process.argv[6],held=process.argv[7],release=process.argv[8];",
    "let guardRenames=0;",
    "fs.renameSync=(source,destination)=>{if(String(source).includes('owner-update.lock')&&String(source).endsWith('.guard')&&++guardRenames===2){fs.writeFileSync(held,'');fs.writeFileSync(resume,'');while(!fs.existsSync(attempt))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return originalRename(source,destination);};",
    "const {ProbeQueue}=require(modulePath);",
    "const q=new ProbeQueue(root);q.adoptOwner(serial,{kind:'hss',projectRoot:'P',targetGeneration:'G',resourcePid,captureId:'capture-aba'});process.stdout.write('adopted');while(!fs.existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);",
  ].join("");
  let replacement: Promise<string> | undefined;
  try {
    await waitForFile(staleRead);
    replacement = runChild(replacementScript, [
      modulePath,
      root,
      serial,
      String(process.pid),
      resumeStaleReader,
      staleRemovalAttempt,
      replacementHeld,
      releaseReplacementOwner,
    ]);
    await waitForFile(replacementHeld);
    await waitForFile(staleRemovalAttempt);
    const replacementLock = JSON.parse(readFileSync(join(lockDirectory, "owner.json"), "utf8")) as { token: string };
    const replacementGuardName = `.owner-${createHash("sha256").update(replacementLock.token).digest("hex")}.guard`;
    assert.notEqual(replacementLock.token, staleToken);
    assert.equal(existsSync(join(lockDirectory, staleGuardName)), false);
    assert.equal(existsSync(join(lockDirectory, replacementGuardName)), true);
    assert.equal(await staleReader, "blocked");
    writeFileSync(releaseReplacementOwner, "");
    assert.equal(await replacement, "adopted");
  } finally {
    writeFileSync(resumeStaleReader, "");
    writeFileSync(releaseReplacementOwner, "");
    await Promise.allSettled([staleReader, ...(replacement ? [replacement] : [])]);
  }
});

test("ProbeQueue status reads an owner without waiting for a live metadata lock", async (context) => {
  const root = testDirectory(context, "queue-status-with-metadata-lock");
  const serial = "10045";
  const probeDir = join(root, createHash("sha256").update(serial).digest("hex"));
  const ownerPath = join(probeDir, "owner.json");
  const lockPath = join(probeDir, "owner-update.lock");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  assert.ok(child.pid);
  const now = new Date().toISOString();
  const owner = {
    kind: "gdb" as const,
    token: randomUUID(),
    pid: 1,
    processInstanceId: "stale-controller-instance",
    processStartedAt: now,
    heartbeatAt: now,
    projectRoot: "P",
    targetGeneration: "G",
    acquiredAt: now,
    resourcePid: process.pid,
  };
  mkdirSync(lockPath, { recursive: true });
  writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
    sequence: 0,
    pid: child.pid,
    processInstanceId: "different-live-process",
    processStartedAt: now,
    token: randomUUID(),
    queuedAt: now,
    heartbeatAt: now,
  }));
  writeFileSync(ownerPath, JSON.stringify(owner));
  try {
    assert.deepEqual(new ProbeQueue(root).getOwner(serial), owner);
    assert.equal(existsSync(lockPath), true);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
});

test("ProbeQueue status leaves dead owner cleanup to the locked writer path", async (context) => {
  const root = testDirectory(context, "queue-status-dead-owner");
  const serial = "10046";
  const probeDir = join(root, createHash("sha256").update(serial).digest("hex"));
  const ownerPath = join(probeDir, "owner.json");
  const now = new Date().toISOString();
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(ownerPath, JSON.stringify({
    kind: "memory",
    token: randomUUID(),
    pid: process.pid,
    processInstanceId: "dead-controller-instance",
    processStartedAt: now,
    heartbeatAt: now,
    projectRoot: "P",
    targetGeneration: "G",
    acquiredAt: now,
  }));
  const queue = new ProbeQueue(root);
  assert.equal(queue.getOwner(serial), undefined);
  assert.equal(existsSync(ownerPath), true);
  await queue.runExclusive(serial, async () => undefined);
  assert.equal(existsSync(ownerPath), false);
});

test("ProbeQueue never steals a stale-heartbeat lease from a live process", async (context) => {
  const root = testDirectory(context, "queue-live-stale-heartbeat");
  const modulePath = join(__dirname, "probe-queue.js");
  const script = [
    "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');",
    "const {ProbeQueue}=require(process.argv[1]);const root=process.argv[2],serial='1005';",
    "const q=new ProbeQueue(root);",
    "q.runExclusive(serial,async()=>{const keepAlive=setInterval(()=>{},1000);const key=crypto.createHash('sha256').update(serial).digest('hex');const p=path.join(root,key,'lease.lock','owner.json');const r=JSON.parse(fs.readFileSync(p,'utf8'));r.heartbeatAt='2000-01-01T00:00:00.000Z';fs.writeFileSync(p,JSON.stringify(r));process.stdout.write('held');await new Promise(()=>{});clearInterval(keepAlive);});",
  ].join("");
  const child = spawn(process.execPath, ["-e", script, modulePath, root], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolveHeld, rejectHeld) => {
    child.once("error", rejectHeld);
    child.stdout.once("data", () => resolveHeld());
  });
  try {
    assert.equal(child.exitCode, null);
    await assert.rejects(
      new ProbeQueue(root).runExclusive("1005", async () => undefined, { queueTimeoutMs: 100 }),
      (error) => error instanceof ProbeQueueError && error.code === "QUEUE_TIMEOUT",
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
});

test("ProbeQueue removes a dead long-lived owner without touching a replacement", async (context) => {
  const root = testDirectory(context, "queue-crashed-owner");
  const modulePath = join(__dirname, "probe-queue.js");
  const script = [
    "const {ProbeQueue}=require(process.argv[1]);",
    "const q=new ProbeQueue(process.argv[2]);",
    "q.runExclusive('1006',async m=>{q.claimOwner('1006',{kind:'gdb',projectRoot:'P',targetGeneration:'G'},m.leaseToken);process.stdout.write('owned',()=>process.exit(0));await new Promise(()=>{});});",
  ].join("");
  assert.equal(await runChild(script, [modulePath, root]), "owned");
  const queue = new ProbeQueue(root);
  assert.equal(queue.getOwner("1006"), undefined);
  let replacement!: ReturnType<ProbeQueue["claimOwner"]>;
  await queue.runExclusive("1006", async (metadata) => {
    replacement = queue.claimOwner("1006", { kind: "gdb", projectRoot: "P2", targetGeneration: "G2" }, metadata.leaseToken);
  }, { queueTimeoutMs: 5_000 });
  assert.equal(queue.getOwner("1006")?.token, replacement.token);
  queue.releaseOwner("1006", replacement.token);
});

test("ProbeQueue keeps an orphaned GDB owner while its server process is alive", async (context) => {
  const root = testDirectory(context, "queue-orphaned-gdb-owner");
  const modulePath = join(__dirname, "probe-queue.js");
  const script = [
    "const {spawn}=require('node:child_process');",
    "const {ProbeQueue}=require(process.argv[1]);",
    "const q=new ProbeQueue(process.argv[2]);",
    "q.runExclusive('1007',async m=>{",
    "const resource=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,windowsHide:true,stdio:'ignore'});resource.unref();",
    "q.claimOwner('1007',{kind:'gdb',projectRoot:'P',targetGeneration:'G',resourcePid:resource.pid},m.leaseToken);",
    "process.stdout.write(String(resource.pid),()=>process.exit(0));await new Promise(()=>{});});",
  ].join("");
  const resourcePid = Number(await runChild(script, [modulePath, root]));
  assert.equal(Number.isSafeInteger(resourcePid) && resourcePid > 0, true);
  const queue = new ProbeQueue(root);
  try {
    assert.equal(queue.getOwner("1007")?.resourcePid, resourcePid);
    await assert.rejects(
      queue.runExclusive("1007", async () => undefined, { queueTimeoutMs: 5_000 }),
      (error) => error instanceof ProbeQueueError && error.code === "GDB_SESSION_ACTIVE",
    );
  } finally {
    try { process.kill(resourcePid, "SIGTERM"); } catch { /* already gone */ }
    await waitForProcessExit(resourcePid);
  }
  assert.equal(queue.getOwner("1007"), undefined);
  await queue.runExclusive("1007", async () => undefined, { queueTimeoutMs: 5_000 });
});

test("ProbeQueue canonicalizes decimal spellings of the same J-Link serial", async (context) => {
  const queue = new ProbeQueue(testDirectory(context, "queue-canonical-serial"));
  let owner!: ReturnType<ProbeQueue["claimOwner"]>;
  await queue.runExclusive("001234", async (metadata) => {
    owner = queue.claimOwner("1234", { kind: "gdb", projectRoot: "P", targetGeneration: "G" }, metadata.leaseToken);
  });
  await assert.rejects(
    queue.runExclusive("1234", async () => undefined),
    (error) => error instanceof ProbeQueueError && error.code === "GDB_SESSION_ACTIVE",
  );
  queue.releaseOwner("0001234", owner.token);
});

function runChild(script: string, args: string[]): Promise<string> {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["-e", script, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (settled) return;
      settled = true;
      rejectChild(new Error("child process timed out after 15 seconds"));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectChild(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolveChild(stdout);
      else rejectChild(new Error(stderr || `child exited ${code}`));
    });
  });
}

function testDirectory(_context: TestContext, name: string): string {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-mcp-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(filePath) && Date.now() < deadline) await delay(10);
  assert.equal(existsSync(filePath), true, `timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processIsAlive(pid) && Date.now() < deadline) await delay(20);
  assert.equal(processIsAlive(pid), false, `process ${pid} did not exit`);
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
