#!/usr/bin/env node
import { JLinkBackend } from "../out/probe/jlink.js";
import { ProcessManager } from "../out/utils/process-manager.js";
import { HssCaptureService } from "../out/mcp/hss/hss-capture-service.js";

const target = process.argv[2] ?? "g_hssDbgWriteProbe";
const value = Number(process.argv[3] ?? 1);

if (!Number.isFinite(value)) {
  console.error("value must be numeric");
  process.exit(2);
}

const probe = new JLinkBackend({ device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
const service = new HssCaptureService(probe, { cwd: process.cwd() });

try {
  const plan = await service.variableWritePlan({ target, type: "uint32", value });
  if (!plan.ok) {
    console.log(JSON.stringify(plan, null, 2));
    process.exit(1);
  }
  const executed = await service.variableWriteExecute({ writePlanId: plan.data.writePlanId });
  let restored = null;
  if (executed.ok && typeof executed.data.oldValue === "number" && executed.data.oldValue !== value) {
    const restorePlan = await service.variableWritePlan({ target, type: "uint32", value: executed.data.oldValue });
    restored = restorePlan.ok ? await service.variableWriteExecute({ writePlanId: restorePlan.data.writePlanId }) : restorePlan;
  }
  console.log(JSON.stringify({
    target,
    requestedValue: value,
    executeOk: executed.ok,
    readbackOk: executed.data?.readbackOk ?? false,
    error: executed.error,
    oldValue: executed.data?.oldValue,
    readback: executed.data?.readback,
    restored: restored ? { ok: restored.ok, readbackOk: restored.data?.readbackOk ?? false, readback: restored.data?.readback, error: restored.error } : null,
  }, null, 2));
  if (!executed.ok || executed.data?.readbackOk !== true || (restored && (!restored.ok || restored.data?.readbackOk !== true))) process.exit(1);
} finally {
  await service.dispose();
  probe.dispose();
}
