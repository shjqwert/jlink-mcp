import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  approvalBrokerEndpoint,
  registerApprovalChallenge,
  startApprovalBrokerIpc,
  verifyRetainedApproval,
  type R4OperationBinding,
} from "./approval-broker";
import { requestApprovalBroker } from "./approval-broker-ipc";

test("same-user API, raw IPC approval, non-interactive CLI, and authorization flags cannot retain approval", async () => {
  const base = join(process.cwd(), ".tmp", `approval-live-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const cwd = join(base, "project");
  const stateRoot = join(base, "state", "approval-broker");
  await mkdir(cwd, { recursive: true });
  const endpoint = approvalBrokerEndpoint(cwd, stateRoot);
  const broker = await startApprovalBrokerIpc(endpoint, cwd, stateRoot);
  try {
    const challenge = registerApprovalChallenge(binding(), "erase exact fixture", 60);
    await assert.rejects(
      requestApprovalBroker(cwd, { action: "approve", challengeId: challenge.challengeId, operationDigest: "0".repeat(64) }, stateRoot),
      (error: unknown) => code(error) === "approval_required",
    );
    await assert.rejects(
      requestApprovalBroker(cwd, {
        action: "approveInteractive",
        challengeId: challenge.challengeId,
        operationDigest: challenge.operationDigest,
        summary: challenge.summary,
        expiresAt: challenge.expiresAt,
        confirmation: challenge.challengeId,
        clientPid: process.pid,
      }, stateRoot),
      (error: unknown) => code(error) === "approval_nonlocal",
    );

    const nonInteractive = await runCli(cwd, stateRoot, [challenge.challengeId]);
    assert.equal(nonInteractive.code, 1);
    assert.match(nonInteractive.stdout, /real stdin\/stdout TTYs/);

    const flagged = await runCli(cwd, stateRoot, [challenge.challengeId, "--user-authorized", "true"]);
    assert.equal(flagged.code, 2);
    assert.match(flagged.stdout, /no non-interactive authorization flags/);

    const sessionFlagWithoutStartupGrant = await runCli(cwd, stateRoot, [challenge.challengeId, "--session-authorized"]);
    assert.equal(sessionFlagWithoutStartupGrant.code, 1);
    assert.match(sessionFlagWithoutStartupGrant.stdout, /session authorization is unavailable/);

    const imported = await runImportedApi(cwd, stateRoot, challenge.challengeId);
    assert.equal(imported.code, 0, imported.stderr);
    assert.match(imported.stdout, /real stdin\/stdout TTYs/);
    const directApi = await runDirectApi(cwd, stateRoot, challenge);
    assert.equal(directApi.code, 0, directApi.stderr);
    assert.equal(directApi.stdout, "");
    assert.throws(() => verifyRetainedApproval(challenge.challengeId), (error: unknown) => code(error) === "approval_required");
  } finally {
    await broker.close();
    await rm(base, { recursive: true, force: true });
  }
});

function binding(): R4OperationBinding {
  return {
    tool: "erase",
    canonicalArgs: {},
    target: { targetId: "Z20K146M", artifactMatch: "verified" },
    probe: { kind: "jlink", serial: "fixture", interface: "SWD", speedKhz: 4000 },
    artifact: { generation: "1".repeat(64), sha256: "2".repeat(64) },
    layoutHash: "3".repeat(64),
    policy: { sha256: "4".repeat(64), unverifiedWriteException: false },
    session: { id: "fixture-session" },
    connectionGeneration: 1,
  };
}

function runCli(cwd: string, stateRoot: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const standalone = join(__dirname, "standalone.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [standalone, "approve", ...args], {
      cwd,
      env: { ...process.env, JLINK_MCP_APPROVAL_ROOT: dirname(stateRoot) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (childCode) => resolve({ code: childCode, stdout, stderr }));
  });
}

function runImportedApi(cwd: string, stateRoot: string, challengeId: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const brokerModule = join(__dirname, "approval-broker.js");
  const script = "require(process.argv[1]).runApprovalBrokerCli([process.argv[2]], process.argv[3], process.argv[4]).then(code => process.exit(code === 1 ? 0 : 8))";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, brokerModule, challengeId, cwd, stateRoot], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (childCode) => resolve({ code: childCode, stdout, stderr }));
  });
}

function runDirectApi(cwd: string, stateRoot: string, challenge: { challengeId: string; operationDigest: string; summary: string; expiresAt: string }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const ipcModule = join(__dirname, "approval-broker-ipc.js");
  const script = `const i=require(process.argv[1]);const c=JSON.parse(process.argv[4]);i.requestApprovalBroker(process.argv[2],{action:'approveInteractive',...c,confirmation:c.challengeId,clientPid:process.pid,presenceEndpoint:'\\\\\\\\.\\\\pipe\\\\jlink-mcp-r4-presence-'+process.pid+'-'+('0'.repeat(32)),presenceDigest:'0'.repeat(64)},process.argv[3]).then(()=>process.exit(8),e=>process.exit(e.code==='approval_nonlocal'?0:9))`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, ipcModule, cwd, stateRoot, JSON.stringify(challenge)], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (childCode) => resolve({ code: childCode, stdout, stderr }));
  });
}

function code(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as { code?: string }).code : undefined;
}
