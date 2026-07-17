import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import * as brokerModule from "./approval-broker";
import {
  approvalBrokerEndpoint,
  consumeApproval,
  registerApprovalChallenge,
  runApprovalBrokerCli,
  startApprovalBrokerIpc,
  verifyApprovalToken,
  type R4OperationBinding,
} from "./approval-broker";

test("raw IPC cannot authorize; in-process standalone CLI issues one HMAC-bound approval", async () => {
  const challenge = registerApprovalChallenge(binding(), "flash exact fixture", 60);
  assert.match(challenge.challengeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(Buffer.from(challenge.nonce, "base64url").length, 32);
  assert.match(challenge.operationDigest, /^[0-9a-f]{64}$/);
  const endpoint = approvalBrokerEndpoint(`${process.cwd()}-${challenge.challengeId}`);
  const server = await startApprovalBrokerIpc(endpoint);
  try {
    const inspected = await request(endpoint, { action: "inspect", challengeId: challenge.challengeId });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.summary, "flash exact fixture");
    const unauthorized = await request(endpoint, { action: "authorize", challengeId: challenge.challengeId, directUserAuthorization: true });
    assert.equal(unauthorized.ok, false);
    assert.equal((unauthorized.error as { code: string }).code, "approval_required");
    let approvalToken = "";
    assert.equal(await runApprovalBrokerCli([challenge.challengeId, "--user-authorized", "true"], process.cwd(), (token) => { approvalToken = token; }), 0);
    assert.equal(verifyApprovalToken(challenge.challengeId, approvalToken).operationDigest, challenge.operationDigest);
    const restarted = spawnSync(process.execPath, ["-e", "const b=require(process.argv[1]);try{b.verifyApprovalToken(process.argv[2],process.argv[3]);process.exit(2)}catch(e){process.exit(e.code==='approval_required'?0:3)}", join(__dirname, "approval-broker.js"), challenge.challengeId, approvalToken]);
    assert.equal(restarted.status, 0, "a token from this process must fail after process restart");
    consumeApproval(challenge.challengeId, challenge.nonce);
    assert.throws(() => verifyApprovalToken(challenge.challengeId, approvalToken), (error: unknown) => brokerCode(error) === "approval_replayed");
    assert.equal(await runApprovalBrokerCli([challenge.challengeId, "--user-authorized", "true"], process.cwd(), () => undefined), 1);
  } finally {
    await server.close();
  }
  assert.equal("issueApprovalToken" in brokerModule, false);
  assert.equal("processSecret" in brokerModule, false);
});

test("approval challenge enforces the 5..300 second TTL boundary", () => {
  assert.throws(() => registerApprovalChallenge(binding(), "x", 4), /5 to 300/);
  assert.throws(() => registerApprovalChallenge(binding(), "x", 301), /5 to 300/);
  assert.doesNotThrow(() => registerApprovalChallenge(binding(), "x", 5));
  assert.doesNotThrow(() => registerApprovalChallenge(binding(), "x", 300));
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
