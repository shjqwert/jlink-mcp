import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const targetRoot = "D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config";
const reportRoot = path.join(repoRoot, "reports", "p5", "hardware");
const standalone = path.join(repoRoot, "out", "mcp", "standalone.js");
const helper = path.join(repoRoot, "native", "hss-helper", "bin", "hss_helper.exe");
const adapter = path.join(repoRoot, "out", "mcp", "hss-dll", "hss-dll-adapter.js");
const dll = "C:\\Program Files\\SEGGER\\JLink_V884\\JLink_x64.dll";
const jlinkExe = "C:\\Program Files\\SEGGER\\JLink_V884\\JLink.exe";
const expected = {
  targetId: "Z20K146M",
  serial: "69401227",
  interface: "SWD",
  speedKhz: 4000,
  artifactSha256: "0ab51e0520a7afc2ffe064ac75296670016879958f56842c0e7433270278d5d6",
  mapSha256: "f95d59de4b2b3dcc3ce296069ad5c7d167007d54dea43e01a6284bfdddb2bdaf",
  artifactGeneration: "99b1212f878b34a13f0e0dd207ebf866b874ea763f5a8792bf6a08801b967066",
};
const flashCurrentSession = process.argv.includes("--flash-current-session");
const r4Only = process.argv.includes("--r4-only");
const sessionAuthorizedRun = flashCurrentSession || r4Only || process.argv.includes("--session-authorized");
const sessionAuthorizationSecret = sessionAuthorizedRun ? randomBytes(32).toString("base64url") : undefined;

if (process.argv.includes("--self-test")) {
  const profile = { runtime: { helperSha256: "old", sha256: "old-runtime" }, profileSha256: "old-profile" };
  const patched = patchProfile(profile, "new", "new-runtime");
  assert.deepEqual(changedPaths(profile, patched), ["profileSha256", "runtime.helperSha256", "runtime.sha256"]);
  assert.equal(sha256(Buffer.from(JSON.stringify({ mode: "none" }))), "7f517f97e00a688b0b402e4005866127e5c928bf44a94ca53477ac34e24b5ef1");
  assert.equal(writePlanRiskLevel({ risk: { level: "R2", requiresUserApproval: false }, data: { risk: "R2", requiresUserApproval: false } }), "R2");
  assert.equal(writePlanRiskLevel({ risk: "R2", requiresUserApproval: false }), "R2");
  assert.equal(writePlanRiskLevel({}), undefined);
  assert.equal(writePlanRiskLevel({ risk: { level: "R2", requiresUserApproval: false }, data: { risk: "R2", requiresUserApproval: true } }), undefined);
  assert.equal(writePlanRiskLevel({ risk: { level: "R2" }, data: { risk: "R4" } }), undefined);
  assert.equal(writePlanRiskLevel({ risk: "R4", requiresUserApproval: false }), undefined);
  const recovery = {};
  let stopCalls = 0;
  await assert.rejects(async () => {
    try {
      assert.equal({ level: "R2" }, "R2");
    } catch (error) {
      await stopStartedCapture(async () => {
        stopCalls += 1;
        return { state: "finalized" };
      }, "capture-self-test", recovery);
      throw error;
    }
  });
  assert.equal(stopCalls, 1);
  assert.deepEqual(recovery.captureRecovery, { captureId: "capture-self-test", state: "finalized" });
  const recoveryRequired = {};
  await assert.rejects(
    stopStartedCapture(async () => { throw new Error("stop unavailable"); }, "capture-self-test", recoveryRequired),
    /stop unavailable/,
  );
  assert.deepEqual(recoveryRequired.captureRecovery, { captureId: "capture-self-test", state: "recovery_required", error: "stop unavailable" });
  process.stdout.write("self-test ok\n");
  process.exit(0);
}

if (process.argv.includes("--manifest-only")) {
  const output = path.resolve(valueAfter("--output") ?? path.join(reportRoot, "manifest-after-readonly.json"));
  if (!inside(output, reportRoot)) throw new Error("--output must stay under reports/p5/hardware");
  const result = await manifest(targetRoot);
  await writeJson(output, result);
  process.stdout.write(`${JSON.stringify({ output, ...summary(result) })}\n`);
  process.exit(0);
}

const runRoot = path.resolve(valueAfter("--run-root") ?? path.join(reportRoot, "runs", new Date().toISOString().replace(/[:.]/g, "-")));
if (!inside(runRoot, reportRoot)) throw new Error("--run-root must stay under reports/p5/hardware");
const storageRoot = path.join(runRoot, "storage");
const evidenceRoot = path.join(runRoot, "evidence");
const statusFile = path.join(runRoot, "status.json");
const transcript = [];
const evidence = {
  schema: "p5-hardware-r2-r4-v1",
  runRoot,
  targetRoot,
  commands: [],
  forbiddenActions: { flash: 0, erase: 0, reset: 0, halt: 0, resume: 0, r5: 0 },
  authorizedActions: { flash: 0 },
  calls: transcript,
};
let client;
let activeCaptureId;
let captureStopAttempted = false;

await mkdir(storageRoot, { recursive: true });
await mkdir(evidenceRoot, { recursive: true });
await setStatus("starting");

try {
  const before = await manifest(targetRoot);
  assert.equal(before.entries.length, 1813, "target manifest file count changed before hardware acceptance");
  await writeJson(path.join(runRoot, "manifest-before.json"), before);
  evidence.manifestBefore = summary(before);

  const probeEnumeration = await enumerateProbe();
  assert.deepEqual(probeEnumeration.serials, [expected.serial], "exactly one expected J-Link serial must be attached");
  evidence.probeEnumeration = probeEnumeration;

  const profilePath = trustProfilePath(targetRoot);
  const profileBytes = await readFile(profilePath);
  const profile = JSON.parse(profileBytes.toString("utf8"));
  const profileBefore = profileSummary(profilePath, profileBytes, profile);
  await writeFile(path.join(runRoot, "trust-profile-before.json"), profileBytes);

  const helperVersion = await helperCommand("version", []);
  const helperPreflight = await helperCommand("preflight", ["--dll", dll]);
  const identities = await runtimeIdentities(profile, helperVersion, helperPreflight);
  assertProfileGate(profile, identities);

  const transportEnv = cleanEnv({
    ...process.env,
    PROBE_TYPE: "jlink",
    JLINK_DEVICE: expected.targetId,
    JLINK_INTERFACE: expected.interface,
    JLINK_SPEED: String(expected.speedKhz),
    JLINK_SERIAL: expected.serial,
    JLINK_DLL_PATH: dll,
    JLINK_INSTALL_DIR: path.dirname(jlinkExe),
    JLINK_MCP_HSS_HELPER_PATH: helper,
    JLINK_MCP_STORAGE_ROOT: storageRoot,
    JLINK_MCP_EVIDENCE_ROOT: evidenceRoot,
    JLINK_MCP_R4_SESSION_AUTHORIZATION: sessionAuthorizationSecret,
  });
  const transport = new StdioClientTransport({ command: process.execPath, args: [standalone], cwd: targetRoot, env: transportEnv, stderr: "pipe" });
  client = new Client({ name: "p5-hardware-acceptance", version: "1" });
  transport.stderr?.on("data", (chunk) => appendLog(path.join(runRoot, "standalone.stderr.log"), chunk));
  evidence.commands.push({ command: `${process.execPath} ${standalone}`, cwd: targetRoot, env: redactedEnv(transportEnv) });
  await client.connect(transport);

  const artifactProbe = await call("artifact_probe", {
    artifactFile: path.join(targetRoot, "Appl", "Debug", "Exe", "FOC_SCM.out"),
    mapFile: path.join(targetRoot, "Appl", "Debug", "List", "FOC_SCM.map"),
  });
  const artifact = findObject(artifactProbe, (item) => item.generation && item.sha256 && item.mapSha256 && item.path && item.mapPath);
  assert.ok(artifact, "artifact_probe did not return one selected OUT/MAP generation");
  assert.equal(artifact.sha256, expected.artifactSha256);
  assert.equal(artifact.mapSha256, expected.mapSha256);
  assert.equal(artifact.generation, expected.artifactGeneration);
  assert.ok(inside(path.resolve(artifact.path), targetRoot) && inside(path.resolve(artifact.mapPath), targetRoot));

  const refs = [];
  for (const name of ["g_hssDbgCounterFocIsr", "g_hssDbgWriteProbe"]) {
    await call("symbol_search", { artifactGeneration: artifact.generation, query: name, limit: 8 });
    const resolved = await call("symbol_resolve", { artifactGeneration: artifact.generation, selector: name, type: "uint32" });
    const ref = findObject(resolved, (item) => item.qualifiedName === name && item.artifactGeneration && item.layoutHash);
    assert.ok(ref, `symbol_resolve did not return ${name}`);
    refs.push({ source: "hot_variable", ref: pick(ref, ["qualifiedName", "memberPath", "artifactGeneration", "layoutHash"]) });
    await call("hot_variable_add", { ref: refs.at(-1).ref });
  }
  evidence.artifact = artifact;
  evidence.variableRefs = refs;

  // Authorized refresh: only the helper identity and its two derived integrity digests change.
  const patched = patchProfile(profile, identities.helperSha256, identities.runtimeSha256);
  const changes = changedPaths(profile, patched);
  assert.ok(changes.length === 0 || JSON.stringify(changes) === JSON.stringify(["profileSha256", "runtime.helperSha256", "runtime.sha256"]));
  if (changes.length) {
    const temporaryProfile = `${profilePath}.${process.pid}.tmp`;
    await writeFile(temporaryProfile, `${JSON.stringify(patched, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryProfile, profilePath);
  }
  const profileAfterBytes = await readFile(profilePath);
  const reloadedProfile = JSON.parse(profileAfterBytes.toString("utf8"));
  assert.deepEqual(reloadedProfile, patched);
  evidence.trustRefresh = {
    authorizedChanges: changes,
    alreadyCurrent: changes.length === 0,
    before: profileBefore,
    after: profileSummary(profilePath, profileAfterBytes, reloadedProfile),
  };

  if (flashCurrentSession) {
    const challengePayload = await call("flash_plan", { filePath: artifact.path });
    const challenge = findObject(challengePayload, (item) => item.challengeId && item.operationDigest && item.summary && item.expiresAt);
    assert.ok(challenge, "flash_plan did not return an exact challenge");
    const missingApproval = await call("flash", { filePath: artifact.path, challengeId: challenge.challengeId });
    assert.equal(findValue(missingApproval, "code"), "approval_required", "unapproved flash did not fail closed");
    assert.notEqual(findValue(missingApproval, "hardwareActionIssued"), true);
    assert.notEqual(findValue(missingApproval, "executorCalled"), true);
    evidence.flash = {
      challenge: pick(challenge, ["challengeId", "operationDigest", "summary", "expiresAt"]),
      missingApproval,
      artifact: pick(artifact, ["path", "sha256", "generation"]),
    };
    await writeJson(path.join(runRoot, "evidence.json"), evidence);
    await setStatus("authorizing_current_session", { challenge: evidence.flash.challenge });
    await approveCurrentSession(challenge.challengeId, transportEnv, evidence.flash);
    evidence.authorizedActions.flash += 1;
    const executed = await call("flash", { filePath: artifact.path, challengeId: challenge.challengeId }, 240000);
    assert.equal(findValue(executed, "success") ?? findValue(executed, "ok"), true, "session-authorized flash did not execute successfully");
    const replay = await call("flash", { filePath: artifact.path, challengeId: challenge.challengeId });
    assert.equal(findValue(replay, "code"), "approval_replayed", "same retained approval was not rejected on replay");
    evidence.flash.executed = executed;
    evidence.flash.replay = replay;
    const after = await manifest(targetRoot);
    await writeJson(path.join(runRoot, "manifest-after.json"), after);
    assert.equal(after.digest, before.digest, "target project changed during authorized Flash");
    evidence.manifestAfter = summary(after);
    await writeJson(path.join(runRoot, "evidence.json"), evidence);
    await setStatus("completed", { evidenceFile: path.join(runRoot, "evidence.json"), authorizedFlash: true });
  } else if (r4Only) {
    await executeR4ProbeAcceptance(transportEnv);
    const after = await manifest(targetRoot);
    await writeJson(path.join(runRoot, "manifest-after.json"), after);
    assert.equal(after.digest, before.digest, "target project changed during R4-only acceptance");
    evidence.manifestAfter = summary(after);
    await writeJson(path.join(runRoot, "evidence.json"), evidence);
    await setStatus("completed", { evidenceFile: path.join(runRoot, "evidence.json"), r4Only: true });
  } else {

  const capability = await call("hss_capability_probe", bindingArgs());
  assert.equal(findValue(capability, "runtimeIdentityValidated"), true, "runtime identity was not validated after Trust refresh");
  assert.equal(findValue(capability, "getCapsOk"), true, "GetCaps did not pass");
  assert.equal(findValue(capability, "probeSerial"), expected.serial);
  assert.equal(findValue(capability, "targetId"), expected.targetId);

  const plan = await call("hss_capture_plan", {
    ...bindingArgs(),
    artifactFile: artifact.path,
    mapFile: artifact.mapPath,
    variableRefs: refs,
    requestedRateHz: 100,
    durationSec: 10,
    nonvolatileRanges: [{ start: 0, end: 0x20000000 }],
    ramRanges: [{ start: 0x20000000, end: 0x40000000 }],
    resetBeforeCapture: false,
    resumeBeforeStart: false,
    sessionName: "p5-hardware-r2-r4-v2",
  });
  const planId = findValue(plan, "planId");
  assert.equal(typeof planId, "string");
  assert.equal(findValue(plan, "resetBeforeCapture") ?? false, false);

  const started = await call("hss_capture_start", { ...bindingArgs(), planId });
  assert.equal(findValue(started, "ok"), true, `hss_capture_start failed: ${findValue(started, "code") ?? "unknown"}`);
  const captureId = findValue(started, "captureId");
  assert.equal(typeof captureId, "string");
  activeCaptureId = captureId;
  await call("hss_capture_status", { captureId });

  const writePlan = await call("variable_write_plan", {
    captureId,
    artifactFile: artifact.path,
    mapFile: artifact.mapPath,
    targetRef: { kind: "scalar", path: "g_hssDbgWriteProbe" },
    type: "uint32",
    value: 1,
  });
  const writePlanId = findValue(writePlan, "writePlanId") ?? findValue(writePlan, "planId");
  assert.equal(typeof writePlanId, "string");
  assert.equal(writePlanRiskLevel(writePlan), "R2", "variable_write_plan must return one unambiguous R2 risk");
  const writeResult = await call("variable_write_execute", { writePlanId });
  assert.equal(findValue(writeResult, "ok"), true);
  assert.equal(typeof findValue(writeResult, "writeId"), "string");
  assert.equal(findValue(writeResult, "readbackOk"), true);
  assert.equal(Number(findValue(writeResult, "readbackValue") ?? findValue(writeResult, "readback")), 1);
  const eventId = findValue(writeResult, "eventId") ?? findValue(writeResult, "eventUuid");

  captureStopAttempted = true;
  const stopped = await call("hss_capture_stop", { captureId });
  const terminalState = findValue(stopped, "captureState") ?? findValue(stopped, "state");
  assert.ok(["completed", "stopped", "finalized"].includes(terminalState), `unexpected capture terminal state: ${terminalState}`);
  activeCaptureId = undefined;
  const captureSummary = await call("capture_summary", { captureId });
  if (typeof eventId === "string") {
    await call("capture_event_window", { captureId, eventId, variables: ["g_hssDbgCounterFocIsr", "g_hssDbgWriteProbe"], beforeMs: 100, afterMs: 100, bucketCount: 20 });
  }
  evidence.capture = { captureId, terminalState, eventId, summary: captureSummary };

  const afterPhase1 = await manifest(targetRoot);
  await writeJson(path.join(runRoot, "manifest-after-phase1.json"), afterPhase1);
  assert.equal(afterPhase1.digest, before.digest, "target project changed during Trust/HSS/R2 acceptance");
  evidence.manifestAfterPhase1 = summary(afterPhase1);

  await executeR4ProbeAcceptance(transportEnv, captureId);

  const after = await manifest(targetRoot);
  await writeJson(path.join(runRoot, "manifest-after.json"), after);
  assert.equal(after.digest, before.digest, "target project changed during R4 acceptance");
  evidence.manifestAfter = summary(after);
  await writeJson(path.join(runRoot, "evidence.json"), evidence);
  await setStatus("completed", { captureId, evidenceFile: path.join(runRoot, "evidence.json") });
  }
} catch (error) {
  if (activeCaptureId && !captureStopAttempted) {
    try {
      await stopStartedCapture((captureId) => call("hss_capture_stop", { captureId }), activeCaptureId, evidence);
      activeCaptureId = undefined;
    } catch {
      // stopStartedCapture records explicit recovery evidence and this run remains failed closed.
    }
  } else if (activeCaptureId) {
    evidence.captureRecovery ??= { captureId: activeCaptureId, state: "recovery_required", reason: "hss_capture_stop did not prove a terminal state" };
  }
  evidence.failure = { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined };
  await writeJson(path.join(runRoot, "evidence.json"), evidence).catch(() => {});
  await setStatus("failed", evidence.failure).catch(() => {});
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
}

function bindingArgs() {
  return {
    projectRoot: targetRoot,
    targetId: expected.targetId,
    device: expected.targetId,
    dllPath: dll,
    interface: expected.interface,
    speedKhz: expected.speedKhz,
    serial: expected.serial,
    script: { mode: "none" },
  };
}

async function call(name, args, timeoutMs) {
  const raw = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
  const payload = toolPayload(raw);
  transcript.push({ at: new Date().toISOString(), name, arguments: redact(args), isError: raw.isError === true, payload });
  await writeJson(path.join(runRoot, "evidence.json"), evidence);
  return payload;
}

function toolPayload(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") return result;
  try { return JSON.parse(text); } catch { return { text }; }
}

async function enumerateProbe() {
  const command = ["ShowEmuList USB", "exit"];
  evidence.commands.push({ command: `${jlinkExe} -NoGui 1`, stdin: command, cwd: repoRoot });
  const result = await run(jlinkExe, ["-NoGui", "1"], { cwd: repoRoot, input: `${command.join("\n")}\n` });
  assert.equal(result.code, 0, result.stderr || "J-Link enumeration failed");
  const serials = [...new Set([...result.stdout.matchAll(/Serial number:\s*(\d+)/gi), ...result.stdout.matchAll(/S\/N:\s*(\d+)/gi)].map((match) => match[1]))].sort();
  return { serials, stdoutSha256: sha256(Buffer.from(result.stdout)), stdout: result.stdout };
}

async function helperCommand(command, args) {
  const result = await run(helper, [command, ...args], { cwd: repoRoot });
  assert.equal(result.code, 0, result.stderr || `${command} failed`);
  return JSON.parse(result.stdout.trim());
}

async function runtimeIdentities(profile, version, preflight) {
  assert.equal(version.status, "ok");
  assert.equal(preflight.status, "ok");
  const dllSha256 = await fileSha256(dll);
  const helperSha256 = await fileSha256(helper);
  const adapterSha256 = await fileSha256(adapter);
  const scriptApprovalSha256 = sha256(Buffer.from(JSON.stringify({ mode: "none" })));
  const runtimeSha256 = sha256(Buffer.from(JSON.stringify({
    dllSha256,
    dllVersion: String(preflight.dllVersion),
    helperVersion: String(version.helperVersion),
    helperProtocolVersion: Number(version.helperProtocolVersion),
    helperSha256,
    adapterVersion: "1",
    adapterSha256,
    jlinkScriptMode: "none",
    jlinkScriptApprovalSha256: scriptApprovalSha256,
  })));
  return { dllSha256, helperSha256, adapterSha256, scriptApprovalSha256, runtimeSha256, version, preflight, profile };
}

function assertProfileGate(profile, identities) {
  assert.equal(profile.project.root, targetRoot);
  assert.equal(profile.project.namespaceSha256, projectNamespace(targetRoot));
  assert.equal(profile.target.targetId, expected.targetId);
  assert.deepEqual(profile.probe, { serial: expected.serial, interface: expected.interface, speedKhz: expected.speedKhz });
  assert.deepEqual(profile.script, { mode: "none" });
  assert.equal(path.resolve(profile.runtime.dllPath), path.resolve(dll));
  assert.equal(path.resolve(profile.runtime.helperPath), path.resolve(helper));
  assert.equal(path.resolve(profile.runtime.adapterPath), path.resolve(adapter));
  assert.equal(profile.runtime.dllSha256, identities.dllSha256);
  assert.equal(profile.runtime.adapterSha256, identities.adapterSha256);
  assert.equal(profile.runtime.dllVersion, String(identities.preflight.dllVersion));
  assert.equal(profile.runtime.helperVersion, String(identities.version.helperVersion));
  assert.equal(profile.runtime.helperProtocolVersion, Number(identities.version.helperProtocolVersion));
  assert.equal(profile.runtime.adapterVersion, "1");
  assert.equal(profile.validation.getCaps, true);
  assert.equal(profile.validation.lifecycle, true);
  assert.equal(profile.validation.decoderSemantics, true);
}

function patchProfile(profile, helperSha256, runtimeSha256) {
  const patched = structuredClone(profile);
  patched.runtime.helperSha256 = helperSha256;
  patched.runtime.sha256 = runtimeSha256;
  const { profileSha256: _old, ...content } = patched;
  patched.profileSha256 = sha256(Buffer.from(JSON.stringify(content)));
  return patched;
}

async function approveCurrentSession(challengeId, env, approvalEvidence) {
  assert.ok(sessionAuthorizationSecret, "current-session authorization was not enabled for this run");
  evidence.commands.push({ command: `${process.execPath} ${standalone} approve ${challengeId} --session-authorized`, cwd: targetRoot, authorization: "ephemeral-current-session" });
  const result = await run(process.execPath, [standalone, "approve", challengeId, "--session-authorized"], { cwd: targetRoot, env });
  assert.equal(result.code, 0, result.stderr || "approval CLI failed");
  assert.match(result.stdout, /retained by the broker for one exact session-authorized execution/);
  approvalEvidence.approvalCli = { exitCode: result.code, stdoutSha256: sha256(Buffer.from(result.stdout)), stderr: result.stderr, authorization: "ephemeral-current-session", tokenPersisted: false };
}

async function executeR4ProbeAcceptance(env, captureId) {
  // The approved raw command stays side-effect free. The J-Link backend
  // prepends its own DHCSR read, which establishes and verifies the target
  // connection without exposing `mem` as an arbitrary R4 command verb.
  const commands = ["sleep 1"];
  const challengePayload = await call("probe_command_plan", { commands });
  const challenge = findObject(challengePayload, (item) => item.challengeId && item.operationDigest && item.summary && item.expiresAt);
  assert.ok(challenge, "probe_command_plan did not return an exact challenge");
  const missingApproval = await call("probe_command", { commands, challengeId: challenge.challengeId });
  assert.equal(findValue(missingApproval, "code"), "approval_required", "missing-approval path did not fail closed");
  assert.notEqual(findValue(missingApproval, "hardwareActionIssued"), true);
  assert.notEqual(findValue(missingApproval, "executorCalled"), true);
  evidence.r4 = { challenge: pick(challenge, ["challengeId", "operationDigest", "summary", "expiresAt"]), missingApproval };
  await writeJson(path.join(runRoot, "evidence.json"), evidence);
  await setStatus("authorizing_current_session", { challenge: evidence.r4.challenge, ...(captureId ? { captureId } : {}) });
  await approveCurrentSession(challenge.challengeId, env, evidence.r4);
  const executed = await call("probe_command", { commands, challengeId: challenge.challengeId });
  const replay = await call("probe_command", { commands, challengeId: challenge.challengeId });
  assert.equal(findValue(executed, "success") ?? findValue(executed, "ok"), true, "approved read-only probe command did not execute successfully");
  assert.equal(findValue(replay, "code"), "approval_replayed", "same retained approval was not rejected on replay");
  evidence.r4.executed = executed;
  evidence.r4.replay = replay;
}

async function manifest(root) {
  const entries = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const info = await stat(file);
        entries.push({ path: path.relative(root, file).replace(/\\/g, "/"), size: info.size, sha256: await fileSha256(file) });
      }
    }
  };
  await walk(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries, digest: sha256(Buffer.from(JSON.stringify(entries), "utf8")) };
}

function trustProfilePath(projectRoot) {
  const base = process.env.JLINK_MCP_TRUST_STORE_ROOT
    ?? path.join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? path.join(os.homedir(), ".local", "share"), "jlink-mcp", "trust");
  return path.join(base, "projects", projectNamespace(projectRoot), "trust-profile.json");
}

function projectNamespace(projectRoot) {
  return sha256(Buffer.from(path.normalize(projectRoot).toLowerCase()));
}

function profileSummary(file, bytes, profile) {
  return {
    path: file,
    fileSha256: sha256(bytes),
    bytes: bytes.length,
    profileSha256: profile.profileSha256,
    runtimeSha256: profile.runtime.sha256,
    helperSha256: profile.runtime.helperSha256,
  };
}

function changedPaths(before, after, prefix = "") {
  if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .flatMap((key) => changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key))
      .sort();
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

function findObject(value, predicate) {
  if (value && typeof value === "object") {
    if (!Array.isArray(value) && predicate(value)) return value;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = findObject(child, predicate);
      if (found) return found;
    }
  }
}

function findValue(value, key) {
  if (value && typeof value === "object") {
    if (!Array.isArray(value) && Object.hasOwn(value, key)) return value[key];
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      const found = findValue(child, key);
      if (found !== undefined) return found;
    }
  }
}

function writePlanRiskLevel(value) {
  const levels = [];
  const approvals = [];
  const collect = (item) => {
    if (!item || typeof item !== "object") return;
    if (!Array.isArray(item) && Object.hasOwn(item, "risk")) {
      const risk = item.risk;
      levels.push(typeof risk === "string" ? risk : risk && typeof risk === "object" && typeof risk.level === "string" ? risk.level : undefined);
    }
    if (!Array.isArray(item) && Object.hasOwn(item, "requiresUserApproval")) approvals.push(item.requiresUserApproval);
    for (const child of Array.isArray(item) ? item : Object.values(item)) collect(child);
  };
  collect(value);
  const uniqueLevels = [...new Set(levels)];
  const uniqueApprovals = [...new Set(approvals)];
  return uniqueLevels.length === 1 && uniqueLevels[0] === "R2" && uniqueApprovals.length === 1 && uniqueApprovals[0] === false ? "R2" : undefined;
}

async function stopStartedCapture(stop, captureId, captureEvidence) {
  try {
    const stopped = await stop(captureId);
    const terminalState = findValue(stopped, "captureState") ?? findValue(stopped, "state");
    captureEvidence.captureRecovery = { captureId, state: terminalState };
    assert.ok(["completed", "stopped", "finalized"].includes(terminalState), `unexpected capture recovery state: ${terminalState}`);
    return stopped;
  } catch (error) {
    captureEvidence.captureRecovery = {
      captureId,
      state: "recovery_required",
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret/i.test(key) ? "<redacted>" : redact(item)]));
  return value;
}

function cleanEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string"));
}

function redactedEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("JLINK_") || key === "PROBE_TYPE").map(([key, value]) => [key, /TOKEN|SECRET|CREDENTIAL|AUTHORIZATION/i.test(key) ? "<redacted>" : value]));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

async function appendLog(file, chunk) {
  const previous = existsSync(file) ? await readFile(file) : Buffer.alloc(0);
  await writeFile(file, Buffer.concat([previous, Buffer.from(chunk)]));
}

async function setStatus(state, details = {}) {
  const status = { schema: "p5-hardware-status-v1", state, updatedAt: new Date().toISOString(), runRoot, ...details };
  await writeJson(statusFile, status);
  await mkdir(reportRoot, { recursive: true });
  await writeJson(path.join(reportRoot, "latest.json"), status);
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function fileSha256(file) {
  return sha256(await readFile(file));
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function summary(value) {
  return { files: value.entries.length, digest: value.digest };
}

function inside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
