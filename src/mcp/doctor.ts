#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import sqlite3 from "sqlite3";
import { JLINK_MCP_VERSION } from "./version";

export interface DoctorCheck {
  id: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

export interface DoctorReport {
  status: "ok" | "error";
  product: "jlink-mcp";
  version: string;
  platform: string;
  architecture: string;
  node: string;
  checks: DoctorCheck[];
}

export async function runDoctor(): Promise<DoctorReport> {
  const packageRoot = resolve(__dirname, "..", "..");
  const checks: DoctorCheck[] = [
    check("platform", process.platform === "win32" && process.arch === "x64", `${process.platform}-${process.arch}`),
    check("node", supportedNode(), process.version),
    check("standalone", existsSync(join(packageRoot, "out", "mcp", "standalone.js")), join(packageRoot, "out", "mcp", "standalone.js")),
  ];

  checks.push(await checkSqlite());
  checks.push(checkHelper(packageRoot));
  checks.push(checkJlinkRuntime());

  return {
    status: checks.some((entry) => entry.status === "fail") ? "error" : "ok",
    product: "jlink-mcp",
    version: JLINK_MCP_VERSION,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    checks,
  };
}

async function checkSqlite(): Promise<DoctorCheck> {
  try {
    const database = await new Promise<sqlite3.Database>((resolveDatabase, rejectDatabase) => {
      const instance = new sqlite3.Database(":memory:", (error) => error ? rejectDatabase(error) : resolveDatabase(instance));
    });
    await new Promise<void>((resolveExec, rejectExec) => database.exec(
      "CREATE TABLE health(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO health(value) VALUES ('ok');",
      (error) => error ? rejectExec(error) : resolveExec(),
    ));
    await new Promise<void>((resolveClose, rejectClose) => database.close((error) => error ? rejectClose(error) : resolveClose()));
    return { id: "sqlite", status: "pass", detail: "in-memory create/write/close succeeded" };
  } catch (error) {
    return { id: "sqlite", status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

function checkHelper(packageRoot: string): DoctorCheck {
  const executable = join(packageRoot, "native", "hss-helper", "bin", "hss_helper.exe");
  if (!regularFile(executable)) return { id: "hss-helper", status: "fail", detail: `missing: ${executable}` };
  const result = spawnSync(executable, ["version"], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    return { id: "hss-helper", status: "fail", detail: result.error?.message ?? `exited ${String(result.status)}` };
  }
  try {
    const response = JSON.parse(result.stdout.trim());
    const valid = response.status === "ok"
      && response.helperProtocolVersion === 1
      && response.helperVersion === JLINK_MCP_VERSION
      && response.architecture === "x64";
    return {
      id: "hss-helper",
      status: valid ? "pass" : "fail",
      detail: valid ? `${response.helperVersion}, protocol ${response.helperProtocolVersion}, ${response.architecture}` : result.stdout.trim(),
    };
  } catch (error) {
    return { id: "hss-helper", status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

function checkJlinkRuntime(): DoctorCheck {
  const candidates = new Set<string>();
  for (const envPath of [process.env.JLINK_INSTALL_DIR, process.env.JLINK_DLL_PATH]) {
    if (envPath) candidates.add(envPath.toLowerCase().endsWith(".dll") ? dirname(envPath) : envPath);
  }
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (!root) continue;
    const segger = join(root, "SEGGER");
    if (!existsSync(segger)) continue;
    for (const entry of readdirSync(segger, { withFileTypes: true })) {
      if (entry.isDirectory() && /^JLink/i.test(entry.name)) candidates.add(join(segger, entry.name));
    }
  }
  for (const candidate of candidates) {
    if (["JLink_x64.dll", "JLinkARM.dll"].some((name) => regularFile(join(candidate, name)))) {
      return { id: "jlink-runtime", status: "pass", detail: candidate };
    }
  }
  return {
    id: "jlink-runtime",
    status: "warning",
    detail: "not discovered; install SEGGER J-Link Software or set JLINK_INSTALL_DIR",
  };
}

function supportedNode(): boolean {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 22 && major < 25;
}

function check(id: string, success: boolean, detail: string): DoctorCheck {
  return { id, status: success ? "pass" : "fail", detail };
}

function regularFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const report = await runDoctor();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "ok") process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
