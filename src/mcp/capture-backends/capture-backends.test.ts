import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { captureBackendBenchmarkTool, captureBackendListTool, captureBackendSelectTool, captureImportExperimentTool, probeCaptureBackends } from "./backend-router";
import { EnvJlinkHssAdapter, FakeJlinkHssAdapter } from "./jlink-hss-adapter";

const hssEnv = { JLINK_HSS_ENABLED: "1", JLINK_SDK_DIR: "C:\\JLinkSDK" };
const rtt = {
  controlBlockAddress: "0x2000657C",
  upChannels: [{ index: 1, name: "AI_TRACE" }],
  downChannels: [{ index: 1, name: "AI_CMD" }],
};

test("HSS is selected before RTT and RSP only when SDK adapter is available", () => {
  const report = probeCaptureBackends({ env: hssEnv, hssAdapter: new FakeJlinkHssAdapter(true), rtt });
  assert.deepEqual(report.preferredOrder, ["jlink-hss", "direct-rtt-channel", "memory-poll-rsp", "external-import"]);
  assert.equal(report.selectedBackend, "jlink-hss");
  assert.equal(report.backends.find((backend) => backend.name === "jlink-hss")?.requiresTargetCodeChange, false);
});

test("HSS missing env or adapter is unavailable and does not block RTT/RSP fallback", () => {
  assert.equal(probeCaptureBackends({ env: { JLINK_HSS_ENABLED: "0" }, rtt }).selectedBackend, "direct-rtt-channel");
  assert.equal(probeCaptureBackends({ env: hssEnv, rtt, hssAdapter: new FakeJlinkHssAdapter(false) }).backends[0].reason, "HSS benchmark adapter unavailable");
  assert.equal(probeCaptureBackends({ env: { JLINK_HSS_ENABLED: "0" }, rtt: { upChannels: [], downChannels: [] } }).selectedBackend, "memory-poll-rsp");
});

test("RTT unavailable preserves reasons and no-RTT project falls back without MCU changes", () => {
  const report = probeCaptureBackends({ env: { JLINK_HSS_ENABLED: "0" }, rtt: { upChannels: [], downChannels: [] } });
  const rttBackend = report.backends.find((backend) => backend.name === "direct-rtt-channel");
  const rsp = report.backends.find((backend) => backend.name === "memory-poll-rsp");
  assert.equal(report.selectedBackend, "memory-poll-rsp");
  assert.equal(rttBackend?.reason, "RTT control block not found");
  assert.equal(rsp?.requiresFirmware, false);
  assert.match(rsp?.warnings.join("\n") ?? "", /low-rate fallback/);
  assert.deepEqual(report.fallbackFrom, ["jlink-hss", "direct-rtt-channel"]);
  assert.match(report.fallbackReason ?? "", /jlink-hss/);
  assert.match(report.unavailableReasons["direct-rtt-channel"] ?? "", /RTT control block/);
  assert.match(report.lowRateWarning ?? "", /low-rate fallback/);
});

test("preferred backend override works only when the backend is available", () => {
  const preferred = probeCaptureBackends({ env: { JLINK_HSS_ENABLED: "0" }, rtt, preferredBackend: "direct-rtt-channel" });
  assert.equal(preferred.selectedBackend, "direct-rtt-channel");
  assert.match(preferred.warnings.join("\n"), /preferred backend override/);

  const unavailable = probeCaptureBackends({ env: { JLINK_HSS_ENABLED: "0" }, preferredBackend: "jlink-hss" });
  assert.equal(unavailable.selectedBackend, null);
  assert.match(unavailable.warnings.join("\n"), /unavailable/);

  const unknown = probeCaptureBackends({ preferredBackend: "missing" as never });
  assert.equal(unknown.selectedBackend, null);
  assert.match(unknown.warnings.join("\n"), /unknown/);
});

test("external import is offline-only and import tool does not compete with realtime capture", () => {
  assert.equal(probeCaptureBackends({ env: { JLINK_HSS_ENABLED: "0" } }).selectedBackend, "memory-poll-rsp");
  assert.equal(captureImportExperimentTool({ sourcePath: "trace.csv", format: "csv" }).backend, "external-import");
});

test("backend list/select tools and no-selected reports stay structured", () => {
  assert.equal(captureBackendListTool({ env: { JLINK_HSS_ENABLED: "0" } }).selectedBackend, "memory-poll-rsp");
  assert.equal(captureBackendSelectTool({ env: { JLINK_HSS_ENABLED: "0" }, rtt }).selectedBackend, "direct-rtt-channel");
  const result = probeCaptureBackends({}, [{
    capability: { name: "jlink-hss", priority: 1, expectedUse: "test", requiresFirmware: false, requiresTargetCodeChange: false, requiresSDK: false, requiresExternalTool: false, supportsRead: true, supportsWrite: false, supportsStreaming: false, supportsRunWhileTargetRunning: false, supportsExperimentExport: true },
    probe: () => ({ name: "jlink-hss", priority: 1, expectedUse: "test", requiresFirmware: false, requiresTargetCodeChange: false, requiresSDK: false, requiresExternalTool: false, supportsRead: true, supportsWrite: false, supportsStreaming: false, supportsRunWhileTargetRunning: false, supportsExperimentExport: true, status: "unavailable", reason: "nope", warnings: [] }),
  }]);
  assert.equal(result.selectedBackend, null);
  assert.equal(result.fallbackReason, undefined);
  assert.equal(result.unavailableReasons["jlink-hss"], "nope");
});

test("HSS fake benchmark reports actual rate and RSP benchmark reports fallback warning", () => {
  assert.equal(new EnvJlinkHssAdapter({ installDir: "Z:\\missing" }).isAvailable(""), false);

  const hss = captureBackendBenchmarkTool({
    backendName: "jlink-hss",
    variables: ["speed"],
    requestedRateHz: 200,
    durationSec: 2,
    context: { env: hssEnv, hssAdapter: new FakeJlinkHssAdapter(true) },
  });
  assert.equal(hss.actualRateHz, 200);
  assert.equal(hss.successRate, 1);

  const rsp = captureBackendBenchmarkTool({ backendName: "memory-poll-rsp", variables: ["speed"], requestedRateHz: 200, durationSec: 2 });
  assert.equal(rsp.actualRateHz, 10);
  assert.match(rsp.warnings.join("\n"), /low-rate fallback/);

  assert.throws(() => captureBackendBenchmarkTool({ backendName: "direct-rtt-channel", context: { env: {}, rtt } }), /benchmark is unavailable/);
  assert.throws(() => captureBackendBenchmarkTool({ backendName: "missing" as never }), /No available backend selected/);
});

test("EnvJlinkHssAdapter records JScope as preflight-only and never benchmark-ready", () => {
  fs.mkdirSync(".tmp", { recursive: true });
  const root = fs.mkdtempSync(path.join(process.cwd(), ".tmp", "jlink-hss-test-"));
  const installDir = path.join(root, "JLink");
  const appData = path.join(root, "AppData", "Roaming");
  const project = path.join(root, "FOC.jscope");
  const oldAppData = process.env.APPDATA;

  try {
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(path.join(appData, "SEGGER"), { recursive: true });
    fs.writeFileSync(path.join(installDir, "JScope.exe"), "");
    fs.writeFileSync(
      path.join(installDir, "JLink_x64.dll"),
      "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop",
    );
    fs.writeFileSync(project, "<JScopeProject />");
    fs.writeFileSync(path.join(appData, "SEGGER", "JScopeSettings.ini"), `Current="${project}"\n`);

    const adapter = new EnvJlinkHssAdapter({ installDir });
    assert.equal(new EnvJlinkHssAdapter({ installDir: path.join(root, "missing") }).preflight("").benchmarkReady, false);
    assert.equal(adapter.isAvailable(""), false);
    const report = probeCaptureBackends({ env: hssEnv, hssAdapter: adapter, rtt });
    const hss = report.backends.find((backend) => backend.name === "jlink-hss");
    assert.equal(hss?.status, "unavailable");
    assert.equal(hss?.headlessBenchmark?.status, "blocked");
    assert.equal(hss?.sdkPrototype?.status, "missing");
    assert.equal(hss?.preflight?.preflightOnly, true);
    assert.equal(hss?.preflight?.benchmarkReady, false);
    assert.equal(hss?.hssValidationState?.status, "blocked_missing_adapter");
    assert.equal(hss?.hssValidationState?.benchmarkReady, false);
    assert.equal(hss?.hssValidationState?.publicPrototypeCandidate, true);
    assert.equal(report.selectedBackend, "direct-rtt-channel");

    process.env.APPDATA = appData;
    assert.equal(adapter.projectFile(), project);
    assert.equal(new EnvJlinkHssAdapter({ installDir, projectFile: project }).projectFile(), project);

    fs.writeFileSync(path.join(installDir, "JLink_x64.dll"), "JLINK_HSS_GetCaps");
    assert.equal(adapter.isAvailable(""), false);
  } finally {
    if (oldAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = oldAppData;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HSS is selected only after benchmark-capable adapter evidence exists", () => {
  const getCapsOnly = {
    isAvailable: () => false,
    preflight: () => ({ hssExportsFound: true, getcapsPass: true }),
  };
  const report = probeCaptureBackends({ env: { ...hssEnv, JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API: "1" }, hssAdapter: getCapsOnly, rtt });
  assert.equal(report.selectedBackend, "direct-rtt-channel");
  assert.equal(report.backends[0].hssValidationState?.status, "blocked_missing_adapter");

  const benchmark = probeCaptureBackends({ env: hssEnv, hssAdapter: new FakeJlinkHssAdapter(true), rtt });
  assert.equal(benchmark.selectedBackend, "jlink-hss");
  assert.equal(benchmark.backends[0].hssValidationState?.status, "experimental_benchmark_pass");
});

test("HSS preflight available without benchmark remains blocked", () => {
  const preflightOnly = {
    isAvailable: () => true,
    preflight: () => ({ hssExportsFound: true }),
  };
  const report = probeCaptureBackends({ env: hssEnv, hssAdapter: preflightOnly, rtt });
  assert.equal(report.selectedBackend, "direct-rtt-channel");
  assert.equal(report.backends[0].status, "available-if-configured");
  assert.equal(report.backends[0].hssValidationState?.benchmarkReady, false);
});

test("direct RTT preserves missing requested channel reason", () => {
  const report = probeCaptureBackends({
    env: { JLINK_HSS_ENABLED: "0" },
    rtt: { ...rtt, requestedChannelName: "MISSING" },
    preferredBackend: "direct-rtt-channel",
  });
  assert.equal(report.selectedBackend, null);
  assert.equal(report.backends.find((backend) => backend.name === "direct-rtt-channel")?.reason, "requested RTT channel not found");
});
