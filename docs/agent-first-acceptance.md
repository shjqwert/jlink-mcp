# Agent-first MCP and local acceptance

This document describes the current standalone MCP. Historical approval-era documents under `docs/` are not current interfaces.

## Direct operation model

The Agent chooses and sequences operations. MCP validates the explicit request, serializes access to one Probe, executes it, and returns an operation envelope containing observed state, effects, verification, warnings, errors, and output references.

- Configure each canonical `projectRoot` with `target_configure` before project or hardware tools.
- Reconfigure explicitly after changing the board, Artifact, SVD, or J-Link settings.
- Reads never halt or reset implicitly. A backend that needs a halt returns `HALT_REQUIRED`.
- Writes default to `captureOld=false`, `verify=false`, and `restore=false`. Request only the confirmation steps needed for the debugging decision.
- Peripheral register tools require an explicit validated SVD. Raw memory is an explicit alternative, not SVD coverage.
- Flash, erase, CPU control, GDB, Probe commands, and HSS execute directly without approval tokens or plan authority.

## HSS and JCAP v1

The current HSS limit is ten synchronized variables, 1 kHz, and 60 seconds. `hss_plan` validates and calculates only; `hss_start` is the direct start operation. An active capture owns the Probe, while declared capture variables may use the capture-aware write path.

Every finalized package contains exactly:

```text
<captureId>.jcap/
  capture.json
  raw/samples.bin
  raw/events.bin
  capture.db
```

`capture.json` plus the two append-only Raw files are authoritative. `capture.db` is a derived query index and is rebuilt atomically. CSV is generated only by `capture_export_csv` and remains outside the package.

## Evidence routing

`test-output/` is repository-local and Git-ignored.

- No `runId`: HSS uses `test-output/captures/`; export uses `test-output/exports/`; ordinary tool calls create no persistent command log.
- Explicit `runId` (1–96 safe ASCII characters): every tool appends a bounded command record and acceptance output uses `test-output/<runId>/`.
- A completed run ID is immutable. Once `acceptance-index.json` exists, MCP rejects that `runId` before executing the requested tool. Capture rebuild, analysis persistence, and export are guarded by the Capture's owning run even when the caller omits `runId`; a different request run is rejected. Use a new run ID after a failure or code fix; do not overwrite the earlier run.
- Acceptance completion is rejected while any run-scoped JCAP is active, finalizing, malformed, missing Raw/DB data, using a non-ready index, or failing SQLite/Raw identity verification. Stop or recover the Capture and verify its ready index before publishing `acceptance-index.json`.

Each command record keeps the exact request/result and hashes every declared output. For a growing active HSS Raw file, `bytes` and `sha256` identify the immutable prefix visible through one open file descriptor; hashing failures are reported as evidence failures instead of being omitted. If command logging fails after any successful or failed operation records explicit effects, those effects remain authoritative, `writeIssued` is true, automatic retry is disabled, and the original operation error is preserved when present.

The run layout is:

```text
test-output/<runId>/
  run.json
  environment.json
  preconditions.json
  acceptance-index.json
  issue-ledger.json
  issue-ledger.md
  commands.ndjson
  hashes.json
  tests/<T01..T20>/result.json
  captures/
  manifests/
  logs/
```

Environment files may contain local paths, Probe identity, and Artifact hashes. Never commit or push this tree.

## Software acceptance

Use a new run ID:

```powershell
npm run acceptance:software -- --run-id software-<timestamp>
```

Optional arguments:

- `--project-root <path>` records before/after manifests without writing to the project.
- `--artifact <path>` records local Artifact identity.
- `--allow-erase` records run-level erase permission; it does not execute erase in the software runner.
- `--svd-available` declares that an exact validated SVD prerequisite is available.

The runner executes dependency installation, build, lint, unit/simulated tests, standalone surface checks, the legacy-control-plane scan, native HSS self-test, OpenSpec validation, and Git-ignore verification. It writes every T01-T20 entry even when hardware is not run.

Only these result values are valid:

- `PASS`
- `FAIL`
- `BLOCKED`
- `SKIPPED_WITH_REASON`
- `NOT_TESTED`

Fixture success never converts missing hardware, Artifact match, SVD, or erase permission into a pass.

## Hardware ordering

Hardware execution is a separate local run and must preserve the software evidence run.

1. Revalidate board, Probe, project, Artifact/flash association, recovery method, connection, and erase permission without mutating the target.
2. Flash and verify the associated image first to establish a verified live Artifact generation.
3. Execute applicable Artifact, variable, queue, CPU-control, and failure cases in dependency order.
4. Run HSS Smoke at four variables, 100 Hz, 10 seconds.
5. Run HSS Full at ten variables, 1 kHz, 60 seconds; require at least 57,000 of 60,000 frames and explicit loss/overflow counts.
6. Run the 60-second capture-write case, writing near 20 seconds and restoring the captured old value near 40 seconds with verification.
7. Run recovery, Raw integrity, DB rebuild, bounded query, CSV, and the complete Agent loop.
8. Execute erase only when the run explicitly sets `allowErase=true`, then immediately flash/verify the recovery image and restore execution explicitly.

Unavailable exact SVD coverage remains `BLOCKED`. Do not substitute guessed registers or raw memory and label it as SVD validation.

## Merge and Offline UI

Do not recommend merge while an applicable T01-T20 case is failed, blocked by a required prerequisite, or not tested, or while a P0 issue remains open. No hardware-summary commit is created by default; local AI and UI consumers read ignored evidence directly.

The existing Offline UI source is retained but is not modified, expanded, or accepted in this change. Producer-side SQLite compatibility is the only UI-related verification in scope.
