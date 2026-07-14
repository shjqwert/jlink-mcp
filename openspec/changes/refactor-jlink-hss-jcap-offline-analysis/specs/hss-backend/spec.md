## ADDED Requirements

### Requirement: Trust validation uses one local command

`jlink-mcp trust validate` SHALL replace acceptance-mode candidate/promotion flow. Outside the MCP catalog, it SHALL validate the DLL/helper/adapter Runtime Bundle and selected ScriptFile, run bounded HSS validation, display the result, require one local-user confirmation, and persist a Trust Profile. Agent, UI and MCP tools SHALL NOT elevate trust.

#### Scenario: runtime validation succeeds

- **WHEN** a local user confirms a passing `trust validate` result
- **THEN** the exact Runtime Bundle is saved in the Trust Profile
- **AND** a changed identity requires validation again.

### Requirement: Script mode is explicit and cache-backed

HSS SHALL accept only `script.mode=none|file`. `none` explicitly selects no script and SHALL NOT fall back to a system default. `file` SHALL canonicalize and hash the source, copy it to a SHA-256-named content-addressed cache, and load that cached copy. No-op scripts and additional lock/re-hash TOCTOU schemes are not required.

#### Scenario: a source script changes after validation

- **WHEN** the original file changes after its cached copy is trusted
- **THEN** the current execution uses the cached verified copy
- **AND** selecting the changed source requires a new validation.

### Requirement: HSS uses one validated Windows x64 DLL path

The `jlink-hss` backend SHALL use the project's experimental adapter as its only supported HSS path for Windows x64 and `JLink_x64.dll`. It SHALL resolve the DLL in this order: explicit `--jlink-dll`, `JLINK_DLL_PATH`, SEGGER installation registry path, the directory of `JLink.exe` found on PATH, then common SEGGER installation directories. It SHALL NOT hard-code a machine-specific path or add cross-platform, 32-bit, or multi-DLL abstractions in the first version.

#### Scenario: validated DLL is resolved

- **GIVEN** the first matching DLL is x64 and its identity is validated
- **AND** required exports and `GetCaps` succeed
- **WHEN** HSS is probed
- **THEN** the single HSS service reports available capabilities
- **AND** capture provenance records DLL path/version/SHA-256 and adapter/helper versions and hashes.

#### Scenario: DLL is unusable

- **WHEN** no DLL is found, architecture is not x64, exports or `GetCaps` fail, or identity is unvalidated
- **THEN** HSS returns structured `unavailable`
- **AND** no Direct RTT, RSP, or external-import fallback starts automatically.

### Requirement: HSS requires one trusted dedicated ScriptFile identity

Every formal GetCaps, reset, and capture execution SHALL use the same dedicated J-Link ScriptFile identity. The identity SHALL contain a canonical absolute Windows path, the actual SHA-256, and a trusted approval digest from a project allowlist, supported project configuration, or explicitly authorized acceptance process. A caller-provided digest alone SHALL NOT approve a script. Missing, untrusted, changed, non-regular, reparse-point, non-canonical, or non-UTF-8-representable script input SHALL return structured `unavailable`; Jlink_MCP SHALL NOT use the installed default script.

The helper SHALL deny write/delete sharing while holding the canonical script handle, hash that handle before and after the fixed `ScriptFile = <path>` command, and require selection return code `0`. It SHALL preserve lossless UTF-8/UTF-16 paths. The ScriptFile selector and HSS execution path SHALL NOT expose or invoke arbitrary Raw/general ExecCommand; this restriction does not remove the existing explicit R4 raw probe/GDB auxiliary tools, which HSS SHALL NOT use as a fallback or internal escape path. The script SHA-256 and approval digest SHALL participate in the validated DLL/helper/adapter/script runtime identity; any change invalidates the approval.

A target that requires no custom initialization SHALL still use an explicitly selected, hashed and approved no-op ScriptFile. Empty selection and implicit installed defaults remain forbidden.

#### Scenario: trusted script is selected

- **GIVEN** the canonical absolute ScriptFile path and actual SHA-256 match a trusted approval
- **WHEN** GetCaps, reset, or capture crosses a J-Link execution boundary
- **THEN** the same held file identity is checked before and after selection
- **AND** selection return code `0`, effective path, actual SHA-256, approval digest, and runtime identity are returned for provenance.

#### Scenario: script selection is absent or changes

- **WHEN** either path or digest is absent, the digest is only caller asserted, the path resolves through a reparse point, content changes, selection returns nonzero, or any phase resolves a different identity
- **THEN** GetCaps/reset/capture fails before the next hardware action or HSS Start
- **AND** no installed default ScriptFile, Raw command, general ExecCommand, Direct RTT, RSP, or external-import fallback is used.

### Requirement: Runtime identity acceptance has a process-local bootstrap

Production HSS SHALL accept only DLL/helper/adapter/ScriptFile identities present in a user-promoted trust manifest and SHALL otherwise fail closed. A user MAY explicitly start an acceptance mode through a trusted local host/CLI boundary outside the ordinary MCP tool catalog. Acceptance mode SHALL be limited to one process, one exact candidate identity tuple, one target MCU, one probe/connection identity and one validation-suite version; it SHALL permit only preflight/export checks and the bounded `GetCaps → target-state check → one R3 resetBeforeCapture → stabilization → HSS Start/Read/Stop` acceptance flow.

Acceptance mode SHALL NOT permit normal RAM writes, Flash/Erase, Raw/general ExecCommand, Direct RTT/RSP/external-import fallback, wildcard identities, or persistence of provisional approval. Successful validation SHALL emit only a versioned candidate trust manifest containing DLL/helper/adapter/ScriptFile SHA-256 values, target MCU, suite version, validation time, GetCaps result and semantic-fixture result. The candidate SHALL have its own digest. Production SHALL remain closed until the user explicitly promotes that exact digest through the trusted local host/CLI, which atomically records the promoted tuple and promotion audit in the local policy/trust store; neither the target project nor JCAP raw is used as the trust store. The Agent and acceptance process SHALL NOT self-promote it.

#### Scenario: first identity tuple is evaluated

- **GIVEN** the user explicitly starts acceptance mode with one exact candidate tuple and target
- **WHEN** the bounded validation flow executes
- **THEN** only the declared acceptance operations are available for that process
- **AND** a passing run produces a candidate manifest without changing the production trust set.

#### Scenario: candidate is not promoted

- **WHEN** acceptance succeeds but no trusted local user promotion occurs
- **THEN** a later production process still reports the tuple as unvalidated
- **AND** GetCaps/reset/capture fail closed.

### Requirement: resetBeforeCapture is an explicit bounded R3 phase

When `resetBeforeCapture=true`, the resolved HSS capture plan SHALL contain a single-use R3 reset operation bound to canonical reset arguments, target identity, Artifact/layout/policy hashes, session, expiry/TTL, operation digest, and capture ID. The execution order SHALL be target/OUT/MAP/runtime identity resolution, trusted ScriptFile selection, J-Link main-backend GetCaps, target-state check, bound reset, bounded stabilization, HSS Start/Read/Stop, then reset/capture events and append-safe audit. It SHALL reuse the existing J-Link CPU-control executor without renaming or changing the input/output contract of `halt`, `resume`, or `reset`.

The resolved stabilization policy SHALL contain `minimumRecoveryMs` (`0..60000`), `timeoutMs` (`1..60000`), `pollIntervalMs` (`10..1000`), and `requiredConsecutiveRunningChecks` (`2..100`). Stabilization SHALL require the minimum recovery interval, unchanged DLL/helper/adapter/script identities, and the configured consecutive not-halted observations. The resolved values SHALL be stored in the plan and capture provenance.

#### Scenario: reset and stabilization succeed

- **GIVEN** no HSS capture is active and the R3 reset binding is current
- **WHEN** reset returns a structured success and the target satisfies the resolved stabilization policy
- **THEN** Jlink_MCP revalidates all runtime identities and starts HSS
- **AND** the new capture records every sample from `sampleIndex=0` without including pre-reset history.

#### Scenario: reset or stabilization fails

- **WHEN** the reset plan is stale, expired, replayed, mismatched, conflicts with an active capture, reset fails, target-state reads fail, identities drift, or stabilization times out
- **THEN** Jlink_MCP returns a structured binding, `capture_conflict`, reset, identity, or `HSS_TARGET_STABILITY_TIMEOUT` error
- **AND** performs no HSS Start and does not discard evidence of the attempted R3 operation.

### Requirement: HSS semantic acceptance uses predictable evidence

HSS acceptance SHALL use an independently predictable monotonic counter, fixed-step sequence, or known waveform and SHALL verify decoded values, sample order, monotonic timebase, and dropped-sample flags rather than only proving that bytes were read.

For the named HM_C095 acceptance project, the primary oracle SHALL be `g_hssDbgCounterFocIsr`, dynamically resolved from the selected OUT/MAP. The firmware increments this `uint32` once per `AppCurrentSenseHssFastUpdate`. The accepted plan SHALL record the FOC scheduling/rate evidence, the resulting modular-delta lower/upper bounds, the observation window and any permitted repeated-sample tolerance. For adjacent values, `delta=(current-previous) mod 2^32` SHALL satisfy those bounds; a wrap SHALL be accepted only when the same modular bound holds, at least one positive delta SHALL occur within the observation window, and an unexplained non-wrap decrease or out-of-bound delta SHALL fail. Other variables MAY provide diagnostics but SHALL NOT override the counter result. No symbol address or target default SHALL be hard-coded.

For `resetBeforeCapture`, the oracle SHALL begin at sample index 0 of the post-stability capture. It SHALL ignore historical pre-reset data only because that data is outside the new capture; it SHALL NOT drop a post-stability capture prefix, ignore a non-wrapping decrease, or relax duplicate, decreasing-index, gap, dropped-flag, timebase, or read-error rules.

#### Scenario: transport works but values are wrong

- **WHEN** samples arrive but any expected value, order, timebase, or dropped-sample indication is incorrect
- **THEN** semantic acceptance fails
- **AND** the DLL identity is not approved for the supported matrix.

## MODIFIED Requirements

### Requirement: HSS capture artifacts expose query and event hooks

Completed HSS captures SHALL expose JCAP raw sample segments, the raw event journal, DLL/helper/adapter/ScriptFile provenance, target identity/source/confidence, R3 reset/capture events, stabilization evidence, variable definitions, quality, event markers, flag intervals, and bounded query/export hooks through `capture.db`.

#### Scenario: completed HSS capture indexed

- **WHEN** an HSS capture completes
- **THEN** its validated raw evidence remains under the `.jcap/raw` directory
- **AND** its terminal raw event is synced and the raw journal is closed before `capture.db` is built and atomically published for query consumers.

#### Scenario: database is rebuilt

- **GIVEN** `capture.db` is missing
- **WHEN** rebuild validates the raw sample and event files
- **THEN** capture metadata, variables, events, flags, quality, and indexes are reconstructed without JSON sidecars.

### Requirement: HSS capture planning enforces variable limits

HSS capture planning SHALL consume current Variable Catalog or Hot Variable references and validate requested scalar types, variable count, sample rate, duration, record bandwidth, target state, Artifact match, and segment bounds against capabilities reported by the validated adapter.

#### Scenario: capability is exceeded

- **WHEN** a plan exceeds a reported limit or contains an unsupported type
- **THEN** Jlink_MCP rejects it before hardware access
- **AND** returns structured lower-rate, fewer-variable, or supported-type alternatives.

#### Scenario: unverified read-only target

- **WHEN** a read-only plan uses `targetArtifactMatch: unverified`
- **THEN** the plan may proceed only with a persistent warning recorded in JCAP provenance.

#### Scenario: target mismatches

- **WHEN** a plan uses `targetArtifactMatch: mismatch`
- **THEN** capture is rejected before hardware access.

### Requirement: HSS variable writes support R2 production scalar and fixed-array targets

Allowlisted RAM scalar, fixed-array element, and fixed contiguous slice writes on a `verified` target SHALL be R2. Every request SHALL use `variable_write_plan`, not an R3 operation plan, and bind Artifact/layout/policy/session identity and TTL. Execution SHALL validate RAM region, type/range/value, policy and `maxWrites`, read the old value, serialize through the capture owner/queue, write, read back, and append the aligned event and append-safe audit record. No user approval SHALL be required for this normal R2 flow. An `unverified` target SHALL deny writes by default and MAY proceed only through an explicit R4 policy exception with trusted user approval; a `mismatch` SHALL always reject capture and write.

#### Scenario: fixed array slice write accepted

- **GIVEN** policy allows a fixed RAM array slice and target identity is verified
- **WHEN** a valid R2 `variable_write_plan` executes
- **THEN** old, requested, and readback values are recorded
- **AND** the capture event is aligned to the common monotonic tick domain.

#### Scenario: active capture queues an R2 write

- **GIVEN** an HSS capture is active and the capture owner accepts the bounded write
- **WHEN** the verified R2 write executes
- **THEN** it is serialized through the capture queue without bypassing sampling ownership
- **AND** its event and audit preserve old/requested/readback values and monotonic timing.

#### Scenario: stale or mismatched target is rejected

- **WHEN** Artifact/layout/policy/session identity is stale or `targetArtifactMatch` is `mismatch`
- **THEN** no target memory is written
- **AND** a structured rejection is audited.

## REMOVED Requirements

### Requirement: HSS requires explicit SDK configuration and adapter proof

**Reason**: The project does not depend on or claim support for the official SEGGER SDK; SDK configuration is not an HSS availability prerequisite.

**Migration**: Use the validated Windows x64 DLL resolution and identity contract defined above.
