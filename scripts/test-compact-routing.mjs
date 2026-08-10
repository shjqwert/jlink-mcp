import assert from "node:assert/strict";
import { loadLiveToolCatalog } from "./agent-routing-eval.mjs";

const compact = await loadLiveToolCatalog("compact");
const advanced = await loadLiveToolCatalog("advanced");
const expectedCompact = [
  "project", "inspect", "write", "control", "program",
  "debug", "trace", "capture", "diagnose_crash",
].sort();

assert.deepEqual(compact.map(({ name }) => name).sort(), expectedCompact);
assert.deepEqual(advanced.map(({ name }) => name).sort(), [...expectedCompact, "raw"].sort());
assert.ok(JSON.stringify(compact).length <= 10_000, "compact catalog exceeds the 10k-character budget");

for (const tool of compact) {
  assert.equal(tool.inputSchema?.properties?.runId, undefined, `${tool.name} must not expose runId`);
  if (tool.name !== "project") {
    assert.equal(tool.inputSchema?.properties?.projectRoot, undefined, `${tool.name} must consume the bound root`);
  }
}

const byName = new Map(compact.map((tool) => [tool.name, tool]));
assert.match(byName.get("debug")?.description ?? "", /run_to.*one call/i);
assert.match(byName.get("trace")?.description ?? "", /rtt_window/);
assert.match(byName.get("trace")?.description ?? "", /hss_window/);

const referencePlans = [
  { id: "cold-setup-inspect", calls: [["project", "configure"], ["inspect", "variable"]], maxCalls: 2 },
  { id: "run-to-breakpoint", calls: [["debug", "run_to"]], maxCalls: 1 },
  { id: "bounded-rtt-window", calls: [["trace", "rtt_window"]], maxCalls: 1 },
  { id: "bounded-hss-window", calls: [["trace", "hss_window"]], maxCalls: 1 },
];
for (const plan of referencePlans) {
  assert.ok(plan.calls.length <= plan.maxCalls, `${plan.id} exceeds its call budget`);
  for (const [tool, action] of plan.calls) {
    const schema = byName.get(tool)?.inputSchema;
    assert.ok(schema, `${plan.id}: missing ${tool}`);
    if (action) {
      const actions = schema.properties?.action?.enum ?? [];
      assert.ok(actions.includes(action), `${plan.id}: ${tool}.${action} is not in the live schema`);
    }
  }
}

process.stdout.write("Compact routing budget: 9 default tools, 10 advanced tools, and 2/1/1/1 call plans passed.\n");
