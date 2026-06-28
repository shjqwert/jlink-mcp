import assert from "node:assert/strict";
import test from "node:test";
import { HSS_CANDIDATE_FUNCTIONS, HSS_CANDIDATE_STRUCTS, hssApiCandidateReport } from "./hss-api-candidate";
import { requireHssReadOnlyVariables, selectDefaultHssReadOnlyVariables, validateHssReadOnlyVariable } from "./hss-symbols";

test("HSS public candidate API records function names and struct layouts", () => {
  const report = hssApiCandidateReport(false);
  assert.deepEqual(report.functionNames, ["JLINK_HSS_GetCaps", "JLINK_HSS_Start", "JLINK_HSS_Read", "JLINK_HSS_Stop"]);
  assert.equal(HSS_CANDIDATE_FUNCTIONS.length, 4);
  assert.equal(HSS_CANDIDATE_STRUCTS.HssCaps.sizeBytes, 32);
  assert.equal(HSS_CANDIDATE_STRUCTS.HssMemBlockDesc.sizeBytes, 16);
  assert.equal(report.officialSdkHeaderFound, false);
  assert.equal(report.publicPrototypeCandidate, true);
  assert.equal(report.productionReady, false);
});

test("HSS symbol safety rejects motor/control writes", () => {
  assert.deepEqual(validateHssReadOnlyVariable("theta_rad"), { ok: true });
  assert.deepEqual(selectDefaultHssReadOnlyVariables(3), ["s_traceAliveCounter", "trace_state", "motor_fault"]);
  assert.throws(() => requireHssReadOnlyVariables(["bMotorStarted"]), /unsafe HSS observation symbol rejected/);
  assert.throws(() => requireHssReadOnlyVariables(["AppMotorCtrl.c::gstMotorCtrl.run"]), /unsafe HSS observation symbol rejected/);
  assert.throws(() => requireHssReadOnlyVariables(["speed_ref"]), /unsafe HSS observation symbol rejected/);
});
