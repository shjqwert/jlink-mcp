import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ProcessManager } from "../../utils/process-manager";
import { JLinkBackend } from "../../probe/jlink";
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
    assert.deepEqual(HSS_SAFETY_FALSE, { targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false });
    assert.equal(HSS_STATUS_FLAGS.write_nearby, 64);
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
    const ten = await buildHssCapturePlan({}, root, true);
    assert.equal(ten.symbols.length, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS capture service starts fake helper, finalizes metadata, queries and exports", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
  });
  try {
    await writeHmProject(root);
    await writeFile(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", "utf8");
    await writeFile(helper, fakeHelperSource(), "utf8");

    const cap = await service.capabilityProbe({ dllPath: dll, device: "Z20K146MC", interface: "SWD", speedKhz: 4000 });
    assert.equal(cap.ok, true);
    assert.equal((cap.data?.helper as { exists?: boolean }).exists, true);

    const plan = await service.capturePlan({ symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }], requestedRateHz: 1000, durationSec: 1 });
    assert.equal(plan.ok, true);
    assert.equal(plan.data?.startReady, true);

    const start = await service.captureStart({ planId: plan.data!.planId, dllPath: dll });
    assert.equal(start.ok, true);
    const captureId = (start.data as { captureId: string }).captureId;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId });
      return Boolean(status.data && (status.data as { state: string }).state === "completed");
    });
    const metadataFile = join(root, ".jlink-mcp", "captures", captureId, "capture.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    assert.equal(metadata.safety.targetReset, false);
    assert.equal(metadata.segments[0].file, "capture_0001.bin");
    assert.equal(metadata.quality.sampleCount, 1000);
    assert.equal(probe.getExclusiveOwner(), null);
    const audit = await readAuditText(root);
    assert.match(audit, /capture_terminal/);
    assert.match(audit, /"state":"completed"/);

    const query = await service.captureQuery({ captureId, hmC095Profile: true });
    assert.equal(query.ok, true);
    assert.equal((query.data?.hmC095 as { counterDeltaPass?: boolean }).counterDeltaPass, true);
    assert.equal((query.data?.hmC095 as { counterDeltaMean?: number }).counterDeltaMean, 16);

    const exported = await service.captureExport({ captureId });
    assert.equal(exported.ok, true);
    assert.equal(existsSync((exported.data as { csvFile: string }).csvFile), true);
    assert.match(await readFile((exported.data as { csvFile: string }).csvFile, "utf8"), /sampleIndex,timeSec,timestampTicks,statusFlags,g_hssDbgCounterFocIsr/);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HSS capture start runs when GetCaps fails but helper and target are available", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
  });
  try {
    await writeHmProject(root);
    await writeFile(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", "utf8");
    await writeFile(helper, fakeHelperSource({ getCapsOk: false }), "utf8");

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
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
  });
  try {
    await writeHmProject(root);
    await writeFile(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", "utf8");
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
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
  });
  try {
    await writeHmProject(root);
    await writeFile(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", "utf8");
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

test("HSS export rejects non-terminal capture metadata", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
  });
  try {
    await writeHmProject(root);
    await writeFile(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", "utf8");
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
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
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

test("HSS capture start allows halted preflight with warning", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
  });
  try {
    await writeHmProject(root);
    await writeFile(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", "utf8");
    await writeFile(helper, fakeHelperSource({ getCapsOk: false }), "utf8");

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
    assert.equal(halted.ok, true);
    assert.match(halted.warnings[0] ?? "", /target reported halted/);
    const haltedCaptureId = (halted.data as { captureId: string }).captureId;
    await waitFor(async () => {
      const status = await service.captureStatus({ captureId: haltedCaptureId });
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

async function writeHmProject(root: string): Promise<string> {
  const exe = join(root, "Appl", "Debug", "Exe");
  const list = join(root, "Appl", "Debug", "List");
  await mkdir(exe, { recursive: true });
  await mkdir(list, { recursive: true });
  await writeFile(join(root, "Appl", "FOC_SCM.ewp"), "<project><name>Debug</name>Z20K146MC</project>", "utf8");
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
  targetWasHalted?: boolean;
  readError?: boolean;
  lingerMs?: number;
}

function fakeHelperSource(options: FakeHelperOptions = {}): string {
  const getCapsOk = options.getCapsOk ?? true;
  const targetWasHalted = options.targetWasHalted ?? false;
  const statusFlags = options.readError ? HSS_STATUS_FLAGS.read_error : HSS_STATUS_FLAGS.valid;
  const counterExpression = options.readError ? "0" : "i * 16";
  const helperStatus = options.readError ? "error" : "ok";
  const helperError = options.readError ? 'errorCode: "HSS_READ_FAILED", reason: "JLINK_HSS_Read produced no valid samples",' : "";
  return `
const fs = require("fs");
const command = process.argv[2];
if (command === "preflight") {
  console.log(JSON.stringify({ status: "ok", exportsFound: true }));
  process.exit(0);
}
if (command === "connect-preflight") {
  console.log(JSON.stringify({ status: "ok", targetWasHalted: ${targetWasHalted ? "true" : "false"}, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false }));
  process.exit(0);
}
if (command === "getcaps") {
  console.log(JSON.stringify(${getCapsOk ? "{ status: \"ok\", caps: { maxBlocks: 16, maxFreq: 16000 } }" : "{ status: \"error\", errorCode: \"HSS_HELPER_TIMEOUT\", reason: \"GetCaps failed\" }"}));
  process.exit(0);
}
if (command !== "hss-capture") {
  console.log(JSON.stringify({ status: "error", errorCode: "BAD_COMMAND", targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false }));
  process.exit(0);
}
const plan = JSON.parse(fs.readFileSync(process.argv[4], "utf8"));
const records = [];
const symbolCount = plan.symbols.length;
for (let i = 0; i < plan.requestedRateHz * plan.durationSec; i++) {
  const record = Buffer.alloc(24 + symbolCount * 4);
  record.writeBigUInt64LE(BigInt(i), 0);
  record.writeBigInt64LE(BigInt(i) * 1000000n, 8);
  record.writeUInt32LE(${statusFlags}, 16);
  record.writeUInt32LE(0, 20);
  record.writeUInt32LE(${counterExpression}, 24);
  records.push(record);
}
fs.writeFileSync(plan.outputFile, Buffer.concat(records));
const result = { status: "${helperStatus}", ${helperError} captureId: plan.captureId, requestedRateHz: plan.requestedRateHz, actualRateHz: plan.requestedRateHz, durationSec: plan.durationSec, sampleCount: records.length, validSamples: ${options.readError ? "0" : "records.length"}, readErrors: ${options.readError ? "records.length" : "0"}, timeouts: 0, overflows: 0, droppedSamples: 0, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false };
const finish = () => console.log(JSON.stringify(result));
${options.lingerMs ? `setTimeout(finish, ${options.lingerMs});` : "finish();"}
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
