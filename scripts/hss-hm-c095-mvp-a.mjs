import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { JLinkBackend } from "../out/probe/jlink.js";
import { ProcessManager } from "../out/utils/process-manager.js";
import { HssCaptureService } from "../out/mcp/hss/hss-capture-service.js";

const options = parseArgs(process.argv.slice(2));
for (const name of ["project", "storage-root", "evidence-root", "jlink-exe", "jlink-dll", "helper", "adapter", "artifact", "map"]) {
  if (!isAbsolute(options[name] ?? "")) throw new Error(`--${name} must be an absolute path`);
}
if (options.target !== "Z20K146M") throw new Error("HM_C095 hardware acceptance requires --target Z20K146M");

const projectRoot = resolve(options.project);
const storageRoot = resolve(options["storage-root"]);
const evidenceRoot = resolve(options["evidence-root"]);
const before = await snapshot(projectRoot);
const processManager = new ProcessManager();
const probe = new JLinkBackend({
  installDir: dirname(options["jlink-exe"]),
  device: options.target,
  interface: "SWD",
  speed: numberOption(options.speed, 4000),
  serialNumber: options["probe-serial"],
}, processManager);
const service = new HssCaptureService(probe, {
  cwd: projectRoot,
  storageRoot,
  evidenceRoot,
  helperPath: options.helper,
  adapterPath: options.adapter,
});

try {
  const common = {
    targetId: "Z20K146M",
    dllPath: options["jlink-dll"],
    interface: "SWD",
    speedKhz: numberOption(options.speed, 4000),
    serial: options["probe-serial"],
    script: { mode: "none" },
    artifactFile: options.artifact,
    mapFile: options.map,
  };
  const getCaps = await service.capabilityProbe(common);
  if (!getCaps.ok) throw new Error(getCaps.error?.message ?? "GetCaps failed");
  const plan = await service.capturePlan({
    ...common,
    symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32", unit: "count" }],
    requestedRateHz: numberOption(options.rate, 1000),
    durationSec: numberOption(options.duration, 3),
    resetBeforeCapture: true,
    minimumRecoveryMs: numberOption(options["minimum-recovery-ms"], 1000),
    timeoutMs: numberOption(options["stability-timeout-ms"], 10000),
    pollIntervalMs: numberOption(options["poll-interval-ms"], 100),
    requiredConsecutiveRunningChecks: numberOption(options["running-checks"], 3),
  });
  if (!plan.ok || !plan.data) throw new Error(plan.error?.message ?? "HSS plan failed");
  const started = await service.captureStart({ planId: plan.data.planId });
  if (!started.ok || !started.data) throw new Error(started.error?.message ?? "HSS start failed");
  const deadline = Date.now() + plan.data.stabilityPolicy.timeoutMs + plan.data.sampling.durationSec * 1000 + 2000;
  while (Date.now() < deadline) {
    const status = await service.captureStatus({ captureId: started.data.captureId });
    if (!status.ok || status.data?.state !== "capturing") break;
    await new Promise((done) => setTimeout(done, 100));
  }
  const stopped = await service.captureStop({ captureId: started.data.captureId });
  if (!stopped.ok) throw new Error(stopped.error?.message ?? "HSS stop failed");
  const postConnect = stopped.data?.helperResult?.postConnectStability;
  if (postConnect?.passed !== true
      || !Number.isInteger(postConnect.checkCount)
      || postConnect.checkCount < plan.data.stabilityPolicy.requiredConsecutiveRunningChecks + 1
      || !Number.isFinite(postConnect.elapsedMs)
      || !Number.isInteger(postConnect.firstValue)
      || !Number.isInteger(postConnect.lastValue)
      || !Number.isFinite(postConnect.firstRateHz)
      || !Number.isFinite(postConnect.lastRateHz)) {
    throw new Error(`post-connect stability evidence failed: ${JSON.stringify(postConnect)}`);
  }
  const query = await service.captureQuery({ captureId: started.data.captureId, includeRawSamples: true, maxSamples: 10000, hmC095Profile: true });
  const oracle = query.data?.hmC095;
  if (!query.ok || oracle?.strictOracle !== true || oracle?.semanticPass !== true || oracle?.firstSampleIndexZero !== true) {
    throw new Error(`HM_C095 oracle failed: ${JSON.stringify(oracle)}`);
  }
  const after = await snapshot(projectRoot);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("target project changed during read-only hardware acceptance");
  const evidence = {
    recordedAt: new Date().toISOString(),
    projectRoot,
    storageRoot,
    evidenceRoot,
    targetProjectUnchanged: true,
    identities: {
      node: process.version,
      jlinkExe: await identity(options["jlink-exe"]),
      dll: await identity(options["jlink-dll"]),
      helper: await identity(options.helper),
      adapter: await identity(options.adapter),
      artifact: await identity(options.artifact),
      map: await identity(options.map),
    },
    getCaps,
    plan: plan.data,
    start: started.data,
    stop: stopped.data,
    query: query.data,
    oracle,
  };
  await mkdir(evidenceRoot, { recursive: true });
  const evidenceFile = join(evidenceRoot, `hm-c095-${started.data.captureId}.json`);
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(evidenceFile);
} finally {
  await service.dispose();
  probe.dispose();
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error(`invalid argument: ${args[index] ?? ""}`);
    parsed[args[index].slice(2)] = args[index + 1];
  }
  return parsed;
}

function numberOption(value, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid positive integer: ${value}`);
  return parsed;
}

async function identity(file) {
  const bytes = await readFile(file);
  return { path: resolve(file), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

async function snapshot(root) {
  const result = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.push(`${relative(root, file).replaceAll("\\", "/")}:${(await identity(file)).sha256}`);
    }
  };
  await walk(root);
  return result.sort();
}
