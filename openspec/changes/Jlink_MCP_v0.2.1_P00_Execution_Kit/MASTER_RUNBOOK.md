# Jlink_MCP v0.2.1 — P00 Master Runbook

本文件是单文件操作版，包含决策、文件说明、完整操作步骤、固定输出格式、全部提示词和 Frozen Spec。

## A. 决策

1. 使用上传的 Frozen Spec，并以 Rev1 作为唯一功能权威。
2. Spec 仅增加 144 个 Requirement ID、验收条件和边界澄清，不扩大功能范围。
3. 增加 `requirement-traceability.json`。
4. 增加 `hardware-environment.json`；它是测试 fixture 记录，不是产品默认配置。
5. 正式开发从 P00 开始显式使用 `$project-orchestrator`。
6. P00 不修改运行时代码，只做 Spec/Gap/Baseline/Reporting。

## B. 包内文件

```text
Jlink_MCP_v0.2.1_P00_Execution_Kit/
  README_START_HERE.md
  MASTER_RUNBOOK.md
  OPERATIONS_GUIDE.md
  DEVELOPMENT_PLAN.md
  VALIDATION_REPORT.md
  spec/
    Jlink_MCP_v0.2.1_Functional_Spec_Rev1_Frozen.md
    SPEC_REV1_CHANGELOG.md
    requirement-traceability.json
    source/Jlink_MCP_v0.2.1_Function_List_Updated.md
  environment/hardware-environment.json
  orchestrator/P00-goal-contract.json
  orchestrator/P00-task-wave.json
  schemas/*.schema.json
  templates/*
  prompts/*
  scripts/Install-P00Kit.ps1
  scripts/Validate-P00Kit.ps1
  tests/test-catalog.json
  tests/TEST_CATALOG.md
```

## C. 完整操作步骤


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


## D. 固定输出格式

### 阶段目录

```text
reports/phases/PXX/
  phase-result.json
  phase-summary.md
  evidence/
    test-runs.jsonl
    hardware-runs.jsonl
    requirement-status.json
    catalog-snapshot.json
    hashes.sha256
  review/
    pro-review-result.json
    pro-review-summary.md
```

### Handoff

```markdown
## 任务 <TASK-ID>

**状态：已完成**

### 产物
- `<path>`：<说明>

### 验证
- `<test-id>`：`<command>`；结果 `<passed/failed/skipped>`；证据 `<path>`

### 信号
- 无；或 decision/risk/memory

### 边界声明
- 实际变更位于 ownedScope：true
- 目标工程源码修改：false
- 目标构建触发：false
- 未经批准的 R4：false
- 未观测数据被估算：false
```

### 时间修正

```text
executionElapsedMs =
  elapsedMs
  - blockedMs
  - humanApprovalWaitMs

ratio =
  actualExecutionMinutes / plannedMinutes

recommendedMultiplier =
  clamp(median(最近最多三个同类 accepted ratios), 0.70, 1.80)
```

硬件执行时间单列；Token 不可观测时写 `available=false`。


## E. 全部提示词

### 00_START_P00_ORCHESTRATOR.md

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


### 01_P00_CONTRACT_INVENTORY_FALLBACK.md

# 提示词：P00 规格与仓库 Inventory（不使用自动派发时）

```text
你负责 Jlink_MCP P00 的“规格与合同岗位”。

目标：
验证 Frozen Spec 和 144 条 requirement-traceability 是否完整，并把当前仓库公共面映射到 requirement。不得实现功能或重构生产代码。

必须读取：
- docs/spec/v0.2.1/Jlink_MCP_v0.2.1_Functional_Spec_Rev1_Frozen.md
- reports/governance/requirement-traceability.json
- package.json
- src/mcp/server.ts 及相关注册入口
- AGENTS.md、README、MCP resources/prompts/config
- 当前 Git HEAD

任务：
1. 校验 requirement ID 唯一、总数 144、每条有 owner phase 和 planned test。
2. 枚举当前所有 tools/resources/prompts，逐项标记：
   keep | refactor | hide | remove | test-only。
3. 为每项绑定 requirement IDs、当前源码位置和主要缺口。
4. 搜索并列出生产代码中的 target-specific 耦合：
   HM_C095、FOC_SCM、g_hssDbg、Z20K146M、固定本机路径、项目专用 semantic。
5. 更新 requirement-traceability.json 的 implementationStatus、codeMapping 和 notes。
6. 生成：
   - reports/phases/P00/evidence/requirement-status.json
   - reports/phases/P00/evidence/catalog-snapshot.json
   - reports/phases/P00/evidence/gap-analysis.md

禁止：
- 修改 src/、native/、package runtime 行为。
- 把历史验证文档当作当前通过证据。
- 猜测 artifact、target、变量地址或类型。

最终使用 task-handoff.template.md，状态必须明确，结论级证据不超过三条。
```


### 02_P00_BASELINE_FALLBACK.md

# 提示词：P00 软件与只读硬件 Baseline

```text
你负责 Jlink_MCP P00 的“基线验证岗位”。生产代码和目标工程只读，只能在 `reports/phases/P00/evidence/` 写证据。

目标：
在当前 Git baseline 上获取可复现的软件和 J-Link V8.84 R0/R1 只读证据。不得修改仓库文件或目标工程。

输入：
- reports/environment/hardware-environment.json
- package.json
- docs/spec/v0.2.1/Jlink_MCP_v0.2.1_Functional_Spec_Rev1_Frozen.md
- .agent/orchestrator/P00-goal-contract.json

顺序：
1. 记录 git rev-parse HEAD、branch、git status、Node、npm、OS/arch、PowerShell。
2. 记录目标工程只读 source fingerprint；不要运行目标构建。
3. 执行 npm ci（若工作流允许 lockfile 精确安装）、npm run compile、当前 package.json 定义的必需测试。
4. 每条命令记录 command、cwd、startedAt、durationMs、exitCode、passed/failed/skipped。
5. 设备可用时，仅执行：
   - J-Link 安装/DLL/probe/target capability 查询；
   - artifact/config 候选只读扫描；
   - HSS capability 或已有只读 baseline，不得 reset/resume/halt/write。
6. 设备不可用、target halted 而需要 resume、出现 GUI/权限问题时立即停止对应硬件路径并记录 blocker。
7. 重新计算目标 source fingerprint，证明 sourceModified=false、buildTriggered=false。

禁止：
variable/SVD write、halt、resume、step、reset、flash write、erase、raw GDB、raw probe，以及向目标根写入新的 capture/policy/audit。

输出：
- reports/phases/P00/evidence/test-runs.jsonl
- reports/phases/P00/evidence/hardware-runs.jsonl
- reports/phases/P00/evidence/hashes.sha256
- 在 Handoff 中提供 hardwareEnvironmentPatch 和 safety 摘要

只能修改上述 evidence scope；不得修改 src/native/package/目标工程。最终 Handoff 必须明确安全字段全部为 false，无法运行的测试列为 not_run/blocked。
```


### 03_P00_REPORTING_FALLBACK.md

# 提示词：P00 报告汇总

```text
你负责 Jlink_MCP P00 的“报告与证据岗位”。

前置证据：
- contract inventory Handoff
- baseline Handoff
- reports/phases/P00/evidence/*
- reports/schemas/phase-result.schema.json
- reports/templates/phase-result.template.json

任务：
1. 汇总而不篡改前置证据。
2. 更新 reports/environment/hardware-environment.json，只填实际观测值；未知保留 null。
3. 更新 requirement-traceability.json，保留 planned 与 passed 的区别。
4. 生成 reports/phases/P00/phase-result.json。
5. 生成 reports/phases/P00/phase-summary.md。
6. 使用 JSON Schema 2020-12 校验：
   - phase-result.json
   - requirement-traceability.json
   - hardware-environment.json
7. 检查 P00 safety：
   targetWritten=false、flashIssued=false、eraseIssued=false、resetIssued=false、haltIssued=false、sourceModified=false。
8. 未运行 mandatory test 必须列入 mandatoryNotRun；不能用历史文档替代。
9. 不判定进入 P01；只生成阶段候选并等待 GPT-5.6 Pro Review。

不得修改生产代码，不得自动 commit/push。
```


### 04_GPT56PRO_P00_REVIEW.md

# 提示词：GPT-5.6 Pro 验收 P00

在 GPT-5.6 Pro 中提供 P00 Git commit/仓库访问和下列文件，然后粘贴：

```text
你是 Jlink_MCP v0.2.1 P00 的独立验收模型。只做分析和验收，不修改代码，不执行硬件操作。

权威顺序：
1. docs/spec/v0.2.1/Jlink_MCP_v0.2.1_Functional_Spec_Rev1_Frozen.md
2. reports/governance/requirement-traceability.json
3. .agent/orchestrator/P00-goal-contract.json
4. reports/phases/P00/phase-result.json
5. reports/phases/P00/phase-summary.md
6. reports/phases/P00/evidence/*
7. 当前 Git diff/commit 和实际源码

必须检查：
- Frozen Spec 是否仅做 clarification，没有偷偷扩大/缩小功能范围。
- Requirement 是否恰好 144 条、ID 唯一、全部有 owner phase/planned test。
- 当前 tools/resources/prompts inventory 是否完整，分类是否有源码证据。
- target-specific 耦合是否完整识别。
- 软件测试 command/exitCode/count/duration 是否可复现。
- hardware-environment 是否只填实际值；历史 hint 未被当事实。
- P00 是否发生任何 R2+、目标写入、halt/reset/flash/raw、目标源码修改或构建。
- phase-result.json 是否与 evidence 和 Git diff 一致。
- 所有 not_run/blocker 是否诚实披露。
- plannedMinutes 与 executionElapsedMs 的计算是否正确：
  executionElapsedMs = elapsedMs - blockedMs - humanApprovalWaitMs。
- Token 不可观测时是否明确 unavailable。

输出要求：
1. 生成 reports/phases/P00/review/pro-review-result.json，必须严格匹配 reports/schemas/pro-review-result.schema.json。
2. 生成 reports/phases/P00/review/pro-review-summary.md，最多包含：
   - decision
   - blocking findings
   - required corrections/retest scope
   - next-phase budget correction
3. decision 只能是 accepted、conditional、correction_required、rejected。
4. 只有证据覆盖全部 P00 exit criteria 且无阻塞问题时才 accepted。
5. finding 必须指出 requirementId、可达触发条件、文件/行或 evidence、修正和最小 retestScope；纯理论风险不得设为 blocking。
6. 不要直接进入 P01，不要自动 commit/push。
```


### 05_CODEX_P00_CORRECTION.md

# 提示词：根据 Pro Review 修正 P00

```text
使用 $project-orchestrator 处理 P00 correction。

输入：
- reports/phases/P00/review/pro-review-result.json
- reports/phases/P00/review/pro-review-summary.md
- 当前 P00 Registry 和 evidence

要求：
1. 只处理 blocking finding 及其直接回归。
2. 不降低 hard goal、constraint 或 exit criterion。
3. finding 若需要改生产代码，停止并返回 waiting_decision；P00 不允许运行时实现变更。
4. 对受影响任务使用 resolve-decision/prepare-dispatch correction；不要重跑无关完整测试。
5. 更新 phase-result/evidence，并保留原失败证据和 correctionCount。
6. 重新校验 Schema，运行 barrier。
7. 不进入 P01，等待 GPT-5.6 Pro 复验。
```


### 06_START_PHASE_TEMPLATE.md

# 提示词：P01–P09 通用阶段启动模板

将占位符替换后使用：

```text
使用 $project-orchestrator 启动 <PXX>：<PHASE-NAME>。

仓库：<JLINK_MCP_REPO>
硬件 fixture：D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config
基线提交：<BASE-COMMIT>
上一阶段 Pro decision：accepted
上一阶段 Review：reports/phases/<PREV>/review/pro-review-result.json

本阶段权威 requirements：
<REQ-ID-LIST>

要求：
- 读取 Frozen Spec、requirement-traceability、当前代码和上一阶段 accepted evidence。
- 将本阶段 requirements 组成 Goal Contract；不得扩大其他阶段范围。
- 每个实现任务包含 affected/module tests 和一次 self-check。
- 所有公共合同变更更新 tool schema、resources/prompts、migration notes 和 traceability。
- 硬件测试必须遵守 risk：
  R2=policy+readback；
  R3=operationPlan+audit；
  R4=执行时另行请求用户可信确认；
  R5=禁止。
- 没有 R4 确认时只验收 dry-run/拒绝路径，不得执行真实 flash/erase/raw。
- 目标工程默认不修改、不构建；真实安全变量/field 未确认时标记 not_run。
- 输出固定 reports/phases/<PXX>/ 结构和 Schema-valid phase-result.json。
- barrier 后停止，等待 GPT-5.6 Pro Review；不自动 commit/merge/push。
```


### 07_GPT56PRO_PHASE_REVIEW_TEMPLATE.md

# 提示词：P01–P09 通用 GPT-5.6 Pro Review

```text
你是 Jlink_MCP v0.2.1 <PXX> 的独立验收模型，只做 Review。

输入：
- Frozen Spec Rev1
- requirement-traceability.json
- <PXX> Goal Contract / Task Graph
- baseCommit..resultCommit Git diff
- reports/phases/<PXX>/phase-result.json
- reports/phases/<PXX>/phase-summary.md
- reports/phases/<PXX>/evidence/*
- 前一阶段 accepted review

检查：
1. 所有本阶段 requirement 的实现、负向边界和兼容性是否有直接证据。
2. 公共 API/Schema/Agent discovery 是否一致。
3. 测试是否覆盖 affected/module/phase 范围，失败是否被隐藏。
4. 硬件证据是否来自指定 fixture，身份/hash 是否匹配。
5. R2/R3/R4/R5 是否严格遵守；approval receipt 是否可信绑定并单次使用。
6. 生产代码是否引入 HM_C095/FOC_SCM/g_hssDbg/Z20K146M 默认。
7. timing 修正是否排除 blocked/human approval wait，并基于最近最多三个可比 accepted task ratio 的中位数，clamp 到 0.70–1.80。
8. 只对有可达触发和证据的问题设 blocking。

输出：
- reports/phases/<PXX>/review/pro-review-result.json，严格匹配 pro-review-result.schema.json
- reports/phases/<PXX>/review/pro-review-summary.md
- 不修改代码，不执行硬件，不进入下一阶段。
```


### 08_R4_EXECUTION_APPROVAL_TEMPLATE.md

# 提示词：未来 R4 执行时的人工确认模板

> 仅在工具已经生成 R4 plan，且你确实愿意执行该具体操作时使用。不要提前长期授权。

```text
我确认执行下面这个单次 R4 operation plan：

operation: <flash_write|erase|raw_gdb|raw_probe|critical_svd_write|composite_reset>
planId: <PLAN-ID>
planDigest: <SHA-256>
targetId: <TARGET-ID>
artifactSha256: <SHA-256-or-null>
policySha256: <SHA-256>
expiresAt: <ISO-8601>
expectedImpact: <摘要>
recoveryAndValidation: <摘要>

仅批准以上精确 plan 的一次执行。任何参数、target、artifact、policy、runtime identity、TTL 或 digest 变化都必须重新请求确认。禁止把本消息解释为 approved=true、通用授权或后续操作授权。
```



## F. Frozen Spec Rev1（完整文本）

# Jlink_MCP v0.2.1 Functional Specification

- **Revision**：1
- **Status**：Frozen
- **Date**：2026-07-14
- **Scope change**：None。该修订仅增加 Requirement ID、验收条件和已确认的边界澄清，不新增第一版功能。
- **Authoritative source**：本文件；原始冻结清单 SHA-256：`12e46eda65d07e29eee67fd4e783093190c8ecdf8e2cd170b6eb5ef7e62b173b`
- **Package version**：与功能规格版本独立管理。

## 0.1 规范用语

- **必须 / MUST**：发布前必须满足。
- **不得 / MUST NOT**：禁止路径，任何默认值或兼容层均不能绕过。
- **第一版**：本 Spec v0.2.1 的冻结交付范围。

## 0.2 已确认的边界澄清

1. `HM_C095`、`FOC_SCM.*`、`g_hssDbg*`、`Z20K146M` 和本机绝对路径只允许出现在测试 fixture、硬件证据和示例配置中。
2. 数组元素/切片写已有实验代码可以保留为 test-only/experimental，但不得出现在 v0.2.1 公共 catalog。
3. 活跃 HSS capture 中普通 `reset/halt/step` 不直接执行。需要 reset 时先停止 capture；只有显式 R4 复合流程可执行并重新建立采样。
4. R4 批准必须是绑定 operation plan 的单次可信 receipt，裸 `approved:true` 无效。
5. 源代码扫描只发现候选；变量地址、尺寸、类型和 struct member offset 必须由 debug artifact/map 验证。

## 0.3 产品定位摘要

Jlink_MCP 是 Agent 调试 MCU 的通用本机运行时访问层：以 MCP 启动 cwd 为 projectRoot，支持 Debug Artifact 变量解析、RAM 变量读写、HSS 高速采样、Background Memory/RSP fallback、可选 RTT、SVD、Flash verify/write、风险治理、审计和统一 JSON 返回。

## 0. 修订澄清

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-CLR-001` | 功能规格版本 v0.2.1 与 npm/package 版本独立管理，不要求 package 降级或与 Spec 同号。 | 阶段报告同时记录 specVersion 与 packageVersion，不因规格号修改 package 版本。 | `P00` |
| `REQ-CLR-002` | J-Link V8.84 与 HM_C095 目标工程只作为主要硬件验收 fixture，不得成为生产默认或通用语义。 | traceability、hardware-environment 与测试 profile 明确 target-specific；生产源码无默认绑定。 | `P00` |
| `REQ-CLR-003` | 目标工程源码扫描只能发现候选和声明上下文；地址、尺寸、类型和 member offset 必须由 debug artifact/map 验证。 | 没有 artifact/map 证据时 resolver 不输出可执行地址。 | `P02` |
| `REQ-CLR-004` | 硬件变量写验收只能使用用户/policy 明确选择的非执行器 RAM 调试变量，并执行 old→new→readback→restore→readback。 | hardware evidence 记录 old/new/readback/restore，restored=true；未识别安全变量时测试 not_run 而非猜测。 | `P04` |

## 1. 项目定位

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-GEN-001` | Jlink_MCP 必须作为供 Codex/Agent 调用的通用本机 MCU Runtime Access MCP，而不是单一目标工程或单一 MCU 的专用工具。 | 生产代码在不依赖 HM_C095、FOC_SCM、固定目标 ID 或固定绝对路径的情况下可启动并完成能力发现。<br>至少一个非 HM_C095 的离线/模拟 fixture 通过公共合同测试。 | `P09` |
| `REQ-GEN-002` | Jlink_MCP 不负责理解业务逻辑或决定调试结论；Agent 负责理解项目、选择工具和解释证据。 | server instructions、resources 和 prompts 不宣称 MCP 自动理解业务或生成项目语义结论。 | `P08` |
| `REQ-GEN-003` | 所有核心运行时访问必须输出可靠、可追溯、结构化的数据和证据引用。 | 核心工具返回统一 envelope，包含 operation、risk、backend、artifacts、warnings 和结果状态。<br>改变目标状态的操作能够关联 plan、audit 和验证结果。 | `P01` |
| `REQ-GEN-004` | MCP 产品运行时不得依赖目标工程使用 Git，也不得通过 Git 命令确定 projectRoot。 | 静态检查和集成测试证明运行时 project context 不调用 Git。<br>非 Git fixture 可正常初始化 `.jlink-mcp`。 | `P01` |
| `REQ-GEN-005` | 第一版不得要求目标 MCU 工程为使用 MCP 而修改、插桩或新增运行时代码。 | 硬件验收前后目标源码 fingerprint 一致，sourceModified=false。<br>HSS、Background Memory、RSP 和 SVD 主流程不依赖新增目标端代码。 | `P09` |

## 2. 主从关系

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-ROLE-001` | Agent/Codex 必须负责理解项目、判断问题、选择调试流程和选择 MCP 工具。 | Agent workflow 文档明确 MCP 只提供能力与证据，Agent 负责决策。 | `P08` |
| `REQ-ROLE-002` | Jlink_MCP 必须提供 J-Link、HSS、SVD、变量读写、采样、Flash 和审计能力，不越权替代 Agent。 | mcu_capabilities 和 mcu_tool_catalog 能枚举公共能力及其风险。 | `P08` |
| `REQ-ROLE-003` | 用户只在 R4 高风险执行时提供人工确认；R0-R3 按 policy 和 operationPlan 自动治理，R5 永久拒绝。 | R4 execute 无可信 approval receipt 时稳定拒绝。<br>R0-R3 不要求裸人工确认；R5 无任何执行路径。 | `P07` |

## 3. 项目路径策略

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-PATH-001` | projectRoot 必须等于 MCP 进程启动时的 process.cwd()。 | 在不同 cwd 启动时 projectRoot 精确等于对应规范化 cwd。 | `P01` |
| `REQ-PATH-002` | MCP 运行时不得调用 Git 命令或查找 Git 根目录来确定 projectRoot。 | 无 Git 环境测试通过，且静态检查未发现运行时 Git root 探测。 | `P01` |
| `REQ-PATH-003` | 公共工具不得要求用户重复传入 projectRoot。 | 公共 tool schema 中不存在必填 projectRoot 参数；project context 来自 server cwd。 | `P01` |
| `REQ-PATH-004` | 默认输出必须位于 `<cwd>/.jlink-mcp/`。 | 初始化后只在 cwd 下创建 `.jlink-mcp` 及规定子目录。 | `P01` |
| `REQ-PATH-005` | MCP 必须拒绝任何通过绝对路径、`..`、符号链接、junction、reparse point 或规范化差异逃逸 cwd 的读写。 | Windows 路径、大小写、UNC、符号链接/junction 和 TOCTOU 相关边界测试通过。 | `P01` |
| `REQ-PATH-006` | Agent 可以传 sessionName；未传时由 MCP 生成。 | 显式 sessionName 被规范化保存；缺省时生成符合命名规则的唯一名称。 | `P01` |
| `REQ-PATH-007` | Agent 可以传 outputSubdir，但解析后的目录必须位于 cwd 内部。 | cwd 内合法子目录通过；cwd 外、链接逃逸和路径歧义被拒绝。 | `P01` |

## 4. Debug Artifact 支持

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-ART-001` | 用于变量解析的 `.elf`、`.out` 和预留 `.axf` 必须按文件内容识别，而不是只按扩展名。 | ELF 内容配合不同扩展名均被识别；伪造扩展名但非 ELF 内容被拒绝。 | `P02` |
| `REQ-ART-002` | 变量地址、尺寸和类型必须优先来自 ELF 调试信息或符号表。 | 含 DWARF 的 fixture 可解析地址、类型和 struct member offset。 | `P02` |
| `REQ-ART-003` | 第一版必须支持 IAR `.map` 作为变量解析补充来源。 | IAR map fixture 可解析唯一 global/static symbol；重复或缺失符号产生结构化错误。 | `P02` |
| `REQ-ART-004` | `.hex`、`.bin`、`.srec`/`.s19` 只能用于 Flash/校验，不得参与变量解析。 | 将这些文件传给 symbol/artifact resolver 时稳定返回 unsupported，而 Flash probe 可接受。 | `P02` |
| `REQ-ART-005` | 发现多个 debug artifact、map 或配置候选时，MCP 必须返回候选及歧义原因，不得按工程名或历史文件名自动猜测。 | 多候选 fixture 返回 selection-required 与候选列表；不自动选择最新 FOC_SCM 文件。 | `P02` |
| `REQ-ART-006` | Agent 显式选择的 artifact 必须被规范化、哈希并绑定到后续 Symbol Catalog、plan 和证据。 | artifact SHA-256 在 catalog、plan、capture metadata 和 phase evidence 中一致。 | `P02` |
| `REQ-ART-007` | 生产 resolver 不得默认搜索或优先选择 `FOC_SCM.out`、`FOC_SCM.map` 或其他 HM_C095 专用名称。 | 生产源码静态检查无专用默认名；相关名称仅存在于 tests/fixtures、examples 或硬件 profile。 | `P02` |

## 5. 变量读取范围

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-VREAD-001` | 第一版必须支持通过 Symbol Catalog 读取 global scalar。 | 离线解析和模拟 memory backend 返回正确类型和值。 | `P03` |
| `REQ-VREAD-002` | 第一版必须支持带编译单元/作用域消歧的 static scalar 读取。 | 同名 static 未限定时返回歧义；限定后读取正确地址和值。 | `P03` |
| `REQ-VREAD-003` | 第一版必须支持具有固定布局的 struct member 读取。 | member offset 来自 DWARF/受验证布局，读取值与 fixture 一致。 | `P03` |
| `REQ-VREAD-004` | 第一版不得解析或读取局部变量。 | local selector 返回明确 unsupported，不退化为地址猜测。 | `P02` |
| `REQ-VREAD-005` | 第一版不得自动解引用指针选择器。 | 含 `*`、`->` 或隐式指针遍历的 selector 被拒绝。 | `P02` |
| `REQ-VREAD-006` | 第一版不得解析动态数组、malloc 对象或运行时长度对象。 | 动态对象 selector 返回 unsupported，且不进行 target memory chase。 | `P02` |
| `REQ-VREAD-007` | 第一版不得提供多核或多镜像变量解析。 | 多镜像/多核输入返回 unsupported 或 selection-required，不默选 core/image。 | `P02` |

## 6. 变量写入范围

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-VWRITE-001` | 第一版必须支持 policy allowlist 内的 RAM scalar 写入。 | 允许目标通过 plan→execute→readback，非 RAM 目标被拒绝。 | `P04` |
| `REQ-VWRITE-002` | 第一版必须支持 policy allowlist 内的 struct fixed member 写入。 | member 地址由 catalog 解析，写后 readback 与目标值一致。 | `P04` |
| `REQ-VWRITE-003` | 任何变量写执行前必须生成可检查的 variable_write_plan。 | execute 缺少有效 plan 时拒绝；plan 包含 target、类型、范围、risk、policy 和验证步骤。 | `P04` |
| `REQ-VWRITE-004` | 所有实际变量写必须执行 readback 并报告匹配结果。 | readback mismatch 返回失败/未知状态并写入 audit；不得报告成功。 | `P04` |
| `REQ-VWRITE-005` | 变量写必须执行按 policy 配置的 maxWrites 限制，超限只拒绝该目标后续写入。 | 目标 A 超限后 A 被拒绝，目标 B 仍可按 policy 执行；session 不被整体关闭。 | `P04` |
| `REQ-VWRITE-006` | variable write plan/execute 必须支持 dryRun，dryRun 不得写目标。 | dryRun 返回计划、旧值读取意图和验证步骤；目标值与写计数均不变。 | `P04` |
| `REQ-VWRITE-007` | 公共变量写 API 不得允许调用方绕过 Symbol Catalog 直接提供任意地址。 | 公共 schema 不接受裸 address；legacy write_memory 被隐藏、迁移或纳入 R4 raw 边界。 | `P04` |
| `REQ-VWRITE-008` | Flash、Peripheral、Debug/Core register 区不得通过变量写 API 写入。 | 地址域校验分别拒绝 Flash、Peripheral、Core/Debug 范围。 | `P04` |
| `REQ-VWRITE-009` | 数组元素或数组切片写入不得出现在 v0.2.1 公共 tool catalog；已有实验实现只能隔离为 test-only/experimental。 | 公共 schemas/resources/prompts 不暴露 array_element/array_slice；生产默认流程不会调用。 | `P04` |

## 7. 风险等级策略

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-RISK-001` | R0 纯只读与能力查询可由 Agent 自动执行。 | R0 工具风险元数据正确且不要求 approval。 | `P01` |
| `REQ-RISK-002` | R1 变量读取、SVD 读、artifact probe 和 HSS plan 可由 Agent 自动执行。 | R1 工具风险元数据正确且不改变目标状态。 | `P01` |
| `REQ-RISK-003` | R2 仅允许 policy 允许的 RAM 变量写，且必须 readback。 | R2 缺少 allowlist/readback 时拒绝。 | `P04` |
| `REQ-RISK-004` | R3 halt/resume/step/reset、GPIO 输出写和普通 SVD field 写必须有 operationPlan 与 audit，可由 Agent 自主判断执行。 | R3 execute 重新验证 operationPlan 并产生 audit。 | `P07` |
| `REQ-RISK-005` | R4 Flash 写、erase、raw GDB/raw probe 和关键外设写必须获得可信人工确认后执行。 | 无 receipt、过期 receipt、错 plan receipt 和重放 receipt 均拒绝。 | `P07` |
| `REQ-RISK-006` | R5 option byte、security、reserved bit、未知寄存器和危险系统区写必须永久禁止。 | R5 plan/execute 均返回 prohibited，任何 override 都不能放行。 | `P07` |
| `REQ-RISK-007` | R3/R4 operationPlan 必须绑定 operation、规范化参数、target identity、artifact/catalog identity、policy hash、runtime identity、session、TTL 和单次执行状态。 | 任一绑定字段变化、过期、跨 session 或二次执行均拒绝。 | `P01` |
| `REQ-RISK-008` | R4 人工确认不得使用裸 `approved:true`；必须由可信 approval provider 产生绑定 planDigest、target、artifact、policy、TTL 和 nonce 的单次 receipt。 | 伪造布尔批准无效；receipt 可验证、不可跨计划使用、不可重放。 | `P07` |

## 8. Policy 文件

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-POL-001` | policy 必须保存于 `<projectRoot>/.jlink-mcp/policy.json`。 | 非 Git fixture 初始化并加载规定路径的 policy。 | `P01` |
| `REQ-POL-002` | policy 必须支持 variableWriteAllowlist、svdWriteAllowlist、riskOverrides、maxWrites、value range、requireReadback 和 allowBurstWrite。 | schema 对必需/可选字段、类型、范围和未知字段执行严格校验。 | `P01` |
| `REQ-POL-003` | 第一版 policy 允许配置 R0-R3；R4 仍需人工确认，R5 不可被 policy 放行。 | riskOverride 不能把 R4 降为无需确认，也不能放行 R5。 | `P01` |
| `REQ-POL-004` | variable/SVD allowlist 必须精确绑定目标路径/field、类型、值域、写次数和 readback 要求。 | 非 allowlist 目标、越界值、类型不匹配和次数超限分别被拒绝。 | `P04` |
| `REQ-POL-005` | 执行计划和审计必须记录规范化 policy hash；执行时 policy 变化必须使旧计划失效。 | plan 与 execute 间修改 policy 后返回 binding mismatch。 | `P01` |

## 9. dry-run 模式

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-DRY-001` | variable_write、svd_write_field、flash、erase、halt、resume、step、reset 和 raw_command 必须支持 `dryRun:true`。 | tool catalog/schema 标记上述操作支持 dryRun。 | `P07` |
| `REQ-DRY-002` | dryRun 必须完成解析、风险、policy、plan 和预期影响检查，但不得改变目标、Flash、CPU 状态或写计数。 | 模拟/硬件观察证明 dryRun 前后目标状态一致，audit 标记 dryRun。 | `P07` |

## 10. J-Link 能力

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-JLINK-001` | 第一版必须支持本机直接连接 SEGGER J-Link。 | 本机 V8.84 fixture 能完成只读 capability probe。 | `P03` |
| `REQ-JLINK-002` | MCP 必须识别连接的 J-Link 型号、序列号和目标设备选择状态。 | capabilities/backend status 返回探针型号、序列号和目标 ID 或结构化 unknown。 | `P03` |
| `REQ-JLINK-003` | MCP 必须识别 J-Link 软件/DLL 路径、版本、架构和 SHA-256。 | V8.84 DLL 身份字段完整；路径/哈希变化可被检测。 | `P03` |
| `REQ-JLINK-004` | MCP 必须提供 J-Link 与 HSS 能力查询并返回限制和不可用原因。 | 能力查询不写目标，且能区分 unsupported、unavailable、misconfigured。 | `P03` |
| `REQ-JLINK-005` | 第一版不得实现远程 Agent、远程硬件或复杂多探针调度。 | 公共 catalog 不宣称远程/复杂调度能力；相关配置返回 unsupported。 | `P09` |

## 11. HSS 高速采样

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-HSS-001` | HSS 必须是第一版高速变量采样主路径。 | workflow 优先推荐 HSS；不适用时才返回 BMA/RSP 建议。 | `P05` |
| `REQ-HSS-002` | 必须提供只读 `hss_capability_probe`，报告 DLL、helper、target、limits 和 safety 状态。 | probe 不 reset/halt/write/flash，返回结构化 availability 与限制。 | `P05` |
| `REQ-HSS-003` | 必须提供 `hss_capture_plan`，由 Agent 选择 catalog 变量、采样率、时长和分段大小。 | plan 不启动采样，且包含估算、限制、risk、artifact/catalog/runtime identities。 | `P05` |
| `REQ-HSS-004` | 第一版只支持单组 HSS capture；不支持并行多组或多频率 HSS。 | 第二组并发 start 被拒绝并返回 active owner；catalog 不暴露多组计划。 | `P05` |
| `REQ-HSS-005` | 计划和启动前必须校验 J-Link 版本/型号、HSS maxBlocks/maxFreq、变量数量、布局和请求速率。 | 超限计划不触碰硬件并返回可执行的减变量/降频/分轮建议。 | `P05` |
| `REQ-HSS-006` | capture start/status/stop 必须形成可恢复的单会话生命周期并保证探针所有权。 | 并发、异常退出、stop timeout 和 session recover 有确定状态和审计。 | `P05` |
| `REQ-HSS-007` | HSS 请求超限时必须返回 Agent 可选择的降低采样率、减少变量数量或分多轮采样建议，不得自动做业务优先级判断。 | 错误 envelope 包含当前限制、请求量和至少一个合法调整方案。 | `P05` |
| `REQ-HSS-008` | HSS transport/data quality 判定必须与 HM_C095 或其他项目专用 semantic profile 分离。 | 项目专用 counter/profile 失败不能把零错误的通用 transport 判定为失败；profile 仅位于测试目录。 | `P05` |

## 11A. HSS 高速采样过程中的变量写入

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-HSSW-001` | HSS capture 拥有 probe 时，允许的变量写必须作为 capture session 子操作进入统一硬件队列，普通写不得绕过。 | 直接抢占写被拒绝；带 captureId 的队列写串行执行。 | `P04` |
| `REQ-HSSW-002` | HSS 运行中可执行不破坏 capture 的 R0/R1 读和查询操作。 | status/query 等操作不抢占探针或破坏采样。 | `P05` |
| `REQ-HSSW-003` | HSS 运行中允许 policy 允许的 R2 RAM scalar/struct member 写，必须 readback。 | 1 kHz capture 中安全 R2 写成功、readback 匹配且 capture 继续。 | `P04` |
| `REQ-HSSW-004` | HSS 运行中的 R3 RAM/SVD field 写必须有 operationPlan、policy、队列和 audit。 | 缺 plan 或非 allowlist R3 写被拒绝；成功路径生成 audit/event。 | `P06` |
| `REQ-HSSW-005` | HSS 运行中必须禁止 flash、erase、raw GDB/raw probe、halt、step 和直接 reset。 | active capture 下各操作稳定拒绝且不改变 capture metadata。 | `P07` |
| `REQ-HSSW-006` | 需要 reset 时应先停止 capture；只有显式 R4 复合操作计划可在重启采样流程中执行 reset，不能作为普通 R3 capture 子操作。 | 普通 reset 在 active capture 下拒绝；R4 复合流程要求人工 receipt，并明确结束/重建 capture。 | `P07` |
| `REQ-HSSW-007` | HSS 运行中写入必须记录 variable_write event，至少包含 timeUs、sampleIndexNear、target、oldValue、newValue、readback、risk 和 ok。 | capture.json event 字段完整并能与 audit writeId/planId 关联。 | `P04` |
| `REQ-HSSW-008` | Agent 必须能按写入 event 查询写前/写后的有界采样窗口。 | 事件窗口查询返回边界、前后样本和缺口 warnings；不要求 Agent 解析 raw BIN。 | `P05` |
| `REQ-HSSW-009` | 采样记录必须支持 write_nearby、write_in_progress 和 backend_busy 状态标记。 | 写事件附近对应样本/区间能够查询到有效 flags。 | `P05` |
| `REQ-HSSW-010` | capture-time write 失败不得破坏 capture metadata；写入是否已发出、readback 和未知状态必须保留。 | 模拟 write/readback 失败后 capture 可停止/查询，metadata 和 audit 包含失败证据。 | `P04` |

## 12. Background Memory Access / Live Watch

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-BMA-001` | 必须提供 Background Memory/Live Watch，用于少量变量的低侵入周期读取和 Agent 验证。 | 模拟/硬件读取返回时间戳、值、backend 和质量状态。 | `P03` |
| `REQ-BMA-002` | Background Memory 路径必须支持 target 已 halted 状态下的读取并如实报告状态。 | 已 halted fixture 读取不自动 resume。 | `P03` |
| `REQ-BMA-003` | Background Memory 失败后 MCP 不得自动 halt target。 | 故障注入后 haltIssued=false，返回 fallback suggestion。 | `P03` |
| `REQ-BMA-004` | Background Memory 不适用或失败时必须返回结构化 fallback reason 和 HSS/RSP/Agent-R3-halt 建议。 | backend envelope 明确 fallbackFrom、selected/reason，且不自动执行 halt。 | `P03` |

## 13. RSP Memory fallback

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-RSP-001` | 必须提供 RSP Memory 作为 HSS/Background Memory 不适用时的少量变量和小范围 memory read fallback。 | RSP 模拟/集成测试读取正确字节和值。 | `P03` |
| `REQ-RSP-002` | 选择 RSP 时必须返回为何未选 HSS/BMA 的结构化原因。 | envelope 的 backend.selected、fallbackFrom、reason 一致。 | `P03` |
| `REQ-RSP-003` | RSP 不得被宣传或自动用于高速采样。 | 高速 capture workflow 不选择 RSP；超速请求返回 HSS 建议。 | `P03` |

## 14. RTT

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-RTT-001` | RTT 必须保留为 optional 能力，不作为默认变量读取或高速采样主路径。 | capabilities 标记 RTT optional；默认 workflow 不要求 RTT。 | `P03` |
| `REQ-RTT-002` | 第一版不得要求目标工程新增 RTT 代码。 | 无 RTT 的 fixture 仍可完成核心读取/采样流程。 | `P09` |
| `REQ-RTT-003` | Direct RTT Channel 只能标记为 optional/experimental，不进入冻结主线承诺。 | 公共 tool catalog 明确 experimental 或默认隐藏。 | `P03` |
| `REQ-RTT-004` | TraceAgent 必须从 v0.2.1 主线公共工具、prompts 和 workflow 中删除或隐藏。 | 公共 catalog/server source 不注册 TraceAgent 主线工具。 | `P03` |

## 15. SVD 功能

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-SVD-001` | 必须提供 `svd_load`、`svd_list_peripherals` 和 `svd_list_registers`。 | CMSIS-SVD fixture 可加载并稳定列出 peripheral/register。 | `P06` |
| `REQ-SVD-002` | 必须提供 `svd_read_register`、`svd_read_field` 和 `svd_decode_register`。 | 模拟 memory backend 的 register/field 值与解码结果正确。 | `P06` |
| `REQ-SVD-003` | 必须提供 `svd_write_field_plan`、`svd_write_field_execute` 和 `svd_write_field_readback`。 | 允许 field 通过 plan/execute/readback；plan 与 execute 绑定。 | `P06` |
| `REQ-SVD-004` | SVD 写默认只允许 field-level，register-level 默认禁止。 | 公共 execute schema 不提供任意 register value 写，或将其归入 R4 raw。 | `P06` |
| `REQ-SVD-005` | reserved bit 和 unknown register/field 写必须归为 R5 并禁止。 | reserved/unknown fixture 无法通过 plan 或 policy override。 | `P06` |
| `REQ-SVD-006` | W1C、W0C 和 toggle field 必须由 SVD 或显式 policy 识别并使用正确写入算法；未知语义不得猜测。 | special-access fixture 的 write mask/值正确；缺语义时拒绝。 | `P06` |
| `REQ-SVD-007` | clock、reset、watchdog、flash、security 等关键外设 field 必须默认分类为 R4 或 R5。 | 风险分类测试覆盖名称/地址/显式 policy；不得降为 R3。 | `P06` |
| `REQ-SVD-008` | 明确 GPIO 输出电平 field 写必须分类为 R3，并要求 operationPlan、audit 和 readback。 | GPIO output fixture 计划为 R3，缺 plan 时拒绝。 | `P06` |

## 16. Flash 能力

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-FLASH-001` | flash verify 必须作为只读/校验能力允许 Agent 自动执行。 | verify 不擦写、不 reset（除非明确协议要求并报告），结果含 artifact hash 和匹配状态。 | `P07` |
| `REQ-FLASH-002` | flash write 必须分类为 R4，执行需人工 approval receipt。 | 无有效 receipt 时不调用烧录命令；dryRun 可生成计划。 | `P07` |
| `REQ-FLASH-003` | erase 必须分类为 R4，并默认隐藏或要求强确认。 | catalog 标记 destructive；无 receipt 永不执行。 | `P07` |
| `REQ-FLASH-004` | `.hex`、`.bin`、`.srec`/`.s19` 可用于 verify/write，但不得进入变量 resolver。 | Flash artifact probe 接受支持格式并记录 base address/format；symbol resolver 拒绝。 | `P07` |

## 17. CPU 控制

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-CPU-001` | 第一版必须支持 halt、resume、step 和 reset。 | 模拟 backend 和经授权硬件路径返回 before/after state。 | `P07` |
| `REQ-CPU-002` | 普通 halt/resume/step/reset 为 R3，Agent 可自主判断执行，不要求每次人工确认。 | 风险元数据为 R3，execute 依赖 operationPlan/audit 而非用户布尔确认。 | `P07` |
| `REQ-CPU-003` | 每个实际 CPU 控制必须绑定 operationPlan、记录 audit，并验证执行后状态。 | 错 target/过期/重放 plan 拒绝；成功与失败均有 audit。 | `P07` |
| `REQ-CPU-004` | halt/step/reset 在活跃 HSS capture 中不得作为普通 R3 直接执行；resume 仅在明确安全路径中执行并报告连续性影响。 | active capture 冲突测试不破坏 capture；复合 reset 遵循 REQ-HSSW-006。 | `P07` |
| `REQ-CPU-005` | reset 与 flash/raw 组合操作必须升级为 R4。 | 组合 plan 风险为 R4，需人工 receipt。 | `P07` |

## 18. Raw GDB / Raw Probe Command

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-RAW-001` | 必须使用 `raw_command_plan` 与 `raw_command_execute` 分离计划和执行。 | execute 不接受未计划的任意命令。 | `P07` |
| `REQ-RAW-002` | raw GDB/raw probe execute 必须分类为 R4 并要求人工 approval receipt。 | 无 receipt 或 receipt 不匹配时命令未发送到 backend。 | `P07` |
| `REQ-RAW-003` | raw plan 必须说明使用原因、预期影响、目标状态变化、可恢复性和后续验证步骤。 | 缺少任一说明字段的 plan 不可执行。 | `P07` |
| `REQ-RAW-004` | 活跃 HSS capture 中不得执行 raw command。 | active capture 冲突返回拒绝且 command backend 未调用。 | `P07` |

## 19. 采样数据格式

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-CAP-001` | 采样主格式必须为分段 `.capture.bin` 数据和 `.capture.json` metadata（物理文件名可为 `capture_0001.bin` 等）。 | capture metadata 能唯一列出所有二进制段；不依赖 JCAP/SQLite。 | `P05` |
| `REQ-CAP-002` | CSV 和 JSONL 只能作为辅助导出格式。 | 导出不替代原始 capture/metadata，且记录源 capture hash。 | `P05` |
| `REQ-CAP-003` | 第一版 capture 二进制不得压缩。 | metadata compression 标记为 none，读取无需压缩库。 | `P05` |
| `REQ-CAP-004` | 默认 segmentSize 必须为 64 MB，可配置范围 16–512 MB。 | 边界值通过；低于 16 或高于 512 被拒绝。 | `P05` |
| `REQ-CAP-005` | 每个 sample 必须包含 sampleIndex、timestampTicks、statusFlags 和 values[]。 | 编码/解码 golden test 字节级一致，并验证单调 index/time。 | `P05` |
| `REQ-CAP-006` | statusFlags 必须支持 valid、read_error、timeout、overflow、dropped_before_this_sample、target_halted、write_nearby、write_in_progress、backend_busy。 | 每个 flag 有固定 bit、编码/解码测试和查询过滤行为。 | `P05` |
| `REQ-CAP-007` | Agent 必须通过 capture index/metadata 查询数据，不得猜测 segment 文件名或直接解析 raw BIN。 | resources/workflows 只引导 list/summary/query/export；query 验证 segment 路径和 CRC。 | `P05` |

## 20. 分段采样

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-SEG-001` | capture 必须按配置文件大小自动生成 `capture_0001.bin`、`capture_0002.bin` 等连续分段。 | 使用小测试阈值触发至少三段，sampleIndex 无重叠/缺口且各段不超过允许边界。 | `P05` |
| `REQ-SEG-002` | capture.json 必须包含 captureId、backend、symbols、sampling、segment list、每段 CRC、sampleStart、sampleCount 和 quality summary。 | metadata schema 校验通过；篡改段内容时 query 检测 CRC mismatch。 | `P05` |

## 21. 审计日志

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-AUD-001` | 审计必须通过异步、非阻塞队列追加 JSONL，不能阻塞主要调试/采样路径。 | 压力测试下操作延迟不等待磁盘逐条 fsync；队列失败产生 warning 而不伪造成功。 | `P01` |
| `REQ-AUD-002` | 每个 session 必须在 `<projectRoot>/.jlink-mcp/audit/<session>/audit.jsonl` 维护审计。 | 不同 session 记录隔离且路径受 cwd 防逃逸保护。 | `P01` |
| `REQ-AUD-003` | 必须提供有界 audit query 和 summary。 | 可按 operation/risk/ok/time range 查询，并返回计数汇总。 | `P01` |
| `REQ-AUD-004` | audit 必须覆盖 variable/SVD write、CPU control、flash、erase、raw、policy change、backend fallback 和 capture start/stop。 | 每种操作至少一个成功/拒绝/失败 fixture 记录，包含 plan/risk/result。 | `P07` |

## 22. Session 管理

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-SES-001` | Agent 可以传 sessionName。 | 合法名称保留语义并经过路径安全规范化。 | `P01` |
| `REQ-SES-002` | 未传 sessionName 时必须生成 `YYYYMMDD_HHMMSS_<short-task-name>` 形式的唯一名称。 | 固定时钟测试验证格式和碰撞处理。 | `P01` |
| `REQ-SES-003` | session 创建不得要求用户确认。 | R0 session init 自动完成且不触碰硬件。 | `P01` |
| `REQ-SES-004` | session metadata 必须保存在 `<projectRoot>/.jlink-mcp/sessions/` 下。 | session 文件路径位于 cwd 内并可恢复读取。 | `P01` |

## 23. Agent 能力发现

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-DISC-001` | AGENTS.md 只保留最小入口和安全原则，不复制完整 MCP 手册。 | AGENTS 指向 mcu_capabilities/workflow resources，内容保持精简。 | `P08` |
| `REQ-DISC-002` | 必须提供 mcu_capabilities、mcu_tool_catalog、mcu_backend_status 和 mcu_risk_policy。 | 四个工具在 Codex、Claude/OpenCode MCP inspection 中可发现，输出一致。 | `P08` |
| `REQ-DISC-003` | MCP 必须提供按任务组织的 resources、prompts 和 workflow playbook。 | 至少覆盖只读调试、变量写、HSS 激励采样、SVD、Flash verify 和 R4 流程。 | `P08` |
| `REQ-DISC-004` | server instructions 必须明确建议 Agent 先调用 mcu_capabilities，再读取对应 workflow。 | 三个客户端接入测试中模型能发现首步和风险边界。 | `P08` |

## 24. 返回格式

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-ENV-001` | 所有核心工具必须返回统一 JSON envelope，至少包含 ok、operation、data、risk、backend、artifacts、warnings 和 message。 | 所有核心 tool output schema 通过统一 contract test。 | `P01` |
| `REQ-ENV-002` | envelope 必须用 backend.selected、fallbackFrom 和 reason 说明实际后端及降级原因。 | HSS/BMA/RSP/RTT 各路由场景返回一致字段。 | `P03` |
| `REQ-ENV-003` | 核心工具必须提供 outputSchema/structuredContent；为兼容旧客户端，可同时返回相同 JSON 的 TextContent，业务失败设置 isError。 | MCP inspector/客户端 contract test 验证 structuredContent 与 text JSON 一致。 | `P01` |

## 25. 第一版明确不做

| Requirement ID | 规范要求 | 验收条件 | Owner Phase |
|---|---|---|---|
| `REQ-OOS-001` | 多核、多镜像和复杂项目根识别不得进入第一版。 | 公共 catalog、schemas、prompts 和生产默认路径不暴露该能力；存在的实验代码被隔离或删除。 | `P09` |
| `REQ-OOS-002` | GCC map parser 不得作为 v0.2.1 必需能力；GCC/IAR ELF 仍按内容支持。 | 公共 catalog、schemas、prompts 和生产默认路径不暴露该能力；存在的实验代码被隔离或删除。 | `P09` |
| `REQ-OOS-003` | 远程 Agent、远程硬件和复杂多探针调度不得进入第一版。 | 公共 catalog、schemas、prompts 和生产默认路径不暴露该能力；存在的实验代码被隔离或删除。 | `P09` |
| `REQ-OOS-004` | TraceAgent、Runtime Evidence、CodeGraph Bridge 和离线实验诊断不得进入主线。 | 公共 catalog、schemas、prompts 和生产默认路径不暴露该能力；存在的实验代码被隔离或删除。 | `P09` |
| `REQ-OOS-005` | 采样压缩、JCAP/SQLite 和离线 UI 不得进入冻结实现。 | 公共 catalog、schemas、prompts 和生产默认路径不暴露该能力；存在的实验代码被隔离或删除。 | `P09` |
| `REQ-OOS-006` | 多组/多频率 HSS 并行采样不得进入第一版。 | 公共 catalog、schemas、prompts 和生产默认路径不暴露该能力；存在的实验代码被隔离或删除。 | `P09` |
| `REQ-OOS-007` | 任意地址默认写、SVD register-level 默认写和 MCU 端代码修改依赖不得进入第一版。 | 公共 catalog、schemas、prompts 和生产默认路径不暴露该能力；存在的实验代码被隔离或删除。 | `P09` |
| `REQ-OOS-008` | HSS 运行中的复杂事务写入不得进入第一版。 | 公共 catalog、schemas、prompts 和生产默认路径不暴露该能力；存在的实验代码被隔离或删除。 | `P09` |

## 26. 验收规则

### 26.1 通用验收

1. 每个 Requirement ID 必须在 `requirement-traceability.json` 中具备 owner phase、计划测试、代码映射、证据和最终状态。
2. 任何阶段不得以“现有代码已经支持”为理由跳过可执行测试或证据。
3. 任何无法实际观察的 Token、宿主模型生效参数、硬件结果均必须标记为 `unavailable`、`not_run` 或 `blocked`，不得估算或补写。
4. 所有改变 target 状态的硬件操作必须记录 risk、plan、audit、执行结果和恢复/验证状态。
5. 项目专用 semantic profile 与通用 transport/data-quality 判定分离。

### 26.2 P00 验收

- 不修改运行时代码和目标工程源码。
- 完成 144 条 Requirement 的 Spec → phase → planned test 映射。
- 完成当前 tools/resources/prompts 的 keep/refactor/hide/remove/test-only inventory。
- 记录 Git baseline、Node/npm/J-Link/fixture/artifact 身份。
- 仅允许 R0/R1 只读硬件测试；R2 以上一律不得执行。
- `phase-result.json` 和 `pro-review-result.json` 通过各自 JSON Schema。

### 26.3 主要硬件 fixture 的后续阶段验收目标

| 能力 | 最低证据 |
|---|---|
| J-Link identity | 记录 V8.84 实际安装/DLL 版本、DLL SHA-256、probe model/serial、interface、speed、targetId 来源。 |
| HSS 1 kHz read-only | 1000 Hz、3 s；`actualRateHz` 在 950–1050；`validSamples >= 2850`；readErrors/timeouts/overflows/droppedSamples 均为 0。项目语义失败不得覆盖 transport 结果。 |
| Background Memory | 读取至少一个安全变量；失败注入时 `haltIssued=false` 且返回 fallback reason。 |
| RSP fallback | 小范围内存/少量变量读取正确，backend 选择原因可追踪。 |
| R2 variable write | 仅使用 policy 明确允许的非执行器 RAM 变量，完成 old→new→readback→restore→readback，`restored=true`。未找到安全变量则标记 not_run，不得猜测。 |
| HSS capture-time write | 1 kHz capture 中写入可串行执行，readback 匹配，event 与 sample window 可查询，capture 继续并保持质量证据。 |
| SVD | 完成 load/list/read/decode；write dry-run 覆盖；真实 R3 field 写仅在明确安全 fixture/policy 下执行。 |
| Flash | verify 可自动执行；write/erase 只有执行时获得新的 R4 receipt 才允许。没有确认时应通过拒绝路径验收，不得声称已实烧。 |

### 26.4 通用性 release gate

- 生产代码不得含 HM_C095/FOC_SCM/g_hssDbg/Z20K146M 的默认选择或业务语义。
- 第二个非 HM_C095 fixture 必须通过 artifact/catalog/path/envelope/风险治理合同。
- Codex、Claude 和 OpenCode 接入后均能发现 `mcu_capabilities`、tool catalog、risk policy 和 workflow。

## 27. 变更控制

冻结后仅允许两种修改：

1. **Clarification**：不改变能力范围、风险等级或 exit criteria；记录 revision 与 reason。
2. **Approved change**：改变 hard goal/constraint/exit criterion，必须有用户显式批准并更新 traceability、阶段计划和 Review 基线。

任何旧 OpenSpec、现有代码或历史硬件证据与本文件冲突时，以本文件为准。

