## Context

仓库已有 HSS 只读采样和 capture-time RAM write MVP，但当前数据分散在 BIN、JSON、JSONL、CSV，且存在两套 HSS 可用性判断和多条 capture fallback。目标工程验证基线是 `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config`；其现有硬件证据只证明 transport/data-quality，尚未证明 semantic correctness。

## Goals / Non-Goals

**Goals**

- 把实验性 J-Link DLL API adapter 定义为项目支持的正式、唯一 HSS 主路径。
- 建立内容驱动的 Artifact/Symbol/Hot Variable 合同。
- 采样线程只追加版本化 raw BIN；停止后构建可恢复的 SQLite 查询库。
- 为 Agent 和 UI 提供相同的有界查询与确定性分析合同。
- 保持变量写入的 policy、风险分级、readback 和 audit 边界；只有 R4 例外需要用户 approval。
- replacement-first 地删除被替代的旧能力。

**Non-Goals**

- 不依赖或宣称 SEGGER 官方 SDK 支持。
- 不在 MCP 中嵌入 LLM 或多轮业务编排。
- UI 不连接硬件、不启动/停止采样、不写变量。
- 不实现多探针、多核、多镜像、多 HSS group 或 SVD。
- 不自动构建、烧录或修改目标工程。

## Architecture

```text
External Agent
  → MCP discovery/risk metadata
  → Artifact + Symbol Catalog + Hot Variables
  → HSS Service → validated J-Link DLL adapter → helper/DLL
  → <captureId>.jcap/raw/{capture_*.bin,events.bin}
  → finalizer → capture.db
  → bounded query/analysis → local loopback Web offline UI
```

```text
<captureId>.jcap/
  capture.db
  raw/
    capture_0001.bin
    events.bin
  export/
    *.csv                 # only when requested
```

## Decisions

### 1. Experimental DLL adapter is the supported HSS mainline

The project SHALL treat the current experimental J-Link DLL API adapter as its supported production HSS path. “Supported” means validated by this project; it does not imply a SEGGER SDK contract. The first release SHALL support only Windows x64 with `JLink_x64.dll`; it SHALL NOT add cross-platform, 32-bit, multi-DLL, or provider abstractions in advance.

- DLL resolution order is explicit `--jlink-dll`, then `JLINK_DLL_PATH`, then the SEGGER installation registry path, then the directory containing `JLink.exe` found on PATH, then common SEGGER installation directories.
- No machine-specific absolute DLL path is stored as a default. If no DLL is found, its architecture is not x64, required exports or `GetCaps` fail, or its identity is not validated, HSS reports structured `unavailable`.
- A single HSS service owns planning, availability and Start/Read/Stop; generic backend routing and direct helper shortcuts are removed.
- No automatic fallback to Direct RTT, RSP or external import is allowed.
- Every formal GetCaps, reset and capture requires one dedicated J-Link `ScriptFile` selected by canonical absolute path and a SHA-256 approved by a trusted allowlist, project configuration, or explicitly authorized acceptance process. A target that needs no custom initialization still supplies an explicitly selected and approved no-op ScriptFile. A caller-provided digest alone is not approval; an empty script selection is structured `unavailable` and never falls back to the installed default script.
- The helper opens a regular non-reparse script with write/delete sharing denied, canonicalizes it, hashes the held handle, keeps the handle through the fixed `ScriptFile = <path>` command, requires return code `0`, and rehashes the same handle. UTF-8/UTF-16 conversion is lossless; no generic ExecCommand input is exposed.
- Each capture records the resolved DLL path, DLL version and SHA-256, adapter version/hash, helper version/hash, effective script path/SHA-256/approval digest/GetCaps and capture selection results, architecture, resolution source, and validated capabilities.
- Production mode accepts only identities in a user-promoted trust manifest and fails closed on an unknown or changed DLL/helper/adapter/script identity.
- Acceptance mode is a user-explicit local host/CLI invocation outside the ordinary MCP tool catalog. It is process-local, binds one exact DLL/helper/adapter/ScriptFile tuple, target MCU, probe/connection identity and validation-suite version, and permits only export/preflight checks plus the bounded `GetCaps → target-state check → one R3 resetBeforeCapture → stabilization → HSS Start/Read/Stop` acceptance flow. It exposes no normal RAM write, Flash/Erase, Raw/ExecCommand or fallback capability.
- A successful acceptance run emits only a candidate trust manifest containing the four identities, target MCU, suite version, validation time, GetCaps result and semantic-fixture result. Production trust remains closed until a user explicitly promotes that exact candidate through the trusted local host/CLI boundary; the acceptance process and Agent cannot self-promote it.
- The minimum validation gate is export discovery, `GetCaps`, Start/Read/Stop lifecycle, record decoding and a semantic fixture whose expected values are independently known.

### 2. Artifact identity and target match are explicit

`projectRoot` is the supplied directory or MCP cwd; Git is not used to infer it. Artifact candidates are content-probed while excluding `.git`, `node_modules`, `.jlink-mcp` and configured cache directories. `.elf/.out/.axf` may provide symbols; `.hex/.bin/.srec` are flash artifacts only.

Target identity is resolved only from explicit input, then supported project configuration files. If the result is absent or ambiguous, Jlink_MCP returns a structured selection error. It never guesses from directory name, project name, test history, or a default MCU. The result records `targetId`, configuration source, and confidence.

Each artifact generation binds canonical path, format, SHA-256, optional MAP SHA-256 and `symbolLayoutHash`. `targetArtifactMatch` is `verified | unverified | mismatch`:

- V1 first validates the resolved MCU target identity, then constructs the Artifact-defined nonvolatile load image. For ELF this consists only of file-backed bytes (`p_filesz`) in loadable `PT_LOAD` segments mapped to target Flash/nonvolatile regions; OUT/AXF uses equivalent file-backed load records. RAM initializers, BSS/`SHT_NOBITS`, `NOLOAD`, address gaps, and the `p_memsz - p_filesz` tail are not compared.
- The J-Link main backend reads and compares every byte of that load image without modifying target state. A complete byte-for-byte match is `verified`; any definite byte difference is `mismatch`; unsupported parsing, incomplete/failed reads, ambiguous nonvolatile mapping, or inability to compare the full image is `unverified`. Chunking may bound memory and response size but cannot sample or omit bytes.
- Verification evidence binds Artifact SHA-256, resolved target identity, probe serial, connection generation and runtime/script identities. It is invalidated by an Artifact hash change, target/probe change, any J-Link reconnect/new connection generation, Flash/Erase, or a Raw operation that may modify Flash; stale evidence is never reused as `verified`.
- read-only capture may proceed when `unverified`, with a persistent warning in plan and JCAP;
- writes are denied by default when `unverified`; only an explicit R4 policy exception may permit one;
- `mismatch` is a hard rejection for capture and write.

### 3. Variable identity is separate from layout

The stable key is `qualifiedName + memberPath`. Runtime layout includes artifact generation, address, type, size, region, resolver and confidence. Hot Variables cache only validated layouts for a process-local debug session. Artifact/MAP/policy/session changes make entries stale; stale entries cannot be read, written or sampled until selectively refreshed.

JCAP v1 sampling supports scalar 1/2/4-byte integer/enum/boolean values and IEEE-754 float32. The `uint32` value slot preserves raw bits. Unsupported widths, float64, dynamic arrays, bitfields and pointer dereference are rejected. Fixed-array element/slice targets remain valid for controlled writes but are expanded to supported scalar sample columns for HSS.

### 4. Raw capture is authoritative and rebuildable

JCAP v1 is byte-frozen. Every multibyte field is unsigned little-endian; the endian marker is `0x01020304`. Binary UUIDs are 16 RFC-4122 network-order bytes, SHA-256 values are 32 raw bytes, and CRC algorithm `1` is CRC-32/ISO-HDLC/IEEE (`refin/refout=true`, reflected polynomial `0xEDB88320`, init/xorout `0xFFFFFFFF`) stored as little-endian `u32`. The package name is a lowercase RFC-4122 UUID-v4 and is the same UUID stored in every raw header.

Each `raw/capture_NNNN.bin` starts with a synced 512-byte `JCAPSEG\0` header and a synced, CRC-protected descriptor block before any records. The descriptor block is self-contained, at most 1 MiB, and contains CAPTURE, TARGET, ARTIFACT, RUNTIME, SCRIPT, then up to 64 VARIABLE descriptors in ascending `variableId`. It contains every string and identity needed to rebuild the index without JSON, JSONL, CSV, a sidecar, or `capture.db`.

The pre-implementation JCAP v1 descriptor contract is re-frozen to insert one mandatory SCRIPT descriptor between RUNTIME and VARIABLE. It records the effective path, script SHA-256, trusted-approval SHA-256, no-fallback/approval flags, and GetCaps/capture selection return codes. Header, record, footer, CRC, scalar and status layouts remain unchanged; no released JCAP v1 runtime data exists to migrate.

Each sample record is fixed-width and CRC-protected:

```text
u64 sampleIndex
u64 captureRelativeNanosecondTick
u32 statusFlags
u32 reserved = 0
u32 rawValue[variableCount]
u32 recordCrc32
```

The record size is `28 + 4 * variableCount`; its CRC covers the preceding `24 + 4 * variableCount` bytes. Sample indexes strictly increase across segments and ticks are nondecreasing. Ticks use integer QPC conversion `floor((qpcNow - qpcStart) * 1_000_000_000 / qpcFrequency)`, never wall-clock or rate estimation. A sample-index gap is legal only when `dropped_before_this_sample` is set.

A clean segment ends with one 64-byte `JCAPEND\0` footer. A segment rolls before a record would make the file exceed 128 MiB including that footer. Parsers validate the header and descriptors first, accept only the contiguous CRC-valid record prefix, report partial tails or corruption, and never resynchronize or synthesize gaps.

`raw/events.bin` starts with a synced 256-byte `JCAPEVT\0` header and contains append-safe `EVT1` frames. Frames use the sample QPC-relative tick domain and a bounded, 4-aligned TLV payload for lifecycle, target-control reset, variable-write, quality-interval, fault, and segment-rollover events. A frame becomes visible only when its final frame CRC is valid; an incomplete or invalid tail is ignored and reported. The optional audit SHA-256 references the separate append-safe security audit instead of copying mutable audit data.

For `resetBeforeCapture`, the QPC epoch and `planned` journal are created before reset. The reset event occurs while planned; `active` is appended only after reset succeeds, stabilization succeeds and HSS Start succeeds. The first sample remains `sampleIndex=0` but may have a positive tick. Pre-reset values are not sample records, and no post-stability sample prefix may be discarded.

Raw files are immutable authority after append/close. `capture.db` is derived, schema-versioned, and source-hash bound. Rebuild reads only validated raw prefixes, records corrupt ranges explicitly, never modifies raw, and restores capture identity, descriptors, timing, quality, segment ranges, and capture-local events.

JCAP implementation starts with one shared set of byte-golden vectors covering header, descriptors, records, footer, event frames, CRCs, rollover and damaged tails. The native/C++ writer, TypeScript decoder and SQLite rebuild path must all pass those same vectors before real HSS data is connected. This sequencing does not add a live compatibility path for earlier drafts.

### 5. Capture lifecycle is explicit

Capture lifecycle and index publication are separate state machines. `captureState` is `planned | active | finalizing | completed | stopped | recoverable | failed`; `planned → failed` is allowed when script selection, reset, stabilization or HSS Start fails before sampling, so such a package may have a valid event journal and no sample segment. `indexStatus` is `absent | building | ready | rebuild_required | failed` and is derived from the active finalizer plus `capture.db` existence, integrity and source hashes; it is not appended as a post-terminal raw event.

- `active`: status and bounded live-tail metadata only; completed-series/analysis return `not_ready`.
- `finalizing`: sample segments are closed while the event journal remains open only long enough to append the terminal lifecycle event; queries return progress and `not_ready`.
- `completed` or clean `stopped`: raw capture is terminal, but full query/export/analysis requires `indexStatus=ready`; otherwise callers receive `not_ready` plus rebuild status.
- `recoverable`: raw validation/rebuild allowed; corrupt ranges are reported, never hidden.
- `failed`: summary and diagnostics allowed; series only for validated complete ranges.

Finalization closes and syncs all sample segments, appends and syncs `finalizing`, validates the complete raw prefix, appends and syncs the appropriate terminal `completed`, `stopped` or `failed` event only when that pre-terminal validation permits it, then closes the event journal. Pre-terminal corruption transitions to `recoverable` instead. No raw byte changes after a terminal event. Only then does it set `indexStatus=building`, build `capture.db.tmp` from the final raw set, validate DB integrity and every source hash, sync it and atomically rename it to `capture.db`; a valid published DB yields `ready`. A build failure leaves terminal raw intact and returns `indexStatus=failed`; after restart, closed terminal raw without a valid matching DB is `rebuild_required`. Corruption discovered after terminal closure cannot rewrite `captureState`; it is reported through index/corruption diagnostics. Finalization never deletes or edits raw evidence, and an initial DB and a later rebuild from the same raw must be equivalent.

### 6. SQLite is behind a runtime adapter gate

The implementation SHALL first select and test one SQLite runtime adapter compatible with the supported Node 18, standalone MCP, and local loopback Web packaging. No dependency is chosen by this specification. The gate requires schema creation, transactions, integrity check, atomic finalization and bundled installation tests before JCAP implementation proceeds.

`capture.db` contains capture/variable/segment/event/quality/bucket/analysis indexes. It is derived data and carries schema version plus source hashes. UI preferences are stored separately.

### 7. Queries are bounded and share one contract

`capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, `analysis_run`, `capture_export` and `capture_index_rebuild` are the shared Agent/UI boundary.

- Time inputs use capture-relative ticks or explicit milliseconds; outputs identify the unit.
- Series calls require a bounded time window, variable count and bucket count; server policy enforces maximum response points/bytes.
- Buckets return `min/max/average/last/count` and quality flags.
- Event windows validate before/after bounds and read only indexed segments.
- UI never parses raw BIN directly and CSV exists only after explicit export.

An optional `sessionName`/capture-group field supports offline navigation. It is metadata only and does not reintroduce an MCP-owned AI workflow.

### 8. Analysis is deterministic and read-only

Existing generic control/state-machine algorithms consume normalized capture query records. Findings name signals, window, supporting values, analyzer/profile version and confidence. Missing signals or insufficient quality produce warnings, not invented conclusions. Analysis writes only derived rows in `capture.db` and never changes raw or contacts hardware.

### 9. Risk review and approval binding

MCP exposes structured risk facts and enforces policy; an external Agent performs semantic review. Automatic Agent review is a conformance requirement for the reference skill/client, not a property the server can guarantee for every client.

Normal RAM variable writes on a `verified` target are R2. They use `variable_write_plan`, not an R3 operation plan, and require policy allowlist, valid RAM range/value/layout, Artifact/layout/policy/session/TTL binding, `maxWrites`, old-value read, write, readback, capture-owner serialization, capture event and append-safe audit. During active HSS capture the write is serialized through the capture queue. The Agent may decide to invoke the R2 operation from structured risk facts without user confirmation. An `unverified` target is denied by default and can proceed only through an explicit R4 policy exception; `mismatch` and R5 are always rejected.

R4 is also used for Flash/Erase, raw GDB, raw probe and equivalent high-risk actions. Each action has a read-only `*_plan` step that returns a canonical `challengeId`, `operationDigest`, single-use `nonce`, `expiresAt` and human-readable operation summary. The local MCP host creates an ephemeral signing/MAC secret at process start and exposes it only to a private local host/CLI approval broker—not to the Agent, MCP offline-analysis UI, or any MCP-callable self-approval tool. That broker displays the exact challenge and, after direct user confirmation, issues an opaque server-authenticated approval token bound to tool name, canonical arguments, target identity, Artifact/layout/policy hashes, session/connection generation, digest, expiry and nonce. `*_execute` supplies that token with the canonical operation, revalidates every binding, atomically consumes the nonce before hardware access, and audits success, failure or indeterminate outcome. Tokens do not survive a server restart; missing, expired, mismatched, forged or replayed approval returns `approval_required`/structured rejection without hardware action.

`halt`, `resume`, and `reset` remain formal R3 auxiliary tools with their existing names, input schemas, required output fields and semantic meanings. Each single call executes only through the J-Link main backend and internally performs deterministic plan creation → target-state/identity preflight → binding revalidation → execution → single-use consumption → append-safe audit. The existing response envelope may add backward-compatible `planDigest` and audit-reference metadata but may not rename or remove existing fields. During an active HSS capture, `halt` and `reset` return a structured conflict by default and perform no control action. A future exception may proceed only after explicitly stopping or marking the capture and appending both a capture event and audit record; no silent capture disruption is allowed.

`resetBeforeCapture=true` composes that same reset executor as a single-use R3 sub-operation; it is not a reset bypass. The resolved HSS plan binds canonical reset arguments, target identity, Artifact/layout/policy hashes, session, expiry/TTL, operation digest and capture ID. The binding is revalidated immediately before reset, the before/after target states and result are audited, and the reset event references that audit. The composite capture operation advertises R3 risk whenever reset is enabled.

### 10. The UI is a local loopback Web application

The first UI SHALL run as a local loopback Web application and SHALL NOT use a VS Code webview or require VS Code integration. It uses the bounded query service, never parses raw BIN, and exposes no probe, capture-control, write, flash, reset, or raw-command operation.

### 11. Replacement precedes deletion

Order: baseline and adapter proof → SQLite decision → JCAP minimal slice → Artifact/Symbol/HSS migration → writes/events → analysis/UI/discovery → per-batch deletion → end-to-end acceptance. Each deletion batch requires compile, targeted tests and accepted HSS regression evidence.

### 12. Hardware acceptance starts a new capture after explicit reset and stabilization

The supported Gate 0 sequence is fixed: resolve target, OUT/MAP and runtime identities → select the trusted ScriptFile → GetCaps through the J-Link main backend → inspect target state → execute the bound R3 reset with `resetBeforeCapture=true` → wait for bounded stabilization → HSS Start/Read/Stop → persist reset/capture events and the complete audit.

The resolved plan SHALL contain `minimumRecoveryMs` (`0..60000`), `timeoutMs` (`1..60000`), `pollIntervalMs` (`10..1000`) and `requiredConsecutiveRunningChecks` (`2..100`). Stabilization succeeds only after the minimum recovery interval, unchanged DLL/helper/adapter/script identities, and the required consecutive not-halted observations. Timeout, state-read failure or identity drift returns structured `HSS_TARGET_STABILITY_TIMEOUT` or the specific identity error and performs no HSS Start.

The HM_C095 hardware oracle is `g_hssDbgCounterFocIsr`, resolved dynamically from the selected OUT/MAP rather than a fixed address or product default. The firmware increments this `uint32` once per `AppCurrentSenseHssFastUpdate`; after explicit reset and bounded stabilization, the oracle starts at sample index 0 and covers every new-capture record. For adjacent samples, `delta=(current-previous) mod 2^32` must be within the acceptance-plan bounds derived from and recorded with the firmware FOC scheduling/rate configuration; at least one positive delta must occur within the configured observation window. A wrap is accepted only when the modular delta satisfies the same bound, never merely because the value decreased. Repeated values within the declared rate tolerance are allowed, but an unexplained non-wrap decrease, zero progress for the full window, or an out-of-bound delta fails. Other fixture variables are diagnostic and cannot override this primary result.

The same oracle validates strict sample-index order, monotonic tick/rate relation, gap-successor `dropped_before_this_sample`, duplicate suppression, decreasing-index rejection and read-error rules over every record. Historical pre-reset samples are outside this oracle; ignoring a post-stability decrease, dropping a prefix or weakening decoder rules is forbidden.

## Module Disposition

After replacements pass their gates, remove OpenOCD/BMP implementations, Telnet Proxy, TraceAgent, legacy CaptureService and helper, Direct RTT capture backend, external import routing, Runtime Evidence and CodeGraph Bridge. Retain shared GDB/ELF/process/CRC/typed-value code by moving it before deleting its old owner. Retain RTT/GDB/CPU/Flash/Raw tools as risk-classified auxiliaries.

## Risks / Trade-offs

- Experimental DLL contracts may change: identity allowlist plus mandatory revalidation blocks silent drift.
- Existing evidence is not yet semantic proof: hardware acceptance requires an independently known fixture.
- Raw/DB divergence: raw is authoritative and DB carries source hashes.
- Independent UI axes can mislead: units and per-channel scale remain visible.
- Historical formats may be needed for fixtures: any converter is one-time/offline and does not preserve a second runtime model.
