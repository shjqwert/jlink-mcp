import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  ExperimentAnalyzeOutput,
  ExperimentCompareOutput,
  analysisProfilesTool,
  experimentAnalyzeTool,
  experimentCompareTool,
} from "./tools";

test("analysis_profiles returns implemented generic profiles", () => {
  assert.deepEqual(analysisProfilesTool().profiles.map((profile) => ({
    name: profile.name,
    domain: profile.domain,
    status: profile.status,
    patterns: profile.patterns,
  })), [
    {
      name: "generic_control",
      domain: "generic",
      status: "implemented",
      patterns: ["step_response", "overshoot", "settling_time", "steady_error", "saturation"],
    },
    {
      name: "generic_state_machine",
      domain: "generic",
      status: "implemented",
      patterns: ["state_transition", "fault_transition", "stuck_signal", "counter_stall", "counter_wrap"],
    },
  ]);
});

test("experiment_analyze reports ideal step metrics", async () => {
  const result = await experimentAnalyzeTool({
    experimentId: "generic-control-ideal",
    analysisProfile: "generic_control",
    signals: ["setpoint", "measured"],
    windowMs: [0, 40],
  });
  assert.ok(!("error" in result));
  const output = result as ExperimentAnalyzeOutput;
  assert.equal(output.experimentId, "generic-control-ideal");
  assert.equal(output.analysisProfile, "generic_control");
  assert.deepEqual(output.selectedSignals, ["setpoint", "measured"]);
  assert.deepEqual(output.patterns.map((pattern) => pattern.type), ["step_response", "steady_error", "settling_time"]);
});

test("experiment_analyze reports overshoot and fault fixtures", async () => {
  const overshoot = await experimentAnalyzeTool({
    experimentId: "generic-control-overshoot",
    analysisProfile: "generic_control",
    signals: ["command", "feedback"],
    windowMs: [0, 50],
  });
  assert.ok(!("error" in overshoot));
  assert.ok((overshoot as ExperimentAnalyzeOutput).patterns.some((pattern) => pattern.type === "overshoot"));

  const fault = await experimentAnalyzeTool({
    experimentId: "generic-fault-transition",
    analysisProfile: "generic_state_machine",
  });
  assert.ok(!("error" in fault));
  assert.ok((fault as ExperimentAnalyzeOutput).patterns.some((pattern) => pattern.type === "fault_transition"));
});

test("experiment_compare reports overshoot improvement", async () => {
  const result = await experimentCompareTool({
    baselineExperimentId: "generic-control-overshoot",
    candidateExperimentId: "generic-control-ideal",
    analysisProfile: "generic_control",
    metrics: ["overshoot", "settling_time", "steady_error"],
  });
  assert.ok(!("error" in result));
  const output = result as ExperimentCompareOutput;
  assert.equal(output.summary.verdict, "improved");
  assert.deepEqual(output.metricDiffs.find((diff) => diff.metric === "overshoot"), {
    metric: "overshoot",
    baseline: 2,
    candidate: 0,
    direction: "improved",
  });
});

test("analysis tools return structured validation and not-found errors", async () => {
  const unknownProfile = await experimentAnalyzeTool({
    experimentId: "generic-control-ideal",
    analysisProfile: "unknown_profile",
  });
  assert.deepEqual(unknownProfile, {
    error: {
      code: "validation_error",
      message: "Unknown or unimplemented analysisProfile: unknown_profile",
      issues: undefined,
    },
  });

  const missing = await experimentAnalyzeTool({
    experimentId: "missing-experiment",
    analysisProfile: "generic_control",
  });
  assert.equal("error" in missing && missing.error.code, "not_found");
});

test("incompatible selected signals produce structured validation errors", async () => {
  const result = await experimentAnalyzeTool({
    experimentId: "generic-control-ideal",
    analysisProfile: "generic_control",
    signals: ["setpoint"],
  });
  assert.deepEqual(result, {
    error: {
      code: "validation_error",
      message: "generic_control requires a feedback signal",
      issues: undefined,
    },
  });
});

test("MCP analysis handlers stay offline and read-only", async () => {
  const source = await readFile(join(process.cwd(), "src", "mcp", "analysis", "tools.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((line) => line.startsWith("import "));
  assert.equal(imports.some((line) => /codegraph|jlink|gdb|probe|capture/i.test(line)), false);
  assert.equal(/write_memory|halt|resume|reset|flash|startGDBServer|startCapture|capture_control/i.test(source), false);
});
