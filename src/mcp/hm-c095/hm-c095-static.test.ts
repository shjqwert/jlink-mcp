import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const hmRoot = process.env.HM_C095_REPO_DIR ?? "D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config";

const requiredFiles = [
  "Appl/FOC_SCM.ewp",
  "Appl/FOC_SCM.eww",
  "Appl/FOC_SCM_832.ewp",
  "Appl/FOC_SCM_832.eww",
  "Appl/Source/App/Motor/Dbg/AppMotorDbg.h",
  "Appl/Source/App/Motor/Dbg/AppMotorDbg.c",
  "Appl/Source/App/Motor/Ctrl/AppMotorCtrl.h",
  "Appl/Source/App/Motor/Ctrl/AppMotorCtrl.c",
  "Appl/Source/App/AppCurrentSense.h",
  "Appl/Source/App/AppCurrentSense.c",
  "Appl/Source/App/TraceAgent/TraceAgentCore.c",
  "Appl/Source/App/TraceAgent/TraceAgentPort.c",
  "Appl/Source/App/TraceAgent/TraceSignals.c",
  "Appl/Source/App/TraceAgent/TraceSignals.h",
  "Appl/Source/App/OsUserConfig.c",
];

test("HM_C095 current project files and static facts match validation mapping", async () => {
  await Promise.all(requiredFiles.map((file) => access(hm(file))));

  const project = await text("Appl/FOC_SCM.ewp");
  const workspace = await text("Appl/FOC_SCM.eww");
  const workspace832 = await text("Appl/FOC_SCM_832.eww");
  const motorDbgH = await text("Appl/Source/App/Motor/Dbg/AppMotorDbg.h");
  const motorDbgC = await text("Appl/Source/App/Motor/Dbg/AppMotorDbg.c");
  const motorCtrlC = await text("Appl/Source/App/Motor/Ctrl/AppMotorCtrl.c");
  const osUserConfig = await text("Appl/Source/App/OsUserConfig.c");
  const tracePort = await text("Appl/Source/App/TraceAgent/TraceAgentPort.c");
  const traceSignalsC = await text("Appl/Source/App/TraceAgent/TraceSignals.c");
  const traceSignalsH = await text("Appl/Source/App/TraceAgent/TraceSignals.h");
  const currentSense = `${await text("Appl/Source/App/AppCurrentSense.c")}\n${await text("Appl/Source/App/AppCurrentSense.h")}`;

  assert.match(project, /<name>Debug<\/name>/);
  assert.match(project, /Z20K146M/);
  assert.match(workspace, /FOC_SCM\.ewp/);
  assert.match(workspace832, /FOC_SCM_832\.ewp/);

  assert.match(motorDbgH, /typedef\s+struct[\s\S]*ST_APP_MOTOR_DBG/);
  for (const field of ["fThetaRad", "ucSector", "fModPu", "fIuPu", "fIvPu", "fIwPu", "fIalpha", "fIbeta", "uwDutyU", "uwDutyV", "uwDutyW", "enFault"]) {
    assert.match(motorDbgH, new RegExp(`\\b${field}\\b`));
  }
  for (const token of ["static volatile ST_APP_MOTOR_DBG gstMotorDbg", "AppMotorDbgColdInit", "AppMotorDbgUpdate", "AppMotorDbgSnapshotGet", "AppMotorDbgPeakClear"]) {
    assert.match(motorDbgC, fixed(token));
  }
  for (const token of ["AppMotorCtrlOpenLoopStart", "AppMotorCtrlStop", "AppMotorCtrlPwmIsr", "AppMotorDbgUpdate"]) {
    assert.match(motorCtrlC, fixed(token));
  }

  if (/bMotorStarted/.test(osUserConfig)) {
    assert.match(osUserConfig, /OS_USER_ENABLE_OPEN_LOOP_START/);
  }

  assert.match(tracePort, /AppMotorDbgSnapshotGet/);
  for (const token of ["TRACE_SIGNAL_MOTOR_FAULT", "TRACE_SIGNAL_THETA_RAD", "TRACE_SIGNAL_SECTOR", "TRACE_SIGNAL_MOD_PU", "TRACE_SIGNAL_IU_PU", "TRACE_SIGNAL_IV_PU", "TRACE_SIGNAL_IW_PU", "TRACE_SIGNAL_DUTY_U", "TRACE_SIGNAL_DUTY_V", "TRACE_SIGNAL_DUTY_W"]) {
    assert.match(tracePort, fixed(token));
  }
  assert.match(traceSignalsH, /TRACE_SIGNAL_[A-Z0-9_]+/);
  assert.match(traceSignalsH, /TRACE_SIGNAL_GUW_WDG_FLG/);
  assert.match(traceSignalsC, /TRACE_REG_SLOW\(&g_traceMotorFault/);
  assert.match(traceSignalsC, /TRACE_REG_WRITABLE_EX\(&g_traceWdgFlg,\s*TRACE_U16,\s*"guwWdgFlg",\s*0,\s*1,\s*TRACE_MODE_STOP \| TRACE_MODE_MAINT\)/);

  for (const token of ["OffsetCalib", "OffsetRemovedAdc", "AppCurrentSenseStartOffsetCalib", "AppCurrentSenseOffsetReadyGet", "AppCurrentSenseOffsetRemovedAdcGet"]) {
    assert.match(currentSense, fixed(token));
  }
});

function hm(file: string): string {
  return join(hmRoot, file);
}

async function text(file: string): Promise<string> {
  return readFile(hm(file), "utf8");
}

function fixed(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}
