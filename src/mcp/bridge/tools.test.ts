import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { experimentAnalyzeTool } from "../analysis/tools";
import { EvidenceForCodegraphOutput, evidenceForCodegraphTool } from "./tools";

test("evidence_for_codegraph maps overshoot to control-loop queries", async () => {
  const analysis = await experimentAnalyzeTool({
    experimentId: "generic-control-overshoot",
    analysisProfile: "generic_control",
    signals: ["command", "feedback"],
    windowMs: [0, 50],
  });
  assert.ok(!("error" in analysis));
  const result = await evidenceForCodegraphTool({ experimentId: "generic-control-overshoot", analysisResult: analysis });
  assert.ok(!("error" in result));
  const output = result as EvidenceForCodegraphOutput;
  assert.ok(output.evidence.some((item) => item.patterns.includes("overshoot")));
  assert.ok(output.queries.some((query) => /PI\/PID|feedback-control/.test(query.query)));
  assert.ok(output.queries.some((query) => query.symbols.includes("g_command") && query.symbols.includes("g_feedback")));
  assert.ok(output.queries.some((query) => query.files.includes("control.c") && query.files.includes("sense.c")));
});

test("evidence_for_codegraph maps fault transition to enum and assignment query", async () => {
  const analysis = await experimentAnalyzeTool({
    experimentId: "generic-fault-transition",
    analysisProfile: "generic_state_machine",
  });
  assert.ok(!("error" in analysis));
  const result = await evidenceForCodegraphTool({ experimentId: "generic-fault-transition", analysisResult: analysis });
  assert.ok(!("error" in result));
  const output = result as EvidenceForCodegraphOutput;
  assert.ok(output.evidence.some((item) => item.patterns.includes("fault_transition")));
  assert.ok(output.queries.some((query) => /defined, assigned, reported, and cleared/.test(query.query)));
  assert.ok(output.queries.some((query) => query.symbols.includes("g_faultCode") && query.files.includes("fault.c")));
});

test("evidence_for_codegraph maps stuck signal to update and ISR-path query", async () => {
  const analysis = await experimentAnalyzeTool({
    experimentId: "generic-state-stuck",
    analysisProfile: "generic_state_machine",
  });
  assert.ok(!("error" in analysis));
  const result = await evidenceForCodegraphTool({ experimentId: "generic-state-stuck", analysisResult: JSON.stringify(analysis) });
  assert.ok(!("error" in result));
  const output = result as EvidenceForCodegraphOutput;
  assert.ok(output.evidence.some((item) => item.patterns.includes("stuck_signal")));
  assert.ok(output.queries.some((query) => /update functions and interrupt\/task paths/.test(query.query)));
  assert.ok(output.queries.some((query) => query.symbols.includes("g_activeState") && query.symbols.includes("g_requestedMode")));
});

test("evidence_for_codegraph validates input and stays offline", async () => {
  const bad = await evidenceForCodegraphTool({ experimentId: "generic-control-ideal", analysisResult: "not json" });
  assert.deepEqual(bad, {
    error: {
      code: "validation_error",
      message: "analysisResult must be an object or JSON string",
      issues: undefined,
    },
  });

  for (const file of [
    "src/mcp/evidence/runtime-evidence.ts",
    "src/mcp/bridge/queries.ts",
    "src/mcp/bridge/tools.ts",
  ]) {
    const source = await readFile(join(process.cwd(), file), "utf8");
    const imports = source.split(/\r?\n/).filter((line) => line.startsWith("import "));
    assert.equal(imports.some((line) => /@.*codegraph|jlink|gdb|probe|rtt|capture/i.test(line)), false);
    assert.equal(/write_memory|halt|resume|reset|flash|startGDBServer|startCapture|capture_control|AppMotorDbg|AppCurrentSense|\bmotor\b|\biq\b|\bsvm\b/i.test(source), false);
  }
});
