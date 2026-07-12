import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { ProcessManager } from "../../utils/process-manager";
import { JLinkBackend } from "../../probe/jlink";
import { HssCaptureService } from "./hss-capture-service";
import { HSS_ERROR, HssError } from "./hss-errors";
import { resolveHssTargetIdentity } from "./target-identity";

test("explicit HSS target takes precedence over project configuration", async () => {
  const root = await tempProject();
  try {
    await writeIarProject(root, "PROJECT_TARGET");

    const target = await resolveHssTargetIdentity({ device: "EXPLICIT_TARGET", projectRoot: root });

    assert.deepEqual(target, {
      targetId: "EXPLICIT_TARGET",
      source: "explicit",
      confidence: "explicit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a unique supported project configuration records target source and confidence", async () => {
  const root = await tempProject();
  try {
    const config = await writeIarProject(root, "PROJECT_TARGET");

    const target = await resolveHssTargetIdentity({ projectRoot: root });

    assert.equal(target.targetId, "PROJECT_TARGET");
    assert.equal(target.source, "project-config");
    assert.equal(target.confidence, "project-config");
    assert.deepEqual(target.configurationSource, { file: config, format: "iar-ewp" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing target does not fall back to a built-in MCU or environment default", async () => {
  const root = await tempProject();
  try {
    await assertTargetSelectionRequired(() => resolveHssTargetIdentity({ projectRoot: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinct supported project targets require an explicit selection", async () => {
  const root = await tempProject();
  try {
    await writeIarProject(root, "TARGET_A");
    await writeJlinkConfig(join(root, "settings", "target-b.jlink"), "TARGET_B");

    const error = await targetSelectionError(() => resolveHssTargetIdentity({ projectRoot: root }));

    assert.deepEqual(error.details.candidates, [
      { targetId: "TARGET_A", source: { file: join(root, "project.ewp"), format: "iar-ewp" } },
      { targetId: "TARGET_B", source: { file: join(root, "settings", "target-b.jlink"), format: "jlink" } },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicitly selected configuration resolves deterministically", async () => {
  const root = await tempProject();
  try {
    await writeIarProject(root, "TARGET_A");
    const selected = await writeJlinkConfig(join(root, "settings", "target-b.jlink"), "TARGET_B");

    const target = await resolveHssTargetIdentity({ projectRoot: root, projectConfigFile: selected });

    assert.equal(target.targetId, "TARGET_B");
    assert.deepEqual(target.configurationSource, { file: selected, format: "jlink" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project configuration scanning remains bounded", async () => {
  const root = await tempProject();
  try {
    await Promise.all(Array.from({ length: 65 }, (_, index) => writeJlinkConfig(join(root, `config-${index}.jlink`), "TARGET_A")));

    const error = await targetSelectionError(() => resolveHssTargetIdentity({ projectRoot: root }));

    const scan = error.details.scan as { truncated?: boolean };
    const candidates = error.details.candidates as unknown[];
    assert.equal(scan.truncated, true);
    assert.ok(candidates.length <= 16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HM_C095 configuration ambiguity keeps Z20K146M and Z20K146MC distinct", async () => {
  const projectRoot = "D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config";
  const ewp = join(projectRoot, "Appl", "FOC_SCM.ewp");
  const jlink = join(projectRoot, "Appl", "settings", "FOC_SCM_Debug.jlink");
  assert.equal(existsSync(ewp), true);
  assert.equal(existsSync(jlink), true);

  const error = await targetSelectionError(() => resolveHssTargetIdentity({ projectRoot }));
  const candidates = error.details.candidates as Array<{ targetId: string }>;
  assert.ok(candidates.some((candidate) => candidate.targetId === "Z20K146M"));
  assert.ok(candidates.some((candidate) => candidate.targetId === "Z20K146MC"));

  const explicit = await resolveHssTargetIdentity({ projectRoot, device: "Z20K146MC" });
  const selected = await resolveHssTargetIdentity({ projectConfigFile: ewp });
  assert.equal(explicit.targetId, "Z20K146MC");
  assert.equal(selected.targetId, "Z20K146M");
});

test("capability and capture reject target selection before invoking a helper", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const marker = join(root, "helper-invoked");
  const probe = new JLinkBackend({ installDir: root, device: "PROBE_ONLY_TARGET", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: { HSS_TARGET_HELPER_MARKER: marker },
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
  });
  try {
    await writeFile(helper, 'require("node:fs").writeFileSync(process.env.HSS_TARGET_HELPER_MARKER, "invoked")', "utf8");

    const capability = await service.capabilityProbe({ dllPath: join(root, "JLink_x64.dll") });
    const capture = await service.captureStart({ dllPath: join(root, "JLink_x64.dll") });

    assert.equal(capability.error?.code, HSS_ERROR.HSS_TARGET_SELECTION_REQUIRED);
    assert.equal(capture.error?.code, HSS_ERROR.HSS_TARGET_SELECTION_REQUIRED);
    assert.equal(existsSync(marker), false);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

async function targetSelectionError(action: () => Promise<unknown>): Promise<HssError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof HssError && error.code === HSS_ERROR.HSS_TARGET_SELECTION_REQUIRED) return error;
    throw error;
  }
  assert.fail("expected HSS_TARGET_SELECTION_REQUIRED");
}

async function assertTargetSelectionRequired(action: () => Promise<unknown>): Promise<void> {
  await targetSelectionError(action);
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-target-identity-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

async function writeIarProject(root: string, targetId: string): Promise<string> {
  const file = join(root, "project.ewp");
  await writeFile(file, `<project><option><name>OGChipSelectEditMenu</name><state>${targetId} Vendor ${targetId}</state></option></project>`, "utf8");
  return file;
}

async function writeJlinkConfig(file: string, targetId: string): Promise<string> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `[FLASH]\nDevice="${targetId}"\n`, "utf8");
  return file;
}
