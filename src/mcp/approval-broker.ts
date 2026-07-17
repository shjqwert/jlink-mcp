import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { createInterface } from "node:readline/promises";

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
  | "approval_forged"
  | "approval_replayed";

export class ApprovalError extends Error {
  constructor(readonly code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

interface StoredChallenge {
  challenge: R4Challenge;
  remainingExecutions: number;
}

interface ApprovalTokenPayload extends R4Challenge {
  version: 1;
  executionBudget: 1;
}

const processSecret = randomBytes(32);
const challenges = new Map<string, StoredChallenge>();

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
  challenges.set(challenge.challengeId, { challenge, remainingExecutions: 1 });
  return structuredClone(challenge);
}

export function getApprovalChallenge(challengeId: string): R4Challenge {
  const stored = challenges.get(challengeId);
  if (!stored) throw new ApprovalError("approval_required", "approval challenge was not issued by this process");
  return structuredClone(stored.challenge);
}

export function verifyApprovalToken(challengeId: string, token: string | undefined, now = Date.now()): R4Challenge {
  if (!token) throw new ApprovalError("approval_required", "approvalToken is required");
  const stored = challenges.get(challengeId);
  if (!stored) throw new ApprovalError("approval_required", "approval challenge was not issued by this process");
  if (stored.remainingExecutions === 0) throw new ApprovalError("approval_replayed", "approval was already consumed");
  if (now > Date.parse(stored.challenge.expiresAt)) throw new ApprovalError("approval_expired", "approval challenge expired");
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw new ApprovalError("approval_forged", "approval token format is invalid");
  const expected = createHmac("sha256", processSecret).update(encoded).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); } catch { throw new ApprovalError("approval_forged", "approval token signature is invalid"); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ApprovalError("approval_forged", "approval token signature is invalid");
  }
  let payload: ApprovalTokenPayload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ApprovalTokenPayload; }
  catch { throw new ApprovalError("approval_forged", "approval token payload is invalid"); }
  const expectedPayload: ApprovalTokenPayload = { version: 1, executionBudget: 1, ...stored.challenge };
  if (stableJson(payload) !== stableJson(expectedPayload)) {
    throw new ApprovalError("approval_mismatch", "approval token does not match the current challenge");
  }
  return structuredClone(stored.challenge);
}

export function consumeApproval(challengeId: string, nonce: string): void {
  const stored = challenges.get(challengeId);
  if (!stored) throw new ApprovalError("approval_required", "approval challenge was not issued by this process");
  if (stored.remainingExecutions === 0) throw new ApprovalError("approval_replayed", "approval was already consumed");
  if (stored.challenge.nonce !== nonce) throw new ApprovalError("approval_mismatch", "approval nonce does not match");
  stored.remainingExecutions = 0;
}

export function operationDigest(binding: R4OperationBinding): string {
  return createHash("sha256").update(stableJson(binding)).digest("hex");
}

export function approvalBrokerEndpoint(cwd = process.cwd()): string {
  const id = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
  return process.platform === "win32" ? `\\\\.\\pipe\\jlink-mcp-r4-${id}` : join(tmpdir(), `jlink-mcp-r4-${id}.sock`);
}

export async function startApprovalBrokerIpc(endpoint = approvalBrokerEndpoint()): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      request += chunk;
      if (request.length > 64 * 1024) socket.destroy(new Error("approval broker request is too large"));
      if (!request.includes("\n")) return;
      const line = request.slice(0, request.indexOf("\n"));
      void handleBrokerRequest(line).then(
        (response) => socket.end(JSON.stringify({ ok: true, ...response }) + "\n"),
        (error) => socket.end(JSON.stringify({ ok: false, error: brokerError(error) }) + "\n"),
      );
    });
  });
  await listen(server, endpoint);
  return { endpoint, close: () => closeServer(server) };
}

export async function runApprovalBrokerCli(args: string[], cwd = process.cwd(), emitToken: (token: string) => void = (token) => { process.stdout.write(token + "\n"); }): Promise<number> {
  const challengeId = args[0];
  if (!challengeId) {
    process.stderr.write("Usage: jlink-mcp approve <challengeId> [--user-authorized true]\n");
    return 2;
  }
  const direct = args[1] === "--user-authorized" && args[2] === "true" && args.length === 3;
  if (args.length > 1 && !direct) {
    process.stderr.write("Only --user-authorized true is accepted for explicit direct-user authorization.\n");
    return 2;
  }
  let challenge: R4Challenge;
  try { challenge = getApprovalChallenge(challengeId); }
  catch (error) {
    const rejected = brokerError(error);
    process.stderr.write(`${rejected.code}: ${rejected.message}\n`);
    return 1;
  }
  process.stderr.write(`\nR4 approval challenge\n${challenge.summary}\nExpires: ${challenge.expiresAt}\nDigest: ${challenge.operationDigest}\n`);
  let authorized = direct;
  if (!authorized) {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      process.stderr.write("Interactive approval requires a local TTY.\n");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { authorized = (await rl.question("Approve this exact operation? Type 'approve': ")).trim() === "approve"; }
    finally { rl.close(); }
  }
  if (!authorized) {
    process.stderr.write("Approval denied.\n");
    return 1;
  }
  let approvalToken: string;
  try { approvalToken = issueApprovalToken(challenge); }
  catch (error) {
    const rejected = brokerError(error);
    process.stderr.write(`${rejected.code}: ${rejected.message}\n`);
    return 1;
  }
  emitToken(approvalToken);
  return 0;
}

async function handleBrokerRequest(line: string): Promise<Record<string, unknown>> {
  const request = JSON.parse(line) as { action?: string; challengeId?: string };
  if (!request.challengeId) throw new ApprovalError("approval_required", "challengeId is required");
  const challenge = getApprovalChallenge(request.challengeId);
  if (Date.now() > Date.parse(challenge.expiresAt)) throw new ApprovalError("approval_expired", "approval challenge expired");
  if (request.action === "inspect") {
    return { challengeId: challenge.challengeId, summary: challenge.summary, expiresAt: challenge.expiresAt, operationDigest: challenge.operationDigest };
  }
  throw new ApprovalError("approval_required", "approval signing is not available over IPC; use the in-process standalone CLI");
}

function issueApprovalToken(challenge: R4Challenge): string {
  const stored = challenges.get(challenge.challengeId);
  if (!stored || stored.remainingExecutions === 0) throw new ApprovalError("approval_replayed", "approval was already consumed");
  const encoded = Buffer.from(stableJson({ version: 1, executionBudget: 1, ...challenge } satisfies ApprovalTokenPayload), "utf8").toString("base64url");
  const signature = createHmac("sha256", processSecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
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
  return error instanceof ApprovalError
    ? { code: error.code, message: error.message }
    : { code: "approval_required", message: error instanceof Error ? error.message : String(error) };
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => { server.off("error", reject); resolve(); });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
