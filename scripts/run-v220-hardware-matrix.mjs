#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const match = /^--([^=]+)=(.*)$/.exec(argument);
  if (!match) throw new Error(`invalid argument ${argument}; expected --name=value`);
  return [match[1], match[2]];
}));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = requiredPath("project-root");
const artifactPath = requiredPath("artifact");
const mapPath = requiredPath("map");
const flashPath = requiredPath("flash-image");
const jlinkDir = requiredPath("jlink-dir");
const gdbPath = requiredPath("gdb-path");
const canonicalStandalonePath = path.resolve(repositoryRoot, "out", "mcp", "standalone.js");
const standalonePath = path.resolve(options.standalone ?? canonicalStandalonePath);
const helperPath = path.resolve(options.helper ?? path.join(repositoryRoot, "native", "hss-helper", "bin", "hss_helper.exe"));
const packageMetadata = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const releaseBinaryMetadata = JSON.parse(await fs.readFile(path.join(repositoryRoot, "scripts", "v220-release-binaries.json"), "utf8"));
const expectedVersion = String(packageMetadata.version);
const expectedStandaloneSha256 = String(releaseBinaryMetadata.standaloneSha256 ?? "");
const expectedHelperSha256 = String(packageMetadata.jlinkMcp?.hssHelper?.sha256 ?? "");
const probeSerial = required("probe-serial");
const runId = `v220-hardware-matrix-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runRoot = path.resolve(options["run-root"] ?? path.join(repositoryRoot, "outputs", runId));
const evidencePath = path.resolve(options.evidence ?? path.join(runRoot, "result.json"));
const expectedBackends = ["hss", "background_poll", "stop_poll"];
const expectedRates = [1, 10, 100, 1_000];
const expectedVariableCounts = [1, 10];
const backends = parseList(options.backends ?? expectedBackends.join(","), expectedBackends);
const rates = parseIntegerList(options.rates ?? expectedRates.join(","), 1, 1_000);
const variableCounts = parseIntegerList(options["variable-counts"] ?? expectedVariableCounts.join(","), 1, 10);
const fullMatrixRequested = sameJson(backends, expectedBackends)
  && sameJson(rates, expectedRates)
  && sameJson(variableCounts, expectedVariableCounts);
const repositoryHeadBefore = gitHead(repositoryRoot);
const repositoryStatusBefore = gitStatus(repositoryRoot, false);
const targetStatusBefore = gitStatus(projectRoot, true);
const inputHashesBefore = await inputHashes();
const binaryHashesBefore = { standalone: await sha256(standalonePath), helper: await sha256(helperPath) };
const startedAt = new Date().toISOString();

const scalarWriteCases = [
  ["g_jlinkTestInt8", -7],
  ["g_jlinkTestInt16", -1599],
  ["g_jlinkTestInt32", -319999],
  ["g_jlinkTestUint8", 9],
  ["g_jlinkTestUint16", 1601],
  ["g_jlinkTestUint32", 320001],
  ["g_jlinkTestFloat32", 13.25],
  ["g_jlinkTestRamPattern[7]", 71],
  ["g_jlinkTestWriteSlots[0]", 0x5a5aa5a5],
  ["g_jlinkTestNested.signedValue", -1233],
  ["g_jlinkTestNested.unsignedValue", 4322],
  ["g_jlinkTestNested.nested.mode", 3],
  ["g_jlinkTestNested.nested.status", 0x5b],
  ["g_jlinkTestNested.values[0]", 0x12345678],
];

const captureSelectors = [
  ["g_jlinkTestStaticQualityValue", "staticQuality"],
  ["g_jlinkTestCounter", "counter"],
  ["g_jlinkTestInt8", "int8"],
  ["g_jlinkTestInt16", "int16"],
  ["g_jlinkTestInt32", "int32"],
  ["g_jlinkTestUint8", "uint8"],
  ["g_jlinkTestUint16", "uint16"],
  ["g_jlinkTestUint32", "uint32"],
  ["g_jlinkTestFloat32", "float32"],
  ["g_jlinkTestNested.signedValue", "nestedSigned"],
];

await fs.mkdir(runRoot, { recursive: true });
let outcome;
try {
  if (String(releaseBinaryMetadata.version) !== expectedVersion) throw new Error("release binary manifest version does not match package version");
  if (String(releaseBinaryMetadata.helperSha256) !== expectedHelperSha256) throw new Error("release binary manifest helper SHA does not match package metadata");
  if (fullMatrixRequested && !samePath(standalonePath, canonicalStandalonePath)) throw new Error("release matrix must use the canonical repository standalone.js");
  if (fullMatrixRequested && binaryHashesBefore.standalone !== expectedStandaloneSha256) throw new Error("canonical standalone SHA does not match the committed release binary manifest");
  if (fullMatrixRequested && binaryHashesBefore.helper !== expectedHelperSha256) throw new Error("native helper SHA does not match package metadata");
  const backendResults = [];
  for (let index = 0; index < backends.length; index += 1) {
    backendResults.push(await runBackend(backends[index], index));
  }
  const inputHashesAfter = await inputHashes();
  const binaryHashesAfter = { standalone: await sha256(standalonePath), helper: await sha256(helperPath) };
  const repositoryHeadAfter = gitHead(repositoryRoot);
  const repositoryStatusAfter = gitStatus(repositoryRoot, false);
  const targetStatusAfter = gitStatus(projectRoot, true);
  assertEqual(inputHashesAfter, inputHashesBefore, "target Artifact, MAP, or Flash image changed during the matrix");
  assertEqual(targetStatusAfter, targetStatusBefore, "target project worktree changed during the matrix");
  assertEqual(repositoryHeadAfter, repositoryHeadBefore, "repository HEAD changed during the matrix");
  assertEqual(repositoryStatusAfter, repositoryStatusBefore, "repository worktree changed during the matrix");
  assertEqual(binaryHashesAfter, binaryHashesBefore, "standalone or native helper changed during the matrix");
  if (binaryHashesAfter.helper !== expectedHelperSha256) throw new Error("native helper SHA does not match package metadata");
  const releaseEligible = fullMatrixRequested && releaseStatusAllowed(repositoryStatusAfter);
  outcome = {
    ok: true,
    releaseEligible,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    repositoryCommit: repositoryHeadAfter,
    repositoryStatus: repositoryStatusAfter,
    binaryHashes: binaryHashesAfter,
    expectedStandaloneSha256,
    expectedHelperSha256,
    canonicalStandalonePath,
    projectRoot,
    probeSerial,
    targetProjectUnchanged: true,
    inputHashes: inputHashesAfter,
    rates,
    variableCounts,
    backends: backendResults,
  };
} catch (error) {
  outcome = {
    ok: false,
    runId,
    startedAt,
    failedAt: new Date().toISOString(),
    repositoryCommit: gitHead(repositoryRoot),
    releaseEligible: false,
    projectRoot,
    probeSerial,
    error: error instanceof Error ? {
      message: error.message,
      stack: error.stack,
      backend: error.backend,
      stateUnknown: error.stateUnknown === true,
      cleanupIncomplete: error.cleanupIncomplete === true,
      cleanup: error.cleanup,
      transcript: error.transcript,
      faultEvidence: error.faultEvidence,
    } : String(error),
  };
}

await fs.mkdir(path.dirname(evidencePath), { recursive: true });
await fs.writeFile(evidencePath, `${JSON.stringify(outcome, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...outcome, evidencePath }, null, 2)}\n`);
if (!outcome.ok) process.exitCode = 1;

async function runBackend(backend, index) {
  const backendRoot = path.join(runRoot, backend);
  await fs.mkdir(backendRoot, { recursive: true });
  const transcript = [];
  let clientConnected = false;
  let configured = false;
  let activeCaptureId;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [standalonePath],
    cwd: repositoryRoot,
    stderr: "pipe",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      JLINK_INSTALL_DIR: jlinkDir,
      JLINK_MCP_STORAGE_ROOT: path.join(backendRoot, "storage"),
      JLINK_MCP_EVIDENCE_ROOT: path.join(backendRoot, "evidence"),
      JLINK_MCP_QUEUE_ROOT: path.join(backendRoot, "queue"),
      JLINK_MCP_PROFILE: "acceptance",
      JLINK_MCP_RESULT_MODE: "full",
      JLINK_MCP_TEST_CAPTURE_BACKEND: backend,
    },
  });
  const client = new Client({ name: `v220-hardware-matrix-${backend}`, version: "2.2.0" }, { capabilities: {} });

  async function callTool(name, args, { requireOk = true } = {}) {
    const raw = await client.callTool({ name, arguments: args });
    const response = parseEnvelope(raw);
    transcript.push({ name, ok: response.ok, code: response.error?.code, stateUnknown: response.error?.stateUnknown === true });
    if (response.error?.stateUnknown === true) {
      const error = new Error(`${name} left target state unknown: ${JSON.stringify(response.error)}`);
      error.stateUnknown = true;
      error.response = response;
      throw error;
    }
    if (requireOk && response.ok !== true) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? response)}`);
    return response;
  }

  try {
    await client.connect(transport);
    clientConnected = true;
    const serverVersion = client.getServerVersion();
    if (serverVersion?.version !== expectedVersion) {
      throw new Error(`expected MCP ${expectedVersion}, observed ${String(serverVersion?.version)}`);
    }
    const tools = (await client.listTools()).tools.map(({ name }) => name).sort();
    for (const requiredTool of ["mcp_init", "target_configure", "target_status", "read_variable", "write_variable", "flash", "hss_start", "hss_stop", "capture_summary", "capture_series"]) {
      if (!tools.includes(requiredTool)) throw new Error(`acceptance tool catalog is missing ${requiredTool}`);
    }
    await callTool("mcp_init", { projectRoot });
    const devices = await callTool("list_devices", {});
    if (!JSON.stringify(devices).includes(probeSerial)) throw new Error(`probe serial ${probeSerial} was not enumerated`);
    await callTool("target_configure", {
      projectRoot,
      device: options.device ?? "Z20K146M",
      gdbDevice: options["gdb-device"] ?? "Cortex-M4",
      interface: options.interface ?? "SWD",
      speed: Number(options.speed ?? 1000),
      probeSerial,
      artifactPath,
      mapPath,
      artifactFlashImages: [{ path: flashPath }],
      jlinkPath: path.join(jlinkDir, "JLink.exe"),
      gdbServerPath: path.join(jlinkDir, "JLinkGDBServerCL.exe"),
      gdbPath,
      ports: {
        gdb: Number(options["gdb-port"] ?? 2431) + index * 10,
        rtt: Number(options["rtt-port"] ?? 19121) + index * 10,
        swo: Number(options["swo-port"] ?? 2432) + index * 10,
      },
      memoryRegions: [
        { kind: "flash", start: 0x00000000, length: 0x00040000, writable: false },
        { kind: "ram", start: 0x20000000, length: 0x00020000, writable: true },
      ],
    });
    configured = true;
    let program;
    if (index === 0) {
      program = await callTool("flash", { projectRoot, path: flashPath });
      assertVerified(program, "matrix test firmware program");
    }
    const firmwareHalt = await callTool("target_control", { projectRoot, action: "halt" });
    assertPostState(firmwareHalt, "halted", `${backend} firmware verify-only halt`);
    const firmware = await callTool("target_status", { projectRoot, firmwareVerification: "segger_verify_only" });
    assertVerified(firmware, `${backend} firmware verify-only`);
    await requireRunningReset(callTool, `${backend} initial reset`);

    let typedAccess;
    let readOnlyBoundaries;
    if (index === 0) {
      typedAccess = await verifyTypedAccess(callTool);
      readOnlyBoundaries = await verifyReadOnlyBoundaries(callTool);
    }

    await requireRunningReset(callTool, `${backend} pre-capture fault baseline reset`);
    await delay(1_500);
    const preCaptureFaultGate = await verifyNoActiveFault(callTool, `${backend}/pre-capture`);

    const captures = [];
    for (const rateHz of rates) {
      for (const variableCount of variableCounts) {
        await requireRunningReset(callTool, `${backend}/${rateHz}Hz/${variableCount}vars pre-capture reset`);
        const variables = captureSelectors.slice(0, variableCount).map(([ref, alias]) => ({ ref, alias }));
        const baselines = {};
        for (const { ref, alias } of variables) {
          if (alias === "counter") continue;
          baselines[ref] = typedValueOf(await callTool("read_variable", { projectRoot, ref }));
        }
        const start = await callTool("hss_start", {
          projectRoot,
          variables,
          rateHz,
          durationSec: 1,
          ...(variables.some(({ alias }) => alias === "counter") ? {
            qualityOracle: {
              ref: "g_jlinkTestCounter",
              expectedIncrement: Math.max(1, Math.round(1000 / rateHz)),
              tolerance: Math.max(1, Math.round(200 / rateHz)),
            },
          } : {}),
        });
        if (backend !== "hss" && !start.observedEffects?.includes("acceptance_test_backend_forced")) {
          throw new Error(`${backend} start did not prove the acceptance-only backend override`);
        }
        activeCaptureId = captureIdOf(start);
        if (!activeCaptureId) throw new Error(`${backend}/${rateHz}Hz/${variableCount}vars did not return captureId`);
        await waitForCaptureTerminal(callTool, activeCaptureId);
        const stop = await callTool("hss_stop", { projectRoot, captureId: activeCaptureId });
        const captureId = activeCaptureId;
        activeCaptureId = undefined;
        const summary = await callTool("capture_summary", { captureId });
        const summaryData = dataOf(summary);
        if (summaryData.state !== "completed") throw new Error(`${captureId} state is ${String(summaryData.state)}`);
        if (summaryData.backend !== backend) throw new Error(`${captureId} expected backend ${backend}, observed ${String(summaryData.backend)}`);
        if (summaryData.requestedRateHz !== rateHz) throw new Error(`${captureId} requested-rate mismatch`);
        if (!Number.isFinite(summaryData.actualRateHz) || summaryData.actualRateHz <= 0) throw new Error(`${captureId} has no positive actual rate`);
        if (!Number.isInteger(summaryData.sampleCount) || summaryData.sampleCount < 1) throw new Error(`${captureId} has no samples`);
        const requestedNames = variables.map(({ ref }) => ref);
        if (!Array.isArray(summaryData.variables)
            || !sameJson(summaryData.variables.map(({ name }) => name), requestedNames)) {
          throw new Error(`${captureId} variable catalog mismatch`);
        }
        if (backend === "stop_poll" && (summaryData.intrusive !== true || !(summaryData.pauseTotalUs > 0))) {
          throw new Error(`${captureId} stop_poll did not record intrusive pause evidence`);
        }
        if (backend !== "stop_poll" && summaryData.intrusive !== false) throw new Error(`${captureId} non-stop backend was marked intrusive`);
        const rateEvidence = assertRateEvidence(stop, summaryData, rateHz, captureId);
        const series = await callTool("capture_series", {
          captureId,
          variables: requestedNames,
          resolution: { mode: "points", maxPoints: 64 },
          statistics: ["last", "min", "max"],
        });
        assertSeries(series, requestedNames, baselines, captureId);
        const faultGate = await verifyNoActiveFault(callTool, captureId);
        captures.push({
          captureId,
          requestedRateHz: rateHz,
          variableCount,
          backend: summaryData.backend,
          forcedBackendRequested: backend,
          forcedBackendMarker: backend === "hss" ? "actual_backend_match" : "acceptance_test_backend_forced",
          intrusive: summaryData.intrusive,
          actualRateHz: summaryData.actualRateHz,
          pauseTotalUs: summaryData.pauseTotalUs,
          sampleCount: summaryData.sampleCount,
          sampleThresholdMet: rateEvidence.sampleThresholdMet,
          quality: summaryData.quality,
          baselines,
          anomalies: rateEvidence.anomalies,
          faultGate,
        });
      }
    }

    const finalReset = await requireRunningReset(callTool, `${backend} final reset`);
    const captureFiles = await validateCaptureFiles(path.join(backendRoot, "evidence", "captures"), captures.map(({ captureId }) => captureId));
    await client.close();
    clientConnected = false;
    const finalStatus = await statusAfterClientClose(backendRoot, backend);
    assertOwnerReleased(finalStatus, `${backend} post-client-close status`);
    return {
      backend,
      serverVersion,
      toolCount: tools.length,
      program: program ? { ok: program.ok, verification: program.verification } : null,
      firmwareHaltVerified: true,
      firmwareVerified: true,
      typedAccess,
      readOnlyBoundaries,
      preCaptureFaultGate,
      captures,
      captureFiles,
      finalState: "running",
      finalReset: { ok: finalReset.ok, verification: finalReset.verification },
      transcript,
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const cleanup = [];
    let cleanupCanContinue = clientConnected && !failure.stateUnknown;
    if (cleanupCanContinue && activeCaptureId) {
      try {
        const response = await callTool("hss_stop", { projectRoot, captureId: activeCaptureId }, { requireOk: false });
        cleanup.push({ action: "hss_stop", response });
        if (response.ok !== true) {
          failure.cleanupIncomplete = true;
          cleanupCanContinue = false;
        }
      } catch (cleanupError) {
        cleanup.push({ action: "hss_stop", error: String(cleanupError) });
        failure.cleanupIncomplete = true;
        if (cleanupError?.stateUnknown) failure.stateUnknown = true;
        cleanupCanContinue = false;
      }
    }
    if (cleanupCanContinue && configured) {
      try {
        const response = await callTool("target_control", { projectRoot, action: "reset" }, { requireOk: false });
        cleanup.push({ action: "reset", response });
        if (response.ok !== true) failure.cleanupIncomplete = true;
      } catch (cleanupError) {
        cleanup.push({ action: "reset", error: String(cleanupError) });
        failure.cleanupIncomplete = true;
        if (cleanupError?.stateUnknown) failure.stateUnknown = true;
      }
    }
    failure.backend = backend;
    failure.cleanup = cleanup;
    failure.transcript = transcript;
    throw failure;
  } finally {
    if (clientConnected) await client.close().catch(() => transport.close().catch(() => undefined));
    else await transport.close().catch(() => undefined);
  }
}

async function verifyTypedAccess(callTool) {
  const results = [];
  for (const [ref, value] of scalarWriteCases) {
    const before = await callTool("read_variable", { projectRoot, ref });
    const beforeValue = typedValueOf(before);
    const write = await callTool("write_variable", {
      projectRoot,
      ref,
      value,
      captureOld: true,
      verify: true,
      restore: true,
      verificationConnection: "same_session",
    });
    assertVerified(write, `${ref} write/readback/restore`);
    const after = await callTool("read_variable", { projectRoot, ref });
    const afterValue = typedValueOf(after);
    if (!Object.is(afterValue, beforeValue)) throw new Error(`${ref} was not restored: before=${beforeValue}, after=${afterValue}`);
    results.push({ ref, before: beforeValue, requested: value, after: afterValue, restored: true });
  }
  return results;
}

async function verifyReadOnlyBoundaries(callTool) {
  const flash = await callTool("read_variable", { projectRoot, ref: "g_jlinkTestFlashConst" });
  const mirror = await callTool("read_variable", { projectRoot, ref: "g_jlinkTestFlashConstMirror" });
  const rejectedLayouts = [];
  for (const ref of ["g_jlinkTestUnion.raw", "g_jlinkTestUnion.floatValue", "g_jlinkTestPointer"]) {
    const response = await callTool("read_variable", { projectRoot, ref }, { requireOk: false });
    if (response.ok === true || response.error?.code !== "UNSUPPORTED_SYMBOL"
        || response.error?.stateUnknown === true || response.error?.writeIssued === true) {
      throw new Error(`${ref} safety boundary was not a known no-write rejection: ${JSON.stringify(response)}`);
    }
    rejectedLayouts.push({ ref, rejected: true, code: response.error.code, writeIssued: false, stateUnknown: false });
  }
  return {
    flashConst: typedValueOf(flash),
    flashConstMirror: typedValueOf(mirror),
    rejectedLayouts,
  };
}

async function waitForCaptureTerminal(callTool, captureId) {
  const deadline = Date.now() + 30_000;
  let state;
  while (Date.now() < deadline) {
    const status = await callTool("hss_status", { projectRoot, captureId });
    state = status.capture?.state ?? dataOf(status).session?.state;
    if (["completed", "stopped", "failed", "interrupted"].includes(state)) return status;
    await delay(100);
  }
  throw new Error(`${captureId} did not reach a terminal state within the bounded observation window; last state=${String(state)}`);
}

async function verifyNoActiveFault(callTool, captureId) {
  const halt = await callTool("target_control", { projectRoot, action: "halt" });
  assertPostState(halt, "halted", `${captureId} fault-gate halt`);
  const diagnosis = await callTool("diagnose_crash", { projectRoot });
  const registers = diagnosis.data?.coreRegisters?.registers;
  const faults = diagnosis.data?.faultRegisters?.raw;
  const raw = { ipsr: registers?.IPSR, cfsr: faults?.CFSR, hfsr: faults?.HFSR };
  const observed = {
    ipsr: parseRequiredHex(raw.ipsr, "IPSR"),
    cfsr: parseRequiredHex(raw.cfsr, "CFSR"),
    hfsr: parseRequiredHex(raw.hfsr, "HFSR"),
  };
  if (observed.ipsr !== 0n || observed.cfsr !== 0n || observed.hfsr !== 0n) {
    const error = new Error(`${captureId} observed an active exception or fault status: ${JSON.stringify(raw)}`);
    error.faultEvidence = {
      raw,
      registers,
      decoded: diagnosis.data?.faultRegisters?.decoded,
      frame: diagnosis.data?.frame,
      artifactMapping: diagnosis.data?.artifactMapping,
    };
    throw error;
  }
  const resume = await callTool("target_control", { projectRoot, action: "resume" });
  assertPostState(resume, "running", `${captureId} fault-gate resume`);
  return { ...raw, haltVerified: true, resumeVerified: true };
}

function parseRequiredHex(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new Error(`diagnose_crash did not expose a valid ${label}: ${String(value)}`);
  }
  return BigInt(value);
}

async function requireRunningReset(callTool, label) {
  const reset = await callTool("target_control", { projectRoot, action: "reset" });
  assertPostState(reset, "running", label);
  return reset;
}

function assertPostState(response, expected, label) {
  const states = [
    ["after.targetExecutionState", response.after?.targetExecutionState],
    ["data.finalState", response.data?.finalState],
  ].filter(([, value]) => typeof value === "string");
  if (!states.length || states.some(([, value]) => value !== expected)) {
    throw new Error(`${label} did not authoritatively confirm ${expected}: ${JSON.stringify(states)}`);
  }
}

async function statusAfterClientClose(backendRoot, backend) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [standalonePath],
    cwd: repositoryRoot,
    stderr: "pipe",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
      JLINK_INSTALL_DIR: jlinkDir,
      JLINK_MCP_STORAGE_ROOT: path.join(backendRoot, "storage"),
      JLINK_MCP_EVIDENCE_ROOT: path.join(backendRoot, "evidence"),
      JLINK_MCP_QUEUE_ROOT: path.join(backendRoot, "queue"),
      JLINK_MCP_PROFILE: "acceptance",
      JLINK_MCP_RESULT_MODE: "full",
    },
  });
  const observer = new Client({ name: `v220-owner-audit-${backend}`, version: expectedVersion }, { capabilities: {} });
  try {
    await observer.connect(transport);
    const initialized = parseEnvelope(await observer.callTool({ name: "mcp_init", arguments: { projectRoot } }));
    if (initialized.ok !== true) throw new Error(`${backend} post-close observer initialization failed`);
    const status = parseEnvelope(await observer.callTool({ name: "target_status", arguments: { projectRoot } }));
    if (status.ok !== true || status.error?.stateUnknown === true) throw new Error(`${backend} post-close owner status failed: ${JSON.stringify(status.error ?? status)}`);
    return status;
  } finally {
    await observer.close();
  }
}

function assertOwnerReleased(response, label) {
  const owners = [response.data?.owner, response.after?.owner, response.probe?.owner]
    .filter((value) => value !== undefined);
  if (!owners.length || owners.some((owner) => owner !== null)) {
    throw new Error(`${label} did not authoritatively confirm owner release: ${JSON.stringify(owners)}`);
  }
}

function assertVerified(response, label) {
  if (response.verification?.status !== "verified") {
    throw new Error(`${label} did not report top-level verified status: ${JSON.stringify(response.verification)}`);
  }
}

function assertRateEvidence(stop, summary, requestedRateHz, captureId) {
  const capture = stop.capture;
  if (!capture || capture.captureId !== captureId || capture.requestedRateHz !== requestedRateHz) {
    throw new Error(`${captureId} stop result did not expose authoritative capture-rate evidence`);
  }
  if (!Number.isFinite(capture.actualRateHz) || capture.actualRateHz !== summary.actualRateHz) {
    throw new Error(`${captureId} stop/JCAP actual-rate evidence disagrees`);
  }
  if (!Array.isArray(capture.anomalies) || capture.anomalies.some((code) => typeof code !== "string")) {
    throw new Error(`${captureId} stop result omitted anomaly evidence`);
  }
  const rateThresholdMet = summary.actualRateHz >= requestedRateHz * 0.95;
  const sampleThresholdMet = typeof capture.sampleThresholdMet === "boolean"
    ? capture.sampleThresholdMet
    : rateThresholdMet;
  const degraded = sampleThresholdMet === false || !rateThresholdMet;
  const reportsDegraded = capture.anomalies.includes("RATE_DEGRADED");
  if (degraded !== reportsDegraded) {
    throw new Error(`${captureId} RATE_DEGRADED evidence is inconsistent: degraded=${degraded}, anomalies=${capture.anomalies.join(",")}`);
  }
  return { sampleThresholdMet, anomalies: [...capture.anomalies] };
}

function assertSeries(response, requestedNames, baselines, captureId) {
  const data = dataOf(response);
  if (data.captureId !== captureId) throw new Error(`${captureId} series identity mismatch`);
  if (data.time?.unit !== "ms" || !Array.isArray(data.time.start) || !Array.isArray(data.time.end)
      || data.time.start.length < 1 || data.time.start.length !== data.time.end.length) {
    throw new Error(`${captureId} series time axes are empty or not aligned`);
  }
  for (let index = 0; index < data.time.start.length; index += 1) {
    const start = data.time.start[index];
    const end = data.time.end[index];
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start
        || (index > 0 && (start < data.time.start[index - 1] || end < data.time.end[index - 1]))) {
      throw new Error(`${captureId} series time axis is invalid at index ${index}`);
    }
  }
  if (!Array.isArray(data.variables)
      || !sameJson(data.variables.map(({ name }) => name), requestedNames)
      || new Set(data.variables.map(({ name }) => name)).size !== requestedNames.length) {
    throw new Error(`${captureId} series variable names are not exact and unique`);
  }
  for (const variable of data.variables) {
    for (const statistic of ["last", "min", "max"]) {
      if (!Array.isArray(variable[statistic]) || variable[statistic].length !== data.time.start.length) {
        throw new Error(`${captureId}/${variable.name}/${statistic} is not aligned to the shared time axis`);
      }
    }
    if (variable.name === "g_jlinkTestCounter") {
      let previousLast;
      let observed = false;
      for (let index = 0; index < data.time.start.length; index += 1) {
        const values = [variable.last[index], variable.min[index], variable.max[index]];
        if (values.every((value) => value === null)) continue;
        if (values.some((value) => !Number.isFinite(value))) throw new Error(`${captureId}/counter contains a partial or non-numeric bucket`);
        const [last, min, max] = values;
        if (min > last || last > max || (previousLast !== undefined && last < previousLast)) {
          throw new Error(`${captureId}/counter violates min<=last<=max or monotonic ordering`);
        }
        previousLast = last;
        observed = true;
      }
      if (!observed) throw new Error(`${captureId}/counter returned no numeric samples`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(baselines, variable.name)) {
      throw new Error(`${captureId}/${variable.name} has no pre-capture baseline`);
    }
    const baseline = baselines[variable.name];
    let observed = false;
    for (let index = 0; index < data.time.start.length; index += 1) {
      const values = [variable.last[index], variable.min[index], variable.max[index]];
      if (values.every((value) => value === null)) continue;
      if (values.some((value) => !Object.is(value, baseline))) {
        throw new Error(`${captureId}/${variable.name} disagrees with baseline ${baseline} at bucket ${index}`);
      }
      observed = true;
    }
    if (!observed) throw new Error(`${captureId}/${variable.name} returned no baseline-matching samples`);
  }
  if (data.nextCursor !== null) throw new Error(`${captureId} points query unexpectedly required pagination`);
  if (!data.quality || !Number.isInteger(data.quality.missing) || data.quality.missing < 0
      || !Number.isInteger(data.quality.dropped) || data.quality.dropped < 0) {
    throw new Error(`${captureId} series quality summary is missing or invalid`);
  }
}

async function validateCaptureFiles(captureRoot, captureIds) {
  const entries = await fs.readdir(captureRoot, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const expected = captureIds.map((captureId) => `${captureId}.jcap`).sort();
  assertEqual(files, expected, `capture directory contains sidecars or unexpected files: ${captureRoot}`);
  if (files.some((name) => /(?:-wal|-shm|\.tmp|\.db)$/i.test(name))) throw new Error(`${captureRoot} contains temporary SQLite files`);
  return Promise.all(files.map(async (name) => {
    const fullPath = path.join(captureRoot, name);
    const stat = await fs.stat(fullPath);
    return { name, size: stat.size, sha256: await sha256(fullPath) };
  }));
}

function parseEnvelope(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP tool result did not contain an operation envelope");
  return JSON.parse(text);
}

function dataOf(response) {
  return response.result ?? response.data ?? response;
}

function captureIdOf(response) {
  const data = dataOf(response);
  return typeof data.captureId === "string" ? data.captureId : undefined;
}

function typedValueOf(response) {
  const data = dataOf(response);
  if (typeof data.typedValue !== "number") throw new Error(`variable result did not contain a numeric typedValue: ${JSON.stringify(response)}`);
  return data.typedValue;
}

function required(name) {
  const value = options[name];
  if (!value) throw new Error(`missing required --${name}=...`);
  return value;
}

function requiredPath(name) {
  return path.resolve(required(name));
}

function parseList(value, allowed) {
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (!values.length || values.some((item) => !allowed.includes(item))) throw new Error(`invalid list ${value}; allowed: ${allowed.join(",")}`);
  return values;
}

function parseIntegerList(value, min, max) {
  const values = [...new Set(value.split(",").map((item) => Number(item.trim())))];
  if (!values.length || values.some((item) => !Number.isInteger(item) || item < min || item > max)) {
    throw new Error(`invalid integer list ${value}; expected ${min}..${max}`);
  }
  return values;
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function sameJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertEqual(actual, expected, message) {
  if (!sameJson(actual, expected)) throw new Error(message);
}

function releaseStatusAllowed(status) {
  return status.split("\n").filter(Boolean).every((line) => line === " M AGENTS.md" || line === "?? outputs/");
}

function gitStatus(root, allUntracked) {
  const result = spawnSync("git", ["status", "--short", `--untracked-files=${allUntracked ? "all" : "normal"}`], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git status failed for ${root}: ${result.stderr}`);
  return result.stdout.replace(/\r\n/g, "\n");
}

function gitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git rev-parse failed for ${root}: ${result.stderr}`);
  return result.stdout.trim();
}

async function inputHashes() {
  return {
    artifact: await sha256(artifactPath),
    map: await sha256(mapPath),
    flashImage: await sha256(flashPath),
  };
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
