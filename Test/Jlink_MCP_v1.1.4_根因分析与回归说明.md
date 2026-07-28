# Jlink_MCP v1.1.4 根因分析与回归说明

## 修复结论

本版本修复 3 个生产根因，并调整 2 个测试执行根因。未满足的外部测试条件继续保持 `BLOCKED`，不得转记为 `FAIL` 或 `PASS`。

| 问题编号 | 根因 | v1.1.4 处理 | 回归要求 |
| --- | --- | --- | --- |
| HSS-BUG-001 | Live HSS 在目标处于 halted 时直接启动，未执行并验证 `halted → running` 状态转换 | Helper 协议和 Capture Plan 均升级为 v3；记录初始/期望状态；halted 时显式 resume，启动后验证 running，结束时恢复初始 halted 状态 | 先执行 HSS 根因用例；通过后再解除其依赖用例 |
| JLINK-GDB-001 | GDB Server 就绪检测只读取 stdout 单个数据块，遗漏 stderr 和跨块就绪文本，失败响应也缺少启动诊断 | 分别累计有界 stdout/stderr；支持跨块匹配；超时/退出/错误返回两路诊断 | `gdb_open` 成功后才执行 command/wait/backtrace/close 和 GDB Owner 相关 RTT |
| CAPTURE-CURSOR-001 | JCAP cursor 只校验长度，畸形 cursor 被当作合法查询 | 规范化 UUID 大小写；严格校验 UUID、单个 NUL 分隔符、无额外 NUL 的可空后缀和 1024 字节上限，统一返回 `INVALID_CURSOR` | 回归 `FT-238` 及新增白盒 `WB-383` |
| TEST-RUNNER-001 | 执行器为每条用例启动新 MCP 进程，但未重放 `target_configure`，11 条用例被误报 `TARGET_NOT_CONFIGURED` | 不修改生产代码；回归执行器必须复用已配置进程，或为每个新进程重放真实配置 | 重跑 FT-064/066/067/144/147/169/170/172/174/191/194 |
| TEST-INFRA-001 | JCAP 60,000 帧用例声明 300 秒超时，但外层执行器仅允许 60 秒 | 不修改 JCAP 生产逻辑；v1.1.4 回归外层超时设为至少 360 秒 | 重跑 JCAP v1 白盒，按真实退出结果记录 |

`MCP-CASE-001` 已拆分为 `TEST-RUNNER-001` 与 `CAPTURE-CURSOR-001`，不再将 12 条不同根因的失败归并处理。

## 版本与回归范围

- 软件版本：`1.1.4`
- 功能回归版本：`TV-1.1.4-RT-01`
- 功能回归基线：`TV-1.1.3-FT-01`
- 功能回归计划：167 条，初始状态全部为 `NOT_RUN`
  - v1.1.3 `FAIL`：25 条
  - v1.1.3 `NOT_RUN`：72 条
  - HSS/GDB 修复后候选解除的 `BLOCKED`：70 条
- 白盒回归版本：`WTV-1.1.4-WR-01`
- 白盒回归计划：125 条，含受修改模块影响的既有用例及 4 条新增根因用例

真实 SVD、第二个 Probe、确定性读回故障注入和专用 Fault 固件仍未具备，对应项目继续保持 `BLOCKED`，不纳入本轮解除范围。

## 回归执行顺序

1. 核对 v1.1.4 Git Commit、构建产物、Helper 版本/Hash、Probe、目标、镜像 Hash 和证据目录。
2. 执行离线构建、发布、JCAP cursor 和 JCAP 60,000 帧白盒回归。
3. 重新验证两轮基线恢复闸门。
4. 先执行 HSS/GDB 根因用例；根因用例通过后，才调度各自依赖用例。
5. 按 `测试执行记录` 中的 Excel 顺序执行其余 v1.1.4 功能回归记录。
6. 每条完成后立即写回 Excel；单条失败不得终止无关用例。

动态 Capture/Event/GDB session 标识必须来自真实 MCP 响应。MCP `ok=true` 仍需审查原始 J-Link/GDB 诊断并采用 fail-closed 判定。

## 本会话验证边界

本修复会话仅执行编译、单元测试和 Native Helper 离线验证，不执行 Probe、Flash、Erase、HSS、GDB、RTT 等硬件功能测试。硬件结论只能由原测试任务依据 v1.1.4 回归工作簿和真实证据给出。
