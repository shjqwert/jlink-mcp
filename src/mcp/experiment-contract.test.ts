import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  analysisProfileSchema,
  loadExperimentFixture,
  metricNameSchema,
  runtimeEvidenceSchema,
  validateExperimentRecord,
} from "./experiment-contract";

test("experiment contracts accept generic non-motor signals and reject structured invalid input", () => {
  const valid = validateExperimentRecord({
    experimentId: "fixture_power_supply_step",
    createdAt: "2026-06-24T00:00:00.000Z",
    source: "synthetic",
    signals: [
      { name: "voltage_ref", selector: "control.c::g_voltageRef", type: "float32", unit: "V", role: "command", domain: "power" },
      { name: "vout", selector: "adc.c::g_vout", type: "float32", unit: "V", role: "feedback", domain: "power" },
    ],
    events: [{ timeMs: 10, type: "command_step", signal: "voltage_ref", value: 12 }],
    samples: [{ timeMs: 10, values: { voltage_ref: 12, vout: 10.5 } }],
  });
  assert.equal(valid.ok, true);

  const invalid = validateExperimentRecord({
    experimentId: "bad",
    createdAt: "2026-06-24T00:00:00.000Z",
    source: "fixture",
    signals: [{ name: "speed", type: "float32", role: "motor_feedback_magic" }],
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.ok(invalid.issues.some((issue) => issue.path.join(".") === "signals.0.role"));
  }

  const unknownSampleSignal = validateExperimentRecord({
    experimentId: "bad_sample",
    createdAt: "2026-06-24T00:00:00.000Z",
    source: "fixture",
    signals: [{ name: "speed", type: "float32", role: "feedback" }],
    samples: [{ timeMs: 0, values: { missing_signal: 1 } }],
  });
  assert.equal(unknownSampleSignal.ok, false);
  if (!unknownSampleSignal.ok) {
    assert.ok(unknownSampleSignal.issues.some((issue) => issue.path.join(".") === "samples.0.values.missing_signal"));
  }
});

test("profile, metric, and runtime evidence validators cover phase one enums", () => {
  assert.equal(analysisProfileSchema.parse({
    name: "generic_control",
    domain: "generic",
    status: "implemented",
    patterns: ["step_response", "overshoot", "settling_time", "steady_error", "saturation"],
  }).name, "generic_control");
  assert.throws(() => analysisProfileSchema.parse({ name: "unknown_profile", domain: "generic", status: "implemented", patterns: ["overshoot"] }));
  assert.throws(() => metricNameSchema.parse("current_loop_gain"));
  assert.throws(() => runtimeEvidenceSchema.parse({
    evidenceId: "ev_1",
    experimentId: "exp_1",
    summary: "bad severity",
    severity: "critical",
    signals: [],
    patterns: [],
  }));
});

test("synthetic fixture loading is local and hardware-free", async () => {
  const fixture = await loadExperimentFixture(join(process.cwd(), "src", "mcp", "fixtures", "generic-control-step.experiment.json"));
  assert.equal(fixture.source, "fixture");
  assert.deepEqual(fixture.signals.map((signal) => signal.role), ["command", "feedback", "fault"]);
  assert.equal(fixture.samples?.length, 5);

  const source = await readFile(join(process.cwd(), "src", "mcp", "experiment-contract.ts"), "utf8");
  const imports = source.split(/\r?\n/).filter((line) => line.startsWith("import "));
  assert.equal(imports.some((line) => /probe|jlink|gdb|capture-helper|codegraph/i.test(line)), false);
});
