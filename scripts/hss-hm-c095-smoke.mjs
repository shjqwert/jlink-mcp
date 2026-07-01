import { JLinkBackend } from "../out/probe/jlink.js";
import { ProcessManager } from "../out/utils/process-manager.js";
import { HssCaptureService } from "../out/mcp/hss/hss-capture-service.js";

const symbolSets = {
  counter: [{ name: "g_hssDbgCounterFocIsr", type: "uint32", unit: "count" }],
  task1ms: [{ name: "g_hssDbgCounterTask1ms", type: "uint32", unit: "count" }],
  core4: [
    { name: "g_hssDbgCounterFocIsr", type: "uint32", unit: "count" },
    { name: "g_hssDbgSawFocIsr", type: "uint32" },
    { name: "g_hssDbgToggleFocIsr", type: "uint32" },
    { name: "g_hssDbgPatternFocIsr", type: "uint32" },
  ],
  full10: [
    { name: "g_hssDbgCounterFocIsr", type: "uint32", unit: "count" },
    { name: "g_hssDbgSawFocIsr", type: "uint32" },
    { name: "g_hssDbgToggleFocIsr", type: "uint32" },
    { name: "g_hssDbgPatternFocIsr", type: "uint32" },
    { name: "g_hssDbgRawAdcM1U", type: "uint32" },
    { name: "g_hssDbgRawAdcM1V", type: "uint32" },
    { name: "g_hssDbgRawAdcM2U", type: "uint32" },
    { name: "g_hssDbgRawAdcM2V", type: "uint32" },
    { name: "g_hssDbgOffsetM1U", type: "int16" },
    { name: "g_hssDbgOffsetM1V", type: "int16" },
  ],
};

const args = process.argv.slice(2);
if (args[0] === "--help") {
  console.log("usage: node scripts/hss-hm-c095-smoke.mjs [counter|task1ms|core4|full10] [rateHz] [durationSec] [dllPath] [periodic|drain] [resume]");
  console.log("legacy: node scripts/hss-hm-c095-smoke.mjs 1000 3 [dllPath]");
  process.exit(0);
}

const mode = symbolSets[args[0]] ? args.shift() : "counter";
const rateHz = Number(args[0] ?? 1000);
const durationSec = Number(args[1] ?? 3);
const dllPath = args[2];
const readMode = args[3] ?? "periodic";
const resumeBeforeStart = args[4] === "resume";
if (!Number.isInteger(rateHz) || rateHz < 1 || !Number.isInteger(durationSec) || durationSec < 1) {
  console.error("rateHz and durationSec must be positive integers");
  process.exit(2);
}
if (!["periodic", "drain"].includes(readMode)) {
  console.error("readMode must be periodic or drain");
  process.exit(2);
}

const probe = new JLinkBackend({ device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
const service = new HssCaptureService(probe);

try {
  const plan = await service.capturePlan({
    dllPath,
    readMode,
    resumeBeforeStart,
    symbols: symbolSets[mode],
    requestedRateHz: rateHz,
    durationSec,
  });
  console.log(JSON.stringify(plan, null, 2));
  if (!plan.ok) process.exit(1);
  const start = await service.captureStart({ planId: plan.data.planId, dllPath, readMode, resumeBeforeStart });
  console.log(JSON.stringify(start, null, 2));
  if (!start.ok) process.exit(1);
  const captureId = start.data.captureId;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await service.captureStatus({ captureId });
    console.log(JSON.stringify(status, null, 2));
    if (status.data && status.data.state !== "capturing") break;
  }
  console.log(JSON.stringify(await service.captureQuery({ captureId, hmC095Profile: true }), null, 2));
  console.log(JSON.stringify(await service.captureExport({ captureId }), null, 2));
} finally {
  await service.dispose();
  probe.dispose();
}
