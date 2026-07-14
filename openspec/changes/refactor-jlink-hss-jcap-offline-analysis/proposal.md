## Why

当前仓库存在多套采样、存储、分析和探针路径，工具合同与生命周期不一致。目标产品链路已经明确为 J-Link HSS 采样、`.jcap` 离线存储、统一查询/分析和只读 UI；MCP 只提供确定性工具与安全约束，语义推理由外部 Agent 完成。

项目没有 SEGGER 官方 SDK。本变更明确把现有实验性 J-Link DLL API adapter 提升为**项目支持的正式 HSS 主路径**：以实际 DLL 导出、能力探测和项目验证矩阵为准，不宣称 SEGGER 官方 SDK 兼容或支持。

## What Changes

- 主线收敛为 `Artifact → Symbol/Hot Variables → J-Link DLL HSS → .jcap → Query/Analysis → Offline UI`。
- HSS 只保留一套能力视图和执行入口；不再自动回退到 Direct RTT、RSP 或 External Import。
- 首版仅支持 Windows x64 + `JLink_x64.dll`。DLL 按“显式 `--jlink-dll`/`JLINK_DLL_PATH` → SEGGER 安装注册表 → PATH 中 `JLink.exe` 同目录 → 常见安装目录”解析；未知或未验证身份禁止采样。
- HSS 连接只使用专用 `ScriptFile` 选择器；脚本必须是绝对路径且 SHA-256 来自可信批准源。GetCaps、reset 和 capture 均禁止回退到未批准的 SEGGER 默认脚本，也不新增通用 Raw/ExecCommand 表面。
- 身份门禁使用一个可信本地命令 `jlink-mcp trust validate`：校验 DLL/helper/adapter/ScriptFile、执行有界 HSS 验证、展示 Runtime Bundle，经用户一次确认后保存 Trust Profile。它不作为 MCP Tool 暴露，Agent 不能自行提升信任。
- capture 记录实际 DLL 路径、版本、SHA-256，adapter/helper 版本与哈希，以及脚本路径、SHA-256、批准摘要和选择结果。
- 真实硬件验收使用显式 `resetBeforeCapture=true`：GetCaps 和目标状态检查后执行一次绑定 target/Artifact/layout/policy/session/TTL 的 R3 reset，目标满足有界稳定条件后才启动新的 HSS capture。
- 目标 MCU 由“显式参数 → 项目配置 → 无法唯一确定则结构化报错”解析；不得根据目录名、工程名或历史默认值猜测。
- `.jcap` 首轮合同为实验性 `formatVersion=0` 的 `capture.db + raw/*.bin + optional export`。采样原始段和版本化事件日志是权威数据；闭环稳定后再单独冻结 `formatVersion=1`，不默认生成 JSON/JSONL/CSV。
- 新增通用 Artifact/Symbol Catalog、Hot Variables、有界查询、少量确定性分析、本地 loopback Web 离线 UI、风险元数据与审计合同；核心状态收敛为 RuntimeContext、TargetContext、OperationPlan 和 CapturePackage。
- 删除旧 MCP 编排、全局 capture index、旧 UI 控制 API、Direct RTT/RSP/External Import capture 路由、Runtime Evidence/CodeGraph Bridge 以及非主线 probe/capture 实现。
- RTT、GDB、CPU、Flash/Erase、Raw Probe 等辅助工具继续公开，但不是默认采样路径，并受风险策略约束。现有 `halt`、`resume`、`reset` 名称和输入输出合同保持不变，由 J-Link 主 backend 执行且不属于删除范围。
- 风险模型固定为：verified target 上经过 policy allowlist、RAM 范围和布局检查的普通变量写入是 R2，使用 `variable_write_plan`、写预算、readback、capture queue、event 与 audit，但不需要 R3 operation plan 或人工批准；CPU 控制是 R3；Flash/Erase/Raw 和 unverified-target 写入例外是需要可信本地用户确认的 R4；mismatch 与 R5 始终拒绝。
- SVD 保留为后续独立规划，本次不实现。

## Capabilities

### New Capabilities

- `project-simplification`
- `artifact-symbol-catalog`
- `hot-variable-session`
- `jcap-capture-store`
- `capture-query-analysis`
- `offline-analysis-ui`
- `agent-tool-discovery`
- `risk-policy-audit`

### Modified Capabilities

- `hss-backend`
- `runtime-experiment-analysis`

### Removed Capabilities

- `ai-debug-workflow`
- `backend-benchmark`
- `capture-backend-routing`
- `capture-query-index`
- `codegraph-runtime-bridge`
- `direct-rtt-channel-backend`
- `post-capture-ui-api`

## Impact

- 变更集中在 `src/mcp/hss/`、`src/mcp/analysis/`、`src/mcp/server.ts`、`src/probe/`，并新增 artifact、symbol、hot-variable、jcap、capture-query 与 UI 模块。
- 最终 capture 目录为 `<projectRoot>/.jlink-mcp/captures/<captureId>.jcap/`。
- 活跃变更 `add-ai-hss-debug-workflow` 的 MCP 内部编排方向被本变更取代；后续需单独同步或关闭，避免两套规格并行。
- 删除采用 replacement-first 门禁；每批删除前后都必须有编译、目标测试和已接受 HSS 证据。
- 本变更不自动构建或烧录目标工程，也不修改目标工程源码。
- `resetBeforeCapture` 不改变既有 `halt`、`resume`、`reset` 工具名称或输入输出合同；它复用同一 J-Link 主 backend、R3 operation-plan、capture-conflict 和 append-safe audit 边界。
