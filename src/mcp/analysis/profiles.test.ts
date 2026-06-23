import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadExperimentFixture } from "../experiment-contract";
import { analyzeExperiment, listAnalysisProfiles } from "./profiles";

const fixtureDir = join(process.cwd(), "src", "mcp", "fixtures");

test("analysis profile registry exposes generic profiles", () => {
  assert.deepEqual(
    listAnalysisProfiles().filter((profile) => profile.status === "implemented").map((profile) => profile.name),
    ["generic_control", "generic_state_machine"],
  );
});

test("generic control analysis detects step metrics without domain naming", async () => {
  const ideal = await loadExperimentFixture(join(fixtureDir, "generic-control-ideal.experiment.json"));
  const idealResult = analyzeExperiment(ideal, "generic_control");
  assert.deepEqual(idealResult.patterns.map((pattern) => pattern.type), ["step_response", "steady_error", "settling_time"]);
  assert.equal(idealResult.patterns.find((pattern) => pattern.type === "steady_error")?.value, 0);

  const overshoot = await loadExperimentFixture(join(fixtureDir, "generic-control-overshoot.experiment.json"));
  const overshootResult = analyzeExperiment(overshoot, "generic_control");
  assert.ok(overshootResult.patterns.some((pattern) => pattern.type === "overshoot" && pattern.value === 2));
  assert.ok(overshootResult.patterns.some((pattern) => pattern.type === "saturation"));
});

test("generic state analysis detects stuck, fault, and counter patterns", async () => {
  const stuck = await loadExperimentFixture(join(fixtureDir, "generic-state-stuck.experiment.json"));
  assert.ok(analyzeExperiment(stuck, "generic_state_machine").patterns.some((pattern) => pattern.type === "stuck_signal"));

  const fault = await loadExperimentFixture(join(fixtureDir, "generic-fault-transition.experiment.json"));
  const faultPatterns = analyzeExperiment(fault, "generic_state_machine").patterns.map((pattern) => pattern.type);
  assert.ok(faultPatterns.includes("state_transition"));
  assert.ok(faultPatterns.includes("fault_transition"));

  const counter = await loadExperimentFixture(join(fixtureDir, "generic-counter-stall.experiment.json"));
  assert.ok(analyzeExperiment(counter, "generic_state_machine").patterns.some((pattern) => pattern.type === "counter_stall"));
});

test("analysis core stays role-based and offline", async () => {
  const source = await readFile(join(process.cwd(), "src", "mcp", "analysis", "profiles.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((line) => line.startsWith("import "));
  assert.equal(imports.some((line) => /probe|jlink|gdb|capture|codegraph/i.test(line)), false);
  assert.equal(/AppMotorDbg|AppCurrentSense|\bmotor\b|\biq\b|\bsvm\b/i.test(source), false);
});
