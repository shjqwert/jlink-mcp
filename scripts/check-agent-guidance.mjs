import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const workspace = resolve(process.cwd());
const runtimePath = resolve(workspace, "out/mcp/server.js");
if (!existsSync(runtimePath)) throw new Error("guidance check requires a compiled standalone runtime; run npm run compile first");
const { AGENT_TOOL_NAMES, COMPACT_TOOL_NAMES } = await import(pathToFileURL(runtimePath).href);

const guidanceFiles = [
  "README.md",
  ".mcp.json",
  "mcp-config.json",
];
const requiredToolLists = ["README.md"];
const forbiddenNames = [
  "hot_variable_add", "hot_variable_list", "hot_variable_refresh",
  "read_core_register", "read_core_registers", "write_core_register",
  "read_register", "read_registers", "write_register",
  "hss_capability", "hss_plan", "capture_index_rebuild", "snapshot",
  "gdb_server_start", "gdb_server_stop", "gdb_server_status", "gdb_connect", "gdb_disconnect",
  "rtt_connect", "rtt_disconnect", "rtt_channel_list", "rtt_channel_read",
  "analysis_profiles", "analysis_run", "variable_write_plan", "variable_write_execute",
];
const forbiddenGuidance = [/challengeId/i, /approvalToken/i, /planId/i, /userConfirmed/i, /risks*level/i, /jlink:\/\/discovery\/catalog/i];
const findings = [];
const texts = new Map();

for (const relativePath of guidanceFiles) {
  const absolutePath = resolve(workspace, relativePath);
  if (!existsSync(absolutePath)) {
    findings.push(`${relativePath}: missing active guidance file`);
    continue;
  }
  const text = readFileSync(absolutePath, "utf8");
  texts.set(relativePath, text);
  for (const name of forbiddenNames) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text)) findings.push(`${relativePath}: removed tool name ${name}`);
  }
  for (const pattern of forbiddenGuidance) {
    if (pattern.test(text)) findings.push(`${relativePath}: removed workflow vocabulary`);
  }
}

for (const relativePath of requiredToolLists) {
  const text = texts.get(relativePath) ?? "";
  for (const name of AGENT_TOOL_NAMES) {
    if (!new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text)) findings.push(`${relativePath}: missing documented tool ${name}`);
  }
  for (const name of COMPACT_TOOL_NAMES) {
    if (!new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text)) findings.push(`${relativePath}: missing documented compact tool ${name}`);
  }
}

const readme = texts.get("README.md") ?? "";
if (!/JLINK_MCP_PROFILE=compact/i.test(readme)) findings.push("README.md: missing default compact profile guidance");
if (!/legacy[\s\S]*40 direct tools/i.test(readme)) findings.push("README.md: missing legacy 40-tool compatibility guidance");

for (const relativePath of [".mcp.json", "mcp-config.json"]) {
  const text = texts.get(relativePath) ?? "";
  if (/\bJLINK_[A-Z_]+\b/.test(text)) findings.push(`${relativePath}: must not set a Target default`);
  if (/[A-Za-z]:[\\/]|\/(?:Users|home)\//.test(text)) findings.push(`${relativePath}: contains a machine-specific path`);
  try {
    const parsed = JSON.parse(text);
    const server = parsed?.mcpServers?.jlink;
    if (server?.command !== "node" || !Array.isArray(server.args) || !server.args.includes("out/mcp/standalone.js")) {
      findings.push(`${relativePath}: does not start the packaged standalone stdio entry`);
    }
  } catch {
    findings.push(`${relativePath}: invalid JSON`);
  }
}

if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`active guidance matches ${COMPACT_TOOL_NAMES.length} compact and ${AGENT_TOOL_NAMES.length} legacy tools\n`);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
