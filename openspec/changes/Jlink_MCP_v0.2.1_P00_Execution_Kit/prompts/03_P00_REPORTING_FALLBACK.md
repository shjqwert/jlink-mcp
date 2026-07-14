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
