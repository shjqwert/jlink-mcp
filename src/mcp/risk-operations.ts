import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { appendHssAudit } from "./hss/audit-log";
import {
  ApprovalError,
  consumeApproval,
  getApprovalChallenge,
  operationDigest,
  registerApprovalChallenge,
  verifyApprovalToken,
  type ApprovalErrorCode,
  type R4Challenge,
  type R4ExecuteTool,
  type R4OperationBinding,
} from "./approval-broker";

export interface R4PlanInput extends R4OperationBinding {
  forbiddenCategories?: string[];
  ttlSeconds?: number;
}

export type RiskOperationErrorCode = ApprovalErrorCode
  | "r5_forbidden"
  | "operation_binding_changed"
  | "native_r4_unavailable"
  | "operation_conflict"
  | "execution_failed"
  | "audit_failed";

export interface RiskOperationFailure {
  ok: false;
  error: { code: RiskOperationErrorCode; message: string };
  consumed: boolean;
}

export interface RiskOperationSuccess<T> {
  ok: true;
  data: T;
  challengeId: string;
  operationDigest: string;
  consumed: true;
}

export interface R4ExecutionHooks<T> {
  revalidate(): Promise<R4PlanInput> | R4PlanInput;
  execute(approval: R4ApprovalConsumptionEvidence): Promise<T>;
  syncEvent?(result: T): Promise<void>;
}

export interface R4ApprovalConsumptionEvidence {
  state: "consumed";
  challengeId: string;
  operationDigest: string;
  nonceSha256: string;
  consumedAt: string;
  expiresAt: string;
}

interface AuthorityPermit {
  challenge: R4Challenge;
  remainingHardwareCalls: number;
}

const authority = new AsyncLocalStorage<AuthorityPermit>();
let operationLock: Promise<void> = Promise.resolve();

export function planR4Operation(input: R4PlanInput): R4Challenge {
  const normalized = { ...input, canonicalArgs: canonicalR4Args(input.tool, input.canonicalArgs) };
  const binding = canonicalBinding(normalized);
  assertR4Allowed(normalized);
  return registerApprovalChallenge(binding, operationSummary(binding), input.ttlSeconds ?? 60);
}

export function flashPlan(input: Omit<R4PlanInput, "tool">): R4Challenge { return planR4Operation({ ...input, tool: "flash" }); }
export function erasePlan(input: Omit<R4PlanInput, "tool">): R4Challenge { return planR4Operation({ ...input, tool: "erase" }); }
export function gdbCommandPlan(input: Omit<R4PlanInput, "tool">): R4Challenge { return planR4Operation({ ...input, tool: "gdb_command" }); }
export function probeCommandPlan(input: Omit<R4PlanInput, "tool">): R4Challenge { return planR4Operation({ ...input, tool: "probe_command" }); }
export function unverifiedVariableWritePlan(input: Omit<R4PlanInput, "tool">): R4Challenge { return planR4Operation({ ...input, tool: "variable_write_execute" }); }

export async function executeR4Operation<T>(
  request: { challengeId: string; approvalToken?: string; cwd?: string },
  hooks: R4ExecutionHooks<T>,
): Promise<RiskOperationSuccess<T> | RiskOperationFailure> {
  return withOperationLock(async () => {
    let challenge: R4Challenge | undefined;
    let consumed = false;
    try {
      challenge = getApprovalChallenge(request.challengeId);
      const revalidated = await hooks.revalidate();
      const currentInput = { ...revalidated, canonicalArgs: canonicalR4Args(revalidated.tool, revalidated.canonicalArgs) };
      assertR4Allowed(currentInput);
      const current = canonicalBinding(currentInput);
      if (operationDigest(current) !== challenge.operationDigest || !sameBinding(current, challenge)) {
        throw new RiskOperationError("operation_binding_changed", "operation context changed after approval planning");
      }
      const verified = verifyApprovalToken(request.challengeId, request.approvalToken);
      try { await appendRiskAudit(challenge, "intent", { approvalVerified: true }, request.cwd); }
      catch (error) { throw new RiskOperationError("audit_failed", errorMessage(error)); }
      consumeApproval(request.challengeId, verified.nonce);
      consumed = true;
      const approval: R4ApprovalConsumptionEvidence = {
        state: "consumed",
        challengeId: challenge.challengeId,
        operationDigest: challenge.operationDigest,
        nonceSha256: createHash("sha256").update(challenge.nonce).digest("hex"),
        consumedAt: new Date().toISOString(),
        expiresAt: challenge.expiresAt,
      };
      let data: T;
      const permit: AuthorityPermit = { challenge, remainingHardwareCalls: 1 };
      try {
        data = await authority.run(permit, () => hooks.execute(approval));
        if (data && typeof data === "object" && (("success" in data && (data as { success?: unknown }).success === false) || ("ok" in data && (data as { ok?: unknown }).ok === false))) {
          const rejected = data as { code?: unknown; message?: unknown };
          throw new RiskOperationError(rejected.code === "native_r4_unavailable" ? "native_r4_unavailable" : "execution_failed", typeof rejected.message === "string" ? rejected.message : "bound hardware operation returned failure");
        }
        if (permit.remainingHardwareCalls !== 0) {
          throw new RiskOperationError("execution_failed", "approved executor did not issue its bound hardware operation");
        }
        await hooks.syncEvent?.(data);
      } catch (error) {
        try { await appendRiskAudit(challenge, "outcome", { ok: false, consumed: true, error: errorMessage(error), uncertain: true }, request.cwd); }
        catch (auditError) { return failure(new RiskOperationError("audit_failed", errorMessage(auditError)), true); }
        return failure(error, true);
      }
      try { await appendRiskAudit(challenge, "outcome", { ok: true, consumed: true }, request.cwd); }
      catch (error) { return failure(new RiskOperationError("audit_failed", errorMessage(error)), true); }
      return { ok: true, data, challengeId: challenge.challengeId, operationDigest: challenge.operationDigest, consumed: true };
    } catch (error) {
      if (challenge) {
        try { await appendRiskAudit(challenge, "rejected", { ok: false, consumed, error: errorMessage(error) }, request.cwd); }
        catch (auditError) { return failure(new RiskOperationError("audit_failed", errorMessage(auditError)), consumed); }
      }
      return failure(error, consumed);
    }
  });
}

export function checkR4ExecutionPermit(
  tool: R4ExecuteTool,
  canonicalArgs: Record<string, unknown>,
  connectionGeneration: number,
): { code: RiskOperationErrorCode; message: string } | null {
  const permit = authority.getStore();
  if (!permit) return { code: "approval_required", message: "a current trusted-host R4 approvalToken is required" };
  const expected = canonicalBinding({ ...permit.challenge, canonicalArgs: canonicalR4Args(tool, canonicalArgs) });
  if (
    permit.remainingHardwareCalls !== 1
    || permit.challenge.tool !== tool
    || permit.challenge.connectionGeneration !== connectionGeneration
    || operationDigest(expected) !== permit.challenge.operationDigest
  ) {
    return { code: "approval_mismatch", message: "R4 approval does not match tool, arguments, or physical connection generation" };
  }
  permit.remainingHardwareCalls = 0;
  return null;
}

export function classifyR4Operation(tool: R4ExecuteTool, canonicalArgs: Record<string, unknown>): { code: "r5_forbidden"; message: string } | null {
  if (tool === "gdb_command") {
    const command = canonicalArgs.command;
    if (typeof command !== "string") return r5("gdb_command requires one canonical command string");
    return validateRawCommands([command], GDB_VERBS, "GDB");
  }
  if (tool === "probe_command") {
    const commands = canonicalArgs.commands;
    if (!Array.isArray(commands) || commands.some((command) => typeof command !== "string")) return r5("probe_command requires canonical command strings");
    return validateRawCommands(commands as string[], PROBE_VERBS, "probe");
  }
  return null;
}

export function canonicalR4Args(tool: R4ExecuteTool, args: Record<string, unknown>): Record<string, unknown> {
  if (tool === "flash" && typeof args.filePath === "string") {
    return canonicalValue({ filePath: resolve(args.filePath), ...(args.baseAddress !== undefined ? { baseAddress: args.baseAddress } : {}) }) as Record<string, unknown>;
  }
  return canonicalValue(args) as Record<string, unknown>;
}

function assertR4Allowed(input: R4PlanInput): void {
  for (const value of [input.target.targetId, input.artifact.generation, input.artifact.sha256, input.layoutHash, input.policy.sha256, input.session.id]) {
    if (typeof value !== "string" || value.length === 0) throw new TypeError("R4 bindings require non-empty target, Artifact, layout, policy, and session identities");
  }
  for (const hash of [input.artifact.generation, input.artifact.sha256, input.layoutHash, input.policy.sha256]) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) throw new TypeError("R4 Artifact, layout, and policy hashes must be SHA-256 hex");
  }
  if (input.forbiddenCategories?.length) {
    throw new RiskOperationError("r5_forbidden", `R5 category is never approvable: ${input.forbiddenCategories.join(", ")}`);
  }
  if (input.target.artifactMatch === "mismatch") {
    throw new RiskOperationError("r5_forbidden", "target/Artifact mismatch is never approvable");
  }
  if (input.tool === "variable_write_execute") {
    if (input.target.artifactMatch !== "unverified" || input.policy.unverifiedWriteException !== true) {
      throw new RiskOperationError("r5_forbidden", "R4 variable writes are limited to an explicit unverified-target policy exception");
    }
  }
  if (input.tool === "flash") {
    const filePath = input.canonicalArgs.filePath;
    const baseAddress = input.canonicalArgs.baseAddress;
    if (typeof filePath !== "string" || !filePath || /[\r\n\0]/.test(filePath)) throw new RiskOperationError("r5_forbidden", "flash requires one canonical file path without control characters");
    if (baseAddress !== undefined && (!Number.isInteger(baseAddress) || (baseAddress as number) < 0)) throw new RiskOperationError("r5_forbidden", "flash baseAddress must be a non-negative integer");
  }
  if (input.tool === "erase" && Object.keys(input.canonicalArgs).length !== 0) throw new RiskOperationError("r5_forbidden", "erase accepts no arguments");
  if (input.tool === "variable_write_execute" && (typeof input.canonicalArgs.writePlanId !== "string" || !input.canonicalArgs.writePlanId)) {
    throw new RiskOperationError("r5_forbidden", "unverified variable execution requires one canonical writePlanId");
  }
  const raw = classifyR4Operation(input.tool, input.canonicalArgs);
  if (raw) throw new RiskOperationError(raw.code, raw.message);
}

function canonicalBinding(input: R4OperationBinding): R4OperationBinding {
  if (!Number.isInteger(input.connectionGeneration) || input.connectionGeneration < 1) throw new TypeError("connectionGeneration must be a positive integer");
  return canonicalValue({
    tool: input.tool,
    canonicalArgs: input.canonicalArgs,
    target: { targetId: input.target.targetId.trim(), artifactMatch: input.target.artifactMatch },
    probe: input.probe,
    artifact: { generation: input.artifact.generation.toLowerCase(), sha256: input.artifact.sha256.toLowerCase() },
    layoutHash: input.layoutHash.toLowerCase(),
    policy: { ...input.policy, sha256: input.policy.sha256.toLowerCase() },
    session: input.session,
    connectionGeneration: input.connectionGeneration,
  }) as R4OperationBinding;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("canonical operation contains a non-finite number");
  if (!["string", "number", "boolean"].includes(typeof value) && value !== null) throw new TypeError("canonical operation contains an unsupported value");
  return value;
}

function sameBinding(current: R4OperationBinding, challenge: R4Challenge): boolean {
  return operationDigest(current) === operationDigest(canonicalBinding(challenge));
}

function operationSummary(binding: R4OperationBinding): string {
  return `${binding.tool} ${JSON.stringify(binding.canonicalArgs)}\ntarget=${binding.target.targetId} match=${binding.target.artifactMatch} probe=${binding.probe.serial ?? binding.probe.kind} connectionGeneration=${binding.connectionGeneration}\nartifact=${binding.artifact.generation}/${binding.artifact.sha256} layout=${binding.layoutHash} policy=${binding.policy.sha256} session=${binding.session.id}`;
}

async function appendRiskAudit(challenge: R4Challenge, phase: "intent" | "outcome" | "rejected", output: Record<string, unknown>, cwd?: string): Promise<void> {
  await appendHssAudit(challenge.session.id, challenge.tool as never, challenge, {
    ...output,
    phase,
    risk: { level: "R4" },
    data: { challengeId: challenge.challengeId, operationDigest: challenge.operationDigest, policyHash: challenge.policy.sha256, symbolLayoutHash: challenge.layoutHash },
  }, cwd);
}

async function withOperationLock<T>(fn: () => Promise<T>): Promise<T> {
  // ponytail: global lock is the safe minimum; move to per-probe locks only if measured concurrency requires it.
  const previous = operationLock;
  let release!: () => void;
  operationLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await fn(); }
  finally { release(); }
}

function validateRawCommands(commands: string[], verbs: ReadonlySet<string>, label: string): { code: "r5_forbidden"; message: string } | null {
  if (commands.length === 0 || commands.length > 32) return r5(`${label} raw input must contain 1..32 commands`);
  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed || /[\r\n\0]/.test(command)) return r5(`${label} raw input contains CR, LF, NUL, or an empty command`);
    if (/(?:;|&&|\|\||\||`|\$\(|>|<)/.test(trimmed)) return r5(`${label} compound or shell-like input is forbidden`);
    if (/\b(?:security|option[ _-]?bytes?|protect(?:ion)?|reserved|forbidden|unlock|lockbits?|fuses?|python|shell|source|define|document|commands|macro|script)\b/i.test(trimmed)) {
      return r5(`${label} command may reach security, protection, reserved, script, macro, or shell behavior`);
    }
    const verb = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)/)?.[1].toLowerCase();
    if (!verb || !verbs.has(verb)) return r5(`${label} command verb cannot be proven below R5: ${verb ?? "unknown"}`);
  }
  return null;
}

function r5(message: string): { code: "r5_forbidden"; message: string } { return { code: "r5_forbidden", message }; }

function failure(error: unknown, consumed: boolean): RiskOperationFailure {
  if (error instanceof RiskOperationError || error instanceof ApprovalError) return { ok: false, error: { code: error.code, message: error.message }, consumed };
  return { ok: false, error: { code: "execution_failed", message: errorMessage(error) }, consumed };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class RiskOperationError extends Error {
  constructor(readonly code: RiskOperationErrorCode, message: string) {
    super(message);
    this.name = "RiskOperationError";
  }
}

const GDB_VERBS = new Set(["advance", "awatch", "b", "backtrace", "break", "bt", "c", "continue", "delete", "disable", "disassemble", "enable", "finish", "frame", "hbreak", "info", "list", "n", "next", "nexti", "ni", "p", "print", "rwatch", "s", "si", "step", "stepi", "thread", "until", "watch", "x"]);
const PROBE_VERBS = new Set(["clrbp", "go", "halt", "regs", "s", "setbp", "sleep"]);
