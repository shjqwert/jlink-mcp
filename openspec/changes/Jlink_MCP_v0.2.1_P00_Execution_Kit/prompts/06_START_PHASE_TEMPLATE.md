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
