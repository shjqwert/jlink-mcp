## MODIFIED Requirements

### Requirement: HSS acceptance proves the declared ceiling

T14 SHALL include a four-variable 100 Hz ten-second Smoke capture and a fixed synchronized 1 kHz 60-second Full capture of at most ten variables. Full SHALL expect 60,000 received frames and require at least 57,000 valid frames. Acceptance SHALL report rate/duration capacity separately from quality-source completeness.

#### Scenario: Full capture with qualified quality source
- **WHEN** Full produces at least 57,000 valid frames, closes cleanly, and a J-Link or target-counter source accounts for quality loss
- **THEN** the capability and full-quality subcases pass
- **AND** Raw and DB evidence identify the sanitized Artifact generation and environment class.

#### Scenario: Full capture without qualified quality source
- **WHEN** Full meets frame and lifecycle bounds but has no independent quality source
- **THEN** the capability subcase may pass while metadata remains `qualityStatus=partial`
- **AND** no zero-loss/full-quality assertion passes.

#### Scenario: Smoke only passes
- **WHEN** Smoke passes but Full fails or is not executed
- **THEN** the maximum capability is not marked passed
- **AND** its actual status and evidence are retained.

### Requirement: Git delivery excludes generated hardware evidence

Git delivery SHALL exclude JCAP, Raw, DB, CSV, full logs, exact commands, target firmware binaries, local paths, Probe identifiers, and unsanitized Artifact hashes. It MAY include one current-commit sanitized Markdown summary and one bounded JSON acceptance index under `reports/agent-first/`.

#### Scenario: hardware acceptance completes
- **WHEN** local acceptance finishes on the final candidate commit
- **THEN** full results remain under ignored `test-output/` and only the sanitized summary/index are eligible for Git
- **AND** each published status links to a redacted issue ID or non-sensitive evidence digest rather than a local evidence path.

#### Scenario: no current hardware rerun
- **WHEN** software changes exist after the latest hardware run
- **THEN** the published summary marks hardware results stale or not tested for the current commit
- **AND** does not reuse the older commit's PASS state.

## ADDED Requirements

### Requirement: Tracked release content is privacy scanned

A deterministic scanner SHALL inspect tracked text/configuration and packed-file names for machine-specific paths, Probe identifiers, target binary payloads, private Artifact hashes, credentials, and unsanitized hardware evidence. It SHALL emit only category, repository-relative file, and line number; it SHALL NOT echo the matched secret value.

#### Scenario: sensitive tracked text is found
- **WHEN** a tracked file contains a forbidden local path or hardware identifier
- **THEN** the privacy check fails with category, relative path, and line
- **AND** omits the matched value from stdout, stderr, and generated reports.

#### Scenario: generated local evidence exists
- **WHEN** ignored `test-output/` contains hardware paths, serials, hashes, Raw, DB, or logs
- **THEN** the tracked-content scan ignores that local directory
- **AND** package validation proves none of it enters the distribution.

### Requirement: Final acceptance summary is sanitized and commit-bound

`reports/agent-first/acceptance-summary.md` and `reports/agent-first/acceptance-index.json` SHALL identify the exact tested commit, software/CI/package results, T01-T20 status counts, HSS capacity and quality status/source, write verification source, remaining P0/P1 issues, and merge recommendation using anonymous environment classes only.

#### Scenario: summary is publishable
- **WHEN** the final software and authorized hardware regressions target one commit
- **THEN** the summary passes privacy/schema checks and contains no local evidence path, Probe identifier, target binary, or private Artifact hash
- **AND** its merge recommendation is derived from applicable test status and open core P0/P1 issues.

#### Scenario: release gate is incomplete
- **WHEN** CI, package validation, hardware regression, destination metadata, or a core P0/P1 remains unresolved
- **THEN** the summary reports the exact blocker and recommends no public release
- **AND** no remote push or history rewrite is performed automatically.
