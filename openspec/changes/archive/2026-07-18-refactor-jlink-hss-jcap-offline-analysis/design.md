## Context

仓库已有 HSS 只读采样和 capture-time RAM write MVP，但当前数据分散在 BIN、JSON、JSONL、CSV，且存在两套 HSS 可用性判断和多条 capture fallback。目标工程验证基线是 `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config`；其现有硬件证据只证明 transport/data-quality，尚未证明 semantic correctness。

## Optimization decisions

本节覆盖本变更中与其冲突的旧细节，未提及的安全约束和需求保持不变。

- 系统仅以 `RuntimeContext`（DLL/helper/adapter/script-mode/cache-script 身份）、`TargetContext`（target/probe/artifact/symbol layout）、`OperationPlan`（policy/readback/maxWrites/R4）和 `CapturePackage` 组织主线。Runtime Bundle 是 RuntimeContext 内的单一身份集合。
- 删除 acceptance-mode、candidate manifest 和单独 promotion 状态机。可信本地 CLI `jlink-mcp trust validate` 校验 Runtime Bundle 与 ScriptFile、执行有界 HSS 验证、显示结果并在本地确认或直接用户授权后将 Trust Profile 保存到工作区外的用户本地信任存储；它不是 MCP Tool，Agent 无直接用户授权时不能提升信任。
- ScriptFile 只有 `script.mode=none|file`：`none` 显式禁止默认脚本；`file` 校验规范化路径和 SHA-256，将内容复制至用户本地信任存储内以 SHA-256 命名的缓存副本后供 J-Link 加载。信任存储按规范化工程根真实路径 SHA-256 隔离且不得位于工程内；存储根须解析最近存在祖先的 OS 真实路径并校验待创建后缀，拒绝扩展长度路径、junction/reparse point、SUBST 或 8.3 短路径映射回工程的别名。此内容寻址副本是唯一 TOCTOU 防护方案，不再要求 no-op ScriptFile 或叠加文件锁/重复校验。
- HSS 将 canonical target `projectRoot` 与显式外部 `storageRoot`、`evidenceRoot` 分离；OUT/MAP 与 Trust Profile 仍绑定真实目标工程根，capture、export、helper 临时文件、audit 和会话证据只能写入工程外根。调用前后必须以目标工程相对路径清单和逐文件 SHA-256 证明工程未变化。
- Artifact 比对按风险触发：只读可使用 `unverified` 并持续告警；R2 写入和正式语义验收必须完整验证；`mismatch` 拒绝 capture 和变量写入。验证缓存限于当前 connection generation，并在 reconnect、Artifact/Target/Probe 变化、Flash/Erase 或可能改 Flash 的 Raw 操作后失效。
- JCAP 首版为 `formatVersion=0`、`status=experimental`，先验证 Raw→DB→Query→Analysis→UI；不冻结完整字节布局，v1 冻结另立变更。SQLite adapter 移至 P1 数据路径验证。
- 首版 UI 仅支持打开 JCAP、项目/会话/capture 导航、变量、多变量曲线、zoom/brush、events、quality、基本 Y auto-fit 和有界查询；高级样式、复杂多轴、单位编辑、任意 scale/offset 持久化和完整 preferences 延后。分析仅提供写入前后窗口、峰值/稳态/超调、状态迁移和持续时间。
- replacement-first 分为 Batch A（旧 Capture 主线）和 Batch B（历史/非主线模块）；每批统一执行 compile、affected tests、tool catalog、import/reference scan 和 HSS regression。

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
  → <storageRoot>/captures/<captureId>.jcap/raw/{samples.bin,events.bin}
  → finalizer → capture.db
  → bounded query/analysis → local loopback Web offline UI
```

```text
<captureId>.jcap/
    capture.db
  raw/
    samples.bin
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
- Every formal GetCaps, target-state and capture passes an explicit `script.mode`. `none` passes no script path/hash and disables installed defaults; `file` canonicalizes and hashes the source once, writes a SHA-256-named cache copy under the external user-local trust store, verifies that copy and passes only its path/hash to the helper.
- The helper requires `--jlink-script-mode none|file`; only `file` invokes the fixed `ScriptFile = <cache-path>` selector and requires return code `0`. No generic ExecCommand input is exposed.
- Each capture records the resolved DLL path, DLL version and SHA-256, adapter version/hash, helper version/hash, effective script path/SHA-256/approval digest/GetCaps and capture selection results, architecture, resolution source, and validated capabilities.
- Production mode resolves the same external store by normalized project-root real-path SHA-256. Before profile/cache creation or access it resolves the store's nearest existing ancestor through the OS, validates the uncreated suffix, and rejects any extended-length, junction/reparse-point, SUBST, or 8.3 alias whose real destination is the project root or a descendant. It reloads the persistent Trust Profile and accepts only its exact project/DLL/helper/adapter/script-mode/target/probe/suite tuple; any changed namespace, identity or cached script content fails closed. Project `.jlink-mcp` data is never a trust source.
- `jlink-mcp trust validate` is a user-explicit local CLI outside the MCP catalog. It validates the exact tuple with the bounded HSS suite, displays the result and atomically saves the Trust Profile to that external project namespace after either local confirmation or an explicit `--user-authorized true` supplied under direct user instruction. MCP Tool and offline UI cannot create or promote trust.
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

Experimental JCAP v0 records stable variable identity, capture-relative ticks, quality flags and numeric values in a self-describing payload. Physical scalar codes, byte offsets and binary value-slot layout are deliberately deferred to a separate v1 freeze. Unsupported HSS source types remain rejected by the HSS plan before they reach JCAP.

### 4. Raw capture is authoritative and rebuildable

JCAP v0 freezes only the package roles (`capture.db`, `raw/samples.bin`, `raw/events.bin`, optional on-demand `export/`) and a self-describing experimental envelope carrying `formatVersion=0`, status, record kind, payload encoding, payload length and payload SHA-256. Each frame is the UTF-8 header JSON line, the exact declared UTF-8 payload bytes, then LF; readers verify those bytes directly and native HSS produces the same framing. Fixed offsets, header/footer sizes, CRC/TLV algorithms, scalar codes and SQLite schema remain outside the future v1 compatibility promise.

Sample payloads carry increasing sample index, nondecreasing capture-relative nanosecond tick, status flags and named numeric values. Event payloads carry provenance, lifecycle, reset/write/fault facts and the same tick domain. Readers accept only the contiguous length/hash-valid prefix; a partial tail or invalid envelope stops parsing and produces an explicit corrupt-suffix diagnostic without resynchronization.

For `resetBeforeCapture`, the QPC epoch and `planned` journal are created before reset. The reset event occurs while planned; `active` is appended only after reset succeeds, stabilization succeeds and HSS Start succeeds. The first sample remains `sampleIndex=0` but may have a positive tick. Pre-reset values are not sample records, and no post-stability sample prefix may be discarded.

Raw files are immutable authority after append/close. `capture.db` is derived, schema-versioned, and source-hash bound. Rebuild reads only validated raw prefixes, records corrupt ranges explicitly, never modifies raw, and restores capture identity, descriptors, timing, quality, segment ranges, and capture-local events.

JCAP v0 uses one shared golden corpus for round-trip, native exact-payload compatibility, script/reset provenance, pre-start failure, terminal lifecycle, truncated tail, corrupt suffix and rebuild equivalence. A later v1 change may freeze byte-golden vectors only after the v0 data path is accepted.

### 5. Capture lifecycle is explicit

Capture lifecycle and index publication are separate state machines. `captureState` is `planned | active | finalizing | completed | stopped | recoverable | failed`; `planned → failed` is allowed when script selection, reset, stabilization or HSS Start fails before sampling, so such a package may have a valid event journal and no sample segment. `indexStatus` is `absent | building | ready | rebuild_required | failed` and is derived from the active finalizer plus `capture.db` existence, integrity and source hashes; it is not appended as a post-terminal raw event.

- `active`: status and bounded live-tail metadata only; completed-series/analysis return `not_ready`.
- `finalizing`: sample segments are closed while the event journal remains open only long enough to append the terminal lifecycle event; queries return progress and `not_ready`.
- `completed` or clean `stopped`: raw capture is terminal, but full query/export/analysis requires `indexStatus=ready`; otherwise callers receive `not_ready` plus rebuild status.
- `recoverable`: raw validation/rebuild allowed; corrupt ranges are reported, never hidden.
- `failed`: summary and diagnostics allowed; series only for validated complete ranges.

Finalization closes and syncs all sample segments, appends and syncs `finalizing`, validates the complete raw prefix, appends and syncs the appropriate terminal `completed`, `stopped` or `failed` event only when that pre-terminal validation permits it, then closes the event journal. Pre-terminal corruption transitions to `recoverable` instead. No raw byte changes after a terminal event. Only then does it set `indexStatus=building`, build `capture.db.tmp` from the final raw set, validate DB integrity and every source hash, sync it and atomically rename it to `capture.db`; a valid published DB yields `ready`. A build failure leaves terminal raw intact and returns `indexStatus=failed`; after restart, closed terminal raw without a valid matching DB is `rebuild_required`. Corruption discovered after terminal closure cannot rewrite `captureState`; it is reported through index/corruption diagnostics. Finalization never deletes or edits raw evidence, and an initial DB and a later rebuild from the same raw must be equivalent.

### 6. SQLite is behind a runtime adapter gate

The selected adapter is `sqlite3@5.1.7`, loaded as an external CommonJS native dependency by both extension and standalone Node 18 builds. The packaged installation includes its Windows x64 `node_sqlite3.node` binding plus `bindings` and `file-uri-to-path`; the same adapter module is used by standalone MCP and the local loopback query service. The gate requires schema creation, transactions, integrity check, raw-source verification, rebuild, fsync/close and atomic publication tests.

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

Normal RAM variable writes on a `verified` target are R2. They use `variable_write_plan`, not an R3 operation plan, and require policy allowlist, valid RAM range/value/layout, Artifact/layout/policy/session/TTL binding, `maxWrites`, old-value read, write, readback, capture-owner serialization, capture event and append-safe audit. During active HSS capture, claim, old-value read, write, readback, QPC event append/sync and the same-`auditId` outcome audit append/fsync remain in one capture queue segment; the next accepted write cannot enter until that outcome audit is durable. The Agent may decide to invoke the R2 operation from structured risk facts without user confirmation. An `unverified` target is denied by default and can proceed only through an explicit R4 policy exception; `mismatch` and R5 are always rejected.

R4 is also used for Flash/Erase, raw GDB, raw probe and equivalent high-risk actions. Each action has a read-only `*_plan` step that returns a canonical `challengeId`, `operationDigest`, single-use `nonce`, `expiresAt` and human-readable operation summary. The local MCP host creates an ephemeral signing/MAC secret at process start and exposes it only to a private local host/CLI approval broker—not to the Agent, MCP offline-analysis UI, or any MCP-callable self-approval tool. That broker displays the exact challenge and, after direct user confirmation, issues an opaque server-authenticated approval token bound to tool name, canonical arguments, target identity, Artifact/layout/policy hashes, session/connection generation, digest, expiry and nonce. `*_execute` supplies that token with the canonical operation, revalidates every binding, atomically consumes the nonce before hardware access, and audits success, failure or indeterminate outcome. Tokens do not survive a server restart; missing, expired, mismatched, forged or replayed approval returns `approval_required`/structured rejection without hardware action.

The unverified-target variable exception crosses Node→Native only as `schema=jlink-mcp-r4-native-exception`, `version=1`, `kind=unverified_variable_write`. Its fixed fields bind the consumed approval evidence (`challengeId`, approval operation digest, nonce SHA-256, consumed/expiry times), write-plan ID/digest/lifetime/canonical arguments, exact write address/access size/bytes/readback, target/probe/runtime/Artifact/evidence/layout/policy/session/capture and reserved physical connection generation. The summary is SHA-256 over UTF-8 `utf8-sorted-json-v1`: recursively sort object keys by ordinal name, omit `undefined`, retain array order, and encode only finite JSON values; `summarySha256` itself is excluded. The persisted external session plan contains no approval token, authority secret, signature or raw nonce. Node invokes the existing helper binary with the distinct `variable-write-r4` command, `--plan`, and `--r4-exception-summary-sha256`; the legacy `variable-write` command remains the verified R2 path. Until Native implements this discriminator and per-field/digest validation, `variable-write-r4` must return structured unsupported before DLL load/connect/write and no fallback is allowed.

`halt`, `resume`, and `reset` remain formal R3 auxiliary tools with their existing names, input schemas, required text semantics and structured outcome meanings. Each single call executes only through the J-Link main backend and internally performs deterministic plan creation → target-state/identity preflight → binding revalidation → execution → single-use consumption → append-safe audit. The MCP response preserves the compatibility text while returning the service envelope, including risk, plan/digest, audit reference and structured refusal facts; it may not rename or remove existing fields. During an active HSS capture, `halt` and `reset` return a structured conflict by default and perform no control action. A future exception may proceed only after explicitly stopping or marking the capture and appending both a capture event and audit record; no silent capture disruption is allowed.

`resetBeforeCapture=true` composes that same reset executor as a single-use R3 sub-operation; it is not a reset bypass. The resolved HSS plan binds canonical reset arguments, target identity, Artifact/layout/policy hashes, session, expiry/TTL, operation digest and capture ID. The binding is revalidated immediately before reset, the before/after target states and result are audited, and the reset event references that audit. The composite capture operation advertises R3 risk whenever reset is enabled.

### 10. The UI is a local loopback Web application

The first UI SHALL run as a local loopback Web application and SHALL NOT use a VS Code webview or require VS Code integration. It uses the bounded query service, never parses raw BIN, and exposes no probe, capture-control, write, flash, reset, or raw-command operation.

### 11. Replacement precedes deletion

Order: baseline and adapter proof → SQLite decision → JCAP minimal slice → Artifact/Symbol/HSS migration → writes/events → analysis/UI/discovery → per-batch deletion → end-to-end acceptance. Each deletion batch requires compile, targeted tests and accepted HSS regression evidence.

### 12. Hardware acceptance starts a new capture after explicit reset and stabilization

The supported Gate 0 sequence is fixed: resolve target, OUT/MAP and runtime identities → validate the trusted script mode/cache identity → GetCaps through the J-Link main backend → inspect target state → execute the bound R3 reset with `resetBeforeCapture=true` → wait for bounded stabilization → HSS Start/Read/Stop → persist reset/capture events and the complete audit.

The resolved plan SHALL contain the dynamically resolved counter address, `uint32` modulus semantics, expected counter rate and tolerance, plus `minimumRecoveryMs` (`0..60000`), `timeoutMs` (`1..60000`), `pollIntervalMs` (`10..1000`) and `requiredConsecutiveRunningChecks` (`2..100`). After the capture helper's own `JLINKARM_Connect` and before `JLINK_HSS_Start`, that same DLL connection SHALL use a single-element `JLINKARM_ReadMemU32` read with per-element status and require the target to remain running with the configured consecutive modular-forward, in-rate windows. A non-wrapping decrease before `minimumRecoveryMs` and before any running window is initialization restart evidence: it resets the counter baseline and consecutive count but remains inside the original timeout. The same decrease after recovery or after a running window begins, timeout, failed/status-invalid read, target halt or identity drift fails closed with no HSS Start. Success and failure report check count, elapsed time, first/last counter values and observed-rate evidence.

HM_C095 uses a plan-bound 1000ms default recovery window, calibrated above the observed approximately 305ms connect-time initialization restart; callers may override it within the validated bounds without extending the fixed timeout.

The HM_C095 hardware oracle is `g_hssDbgCounterFocIsr`, resolved dynamically from the selected OUT/MAP rather than a fixed address or product default. The firmware increments this `uint32` once per ADC1 DMA completion through `Dma_Drv_Ch1IrqHandler → CddAdc_DmaDoneCallback → AppMotorCtrlPwmIsr → AppCurrentSenseHssFastUpdate`. The selected build configures FOSC=40MHz, MCPWM1 PARCC=/2, PWM divider=/1, center-aligned period=625, TDG1 PARCC=/2, TDG prescaler=/2 and delay offset=1238. Thus `fPWM=40MHz/(2×1×2×625)=16kHz`, while the TDG delay spans `ceil((1238+1)/(40MHz/2/2)×16kHz)=2` PWM triggers, so the counter oracle rate is `fCounter=16kHz/2=8kHz`; 16kHz is only the upstream PWM rate. The plan records these values, formula and source hashes and retains the bounded rate tolerance. After explicit reset and bounded stabilization, the oracle starts at sample index 0 and covers every new-capture record. For adjacent samples, `delta=(current-previous) mod 2^32` must be within those recorded bounds; at least one positive delta must occur within the configured observation window. A wrap is accepted only when the modular delta satisfies the same bound, never merely because the value decreased. Repeated values within the declared rate tolerance are allowed, but an unexplained non-wrap decrease, zero progress for the full window, or an out-of-bound delta fails. Other fixture variables are diagnostic and cannot override this primary result.

The same oracle validates strict sample-index order, monotonic tick/rate relation, gap-successor `dropped_before_this_sample`, duplicate suppression, decreasing-index rejection and read-error rules over every record. Historical pre-reset samples are outside this oracle; ignoring a post-stability decrease, dropping a prefix or weakening decoder rules is forbidden.

## Module Disposition

After replacements pass their gates, remove OpenOCD/BMP implementations, Telnet Proxy, TraceAgent, legacy CaptureService and helper, Direct RTT capture backend, external import routing, Runtime Evidence and CodeGraph Bridge. Retain shared GDB/ELF/process/CRC/typed-value code by moving it before deleting its old owner. Retain read-only RTT logging/decoding plus GDB/CPU/Flash/Raw tools as risk-classified auxiliaries; the public MCP surface does not expose RTT send, down-ring write, or TraceAgent signal-write aliases.

## Risks / Trade-offs

- Experimental DLL contracts may change: identity allowlist plus mandatory revalidation blocks silent drift.
- Existing evidence is not yet semantic proof: hardware acceptance requires an independently known fixture.
- Raw/DB divergence: raw is authoritative and DB carries source hashes.
- Independent UI axes can mislead: units and per-channel scale remain visible.
- Historical formats may be needed for fixtures: any converter is one-time/offline and does not preserve a second runtime model.
