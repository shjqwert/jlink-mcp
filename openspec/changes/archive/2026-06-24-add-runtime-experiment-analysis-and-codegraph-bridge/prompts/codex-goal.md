@ponytail /goal 在 D:\AI_Project\Trunk\Jlink_mcp 中实现 OpenSpec 变更 add-runtime-experiment-analysis-and-codegraph-bridge：为 Jlink-MCP 添加通用运行态实验分析层和 CodeGraph 友好的 Runtime Evidence 桥接能力。核心目标是让 Agent 能把 Jlink-MCP 的运行态证据与 CodeGraph MCP 的静态代码理解结合起来定位问题；Jlink-MCP 本身不得变成电机专用工具，也不得重复实现 CodeGraph。

First action:
1. 确认仓库根目录为 D:\AI_Project\Trunk\Jlink_mcp。
2. 逐字读取：
   - AGENTS.md
   - package.json
   - README.md
   - 现有 capture 相关实现文件
   - 现有 openspec/changes/add-jlink-sdk-capture 下的 proposal/design/tasks/spec
   - 新增 openspec/changes/add-runtime-experiment-analysis-and-codegraph-bridge 下的 proposal/design/tasks/spec
3. 报告：
   - 当前 git status
   - 新 change 的任务数
   - 两个新 capability spec 的 SHALL 数和 Scenario 数
   - openspec strict 校验结果
   - baseline：npm run lint、npm run build、npm run test、npm run test:capture-ipc、npm run test:elf 的结果
4. 等我确认后再实施 Phase 1；不要直接开始改代码。

Scope:
- OpenSpec change:
  - openspec/changes/add-runtime-experiment-analysis-and-codegraph-bridge/
- TypeScript runtime analysis layer:
  - src/mcp
  - src/mcp/analysis 或等价目录
  - src/utils 中必要的纯工具函数
- Tests:
  - 现有 Node test runner
  - synthetic fixtures
  - golden assertions
- Documentation:
  - README 或 docs 中最小必要说明
- 不修改 out/
- 不修改 D:\FOC_Project 或任何嵌入式固件源码
- 不修改与本 change 无关的探针后端、flash、RTT、VS Code 命令

Architecture requirements:
- Jlink-MCP 负责 runtime world：
  - signals
  - captures
  - experiments
  - runtime events
  - generic analysis
  - runtime evidence
  - codegraph query suggestions
- CodeGraph MCP 负责 static world：
  - symbols
  - writers/readers
  - call graph
  - dependencies
- Agent 负责两者编排。
- Jlink-MCP 不得直接调用 CodeGraph MCP，不得引入 CodeGraph runtime dependency。

Required MVP tools:
- analysis_profiles
- experiment_analyze
- experiment_compare
- evidence_for_codegraph

Optional tool after MVP:
- experiment_run

Do not implement experiment_run until:
- contracts are complete
- generic analysis tests pass
- Runtime Evidence tests pass
- evidence_for_codegraph tests pass
- I explicitly approve starting the optional orchestration phase

Functional requirements:
1. Add generic SignalDefinition with role-based semantics:
   - command
   - feedback
   - error
   - state
   - fault
   - limit
   - counter
   - timestamp
   - event
   - raw
   - derived
2. Add ExperimentRecord that can represent:
   - saved capture
   - imported data
   - fixture
   - synthetic data
3. Add generic_control analysis profile:
   - step_response
   - overshoot
   - settling_time
   - steady_error
   - saturation
4. Add generic_state_machine analysis profile:
   - state_transition
   - fault_transition
   - stuck_signal
   - counter_stall
   - counter_wrap
5. Motor profiles are optional plugins/profiles only:
   - motor_bldc
   - motor_foc
   They must not be required by generic analysis.
6. Add RuntimeEvidence with:
   - evidenceId
   - experimentId
   - summary
   - severity
   - timeWindowMs
   - signals
   - patterns
   - codeHints
   - questionsForCodeGraph
   - artifact references
7. Add evidence_for_codegraph that only generates CodeGraph-friendly query suggestions. It must not call CodeGraph.

Safety and side-effect constraints:
- analysis_profiles, experiment_analyze, experiment_compare, evidence_for_codegraph are read-only.
- These tools must not:
  - connect to hardware
  - start or stop GDB Server
  - start or stop capture
  - write memory
  - halt/resume/reset/flash the target
  - run motor control actions
  - call CodeGraph MCP
- Do not weaken existing capture/control safety rules.
- Do not claim 1 kHz strict support or J-Scope-equivalent performance for the RSP backend.
- Do not use private J-Link SDK/DLL APIs.
- Do not add dependencies unless you first explain necessity and wait for approval.

Implementation phases:
Phase 0 — Spec gate:
- Add/validate the OpenSpec change only.
- Stop and report to me for web GPT review.

Phase 1 — Contracts and fixtures:
- Implement data contracts, validators, and synthetic fixture loading.
- Add tests.
- Stop and report changed files and test outputs.

Phase 2 — Generic analysis:
- Implement generic_control and generic_state_machine.
- Add deterministic golden tests.
- Stop and report fixture outputs and test outputs.

Phase 3 — MCP tools:
- Register analysis_profiles, experiment_analyze, experiment_compare, evidence_for_codegraph.
- Add MCP-level input/output tests.
- Stop and report examples and test outputs.

Phase 4 — CodeGraph bridge:
- Generate RuntimeEvidence and CodeGraph query suggestions.
- Prove there is no CodeGraph import or nested MCP call.
- Stop and report evidence samples.

Phase 5 — Optional experiment_run:
- Do not start unless I explicitly approve.
- Reuse existing capture/control allowlist logic.
- Require allowControls=true for control actions.
- Record every action/event/failure/safety decision.
- Add mock tests before any hardware test.

Done when:
- openspec validate add-runtime-experiment-analysis-and-codegraph-bridge --type change --strict exits 0.
- npm run lint exits 0.
- npm run build exits 0.
- npm run test exits 0.
- npm run test:capture-ipc exits 0.
- npm run test:elf exits 0.
- All MVP tools have tests and example outputs.
- Generic profiles work on non-motor fixtures.
- Runtime Evidence includes CodeGraph-friendly hints.
- No CodeGraph runtime dependency is introduced.
- No hardware side effects occur in read-only tools.
- Final report lists modified files, validation commands, deferred tasks, and remaining risks.

Stop if:
- Repository root is not D:\AI_Project\Trunk\Jlink_mcp.
- AGENTS.md conflicts with this goal.
- OpenSpec strict validation fails and cannot be fixed without changing the intended scope.
- You need to modify embedded firmware source.
- You need to add dependencies without approval.
- Any existing test fails before implementation.
- You need to weaken, skip, or delete existing tests.
- You need to start hardware, control a motor, reset, flash, halt, resume, or write memory for MVP phases.
- You find yourself implementing a CodeGraph replacement inside Jlink-MCP.
- You find motor-specific assumptions leaking into generic profiles.

At every phase boundary:
- Stop.
- Provide:
  - git status --short
  - changed files
  - completed tasks
  - commands run with exit codes
  - representative tool output or fixture output
  - risks or blocked items
- Wait for my confirmation before continuing.
