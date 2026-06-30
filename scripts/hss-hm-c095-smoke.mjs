import { JLinkBackend } from "../out/probe/jlink.js";
import { ProcessManager } from "../out/utils/process-manager.js";
import { HssCaptureService } from "../out/mcp/hss/hss-capture-service.js";

const rateHz = Number(process.argv[2] ?? 1000);
const durationSec = Number(process.argv[3] ?? 3);
const dllPath = process.argv[4];
const probe = new JLinkBackend({ device: "Z20K146MC", interface: "SWD", speed: 4000 }, new ProcessManager());
const service = new HssCaptureService(probe);

try {
  const plan = await service.capturePlan({
    symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32", unit: "count" }],
    requestedRateHz: rateHz,
    durationSec,
  });
  console.log(JSON.stringify(plan, null, 2));
  if (!plan.ok) process.exit(1);
  const start = await service.captureStart({ planId: plan.data.planId, dllPath });
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
