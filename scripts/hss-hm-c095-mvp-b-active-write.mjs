#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JLinkBackend } from "../out/probe/jlink.js";
import { ProcessManager } from "../out/utils/process-manager.js";
import { HssCaptureService } from "../out/mcp/hss/hss-capture-service.js";

const options = parseArgs(process.argv.slice(2));
const device = process.env.JLINK_DEVICE ?? "Z20K146M";
if (device !== "Z20K146M") {
  console.error(`HM_C095 active write requires JLINK_DEVICE=Z20K146M, got ${device}`);
  process.exit(2);
}

const root = options.fake
  ? join(process.cwd(), ".tmp", `hss-active-write-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  : process.cwd();
const target = options.target ?? (options.fake ? "Debug_IqRef" : "g_hssDbgWriteProbe");
const value = Number(options.value ?? 1);
const rateHz = Number(options.rateHz ?? 100);
const durationSec = Number(options.durationSec ?? 3);
const minSamples = Number(options.minSamples ?? 3);
const pollMs = Number(options.pollMs ?? 100);
const dllPath = options.dllPath ?? (options.fake ? join(root, "JLink_x64.dll") : undefined);
const symbols = options.fake
  ? [{ name: "Debug_IqRef", type: "int32" }]
  : undefined;

if (!Number.isFinite(value) || !Number.isInteger(rateHz) || rateHz < 1 || !Number.isInteger(durationSec) || durationSec < 1 || !Number.isInteger(minSamples) || minSamples < 1) {
  console.error("value/rateHz/durationSec/minSamples are invalid");
  process.exit(2);
}

let probe;
let service;
let captureId;
let finalResult;
const startedAt = Date.now();
try {
  if (options.fake) await writeFakeProject(root, dllPath);
  const helper = options.fake ? join(root, "helper.js") : undefined;
  probe = new JLinkBackend({ installDir: options.fake ? root : undefined, device, interface: "SWD", speed: 4000 }, new ProcessManager());
  service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: options.fake ? process.execPath : undefined,
    helperArgsPrefix: options.fake ? [helper] : undefined,
  });

  const start = await service.captureStart({ dllPath, device, symbols, requestedRateHz: rateHz, durationSec, readMode: "periodic" });
  if (!start.ok) {
    finalResult = classify({ start });
  } else {
  captureId = start.data.captureId;
  const readiness = await waitForSamples(service, captureId, minSamples, durationSec * 1000 + 2000, pollMs);
  if (!readiness.ready) {
    const stop = await service.captureStop({ captureId });
    finalResult = classify({ start, readiness, stop });
  } else {

  const writePlan = await service.variableWritePlan({ captureId, targetRef: { kind: "scalar", path: target }, value });
  const writeExec = writePlan.ok ? await service.variableWriteExecute({ writePlanId: writePlan.data.writePlanId }) : null;
  const stop = await service.captureStop({ captureId });
  const eventId = writeExec?.data?.eventId;
  const query = eventId ? await service.captureQuery({ captureId, mode: "event_window", eventId, windowBeforeMs: 50, windowAfterMs: 50, includeRawSamples: true, hmC095Profile: !options.fake }) : null;
  const exported = eventId ? await service.captureExport({ captureId, eventAware: true, eventId, windowBeforeMs: 50, windowAfterMs: 50 }) : null;
  finalResult = classify({ start, readiness, writePlan, writeExec, stop, query, exported });
  }
  }
} catch (error) {
  finalResult = {
    overallStatus: "failed",
    writePathStatus: "failed",
    captureQualityStatus: "not_run",
    eventWindowStatus: "not_run",
    csvExportStatus: "not_run",
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  await service?.dispose();
  probe?.dispose();
  if (options.fake && !options.keepFake) await rm(root, { recursive: true, force: true });
}
returnResult(finalResult);

function classify(run) {
  const stopData = run.stop?.data ?? {};
  const writeOk = run.writeExec?.ok === true && run.writeExec.data?.readbackOk === true;
  const readbackMismatch = run.writeExec?.data?.readbackOk === false || (run.writeExec?.data?.mismatches?.length ?? 0) > 0;
  const qualityPass = run.stop?.ok === true
    && stopData.transportStatus === "pass"
    && stopData.dataQualityStatus === "pass"
    && (stopData.quality?.readErrors ?? 0) === 0
    && (stopData.quality?.droppedSamples ?? 0) === 0
    && (stopData.quality?.sampleCount ?? 0) >= minSamples;
  const eventSampleCount = run.query?.data?.eventWindow?.sampleCount ?? 0;
  const eventOk = run.query?.ok === true && eventSampleCount > 0;
  const csvOk = run.exported?.ok === true && (run.exported.data?.rows ?? 0) > 0 && existsSync(run.exported.data?.csvFile ?? "");
  const captureQualityStatus = qualityPass ? "pass" : run.stop ? "fail" : "not_run";
  const eventWindowStatus = eventOk ? "pass" : run.query ? "fail" : "not_run";
  const csvExportStatus = csvOk ? "pass" : run.exported ? "fail" : "not_run";
  const writePathStatus = writeOk ? "pass" : "fail";
  const overallStatus = writePathStatus === "pass" && captureQualityStatus === "pass" && eventWindowStatus === "pass" && csvExportStatus === "pass"
    ? "pass"
    : writePathStatus === "pass" && captureQualityStatus === "fail" ? "blocked_by_capture_quality" : "failed";
  return {
    fake: Boolean(options.fake),
    device,
    target,
    value,
    captureId,
    overallStatus,
    writePathStatus,
    captureQualityStatus,
    eventWindowStatus,
    csvExportStatus,
    readbackMismatch,
    elapsedMs: Date.now() - startedAt,
    artifacts: {
      metadataFile: run.start?.data?.metadataFile,
      csvFile: run.exported?.data?.csvFile,
    },
    diagnostics: {
      readiness: run.readiness,
      write: run.writeExec?.data,
      writeError: run.writeExec?.error ?? run.writePlan?.error,
      captureQuality: stopData.quality,
      transportStatus: stopData.transportStatus,
      dataQualityStatus: stopData.dataQualityStatus,
      failures: stopData.failures,
      helperResult: stopData.helperResult,
      eventWindow: run.query?.data?.eventWindow,
      warnings: [
        ...(run.start?.warnings ?? []),
        ...(run.stop?.warnings ?? []),
        ...(run.query?.warnings ?? []),
        ...(run.query?.data?.warnings ?? []),
        ...(run.exported?.warnings ?? []),
        ...(run.exported?.data?.warnings ?? []),
      ],
    },
  };
}

async function waitForSamples(captureService, id, threshold, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const status = await captureService.captureStatus({ captureId: id });
    lastStatus = status;
    const sampleCount = status.data?.sampleCount ?? 0;
    if (status.ok && sampleCount >= threshold && status.data?.state === "capturing") return { ready: true, sampleCount, status: status.data };
    if (status.data?.state && status.data.state !== "capturing") return { ready: false, reason: "capture ended before write threshold", sampleCount, status: status.data };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ready: false, reason: "sample threshold timeout", status: lastStatus?.data };
}

function returnResult(result) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.overallStatus === "failed" ? 1 : 0);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--fake") parsed.fake = true;
    else if (arg === "--keep-fake") parsed.keepFake = true;
    else if (arg === "--target") parsed.target = args[++index];
    else if (arg === "--value") parsed.value = args[++index];
    else if (arg === "--rate") parsed.rateHz = args[++index];
    else if (arg === "--duration") parsed.durationSec = args[++index];
    else if (arg === "--min-samples") parsed.minSamples = args[++index];
    else if (arg === "--poll-ms") parsed.pollMs = args[++index];
    else if (arg === "--dll") parsed.dllPath = args[++index];
  }
  return parsed;
}

async function writeFakeProject(fakeRoot, dll) {
  await mkdir(join(fakeRoot, "Appl", "Debug", "Exe"), { recursive: true });
  await mkdir(join(fakeRoot, "Appl", "Debug", "List"), { recursive: true });
  await writeFile(join(fakeRoot, "Appl", "Debug", "Exe", "FOC_SCM.out"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]));
  await writeFile(join(fakeRoot, "Appl", "Debug", "List", "FOC_SCM.map"), "Debug_IqRef              0x2000'0000     0x4  Data  Gb  app.o [1]\n", "utf8");
  await mkdir(join(fakeRoot, ".jlink-mcp"), { recursive: true });
  await writeFile(join(fakeRoot, ".jlink-mcp", "policy.json"), JSON.stringify({
    version: 2,
    requireReadback: true,
    variableWriteAllowlist: [{ path: "Debug_IqRef", kind: "scalar", type: "int32", min: -1000, max: 1000, maxWriteOps: 3 }],
  }), "utf8");
  await writeFile(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", "utf8");
  await writeFile(join(fakeRoot, "helper.js"), fakeHelperSource(), "utf8");
}

function fakeHelperSource() {
  return `
const fs = require("fs");
const command = process.argv[2];
if (command === "preflight") { console.log(JSON.stringify({ status: "ok", exportsFound: true })); process.exit(0); }
if (command === "connect-preflight") { console.log(JSON.stringify({ status: "ok", targetWasHalted: false, targetWasHaltedRaw: 0, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false })); process.exit(0); }
if (command === "getcaps") { console.log(JSON.stringify({ status: "ok", caps: { maxBlocks: 16, maxFreq: 1000 } })); process.exit(0); }
const plan = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const records = [];
for (let i = 0; i < plan.requestedRateHz * plan.durationSec; i++) {
  const record = Buffer.alloc(28);
  record.writeBigUInt64LE(BigInt(i), 0);
  record.writeBigInt64LE(BigInt(Math.round(i * 1000000000 / plan.requestedRateHz)), 8);
  record.writeUInt32LE(1, 16);
  record.writeUInt32LE(0, 20);
  record.writeUInt32LE(i, 24);
  records.push(record);
}
fs.writeFileSync(plan.outputFile, Buffer.concat(records));
let valueHex = "00000000";
let targetWritten = false;
function handleWriteRequest() {
  if (!plan.writeRequestFile || !plan.writeResponseFile || !fs.existsSync(plan.writeRequestFile)) return;
  const request = JSON.parse(fs.readFileSync(plan.writeRequestFile, "utf8"));
  fs.rmSync(plan.writeRequestFile, { force: true });
  if (request.op === "read") fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "ok", bytesHex: valueHex }));
  else if (request.op === "write") { valueHex = request.bytesHex; targetWritten = true; fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "ok", writeIssued: true })); }
  else fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "error", reason: "bad op" }));
}
const timer = setInterval(handleWriteRequest, 5);
setTimeout(() => { clearInterval(timer); console.log(JSON.stringify({ status: "ok", captureId: plan.captureId, requestedRateHz: plan.requestedRateHz, actualRateHz: plan.requestedRateHz, durationSec: plan.durationSec, sampleCount: records.length, validSamples: records.length, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, readMode: plan.readMode, resumeBeforeStart: false, resumeIssued: false, targetWasHaltedBeforeResume: false, targetWasHaltedRaw: 0, targetWasHaltedAfterResume: false, targetReset: false, targetWritten, flashIssued: false, resetIssued: false, haltIssued: false, hssSampleHeaderBytes: 4, hssSampleStrideBytes: 8, bytesPerSample: 4, hssBlockCount: 1, readBufferBytes: 4096, firstChangedOffset: 0, firstChangedBytes: "00000000", headerChangedRatio: 1, payloadChangedRatio: 1, payloadFirstChangedOffset: 4, payloadFirstChangedBytes: "01000000" })); }, 1000);
`;
}
