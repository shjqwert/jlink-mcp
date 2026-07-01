#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const policyFile = join(cwd, ".jlink-mcp", "policy.json");
const artifactFile = join(cwd, "Appl", "Debug", "Exe", "FOC_SCM.out");
const mapFile = join(cwd, "Appl", "Debug", "List", "FOC_SCM.map");

const missing = [
  ["policy", policyFile],
  ["artifact", artifactFile],
  ["map", mapFile],
].filter(([, file]) => !existsSync(file));

let policyOk = false;
let safeTargets = [];
if (!missing.some(([name]) => name === "policy")) {
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  safeTargets = (policy.variableWriteAllowlist ?? []).map((entry) => entry.path).filter((path) => /^(Debug|Test)_/.test(path));
  policyOk = policy.version === 2 && safeTargets.length > 0;
}

console.log(JSON.stringify({
  status: "blocked",
  reason: missing.length ? "required HM_C095 smoke inputs are missing" : "hardware smoke requires an explicit connected HM_C095/J-Link run; this script does not write hardware",
  missing: Object.fromEntries(missing),
  policyOk,
  safeTargets,
  required: {
    device: "HM_C095 target connected through J-Link",
    artifactFile,
    mapFile,
    policyFile,
  },
  mcpSequence: [
    "hss_capture_start",
    "variable_write_plan scalar Debug_* small value",
    "variable_write_execute",
    "variable_write_plan array_element Debug_* or Test_*",
    "variable_write_execute",
    "hss_capture_stop",
    "hss_capture_query mode=event_window",
    "hss_capture_export eventAware=true",
  ],
  passCriteria: [
    "execute readbackOk=true",
    "capture.events.jsonl contains variable_write events",
    "capture.flags.jsonl contains write_in_progress and write_nearby intervals",
    "capture.json materializes events and flagIntervals",
    "event-window query returns real samples",
    "event-aware CSV contains effectiveStatusFlags and eventMarker",
    "audit.jsonl contains variable_write_plan and variable_write_execute",
  ],
}, null, 2));
