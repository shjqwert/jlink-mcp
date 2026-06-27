import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { experimentAnalyzeTool, ExperimentAnalyzeOutput } from "../analysis/tools";
import { evidenceForCodegraphTool, EvidenceForCodegraphOutput } from "../bridge/tools";
import { loadExperimentForAnalysis } from "../experiment-store";

test("HM_C095 control fixture produces generic control metrics and CodeGraph suggestions only", async () => {
  const loaded = await loadExperimentForAnalysis({ experimentId: "hm-c095-control-overshoot" });
  assert.equal(loaded.record.signals.find((signal) => signal.name === "mod_pu")?.selector, "AppMotorDbg.c::gstMotorDbg.fModPu");

  const analysis = await experimentAnalyzeTool({
    experimentId: "hm-c095-control-overshoot",
    analysisProfile: "generic_control",
    signalRoles: {
      mod_pu: "command",
      iu_pu: "feedback",
      iv_pu: "derived",
      motor_fault: "fault",
    },
    windowMs: [0, 40],
  });
  assert.ok(!("error" in analysis));
  const patterns = (analysis as ExperimentAnalyzeOutput).patterns.map((pattern) => pattern.type);
  for (const type of ["step_response", "overshoot", "steady_error", "settling_time"] as const) {
    assert.ok(patterns.includes(type), `missing ${type}`);
  }

  const evidence = await evidenceForCodegraphTool({ experimentId: "hm-c095-control-overshoot", analysisResult: analysis });
  assert.ok(!("error" in evidence));
  const queries = (evidence as EvidenceForCodegraphOutput).queries;
  assert.ok(queries.some((query) => query.symbols.includes("gstMotorDbg") && query.query.includes("gstMotorDbg.fModPu")));
  assert.ok(queries.some((query) => query.query.includes("gstMotorDbg.fIuPu")));
  assert.ok(queries.some((query) => /PI\/PID|feedback-control/.test(query.query)));
  assert.ok(queries.some((query) => /clamp|limit|saturation/.test(query.query)));
});

test("HM_C095 state fixture produces transition, fault, and tail counter-stall evidence", async () => {
  const analysis = await experimentAnalyzeTool({
    experimentId: "hm-c095-state-fault",
    analysisProfile: "generic_state_machine",
    signalRoles: {
      sector: "state",
      motor_fault: "fault",
      alive_counter: "counter",
      guwWdgFlg: "limit",
    },
  });
  assert.ok(!("error" in analysis));
  const patterns = (analysis as ExperimentAnalyzeOutput).patterns.map((pattern) => pattern.type);
  assert.ok(patterns.includes("state_transition"));
  assert.ok(patterns.includes("fault_transition"));
  assert.ok(patterns.includes("counter_stall"));

  const evidence = await evidenceForCodegraphTool({ experimentId: "hm-c095-state-fault", analysisResult: analysis });
  assert.ok(!("error" in evidence));
  const queries = (evidence as EvidenceForCodegraphOutput).queries.map((query) => query.query).join("\n");
  assert.match(queries, /defined, assigned, reported, and cleared/);
  assert.match(queries, /writers, readers, and update path|update functions and interrupt\/task paths/);
});

test("HM_C095 runtime analysis remains offline and read-only", async () => {
  for (const file of [
    "src/mcp/experiment-store.ts",
    "src/mcp/analysis/tools.ts",
    "src/mcp/bridge/tools.ts",
    "src/mcp/evidence/runtime-evidence.ts",
  ]) {
    const source = await readFile(join(process.cwd(), file), "utf8");
    const imports = source.split(/\r?\n/).filter((line) => line.startsWith("import "));
    assert.equal(imports.some((line) => /@.*codegraph|jlink|gdb|rtt|probe/i.test(line)), false);
    assert.equal(/write_memory|halt\(|resume\(|reset\(|flash\(|startGDBServer|startCapture|capture_control/i.test(source), false);
  }
});
