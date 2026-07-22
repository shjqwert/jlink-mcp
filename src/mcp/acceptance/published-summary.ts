import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  ACCEPTANCE_STATUSES,
  acceptanceIndexSchema,
  issueLedgerSchema,
  readRepositoryIdentity,
  summarizeAcceptance,
  type AcceptanceCase,
  type AcceptanceIndex,
  type AcceptanceStatus,
  type IssueRecord,
} from "./evidence";

const commit = z.string().regex(/^[0-9a-f]{40}$/);
const isoTime = z.string().datetime({ offset: true });
const releaseStatus = z.enum(ACCEPTANCE_STATUSES);
const evidenceDigest = z.string().regex(/^digest:[0-9a-f]{64}$/);
const qualityStatus = z.enum(["qualified", "partial", "not_tested"]);
const qualitySource = z.enum(["jlink", "target_counter", "none", "not_tested"]);
const writeSource = z.enum(["same_session", "independent_session", "capture_owner", "not_tested"]);
const ciSchema = z.object({
  build: releaseStatus,
  lint: releaseStatus,
  unit: releaseStatus,
  surface: releaseStatus,
  guidance: releaseStatus,
  legacyScan: releaseStatus,
  helper: releaseStatus,
  package: releaseStatus,
  privacy: releaseStatus,
}).strict();
const publicBlocker = z.string().regex(/^(?:T(?:0[1-9]|1[0-9]|20) is (?:FAIL|BLOCKED|NOT_TESTED)|[1-9]\d* open P[01] issues?|T14 HSS quality is (?:partial|not_tested)|T07 write verification source is not_tested|acceptance index does not recommend merge|CI (?:build|lint|unit|surface|guidance|legacyScan|helper|package|privacy) is (?:FAIL|BLOCKED|SKIPPED_WITH_REASON|NOT_TESTED)|destination metadata is not supplied)$/);

const PUBLIC_CONTENT_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["local machine path", /(?:[A-Za-z]:[\\/][^\s"'`<>]*|\\\\[^\\/\r\n]+[\\/][^\s"'`<>]*|\/(?:Users|home|tmp|var|opt|mnt|private)(?:\/|$))/i],
  ["Probe identifier", /(?:(?:jlink(?:serial|sn)?)|probe(?:Serial|_serial)|serial(?:Number)?)[\s`"':=_-]*\d{7,}/i],
  ["private Artifact hash", /(?:artifact(?:sha(?:256)?|hash)?|runtimeIdentitySha256|flash image|map)\b[^\r\n]{0,160}\b[0-9a-f]{64}\b/i],
];

function hasReleaseBlocker(value: {
  acceptance: AcceptanceIndex;
  ci: z.infer<typeof ciSchema>;
  openP0: number;
  openP1: number;
  hssQuality: z.infer<typeof qualityStatus>;
  writeStatus: AcceptanceStatus;
  writeSource: z.infer<typeof writeSource>;
  destinationMetadata: "supplied" | "not_supplied";
}): boolean {
  const ciIncomplete = Object.values(value.ci).some((status) => status !== "PASS");
  const incomplete = value.acceptance.summary.FAIL > 0
    || value.acceptance.summary.BLOCKED > 0
    || value.acceptance.summary.NOT_TESTED > 0;
  const hssNeedsQualification = value.acceptance.tests.some((entry) => entry.testId === "T14" && entry.status === "PASS")
    && value.hssQuality !== "qualified";
  const writeNeedsVerification = value.writeStatus === "PASS" && value.writeSource === "not_tested";
  return ciIncomplete || incomplete || value.openP0 > 0 || value.openP1 > 0 || hssNeedsQualification || writeNeedsVerification || value.destinationMetadata !== "supplied";
}

export const publishedAcceptanceIndexSchema = z.object({
  schemaVersion: z.literal(1),
  testedCommit: commit,
  generatedAt: isoTime,
  environmentClass: z.literal("windows-x64"),
  ci: ciSchema,
  hss: z.object({
    capacityStatus: releaseStatus,
    qualityStatus,
    qualitySource,
  }).strict(),
  writeVerification: z.object({
    status: releaseStatus,
    source: writeSource,
  }).strict(),
  openCoreIssues: z.object({ P0: z.number().int().nonnegative(), P1: z.number().int().nonnegative() }).strict(),
  acceptance: acceptanceIndexSchema,
  publication: z.object({ destinationMetadata: z.enum(["supplied", "not_supplied"]) }).strict(),
  blockers: z.array(publicBlocker).max(32),
  mergeRecommendation: z.enum(["RECOMMEND", "DO_NOT_RECOMMEND"]),
}).strict().superRefine((value, context) => {
  if (value.testedCommit !== value.acceptance.codeCommit) {
    context.addIssue({ code: "custom", message: "testedCommit must match the nested acceptance codeCommit", path: ["testedCommit"] });
  }
  if (value.openCoreIssues.P0 !== value.acceptance.summary.openP0) {
    context.addIssue({ code: "custom", message: "P0 issue count must match the nested acceptance summary", path: ["openCoreIssues", "P0"] });
  }
  if (value.hss.qualityStatus === "not_tested" && value.hss.qualitySource !== "not_tested") {
    context.addIssue({ code: "custom", message: "untested HSS quality must use the not_tested source", path: ["hss"] });
  }
  if (value.hss.qualityStatus !== "not_tested" && value.hss.qualitySource === "not_tested") {
    context.addIssue({ code: "custom", message: "recorded HSS quality requires a concrete source", path: ["hss"] });
  }
  if (value.hss.qualityStatus === "qualified" && value.hss.capacityStatus !== "PASS") {
    context.addIssue({ code: "custom", message: "qualified HSS quality requires a passing capacity result", path: ["hss"] });
  }
  if (value.hss.qualityStatus === "qualified" && !["jlink", "target_counter"].includes(value.hss.qualitySource)) {
    context.addIssue({ code: "custom", message: "qualified HSS quality requires a qualified source", path: ["hss"] });
  }
  if (value.writeVerification.status === "NOT_TESTED" && value.writeVerification.source !== "not_tested") {
    context.addIssue({ code: "custom", message: "untested write verification must use the not_tested source", path: ["writeVerification"] });
  }
  if (value.writeVerification.status === "PASS" && value.writeVerification.source === "not_tested") {
    context.addIssue({ code: "custom", message: "passing write verification requires a concrete source", path: ["writeVerification"] });
  }
  const expectedRecommendation = hasReleaseBlocker({
    acceptance: value.acceptance,
    ci: value.ci,
    openP0: value.openCoreIssues.P0,
    openP1: value.openCoreIssues.P1,
    hssQuality: value.hss.qualityStatus,
    writeStatus: value.writeVerification.status,
    writeSource: value.writeVerification.source,
    destinationMetadata: value.publication.destinationMetadata,
  }) ? "DO_NOT_RECOMMEND" : value.acceptance.mergeRecommendation;
  if (value.mergeRecommendation !== expectedRecommendation) {
    context.addIssue({ code: "custom", message: "merge recommendation must be derived from acceptance, HSS, write, and open core issue state", path: ["mergeRecommendation"] });
  }
  if (value.acceptance.runId !== "published") {
    context.addIssue({ code: "custom", message: "published acceptance must not retain the private run ID", path: ["acceptance", "runId"] });
  }
  for (const test of value.acceptance.tests) {
    if (!test.evidence.length || test.evidence.some((entry) => !evidenceDigest.safeParse(entry).success)) {
      context.addIssue({ code: "custom", message: "published acceptance must link every test status to an evidence digest", path: ["acceptance", "tests"] });
      break;
    }
    if (test.subcases.some((entry) => !entry.evidence.length || entry.evidence.some((reference) => !evidenceDigest.safeParse(reference).success))) {
      context.addIssue({ code: "custom", message: "published acceptance must link every subcase status to an evidence digest", path: ["acceptance", "tests"] });
      break;
    }
    if (!test.requirements.every((entry, index) => entry === `requirement-${index + 1}`)
      || !test.automatedChecks.every((entry, index) => entry === `check-${index + 1}`)
      || !test.hardwarePrerequisites.every((entry, index) => entry === `hardware-prerequisite-${index + 1}`)
      || !test.blockers.every((entry) => entry === "details-retained-in-private-evidence")
      || !test.subcases.every((entry, index) => entry.id === `subcase-${index + 1}`
        && entry.summary === (entry.status === "PASS" ? "status-recorded" : "details-retained-in-private-evidence")
        && entry.blockers.every((blocker) => blocker === "details-retained-in-private-evidence"))) {
      context.addIssue({ code: "custom", message: "published acceptance must contain only anonymous projected fields", path: ["acceptance", "tests"] });
      break;
    }
  }
  const serialized = JSON.stringify(value);
  for (const [label, pattern] of PUBLIC_CONTENT_PATTERNS) {
    if (pattern.test(serialized)) context.addIssue({ code: "custom", message: `published index must not contain ${label}`, path: [] });
  }
});

export type PublishedAcceptanceIndex = z.infer<typeof publishedAcceptanceIndexSchema>;

export interface PublishAcceptanceSummaryInput {
  repositoryRoot: string;
  outputDirectory: string;
  index: AcceptanceIndex;
  checks: Record<string, AcceptanceStatus>;
  issues: readonly IssueRecord[];
  hssQuality?: { status: z.infer<typeof qualityStatus>; source: z.infer<typeof qualitySource> };
  writeVerificationSource?: z.infer<typeof writeSource>;
  destinationMetadataSupplied?: boolean;
  generatedAt?: string;
}

export interface PublishAcceptanceSummaryResult {
  indexPath: string;
  summaryPath: string;
  index: PublishedAcceptanceIndex;
}

function checkStatus(checks: Record<string, AcceptanceStatus>, id: string): AcceptanceStatus {
  return checks[id] ?? "NOT_TESTED";
}

function combinedStatus(checks: Record<string, AcceptanceStatus>, ids: string[]): AcceptanceStatus {
  const statuses = ids.map((id) => checkStatus(checks, id));
  return statuses.every((status) => status === "PASS") ? "PASS" : statuses.includes("FAIL") ? "FAIL" : "NOT_TESTED";
}

function digest(value: unknown): string {
  return `digest:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function retainedPrivateDetails(values: readonly string[]): string[] {
  return values.length ? ["details-retained-in-private-evidence"] : [];
}

function sanitizeCase(value: AcceptanceCase): AcceptanceCase {
  return {
    testId: value.testId,
    status: value.status,
    requirements: value.requirements.map((_, index) => `requirement-${index + 1}`),
    automatedChecks: value.automatedChecks.map((_, index) => `check-${index + 1}`),
    hardwarePrerequisites: value.hardwarePrerequisites.map((_, index) => `hardware-prerequisite-${index + 1}`),
    evidence: [digest({ testId: value.testId, status: value.status })],
    blockers: retainedPrivateDetails(value.blockers),
    subcases: value.subcases.map((subcase, index) => ({
      id: `subcase-${index + 1}`,
      status: subcase.status,
      summary: subcase.status === "PASS" ? "status-recorded" : "details-retained-in-private-evidence",
      evidence: [digest({ testId: value.testId, subcase: index + 1, status: subcase.status })],
      blockers: retainedPrivateDetails(subcase.blockers),
    })),
  };
}

function unresolvedIssues(issues: readonly IssueRecord[], severity: "P0" | "P1"): number {
  return issues.filter((issue) => issue.severity === severity && issue.fixCommit === null).length;
}

function releaseBlockers(index: AcceptanceIndex, ci: z.infer<typeof ciSchema>, openP0: number, openP1: number, hss: PublishedAcceptanceIndex["hss"], write: PublishedAcceptanceIndex["writeVerification"], destinationMetadata: "supplied" | "not_supplied"): string[] {
  const blockers = index.tests
    .filter((entry) => ["FAIL", "BLOCKED", "NOT_TESTED"].includes(entry.status))
    .map((entry) => `${entry.testId} is ${entry.status}`);
  if (openP0) blockers.push(`${openP0} open P0 issue${openP0 === 1 ? "" : "s"}`);
  if (openP1) blockers.push(`${openP1} open P1 issue${openP1 === 1 ? "" : "s"}`);
  for (const [name, status] of Object.entries(ci)) {
    if (status !== "PASS") blockers.push(`CI ${name} is ${status}`);
  }
  if (index.tests.some((entry) => entry.testId === "T14" && entry.status === "PASS") && hss.qualityStatus !== "qualified") {
    blockers.push(`T14 HSS quality is ${hss.qualityStatus}`);
  }
  if (write.status === "PASS" && write.source === "not_tested") blockers.push("T07 write verification source is not_tested");
  if (destinationMetadata !== "supplied") blockers.push("destination metadata is not supplied");
  if (!blockers.length && index.mergeRecommendation === "DO_NOT_RECOMMEND") blockers.push("acceptance index does not recommend merge");
  return blockers;
}

function assertCommitBinding(repositoryRoot: string, testedCommit: string): void {
  const identity = readRepositoryIdentity(repositoryRoot);
  if (!identity.commit || identity.commit !== testedCommit || identity.dirty) {
    throw new Error("published acceptance requires a clean repository at the exact tested Git commit");
  }
}

function assertPublicContent(value: string): void {
  for (const [label, pattern] of PUBLIC_CONTENT_PATTERNS) {
    if (pattern.test(value)) throw new Error(`published acceptance contains ${label}`);
  }
}

function markdown(index: PublishedAcceptanceIndex): string {
  const counts = index.acceptance.summary;
  const rows = index.acceptance.tests.map((entry) => `| ${entry.testId} | ${entry.status} |`).join("\n");
  return [
    "# Agent-first Acceptance Summary",
    "",
    `Tested commit: \`${index.testedCommit}\``,
    "",
    "## Release gate",
    "",
    `- Environment class: ${index.environmentClass}`,
    `- CI/package/privacy: ${index.ci.build}/${index.ci.package}/${index.ci.privacy}`,
    `- HSS capacity: ${index.hss.capacityStatus}; quality: ${index.hss.qualityStatus}/${index.hss.qualitySource}`,
    `- Write verification: ${index.writeVerification.status}/${index.writeVerification.source}`,
    `- Open core issues: P0=${index.openCoreIssues.P0}, P1=${index.openCoreIssues.P1}`,
    `- Merge recommendation: ${index.mergeRecommendation}`,
    "",
    "## T01–T20 status",
    "",
    `PASS=${counts.PASS}, FAIL=${counts.FAIL}, BLOCKED=${counts.BLOCKED}, SKIPPED=${counts.SKIPPED_WITH_REASON}, NOT_TESTED=${counts.NOT_TESTED}`,
    "",
    "| Test | Status |",
    "| --- | --- |",
    rows,
    "",
    "## Blockers",
    "",
    ...(index.blockers.length ? index.blockers.map((blocker) => `- ${blocker}`) : ["- None"]),
    "",
  ].join("\n");
}

export function publishAcceptanceSummary(input: PublishAcceptanceSummaryInput): PublishAcceptanceSummaryResult {
  const source = acceptanceIndexSchema.parse(input.index);
  const testedCommit = source.codeCommit;
  if (!testedCommit) throw new Error("published acceptance requires a tested Git commit");
  assertCommitBinding(input.repositoryRoot, testedCommit);
  const issues = issueLedgerSchema.parse(input.issues);
  const openP0 = unresolvedIssues(issues, "P0");
  const openP1 = unresolvedIssues(issues, "P1");
  if (openP0 !== source.summary.openP0) throw new Error("published acceptance P0 issue count does not match the acceptance index");
  const acceptance = acceptanceIndexSchema.parse({
    ...source,
    runId: "published",
    tests: source.tests.map(sanitizeCase),
    summary: summarizeAcceptance(source.tests, openP0),
  });
  const capacityStatus = acceptance.tests.find((entry) => entry.testId === "T14")?.status ?? "NOT_TESTED";
  const writeStatus = acceptance.tests.find((entry) => entry.testId === "T07")?.status ?? "NOT_TESTED";
  const hss = {
    capacityStatus,
    qualityStatus: input.hssQuality?.status ?? "not_tested",
    qualitySource: input.hssQuality?.source ?? "not_tested",
  } as const;
  const writeVerification = { status: writeStatus, source: input.writeVerificationSource ?? "not_tested" } as const;
  const ci = {
    build: checkStatus(input.checks, "build"),
    lint: checkStatus(input.checks, "lint"),
    unit: combinedStatus(input.checks, ["unit-foundation", "unit-acceptance", "unit-artifact", "unit-direct", "unit-svd", "unit-hss-jcap"]),
    surface: checkStatus(input.checks, "surface"),
    guidance: checkStatus(input.checks, "guidance"),
    legacyScan: checkStatus(input.checks, "legacy-scan"),
    helper: checkStatus(input.checks, "hss-helper"),
    package: checkStatus(input.checks, "package"),
    privacy: checkStatus(input.checks, "privacy"),
  } as const;
  const destinationMetadata = input.destinationMetadataSupplied ? "supplied" : "not_supplied";
  const mergeRecommendation = hasReleaseBlocker({ acceptance, ci, openP0, openP1, hssQuality: hss.qualityStatus, writeStatus, writeSource: writeVerification.source, destinationMetadata })
    ? "DO_NOT_RECOMMEND"
    : acceptance.mergeRecommendation;
  const index = publishedAcceptanceIndexSchema.parse({
    schemaVersion: 1,
    testedCommit,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    environmentClass: "windows-x64",
    ci,
    hss,
    writeVerification,
    openCoreIssues: { P0: openP0, P1: openP1 },
    acceptance,
    publication: { destinationMetadata },
    blockers: releaseBlockers(acceptance, ci, openP0, openP1, hss, writeVerification, destinationMetadata),
    mergeRecommendation,
  });
  const json = `${JSON.stringify(index, null, 2)}\n`;
  const summary = markdown(index);
  assertPublicContent(json);
  assertPublicContent(summary);
  const outputDirectory = resolve(input.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  const indexPath = join(outputDirectory, "acceptance-index.json");
  const summaryPath = join(outputDirectory, "acceptance-summary.md");
  writeFileSync(indexPath, json);
  writeFileSync(summaryPath, summary);
  return { indexPath, summaryPath, index };
}
