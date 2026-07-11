# Jlink_MCP 精简重构与离线分析能力规划书

## 0. 总目标

将 Jlink_MCP 重构为一个面向 Agent / AI 的通用 MCU Runtime Access MCP，第一阶段聚焦：



```
J-Link HSS 高速采样
→ raw BIN 原始数据
→ capture.db 查询索引
→ 离线 UI 时间轴分析
→ AI 通过 MCP 工具读取和分析采样结果
```



MCP 不内置大语言模型，不负责业务逻辑判断；AI / Agent 负责理解用户意图、选择工具、确认风险；MCP 负责硬件访问、文件生成、数据查询、policy 校验和审计。

------

# 1. 范围定义

## 1.1 本轮必须完成

| 类别           | 内容                                                         |
| -------------- | ------------------------------------------------------------ |
| 项目精简       | 删除非主线模块，降低维护复杂度                               |
| Artifact 识别  | 自动识别 `.elf / .out / .axf / .map`                         |
| 变量解析       | 生成 Variable Catalog                                        |
| Hot Variables  | 支持高频调试变量缓存                                         |
| HSS 采样       | J-Link HSS 作为高速采样主路径                                |
| `.jcap` 文件包 | 输出 `capture.db + raw/*.bin`                                |
| 离线 UI        | 只分析已采样数据，不控制硬件                                 |
| 分析接口       | `capture_summary / capture_series / capture_event_window / analysis_run` |
| AI 接入辅助    | MCP resources / prompts / tool descriptions                  |

## 1.2 本轮不做

| 不做项                              | 说明                     |
| ----------------------------------- | ------------------------ |
| OpenOCD                             | 删除主线                 |
| Black Magic Probe                   | 删除主线                 |
| 旧 `CaptureService`                 | 删除旧 GDB capture 链路  |
| TraceAgent                          | 删除主线                 |
| Telnet Proxy                        | 删除主线                 |
| CodeGraph Bridge / Runtime Evidence | 删除主线                 |
| SVD                                 | 后续阶段实现，本轮不纳入 |
| 多探针调度                          | 本轮不做                 |
| 多组 HSS 并行采样                   | 本轮不做                 |
| UI 实时采样/写入                    | UI 只做离线分析          |

------

# 2. 当前模块处理计划

## Step 1：项目精简

### 目标

删除与当前主线无关的模块，避免后续代码复杂度上升。

### 删除模块



```
src/probe/openocd.ts
src/probe/blackmagic.ts
src/telnet/
src/mcp/rtt-protocols/traceagent*
src/mcp/bridge/
src/mcp/evidence/
src/mcp/capture.ts
src/mcp/capture-backends/direct-rtt-channel*
src/mcp/capture-backends/external-import*
```



### 保留模块



```
src/probe/jlink.ts
src/probe/backend.ts
src/probe/factory.ts   # 需要裁剪为只创建 JLinkBackend
src/rtt/
src/gdb/
src/mcp/hss/
src/mcp/analysis/      # 保留算法思想，重构输入
src/utils/
src/mcp/server.ts
```



### 依据

当前 `factory.ts` 支持 `jlink / openocd / blackmagic`，删除 OpenOCD 和 BlackMagic 后应简化为 J-Link 主路径。
 OpenOCD 当前实现包括 halt/resume/reset/read/write/flash/raw/GDB server 等完整 backend，但不支持 RTT，也不属于 J-Link HSS 主线。
 Black Magic Probe 通过 GDB 串口执行命令，和 J-Link HSS 数据采集链路不一致。

### 验收标准

-  TypeScript 编译通过。 
-  `ProbeFactory` 只默认创建 `JLinkBackend`。 
-  MCP 启动后不再注册 OpenOCD / BlackMagic / Telnet / TraceAgent /旧 capture 工具。 
-  删除后测试套件无引用断裂。 
-  README / tool catalog 不再宣传已删除主线功能。 

------

# 3. Artifact 识别与变量索引

## Step 2：新增 Artifact Probe

### 目标

AI 不再猜 `.out/.elf/.map` 文件名；MCP 自动扫描工程输出文件。

### 新增模块



```
src/mcp/artifacts/
  artifact-probe.ts
  artifact-index.ts
  artifact-pairing.ts
```



### 支持文件

| 文件              | 用途                                |
| ----------------- | ----------------------------------- |
| `.elf`            | 变量解析                            |
| `.out`            | 按内容探测，可能是 ELF              |
| `.axf`            | 预留支持                            |
| `.map`            | 第一版支持 IAR map fallback         |
| `.hex/.bin/.srec` | 只用于 flash/verify，不参与变量解析 |

### 输出示例



```
{
  "artifactId": "art_xxx",
  "path": "build/firmware.out",
  "format": "elf",
  "sha256": "...",
  "pairedMap": "build/firmware.map",
  "supports": ["symbol_resolve", "hss_capture"],
  "confidence": 0.95
}
```



### 验收标准

-  在目标工程 `cwd` 下能扫描出 `.elf/.out/.map`。 
-  `.out` 必须按 ELF magic 判断，不按扩展名硬判断。 
-  同时存在多个 artifact 时返回候选列表和置信度。 
-  不再硬编码 `FOC_SCM.out / FOC_SCM.map`。 
-  artifact 变化后 `sha256` 变化可被检测。 

------

## Step 3：新增 Symbol Search / Resolve

### 目标

通过 ELF/DWARF 或 IAR map 解析变量，生成 Variable Catalog。

### 新增模块



```
src/mcp/symbols/
  symbol-search.ts
  symbol-resolve.ts
  variable-catalog.ts
```



### 变量范围

第一版支持：



```
global scalar
static scalar
struct fixed member
```



第一版不支持：



```
局部变量
指针自动解引用
动态数组
malloc 区对象
多核 / 多镜像
```



### Variable Catalog 字段



```
variableId
artifactId
stableKey
symbolId
name
qualifiedName
rootSymbol
memberPath
address
byteOffset
sizeBytes
dataType
endian
memoryRegion
resolver
readable
writable
riskLevel
unit
scale
offset
groupName
```



### 验收标准

-  `symbol_search` 能按变量名返回候选。 
-  `symbol_resolve` 返回地址、类型、大小、RAM/Flash/Peripheral 区域。 
-  static 同名变量必须能通过 `qualifiedName` 区分。 
-  struct member 必须能返回 `rootSymbol / memberPath / byteOffset`。 
-  写入变量必须确认在 RAM。 
-  artifact 变化后旧 `symbolId` 失效。 

------

# 4. Hot Variables 快速调试机制

## Step 4：新增 Hot Variables

### 目标

调试准备阶段解析变量；调试阶段快速读取、写入、采样，不重复搜索 map/ELF。

### 新增模块



```
src/mcp/hot-variables/
  hot-variable-store.ts
  hot-variable-refresh.ts
  hot-variable-tools.ts
```



### 核心字段



```
hotVariableId
variableId
artifactId
artifactHash
symbolLayoutHash
qualifiedName
address
dataType
sizeBytes
writable
riskLevel
maxWrites
lastValidatedAt
```



### 流程



```
artifact_probe
→ symbol_search
→ symbol_resolve
→ add_hot_variable
→ 后续 variable_read_fast / variable_write_fast / hss_capture_plan 使用
```



### 验收标准

-  能把变量加入 Hot Variables。 
-  artifact 未变化时，fast read/write 不重新解析符号。 
-  artifact 变化后 Hot Variables 标记为 stale。 
-  支持只 refresh stale hot variables。 
-  写入前必须校验 `artifactHash / symbolLayoutHash / policy`。 

------

# 5. HSS 采样主链路

## Step 5：重构 HSS Capture Plan

### 目标

HSS 采样计划从 Hot Variables / Variable Catalog 生成，而不是硬编码变量。

当前 HSS plan 已经有采样率、时长、segmentSize、输出路径等结构，可复用。

### 需要修改

-  `symbols` 来源改为 Variable Catalog / Hot Variables。 
-  删除 HM_C095 默认变量强绑定。 
-  `enforceCapabilityRate()` 必须真实校验 HSS 能力。 
-  plan 生成 `.jcap` 输出目录。 

### 验收标准

-  `hss_capture_plan` 支持从 `hotVariableIds` 生成采样计划。 
-  超过 HSS 支持变量数量或采样率时返回明确错误。 
-  错误中包含建议：降低采样率、减少变量、分多轮。 
-  plan 中固定 `sampleColumn` 映射。 

------

## Step 6：HSS 采样输出 `.jcap`

### 目标

采样阶段只高速写 BIN；停止后生成 `capture.db`。

### 最终目录



```
<projectRoot>/.jlink-mcp/captures/
  <captureId>.jcap/
    capture.db
    raw/
      capture_0001.bin
      capture_0002.bin
    export/
      capture.csv   # 按需生成
```



### 不再默认输出



```
capture.json
capture.events.jsonl
capture.flags.jsonl
```



### BIN SampleRecord

当前代码已有 `sampleIndex / timestampTicks / statusFlags / rawValues` 的记录结构，可作为基础。

建议结构：



```
FileHeader
SampleRecord[]
```



SampleRecord：



```
uint64 sampleIndex
int64  timestampTicks
uint32 statusFlags
uint32 reserved
uint32 values[variableCount]
```



### 验收标准

-  HSS 采样过程中只写 `raw/capture_0001.bin`。 
-  停止采样后自动生成 `capture.db`。 
-  CSV 不默认生成。 
-  `capture.db` 可从 `raw/*.bin` 重建。 
-  `raw/*.bin` CRC 写入 DB segments 表。 

------

# 6. capture.db 数据结构

## Step 7：新增 jcap DB Schema

### 目标

DB 作为 UI / AI 查询索引，BIN 作为原始证据。

### 新增模块



```
src/mcp/jcap/
  jcap-package.ts
  jcap-db.ts
  jcap-schema.ts
  jcap-indexer.ts
  jcap-rebuild.ts
```



### 最小表

| 表          | 用途                                                |
| ----------- | --------------------------------------------------- |
| `capture`   | captureId、状态、backend、采样率、起止时间          |
| `variables` | 变量名、类型、地址、单位、sampleColumn              |
| `segments`  | BIN 文件、sampleStart、sampleCount、crc、recordSize |
| `events`    | 写入事件、异常事件、sampleIndex、timeUs             |
| `flags`     | write_nearby、backend_busy、timeout 等区间          |
| `buckets`   | min/max/avg/last/count，用于 UI 曲线                |
| `quality`   | read_error、timeout、overflow、dropped 统计         |

### 验收标准

-  `capture.db` 创建成功。 
-  UI 可只通过 DB 获取变量列表、事件列表、bucket 曲线。 
-  DB 删除后可通过 `capture_index_rebuild` 从 BIN 重建。 
-  schema 有 version 字段。 
-  旧 schema 打开时返回明确版本错误或自动迁移。 

------

# 7. 变量写入与事件记录

## Step 8：保留并迁移 Variable Write

### 目标

继续支持 HSS 运行中的受控 RAM 变量写入，但事件写入 DB，不再写 JSONL。

当前已有 `variable_write_plan / variable_write_execute`，包含 policyHash、symbolLayoutHash、expiresAt 等字段，可复用。
 当前事件结构已记录 old/new/readback/risk/sampleIndex 等，可迁移到 DB events 表。
 当前 flags 已支持 `write_in_progress / write_nearby / backend_busy`，可迁移到 DB flags 表。

### 验收标准

-  HSS 运行中 R2 RAM 变量写入可执行。 
-  写入必须通过 capture session 队列。 
-  写入后 readback。 
-  写入事件进入 `capture.db.events`。 
-  写入附近 flags 进入 `capture.db.flags`。 
-  写入失败也必须记录 audit。 
-  普通写入不能绕过 active capture 抢占 J-Link。 

------

# 8. 分析工具重构

## Step 9：新增 Capture Analysis Tools

### 目标

AI 和 UI 通过统一接口读取采样结果。

### 新工具



```
capture_summary
capture_series
capture_event_window
analysis_run
capture_export
capture_index_rebuild
```



### 工具说明

| 工具                    | 作用                               |
| ----------------------- | ---------------------------------- |
| `capture_summary`       | 返回采样包整体信息                 |
| `capture_series`        | 返回变量在时间窗口内的 bucket 曲线 |
| `capture_event_window`  | 返回事件前后窗口                   |
| `analysis_run`          | 执行确定性分析                     |
| `capture_export`        | 按需生成 CSV                       |
| `capture_index_rebuild` | 从 BIN 重建 DB                     |

### Analysis 重构

当前 analysis 已有 generic control / state machine 算法：step response、overshoot、settling_time、steady_error、state/fault/counter 等。
 但当前输入依赖 experiment record，需要改为从 `capture.db` 构造 AnalysisRecord。

### 验收标准

-  `capture_summary` 不读 raw BIN，只查 DB。 
-  `capture_series` 支持变量列表、时间范围、bucketCount。 
-  `capture_event_window` 支持写入事件前后窗口。 
-  `analysis_run` 能输出突变、延迟、超限、稳定时间等结果。 
-  `capture_export` 只在调用时生成 CSV。 
-  UI 和 AI 能使用同一组分析接口。 

------

# 9. 离线 UI

## Step 10：实现离线数据分析 UI

### 目标

UI 只用于已采样数据分析，不执行硬件连接、采样、写变量。

### UI 不做



```
连接探针
开始采样
停止采样
变量写入
Flash
Reset
Raw command
```



### UI 做



```
打开 .jcap
显示变量曲线
显示事件时间轴
显示质量标记
变量颜色选择
单变量独立 Y 轴缩放
纵轴 offset
示波器式 Auto Fit / Reset
时间窗口 brush 缩放
CSV 导出
```



### 启动方式

开发阶段：



```
node /path/to/jlink-mcp/out/ui/main.js --project <target-project>
```



或后续封装：



```
jlink-mcp ui --project <target-project>
jlink-mcp ui --open <captureId>.jcap
```



### 验收标准

-  UI 能打开 `.jcap`。 
-  UI 不显示硬件连接、采样、写入按钮。 
-  多变量曲线可显示。 
-  每个变量可选择颜色。 
-  每个变量支持独立 Y 轴 scale / offset / auto-fit / reset。 
-  事件点能显示在时间轴上。 
-  底部事件表能显示写入事件、异常事件、质量 flags。 
-  UI 不直接解析 `raw.bin`；默认通过 MCP/本地查询接口读取 DB。 

------

# 10. AI 接入辅助

## Step 11：新增 MCP Resources / Prompts

### 目标

让 AI 接入 MCP 后能自动理解主流程，而不是靠用户提醒。

### 新增 resources



```
mcp://jlink/server-card
mcp://jlink/workflows/capture-analysis
mcp://jlink/data-format/jcap
mcp://jlink/risk-policy
mcp://jlink/tool-catalog
```



### 新增 prompts



```
jlink-capture-analysis
jlink-hot-variable-debug
jlink-event-window-analysis
```



### 内容要求

必须告诉 AI：



```
不要直接读 raw.bin
不要猜变量名
先 artifact_probe
再 symbol_search / symbol_resolve
再 hot variable
再 hss_capture_plan/start/stop
最后 capture_summary / capture_series / analysis_run
```



### 验收标准

-  MCP client 能看到 resources。 
-  AI 能通过 prompt 获取推荐流程。 
-  tool description 明确每个工具适用场景。 
-  旧 prompt 中 Git-tracked `.jlink-mcp.json` 流程被删除。 
-  README 同步更新为新主线。 

当前 server 已有 prompt/resource 机制，可直接扩展。

------

# 11. 风险、Policy 与审计

## Step 12：统一风险与审计

### 目标

不隐藏 RTT/GDB/CPU/Flash/Raw，但必须明确风险等级、policy 和审计。

### 风险规则

| 等级  | 策略                   |
| ----- | ---------------------- |
| R0/R1 | AI 可自动执行          |
| R2    | policy 允许 + readback |
| R3    | operationPlan + audit  |
| R4    | 人工确认               |
| R5    | MCP 硬拒绝             |

### 保留但非主线工具



```
RTT
GDB
halt/resume/reset/step
flash/erase
probe_command/raw
```



### 验收标准

-  所有风险操作返回 risk metadata。 
-  所有写入、flash、reset、raw command 写 audit。 
-  Raw command 默认需要 R4 确认。 
-  UI 不暴露这些硬件控制操作。 
-  AI tool catalog 中把它们标记为辅助/高风险工具。 

------

# 12. 测试计划

## Step 13：单元测试

### 目标

保证重构后核心能力稳定。

### 必须覆盖

| 测试           | 验收                          |
| -------------- | ----------------------------- |
| artifact probe | 能识别 `.out/.elf/.map`       |
| symbol resolve | 能解析 scalar / struct member |
| hot variables  | artifact 变化后 stale         |
| HSS plan       | 超能力限制时报错              |
| BIN 写入       | sample record 格式正确        |
| DB index       | 能从 BIN 生成 DB              |
| capture_series | bucket 正确                   |
| event_window   | 事件前后窗口正确              |
| variable write | policy/readback/audit 正确    |
| UI query       | 能打开 sample DB              |

------

## Step 14：集成验收

### 目标

验证完整闭环。

### 场景



```
1. 启动 MCP
2. artifact_probe
3. symbol_search / symbol_resolve
4. add_hot_variable
5. hss_capture_plan
6. hss_capture_start
7. variable_write_plan
8. variable_write_execute
9. hss_capture_stop
10. 生成 .jcap
11. capture_summary
12. capture_series
13. capture_event_window
14. UI 打开 .jcap
15. 导出 CSV
```



### 验收标准

-  不依赖 Git。 
-  不生成默认 JSON/JSONL。 
-  `.jcap` 中只有 `capture.db + raw/*.bin + optional export/*.csv`。 
-  AI 能通过 MCP 工具完成分析。 
-  UI 能显示曲线、事件、质量标记。 
-  重新编译 artifact 后 Hot Variables 自动失效并可刷新。 

------

# 13. 推荐执行顺序



```
Phase 1：项目精简
  删除 OpenOCD / BMP / Telnet / TraceAgent / Bridge / Evidence / 旧 CaptureService

Phase 2：Artifact + Symbol
  实现 artifact_probe / symbol_search / symbol_resolve / Variable Catalog

Phase 3：Hot Variables
  实现 add/list/refresh hot variables 与 fast path

Phase 4：HSS + jcap
  改造 HSS 输出 raw BIN，stop 后生成 capture.db

Phase 5：Analysis Tools
  实现 capture_summary / capture_series / capture_event_window / analysis_run

Phase 6：UI
  实现离线分析 UI，支持颜色、事件、独立 Y 轴缩放

Phase 7：AI 接入辅助
  server-card / workflow prompts / README 更新

Phase 8：测试和验收
  单元测试 + 集成闭环测试
```



------

# 14. 最终验收定义

本轮完成后，项目应达到：



```
Jlink_MCP 可以在目标工程 cwd 下识别编译产物，
解析变量并建立 Hot Variables，
通过 J-Link HSS 采样生成 .jcap 文件包，
停止后自动生成 capture.db，
AI 和 UI 可以基于 capture.db 分析变量趋势、事件窗口和采样质量，
CSV 仅按需导出，
项目主线不再包含 OpenOCD / BlackMagic / TraceAgent / Telnet / 旧 CaptureService 等非核心复杂模块。
```



一句话验收标准：

> **不依赖 Git、不猜文件名、不默认生成 JSON、UI 不控制硬件；AI 和 UI 都通过 .jcap(capture.db + raw.bin) 完成离线采样分析**