## ADDED Requirements

### Requirement: Trust validation uses one local command

`jlink-mcp trust validate` SHALL be the sole trust-validation flow. Outside the MCP catalog, it SHALL validate the exact project/DLL/helper/adapter/script-mode/cache-script/target/probe/suite tuple, run bounded HSS validation, display the result, require either local-user confirmation or an explicit `--user-authorized true` supplied under direct user instruction, and atomically persist a Trust Profile in the project's external user-local trust namespace. UI and MCP tools SHALL NOT elevate trust.

#### Scenario: runtime validation succeeds

- **WHEN** a local user confirms a passing `trust validate` result or supplies explicit direct authorization for `--user-authorized true`
- **THEN** the exact Runtime Bundle is saved in the Trust Profile
- **AND** a changed identity requires validation again.

### Requirement: Script mode is explicit and cache-backed

HSS SHALL accept only `script.mode=none|file`. `none` explicitly selects no script and SHALL NOT fall back to a system default. `file` SHALL canonicalize and hash the source, copy it to a SHA-256-named content-addressed cache in the external user-local trust namespace, and load that cached copy. The namespace SHALL be derived from the SHA-256 of the canonical project real path and SHALL NOT be inside the project workspace at the OS real-path layer. Before creating or accessing a profile or cache, the implementation SHALL resolve the store's nearest existing ancestor and validate its uncreated suffix, rejecting extended-length, junction/reparse-point, SUBST, and 8.3 aliases that map to the project root or a descendant. No-op scripts and additional lock/re-hash TOCTOU schemes are not required.

#### Scenario: a source script changes after validation

- **WHEN** the original file changes after its cached copy is trusted
- **THEN** the current execution uses the cached verified copy
- **AND** selecting the changed source requires a new validation.

### Requirement: Target project and writable HSS roots are separate

HSS SHALL bind Trust Profile, target selection, OUT and MAP resolution to the canonical real `projectRoot`, while capture/export/temp data use an explicit external `storageRoot` and audit/session evidence uses an explicit external `evidenceRoot`. Both writable roots SHALL be rejected when they resolve to `projectRoot` or a descendant. Production plans and metadata SHALL record all three roots.

#### Scenario: read-only target project is used for capture planning

- **WHEN** HSS plans or runs against a target project with external storage and evidence roots
- **THEN** every capture, temporary, export, audit and session file is created outside the target project
- **AND** an automated before/after relative-path manifest and per-file SHA-256 snapshot is unchanged.

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

### Requirement: Production HSS uses the persistent Trust Profile

Every formal GetCaps, target-state, reset, and capture execution SHALL derive the external user-local namespace from the canonical project real path, resolve the external store through the same real-path policy used by local trust validation, and reload and verify its persistent Trust Profile for the exact project/DLL/helper/adapter/script-mode/target/probe/suite tuple. In `file` mode the profile binds the verified external cache SHA-256 and the helper receives only that cache path/hash; in `none` mode it receives neither path nor hash. Project `.jlink-mcp` files, a caller digest, target project, JCAP raw, Agent, MCP Tool, or offline UI SHALL NOT establish trust.

Any missing external profile, project-namespace mismatch, tuple mismatch, changed runtime identity, cache collision/tamper, or changed cached script SHALL fail closed before the next hardware action or HSS Start. HSS SHALL NOT use an installed default ScriptFile, Raw/general ExecCommand, Direct RTT, RSP, or external-import fallback.

#### Scenario: exact trusted tuple executes

- **GIVEN** the persistent Trust Profile matches the current runtime, script mode, target, probe, and suite
- **WHEN** GetCaps, target-state, reset, or capture crosses a J-Link boundary
- **THEN** the helper receives the explicit script mode and matching cache identity
- **AND** runtime and script provenance are recorded.

#### Scenario: trusted tuple changes

- **WHEN** any project namespace/DLL/helper/adapter/script mode/cache script/target/probe/suite identity changes or a restarted process reloads a nonmatching profile
- **THEN** GetCaps/reset/capture fails closed before the next hardware action or HSS Start.

### Requirement: resetBeforeCapture is an explicit bounded R3 phase

When `resetBeforeCapture=true`, the resolved HSS capture plan SHALL contain a single-use R3 reset operation bound to canonical reset arguments, target identity, Artifact/layout/policy hashes, session, expiry/TTL, operation digest, and capture ID. The execution order SHALL be target/OUT/MAP/runtime identity resolution, trusted script-mode/cache identity validation, J-Link main-backend GetCaps, target-state check, bound reset, bounded stabilization, HSS Start/Read/Stop, then reset/capture events and append-safe audit. It SHALL reuse the existing J-Link CPU-control executor without renaming or changing the input/output contract of `halt`, `resume`, or `reset`.

The resolved stabilization policy SHALL contain the dynamically resolved counter address, `uint32` modulus, expected counter rate and tolerance, `minimumRecoveryMs` (`0..60000`), `timeoutMs` (`1..60000`), `pollIntervalMs` (`10..1000`), and `requiredConsecutiveRunningChecks` (`2..100`). After the capture helper's own `JLINKARM_Connect`, the same DLL connection SHALL use a single-element `JLINKARM_ReadMemU32` read with per-element status and require the minimum recovery interval plus the configured consecutive running, modular-forward, in-rate windows before `JLINK_HSS_Start`. A non-wrapping decrease within the recovery interval and before a running window begins SHALL reset the counter baseline and consecutive count as initialization restart evidence without extending the timeout; the same decrease after recovery or after a running window begins SHALL fail closed. Timeout, failed/status-invalid read or target halt SHALL perform no HSS Start. Success and failure SHALL report check count, elapsed time, first/last values and rate evidence. The resolved values SHALL be stored in the plan and capture provenance.

The HM_C095 default `minimumRecoveryMs` SHALL be 1000ms based on the observed approximately 305ms connect-time initialization restart and SHALL remain caller-overridable within the validated bounds.

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

For the named HM_C095 acceptance project, the primary oracle SHALL be `g_hssDbgCounterFocIsr`, dynamically resolved from the selected OUT/MAP. The firmware increments this `uint32` once per ADC1 DMA completion. The accepted plan SHALL derive the counter rate from the selected build's FOSC, MCPWM PARCC/divider/center-aligned period and TDG PARCC/prescaler/delay configuration, record the inputs, formula and source hashes, and distinguish the upstream 16kHz PWM rate from the resulting 8kHz DMA counter rate. It SHALL record the resulting modular-delta lower/upper bounds, the observation window and bounded repeated-sample tolerance. For adjacent values, `delta=(current-previous) mod 2^32` SHALL satisfy those bounds; a wrap SHALL be accepted only when the same modular bound holds, at least one positive delta SHALL occur within the observation window, and an unexplained non-wrap decrease or out-of-bound delta SHALL fail. Other variables MAY provide diagnostics but SHALL NOT override the counter result. No symbol address, target default or fixed product rate SHALL be hard-coded.

For `resetBeforeCapture`, the oracle SHALL begin at sample index 0 of the post-stability capture. It SHALL ignore historical pre-reset data only because that data is outside the new capture; it SHALL NOT drop a post-stability capture prefix, ignore a non-wrapping decrease, or relax duplicate, decreasing-index, gap, dropped-flag, timebase, or read-error rules.

#### Scenario: transport works but values are wrong

- **WHEN** samples arrive but any expected value, order, timebase, or dropped-sample indication is incorrect
- **THEN** semantic acceptance fails
- **AND** the DLL identity is not approved for the supported matrix.

## MODIFIED Requirements

### Requirement: HSS capture artifacts expose query and event hooks

Completed HSS captures SHALL expose JCAP raw sample segments, the raw event journal, DLL/helper/adapter/script-mode/cache-script provenance, target identity/source/confidence, R3 reset/capture events, stabilization evidence, variable definitions, quality, event markers, flag intervals, and bounded query/export hooks through `capture.db`.

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
