import assert from "node:assert/strict";
import test from "node:test";
import { runTrustValidate } from "./trust-cli";

const baseArgs = [
  "--project", "D:\\target",
  "--target", "Z20K146M",
  "--artifact", "D:\\target\\FOC_SCM.out",
  "--map", "D:\\target\\FOC_SCM.map",
  "--symbol", "g_hssDbgCounterFocIsr",
  "--script-mode", "none",
];

test("production trust validate requires explicit external storage and evidence roots", async () => {
  let output = "";
  const code = await runTrustValidate(baseArgs, { write: (text) => { output += text; } });
  assert.equal(code, 1);
  assert.match(output, /--storage-root is required/);
});

test("trust validate carries distinct project, storage, and evidence roots into validation", async () => {
  let received: Record<string, unknown> | undefined;
  const code = await runTrustValidate([
    ...baseArgs,
    "--storage-root", "D:\\hss-storage",
    "--evidence-root", "D:\\hss-evidence",
  ], {
    validate: async (input) => {
      received = input as unknown as Record<string, unknown>;
      return {} as never;
    },
    confirm: async () => false,
    write: () => undefined,
  });
  assert.equal(code, 2);
  assert.equal(received?.cwd, "D:\\target");
  assert.equal(received?.storageRoot, "D:\\hss-storage");
  assert.equal(received?.evidenceRoot, "D:\\hss-evidence");
});
