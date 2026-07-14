# Jlink_MCP v0.2.1 P00 操作手册

## 1. 你现在要做什么

先把 Frozen Spec 和 P00 治理文件放入 Jlink_MCP Git 仓库，形成一个纯文档/治理的 base commit；然后在 Codex 中显式启动 `$project-orchestrator` 完成 P00；最后把 P00 result commit 和证据交给 GPT-5.6 Pro 验收。只有 Review 为 `accepted` 才进入 P01。

## 2. 两个根目录必须分开

| 用途 | 路径 | Git |
|---|---|---|
| MCP 开发、Diff、Orchestrator worktree | `<JLINK_MCP_REPO>` | 必须 |
| MCU runtime/hardware fixture | `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config` | 不要求 |

不要从目标工程启动 Orchestrator。目标工程只用于只读扫描和后续经风险治理的硬件测试。

## 3. 准备仓库

下面以 `D:\AI_Project\Trunk\Jlink_mcp` 为推荐示例。如果你的 clone 不在这里，只替换 `$RepoRoot`。

```powershell
$RepoRoot    = "D:\AI_Project\Trunk\Jlink_mcp"
$FixtureRoot = "D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config"
$KitRoot     = "<解压后的>\Jlink_MCP_v0.2.1_P00_Execution_Kit"

git -C $RepoRoot rev-parse --show-toplevel
git -C $RepoRoot status --short
git -C $RepoRoot rev-parse HEAD
```

要求：

- 先确认当前 HEAD 是你希望作为规划基线的提交。
- 如果工作区已有无关修改，先自行提交、stash 或使用新 worktree；不要让 P00 混入无关 Diff。
- 不要在目标工程执行 Git 或构建命令。

## 4. 创建 P00 分支并安装治理文件

```powershell
git -C $RepoRoot switch -c phase/P00-spec-baseline

& "$KitRoot\scripts\Install-P00Kit.ps1" `
  -RepoRoot $RepoRoot `
  -FixtureRoot $FixtureRoot

git -C $RepoRoot status --short
git -C $RepoRoot diff --check
```

安装脚本只写 Jlink_MCP 仓库，不写目标工程。它会生成：

```text
docs/spec/v0.2.1/
docs/project/v0.2.1/
docs/project-prompts/v0.2.1/
reports/governance/
reports/environment/
reports/schemas/
reports/templates/
reports/phases/P00/evidence/
.agent/orchestrator/
tests/planning/v0.2.1/
```

## 5. 创建 P00 base commit

人工检查 Diff 只包含 Spec、规划、Schema、模板、prompts 和空的报告目录/占位文件，然后提交：

```powershell
git -C $RepoRoot add `
  docs/spec/v0.2.1 `
  docs/project/v0.2.1 `
  docs/project-prompts/v0.2.1 `
  reports/governance `
  reports/environment `
  reports/schemas `
  reports/templates `
  .agent/orchestrator `
  tests/planning/v0.2.1

git -C $RepoRoot commit -m "docs(spec): freeze v0.2.1 rev1 and add P00 governance kit"
git -C $RepoRoot rev-parse HEAD
```

把这个 SHA 作为 **P00 baseCommit**。

## 6. 在 Codex 中启动 P00

1. 从 `$RepoRoot` 打开 Codex 项目/会话。
2. 确认 Codex 能读取 `$project-orchestrator` Skill。
3. 打开 `docs/project-prompts/v0.2.1/00_START_P00_ORCHESTRATOR.md`。
4. 替换 `<JLINK_MCP_REPO>`。
5. 原样粘贴提示词。

不要手动改写 Orchestrator `prepare-dispatch` 生成的角色 Prompt。Skill 的正常链路应是：

```text
init/start-phase
  → capabilities
  → register
  → prepare-dispatch
  → visible role task
  → ack-dispatch
  → ingest-handoff
  → barrier
```

## 7. P00 应完成的实际工作

### 7.1 Spec 与仓库 Inventory

- 144 条 requirement 全部检查。
- 每条填写 current `implementationStatus` 和 `codeMapping`。
- 所有 tools/resources/prompts 分类为：
  `keep | refactor | hide | remove | test-only`。
- 列出所有 target-specific 生产耦合。

### 7.2 软件 Baseline

至少记录：

```text
git HEAD / branch / status
node --version
npm --version
npm ci
npm run compile
package.json 中当前必需测试
```

每条命令必须有：

```text
command
cwd
startedAt
durationMs
exitCode
passed/failed/skipped
evidencePath
```

### 7.3 R0/R1 只读硬件 Baseline

允许：

- J-Link 安装、DLL、probe、target 能力查询；
- 目标配置和 artifact 候选只读扫描；
- 不改变目标状态的 HSS capability 或已有只读 baseline。

禁止：

```text
variable/SVD write
halt
resume
step
reset
flash write
erase
raw GDB
raw probe
```

如果 target 已 halted 而读取要求 resume，本阶段直接记录 blocker，不 resume。

## 8. 检查 P00 输出

P00 至少应出现：

```text
reports/phases/P00/
  phase-result.json
  phase-summary.md
  evidence/
    requirement-status.json
    catalog-snapshot.json
    gap-analysis.md
    test-runs.jsonl
    hardware-runs.jsonl
    hashes.sha256
```

同时更新：

```text
reports/governance/requirement-traceability.json
reports/environment/hardware-environment.json
```

检查：

```powershell
git -C $RepoRoot diff --check
git -C $RepoRoot status --short
```

重点确认 `phase-result.json`：

```text
targetWritten=false
flashIssued=false
eraseIssued=false
resetIssued=false
haltIssued=false
sourceModified=false
buildTriggered=false
```

## 9. 创建 P00 result commit

P00 barrier 完成且输出完整后：

```powershell
git -C $RepoRoot add reports .agent/orchestrator
git -C $RepoRoot commit -m "docs(p00): record spec analysis and baseline evidence"
git -C $RepoRoot rev-parse HEAD
```

这个 SHA 是 **P00 resultCommit**。若 Orchestrator Runtime 文件按项目规则不应提交，只提交项目既定允许的 Registry/报告文件；不要盲目提交临时 runtime 文件。

## 10. 使用 GPT-5.6 Pro 验收

向 GPT-5.6 Pro 提供：

```text
baseCommit
resultCommit
Frozen Spec
requirement-traceability.json
P00 goal contract/task wave
phase-result.json
phase-summary.md
evidence 目录
Git diff
```

粘贴：

```text
docs/project-prompts/v0.2.1/04_GPT56PRO_P00_REVIEW.md
```

Pro 必须生成：

```text
reports/phases/P00/review/
  pro-review-result.json
  pro-review-summary.md
```

`pro-review-result.json` 必须通过：

```text
reports/schemas/pro-review-result.schema.json
```

## 11. Review 后怎么处理

| Decision | 操作 |
|---|---|
| `accepted` | 将 Review 文件提交，进入 P01 |
| `conditional` | 仅当条件不影响 P01 hard goals 且有明确跟踪时继续；推荐先修正 |
| `correction_required` | 使用 `05_CODEX_P00_CORRECTION.md`，只修 blocking finding |
| `rejected` | 停止 P01，回到 P00 Goal/Spec/证据检查 |

修正后重新提交 result commit，并让 Pro 只复验原 blocker 和直接回归，不重跑无关内容。

## 12. 进入 P01

P00 Review 为 `accepted` 后：

1. 提交 Review 文件；
2. 更新 requirement-traceability 中 P00 状态；
3. 使用 `06_START_PHASE_TEMPLATE.md`，填入 P01 requirements 和 accepted base commit；
4. P01 开始实现统一 MCP Kernel、envelope、session、policy、risk、operationPlan、audit 和 hardware queue。

## 13. 每阶段固定循环

```text
Frozen Spec / Requirement IDs
  → Goal Contract
  → Task Wave
  → Codex implementation + scoped tests
  → phase-result.json
  → Git result commit
  → GPT-5.6 Pro Review
  → correction or accepted
  → next phase
```

## 14. 不要做的事

- 不要一次性让 Codex 实现 P01–P09。
- 不要把旧 OpenSpec 作为高于 Frozen Spec 的输入。
- 不要把历史 V8.84 报告直接当作当前硬件通过。
- 不要自动选择 `FOC_SCM.out`、`g_hssDbg*` 或 historical target hint。
- 不要在没有新 R4 receipt 时执行 flash write、erase 或 raw。
- 不要用 `approved:true` 代替人工确认。
- 不要把 `planned` 测试写成 `passed`。
- 不要在目标工程源码中插入调试代码。
