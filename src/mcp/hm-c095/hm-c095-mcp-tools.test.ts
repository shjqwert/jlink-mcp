import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  analysisProfilesTool,
  experimentAnalyzeTool,
  experimentCompareTool,
  ExperimentAnalyzeOutput,
} from "../analysis/tools";
import { evidenceForCodegraphTool } from "../bridge/tools";
import { createRepoTempDir } from "../preflight/temp-preflight";
import { writeHmCapture } from "./hm-c095-capture-fixture";

test("HM_C095 MCP tools cover experimentId, fixturePath, experimentPath, metadataFile, and captureId inputs", async () => {
  const directory = await createRepoTempDir("hm-c095-tools-");
  const capture = await writeHmCapture();
  try {
    assert.ok(analysisProfilesTool().profiles.some((profile) => profile.name === "generic_control"));

    const byId = await experimentAnalyzeTool({
      experimentId: "hm-c095-control-overshoot",
      analysisProfile: "generic_control",
      windowMs: [0, 40],
    });
    assert.ok(!("error" in byId));

    const byFixturePath = await experimentAnalyzeTool({
      fixturePath: "hm-c095-state-fault.experiment.json",
      analysisProfile: "generic_state_machine",
    });
    assert.ok(!("error" in byFixturePath));

    const source = await readFile(join(process.cwd(), "src", "mcp", "fixtures", "hm-c095-control-overshoot.experiment.json"), "utf8");
    const experimentPath = join(directory, "hm-c095-copy.experiment.json");
    await writeFile(experimentPath, source);
    const byExperimentPath = await experimentAnalyzeTool({
      experimentPath,
      analysisProfile: "generic_control",
      signals: ["mod_pu", "iu_pu"],
      windowMs: [0, 40],
    });
    assert.ok(!("error" in byExperimentPath));

    const signalRoles = {
      mod_pu: "command" as const,
      iu_pu: "feedback" as const,
      sector: "state" as const,
      motor_fault: "fault" as const,
      alive_counter: "counter" as const,
    };
    const byMetadata = await experimentAnalyzeTool({
      metadataFile: capture.metadataFile,
      analysisProfile: "generic_control",
      signalRoles,
      maxSamples: 10000,
    });
    assert.ok(!("error" in byMetadata));

    const byCaptureId = await experimentAnalyzeTool({
      captureId: capture.metadata.sessionId,
      outputDir: capture.directory,
      analysisProfile: "generic_control",
      signalRoles,
      maxSamples: 10000,
    });
    assert.ok(!("error" in byCaptureId));

    const compare = await experimentCompareTool({
      baselineExperimentId: "hm-c095-control-overshoot",
      candidateExperimentPath: experimentPath,
      analysisProfile: "generic_control",
      metrics: ["overshoot", "steady_error"],
      windowMs: [0, 40],
    });
    assert.ok(!("error" in compare));

    const evidence = await evidenceForCodegraphTool({
      fixturePath: "hm-c095-control-overshoot.experiment.json",
      analysisResult: byId as ExperimentAnalyzeOutput,
    });
    assert.ok(!("error" in evidence));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(capture.directory, { recursive: true, force: true });
  }
});

test("HM_C095 MCP tools return structured errors for invalid inputs", async () => {
  const unknownProfile = await experimentAnalyzeTool({ experimentId: "hm-c095-control-overshoot", analysisProfile: "unknown" });
  assert.equal("error" in unknownProfile && unknownProfile.error.code, "validation_error");

  const missing = await experimentAnalyzeTool({ experimentId: "missing-hm-c095", analysisProfile: "generic_control" });
  assert.equal("error" in missing && missing.error.code, "not_found");

  const invalidPath = await experimentAnalyzeTool({ experimentPath: "relative.experiment.json", analysisProfile: "generic_control" });
  assert.equal("error" in invalidPath && invalidPath.error.code, "validation_error");

  const unsupportedMetric = await experimentCompareTool({
    baselineExperimentId: "hm-c095-control-overshoot",
    candidateExperimentId: "hm-c095-control-overshoot",
    analysisProfile: "generic_control",
    metrics: ["not_metric"],
  });
  assert.equal("error" in unsupportedMetric && unsupportedMetric.error.code, "validation_error");

  const incompatibleMetric = await experimentCompareTool({
    baselineExperimentId: "hm-c095-control-overshoot",
    candidateExperimentId: "hm-c095-control-overshoot",
    analysisProfile: "generic_control",
    metrics: ["state_transition"],
  });
  assert.equal("error" in incompatibleMetric && incompatibleMetric.error.code, "validation_error");

  const noCommand = await experimentAnalyzeTool({
    experimentId: "hm-c095-control-overshoot",
    analysisProfile: "generic_control",
    signals: ["iu_pu"],
  });
  assert.deepEqual("error" in noCommand && noCommand.error.message, "generic_control requires a command signal");

  const noFeedback = await experimentAnalyzeTool({
    experimentId: "hm-c095-control-overshoot",
    analysisProfile: "generic_control",
    signals: ["mod_pu"],
  });
  assert.deepEqual("error" in noFeedback && noFeedback.error.message, "generic_control requires a feedback signal");

  const badAnalysisJson = await evidenceForCodegraphTool({
    experimentId: "hm-c095-control-overshoot",
    analysisResult: "{bad json",
  });
  assert.equal("error" in badAnalysisJson && badAnalysisJson.error.code, "validation_error");

  const pathEscape = await evidenceForCodegraphTool({
    fixturePath: "../hm-c095-control-overshoot.experiment.json",
    analysisResult: { patterns: [] },
  });
  assert.equal("error" in pathEscape && pathEscape.error.code, "validation_error");
});

test("HM_C095 MCP analysis handlers do not import hardware, CodeGraph, or write paths", async () => {
  for (const file of [
    "src/mcp/analysis/tools.ts",
    "src/mcp/bridge/tools.ts",
    "src/mcp/evidence/runtime-evidence.ts",
  ]) {
    const source = await readFile(join(process.cwd(), file), "utf8");
    const imports = source.split(/\r?\n/).filter((line) => line.startsWith("import "));
    assert.equal(imports.some((line) => /@.*codegraph|jlink|gdb|rtt|probe/i.test(line)), false);
    assert.equal(/write_memory|probe_command|gdb_command|capture_control|halt\(|resume\(|reset\(|flash\(/i.test(source), false);
  }
});
