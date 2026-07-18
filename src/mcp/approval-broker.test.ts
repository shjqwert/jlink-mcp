import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import * as brokerModule from "./approval-broker";
import {
  approvalBrokerEndpoint,
  consumeApproval,
  registerApprovalChallenge,
  runApprovalBrokerCli,
  startApprovalBrokerIpc,
  verifyRetainedApproval,
  type R4OperationBinding,
} from "./approval-broker";

test("raw IPC cannot authorize; the protected local CLI retains one exact approval without exposing a token", async () => {
  const challenge = registerApprovalChallenge(binding(), "flash exact fixture", 60);
  assert.match(challenge.challengeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(Buffer.from(challenge.nonce, "base64url").length, 32);
  assert.match(challenge.operationDigest, /^[0-9a-f]{64}$/);
  const endpoint = approvalBrokerEndpoint(`${process.cwd()}-${challenge.challengeId}`);
  const stateRoot = join(process.cwd(), ".tmp", `approval-broker-${challenge.challengeId}`, "approval-broker");
  await mkdir(stateRoot, { recursive: true });
  const server = await startApprovalBrokerIpc(endpoint, process.cwd(), stateRoot, () => true);
  try {
    const inspected = await request(endpoint, { action: "inspect", challengeId: challenge.challengeId });
    assert.equal(inspected.ok, false);
    assert.equal((inspected.error as { code: string }).code, "approval_nonlocal");
    const unauthorized = await request(endpoint, { action: "authorize", challengeId: challenge.challengeId, directUserAuthorization: true });
    assert.equal(unauthorized.ok, false);
    assert.equal((unauthorized.error as { code: string }).code, "approval_nonlocal");
    const output: string[] = [];
    assert.equal(await runApprovalBrokerCli([challenge.challengeId], process.cwd(), stateRoot, interactiveIo(challenge.challengeId, output)), 0);
    assert.match(output.join(""), new RegExp(challenge.challengeId));
    assert.match(output.join(""), new RegExp(challenge.operationDigest));
    assert.match(output.join(""), /flash exact fixture/);
    assert.match(output.join(""), new RegExp(challenge.expiresAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output.join(""), /retained by the broker/);
    assert.doesNotMatch(output.join(""), /approvalToken|eyJ/);
    assert.equal(verifyRetainedApproval(challenge.challengeId).operationDigest, challenge.operationDigest);
    const restarted = spawnSync(process.execPath, ["-e", "const b=require(process.argv[1]);try{b.verifyRetainedApproval(process.argv[2]);process.exit(2)}catch(e){process.exit(e.code==='approval_required'?0:3)}", join(__dirname, "approval-broker.js"), challenge.challengeId]);
    assert.equal(restarted.status, 0, "a retained approval must not survive process restart");
    consumeApproval(challenge.challengeId, challenge.nonce);
    assert.throws(() => verifyRetainedApproval(challenge.challengeId), (error: unknown) => brokerCode(error) === "approval_replayed");
    assert.equal(await runApprovalBrokerCli([challenge.challengeId], process.cwd(), stateRoot, interactiveIo(challenge.challengeId)), 1);
  } finally {
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
  assert.equal("issueApprovalToken" in brokerModule, false);
  assert.equal("processSecret" in brokerModule, false);
  assert.equal("verifyApprovalToken" in brokerModule, false);
});

test("approval challenge enforces the 5..300 second TTL boundary", () => {
  assert.throws(() => registerApprovalChallenge(binding(), "x", 4), /5 to 300/);
  assert.throws(() => registerApprovalChallenge(binding(), "x", 301), /5 to 300/);
  assert.doesNotThrow(() => registerApprovalChallenge(binding(), "x", 5));
  assert.doesNotThrow(() => registerApprovalChallenge(binding(), "x", 300));
});

test("an explicit ephemeral startup grant retains one exact session approval without a TTY", async () => {
  const challenge = registerApprovalChallenge(binding(), "session-authorized flash fixture", 60);
  const endpoint = approvalBrokerEndpoint(`${process.cwd()}-${challenge.challengeId}`);
  const stateRoot = join(process.cwd(), ".tmp", `approval-session-${challenge.challengeId}`, "approval-broker");
  const secret = "a".repeat(43);
  const previous = process.env.JLINK_MCP_R4_SESSION_AUTHORIZATION;
  await mkdir(stateRoot, { recursive: true });
  const server = await startApprovalBrokerIpc(endpoint, process.cwd(), stateRoot, () => false, secret);
  try {
    process.env.JLINK_MCP_R4_SESSION_AUTHORIZATION = "b".repeat(43);
    assert.equal(await runApprovalBrokerCli([challenge.challengeId, "--session-authorized"], process.cwd(), stateRoot, nonInteractiveIo()), 1);
    assert.throws(() => verifyRetainedApproval(challenge.challengeId), (error: unknown) => brokerCode(error) === "approval_required");
    const output: string[] = [];
    process.env.JLINK_MCP_R4_SESSION_AUTHORIZATION = secret;
    assert.equal(await runApprovalBrokerCli([challenge.challengeId, "--session-authorized"], process.cwd(), stateRoot, nonInteractiveIo(output)), 0);
    assert.match(output.join(""), /one exact session-authorized execution/);
    assert.doesNotMatch(output.join(""), new RegExp(secret));
    assert.equal(verifyRetainedApproval(challenge.challengeId).operationDigest, challenge.operationDigest);
    consumeApproval(challenge.challengeId, challenge.nonce);
    assert.throws(() => verifyRetainedApproval(challenge.challengeId), (error: unknown) => brokerCode(error) === "approval_replayed");
  } finally {
    if (previous === undefined) delete process.env.JLINK_MCP_R4_SESSION_AUTHORIZATION;
    else process.env.JLINK_MCP_R4_SESSION_AUTHORIZATION = previous;
    await server.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

function binding(): R4OperationBinding {
  return {
    tool: "flash",
    canonicalArgs: { filePath: "fixture.hex" },
    target: { targetId: "MCU", artifactMatch: "verified" },
    probe: { kind: "jlink", serial: "123" },
    artifact: { generation: "1".repeat(64), sha256: "2".repeat(64) },
    layoutHash: "3".repeat(64),
    policy: { sha256: "4".repeat(64), unverifiedWriteException: false },
    session: { id: "session" },
    connectionGeneration: 1,
  };
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

function brokerCode(error: unknown): string | undefined { return error && typeof error === "object" ? (error as { code?: string }).code : undefined; }

function interactiveIo(challengeId: string, output: string[] = []) {
  return {
    input: { isTTY: true } as NodeJS.ReadStream,
    output: { isTTY: true, write: (value: string | Uint8Array) => { output.push(String(value)); return true; } } as NodeJS.WriteStream,
    question: async () => challengeId,
  };
}

function nonInteractiveIo(output: string[] = []) {
  return {
    input: { isTTY: false } as NodeJS.ReadStream,
    output: { isTTY: false, write: (value: string | Uint8Array) => { output.push(String(value)); return true; } } as NodeJS.WriteStream,
    question: async () => { throw new Error("session authorization must not prompt"); },
  };
}
