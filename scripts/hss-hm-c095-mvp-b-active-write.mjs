#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JLinkBackend } from "../out/probe/jlink.js";
import { ProcessManager } from "../out/utils/process-manager.js";
import { HssCaptureService } from "../out/mcp/hss/hss-capture-service.js";
import { resolveHssRuntimeIdentity, resolveHssScriptIdentity } from "../out/mcp/hss-dll/hss-dll-adapter.js";

const options = parseArgs(process.argv.slice(2));
const device = options.device ?? process.env.JLINK_DEVICE ?? (options.fake ? "Z20K146M" : undefined);
if (!device) {
  console.error("active write requires --device or JLINK_DEVICE");
  process.exit(2);
}

const root = options.fake
  ? join(process.cwd(), ".tmp", `hss-active-write-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  : process.cwd();
const storageRoot = options.fake ? `${root}-storage` : undefined;
const evidenceRoot = options.fake ? `${root}-evidence` : undefined;
const target = options.target ?? (options.fake ? "Debug_IqRef" : "g_hssDbgWriteProbe");
const value = Number(options.value ?? 1);
const rateHz = Number(options.rateHz ?? 100);
const durationSec = Number(options.durationSec ?? 3);
const minSamples = Number(options.minSamples ?? 10);
const pollMs = Number(options.pollMs ?? 100);
const preWriteMs = Number(options.preWriteMs ?? 150);
const postWriteMs = Number(options.postWriteMs ?? 300);
const dllPath = options.dllPath ?? (options.fake ? join(root, "JLink_x64.dll") : undefined);
const symbols = options.fake
  ? [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }]
  : undefined;

if (!Number.isFinite(value) || !Number.isInteger(rateHz) || rateHz < 1 || !Number.isInteger(durationSec) || durationSec < 1 || !Number.isInteger(minSamples) || minSamples < 1 || !Number.isInteger(preWriteMs) || preWriteMs < 0 || !Number.isInteger(postWriteMs) || postWriteMs < 0) {
  console.error("value/rateHz/durationSec/minSamples/preWriteMs/postWriteMs are invalid");
  process.exit(2);
}

let probe;
let service;
let captureId;
let finalResult;
const startedAt = Date.now();
try {
  const fakeProject = options.fake ? await writeFakeProject(root, dllPath) : undefined;
  const fakeDllSha256 = fakeProject?.dllSha256;
  const fakeScriptIdentity = fakeProject ? resolveHssScriptIdentity({
    jlinkScriptFile: fakeProject.scriptPath,
    approvedJlinkScriptSha256: fakeProject.scriptSha256,
  }, {}, {
    cwd: root,
    validatedJlinkScriptSha256: [fakeProject.scriptSha256],
  }) : undefined;
  const fakeRuntimeIdentitySha256 = fakeDllSha256 && fakeScriptIdentity?.validated ? resolveHssRuntimeIdentity({
    selectedDllPath: dllPath,
    sha256: fakeDllSha256,
  }, {}, { helperPath: process.execPath, scriptIdentity: fakeScriptIdentity }, {
    helperVersion: "1",
    helperProtocolVersion: 1,
    dllVersion: "88400",
  }).sha256 : undefined;
  const helper = options.fake ? join(root, "helper.js") : undefined;
  probe = new JLinkBackend({ installDir: options.fake ? root : undefined, device, interface: "SWD", speed: 4000 }, new ProcessManager());
  service = new HssCaptureService(probe, {
    cwd: root,
    env: options.fake ? {} : process.env,
    helperPath: options.fake ? process.execPath : undefined,
    helperArgsPrefix: options.fake ? [helper] : undefined,
    storageRoot,
    evidenceRoot,
    validatedDllSha256: fakeDllSha256 ? [fakeDllSha256] : undefined,
    validatedRuntimeIdentitySha256: fakeRuntimeIdentitySha256 ? [fakeRuntimeIdentitySha256] : undefined,
    validatedJlinkScriptSha256: fakeProject ? [fakeProject.scriptSha256] : undefined,
  });

  const start = await service.captureStart({
    dllPath,
    device,
    symbols,
    requestedRateHz: rateHz,
    durationSec,
    readMode: "periodic",
    jlinkScriptFile: fakeProject?.scriptPath,
    approvedJlinkScriptSha256: fakeProject?.scriptSha256,
  });
  if (!start.ok) {
    finalResult = classify({ start });
  } else {
  captureId = start.data.captureId;
  const readiness = await waitForSamples(service, captureId, minSamples, durationSec * 1000 + 2000, pollMs);
  if (!readiness.ready) {
    const stop = await service.captureStop({ captureId });
    finalResult = classify({ start, readiness, stop });
  } else {

  if (preWriteMs > 0) await new Promise((resolve) => setTimeout(resolve, preWriteMs));
  const writePlan = await service.variableWritePlan({ captureId, targetRef: { kind: "scalar", path: target }, value });
  const writeExec = writePlan.ok ? await service.variableWriteExecute({ writePlanId: writePlan.data.writePlanId }) : null;
  if (postWriteMs > 0) await new Promise((resolve) => setTimeout(resolve, postWriteMs));
  const stop = await service.captureStop({ captureId });
  const eventId = writeExec?.data?.eventId;
  const query = eventId ? await service.captureQuery({ captureId, mode: "event_window", eventId, variables: ["g_hssDbgCounterFocIsr"], windowBeforeMs: 100, windowAfterMs: 100, buckets: 20 }) : null;
  const exported = eventId ? await service.captureExport({ captureId }) : null;
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
  if (options.fake && !options.keepFake) {
    await Promise.all([root, storageRoot, evidenceRoot].map((path) => rm(path, { recursive: true, force: true })));
  }
}
returnResult(finalResult);

function classify(run) {
  const stopData = run.stop?.data ?? {};
  const writeOk = run.writeExec?.ok === true && run.writeExec.data?.readbackOk === true;
  const readbackMismatch = run.writeExec?.data?.readbackOk === false || (run.writeExec?.data?.mismatches?.length ?? 0) > 0;
  const qualityPass = run.stop?.ok === true && (stopData.sampleCount ?? 0) >= minSamples;
  const eventWindow = run.query?.data;
  const eventSampleCount = eventWindow?.series?.series?.length ?? 0;
  const beforeSampleCount = eventSampleCount;
  const afterSampleCount = eventSampleCount;
  const deltaAvailable = eventSampleCount > 0;
  const eventOk = run.query?.ok === true && eventSampleCount > 0 && eventWindow?.event?.eventId === run.writeExec?.data?.eventId;
  const csvOk = run.exported?.ok === true && (run.exported.data?.rows ?? 0) > 0 && existsSync(run.exported.data?.exportFile ?? "");
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
    timing: {
      rateHz,
      durationSec,
      minSamples,
      pollMs,
      preWriteMs,
      postWriteMs,
    },
    overallStatus,
    writePathStatus,
    captureQualityStatus,
    eventWindowStatus,
    csvExportStatus,
    readbackMismatch,
    write: {
      planOk: run.writePlan?.ok === true,
      executeOk: run.writeExec?.ok === true,
      readbackOk: run.writeExec?.data?.readbackOk === true,
      eventId: run.writeExec?.data?.eventId,
    },
    capture: {
      state: stopData.captureState,
      sampleCount: stopData.sampleCount ?? 0,
      readErrors: 0,
      timeouts: 0,
      droppedSamples: 0,
      actualRateHz: rateHz,
    },
    eventWindow: {
      beforeSampleCount,
      afterSampleCount,
      deltaAvailable,
      warnings: eventWindow?.quality?.warnings ?? [],
    },
    elapsedMs: Date.now() - startedAt,
    artifacts: {
      packageDir: run.start?.data?.packageDir,
      csvFile: run.exported?.data?.exportFile,
    },
    diagnostics: {
      readiness: run.readiness,
      write: run.writeExec?.data,
      writeError: run.writeExec?.error ?? run.writePlan?.error,
      captureQuality: { sampleCount: stopData.sampleCount },
      eventWindow,
      warnings: [...new Set([
        ...(run.start?.warnings ?? []),
        ...(run.stop?.warnings ?? []),
        ...(run.query?.warnings ?? []),
        ...(run.query?.data?.warnings ?? []),
        ...(run.exported?.warnings ?? []),
        ...(run.exported?.data?.warnings ?? []),
      ])],
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
    if (status.ok && ["active", "capturing"].includes(status.data?.state)) return { ready: true, sampleCount, status: status.data };
    if (status.data?.state && !["planned", "active", "capturing"].includes(status.data.state)) return { ready: false, reason: "capture ended before write threshold", sampleCount, status: status.data };
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
    else if (arg === "--pre-write-ms") parsed.preWriteMs = args[++index];
    else if (arg === "--post-write-ms") parsed.postWriteMs = args[++index];
    else if (arg === "--dll") parsed.dllPath = args[++index];
    else if (arg === "--device") parsed.device = args[++index];
  }
  return parsed;
}

async function writeFakeProject(fakeRoot, dll) {
  const exe = join(fakeRoot, "Appl", "Debug", "Exe");
  const list = join(fakeRoot, "Appl", "Debug", "List");
  const bsw = join(fakeRoot, "Appl", "Source", "BSW", "Src");
  await mkdir(exe, { recursive: true });
  await mkdir(list, { recursive: true });
  await mkdir(join(fakeRoot, "EB_Project", "config"), { recursive: true });
  await mkdir(bsw, { recursive: true });
  await writeFile(join(fakeRoot, "Appl", "Debug", "Exe", "FOC_SCM.out"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]));
  await writeFile(join(list, "FOC_SCM.map"), [
    "g_hssDbgCounterFocIsr   0x2000'0100     0x4  Data  Gb  app.o [1]",
    "Debug_IqRef              0x2000'0000     0x4  Data  Gb  app.o [1]",
  ].join("\n"), "utf8");
  await Promise.all([
    writeFile(join(fakeRoot, "EB_Project", "config", "Mcu.xdm"), '<d McuFOSCClockFrequency value="40000000"/>', "utf8"),
    writeFile(join(bsw, "Parcc_Drv_PBcfg.c"), "Start of PARCC_MCPWM1 clock divider (Parcc_Drv_ClockDividerType)1U\nStart of PARCC_TDG1 clock divider (Parcc_Drv_ClockDividerType)1U", "utf8"),
    writeFile(join(bsw, "Mcpwm_Pwm_Drv_PBcfg.c"), "Pwm_Drv_I1_Counter0_Cfg = { .PwmPeriod = 625U };\nPwm_Drv_Inst1_Cfg = { .ClkDiv = MCPWM_PWM_DRV_CLK_DIVIDE_1 };\nMCPWM_PWM_DRV_MODE_COMBINE_SYM_CENTER_ALIGNED", "utf8"),
    writeFile(join(bsw, "Tdg_Adc_Drv_PBcfg.c"), "DelayOutputConfig_Group1_Channel0 = { TDG_ADC_DRV_DELAY_OUTPUT_0, 1238U };\nTdg_Adc_Drv_Config_1 = { (Tdg_Adc_Drv_ClockDivideType)1U, 1241U, /* ModulateValue */ };\nTdg_Adc_Drv_GroupConfig_1 = { (boolean)FALSE };", "utf8"),
    writeFile(join(bsw, "Tmu_Drv_Cfg.c"), "TMU_DRV_INPUT_CHANNEL_MCPWM1_INIT_TRIG0, TMU_DRV_OUTPUT_CHANNEL_TDG1_TRIG_IN", "utf8"),
  ]);
  await mkdir(join(fakeRoot, ".jlink-mcp"), { recursive: true });
  await writeFile(join(fakeRoot, ".jlink-mcp", "policy.json"), JSON.stringify({
    version: 2,
    requireReadback: true,
    variableWriteAllowlist: [{ path: "Debug_IqRef", kind: "scalar", type: "int32", min: -1000, max: 1000, maxWriteOps: 3 }],
  }), "utf8");
  const scriptPath = join(fakeRoot, "approved-hss-mvp-b.JLinkScript");
  const scriptSha256 = createHash("sha256").update("// deterministic trusted MVP-B ScriptFile fixture\n").digest("hex");
  await writeFile(scriptPath, "// deterministic trusted MVP-B ScriptFile fixture\n", "utf8");
  const fakeDll = fakeHssDllBuffer();
  await writeFile(dll, fakeDll);
  await writeFile(join(fakeRoot, "helper.js"), fakeHelperSource(), "utf8");
  return { dllSha256: createHash("sha256").update(fakeDll).digest("hex"), scriptPath, scriptSha256 };
}

function fakeHssDllBuffer() {
  const data = Buffer.alloc(1024);
  data.write("MZ", 0, "ascii");
  data.writeUInt32LE(0x80, 0x3c);
  data.write("PE\0\0", 0x80, "ascii");
  data.writeUInt16LE(0x8664, 0x84);
  data.write("JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", 0x100, "ascii");
  return data;
}

function fakeHelperSource() {
  return `
const fs = require("fs");
const crypto = require("crypto");
const command = process.argv[2];
if (command === "version") { console.log(JSON.stringify({ status: "ok", helperVersion: "1", helperProtocolVersion: 1 })); process.exit(0); }
if (command === "preflight") { console.log(JSON.stringify({ status: "ok", exportsFound: true, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1 })); process.exit(0); }
if (command === "connect-preflight") { console.log(JSON.stringify({ status: "ok", targetWasHalted: false, targetWasHaltedRaw: 0, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false })); process.exit(0); }
function option(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
if (command === "getcaps") { console.log(JSON.stringify({ status: "ok", returnCode: 0, caps: { maxBlocks: 16, maxFreq: 1000 }, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1, jlinkScriptMode: option("--jlink-script-mode"), jlinkScriptFile: option("--jlink-script-file"), jlinkScriptSha256: option("--approved-jlink-script-sha256"), jlinkScriptReturnCode: 0 })); process.exit(0); }
if (command === "qpc-timebase") { console.log(JSON.stringify({ status: "ok", qpcCounter: "100000", qpcFrequency: "1000000" })); process.exit(0); }
const plan = JSON.parse(fs.readFileSync(option("--plan"), "utf8"));
const records = [];
function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.from(JSON.stringify({ formatVersion: 0, status: "experimental", kind: "sample", payloadEncoding: "json", payloadBytes: payload.length, payloadSha256: crypto.createHash("sha256").update(payload).digest("hex") }) + "\\n");
  return Buffer.concat([header, payload, Buffer.from("\\n")]);
}
for (let i = 0; i < Math.min(plan.requestedRateHz * plan.durationSec, 20); i++) {
  records.push(frame({ sampleIndex: i, tick: String(Math.round(i * 1000000000 / plan.requestedRateHz)), statusFlags: 1, values: { g_hssDbgCounterFocIsr: i * Math.max(1, Math.round(plan.postConnectExpectedRateHz / plan.requestedRateHz)) } }));
}
fs.writeFileSync(plan.outputFile, Buffer.concat(records));
console.log(JSON.stringify({ record: "lifecycle", phase: "qpc_epoch", captureId: plan.captureId, qpcCounter: "100000", qpcEpochCounter: plan.qpcEpochCounter, qpcFrequency: plan.qpcFrequency }));
console.log(JSON.stringify({ record: "lifecycle", phase: "hss_start", captureId: plan.captureId, qpcCounter: "100001", returnCode: 0, crashed: false }));
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
setTimeout(() => {
  clearInterval(timer);
  console.log(JSON.stringify({ record: "lifecycle", phase: "hss_stop", captureId: plan.captureId, qpcCounter: "100002", returnCode: 0, crashed: false }));
  console.log(JSON.stringify({ record: "result", status: "ok", helperVersion: "1", helperProtocolVersion: 1, dllVersion: 88400, lifecycleValidated: true, decoderSemanticsValidated: true, jlinkScriptMode: plan.jlinkScriptMode, jlinkScriptFile: plan.jlinkScriptFile, jlinkScriptSha256: plan.approvedJlinkScriptSha256, jlinkScriptReturnCode: 0, resetBeforeCapture: plan.resetBeforeCapture === true, captureId: plan.captureId, qpcEpochCounter: plan.qpcEpochCounter, qpcFrequency: plan.qpcFrequency, rawClosed: true, samplesSha256: crypto.createHash("sha256").update(Buffer.concat(records)).digest("hex"), requestedRateHz: plan.requestedRateHz, actualRateHz: plan.requestedRateHz, durationSec: plan.durationSec, sampleCount: records.length, validSamples: records.length, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, readMode: plan.readMode, resumeBeforeStart: false, resumeIssued: false, targetWasHaltedBeforeResume: false, targetWasHaltedAfterResume: false, targetReset: false, targetWritten, flashIssued: false, resetIssued: false, haltIssued: false }));
}, 1000);
`;
}
