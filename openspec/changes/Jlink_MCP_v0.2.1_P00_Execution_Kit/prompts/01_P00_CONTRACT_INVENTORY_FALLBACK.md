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
