import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { selectorHints } from "../bridge/queries";
import { captureMetadataToExperimentRecord, loadExperimentForAnalysis } from "../experiment-store";
import { createRepoTempDir } from "../preflight/temp-preflight";
import { hmCaptureBinary, writeHmCapture } from "./hm-c095-capture-fixture";

test("HM_C095 capture metadata converts to ExperimentRecord with current selectors", async () => {
  const { directory, metadataFile, binaryFile, metadata } = await writeHmCapture();
  try {
    const loaded = await loadExperimentForAnalysis({
      metadataFile,
      signalRoles: {
        mod_pu: "command",
        iu_pu: "feedback",
        sector: "state",
        motor_fault: "fault",
        alive_counter: "counter",
      },
      maxSamples: 10000,
    });
    assert.equal(loaded.record.source, "capture");
    assert.equal(loaded.record.capture?.backend, "jlink-gdb-rsp");
    assert.equal(loaded.record.target?.device, "Z20K146M");
    assert.equal(loaded.record.samples?.[2].values.iu_pu, Math.fround(0.42));
    assert.equal(loaded.record.samples?.[3].values.motor_fault, 2);
    assert.equal(loaded.record.artifacts?.raw, binaryFile);
    assert.equal(loaded.record.artifacts?.metadata, metadataFile);

    const decimated = await loadExperimentForAnalysis({ metadataFile, maxSamples: 2 });
    assert.ok((decimated.record.metadata?.sampleWarnings as string[]).some((warning) => /decimated/.test(warning)));

    const byCaptureId = await loadExperimentForAnalysis({ captureId: metadata.sessionId, outputDir: directory });
    assert.equal(byCaptureId.experimentId, `capture_${metadata.sessionId}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HM_C095 capture conversion rejects wrong-session, outside binary, and path escape", async () => {
  const { directory, metadataFile, metadata } = await writeHmCapture();
  const outside = await createRepoTempDir("hm-c095-capture-outside-");
  try {
    const wrongSession = "223e4567-e89b-42d3-a456-426614174000";
    const wrongBinary = join(directory, `2026-06-27T00-00-00-000Z-${wrongSession}.jlcp`);
    await writeFile(wrongBinary, hmCaptureBinary());
    await assert.rejects(
      () => captureMetadataToExperimentRecord({ ...metadata, binaryFile: wrongBinary }, { metadataFile }),
      /does not match its sessionId/,
    );

    const outsideBinary = join(outside, `2026-06-27T00-00-00-000Z-${metadata.sessionId}.jlcp`);
    await writeFile(outsideBinary, hmCaptureBinary());
    await assert.rejects(
      () => captureMetadataToExperimentRecord({ ...metadata, binaryFile: outsideBinary }, { metadataFile }),
      /escapes its metadata directory/,
    );

    await assert.rejects(() => loadExperimentForAnalysis({ fixturePath: "../hm-c095-control-overshoot.experiment.json" }), /escapes fixture directory/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("HM_C095 selector parser exposes file, root, member path, and display symbol", () => {
  assert.deepEqual(selectorHints({
    name: "iu_pu",
    selector: "AppMotorDbg.c::gstMotorDbg.fIuPu",
    type: "float32",
    role: "feedback",
  }), {
    name: "iu_pu",
    role: "feedback",
    selector: "AppMotorDbg.c::gstMotorDbg.fIuPu",
    symbol: "gstMotorDbg",
    rootSymbol: "gstMotorDbg",
    memberPath: "fIuPu",
    displaySymbol: "gstMotorDbg.fIuPu",
    fileHint: "AppMotorDbg.c",
  });
  assert.equal(selectorHints({
    name: "alive_counter",
    selector: "TraceAgentPort.c::s_traceAliveCounter",
    type: "uint32",
    role: "counter",
  }).rootSymbol, "s_traceAliveCounter");
});
