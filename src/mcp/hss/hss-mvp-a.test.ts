import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { ProcessManager } from "../../utils/process-manager";
import { JLinkBackend } from "../../probe/jlink";
import { resolveHssRuntimeIdentity } from "../hss-dll/hss-dll-adapter";
import { appendHssAudit } from "./audit-log";
import { encodeHssRecord } from "./hss-artifact";
import { HssCaptureService } from "./hss-capture-service";
import { HSS_SAFETY_FALSE } from "./hss-contract";
import { hssFail, hssOk } from "./hss-envelope";
import { HSS_ERROR, HssError } from "./hss-errors";
import { HM_C095_HSS_VARIABLES, buildHssCapturePlan } from "./hss-plan";
import { HSS_STATUS_FLAGS } from "./hss-status-flags";
import { ensureHssProjectDirs, resolveInsideProject } from "./project-paths";
import { resolveIarMapSymbols } from "./iar-map-parser";

const FAKE_HSS_DLL_SHA256 = createHash("sha256").update(fakeHssDllBuffer()).digest("hex");
const FAKE_JLINK_SCRIPT_FILE = join(process.cwd(), ".tmp", "approved-hss-reset-fixture.JLinkScript");
const FAKE_JLINK_SCRIPT_CONTENT = "// deterministic trusted HSS ScriptFile fixture\n";
const FAKE_JLINK_SCRIPT_SHA256 = createHash("sha256").update(FAKE_JLINK_SCRIPT_CONTENT).digest("hex");
const FAKE_JLINK_SCRIPT_APPROVAL_SHA256 = createHash("sha256").update(JSON.stringify({
  approvalSource: "project-config",
  path: FAKE_JLINK_SCRIPT_FILE,
  sha256: FAKE_JLINK_SCRIPT_SHA256,
})).digest("hex");
const FAKE_HSS_RUNTIME_IDENTITY_SHA256 = resolveHssRuntimeIdentity({
  selectedDllPath: "JLink_x64.dll",
  sha256: FAKE_HSS_DLL_SHA256,
}, {}, { helperPath: process.execPath, scriptIdentity: {
  path: FAKE_JLINK_SCRIPT_FILE,
  sha256: FAKE_JLINK_SCRIPT_SHA256,
  approvalSha256: FAKE_JLINK_SCRIPT_APPROVAL_SHA256,
  approvalSource: "project-config",
  validated: true,
} }, {
  helperVersion: "1",
  helperProtocolVersion: 1,
  dllVersion: "88400",
}).sha256!;

test("HSS envelope, risk, project paths, status flags, and audit are stable", async () => {
  const root = await tempProject();
  try {
    const ok = hssOk("hss_capture_plan", { value: 1 });
    assert.equal(ok.ok, true);
    assert.equal(ok.risk.level, "R1");
    assert.equal(ok.backend.selected, "jlink-hss");
    const fail = hssFail("hss_capability_probe", new HssError(HSS_ERROR.HSS_HELPER_MISSING, "missing"));
    assert.equal(fail.ok, false);
    assert.equal(fail.risk.level, "R0");
    assert.equal(fail.error?.code, "HSS_HELPER_MISSING");
    assert.deepEqual(HSS_SAFETY_FALSE, { targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false });
    assert.equal(HSS_STATUS_FLAGS.write_nearby, 64);
    if (process.platform === "win32") {
      const helper = join(process.cwd(), "native", "hss-helper", "bin", "hss_helper.exe");
      if (existsSync(helper)) {
        const selfTest = spawnSync(helper, ["self-test"], { encoding: "utf8", windowsHide: true });
        assert.equal(selfTest.status, 0, selfTest.stderr);
        const result = JSON.parse(selfTest.stdout) as { status?: string; recordSemantics?: Record<string, unknown> };
        assert.equal(result.status, "ok");
        assert.deepEqual(result.recordSemantics, {
          normalEmitted: 3,
          gapEmitted: 2,
          duplicateSamples: 1,
          droppedSamples: 1,
          decreasingRejected: true,
        });
      }
    }
    await ensureHssProjectDirs(root);
    assert.throws(() => resolveInsideProject("..\\escape", root), /path escapes/);
    const audit = await appendHssAudit("session", "hss_capture_plan", { a: 1 }, { b: 2 }, root);
    assert.match(await readFile(audit, "utf8"), /hss_capture_plan/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("IAR map fallback resolves HM_C095 symbols and rejects unsafe cases", async () => {
  const root = await tempProject();
  try {
    const map = await writeHmProject(root);
    const symbols = resolveIarMapSymbols(map, HM_C095_HSS_VARIABLES);
    assert.equal(symbols.length, 10);
    assert.equal(symbols[0].address, "0x20006b28");
    assert.equal(symbols[0].type, "uint32");
    await assert.rejects(() => buildHssCapturePlan({ artifactFile: "..\\bad.out" }, root), /path escapes/);
    await assert.rejects(() => buildHssCapturePlan({ symbols: [{ name: "missing", type: "uint32" }] }, root), /symbol not found/);
    await assert.rejects(() => buildHssCapturePlan({ symbols: [{ name: "a->b", type: "uint32" }] }, root), /unsafe selector/);
    await assert.rejects(async () => {
      await writeFile(join(root, "Appl", "Debug", "Exe", "FOC_SCM.out"), ":020000040000FA\n", "utf8");
      await buildHssCapturePlan({}, root);
    }, /not ELF content/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS capture plan resolves one and ten HM_C095 variables without Git", async () => {
  const root = await tempProject();
  try {
    await writeHmProject(root);
    const one = await buildHssCapturePlan({ symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32", alias: "counter" }], requestedRateHz: 1000, durationSec: 3 }, root, true);
    assert.equal(one.symbols[0].alias, "counter");
    assert.equal(one.hmC095.expectedCounterDelta, 16);
    assert.equal(one.sampling.estimatedSamples, 3000);
    assert.equal(one.output.firstSegmentFile.endsWith("capture_0001.bin"), true);
    assert.equal(one.target.targetId, "Z20K146M");
    assert.equal(one.target.source, "project-config");
    assert.equal(one.target.confidence, "project-config");
    const ten = await buildHssCapturePlan({}, root, true);
    assert.equal(ten.symbols.length, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS smoke full10 lets IAR map infer ADC and offset widths", async () => {
  const script = await readFile(join(process.cwd(), "scripts", "hss-hm-c095-smoke.mjs"), "utf8");
  for (const name of ["g_hssDbgRawAdcM1U", "g_hssDbgRawAdcM1V", "g_hssDbgRawAdcM2U", "g_hssDbgRawAdcM2V", "g_hssDbgOffsetM1U", "g_hssDbgOffsetM1V"]) {
    assert.doesNotMatch(script, new RegExp(`${name}", type:`));
  }
  assert.match(script, /counterMonotonic/);
  assert.match(script, /counterChangedRatio/);
});

test("HSS capture rejects an unvalidated DLL before invoking the helper", async () => {
  const root = await tempProject();
  const dll = join(root, "JLink_x64.dll");
  const helper = join(root, "helper.js");
  const marker = join(root, "helper-invoked");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: { HSS_HELPER_MARKER: marker },
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
  });
  try {
    await writeFakeHssDll(dll);
    await mkdir(join(root, ".tmp"), { recursive: true });
    await writeFile(FAKE_JLINK_SCRIPT_FILE, FAKE_JLINK_SCRIPT_CONTENT, "utf8");
    await writeFile(helper, `
      require("fs").writeFileSync(process.env.HSS_HELPER_MARKER, "invoked");
      console.log(JSON.stringify({ status: "ok", caps: { maxBlocks: 1, maxFreq: 1000 } }));
    `, "utf8");
    const start = await service.captureStart({ dllPath: dll, device: "Z20K146M" });
    assert.equal(start.ok, false);
    assert.equal(start.error?.code, "HSS_DLL_IDENTITY_UNVALIDATED");
    assert.equal(existsSync(marker), false);

    if (process.platform === "win32") {
      const nativeHelper = join(process.cwd(), "native", "hss-helper", "bin", "hss_helper.exe");
      const loadedDll = join(root, "load-boundary.dll");
      const nativeScript = join(root, "批准脚本.JLinkScript");
      const planFile = join(root, "load-boundary-plan.json");
      const diagnosticFile = join(root, "load-boundary.diag.json");
      const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      assert.equal(existsSync(nativeHelper), true);
      await copyFile(join(system32, "version.dll"), loadedDll);
      await writeFile(nativeScript, FAKE_JLINK_SCRIPT_CONTENT, "utf8");
      const approvedDllSha256 = createHash("sha256").update(await readFile(loadedDll)).digest("hex");
      const nativeScriptSha256 = createHash("sha256").update(await readFile(nativeScript)).digest("hex");
      const plan = {
        captureId: "load-boundary-fixture",
        dllPath: loadedDll,
        outputFile: join(root, "capture.bin"),
        diagnosticFile,
        device: "fixture-device",
        interface: "SWD",
        speedKhz: 4000,
        requestedRateHz: 1,
        durationSec: 1,
        readMode: "periodic",
        jlinkScriptFile: nativeScript,
        approvedJlinkScriptSha256: nativeScriptSha256,
        symbols: [{ name: "fixture", address: "0x20000000", size: 4 }],
      };
      const invoke = (): Record<string, unknown> => {
        const result = spawnSync(nativeHelper, ["hss-capture", "--plan", planFile], { encoding: "utf8", windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout) as Record<string, unknown>;
      };

      await writeFile(planFile, JSON.stringify({ ...plan, runtimeIdentityValidated: true }), "utf8");
      assert.equal(invoke().errorCode, "HSS_RUNTIME_IDENTITY_UNVALIDATED");
      await writeFile(planFile, JSON.stringify({ ...plan, runtimeIdentityValidated: true, approvedDllSha256: "invalid" }), "utf8");
      assert.equal(invoke().errorCode, "HSS_RUNTIME_IDENTITY_UNVALIDATED");
      await writeFile(planFile, JSON.stringify({ ...plan, runtimeIdentityValidated: false, approvedDllSha256 }), "utf8");
      assert.equal(invoke().errorCode, "HSS_RUNTIME_IDENTITY_UNVALIDATED");

      await writeFile(planFile, JSON.stringify({ ...plan, runtimeIdentityValidated: true, approvedDllSha256 }), "utf8");
      assert.equal(invoke().errorCode, "HSS_EXPORT_MISSING");

      await writeFile(planFile, JSON.stringify({ ...plan, runtimeIdentityValidated: true, approvedDllSha256 }), "utf8");
      await copyFile(join(system32, "winmm.dll"), loadedDll);
      assert.equal(invoke().errorCode, "HSS_RUNTIME_IDENTITY_CHANGED");
      const diagnostic = await readFile(diagnosticFile, "utf8");
      assert.doesNotMatch(diagnostic, /before_jlink_open|before_jlink_connect|before_hss_start/);
    }
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS capture rejects a validated DLL when GetCaps fails", async () => {
  const root = await tempProject();
  const dll = join(root, "JLink_x64.dll");
  const helper = join(root, "helper.js");
  const sha256 = await writeFakeHssDll(dll);
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [sha256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFile(helper, fakeHelperSource({ getCapsOk: false }), "utf8");
    const start = await service.captureStart({ dllPath: dll, device: "Z20K146M" });
    assert.equal(start.ok, false);
    assert.equal(start.error?.code, "HSS_GETCAPS_FAILED");
    assert.equal(probe.getExclusiveOwner(), null);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS capture service starts fake helper, finalizes metadata, queries and exports", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: { JLINK_DLL_PATH: dll },
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");

    const cap = await service.capabilityProbe({ dllPath: dll, device: "Z20K146M", interface: "SWD", speedKhz: 4000 });
    assert.equal(cap.ok, true);
    assert.equal((cap.data?.helper as { exists?: boolean }).exists, true);
    assert.equal((cap.data?.hss as { getCapsValidated?: boolean }).getCapsValidated, true);
    assert.equal((cap.data?.hss as { startReadStopValidated?: boolean }).startReadStopValidated, true);

    const plan = await service.capturePlan({ symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }], requestedRateHz: 1000, durationSec: 1, readMode: "drain" });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.data?.startReady, true);
    assert.equal(plan.data?.readMode, "drain");

    const start = await service.captureStart({ planId: plan.data!.planId, dllPath: dll });
    assert.equal(start.ok, true);
    const helperPlan = JSON.parse(await readFile(plan.data!.output.planFile, "utf8"));
    assert.equal(helperPlan.getCapsValidated, true);
    assert.equal(helperPlan.startReadStopValidated, true);
    assert.equal(helperPlan.runtimeIdentity.validated, true);
    assert.equal(helperPlan.approvedDllSha256, FAKE_HSS_DLL_SHA256);
    assert.equal(helperPlan.runtimeIdentityValidated, true);
    assert.equal(helperPlan.readMode, "drain");
    const captureId = (start.data as { captureId: string }).captureId;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId });
      return Boolean(status.data && (status.data as { state: string }).state === "completed");
    });
    const metadataFile = join(root, ".jlink-mcp", "captures", captureId, "capture.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    assert.equal(metadata.safety.targetReset, false);
    assert.equal(metadata.safety.resumeIssued, false);
    assert.equal(metadata.transportStatus, "pass");
    assert.equal(metadata.dataQualityStatus, "pass");
    assert.equal(metadata.semanticValidationStatus, "pass");
    assert.equal(metadata.payloadValidationStatus, "pass");
    assert.equal(metadata.target.targetId, "Z20K146M");
    assert.equal(metadata.target.source, "project-config");
    assert.equal(metadata.target.confidence, "project-config");
    assert.equal(metadata.sampling.readMode, "drain");
    assert.equal(metadata.layout.payloadAllConstant, false);
    assert.equal(metadata.segments[0].file, "capture_0001.bin");
    assert.equal(metadata.quality.sampleCount, 1000);
    assert.equal(metadata.quality.droppedSamples, 0);
    const helperIdentity = metadata.events.find((event: { helperResult?: Record<string, unknown> }) => event.helperResult)?.helperResult.runtimeIdentity;
    assert.equal(helperIdentity.sha256, FAKE_HSS_RUNTIME_IDENTITY_SHA256);
    assert.equal(probe.getExclusiveOwner(), null);
    const audit = await readAuditText(root);
    assert.match(audit, /capture_terminal/);
    assert.match(audit, /"state":"completed"/);

    const query = await service.captureQuery({ captureId, hmC095Profile: true });
    assert.equal(query.ok, true);
    assert.equal((query.data?.sampling as { readMode?: string }).readMode, "drain");
    assert.equal(query.data?.transportStatus, "pass");
    assert.equal((query.data?.hmC095 as { counterDeltaPass?: boolean }).counterDeltaPass, true);
    assert.equal((query.data?.hmC095 as { counterMonotonic?: boolean }).counterMonotonic, true);
    assert.equal((query.data?.hmC095 as { counterDeltaMean?: number }).counterDeltaMean, 16);
    const rawQuery = await service.captureQuery({ captureId, includeRawSamples: true, maxSamples: 10, hmC095Profile: false });
    assert.match(rawQuery.warnings[0] ?? "", /raw samples decimated from 1000 to 10/);

    await rm(join(root, ".jlink-mcp", "exports"), { recursive: true, force: true });
    const exported = await service.captureExport({ captureId });
    assert.equal(exported.ok, true);
    assert.equal(existsSync((exported.data as { csvFile: string }).csvFile), true);
    assert.equal((exported.data as { readMode?: string }).readMode, "drain");
    assert.match(await readFile((exported.data as { csvFile: string }).csvFile, "utf8"), /sampleIndex,timeSec,timestampTicks,statusFlags,g_hssDbgCounterFocIsr/);
    const exportedAgain = await service.captureExport({ captureId });
    assert.equal(exportedAgain.ok, true);
    assert.notEqual((exportedAgain.data as { csvFile: string }).csvFile, (exported.data as { csvFile: string }).csvFile);
    assert.equal(existsSync((exportedAgain.data as { csvFile: string }).csvFile), true);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS capture plan forwards explicit DLL and connection parameters to capability probe", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "custom", "JLink_x64.dll");
  const argvLog = join(root, "argv.json");
  const probe = new JLinkBackend({ installDir: root, device: "WRONG_DEVICE", interface: "JTAG", speed: 1000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: { HSS_ARGV_LOG: argvLog },
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await mkdir(join(root, "custom"), { recursive: true });
    await writeFakeHssDll(dll);
    await writeFile(helper, argvEchoHelperSource(), "utf8");

    const plan = await service.capturePlan({
      dllPath: dll,
      device: "Z20K146M",
      interface: "SWD",
      speedKhz: 4000,
      serial: "123456789",
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
    });

    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.data?.startReady, true);
    const argv = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    assert.deepEqual(argv, [
      "getcaps",
      "--dll",
      dll,
      "--device",
      "Z20K146M",
      "--interface",
      "SWD",
      "--speed",
      "4000",
      "--serial",
      "123456789",
      "--jlink-script-file",
      FAKE_JLINK_SCRIPT_FILE,
      "--approved-jlink-script-sha256",
      FAKE_JLINK_SCRIPT_SHA256,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resetBeforeCapture binds R3 reset, stabilizes before HSS start, and rejects conflicts or replay", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const orderLog = join(root, "reset-order.log");
  let stateHalted = false;
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: { HSS_ORDER_LOG: orderLog },
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
    cpuControlExecutor: async (input) => {
      const binding = input.binding as Record<string, unknown>;
      assert.equal(input.operation, "reset");
      if (input.resetBeforeCapture !== undefined) assert.equal(input.resetBeforeCapture, true);
      assert.equal(binding.risk, "R3");
      await appendFile(orderLog, "reset\n", "utf8");
      return { status: "ok", targetReset: true, resetIssued: true, beforeState: "running", afterState: "running" };
    },
    targetStateReader: async () => {
      await appendFile(orderLog, "state\n", "utf8");
      return { halted: stateHalted };
    },
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource({ lingerMs: 300 }), "utf8");
    const plan = await service.capturePlan({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
      resetBeforeCapture: true,
      minimumRecoveryMs: 0,
      timeoutMs: 1000,
      pollIntervalMs: 10,
      requiredConsecutiveRunningChecks: 2,
    });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.risk.level, "R3");
    assert.equal(plan.data?.resetOperation?.risk, "R3");
    assert.equal(plan.data?.resetOperation?.targetId, "Z20K146M");
    assert.equal(plan.data?.resetOperation?.artifactSha256, plan.data?.artifact.sha256);
    assert.equal(plan.data?.resetOperation?.consumed, false);

    const start = await service.captureStart({ planId: plan.data!.planId, dllPath: dll });
    assert.equal(start.ok, true, JSON.stringify(start));
    const helperPlan = JSON.parse(await readFile(plan.data!.output.planFile, "utf8")) as Record<string, unknown>;
    assert.equal(helperPlan.resetBeforeCapture, true);
    assert.equal(helperPlan.requireFirstSampleIndexZero, true);
    assert.equal((await service.cpuControl("halt")).error?.code, HSS_ERROR.CAPTURE_CONFLICT);
    assert.equal((await service.cpuControl("reset")).error?.code, HSS_ERROR.CAPTURE_CONFLICT);
    const captureId = (start.data as { captureId: string }).captureId;
    await waitFor(async () => (await service.captureStatus({ captureId })).data?.state === "completed");

    const order = (await readFile(orderLog, "utf8")).trim().split(/\r?\n/);
    assert.deepEqual(order.slice(0, 8), ["getcaps", "target-state", "getcaps", "target-state", "reset", "state", "state", "hss-capture"]);
    const metadata = JSON.parse(await readFile(plan.data!.output.metadataFile, "utf8")) as {
      reset: { status: string };
      safety: { targetReset: boolean };
      events: Array<Record<string, unknown>>;
    };
    assert.equal(metadata.reset.status, "completed");
    assert.equal(metadata.safety.targetReset, true);
    assert.equal(metadata.events.some((event: Record<string, unknown>) => event.type === "target_control" && event.operation === "reset" && event.result === "succeeded"), true);
    assert.equal(metadata.events.some((event: Record<string, unknown>) => event.type === "capture_lifecycle" && event.lifecycleValidated === true), true);
    const replay = await service.captureStart({ planId: plan.data!.planId, dllPath: dll });
    assert.equal(replay.error?.code, HSS_ERROR.RESET_PLAN_ALREADY_EXECUTED);
    assert.equal(replay.risk.level, "R3");
    assert.equal((JSON.parse(await readFile(plan.data!.output.metadataFile, "utf8")) as Record<string, unknown>).state, "completed");

    stateHalted = true;
    const timeoutPlan = await service.capturePlan({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
      resetBeforeCapture: true,
      minimumRecoveryMs: 0,
      timeoutMs: 30,
      pollIntervalMs: 10,
      requiredConsecutiveRunningChecks: 2,
    });
    assert.equal(timeoutPlan.ok, true, JSON.stringify(timeoutPlan));
    const timedOut = await service.captureStart({ planId: timeoutPlan.data!.planId, dllPath: dll });
    assert.equal(timedOut.error?.code, HSS_ERROR.HSS_TARGET_STABILITY_TIMEOUT);
    assert.equal(timedOut.risk.level, "R3");
    const timeoutMetadata = JSON.parse(await readFile(timeoutPlan.data!.output.metadataFile, "utf8")) as { events: Array<Record<string, unknown>> };
    assert.equal(timeoutMetadata.events.some((event: Record<string, unknown>) => event.operation === "reset" && event.result === "failed"), true);
    stateHalted = false;
    const standalone = await service.cpuControl("reset", { halt: true });
    assert.equal(standalone.ok, true, JSON.stringify(standalone));
    assert.equal(standalone.risk.level, "R3");
    assert.equal((standalone.data?.binding as Record<string, unknown>).captureId, "outside-capture");
    assert.deepEqual((standalone.data?.binding as Record<string, unknown>).arguments, { halt: true });
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS capture plan records GetCaps maxFreq without gating requested rate", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource({ maxFreq: 1000 }), "utf8");
    const plan = await service.capturePlan({ dllPath: dll, symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }], requestedRateHz: 8000, durationSec: 1 });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.data?.sampling.requestedRateHz, 8000);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS capture start reports unavailable when GetCaps fails", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource({ getCapsOk: false }), "utf8");

    const start = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
    });
    assert.equal(start.ok, false);
    assert.equal(start.error?.code, "HSS_GETCAPS_FAILED");
    assert.equal(probe.getExclusiveOwner(), null);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HM_C095 validation rejects read-error captures", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource({ readError: true }), "utf8");
    const start = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
    });
    assert.equal(start.ok, true);
    const captureId = (start.data as { captureId: string }).captureId;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId });
      return Boolean(status.data && (status.data as { state: string }).state === "failed");
    });
    const query = await service.captureQuery({ captureId, hmC095Profile: true });
    const hmC095 = query.data?.hmC095 as { counterDeltaPass?: boolean; validSamples?: number; invalidSamples?: number };
    const quality = query.data?.quality as { readErrors?: number };
    assert.equal(hmC095.counterDeltaPass, false);
    assert.equal(hmC095.validSamples, 0);
    assert.equal(hmC095.invalidSamples, 1000);
    assert.equal(quality.readErrors, 1000);
    assert.equal(query.data?.dataQualityStatus, "failed");
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("live HSS status counts read-error records as invalid", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource({ readError: true, lingerMs: 1000 }), "utf8");
    const start = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
    });
    assert.equal(start.ok, true);
    const captureId = (start.data as { captureId: string }).captureId;
    let live: Record<string, unknown> | undefined;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId });
      live = status.data as Record<string, unknown> | undefined;
      return live?.state === "capturing" && live.sampleCount === 1000;
    });
    assert.equal(live?.validSamples, 0);
    assert.equal(live?.readErrors, 1000);
    assert.ok(Number(live?.elapsedSec) > 0.9);
    assert.ok(Number(live?.actualRateHz) > 900);
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId });
      return Boolean(status.data && (status.data as { state: string }).state === "failed");
    });
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS metadata separates transport, payload quality, and HM_C095 semantic failures", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  async function run(options: FakeHelperOptions, input: Parameters<typeof service.captureStart>[0] = {}): Promise<Record<string, unknown>> {
    await writeFile(helper, fakeHelperSource(options), "utf8");
    const start = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
      ...input,
    });
    assert.equal(start.ok, true);
    const data = start.data as { captureId: string; metadataFile: string };
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId: data.captureId });
      return Boolean(status.data && ["completed", "failed"].includes((status.data as { state: string }).state));
    });
    return JSON.parse(await readFile(data.metadataFile, "utf8")) as Record<string, unknown>;
  }
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);

    const zero = await run({ counterMode: "zero" }, { requestedRateHz: 16000 });
    assert.equal(((zero.hmC095 as Record<string, unknown>).counterDeltaMean), 0);
    assert.equal((zero.hmC095 as Record<string, unknown>).counterDeltaPass, false);
    assert.equal(zero.semanticValidationStatus, "failed");

    const constant = await run({ counterMode: "constant" });
    assert.equal((constant.hmC095 as Record<string, unknown>).counterAllConstant, true);
    assert.equal((constant.hmC095 as Record<string, unknown>).counterDeltaPass, false);
    assert.equal(constant.semanticValidationStatus, "failed");
    assert.equal(constant.state, "failed");
    const constantEvents = constant.events as Array<{ helperResult?: Record<string, unknown> }>;
    assert.equal(constantEvents.at(-1)?.helperResult?.errorCode, HSS_ERROR.HSS_SEMANTIC_VALIDATION_FAILED);

    const decreasing = await run({ counterMode: "decreasing" });
    assert.equal((decreasing.hmC095 as Record<string, unknown>).counterMonotonic, false);
    assert.equal(decreasing.semanticValidationStatus, "failed");

    const lifecycle = await run({ lifecycleValidated: false });
    assert.equal(lifecycle.state, "failed");
    const lifecycleEvents = lifecycle.events as Array<{ helperResult?: Record<string, unknown> }>;
    assert.equal(lifecycleEvents.at(-1)?.helperResult?.errorCode, HSS_ERROR.HSS_LIFECYCLE_VALIDATION_FAILED);

    const decoder = await run({ decoderSemanticsValidated: false });
    assert.equal(decoder.state, "failed");
    const decoderEvents = decoder.events as Array<{ helperResult?: Record<string, unknown> }>;
    assert.equal(decoderEvents.at(-1)?.helperResult?.errorCode, HSS_ERROR.HSS_SEMANTIC_VALIDATION_FAILED);

    const readWarning = await run({ readErrorCount: 1 });
    assert.equal(readWarning.state, "failed");
    assert.equal(readWarning.transportStatus, "pass");
    assert.equal(readWarning.dataQualityStatus, "warning");
    const readWarningEvents = readWarning.events as Array<{ helperResult?: Record<string, unknown> }>;
    assert.equal(readWarningEvents.at(-1)?.helperResult?.errorCode, HSS_ERROR.HSS_SEMANTIC_VALIDATION_FAILED);

    const headerOnly = await run({ counterMode: "constant", payloadHeaderOnly: true });
    assert.equal((headerOnly.layout as Record<string, unknown>).headerChangedRatio, 1);
    assert.equal((headerOnly.layout as Record<string, unknown>).payloadChangedRatio, 0);
    assert.equal(headerOnly.payloadValidationStatus, "failed");
    assert.equal((headerOnly.hmC095 as Record<string, unknown>).payloadPass, false);

    const resumed = await run({}, { resumeBeforeStart: true });
    assert.equal((resumed.safety as Record<string, unknown>).resumeIssued, true);
    assert.equal((resumed.targetState as Record<string, unknown>).resumeBeforeStart, true);
    assert.equal((resumed.targetState as Record<string, unknown>).resumeIssued, true);

    const identityChange = await run({ mutateDllAfterCapture: true });
    assert.equal(identityChange.state, "failed");
    const identityEvents = identityChange.events as Array<{ helperResult?: Record<string, unknown> }>;
    assert.equal(identityEvents.at(-1)?.helperResult?.errorCode, HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS outputSubdir is a base directory and core4 diagnostics do not override counter semantics", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const baseDir = join(root, ".jlink-mcp", "custom-captures");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource({ patternConstant: true }), "utf8");

    const firstPlan = await service.capturePlan({ dllPath: dll, outputSubdir: baseDir, requestedRateHz: 4000, durationSec: 1 });
    const secondPlan = await service.capturePlan({ dllPath: dll, outputSubdir: baseDir, requestedRateHz: 4000, durationSec: 1 });
    assert.equal(firstPlan.ok, true, JSON.stringify(firstPlan));
    assert.equal(secondPlan.ok, true, JSON.stringify(secondPlan));
    assert.notEqual(firstPlan.data!.output.outputDir, secondPlan.data!.output.outputDir);
    assert.equal(firstPlan.data!.output.outputDir.startsWith(baseDir), true);

    const start = await service.captureStart({ planId: firstPlan.data!.planId, dllPath: dll });
    const captureId = (start.data as { captureId: string }).captureId;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId });
      return Boolean(status.data && ["completed", "failed"].includes((status.data as { state: string }).state));
    });
    assert.equal(existsSync(firstPlan.data!.output.metadataFile), true);
    assert.equal(existsSync(firstPlan.data!.output.firstSegmentFile), true);
    const query = await service.captureQuery({ captureId, hmC095Profile: true });
    const hmC095 = query.data?.hmC095 as Record<string, unknown>;
    assert.equal(hmC095.transportPass, true);
    assert.equal(hmC095.payloadPass, true);
    assert.equal(hmC095.counterDeltaPass, true);
    assert.equal(hmC095.patternChanges, false);
    assert.equal(hmC095.semanticPass, true);
    assert.equal(query.data?.transportStatus, "pass");
    assert.equal(query.data?.dataQualityStatus, "pass");
    assert.equal(query.data?.semanticValidationStatus, "pass");
    assert.equal(JSON.parse(await readFile(firstPlan.data!.output.metadataFile, "utf8")).state, "completed");
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS export rejects non-terminal capture metadata", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");
    const start = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
    });
    assert.equal(start.ok, true);
    const captureId = (start.data as { captureId: string }).captureId;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId });
      return Boolean(status.data && (status.data as { state: string }).state === "completed");
    });
    const metadataFile = join(root, ".jlink-mcp", "captures", captureId, "capture.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    metadata.state = "capturing";
    await writeFile(metadataFile, JSON.stringify(metadata, null, 2), "utf8");
    const exported = await service.captureExport({ captureId });
    assert.equal(exported.ok, false);
    assert.equal(exported.error?.code, HSS_ERROR.HSS_CAPTURE_NOT_TERMINAL);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS export rejects captureId path traversal", async () => {
  const root = await tempProject();
  const captureId = "..\\evil";
  const metadataFile = join(root, ".jlink-mcp", "captures", "malicious.json");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, { cwd: root });
  try {
    await mkdir(join(root, ".jlink-mcp", "captures"), { recursive: true });
    await writeFile(metadataFile, JSON.stringify({
      version: 1,
      captureId,
      sessionName: "bad",
      projectRoot: root,
      backend: "jlink-hss",
      state: "completed",
      artifact: {},
      target: {},
      probe: {},
      symbols: [{ name: "g_hssDbgCounterFocIsr", address: "0x20000000", size: 4, type: "uint32", source: "iar-map" }],
      sampling: { requestedRateHz: 1000, actualRateHz: 1000, durationSec: 1, timestampSource: "qpc", timestampFrequency: "1000000000" },
      segments: [{ file: "capture_0001.bin", sampleStart: 0, sampleCount: 1, recordSize: 28, crc32: "00000000" }],
      quality: { sampleCount: 1, validSamples: 1, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, targetHaltedSamples: 0, actualRateHz: 1000 },
      events: [],
      warnings: [],
      failures: [],
      safety: HSS_SAFETY_FALSE,
    }), "utf8");
    const exported = await service.captureExport({ captureId, metadataFile });
    assert.equal(exported.ok, false);
    assert.equal(exported.error?.code, HSS_ERROR.PATH_OUTSIDE_CWD);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS status reports stable error for unknown captureId", async () => {
  const root = await tempProject();
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, { cwd: root });
  try {
    const status = await service.captureStatus({ captureId: "missing-capture" });
    assert.equal(status.ok, false);
    assert.equal(status.error?.code, HSS_ERROR.HSS_CAPTURE_NOT_FOUND);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS status and stop reject captureId path traversal", async () => {
  const root = await tempProject();
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, { cwd: root });
  try {
    const status = await service.captureStatus({ captureId: "..\\escape" });
    assert.equal(status.ok, false);
    assert.equal(status.error?.code, HSS_ERROR.PATH_OUTSIDE_CWD);

    const stopped = await service.captureStop({ captureId: "..\\escape" });
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error?.code, HSS_ERROR.PATH_OUTSIDE_CWD);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS stop is idempotent and returns finalized metadata details", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");
    const start = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
    });
    assert.equal(start.ok, true);
    const captureId = (start.data as { captureId: string }).captureId;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId });
      return Boolean(status.data && (status.data as { state: string }).state === "completed");
    });
    const stopped = await service.captureStop({ captureId });
    assert.equal(stopped.ok, true);
    const data = stopped.data as { metadataFile?: string; segments?: Array<{ file: string }>; quality?: { sampleCount: number }; safety?: typeof HSS_SAFETY_FALSE };
    assert.equal(data.metadataFile?.endsWith("capture.json"), true);
    assert.equal(data.segments?.[0]?.file.endsWith("capture_0001.bin"), true);
    assert.equal(data.quality?.sampleCount, 1000);
    assert.deepEqual(data.safety, HSS_SAFETY_FALSE);
    assert.equal(probe.getExclusiveOwner(), null);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS capture start rejects halted preflight", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeHmProject(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");

    const start = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
    });
    assert.equal(start.ok, true);
    const captureId = (start.data as { captureId: string }).captureId;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId });
      return Boolean(status.data && (status.data as { state: string }).state === "completed");
    });

    await writeFile(helper, fakeHelperSource({ targetWasHalted: true }), "utf8");
    const halted = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
    });
    assert.equal(halted.ok, false);
    assert.equal(halted.error?.code, HSS_ERROR.HSS_TARGET_HALTED);

    const resumed = await service.captureStart({
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 1000,
      durationSec: 1,
      resumeBeforeStart: true,
    });
    assert.equal(resumed.ok, true);
    assert.match(resumed.warnings.join("\n"), /explicitly resumed/);
    const resumedCaptureId = (resumed.data as { captureId: string }).captureId;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId: resumedCaptureId });
      return Boolean(status.data && (status.data as { state: string }).state === "completed");
    });
    assert.equal(probe.getExclusiveOwner(), null);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-mvp-a-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function writeFakeHssDll(file: string): Promise<string> {
  const data = fakeHssDllBuffer();
  await writeFile(file, data);
  return FAKE_HSS_DLL_SHA256;
}

function fakeHssDllBuffer(): Buffer {
  const data = Buffer.alloc(1024);
  data.write("MZ", 0, "ascii");
  data.writeUInt32LE(0x80, 0x3c);
  data.write("PE\0\0", 0x80, "ascii");
  data.writeUInt16LE(0x8664, 0x84);
  data.write("JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", 0x100, "ascii");
  return data;
}

async function writeHmProject(root: string): Promise<string> {
  const exe = join(root, "Appl", "Debug", "Exe");
  const list = join(root, "Appl", "Debug", "List");
  await mkdir(exe, { recursive: true });
  await mkdir(list, { recursive: true });
  await mkdir(join(root, ".jlink-mcp"), { recursive: true });
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
  await writeFile(FAKE_JLINK_SCRIPT_FILE, FAKE_JLINK_SCRIPT_CONTENT, "utf8");
  await writeFile(join(root, ".jlink-mcp", "hss-script-approval.json"), JSON.stringify({ path: FAKE_JLINK_SCRIPT_FILE, sha256: FAKE_JLINK_SCRIPT_SHA256 }), "utf8");
  await writeFile(join(root, ".jlink-mcp", "policy.json"), JSON.stringify({ version: 2, requireReadback: true, allowBurstWrite: false, defaultMaxWritesScope: "capture", variableWriteAllowlist: [] }), "utf8");
  await writeFile(join(root, "Appl", "FOC_SCM.ewp"), "<project><option><name>OGChipSelectEditMenu</name><state>Z20K146M ZhiXin Z20K146M</state></option></project>", "utf8");
  await writeFile(join(exe, "FOC_SCM.out"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]));
  const map = join(list, "FOC_SCM.map");
  await writeFile(map, [
    "g_hssDbgCounterFocIsr   0x2000'6b28     0x4  Data  Gb  AppCurrentSense.o [1]",
    "g_hssDbgSawFocIsr       0x2000'6b2c     0x2  Data  Gb  AppCurrentSense.o [1]",
    "g_hssDbgToggleFocIsr    0x2000'6b30     0x4  Data  Gb  AppCurrentSense.o [1]",
    "g_hssDbgPatternFocIsr   0x2000'0800     0x4  Data  Gb  AppCurrentSense.o [1]",
    "g_hssDbgRawAdcM1U       0x2000'6b34     0x2  Data  Gb  AppCurrentSense.o [1]",
    "g_hssDbgRawAdcM1V       0x2000'6b38     0x2  Data  Gb  AppCurrentSense.o [1]",
    "g_hssDbgRawAdcM2U       0x2000'6b3c     0x2  Data  Gb  AppCurrentSense.o [1]",
    "g_hssDbgRawAdcM2V       0x2000'6b40     0x2  Data  Gb  AppCurrentSense.o [1]",
    "g_hssDbgOffsetM1U       0x2000'6c00     0x2  Data  Gb  AppCurrentSense.o [1]",
    "g_hssDbgOffsetM1V       0x2000'6c02     0x2  Data  Gb  AppCurrentSense.o [1]",
  ].join("\n"), "utf8");
  return map;
}

interface FakeHelperOptions {
  getCapsOk?: boolean;
  maxFreq?: number;
  targetWasHalted?: boolean;
  readError?: boolean;
  readErrorCount?: number;
  helperOkWithReadErrors?: boolean;
  counterMode?: "expected" | "zero" | "constant" | "decreasing";
  patternConstant?: boolean;
  payloadHeaderOnly?: boolean;
  lingerMs?: number;
  lifecycleValidated?: boolean;
  decoderSemanticsValidated?: boolean;
  mutateDllAfterCapture?: boolean;
}

function fakeHelperSource(options: FakeHelperOptions = {}): string {
  const getCapsOk = options.getCapsOk ?? true;
  const maxFreq = options.maxFreq ?? 16000;
  const targetWasHalted = options.targetWasHalted ?? false;
  const counterMode = options.counterMode ?? "expected";
  const readErrorCount = options.readError ? "totalSamples" : String(options.readErrorCount ?? 0);
  const helperStatus = options.readError && !options.helperOkWithReadErrors ? "error" : "ok";
  const helperError = options.readError ? 'errorCode: "HSS_READ_FAILED", reason: "JLINK_HSS_Read produced no valid samples",' : "";
  return `
const fs = require("fs");
const command = process.argv[2];
const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
if (command === "version") {
  console.log(JSON.stringify({ status: "ok", helperVersion: "1", helperProtocolVersion: 1 }));
  process.exit(0);
}
if (command === "preflight") {
  console.log(JSON.stringify({ status: "ok", exportsFound: true, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1 }));
  process.exit(0);
}
if (command === "connect-preflight") {
  console.log(JSON.stringify({ status: "ok", targetWasHalted: ${targetWasHalted ? "true" : "false"}, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false }));
  process.exit(0);
}
if (command === "target-state") {
  if (process.env.HSS_ORDER_LOG) fs.appendFileSync(process.env.HSS_ORDER_LOG, "target-state\\n");
  console.log(JSON.stringify({ status: "ok", operation: "target-state", dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1, targetWasHalted: ${targetWasHalted ? "true" : "false"}, targetWasHaltedRaw: ${targetWasHalted ? "1" : "0"}, beforeState: ${targetWasHalted ? '"halted"' : '"running"'}, afterState: ${targetWasHalted ? '"halted"' : '"running"'}, jlinkScriptFile: option("--jlink-script-file"), jlinkScriptSha256: option("--approved-jlink-script-sha256"), jlinkScriptReturnCode: 0, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false }));
  process.exit(0);
}
if (command === "getcaps") {
  if (process.env.HSS_ORDER_LOG) fs.appendFileSync(process.env.HSS_ORDER_LOG, "getcaps\\n");
  console.log(JSON.stringify(${getCapsOk ? `{ status: "ok", returnCode: 0, caps: { maxBlocks: 16, maxFreq: ${maxFreq} }, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1, jlinkScriptFile: option("--jlink-script-file"), jlinkScriptSha256: option("--approved-jlink-script-sha256"), jlinkScriptReturnCode: 0 }` : "{ status: \"error\", errorCode: \"HSS_HELPER_TIMEOUT\", reason: \"GetCaps failed\" }"}));
  process.exit(0);
}
if (command !== "hss-capture") {
  console.log(JSON.stringify({ status: "error", errorCode: "BAD_COMMAND", targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false }));
  process.exit(0);
}
if (process.env.HSS_ORDER_LOG) fs.appendFileSync(process.env.HSS_ORDER_LOG, "hss-capture\\n");
const plan = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const records = [];
const symbolCount = plan.symbols.length;
const totalSamples = plan.requestedRateHz * plan.durationSec;
const readErrorCount = ${readErrorCount};
const expectedDelta = Math.max(1, Math.round(16000 / plan.requestedRateHz));
function counterValue(i) {
  if ("${counterMode}" === "zero") return 0;
  if ("${counterMode}" === "constant") return 7;
  if ("${counterMode}" === "decreasing") return totalSamples - i;
  return i * expectedDelta;
}
function valueFor(symbol, i) {
  const counter = counterValue(i);
  if (symbol.name === "g_hssDbgCounterFocIsr") return counter;
  if (symbol.name === "g_hssDbgSawFocIsr") return counter & 0xffff;
  if (symbol.name === "g_hssDbgToggleFocIsr") return counter & 1;
  if (symbol.name === "g_hssDbgPatternFocIsr") return ${options.patternConstant ? "0x12345678" : "(0xa5a50000 ^ i)"};
  if (symbol.name.startsWith("g_hssDbgRawAdc")) return 100 + (i & 3);
  if (symbol.name.startsWith("g_hssDbgOffset")) return 2048;
  return counter;
}
for (let i = 0; i < totalSamples; i++) {
  const record = Buffer.alloc(24 + symbolCount * 4);
  record.writeBigUInt64LE(BigInt(i), 0);
  record.writeBigInt64LE(BigInt(Math.round(i * 1000000000 / plan.requestedRateHz)), 8);
  const flags = i < readErrorCount ? ${HSS_STATUS_FLAGS.read_error} : ${HSS_STATUS_FLAGS.valid};
  record.writeUInt32LE(flags, 16);
  record.writeUInt32LE(0, 20);
  for (let symbolIndex = 0; symbolIndex < symbolCount; symbolIndex++) {
    record.writeUInt32LE(valueFor(plan.symbols[symbolIndex], i) >>> 0, 24 + symbolIndex * 4);
  }
  records.push(record);
}
fs.writeFileSync(plan.outputFile, Buffer.concat(records));
if (${options.mutateDllAfterCapture ? "true" : "false"}) fs.appendFileSync(plan.dllPath, "identity-changed");
const validSamples = records.length - readErrorCount;
const payloadChangedRatio = ${options.payloadHeaderOnly ? "0" : "validSamples > 1 ? 1 : 0"};
const result = { status: "${helperStatus}", ${helperError} helperVersion: "1", helperProtocolVersion: 1, dllVersion: 88400, lifecycleValidated: ${options.lifecycleValidated === false ? "false" : "true"}, decoderSemanticsValidated: ${options.decoderSemanticsValidated === false ? "false" : "true"}, jlinkScriptFile: plan.jlinkScriptFile, jlinkScriptSha256: plan.approvedJlinkScriptSha256, jlinkScriptReturnCode: 0, captureId: plan.captureId, requestedRateHz: plan.requestedRateHz, actualRateHz: plan.requestedRateHz, durationSec: plan.durationSec, sampleCount: records.length, validSamples, emittedSamples: records.length, duplicateSamples: 0, missingSamples: 0, readErrors: readErrorCount, timeouts: 0, overflows: 0, droppedSamples: 0, readMode: plan.readMode, resumeBeforeStart: plan.resumeBeforeStart === true, resumeIssued: plan.resumeBeforeStart === true, targetWasHaltedBeforeResume: ${targetWasHalted ? "true" : "false"}, targetWasHaltedAfterResume: false, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, hssSampleHeaderBytes: 4, hssSampleStrideBytes: 4 + symbolCount * 4, bytesPerSample: symbolCount * 4, hssBlockCount: Math.min(3, symbolCount), readBufferBytes: 4096, firstChangedOffset: 0, firstChangedBytes: "00000000", headerChangedRatio: records.length > 1 ? 1 : 0, payloadChangedRatio, payloadFirstChangedOffset: payloadChangedRatio > 0 ? 4 : -1, payloadFirstChangedBytes: payloadChangedRatio > 0 ? "01000000" : "" };
result.resetBeforeCapture = plan.resetBeforeCapture === true;
const finish = () => console.log(JSON.stringify(result));
${options.lingerMs ? `setTimeout(finish, ${options.lingerMs});` : "finish();"}
`;
}

function argvEchoHelperSource(): string {
  return `
const fs = require("fs");
const command = process.argv[2];
const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
if (command === "version") {
  console.log(JSON.stringify({ status: "ok", helperVersion: "1", helperProtocolVersion: 1 }));
  process.exit(0);
}
if (command === "preflight") {
  console.log(JSON.stringify({ status: "ok", helperExists: true, exportsFound: true, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1 }));
  process.exit(0);
}
if (command === "connect-preflight") {
  console.log(JSON.stringify({ status: "ok", targetWasHalted: false, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false }));
  process.exit(0);
}
if (command === "target-state") {
  console.log(JSON.stringify({ status: "ok", operation: "target-state", dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1, targetWasHalted: false, targetWasHaltedRaw: 0, beforeState: "running", afterState: "running", jlinkScriptFile: option("--jlink-script-file"), jlinkScriptSha256: option("--approved-jlink-script-sha256"), jlinkScriptReturnCode: 0, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false }));
  process.exit(0);
}
if (command === "getcaps") {
  if (process.env.HSS_ARGV_LOG) fs.writeFileSync(process.env.HSS_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ status: "ok", argv: process.argv.slice(2), returnCode: 0, caps: { maxBlocks: 10, maxFreq: 1000 }, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1, jlinkScriptFile: option("--jlink-script-file"), jlinkScriptSha256: option("--approved-jlink-script-sha256"), jlinkScriptReturnCode: 0 }));
  process.exit(0);
}
console.log(JSON.stringify({ status: "error", errorCode: "BAD_COMMAND" }));
`;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("condition timed out");
}

async function readAuditText(root: string): Promise<string> {
  const auditRoot = join(root, ".jlink-mcp", "audit");
  const sessions = await readdir(auditRoot);
  const chunks = await Promise.all(sessions.map((session) => readFile(join(auditRoot, session, "audit.jsonl"), "utf8").catch(() => "")));
  return chunks.join("\n");
}

void encodeHssRecord;

