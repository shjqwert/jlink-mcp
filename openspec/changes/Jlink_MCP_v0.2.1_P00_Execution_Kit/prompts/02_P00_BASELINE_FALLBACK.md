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
