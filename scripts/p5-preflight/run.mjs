import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveArtifactGeneration } from "../../out/mcp/artifact/artifact-catalog.js";
import { HotVariables } from "../../out/mcp/artifact/hot-variables.js";
import { SymbolCatalog, catalogCandidateFromIarMap, symbolLogicalIdentity } from "../../out/mcp/artifact/symbol-catalog.js";
import { buildHssCapturePlan, revalidateHssCapturePlan } from "../../out/mcp/hss/hss-plan.js";
import { parseIarMap } from "../../out/mcp/hss/iar-map-parser.js";
import { configureHssProjectPaths } from "../../out/mcp/hss/project-paths.js";
import { resolveHssTargetIdentity } from "../../out/mcp/hss/target-identity.js";
import { HssError } from "../../out/mcp/hss/hss-errors.js";
import { createHssVariableWritePlan, HssWritePlanStore } from "../../out/mcp/hss/hss-write-plan.js";
import { normalizeHssPolicy } from "../../out/mcp/hss/hss-policy.js";
import { readHssTrustProfile } from "../../out/mcp/trust/trust-profile.js";

const targetRoot = absoluteOption("--project");
const reportRoot = absoluteOption("--report", resolve("reports/p5/preflight"));
const artifactRelative = "Appl/Debug/Exe/FOC_SCM.out";
const mapRelative = "Appl/Debug/List/FOC_SCM.map";
const policyRelative = ".jlink-mcp/policy.json";
const selectedNames = new Map([
  ["g_hssDbgCounterFocIsr", "uint32"],
  ["g_hssDbgWriteProbe", "uint32"],
]);

if (inside(reportRoot, targetRoot)) throw new Error("--report must be outside the target project");

const beforeManifest = await manifest(targetRoot);
const targetArtifact = await resolveArtifactGeneration({
  projectRoot: targetRoot,
  explicitArtifact: artifactRelative,
  explicitMap: mapRelative,
});
const targetVariables = resolveVariables(targetArtifact, targetArtifact.mapPath);
const variableRefs = targetVariables.map(({ ref }) => ({ source: "hot_variable", ref }));
const targetSelection = await expectedError(() => resolveHssTargetIdentity({}, { cwd: targetRoot }), "HSS_TARGET_SELECTION_REQUIRED");
const trust = trustMismatch(targetRoot);

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = join(reportRoot, "runs", runId);
const fixtureRoot = join(runRoot, "fixture");
await mkdir(join(fixtureRoot, dirname(artifactRelative)), { recursive: true });
await mkdir(join(fixtureRoot, dirname(mapRelative)), { recursive: true });
await mkdir(join(fixtureRoot, dirname(policyRelative)), { recursive: true });
await Promise.all([
  copyFile(targetArtifact.path, join(fixtureRoot, artifactRelative)),
  copyFile(targetArtifact.mapPath, join(fixtureRoot, mapRelative)),
  copyFile(join(targetRoot, policyRelative), join(fixtureRoot, policyRelative)),
]);

const fixtureStorage = join(runRoot, "external-storage");
const fixtureEvidence = join(runRoot, "external-evidence");
await mkdir(fixtureStorage, { recursive: true });
await mkdir(fixtureEvidence, { recursive: true });
configureHssProjectPaths(fixtureRoot, { storageRoot: fixtureStorage, evidenceRoot: fixtureEvidence });

const fixtureArtifact = await resolveArtifactGeneration({
  projectRoot: fixtureRoot,
  explicitArtifact: artifactRelative,
  explicitMap: mapRelative,
});
const fixtureVariables = resolveVariables(fixtureArtifact, fixtureArtifact.mapPath);
const fixtureTarget = await resolveHssTargetIdentity({ targetId: "P5-STALE-FIXTURE" }, { cwd: fixtureRoot });
const policy = normalizeHssPolicy(JSON.parse((await readFile(join(fixtureRoot, policyRelative), "utf8")).replace(/^\uFEFF/, "")));
const initialContext = hotContext(fixtureArtifact, policy.policyHash);
const hotVariables = new HotVariables();
for (const variable of fixtureVariables) hotVariables.add(variable, initialContext);
const initialPlan = await buildPlan(fixtureRoot, fixtureTarget, fixtureVariables, fixtureArtifact);
const writeStore = new HssWritePlanStore();
const initialWritePlan = writeStore.put(createWritePlan(fixtureArtifact, policy, fixtureArtifact.mapPath));

await mutateFixture(join(fixtureRoot, artifactRelative), join(fixtureRoot, mapRelative));
const changedArtifact = await resolveArtifactGeneration({
  projectRoot: fixtureRoot,
  explicitArtifact: artifactRelative,
  explicitMap: mapRelative,
});
const changedContext = hotContext(changedArtifact, policy.policyHash);
const staleHotVariables = fixtureVariables.map(({ ref }) => {
  const result = hotVariables.get(ref, changedContext);
  if (result.ok || result.error.code !== "hot_variable_stale") throw new Error("old Hot Variable did not become stale");
  return { ref: symbolLogicalIdentity(ref), code: result.error.code };
});
const staleHssPlan = await expectedError(() => revalidateHssCapturePlan(initialPlan, fixtureRoot), "hot_variable_stale");
const staleWritePlan = await expectedError(() => Promise.resolve(writeStore.get(initialWritePlan.writePlanId, writeContext(changedArtifact, policy, changedArtifact.mapPath))), "WRITE_PLAN_CAPTURE_MISMATCH");

const refreshed = await hotVariables.refresh(variableRefs.map(({ ref }) => ref), changedContext, async (ref) => {
  const current = resolveVariables(changedArtifact, changedArtifact.mapPath).find((candidate) => symbolLogicalIdentity(candidate.ref) === symbolLogicalIdentity(ref));
  if (!current) throw new Error(`referenced variable disappeared during refresh: ${symbolLogicalIdentity(ref)}`);
  return current;
});
if (refreshed.length !== variableRefs.length || refreshed.some((item) => !variableRefs.some(({ ref }) => symbolLogicalIdentity(ref) === item.logicalIdentity))) {
  throw new Error("targeted refresh changed a variable outside variableRefs");
}
const refreshedPlan = await buildPlan(fixtureRoot, fixtureTarget, refreshed.map(({ resolved }) => resolved), changedArtifact);
const refreshedWritePlan = createWritePlan(changedArtifact, policy, changedArtifact.mapPath);

const afterManifest = await manifest(targetRoot);
if (beforeManifest.digest !== afterManifest.digest || JSON.stringify(beforeManifest.entries) !== JSON.stringify(afterManifest.entries)) {
  throw new Error("target project content changed during preflight");
}

const report = {
  schema: "p5-preflight-stale-fixture-v1",
  generatedAt: new Date().toISOString(),
  command: `node scripts/p5-preflight/run.mjs --project ${JSON.stringify(targetRoot)} --report ${JSON.stringify(reportRoot)}`,
  hardwareActions: [],
  target: {
    root: targetRoot,
    manifestBefore: { files: beforeManifest.entries.length, digest: beforeManifest.digest },
    manifestAfter: { files: afterManifest.entries.length, digest: afterManifest.digest },
    artifact: artifactRecord(targetArtifact),
    variableRefs: variableRefs.map(({ source, ref }) => ({ source, ref: symbolLogicalIdentity(ref), artifactGeneration: ref.artifactGeneration, layoutHash: ref.layoutHash })),
    targetIdentity: targetSelection,
    trust,
  },
  fixture: {
    root: fixtureRoot,
    explicitTarget: fixtureTarget,
    initialArtifact: artifactRecord(fixtureArtifact),
    changedArtifact: artifactRecord(changedArtifact),
    stale: { hotVariables: staleHotVariables, hssPlan: staleHssPlan, writePlan: staleWritePlan },
    refresh: {
      requestedRefs: variableRefs.map(({ ref }) => symbolLogicalIdentity(ref)),
      refreshedRefs: refreshed.map(({ logicalIdentity, artifactGeneration, layoutHash }) => ({ logicalIdentity, artifactGeneration, layoutHash })),
      newHssPlan: { artifactGeneration: refreshedPlan.artifact.generation, mapSha256: refreshedPlan.artifact.mapSha256, symbolCount: refreshedPlan.symbols.length },
      newWritePlan: { artifactGeneration: refreshedWritePlan.operationPlan.artifact.generation, symbolLayoutHash: refreshedWritePlan.symbolLayoutHash },
    },
    externalRoots: { storage: fixtureStorage, evidence: fixtureEvidence },
  },
};
await mkdir(reportRoot, { recursive: true });
const reportFile = join(reportRoot, "latest.json");
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportFile, targetArtifact: artifactRecord(targetArtifact), stale: report.fixture.stale, hardwareActions: report.hardwareActions }, null, 2));

function absoluteOption(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) throw new Error(`${name} requires a path`);
  return resolve(value);
}

function inside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`..${sep}`));
}

async function manifest(root) {
  const entries = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const info = await stat(file);
        const data = await readFile(file);
        entries.push({ path: relative(root, file).replace(/\\/g, "/"), size: info.size, sha256: sha256(data) });
      }
    }
  };
  await walk(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries, digest: sha256(Buffer.from(JSON.stringify(entries), "utf8")) };
}

function resolveVariables(artifact, mapFile) {
  const parsed = parseIarMap(mapFile);
  const candidates = [...parsed.values()].flat().map((symbol) => catalogCandidateFromIarMap(symbol, selectedNames.get(symbol.name)));
  const catalog = new SymbolCatalog({ generation: artifact.generation }, candidates);
  return [...selectedNames.keys()].map((name) => {
    const result = catalog.resolve(name);
    if (!result.ok) throw new Error(`symbol resolution failed for ${name}: ${result.error.code} ${result.error.reason}`);
    return result.value;
  });
}

function hotContext(artifact, policyGeneration) {
  return { artifactGeneration: artifact.generation, mapSha256: artifact.mapSha256, policyGeneration, sessionGeneration: "p5-preflight" };
}

async function buildPlan(root, target, variables, artifact) {
  return buildHssCapturePlan({
    targetId: target.targetId,
    artifactFile: relative(root, artifact.path),
    mapFile: relative(root, artifact.mapPath),
    variables,
    variableRefs: variables.map(({ ref }) => ({ source: "hot_variable", ref })),
    requestedRateHz: 10,
    durationSec: 1,
    nonvolatileRanges: [{ start: 0, end: 0x20000000 }],
    ramRanges: [{ start: 0x20000000, end: 0x40000000 }],
  }, root, false, target);
}

function createWritePlan(artifact, policy, mapFile) {
  return createHssVariableWritePlan({ target: "g_hssDbgWriteProbe", value: 1 }, { ...writeContext(artifact, policy, mapFile), backend: "jlink-hss" });
}

function writeContext(artifact, policy, mapFile) {
  return {
    captureId: "p5-preflight-fixture",
    captureGeneration: 1,
    mapFile,
    policy,
    runtimeIdentitySha256: "p5-preflight-runtime",
    scriptApprovalSha256: "p5-preflight-script",
    targetId: "P5-STALE-FIXTURE",
    artifactGeneration: artifact.generation,
    artifactSha256: artifact.sha256,
    targetArtifactMatch: "verified",
    evidenceGeneration: "p5-preflight-evidence",
    connectionGeneration: 1,
    sessionId: "p5-preflight-session",
    writeOpsUsed: 0,
    elementsUsed: 0,
  };
}

async function mutateFixture(artifactFile, mapFile) {
  const originalMap = await readFile(mapFile, "utf8");
  const changedMap = originalMap.replace(/(g_hssDbgCounterFocIsr\s+0x)2000'6b2c/, "$12000'6b30");
  if (changedMap === originalMap) throw new Error("fixture MAP did not contain the audited counter layout");
  await writeFile(mapFile, changedMap, "utf8");
  await appendFile(artifactFile, Buffer.from([0]));
}

function trustMismatch(projectRoot) {
  const profile = readHssTrustProfile(projectRoot);
  if (!profile) return { status: "rejected", code: "HSS_RUNTIME_IDENTITY_UNVALIDATED", reason: "Trust Profile is unavailable" };
  const actual = sha256(readFileSync(profile.runtime.helperPath));
  if (actual === profile.runtime.helperSha256) throw new Error("expected helper Trust mismatch is absent; refusing to claim fail-closed preflight");
  return {
    status: "rejected",
    code: "HSS_RUNTIME_IDENTITY_UNVALIDATED",
    reason: "helper SHA-256 differs from the external Trust Profile; no refresh was attempted",
    expectedHelperSha256: profile.runtime.helperSha256,
    actualHelperSha256: actual,
  };
}

async function expectedError(action, code) {
  try {
    await action();
  } catch (error) {
    if (error instanceof HssError && error.code === code) return { code: error.code, message: error.message, details: error.details };
    throw error;
  }
  throw new Error(`expected ${code} but operation succeeded`);
}

function artifactRecord(artifact) {
  return { path: artifact.path, mapPath: artifact.mapPath, generation: artifact.generation, sha256: artifact.sha256, mapSha256: artifact.mapSha256 };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
