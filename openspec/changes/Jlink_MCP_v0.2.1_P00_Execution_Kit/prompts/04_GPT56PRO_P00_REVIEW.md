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
