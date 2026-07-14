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
