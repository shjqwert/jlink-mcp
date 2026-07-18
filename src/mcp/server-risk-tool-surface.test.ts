import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JLinkMcpServer } from "./server";
import { approvalBrokerEndpoint, runApprovalBrokerCli, startApprovalBrokerIpc, type R4OperationBinding } from "./approval-broker";
import { configureHssProjectPaths } from "./hss/project-paths";

const approvalTestRoot = join(tmpdir(), `server-risk-approval-${process.pid}-${randomUUID()}`);
const approvalStateRoot = join(approvalTestRoot, "approval-broker");
let approvalBroker: Awaited<ReturnType<typeof startApprovalBrokerIpc>>;

test.before(async () => {
  await mkdir(approvalTestRoot, { recursive: true });
  configureHssProjectPaths(process.cwd(), {
    storageRoot: join(approvalTestRoot, "storage"),
    evidenceRoot: join(approvalTestRoot, "evidence"),
  });
  approvalBroker = await startApprovalBrokerIpc(approvalBrokerEndpoint(approvalTestRoot, approvalStateRoot), approvalTestRoot, approvalStateRoot, () => true);
});

test.after(async () => {
  await approvalBroker.close();
  await rm(approvalTestRoot, { recursive: true, force: true });
});

test("CPU tools preserve text semantics and expose the complete structured R3 envelope", async () => {
  const instance = new JLinkMcpServer();
  try {
    const typed = instance as unknown as {
      hssCapture: { cpuControl(operation: string, input?: unknown): Promise<Record<string, unknown>> };
      server: { _registeredTools: Record<string, { handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }> }> };
    };
    let hardwareExecutions = 0;
    typed.hssCapture.cpuControl = async (operation) => {
      hardwareExecutions += 1;
      return {
        ok: true,
        operation,
        data: { binding: { planId: "op_cpu", digest: "a".repeat(64) }, planId: "op_cpu", planDigest: "a".repeat(64), auditId: "audit_cpu" },
        risk: { level: "R3", requiresUserApproval: false },
        backend: { selected: "jlink-hss", fallbackFrom: null, reason: null },
        artifacts: [], warnings: [], message: "completed",
      };
    };
    const halt = await typed.server._registeredTools.halt.handler({});
    assert.equal(halt.content[0].text, "CPU halted");
    assert.equal(halt.structuredContent?.risk && (halt.structuredContent.risk as { level: string }).level, "R3");
    assert.equal((halt.structuredContent?.data as { planId: string }).planId, "op_cpu");
    assert.equal((halt.structuredContent?.data as { planDigest: string }).planDigest, "a".repeat(64));
    assert.equal((halt.structuredContent?.data as { auditId: string }).auditId, "audit_cpu");

    typed.hssCapture.cpuControl = async (operation) => ({
      ok: false,
      operation,
      data: null,
      risk: { level: "R3", requiresUserApproval: false },
      backend: { selected: null, fallbackFrom: null, reason: "active capture" },
      artifacts: [], warnings: [], message: "failed",
      error: { code: "capture_conflict", message: "active capture", details: { hardwareActionIssued: false } },
    });
    const reset = await typed.server._registeredTools.reset.handler({ halt: false });
    assert.equal(reset.content[0].text, "Failed: capture_conflict: active capture");
    assert.equal((reset.structuredContent?.error as { code: string }).code, "capture_conflict");
    assert.equal(((reset.structuredContent?.error as { details: { hardwareActionIssued: boolean } }).details.hardwareActionIssued), false);
    assert.equal(hardwareExecutions, 1);
  } finally {
    await instance.dispose();
  }
});

test("public R4 tools expose plans, reject caller tokens, and hide approval issuance", async () => {
  const instance = new JLinkMcpServer();
  try {
    const typed = instance as unknown as {
      probe: { setDevice(device: string): void };
      server: { _registeredTools: Record<string, { handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> }> };
    };
    const tools = typed.server._registeredTools;
    for (const name of ["flash_plan", "flash", "erase_plan", "erase", "gdb_command_plan", "gdb_command", "probe_command_plan", "probe_command"]) {
      assert.ok(tools[name], `${name} must be registered`);
    }
    assert.equal(tools.write_memory, undefined);
    assert.deepEqual(Object.keys(tools).filter((name) => /approve|broker|token|secret/i.test(name)), []);
    for (const name of ["halt", "resume", "reset", "flash_plan", "flash", "erase_plan", "erase", "gdb_command_plan", "gdb_command", "probe_command_plan", "probe_command", "variable_write_plan", "variable_write_execute"]) {
      const discovered = tools[name] as { description?: string; annotations?: Record<string, boolean>; _meta?: Record<string, unknown> };
      assert.match(discovered.description ?? "", /Risk: R(?:2\/R4|3|4)/);
      assert.ok(discovered.annotations);
      assert.ok(discovered._meta?.["jlinkMcp/discovery"]);
    }

    typed.probe.setDevice("STM32F407VG");
    const response = await tools.flash.handler({
      filePath: "firmware.hex",
      challengeId: randomUUID(),
      approvalToken: "caller-generated",
    });
    const parsed = JSON.parse(response.content[0].text);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "approval_required");
  } finally {
    await instance.dispose();
  }
});

test("public R4 execution re-reads owner state and rejects physical-generation drift before the executor", async () => {
  const instance = new JLinkMcpServer();
  try {
    const typed = instance as unknown as {
      probe: { setDevice(device: string): void; erase(): Promise<unknown> };
      hssCapture: { r4Binding(tool: string, args: Record<string, unknown>): Promise<R4OperationBinding> };
      server: { _registeredTools: Record<string, { handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> }> };
    };
    typed.probe.setDevice("STM32F407VG");
    let generation = 3;
    typed.hssCapture.r4Binding = async (tool, canonicalArgs) => binding(tool as "erase", canonicalArgs, generation);
    let executions = 0;
    typed.probe.erase = async () => { executions += 1; return { success: true }; };
    const planned = JSON.parse((await typed.server._registeredTools.erase_plan.handler({})).content[0].text);
    await approve(planned.challenge.challengeId);
    generation += 1;
    const rejected = JSON.parse((await typed.server._registeredTools.erase.handler({ challengeId: planned.challenge.challengeId })).content[0].text);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "operation_binding_changed");
    assert.equal(executions, 0);
  } finally {
    await instance.dispose();
  }
});

test("unverified variable exception exposes a challenge and consumes no Native write when binding drifts", async () => {
  const instance = new JLinkMcpServer();
  try {
    const typed = instance as unknown as {
      hssCapture: {
        variableWritePlan(input: unknown): Promise<Record<string, any>>;
        variableWriteRisk(writePlanId: string): "R4";
        variableWriteApprovalBinding(writePlanId: string): Promise<R4OperationBinding>;
        executeR4VariableWrite(writePlanId: string, approval: unknown): Promise<unknown>;
      };
      server: { _registeredTools: Record<string, { handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> }> };
    };
    let generation = 7;
    let executions = 0;
    typed.hssCapture.variableWritePlan = async () => ({ ok: true, operation: "variable_write_plan", data: { writePlanId: "op_fixture", risk: "R4" }, risk: { level: "R4", requiresUserApproval: true }, backend: { selected: "jlink-hss", fallbackFrom: null, reason: null }, artifacts: [], warnings: [], message: "completed" });
    typed.hssCapture.variableWriteRisk = () => "R4";
    typed.hssCapture.variableWriteApprovalBinding = async () => binding("variable_write_execute", { writePlanId: "op_fixture" }, generation, true);
    typed.hssCapture.executeR4VariableWrite = async () => { executions += 1; return { success: false, code: "native_r4_unavailable" }; };
    const planned = JSON.parse((await typed.server._registeredTools.variable_write_plan.handler({ target: "Debug_R4", value: 1 })).content[0].text);
    await approve(planned.data.challenge.challengeId);
    generation += 1;
    const rejected = JSON.parse((await typed.server._registeredTools.variable_write_execute.handler({ writePlanId: "op_fixture", challengeId: planned.data.challenge.challengeId })).content[0].text);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "operation_binding_changed");
    assert.equal(executions, 0);
  } finally {
    await instance.dispose();
  }
});

test("unverified variable exception consumes approval but remains fail-closed without Native same-connection support", async () => {
  const instance = new JLinkMcpServer();
  try {
    const typed = instance as unknown as {
      hssCapture: {
        variableWritePlan(input: unknown): Promise<Record<string, any>>;
        variableWriteRisk(writePlanId: string): "R4";
        variableWriteApprovalBinding(writePlanId: string): Promise<R4OperationBinding>;
        executeR4VariableWrite(writePlanId: string, approval: unknown): Promise<unknown>;
      };
      server: { _registeredTools: Record<string, { handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> }> };
    };
    const exactBinding = binding("variable_write_execute", { writePlanId: "op_fixture" }, 7, true);
    let nativeContracts = 0;
    typed.hssCapture.variableWritePlan = async () => ({ ok: true, operation: "variable_write_plan", data: { writePlanId: "op_fixture", risk: "R4" }, risk: { level: "R4", requiresUserApproval: true }, backend: { selected: "jlink-hss", fallbackFrom: null, reason: null }, artifacts: [], warnings: [], message: "completed" });
    typed.hssCapture.variableWriteRisk = () => "R4";
    typed.hssCapture.variableWriteApprovalBinding = async () => exactBinding;
    typed.hssCapture.executeR4VariableWrite = async () => {
      nativeContracts += 1;
      return { success: false, code: "native_r4_unavailable", message: "same-connection Native contract is unavailable" };
    };
    const planned = JSON.parse((await typed.server._registeredTools.variable_write_plan.handler({ target: "Debug_R4", value: 1 })).content[0].text);
    await approve(planned.data.challenge.challengeId);
    const first = JSON.parse((await typed.server._registeredTools.variable_write_execute.handler({ writePlanId: "op_fixture", challengeId: planned.data.challenge.challengeId })).content[0].text);
    const replay = JSON.parse((await typed.server._registeredTools.variable_write_execute.handler({ writePlanId: "op_fixture", challengeId: planned.data.challenge.challengeId })).content[0].text);
    assert.equal(first.ok, false);
    assert.equal(first.error.code, "native_r4_unavailable");
    assert.equal(replay.error.code, "approval_replayed");
    assert.equal(nativeContracts, 1);
  } finally {
    await instance.dispose();
  }
});

function binding(tool: R4OperationBinding["tool"], canonicalArgs: Record<string, unknown>, connectionGeneration: number, exception = false): R4OperationBinding {
  return {
    tool,
    canonicalArgs,
    target: { targetId: "STM32F407VG", artifactMatch: exception ? "unverified" : "verified" },
    probe: { kind: tool === "gdb_command" ? "gdb" : "jlink", serial: "fixture-probe", interface: "SWD", speedKhz: 4000 },
    artifact: { generation: "1".repeat(64), sha256: "2".repeat(64) },
    layoutHash: "3".repeat(64),
    policy: { sha256: "4".repeat(64), unverifiedWriteException: exception },
    session: { id: "fixture-session" },
    connectionGeneration,
  };
}

async function approve(challengeId: string): Promise<void> {
  assert.equal(await runApprovalBrokerCli([challengeId], approvalTestRoot, approvalStateRoot, {
    input: { isTTY: true } as NodeJS.ReadStream,
    output: { isTTY: true, write: () => true } as unknown as NodeJS.WriteStream,
    question: async () => challengeId,
  }), 0);
}
