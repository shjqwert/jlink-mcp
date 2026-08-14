import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [compiledRootArg, outputRootArg] = process.argv.slice(2);
if (!compiledRootArg || !outputRootArg) {
  throw new Error("usage: node scripts/measure-capture-pipeline.mjs <compiled-root> <output-root>");
}

const compiledRoot = path.resolve(compiledRootArg);
const outputRoot = path.resolve(outputRootArg);
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const jcap = await import(pathToFileURL(path.join(compiledRoot, "mcp", "jcap", "jcap-v1.js")).href);
const results = await import(pathToFileURL(path.join(compiledRoot, "mcp", "runtime", "operation-result.js")).href);
const envelopes = await import(pathToFileURL(path.join(compiledRoot, "mcp", "runtime", "operation-envelope.js")).href);

const captureId = randomUUID();
const capturesDir = path.join(outputRoot, "captures");
const workDir = path.join(outputRoot, "work", `${captureId}.jcap`);
const finalPath = path.join(capturesDir, `${captureId}.jcap`);
const isV2 = typeof jcap.finalizeJcapV2FromV1Package === "function";
const packageDir = isV2 ? workDir : finalPath;
const variables = [
  { logicalIdentity: "counter", type: "uint32", address: "0x20000000", size: 4, artifactGeneration: "a".repeat(64), layoutHash: "b".repeat(64) },
  { logicalIdentity: "feedback", type: "uint32", address: "0x20000004", size: 4, artifactGeneration: "a".repeat(64), layoutHash: "c".repeat(64) },
];
const metadata = jcap.createJcapV1Metadata({
  captureId,
  backend: "fake-jlink-hss",
  requestedRateHz: 1_000,
  durationSec: 3,
  variables,
  provenance: {
    captureId,
    backend: "fake-jlink-hss",
    runtime: { helperProtocolVersion: 3 },
    target: { projectRoot: "C:\\fixture-project", generation: randomUUID(), device: "FIXTURE", probeSerial: "123456789", interface: "SWD", speed: 4_000 },
    script: { mode: "none" },
    artifact: { path: "C:\\fixture-project\\firmware.elf", generation: "a".repeat(64), sha256: "e".repeat(64) },
  },
});
const writer = new jcap.JcapV1Writer({ packageDir, metadata });
writer.appendEvent({ eventId: randomUUID(), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" });
for (let sampleIndex = 0; sampleIndex < 3_000; sampleIndex += 1) {
  writer.appendSample({
    sampleIndex,
    tick: String(sampleIndex * 1_000_000),
    statusFlags: 0,
    values: { counter: sampleIndex, feedback: sampleIndex + 1_000 },
  });
}
writer.appendEvent({ eventId: randomUUID(), eventSequence: 1, type: "lifecycle", tick: "2999000000", state: "finalizing" });
writer.appendEvent({
  eventId: randomUUID(), eventSequence: 2, type: "quality", tick: "2999000000",
  qualityStatus: "reported", qualitySource: "jlink", missingSamples: 0, droppedSamples: 0,
  overflows: 0, readErrors: 0, timeouts: 0, durationValidated: true, qualityEvidence: { source: "measurement" },
});
writer.appendEvent({ eventId: randomUUID(), eventSequence: 3, type: "lifecycle", tick: "2999000000", state: "completed" });
writer.close();
jcap.finalizeJcapV1Metadata(
  packageDir,
  "completed",
  { missingSamples: 0, droppedSamples: 0, overflows: 0, readErrors: 0, timeouts: 0 },
  "reported",
);

let queryResult;
if (isV2) {
  await jcap.finalizeJcapV2FromV1Package({
    packageDir,
    captureFile: finalPath,
    backend: "hss",
    intrusive: false,
    requestedRateHz: 1_000,
    actualRateHz: 1_000,
    pauseTotalUs: 0,
  });
  queryResult = await jcap.jcapV2CaptureSeries({
    captureFile: finalPath,
    captureId,
    variables: ["counter", "feedback"],
    timeRange: { startMs: 0, endMs: 3_000 },
    resolution: { mode: "points", maxPoints: 256 },
    statistics: ["last", "min", "max"],
  });
  rmSync(path.dirname(packageDir), { recursive: true, force: true });
} else {
  await jcap.rebuildJcapV1Index(packageDir);
  queryResult = await jcap.jcapCaptureSeries({
    packageDir,
    variables: ["counter", "feedback"],
    startTick: "0",
    endTick: "3000000000",
    bucketCount: 256,
  });
}

const captureEnvelope = envelopes.createOperationEnvelope("hss_stop");
captureEnvelope.ok = true;
captureEnvelope.capture = { captureId, state: "completed", sampleCount: 3_000, quality: { missingSamples: 0, droppedSamples: 0, readErrors: 0 } };
captureEnvelope.data = { captureId, state: "completed", sampleCount: 3_000, packageDir: finalPath, probeSerial: "123456789", variables };
const captureResult = results.operationToolResult(captureEnvelope, "normal");

const readEnvelope = envelopes.createOperationEnvelope("read_variable");
readEnvelope.ok = true;
readEnvelope.data = { value: 42, address: "0x20000000", logicalIdentity: "counter", probeSerial: "123456789" };
const readResult = results.operationToolResult(readEnvelope, "normal");

const captureEntries = readdirSync(capturesDir);
const measurePath = captureEntries.length === 1 ? path.join(capturesDir, captureEntries[0]) : capturesDir;
const report = {
  storageFormat: isV2 ? "jcap-v2-sqlite" : "jcap-v1-package",
  sampleCount: 3_000,
  variableCount: 2,
  captureCompletionBytes: Buffer.byteLength(captureResult.content[0].text, "utf8"),
  normalReadBytes: Buffer.byteLength(readResult.content[0].text, "utf8"),
  queryCalls: 1,
  queryResultBytes: Buffer.byteLength(JSON.stringify(queryResult), "utf8"),
  captureStorageBytes: treeBytes(measurePath),
  captureFileCount: treeFiles(measurePath),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function treeBytes(target) {
  const stat = statSync(target);
  if (stat.isFile()) return stat.size;
  return readdirSync(target).reduce((total, entry) => total + treeBytes(path.join(target, entry)), 0);
}

function treeFiles(target) {
  const stat = statSync(target);
  if (stat.isFile()) return 1;
  return readdirSync(target).reduce((total, entry) => total + treeFiles(path.join(target, entry)), 0);
}
