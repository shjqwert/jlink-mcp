# Jlink_MCP v0.2.1 开发、测试与阶段验收计划

- **文档版本**：1.1
- **修订日期**：2026-07-14
- **功能规格**：`Jlink_MCP v0.2.1 Functional Specification, Revision 1, Frozen`
- **修订性质**：P00 治理增强；不改变功能阶段范围

## Rev1 P00 增强

1. Frozen Spec 已加入 144 个稳定 Requirement ID。
2. P00 必须维护：
   - `reports/governance/requirement-traceability.json`
   - `reports/environment/hardware-environment.json`
3. P00 base commit 应先包含 Frozen Spec、Schema、模板和 prompts；P00 result commit 再包含 inventory/baseline evidence。
4. 只有 GPT-5.6 Pro 的 `accepted` decision 才可进入 P01。
5. HM_C095/J-Link V8.84 是主要硬件 fixture，不是生产默认。
6. P00 只允许 R0/R1；不允许任何目标状态改变。

---

## 1. 决策结论

### 1.1 是否使用 `project-orchestrator`

**结论：开发执行阶段采用；本次规划阶段不启动。**

采用原因：

1. 项目跨越 MCP 公共合同、J-Link 原生接口、二进制采样格式、风险审批、SVD、Flash、Agent 接入与真实硬件验收，属于长周期、多模块、强证据项目；
2. 用户会按阶段上传 Git 结果，要求 GPT-5.6 Pro 做计时纠正和验收，正好需要稳定的阶段合同、任务指纹、Handoff、测试范围与阶段 barrier；
3. R2/R3/R4 操作涉及真实设备状态，必须把实现、验证、定向安全 Review 和硬件证据分离；
4. Skill 能记录 elapsed time、派发次数、纠偏次数、模型分布与证据摘要，并明确禁止伪造不可观测 Token 数据。

使用边界：

- Orchestrator 的 `project-root/worktree` 必须是 **Jlink_MCP Git 仓库**；
- MCU 目标工程只是 **运行时 cwd 和硬件验收夹具**，不要求它使用 Git，也不得作为 Orchestrator 的开发 worktree；
- MCP 产品运行时仍严格遵守 `projectRoot = process.cwd()`、不依赖 Git；
- 每个阶段开始前由用户显式发送：`使用 $project-orchestrator 启动 Pxx`；
- Orchestrator 不自动提交、合并、发布或执行硬件动作。当前用户请求可作为 R0/R1 及限定 R2/R3 测试的阶段授权来源，但 R4 仍需执行时单独确认。

### 1.2 是否使用 `refactor-jlink-hss-jcap-offline-analysis`

**结论：不作为 Skill、活动规格或执行工作流；只作为“已被冻结规格取代的参考资料”。**

不能直接采用的原因：

- 其主存储是 `.jcap/capture.db/SQLite`，冻结规格要求 `.capture.bin + .capture.json`；
- 其范围包含离线分析 UI、Runtime Evidence、CodeGraph Bridge、复杂分析链路，冻结规格明确不做；
- 其 SVD 被延后，而冻结规格第一版必须实现 SVD；
- 其数组写入、Hot Variables、replacement-first 大删除等内容会扩大或改变冻结边界；
- 它会删除/弱化冻结规格仍要求的 Background Memory、RSP fallback 等通用读取路径。

可抽取的内容仅限：

- HSS DLL/runtime identity 的验证思路；
- Artifact/Symbol Catalog 的候选消歧与 generation/hash 思路；
- 风险、policy、audit、operation-plan 绑定思路；
- Agent tool discovery 与结构化验收思路；
- HSS capture-time write 的队列、event、quality flag 测试用例。

任何抽取项必须重新映射到 v0.2.1 requirement ID，不得继续引用旧 OpenSpec 作为权威输入。

## 2. 权威输入优先级

发生冲突时按下列顺序处理：

1. **Jlink_MCP v0.2.1 功能冻结清单**；
2. 用户显式批准的阶段合同修订；
3. 已通过阶段验收的公共合同与迁移决定；
4. 当前仓库代码、测试和真实硬件证据；
5. 两个上传 workflow/旧 OpenSpec 中可复用但非权威的设计资料。

HM_C095、`FOC_SCM.*`、`Z20K146M`、本机绝对路径和当前 J-Link 序列号只能出现在：

- 测试夹具；
- 硬件证据；
- 示例配置；
- 明确标注为 target-specific 的验收脚本。

它们不得成为生产模块默认值、工具输入默认值、Artifact 猜测规则或通用语义判断。

## 3. 当前仓库判断

### 3.1 可直接保留并演进的基础

| 能力 | 当前状态 | 处理方式 |
|---|---|---|
| cwd 与 `.jlink-mcp` 路径防逃逸 | 已有较好基础 | 提升到通用 kernel，补 symlink/TOCTOU/Windows 路径测试 |
| HSS native helper 与 V8.84 适配 | 已有真实 1 kHz 证据 | 保留 helper，去除 target-specific 默认和强耦合语义 |
| HSS capture-time write 队列 | 已有 plan/readback/event/flags | 迁入统一 hardware queue 与 policy/risk engine |
| HSS capture metadata/CRC/query/export | 部分具备 | 改成真正多段、通用 metadata、冻结格式 |
| 变量写 policy 子集 | 已有 R2/R3、范围和计数基础 | 收敛为冻结 schema；禁用首版数组写；加入 SVD 与风险覆盖 |
| HSS audit 记录 | 已有 append JSONL | 改成非阻塞队列、全工具覆盖、查询和汇总 |
| target 配置扫描 | 支持 `.ewp/.jlink` | 保留“唯一确定或结构化报错”，不允许目录名猜测 |

### 3.2 必须修正的主要缺口

| 缺口 | 影响 |
|---|---|
| `FOC_SCM.out/.map` 与 HM_C095 变量默认值硬编码 | 违反通用 MCP 定位，是最高优先级去耦项 |
| 尚无真正 ELF/DWARF + IAR map 通用 Symbol Catalog | 无法可靠支持 static 与 struct fixed member |
| 旧 `write_memory/flash/erase/gdb_command/probe_command` 等工具绕过统一风险合同 | R4/R5 安全边界不成立 |
| 统一 envelope 只覆盖 HSS 子集 | Agent 无法稳定解析全部工具结果 |
| policy 只覆盖 HSS 写入，且含首版不要求的数组写 | 与冻结 scope 不一致 |
| Background Memory / Live Watch 与 RSP 路由未形成统一读取服务 | 变量读取主路径缺失 |
| SVD 工具链缺失 | 冻结功能未实现 |
| capture 实际只形成单段 `capture_0001.bin` | 未实现按大小分段 |
| audit 尚非独立异步队列，且没有 query/summary | 审计闭环不完整 |
| `mcu_capabilities` 等发现工具、server instructions、workflow resources 缺失 | Codex/Claude/OpenCode 无法自然掌握用法 |
| `.mcp.json` 含他人绝对路径和固定设备 | 不可移植 |
| CI 只覆盖部分 HSS 测试 | 无法作为完整冻结版 release gate |

## 4. 冻结版硬目标与硬约束

### 4.1 Hard Goals

1. 完成 v0.2.1 所有第一版功能，并逐条建立 requirement → code → test → evidence 映射；
2. 交付一个以本地 J-Link 为核心、对任意符合支持边界的 MCU 工程可复用的 MCP，而不是 HM_C095 专用脚本集合；
3. 让 Codex、Claude Code/Claude Desktop、OpenCode 在连接后能够先发现能力、再选择正确 workflow，并理解风险与审批要求；
4. 对变量读写、HSS、SVD、Flash、CPU、Raw、审计和 capture artifact 提供稳定、可验证、可追溯的 JSON 合同；
5. 使用 J-Link V8.84 和指定目标工程完成真实硬件回归，同时通过第二个非 HM_C095 fixture 证明通用性。

### 4.2 Hard Constraints

1. MCP 运行时 `projectRoot = process.cwd()`，不调用 Git 判断根目录，不要求工具参数传 `projectRoot`；
2. 仅允许在 cwd 下读写 MCP artifact，所有输出位于 `.jlink-mcp/` 或经验证的 cwd 内子目录；
3. 不自动修改、构建或烧录目标工程源码；测试默认只在目标根增加 `.jlink-mcp/`；
4. 不根据工程目录名、历史变量名或当前 ECU 推测 target、artifact、变量地址、类型或安全性；
5. R2 必须 policy allowlist + RAM 校验 + readback；R3 必须 operationPlan + audit；R4 必须可信人工审批；R5 永久拒绝；
6. 不以 `approved: true` 之类裸布尔值作为 R4 人工批准；审批凭据必须绑定 plan digest、target、artifact、policy、TTL 和单次执行；
7. Background Memory 失败不得自动 halt；HSS 运行中不得执行 flash/erase/raw/reset/halt/step；
8. 第一版不实现离线诊断、UI、Runtime Evidence、CodeGraph Bridge、JCAP/SQLite、压缩、多核、多镜像、多组并行 HSS、复杂事务写入；
9. 第一版公共变量写仅支持 scalar 与 struct fixed member；已有 array 代码只能被禁用/隔离，不能出现在冻结公共 catalog；
10. 所有关键工具提供 JSON Schema input/output、`structuredContent` 和兼容 TextContent；业务执行错误返回统一 envelope 并设置 MCP `isError`。

## 5. 目标架构

建议按能力内聚拆分，而不是继续扩展单体 `server.ts`：

```text
src/mcp/
  kernel/
    project-context.ts      # cwd、路径、目录、host root 校验
    envelope.ts             # 全工具统一输出
    tool-registry.ts        # 名称、风险、dryRun、outputSchema、annotations
    session-manager.ts      # sessionName、生命周期、计数
    risk-engine.ts          # R0..R5 分类与覆盖
    policy-store.ts         # policy schema、hash、reload、校验
    approval-provider.ts    # R4 host/local provider 抽象
    operation-plan.ts       # digest、TTL、single-use、binding
    audit-queue.ts          # 非阻塞 JSONL、query、summary
    hardware-queue.ts       # probe ownership、capture child operations
  artifacts/
    artifact-probe.ts
    elf-symbols.ts
    dwarf-types.ts
    iar-map.ts
    source-hints.ts         # 只作候选/类型提示，绝非地址权威
    symbol-catalog.ts
  variables/
    variable-resolver.ts
    variable-read.ts
    variable-write.ts
    live-watch.ts
  backends/
    jlink/
      identity.ts
      background-memory.ts
      rsp-memory.ts
      hss/
      flash.ts
      cpu.ts
      raw.ts
    rtt/                    # optional/experimental
  capture/
    binary-format.ts
    segment-writer.ts
    metadata.ts
    index.ts
    query.ts
    export.ts
  svd/
    parser.ts
    catalog.ts
    semantics.ts
    read.ts
    write.ts
  discovery/
    capabilities.ts
    tool-catalog.ts
    workflows.ts
    resources.ts
    prompts.ts
  server.ts                 # 只组装 registry/resources/prompts
native/
  hss-helper/
tests/
  unit/
  contract/
  integration/
  fixtures/
  hardware/
reports/
  phases/
```

### 5.1 公共合同原则

- 工具实现不得自行拼接不一致的 JSON；统一通过 `EnvelopeFactory`；
- `backend.selected/fallbackFrom/reason` 由 backend router 填充；
- plan/execute 的 execute 必须重新验证 target、artifact hash、symbol layout hash、policy hash、runtime identity、session、TTL；
- probe 访问只有一个所有者队列；HSS capture 拥有 probe 时，允许的变量写作为 capture 子操作串行执行；
- target-specific oracle（例如 HM_C095 ISR 16 kHz 语义）放在 `tests/hardware/profiles/`，不得影响通用 capture 成败；
- ScriptFile 与 runtime hash 可以保留为可选安全能力，但不得成为所有项目未在冻结规格中声明的硬编码必选项；若 target/policy 要求，则通过配置/能力结果明确报告。

## 6. 建议公共工具目录（P0 冻结最终名称）

下表是 P0 的起始候选。P0 可以在不改变语义的前提下调整命名，但一旦 P0 被接受，后续不得随意改名。

| 组 | 候选工具 |
|---|---|
| Discovery | `mcu_capabilities`, `mcu_tool_catalog`, `mcu_backend_status`, `mcu_risk_policy` |
| Artifact/Symbol | `artifact_probe`, `symbol_search`, `symbol_resolve` |
| Variable Read | `variable_read`, `live_watch_start`, `live_watch_status`, `live_watch_stop`, `memory_read` |
| Variable Write | `variable_write_plan`, `variable_write_execute` |
| HSS/Capture | `hss_capability_probe`, `hss_capture_plan`, `hss_capture_start`, `hss_capture_status`, `hss_capture_stop`, `capture_list`, `capture_get`, `capture_query`, `capture_export` |
| SVD | `svd_load`, `svd_list_peripherals`, `svd_list_registers`, `svd_read_register`, `svd_read_field`, `svd_decode_register`, `svd_write_field_plan`, `svd_write_field_execute`, `svd_write_field_readback` |
| Flash | `flash_verify`, `flash_write_plan`, `flash_write_execute`, `erase_plan`, `erase_execute` |
| CPU | `halt`, `resume`, `step`, `reset`（均支持 dryRun/operationPlan） |
| Raw | `raw_command_plan`, `raw_command_execute` |
| Audit | `audit_query`, `audit_summary` |

说明：RSP/BMA 是变量读取的 backend，不需要让 Agent 直接管理连接状态；RTT 作为 optional/experimental feature gate，不进入默认推荐 workflow。

## 7. 阶段计划

初始工时是**模型执行、编译、测试和证据整理的规划预算**，不是日历承诺；人类批准等待、设备占用和环境故障单列。每个普通 Orchestrator task 建议 30–60 分钟，阶段内滚动注册 1–3 个任务一波。

### P00 — 基线、合同与追踪矩阵（2–3 h）

**目标**：不改变产品行为，冻结权威边界和可复现基线。

交付：

- 记录 Git base commit、package/spec version、Node/npm/Windows 环境；
- 生成 v0.2.1 requirement ID 与 traceability matrix；
- 枚举现有所有 MCP tools/resources/prompts，标记 `keep/refactor/hide/remove/test-only`；
- 执行 clean install、compile、现有测试；
- 在 V8.84 上执行只读 capability/HSS baseline，记录 DLL、版本、模型、序列号、target、artifact hash；
- 建立本计划中的报告 Schema、模板和证据目录；
- 记录目标工程源码未修改、未构建、未 flash。

必测：

- `npm ci`、`npm run compile`、当前 HSS MVP-A/B/DLL suites；
- 当前 tool catalog snapshot；
- 只读 1 kHz HSS smoke（设备可用时）；
- `git diff --exit-code` 与目标源码 fingerprint 前后相同。

Exit Criteria：

- 冻结条目 100% 有 requirement ID 和计划阶段；
- 所有当前工具都被归类；
- 基线失败被明确记录，不能伪装成后续回归；
- `phase-result.json` 通过 Schema 验证；
- 无 R2+ 硬件动作。

### P01 — MCP Kernel、统一合同、Session/Policy/Audit（4–6 h）

**目标**：建立所有后续能力共享的安全与结构化内核。

交付：

- cwd project context 与完整路径防逃逸；
- 统一 envelope、error code namespace、`structuredContent`/TextContent；
- tool registry：risk、dryRun、backend、outputSchema、annotations；
- session manager 与默认命名；
- v0.2.1 policy schema：变量/SVD allowlist、riskOverrides、maxWrites、ranges、readback、burst；
- operation-plan binding 与 R4 approval provider 接口；
- 非阻塞 audit queue、flush、query、summary；
- 硬件 ownership queue；
- 将 legacy unsafe tools 默认隐藏或 feature-gate，禁止绕过 kernel。

必测：

- Windows path、relative/absolute、symlink/junction、case、UNC、`..`；
- policy valid/invalid、hash、reload、单变量 maxWrites 隔离；
- R0–R5 决策表；
- plan stale/replay/tamper/TTL/single-use；
- audit 并发、进程退出 flush、写失败降级；
- 所有已迁移工具 envelope contract snapshot。

Exit Criteria：

- 新工具无法绕过 risk/policy/audit/hardware queue；
- 任何 R4 execute 无可信 approval receipt 时稳定拒绝；
- R5 无配置可打开；
- 公共 schema 不含 `projectRoot` 输入。

### P02 — 通用 Artifact Probe 与 Symbol Catalog（6–10 h）

**目标**：删除 `FOC_SCM.*` 和 HM_C095 默认，建立可靠变量解析。

交付：

- cwd 内有界 Artifact 扫描与内容探测；
- ELF `.elf/.out/.axf` symbol table + DWARF type/member provider；
- IAR `.map` supplemental parser；
- source scan 只提供候选、声明位置和类型提示，地址必须来自 artifact/map；
- global scalar、static scalar（含编译单元限定）、struct fixed member；
- stable artifact generation、symbol layout hash、ambiguity diagnostics；
- `.hex/.bin/.srec` 明确排除变量解析；
- locals、pointer dereference、dynamic array、malloc、多核/多镜像拒绝。

必测：

- GCC ELF/DWARF fixture；
- IAR `.out + .map` fixture；
- 重名 static、匿名/嵌套 struct、padding、endianness；
- artifact 变化后旧 symbol handle 失效；
- map-only 缺类型时不按变量名猜类型；
- 指定目标工程中按查询发现变量，不传任何 HM_C095 默认变量名。

Exit Criteria：

- 生产代码静态扫描不含 `FOC_SCM`, `g_hssDbg`, `HM_C095`, `Z20K146M` 默认逻辑；
- target artifact 可按内容识别并输出可追溯 resolver；
- struct fixed member 地址和类型有权威证据。

### P03 — 变量读取、Background Memory/Live Watch、RSP fallback（4–7 h）

**目标**：形成低侵入通用读取主路径。

交付：

- `variable_read` 单次/小批量读取；
- Background Memory/Live Watch 周期读取；
- 运行态、halted 态读取行为；
- RSP small-memory fallback；
- backend router 与 `fallbackFrom/reason/suggestion`；
- BMA 失败时只建议 halt，绝不自动 halt；
- bounded `memory_read`，禁止任意大块或隐式写。

必测：

- fake BMA success/failure、RSP fallback、target halted；
- 类型解码、alignment、partial read、timeout；
- fallback 不改变 target 状态；
- V8.84 上读取由 P02 动态解析的若干变量。

Exit Criteria：

- Agent 能从统一返回中判断为何选择/回退 backend；
- read-only hardware evidence 显示 `targetWritten=false`, `resetIssued=false`, `haltIssued=false`（除非单独 R3 测试）。

### P04 — Policy 控制的变量写与 HSS 采样中写入（5–8 h）

**目标**：完成 scalar/struct member 的 R2/R3 写入闭环。

交付：

- `variable_write_plan → variable_write_execute`；
- RAM region、类型、范围、allowlist、per-variable maxWrites；
- old value、write、readback、mismatch/unknown-state；
- dryRun 不触碰硬件；
- 首版 array element/slice 从公共 catalog/schema 禁用；
- active HSS capture 子操作队列；
- capture event、sampleIndexNear、`write_nearby/write_in_progress/backend_busy`；
- 写失败也保留 metadata/audit；
- 可选 restore 步骤由测试明确执行并验证。

必测：

- allow/deny、range/type、Flash/peripheral/core region 拒绝；
- maxWrites 只拒绝该变量；
- stale plan、policy/artifact/layout/target mismatch；
- readback mismatch 与写后未知状态；
- capture ownership 并发；
- V8.84 上只对预先确认的非执行器 debug RAM 变量做有界写、readback、restore。

Exit Criteria：

- 无任意地址默认写入口；
- 每次真实写都有 plan、policy hash、old/new/readback、audit；
- HSS 连续性与事件窗口可查询。

### P05 — 通用 HSS、分段 Capture Store、查询导出（8–13 h）

**目标**：把现有 1 kHz HSS 成果变成通用、冻结格式的主路径。

交付：

- capability probe 报告 J-Link 软件/DLL版本、probe model/serial、HSS caps；
- generic capture plan：变量数、宽度、采样率、时长、容量限制与降级建议；
- 单组 capture 生命周期与 probe ownership；
- 真正按文件大小 rollover，默认 64 MB，16–512 MB；
- `capture_0001.bin...capture.json`、CRC、sampleStart/count、quality summary；
- 全量 statusFlags；
- capture index/list/get/query；
- CSV 与 JSONL 辅助导出；
- HM_C095 semantic oracle 移出生产 finalize 逻辑；
- abandoned session recovery 与损坏段检测。

必测：

- binary golden vectors、endianness、record version；
- 测试专用小阈值触发多段 rollover；
- CRC mismatch、truncated record、dropped/overflow/timeouts；
- capture event 跨段定位；
- capability 超限时返回减少变量/降采样/分轮建议；
- V8.84 1 kHz read-only 与 active-write 回归；
- 生产 capture 成败不依赖 HM_C095 专用 counter/pattern。

Exit Criteria：

- `capture.json` 足以定位全部段，Agent 不猜文件名；
- 1 kHz 目标回归达到已冻结质量门槛；
- 真实硬件结果与 transport、data quality、project-specific semantic oracle 分离。

### P06 — SVD 读取与安全 field 写（6–10 h）

**目标**：实现冻结 SVD 工具链和字段语义保护。

交付：

- 有界、禁外部实体的 SVD XML parser；
- peripheral/register/field catalog；
- load/list/read/decode；
- field-level plan/execute/readback；
- access、reserved、unknown、W1C/W0C/toggle、self-clearing 语义；
- GPIO output = R3；clock/reset/watchdog/flash/security 默认 R4/R5；
- register-level 默认写拒绝。

必测：

- synthetic SVD：derivedFrom、dim、overlap、reserved、写语义；
- read-only register hardware test；
- 对未明确 allowlist 的 field 写稳定拒绝；
- fake backend 执行所有 W1C/W0C/toggle 路径；
- 真实低风险 field 写仅在 bench/policy 明确允许时执行，否则只做 dryRun/rejection evidence。

Exit Criteria：

- reserved/unknown/R5 无可绕过路径；
- readback 策略能够区分普通、self-clearing、clear-on-write 等字段。

### P07 — CPU、Flash Verify/Write、Erase、Raw R4（7–11 h）

**目标**：完成受控目标状态改变与人工审批边界。

交付：

- halt/resume/step/reset 的 operationPlan、dryRun、audit、capture conflict；
- flash verify 自动执行；
- `.hex/.bin/.srec` 的 write plan/execute；
- erase plan/execute；
- raw command plan/execute，plan 必含理由、影响、可恢复性与验证步骤；
- R4 approval provider：host-native 或可信本地交互；receipt 绑定 digest/TTL/single-use；
- R5 命令和 option/security/reserved 区永久拒绝；
- approval secret/token 永不进入日志。

必测：

- CPU fake + 真实受控 R3；
- capture 中 halt/reset/step 拒绝或升级；
- flash verify 在目标上执行；
- R4 无审批、错误审批、过期、重放、tamper；
- R4 execute 使用 fake backend 做完整副作用验证；
- 真实 flash write/erase/raw 不属于默认自动验收，只能在用户对具体 plan 再确认后运行。

Exit Criteria：

- Agent 自己无法通过构造普通参数越过 R4；
- flash/erase/raw 的软件路径有完整测试；
- 若用户未批准物理 R4，阶段报告必须标为“软件接受、物理 R4 未执行”，不得写成硬件已通过。

### P08 — Agent Discovery、Resources/Prompts、三客户端接入（4–7 h）

**目标**：让 Agent 连接后不依赖大段外部手册就能正确使用 MCP。

交付：

- `mcu_capabilities`, `mcu_tool_catalog`, `mcu_backend_status`, `mcu_risk_policy`；
- server `instructions`：前 512 字符自包含“先 capabilities、风险、R4、人机边界”；
- resources：capabilities、catalog、risk policy、workflow playbooks、capture metadata、audit summary；
- prompts：只读诊断、变量激励+采样、SVD 检查、Flash verify；
- 最小 `AGENTS.md`，不复制整本手册；
- Codex、Claude Code/Claude Desktop、OpenCode 的本地 STDIO 示例；
- 启动时确保 process cwd 是目标工程；不把 target path/device 写死在包内；
- 修复或替换当前不可移植 `.mcp.json`；
- Agent conformance tests：首调用、工具选择、R4 停顿、fallback 解释。

客户端注意：

- Codex 使用 MCP server `instructions` 和项目/用户 config；
- Claude Code 本地 STDIO 会提供 `CLAUDE_PROJECT_DIR`，launcher 可在 MCP 初始化前切换 cwd，并校验 roots；
- OpenCode local MCP 支持显式 `cwd`，同时应控制启用工具数量；
- 三者都必须以同一公共 catalog、schema 和风险语义运行，客户端适配只能处理启动配置，不能改变产品规则。

Exit Criteria：

- 三客户端都能列出 MCP、调用 `mcu_capabilities`、读取 workflow；
- Agent 在无人工提示工具名时能完成至少一个只读任务；
- Agent 面对 R4 只能生成/展示 plan 并请求确认，不能自行执行。

### P09 — 端到端验收、通用性门禁、Legacy 清理与 Release Candidate（5–9 h）

**目标**：形成可提交给 GPT-5.6 Pro 和用户做最终验收的候选版本。

交付：

- Windows clean checkout/build/test；
- 非 Git target cwd E2E；
- 指定 HM_C095 + V8.84 E2E；
- 第二个 GCC/synthetic target fixture；
- public tool/resource/prompt catalog snapshot；
- 生产代码 target-specific string scan；
- legacy unsafe/TraceAgent/offline-analysis/CodeGraph/JCAP 公共面删除或彻底 feature-gate；
- README、安装、policy 示例、故障排查、客户端配置；
- `reports/FINAL_ACCEPTANCE.md` 与 machine-readable result；
- package version/release tag 由最终验收决定，不能把功能 spec `0.2.1` 与 npm package version 混为一谈。

必测层级：

1. affected；
2. module；
3. full phase；
4. contract/schema；
5. fake-backend integration；
6. V8.84 hardware read-only；
7. V8.84 controlled R2/R3；
8. optional user-approved physical R4；
9. Codex/Claude/OpenCode agent conformance。

Exit Criteria：

- 冻结 requirement 无 `not_run` 的强制项；
- 所有 blocker 关闭或由用户显式 accepted-risk；
- 目标源码、构建输出和设备状态变化有明确记录；
- 无 target-specific 默认；
- 5.6 Pro 能只依赖 phase reports、diff 和 evidence 重现验收判断。

## 8. 硬件测试策略

### 8.1 测试夹具与产品通用性的分离

指定工程用于证明“实现能在真实 IAR/目标 ECU/J-Link V8.84 上工作”，不能证明“实现已经通用”。通用性还必须由：

- GCC ELF/DWARF fixture；
- 第二个 target 配置 fixture；
- synthetic SVD；
- fake J-Link backend；
- 无 Git 的临时工程目录；
- 生产代码 target-specific string gate；

共同证明。

### 8.2 目标工程访问规则

允许：

- 扫描 source/config/build artifact；
- 在 `.jlink-mcp/` 写 policy、session、audit、capture、export；
- 使用现有 artifact 解析变量；
- 执行已批准范围内的 J-Link 读取和受控 R2/R3 测试。

默认禁止：

- 修改 source/project 配置；
- 自动触发 build；
- 自动生成 MCU 端调试代码；
- 自动 flash/erase/raw；
- 根据变量名字面含义判定“安全”；
- 启动电机或其他执行器。

### 8.3 每次硬件 run 必须记录

- run ID、绝对时间、阶段/commit；
- J-Link software/DLL version、DLL SHA-256、probe model/serial；
- target ID、interface、speed；
- artifact/map/SVD hash；
- policy hash；
- operation plan digest；
- risk、dryRun、approval provider/result（不保存 secret）；
- old/new/readback/restore；
- captureId、segments、CRC、quality；
- flash/erase/reset/halt/resume/write flags；
- 目标源码 fingerprint 前后是否变化。

### 8.4 默认硬件安全顺序

```text
capability/read-only preflight
→ artifact/symbol resolve
→ variable read
→ HSS read-only capture
→ policy-approved inert RAM write + readback + restore
→ HSS capture-time write
→ SVD read-only
→ controlled R3 CPU test（独立 bench 条件）
→ flash verify
→ R4 only after exact plan approval
```

失败时只重跑失败项和直接回归；已有相同 commit/环境/指纹的客观硬件证据不得无意义重复。

## 9. Agent 可用性设计

### 9.1 Server instructions 的最小核心

建议首段（最终文案在 P08 冻结）：

> First call `mcu_capabilities`. This server is a local J-Link runtime-access layer; it does not infer application intent. Use symbol-based variable tools, prefer read-only workflows, inspect `mcu_risk_policy`, and never bypass plan/policy/audit. R4 flash/erase/raw operations require a fresh human approval receipt; R5 is prohibited.

### 9.2 Resources

建议 URI：

```text
jlink://capabilities
jlink://tool-catalog
jlink://risk-policy
jlink://workflows/read-only-debug
jlink://workflows/stimulus-capture
jlink://workflows/svd-inspect
jlink://workflows/flash-verify
jlink://captures/{captureId}/metadata
jlink://sessions/{sessionId}/audit-summary
```

### 9.3 Tool 返回

每个核心工具同时返回：

- `structuredContent`：符合 outputSchema 的 envelope；
- TextContent：同一 JSON 的序列化文本，兼容旧 client；
- `isError=true`：输入合法但业务执行失败；
- resource links：较大 capture/audit 结果不塞进上下文。

## 10. Orchestrator 执行方式

### 10.1 稳定岗位

| roleId | 职责 | 默认写权限 |
|---|---|---:|
| `architecture-contract` | 规格追踪、公共 schema、迁移边界 | 是 |
| `kernel-implementation` | kernel/policy/audit/session/registry | 是 |
| `backend-implementation` | J-Link/BMA/RSP/HSS/SVD/Flash/CPU | 是 |
| `verification` | 测试、diff、证据、硬件读测 | 否 |
| `docs-integration` | resources/prompts/client configs/docs | 是 |
| `safety-review` | 仅 critical/evidence-conflict 定向 Review | 否 |

阶段内最多两个独立 writable worktree；硬件同一时刻只能有一个 owner。

### 10.2 评分 factor 使用

按事实登记，不手工指定 model/thinking：

- 公共 schema/API：`public-interface-or-data-compatibility`；
- HSS/队列/状态机：`concurrency-timing-state-or-hardware-protocol`；
- 真实 R2/R3 测试：`real-hardware-or-external-mutation`；
- Flash/Erase：`data-loss`, `irreversible-hardware`；
- 可能影响执行器/设备：`device-or-human-safety`；
- 证据冲突：`evidence-conflict`。

如果 Codex 宿主只暴露单一 `GPT-5.6` 名称，而不识别 Skill 内部的 luna/terra/sol 别名，则使用一个显式 model adapter：统一模型为 `GPT-5.6`，保留 low/medium/high reasoning 映射，并把实际传入值记录在 receipt；不得假装宿主已采用无法读回的模型设置。

### 10.3 每阶段节奏

```text
start-phase goal contract
→ capabilities
→ register 1–3 tasks
→ prepare/dispatch/ack
→ task handoff
→ affected/module tests
→ targeted review（仅触发时）
→ phase candidate verification
→ phase-result.json + phase-summary.md
→ barrier
→ 5.6 Pro review
→ correction or user acceptance
```

## 11. 统一阶段输出目录

每个阶段必须提交：

```text
reports/phases/Pxx/
  phase-result.json
  phase-summary.md
  evidence/
    test-runs.jsonl
    hardware-runs.jsonl
    catalog-snapshot.json            # 相关阶段需要时
    requirement-status.json          # 相关阶段需要时
    hashes.sha256
```

大型 `.bin/.csv/.jsonl` capture 不提交 Git；留在目标工程 `.jlink-mcp/`，阶段 evidence 只保存：

- metadata 的脱敏副本；
- 文件大小；
- SHA-256/CRC；
- captureId；
- 可复现命令；
- 质量摘要。

## 12. Handoff 固定格式

任务 Handoff 使用 `templates/task-handoff.template.md`。必须包含精确 task ID 和唯一终态：

- `状态：已完成`
- `状态：等待决策`
- `状态：被阻塞`
- `状态：失败`

正常完成最多三条 conclusion-level evidence；详细日志放 evidence 文件。不得把“测试未运行”写成“通过”，不得伪造 Token、active typing time 或宿主实际生效模型。

## 13. 阶段结果与 5.6 Pro 复核

### 13.1 Machine-readable 主文件

`phase-result.json` 必须通过 `schemas/phase-result.schema.json`。重要规则：

- `baseCommit` 和 `resultCommit` 必须是完整 SHA；
- 每条测试必须有 command、cwd、duration、exitCode、result 和 evidence；
- `not_run` 只能作为明确缺口，强制测试含 `not_run` 时阶段不能 `accepted`；
- 真实硬件写必须记录 readback/restore；
- R4 不保存 token，只保存 provider、approval receipt digest、TTL、outcome；
- `tokens.available=false` 时不允许填估算 token 数；
- target `sourceModified/buildTriggered/flashIssued/eraseIssued` 必须显式记录。

### 13.2 Pro 复核输出

GPT-5.6 Pro 使用 `templates/pro-review-request.template.md`，返回符合 `schemas/pro-review-result.schema.json` 的结果。Finding 必须给出：

- severity；
- blocking；
- requirement ID；
- file/line 或 evidence path；
- 可验证的 correction；
- correction 后测试范围。

### 13.3 计时纠正规则

记录三个时间口径：

1. `elapsedMs`：阶段/任务真实墙钟；
2. `blockedMs + humanApprovalWaitMs`：不可归因于实现吞吐的等待；
3. `executionElapsedMs = elapsedMs - blockedMs - humanApprovalWaitMs`。

对同类 task family 使用最近最多 3 个已接受任务的：

```text
ratio = actualExecutionMinutes / plannedMinutes
correctionMultiplier = clamp(median(ratio), 0.70, 1.80)
```

下一阶段估算：

```text
sum(baseTaskMinutes × familyMultiplier)
+ 已知硬件运行预算
+ 明确集成/回归预算
```

规则：

- 首个同类任务没有历史时 multiplier=1.0；
- 环境故障、人类审批等待不用于降低/放大模型实现效率；
- 硬件实际执行时间单列，但计入阶段总 elapsed；
- 纠偏增加的工作必须记 `correctionCount` 和原因；
- 工期偏差不能用于降低 exit criteria；
- 无法观测的 per-task token/desktop read count 必须标记 unavailable。

## 14. 阶段接受判定

`accepted` 必须同时满足：

1. 所有 required task 完成或有用户批准的有效终态处置；
2. exit criteria 每条为 `pass` 且有证据；
3. 测试无 mandatory failed/not_run；
4. 无 unresolved blocker；
5. 真实变更路径在 owned scope 内，Git/worktree 指纹可验证；
6. 硬件动作与风险、审批、readback/audit 相符；
7. 通用性门禁无生产 target-specific 默认；
8. phase report schema 校验通过。

`conditional` 仅用于：实现与 fake integration 已接受，但明确需要用户另行授权的物理 R4 未执行。它不能掩盖 R0–R3、SVD、HSS、变量读取等正常必测缺口。

## 15. 推荐的下一步启动指令

本计划批准后，下一条实施指令使用：

```text
使用 $project-orchestrator 启动 P00，Jlink_MCP Git 仓库路径为 <实际路径>；
目标夹具为 D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config；
本阶段只允许 R0/R1 只读硬件测试，不允许写、halt、reset、flash、erase 或 raw。
```

P00 通过并由 5.6 Pro 接受后，再启动 P01。禁止一次性把 P00–P09 全部派发出去。
