## Context

仓库已有 HSS 只读采样和 capture-time RAM write MVP，但当前数据分散在 BIN、JSON、JSONL、CSV，且存在两套 HSS 可用性判断和多条 capture fallback。目标工程验证基线是 `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config`；其现有硬件证据只证明 transport/data-quality，尚未证明 semantic correctness。

## Goals / Non-Goals

**Goals**

- 把实验性 J-Link DLL API adapter 定义为项目支持的正式、唯一 HSS 主路径。
- 建立内容驱动的 Artifact/Symbol/Hot Variable 合同。
- 采样线程只追加版本化 raw BIN；停止后构建可恢复的 SQLite 查询库。
- 为 Agent 和 UI 提供相同的有界查询与确定性分析合同。
- 保持变量写入的 policy、approval、readback 和 audit 边界。
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
- Each capture records the resolved DLL path, DLL version and SHA-256, adapter version/hash, helper version/hash, architecture, resolution source, and validated capabilities.
- Unknown or changed DLL/helper/adapter identity blocks capture until the validation suite is rerun and the allowlist is updated.
- The minimum validation gate is export discovery, `GetCaps`, Start/Read/Stop lifecycle, record decoding and a semantic fixture whose expected values are independently known.

### 2. Artifact identity and target match are explicit

`projectRoot` is the supplied directory or MCP cwd; Git is not used to infer it. Artifact candidates are content-probed while excluding `.git`, `node_modules`, `.jlink-mcp` and configured cache directories. `.elf/.out/.axf` may provide symbols; `.hex/.bin/.srec` are flash artifacts only.

Target identity is resolved only from explicit input, then supported project configuration files. If the result is absent or ambiguous, Jlink_MCP returns a structured selection error. It never guesses from directory name, project name, test history, or a default MCU. The result records `targetId`, configuration source, and confidence.

Each artifact generation binds canonical path, format, SHA-256, optional MAP SHA-256 and `symbolLayoutHash`. `targetArtifactMatch` is `verified | unverified | mismatch`:

- read-only capture may proceed when `unverified`, with a persistent warning in plan and JCAP;
- writes are denied by default when `unverified`; only an explicit R4 policy exception may permit one;
- `mismatch` is a hard rejection for capture and write.

### 3. Variable identity is separate from layout

The stable key is `qualifiedName + memberPath`. Runtime layout includes artifact generation, address, type, size, region, resolver and confidence. Hot Variables cache only validated layouts for a process-local debug session. Artifact/MAP/policy/session changes make entries stale; stale entries cannot be read, written or sampled until selectively refreshed.

JCAP v1 sampling supports scalar 1/2/4-byte integer/enum/boolean values and IEEE-754 float32. The `uint32` value slot preserves raw bits. Unsupported widths, float64, dynamic arrays, bitfields and pointer dereference are rejected. Fixed-array element/slice targets remain valid for controlled writes but are expanded to supported scalar sample columns for HSS.

### 4. Raw capture is authoritative and rebuildable

Every sample segment contains a versioned header, binary variable descriptor block and fixed records. Minimum provenance includes capture ID, segment index, timebase, artifact/MAP/layout hashes, DLL/helper/adapter identities, target match, descriptor CRC and record CRC.

The canonical time axis is monotonic ticks from capture start. Header fields define `timebaseHz` and origin; wall-clock time is optional display metadata. Events use the same tick domain.

```text
sample record:
  uint64 sampleIndex
  int64  timestampTicks
  uint32 statusFlags
  uint32 reserved
  uint32 rawValues[variableCount]
```

`raw/events.bin` is an append-safe, versioned journal for lifecycle, variable-write, flag and fault events. It stores event ID, tick, type, payload version, payload length/CRC and optional audit reference. Therefore deleting `capture.db` does not erase capture-local events. Project-level security audit remains a separate append-safe log and is referenced by digest rather than copied as mutable truth.

### 5. Capture lifecycle is explicit

Allowed states are `planned → active → finalizing → completed`, with terminal/repair states `stopped`, `recoverable` and `failed`.

- `active`: status and bounded live-tail metadata only; completed-series/analysis return `not_ready`.
- `finalizing`: raw is closed; queries return progress and `not_ready` for unavailable indexes.
- `completed` or clean `stopped`: full query/export/analysis allowed.
- `recoverable`: raw validation/rebuild allowed; corrupt ranges are reported, never hidden.
- `failed`: summary and diagnostics allowed; series only for validated complete ranges.

Finalization builds `capture.db.tmp`, checks integrity and atomically renames it. It never deletes raw evidence on failure.

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

Normal variable writes are R3 and require an operation plan, policy allowlist, Artifact/layout/policy/session/TTL binding, write budget, readback, capture-owner serialization, and append-safe audit. R4 is reserved for policy exceptions on unverified targets, Flash/Erase, Raw commands, and equivalent high-risk actions. R4 approval is issued by a trusted user-confirmation boundary and binds tool name, canonical arguments, target identity, artifact/layout/policy hashes, operation digest, TTL and single-use nonce. An untrusted Agent cannot self-assert approval. R5 is always rejected.

`halt`, `resume`, and `reset` remain formal R3 auxiliary tools with their existing names, input schemas, and output envelope. They execute only through the J-Link main backend and do not depend on a removed backend or capture router. Each call requires an operation plan, target-state preflight, append-safe audit, and a structured outcome within the existing response contract. During an active HSS capture, `halt` and `reset` return a structured conflict by default and perform no control action. A future exception may proceed only after explicitly stopping or marking the capture and appending both a capture event and audit record; no silent capture disruption is allowed.

### 10. The UI is a local loopback Web application

The first UI SHALL run as a local loopback Web application and SHALL NOT use a VS Code webview or require VS Code integration. It uses the bounded query service, never parses raw BIN, and exposes no probe, capture-control, write, flash, reset, or raw-command operation.

### 11. Replacement precedes deletion

Order: baseline and adapter proof → SQLite decision → JCAP minimal slice → Artifact/Symbol/HSS migration → writes/events → analysis/UI/discovery → per-batch deletion → end-to-end acceptance. Each deletion batch requires compile, targeted tests and accepted HSS regression evidence.

## Module Disposition

After replacements pass their gates, remove OpenOCD/BMP implementations, Telnet Proxy, TraceAgent, legacy CaptureService and helper, Direct RTT capture backend, external import routing, Runtime Evidence and CodeGraph Bridge. Retain shared GDB/ELF/process/CRC/typed-value code by moving it before deleting its old owner. Retain RTT/GDB/CPU/Flash/Raw tools as risk-classified auxiliaries.

## Risks / Trade-offs

- Experimental DLL contracts may change: identity allowlist plus mandatory revalidation blocks silent drift.
- Existing evidence is not yet semantic proof: hardware acceptance requires an independently known fixture.
- Raw/DB divergence: raw is authoritative and DB carries source hashes.
- Independent UI axes can mislead: units and per-channel scale remain visible.
- Historical formats may be needed for fixtures: any converter is one-time/offline and does not preserve a second runtime model.
