# acceptance-evidence Specification

## Purpose
Define local, truthful, Git-ignored acceptance evidence and immutable issue recording for Agent-first MCU debugging.

## Requirements

### Requirement: Local test output is visible and Git-ignored

Jlink-MCP SHALL place all new test and capture output under repository-local ignored `test-output/`. It SHALL NOT write evidence into the target firmware project.

#### Scenario: operation without run ID
- **WHEN** an HSS capture starts without `runId`
- **THEN** it stores the package under `test-output/captures/<captureId>.jcap/`
- **AND** creates no commands log or synthetic run directory.

#### Scenario: explicit run ID
- **WHEN** an acceptance tool receives a valid explicit `runId`
- **THEN** it may create `test-output/<runId>/` with environment, preconditions, acceptance index, issue ledger, commands, tests, captures, manifests, and logs
- **AND** never commits that directory to Git.

### Requirement: Persistent command logging is opt-in

Target operations SHALL append one bounded NDJSON operation record to `test-output/<runId>/commands.ndjson` only when `runId` is present. HSS variable-write events SHALL still be persisted in `raw/events.bin` regardless of run ID.

#### Scenario: normal Agent debugging
- **WHEN** a normal non-HSS operation has no run ID
- **THEN** it returns its structured response
- **AND** writes no persistent command log.

#### Scenario: acceptance run command
- **WHEN** an operation executes with run ID
- **THEN** its operation ID, exact request facts, result envelope, timestamps, code commit, Target/Artifact identity, and referenced output hashes are appended
- **AND** the append does not overwrite earlier records.

#### Scenario: operation completes before command logging fails
- **WHEN** a successful or failed requested operation has observed explicit side effects but its command record cannot be appended
- **THEN** the returned evidence error preserves those observed effects and reports that a side effect was issued
- **AND** retryability is disabled, the original operation error is preserved when present, and the Agent is warned not to retry the operation automatically.

### Requirement: Acceptance results use a fixed honest vocabulary

Every acceptance case and subcase SHALL use only `PASS`, `FAIL`, `BLOCKED`, `SKIPPED_WITH_REASON`, or `NOT_TESTED`. Missing prerequisites, unsupported capability, or absent evidence SHALL NOT be represented as passing.

#### Scenario: SVD unavailable
- **WHEN** exact Z20K146M SVD is unavailable during hardware acceptance
- **THEN** SVD peripheral cases are `BLOCKED`
- **AND** successful raw-memory alternatives do not change their status.

#### Scenario: erase disabled for another run
- **WHEN** a run does not explicitly set `allowErase=true`
- **THEN** T13 is `SKIPPED_WITH_REASON`
- **AND** no erase command is issued.

### Requirement: T01 through T20 are traceable to requirements and evidence

The change SHALL maintain a traceability matrix mapping every applicable T01-T20 case to normative requirements, automated checks, hardware prerequisites, evidence paths, and result status.

#### Scenario: acceptance index generated
- **WHEN** a run finishes or stops at a blocking failure
- **THEN** `acceptance-index.json` lists every T01-T20 ID with status, requirement links, evidence references, and blockers
- **AND** omitted tests appear as `NOT_TESTED` rather than disappearing.

#### Scenario: active Capture prevents run completion
- **WHEN** a run-scoped JCAP is active, finalizing, malformed, missing required Raw/DB files, still building its index, or fails Raw/SQLite integrity verification
- **THEN** publication of `acceptance-index.json` is rejected while holding the same run lease
- **AND** the run remains open until the Capture is stopped or recovered into a stable terminal state with a verified ready index.

#### Scenario: Capture mutation follows durable run ownership
- **WHEN** rebuild, analysis persistence, or export targets a Capture owned by an acceptance run and the caller omits `runId` or supplies a different run ID
- **THEN** the mutation is checked while holding the Capture owner's run lease
- **AND** a completed owner or mismatched active request run is rejected before any Capture file changes.

### Requirement: HSS acceptance proves the declared ceiling

T14 SHALL include a four-variable 100 Hz ten-second Smoke capture and a fixed ten-variable synchronized 1 kHz 60-second Full capture. Full SHALL expect 60,000 frames and require at least 57,000 valid frames; every drop and overflow SHALL be counted explicitly.

#### Scenario: capability maximum passes
- **WHEN** Full capture produces at least 57,000 valid frames, closes cleanly, and accounts for all quality loss
- **THEN** the 1 kHz/ten-variable/60-second capability case passes
- **AND** Raw and DB evidence identify the exact Artifact and environment.

#### Scenario: Smoke only passes
- **WHEN** Smoke passes but Full fails or is not executed
- **THEN** the maximum capability is not marked passed
- **AND** its actual status and evidence are retained.

### Requirement: Capture-time write acceptance uses fixed timing and restoration

T15 SHALL capture the fixed ten-variable frame at 1 kHz for 60 seconds, write `g_hssDbgWriteProbe=0x13579BDF` near 20 seconds with old-value capture and verification, write the captured old value near 40 seconds with verification, and retain pre/write/post windows.

#### Scenario: capture write passes
- **WHEN** both writes are issued and verified, the final value equals the initial old value, aligned write events exist, and the capture remains queryable
- **THEN** T15 passes
- **AND** event intervals, neighboring sample indices/ticks, and any quality gap agree.

### Requirement: Issue records are immutable per run

Every discovered problem SHALL record issue ID, discovery time, test ID, P0/P1/P2 severity, commit, environment, preconditions, reproduction, expected/actual results, raw evidence paths/hashes, workaround, initial cause, blocking scope, fix commit, and regression result.

#### Scenario: failure is fixed
- **WHEN** a code fix is ready after a failed hardware run
- **THEN** the original run evidence remains unchanged and a new run ID is created for regression
- **AND** the failed case plus dependent regression cases are rerun.

#### Scenario: P0 discovered
- **WHEN** a P0 blocks a capability
- **THEN** dependent cases stop while independent cases may continue
- **AND** merge is not recommended until the P0 is closed.

### Requirement: Git delivery excludes generated hardware evidence

The change SHALL use six scoped commits and SHALL push each only after its required verification. It SHALL NOT create a seventh hardware-summary commit or commit JCAP, Raw, DB, CSV, or full logs.

#### Scenario: hardware acceptance completes
- **WHEN** local T01-T20 acceptance finishes
- **THEN** results remain under ignored `test-output/` and are reported in the Agent handoff
- **AND** Git history remains at the six implementation/spec/test commits unless a real code fix requires a separate scoped commit.
