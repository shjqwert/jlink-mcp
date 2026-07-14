# Jlink_MCP v0.2.1 P00 Execution Kit

## 从这里开始

本包用于把已确认的规划落到 Jlink_MCP Git 仓库与 Codex/Orchestrator 工作流。核心内容：

- Frozen Spec Rev1：144 个 Requirement ID、验收条件和边界澄清；
- machine-readable requirement traceability；
- J-Link V8.84 + HM_C095 hardware environment；
- P00 Goal Contract 和已通过 Orchestrator Runtime 格式校验的 Task Wave；
- phase/pro-review/traceability/environment/test JSON Schema 与模板；
- Codex、GPT-5.6 Pro、Correction、通用阶段和 R4 提示词；
- PowerShell 安装/结构校验脚本；
- 单文件 `MASTER_RUNBOOK.md`。

## 最短操作

```powershell
$RepoRoot    = "D:\AI_Project\Trunk\Jlink_mcp"
$FixtureRoot = "D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config"
$KitRoot     = "<解压目录>\Jlink_MCP_v0.2.1_P00_Execution_Kit"

git -C $RepoRoot switch -c phase/P00-spec-baseline

& "$KitRoot\scripts\Install-P00Kit.ps1" `
  -RepoRoot $RepoRoot `
  -FixtureRoot $FixtureRoot

& "$KitRoot\scripts\Validate-P00Kit.ps1" -RepoRoot $RepoRoot
```

检查并提交治理 baseline，然后在 Codex 中粘贴：

```text
docs/project-prompts/v0.2.1/00_START_P00_ORCHESTRATOR.md
```

P00 完成并提交后，在 GPT-5.6 Pro 中粘贴：

```text
docs/project-prompts/v0.2.1/04_GPT56PRO_P00_REVIEW.md
```

只有 `decision=accepted` 才进入 P01。

- 详细操作：`OPERATIONS_GUIDE.md`
- 单文件完整说明：`MASTER_RUNBOOK.md`
- 校验说明：`VALIDATION_REPORT.md`
