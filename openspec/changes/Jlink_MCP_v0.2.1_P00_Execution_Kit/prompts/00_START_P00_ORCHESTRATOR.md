# 提示词：启动 P00（首选）

将 `<JLINK_MCP_REPO>` 替换为本机 Jlink_MCP Git 仓库绝对路径，然后在 **Codex、仓库根目录会话**中粘贴：

```text
使用 $project-orchestrator 启动 P00：Spec Analysis and Baseline。

开发仓库根目录：
<JLINK_MCP_REPO>

运行时/硬件 fixture：
D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config

权威输入，按优先级：
1. docs/spec/v0.2.1/Jlink_MCP_v0.2.1_Functional_Spec_Rev1_Frozen.md
2. reports/governance/requirement-traceability.json
3. docs/project/v0.2.1/DEVELOPMENT_PLAN.md
4. .agent/orchestrator/P00-goal-contract.json
5. .agent/orchestrator/P00-task-wave.json
6. 当前 Git HEAD、代码、测试和实际硬件证据

执行要求：
- 先读取最近的 AGENTS.md、当前 Git 状态和上述文件。
- 使用 P00-goal-contract.json 初始化 Orchestrator；使用 P00-task-wave.json 注册第一波任务。
- Orchestrator project root 必须是 Jlink_MCP Git 仓库，不是目标工程。
- P00 不修改生产运行时代码，不修改/构建/烧录目标工程。
- P00 只允许 R0/R1 只读操作；禁止 variable/SVD write、halt、resume、step、reset、flash write、erase、raw GDB/raw probe。
- historicalTargetHint、FOC_SCM、g_hssDbg 和目录名都不是可直接采用的事实；必须实际探测或报告歧义。
- 不要伪造未运行测试、硬件结果、Token 或宿主模型生效值。
- 不要自动 commit、merge、push 或执行 R4。
- 发现设备/环境不可用时，记录 blocker 并继续完成其余 P00，不以猜测补齐。

P00 必须产出：
- reports/governance/requirement-traceability.json（144 条 requirement 的 current status/code mapping/gap）
- reports/environment/hardware-environment.json（实际可探测字段）
- reports/phases/P00/evidence/requirement-status.json
- reports/phases/P00/evidence/catalog-snapshot.json
- reports/phases/P00/evidence/gap-analysis.md
- reports/phases/P00/evidence/test-runs.jsonl
- reports/phases/P00/evidence/hardware-runs.jsonl
- reports/phases/P00/phase-result.json
- reports/phases/P00/phase-summary.md

结束条件：
- 校验所有 JSON Schema。
- 运行 barrier。
- 只报告 barrier、blocker、变更文件和下一步；不要进入 P01。
```
