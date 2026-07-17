import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { approvalBrokerEndpoint, runApprovalBrokerCli, startApprovalBrokerIpc, type R4ExecuteTool } from "./approval-broker";
import { checkR4ExecutionPermit, executeR4Operation, planR4Operation, type R4PlanInput } from "./risk-operations";
import { JLinkBackend } from "../probe/jlink";
import { ProbeErrorCode } from "../probe/backend";
import { ProcessManager } from "../utils/process-manager";
import { configureHssProjectPaths } from "./hss/project-paths";

test("R4 executor audits, atomically consumes, synchronizes event, and rejects replay", async () => {
  const temp = await tempProject();
  const root = temp.root;
  const input = planInput();
  const challenge = planR4Operation(input);
  const endpoint = approvalBrokerEndpoint(`${root}-${challenge.challengeId}`);
  const broker = await startApprovalBrokerIpc(endpoint);
  try {
    const token = await approve(endpoint, challenge.challengeId);
    let executions = 0;
    let events = 0;
    const hooks = {
      revalidate: () => input,
      execute: async (approval: { state: string; challengeId: string; operationDigest: string; nonceSha256: string }) => {
        executions += 1;
        assert.equal(approval.state, "consumed");
        assert.equal(approval.challengeId, challenge.challengeId);
        assert.equal(approval.operationDigest, challenge.operationDigest);
        assert.match(approval.nonceSha256, /^[0-9a-f]{64}$/);
        assert.equal("approvalToken" in approval, false);
        assert.equal(checkR4ExecutionPermit(input.tool, input.canonicalArgs, input.connectionGeneration), null);
        return { success: true, output: "ok" };
      },
      syncEvent: async () => { events += 1; },
    };
    const first = await executeR4Operation({ challengeId: challenge.challengeId, approvalToken: token, cwd: root }, hooks);
    assert.equal(first.ok, true, first.ok ? undefined : `${first.error.code}: ${first.error.message}`);
    assert.equal(executions, 1);
    assert.equal(events, 1);
    const replay = await executeR4Operation({ challengeId: challenge.challengeId, approvalToken: token, cwd: root }, hooks);
    assert.deepEqual(replay.ok ? null : replay.error.code, "approval_replayed");
    assert.equal(executions, 1);
  } finally {
    await broker.close();
    await temp.remove();
  }
});

test("missing, forged, mismatched, expired, and execute-time R5 approvals make zero executor calls", async () => {
  const temp = await tempProject();
  const root = temp.root;
  const endpoint = approvalBrokerEndpoint(`${root}-reject`);
  const broker = await startApprovalBrokerIpc(endpoint);
  let executions = 0;
  const execute = async () => { executions += 1; return { success: true }; };
  try {
    const missingInput = planInput();
    const missing = planR4Operation(missingInput);
    const missingResult = await executeR4Operation({ challengeId: missing.challengeId, cwd: root }, { revalidate: () => missingInput, execute });
    assert.equal(missingResult.ok ? null : missingResult.error.code, "approval_required", missingResult.ok ? undefined : missingResult.error.message);

    const forgedInput = planInput("erase", {});
    const forged = planR4Operation(forgedInput);
    const forgedToken = await approve(endpoint, forged.challengeId);
    const forgedResult = await executeR4Operation({ challengeId: forged.challengeId, approvalToken: forgedToken + "x", cwd: root }, { revalidate: () => forgedInput, execute });
    assert.equal(forgedResult.ok ? null : forgedResult.error.code, "approval_forged");

    const changedInput = planInput();
    const changed = planR4Operation(changedInput);
    const changedToken = await approve(endpoint, changed.challengeId);
    const changedResult = await executeR4Operation({ challengeId: changed.challengeId, approvalToken: changedToken, cwd: root }, {
      revalidate: () => ({ ...changedInput, layoutHash: "9".repeat(64) }), execute,
    });
    assert.equal(changedResult.ok ? null : changedResult.error.code, "operation_binding_changed");

    const r5Input = planInput("gdb_command", { command: "bt", timeout: 15000 });
    const r5 = planR4Operation(r5Input);
    const r5Token = await approve(endpoint, r5.challengeId);
    const r5Result = await executeR4Operation({ challengeId: r5.challengeId, approvalToken: r5Token, cwd: root }, {
      revalidate: () => ({ ...r5Input, forbiddenCategories: ["security"] }), execute,
    });
    assert.equal(r5Result.ok ? null : r5Result.error.code, "r5_forbidden");

    const expiredInput = { ...planInput(), ttlSeconds: 5 };
    const expired = planR4Operation(expiredInput);
    const expiredToken = await approve(endpoint, expired.challengeId);
    await delay(5100);
    const expiredResult = await executeR4Operation({ challengeId: expired.challengeId, approvalToken: expiredToken, cwd: root }, { revalidate: () => expiredInput, execute });
    assert.equal(expiredResult.ok ? null : expiredResult.error.code, "approval_expired");
    assert.equal(executions, 0);
  } finally {
    await broker.close();
    await temp.remove();
  }
});

test("R5 is rejected during planning for forbidden raw input, mismatch, and non-exception variable writes", () => {
  assert.throws(() => planR4Operation(planInput("gdb_command", { command: "source evil.gdb", timeout: 15000 })), /R5|forbidden|script/i);
  assert.throws(() => planR4Operation(planInput("probe_command", { commands: ["mem 0x0, 4\nexec evil"] })), /R5|CR|LF/i);
  assert.throws(() => planR4Operation({ ...planInput(), target: { targetId: "MCU", artifactMatch: "mismatch" } }), /mismatch/i);
  assert.throws(() => planR4Operation({
    ...planInput("variable_write_execute", { writePlanId: "wp_1" }),
    target: { targetId: "MCU", artifactMatch: "verified" },
    policy: { sha256: "4".repeat(64), unverifiedWriteException: true },
  }), /unverified-target/i);
});

test("J-Link flash, erase, and raw probe entry points reject token-free calls before connecting", async () => {
  const backend = new JLinkBackend({ device: "TEST", installDir: "must-not-spawn" }, new ProcessManager());
  try {
    for (const result of [await backend.flash("fixture.hex"), await backend.erase(), await backend.executeRaw(["regs"])]) {
      assert.equal(result.success, false);
      assert.equal(result.errorCode, ProbeErrorCode.APPROVAL_REQUIRED);
    }
    assert.equal(backend.getConnectionGeneration(), 0);
    const unknownRegion = await backend.executeRaw(["mem 0x1fff0000, 4"]);
    assert.equal(unknownRegion.errorCode, ProbeErrorCode.R5_FORBIDDEN);
    assert.equal((await backend.readRegister("UNKNOWN\nw4 0x0, 1")).errorCode, ProbeErrorCode.R5_FORBIDDEN);
    assert.equal(backend.getConnectionGeneration(), 0);
  } finally {
    backend.dispose();
  }
});

function planInput(tool: R4ExecuteTool = "flash", canonicalArgs: Record<string, unknown> = { filePath: "fixture.hex" }): R4PlanInput {
  return {
    tool,
    canonicalArgs,
    target: { targetId: "MCU", artifactMatch: tool === "variable_write_execute" ? "unverified" : "verified" },
    probe: { kind: tool === "gdb_command" ? "gdb" : "jlink", serial: "123" },
    artifact: { generation: "1".repeat(64), sha256: "2".repeat(64) },
    layoutHash: "3".repeat(64),
    policy: { sha256: "4".repeat(64), unverifiedWriteException: tool === "variable_write_execute" },
    session: { id: "session" },
    connectionGeneration: 3,
  };
}

async function approve(endpoint: string, challengeId: string): Promise<string> {
  void endpoint;
  let token = "";
  assert.equal(await runApprovalBrokerCli([challengeId, "--user-authorized", "true"], process.cwd(), (value) => { token = value; }), 0);
  return token;
}

function request(endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(response) as Record<string, unknown>));
  });
}

async function tempProject(): Promise<{ root: string; remove(): Promise<void> }> {
  const base = join(process.cwd(), ".tmp", `r4-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const root = join(base, "project");
  await mkdir(root, { recursive: true });
  configureHssProjectPaths(root, { storageRoot: join(base, "storage"), evidenceRoot: join(base, "evidence") });
  return { root, remove: () => rm(base, { recursive: true, force: true }) };
}
