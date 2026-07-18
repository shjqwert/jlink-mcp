import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { approvalBrokerEndpoint, approvalBrokerStateRoot, requestApprovalBroker, startProtectedApprovalBrokerIpc, verifyInteractiveApprovalClient, type InteractiveApprovalClient } from "./approval-broker-ipc";

export { approvalBrokerEndpoint } from "./approval-broker-ipc";

export type R4ExecuteTool = "flash" | "erase" | "gdb_command" | "probe_command" | "variable_write_execute";

export interface R4OperationBinding {
  tool: R4ExecuteTool;
  canonicalArgs: Record<string, unknown>;
  target: { targetId: string; artifactMatch: "verified" | "unverified" | "mismatch" };
  probe: { kind: "jlink" | "gdb"; serial?: string; interface?: "SWD" | "JTAG"; speedKhz?: number };
  artifact: { generation: string; sha256: string };
  layoutHash: string;
  policy: { sha256: string; unverifiedWriteException: boolean };
  session: { id: string; captureId?: string };
  connectionGeneration: number;
}

export interface R4Challenge extends R4OperationBinding {
  challengeId: string;
  nonce: string;
  operationDigest: string;
  issuedAt: string;
  expiresAt: string;
  summary: string;
}

export type ApprovalErrorCode =
  | "approval_required"
  | "approval_expired"
  | "approval_mismatch"
  | "approval_replayed"
  | "approval_nonlocal";

export class ApprovalError extends Error {
  constructor(readonly code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

interface StoredChallenge {
  challenge: R4Challenge;
  remainingExecutions: number;
  approved: boolean;
}

const challenges = new Map<string, StoredChallenge>();

interface ApprovalCliIo {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  question(prompt: string): Promise<string>;
}

type InteractiveClientVerifier = (client: InteractiveApprovalClient) => boolean | Promise<boolean>;

export function registerApprovalChallenge(binding: R4OperationBinding, summary: string, ttlSeconds = 60): R4Challenge {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 300) {
    throw new RangeError("approval challenge TTL must be an integer from 5 to 300 seconds");
  }
  const issuedAt = new Date();
  const challenge: R4Challenge = {
    ...binding,
    challengeId: randomUUID(),
    nonce: randomBytes(32).toString("base64url"),
    operationDigest: operationDigest(binding),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
    summary,
  };
  challenges.set(challenge.challengeId, { challenge, remainingExecutions: 1, approved: false });
  return structuredClone(challenge);
}

export function getApprovalChallenge(challengeId: string): R4Challenge {
  const stored = challenges.get(challengeId);
  if (!stored) throw new ApprovalError("approval_required", "approval challenge was not issued by this process");
  return structuredClone(stored.challenge);
}

export function verifyRetainedApproval(challengeId: string, now = Date.now()): R4Challenge {
  const stored = challenges.get(challengeId);
  if (!stored) throw new ApprovalError("approval_required", "approval challenge was not issued by this process");
  if (stored.remainingExecutions === 0) throw new ApprovalError("approval_replayed", "approval was already consumed");
  if (now > Date.parse(stored.challenge.expiresAt)) throw new ApprovalError("approval_expired", "approval challenge expired");
  if (!stored.approved) throw new ApprovalError("approval_required", "the exact challenge has not been approved in the protected local CLI");
  return structuredClone(stored.challenge);
}

export function consumeApproval(challengeId: string, nonce: string): void {
  const stored = challenges.get(challengeId);
  if (!stored) throw new ApprovalError("approval_required", "approval challenge was not issued by this process");
  if (stored.remainingExecutions === 0) throw new ApprovalError("approval_replayed", "approval was already consumed");
  if (!stored.approved) throw new ApprovalError("approval_required", "the exact challenge has not been approved in the protected local CLI");
  if (stored.challenge.nonce !== nonce) throw new ApprovalError("approval_mismatch", "approval nonce does not match");
  stored.remainingExecutions = 0;
  stored.approved = false;
}

export function operationDigest(binding: R4OperationBinding): string {
  return createHash("sha256").update(stableJson(binding)).digest("hex");
}

export async function startApprovalBrokerIpc(
  endpoint = approvalBrokerEndpoint(),
  cwd = process.cwd(),
  stateRoot = approvalBrokerStateRoot(),
  verifyInteractiveClient: InteractiveClientVerifier = verifyInteractiveApprovalClient,
  sessionAuthorizationSecret = process.env.JLINK_MCP_R4_SESSION_AUTHORIZATION,
): Promise<{ endpoint: string; locatorFile: string; close(): Promise<void> }> {
  const sessionAuthorizationDigest = authorizationDigest(sessionAuthorizationSecret);
  return startProtectedApprovalBrokerIpc({
    endpoint,
    cwd,
    stateRoot,
    handle: (request) => handleBrokerRequest(request, verifyInteractiveClient, sessionAuthorizationDigest),
  });
}

export async function runApprovalBrokerCli(
  args: string[],
  cwd = process.cwd(),
  stateRoot = approvalBrokerStateRoot(),
  io: ApprovalCliIo = processApprovalCliIo(),
): Promise<number> {
  const challengeId = args[0];
  const sessionAuthorized = args.length === 2 && args[1] === "--session-authorized";
  if (!challengeId) {
    io.output.write("Usage: jlink-mcp approve <challengeId>\n");
    return 2;
  }
  if (args.length !== 1 && !sessionAuthorized) {
    io.output.write("Approval accepts no non-interactive authorization flags.\n");
    return 2;
  }
  const sessionAuthorizationSecret = process.env.JLINK_MCP_R4_SESSION_AUTHORIZATION;
  if (sessionAuthorized && !authorizationDigest(sessionAuthorizationSecret)) {
    io.output.write("approval_nonlocal: session authorization is unavailable\n");
    return 1;
  }
  if (!sessionAuthorized && (!io.input.isTTY || !io.output.isTTY)) {
    io.output.write("Interactive approval requires real stdin/stdout TTYs.\n");
    return 1;
  }
  let challenge: Pick<R4Challenge, "challengeId" | "summary" | "expiresAt" | "operationDigest">;
  try {
    const inspected = await requestApprovalBroker(cwd, { action: "inspect", challengeId }, stateRoot);
    challenge = {
      challengeId: requiredString(inspected.challengeId, "challengeId"),
      summary: requiredString(inspected.summary, "summary"),
      expiresAt: requiredString(inspected.expiresAt, "expiresAt"),
      operationDigest: requiredString(inspected.operationDigest, "operationDigest"),
    };
  }
  catch (error) {
    const rejected = brokerError(error);
    io.output.write(`${rejected.code}: ${rejected.message}\n`);
    return 1;
  }
  if (challenge.challengeId !== challengeId || !/^[0-9a-f-]{36}$/i.test(challenge.challengeId)
      || !/^[0-9a-f]{64}$/i.test(challenge.operationDigest) || !Number.isFinite(Date.parse(challenge.expiresAt))) {
    io.output.write("approval_mismatch: approval broker returned an invalid challenge binding\n");
    return 1;
  }
  io.output.write(`\nR4 approval challenge\nChallenge ID: ${challenge.challengeId}\nOperation digest: ${challenge.operationDigest}\nSummary: ${JSON.stringify(challenge.summary)}\nExpires at: ${challenge.expiresAt}\n`);
  if (sessionAuthorized) {
    try {
      const approved = await requestApprovalBroker(cwd, {
        action: "approveSession",
        challengeId: challenge.challengeId,
        operationDigest: challenge.operationDigest,
        summary: challenge.summary,
        expiresAt: challenge.expiresAt,
        confirmation: challenge.challengeId,
        sessionAuthorizationSecret,
      }, stateRoot);
      if (approved.approved !== true) throw new ApprovalError("approval_required", "approval broker did not retain the session approval");
      io.output.write("Approval retained by the broker for one exact session-authorized execution.\n");
      return 0;
    }
    catch (error) {
      const rejected = brokerError(error);
      io.output.write(`${rejected.code}: ${rejected.message}\n`);
      return 1;
    }
  }
  const authorized = (await io.question(`Type the exact challenge ID ${challenge.challengeId} to approve: `)).trim() === challenge.challengeId;
  if (!authorized) {
    io.output.write("Approval denied.\n");
    return 1;
  }
  let presence: Awaited<ReturnType<typeof startPresenceProof>> | undefined;
  try {
    presence = await startPresenceProof(stateRoot);
    const approved = await requestApprovalBroker(cwd, {
      action: "approveInteractive",
      challengeId: challenge.challengeId,
      operationDigest: challenge.operationDigest,
      summary: challenge.summary,
      expiresAt: challenge.expiresAt,
      confirmation: challenge.challengeId,
      clientPid: process.pid,
      ...presence.request,
    }, stateRoot);
    if (approved.approved !== true) throw new ApprovalError("approval_required", "approval broker did not retain the approval");
  }
  catch (error) {
    const rejected = brokerError(error);
    io.output.write(`${rejected.code}: ${rejected.message}\n`);
    return 1;
  }
  finally {
    await presence?.close().catch(() => undefined);
  }
  io.output.write("Approval retained by the broker for one exact execution.\n");
  return 0;
}

async function handleBrokerRequest(
  request: Record<string, unknown>,
  verifyInteractiveClient: InteractiveClientVerifier,
  sessionAuthorizationDigest?: Buffer,
): Promise<Record<string, unknown>> {
  if (!request.challengeId) throw new ApprovalError("approval_required", "challengeId is required");
  const challenge = getApprovalChallenge(String(request.challengeId));
  if (Date.now() > Date.parse(challenge.expiresAt)) throw new ApprovalError("approval_expired", "approval challenge expired");
  if (request.action === "inspect") {
    return { challengeId: challenge.challengeId, summary: challenge.summary, expiresAt: challenge.expiresAt, operationDigest: challenge.operationDigest };
  }
  if (request.action === "approveInteractive") {
    if (request.operationDigest !== challenge.operationDigest || request.summary !== challenge.summary
        || request.expiresAt !== challenge.expiresAt || request.confirmation !== challenge.challengeId) {
      throw new ApprovalError("approval_mismatch", "approval request does not match the exact live challenge");
    }
    if (!await verifyInteractiveClient({
      pid: Number(request.clientPid),
      challengeId: challenge.challengeId,
      presenceEndpoint: String(request.presenceEndpoint ?? ""),
      presenceDigest: String(request.presenceDigest ?? ""),
    })) {
      throw new ApprovalError("approval_nonlocal", "approval requires the protected CLI in a real local TTY");
    }
    retainApproval(challenge);
    return { approved: true };
  }
  if (request.action === "approveSession") {
    if (request.operationDigest !== challenge.operationDigest || request.summary !== challenge.summary
        || request.expiresAt !== challenge.expiresAt || request.confirmation !== challenge.challengeId) {
      throw new ApprovalError("approval_mismatch", "approval request does not match the exact live challenge");
    }
    const suppliedDigest = authorizationDigest(typeof request.sessionAuthorizationSecret === "string" ? request.sessionAuthorizationSecret : undefined);
    if (!sessionAuthorizationDigest || !suppliedDigest || !timingSafeEqual(sessionAuthorizationDigest, suppliedDigest)) {
      throw new ApprovalError("approval_nonlocal", "session authorization does not match the broker startup grant");
    }
    retainApproval(challenge);
    return { approved: true };
  }
  throw new ApprovalError("approval_required", "approval broker action is unsupported");
}

function retainApproval(challenge: R4Challenge): void {
  const stored = challenges.get(challenge.challengeId);
  if (!stored || stored.remainingExecutions === 0) throw new ApprovalError("approval_replayed", "approval was already consumed");
  if (Date.now() > Date.parse(stored.challenge.expiresAt)) throw new ApprovalError("approval_expired", "approval challenge expired");
  if (stableJson(challenge) !== stableJson(stored.challenge)) throw new ApprovalError("approval_mismatch", "approval request does not match the stored challenge");
  if (stored.approved) throw new ApprovalError("approval_replayed", "approval was already retained");
  stored.approved = true;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("canonical operation contains an unsupported value");
  return encoded;
}

function brokerError(error: unknown): { code: string; message: string } {
  const typed = error as { code?: unknown; message?: unknown } | undefined;
  return {
    code: error instanceof ApprovalError ? error.code : typeof typed?.code === "string" ? typed.code : "approval_required",
    message: error instanceof Error ? error.message : typeof typed?.message === "string" ? typed.message : String(error),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new ApprovalError("approval_required", `approval broker response is missing ${name}`);
  return value;
}

function authorizationDigest(secret: string | undefined): Buffer | undefined {
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined;
  return createHash("sha256").update(secret).digest();
}

function processApprovalCliIo(): ApprovalCliIo {
  return {
    input: process.stdin,
    output: process.stdout,
    question: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(prompt); }
      finally { rl.close(); }
    },
  };
}

async function startPresenceProof(stateRoot: string): Promise<{
  request: { presenceEndpoint: string; presenceDigest: string };
  close(): Promise<void>;
}> {
  const secret = randomBytes(32).toString("base64url");
  const suffix = randomBytes(16).toString("hex");
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\jlink-mcp-r4-presence-${process.pid}-${suffix}`
    : join(stateRoot, `presence-${process.pid}-${suffix}.sock`);
  const server = createServer((socket) => socket.end(secret));
  await listenPresence(server, endpoint);
  return {
    request: { presenceEndpoint: endpoint, presenceDigest: createHash("sha256").update(secret).digest("hex") },
    close: async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (process.platform !== "win32") await rm(endpoint, { force: true });
    },
  };
}

function listenPresence(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
  });
}
