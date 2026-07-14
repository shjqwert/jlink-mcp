# Jlink_MCP v0.2.1 功能冻结清单

## 1. 项目定位

Jlink_MCP 是供 Codex / Agent 调用的通用 MCU Runtime Access MCP。

它不是项目大脑，不负责理解业务逻辑；它是 Agent 的 MCU 运行时访问工具层。

核心目标：

- 让 Agent 在本机项目目录中，通过 J-Link 对 MCU 进行运行时访问；
- 支持变量读取、受控写入、高速采样、SVD 寄存器读写、Flash 校验/烧录；
- 输出可靠、可追溯、结构化的调试数据；
- 不依赖项目必须使用 Git；
- 不强制目标 MCU 修改代码。

---

## 2. 主从关系

| 角色 | 职责 |
|---|---|
| Agent / Codex | 理解项目、判断问题、决定调试流程、选择 MCP 工具 |
| Jlink_MCP | 提供 J-Link / HSS / SVD / 变量读写 / 采样导出能力 |
| 用户 | 仅在 R4 高风险操作时确认 |

---

## 3. 项目路径策略

`projectRoot = MCP 启动时的 cwd`

规则：

1. 不依赖 Git；
2. 不调用 git 指令判断项目根目录；
3. 不要求用户手动传 projectRoot；
4. 默认输出目录：`<cwd>/.jlink-mcp/`；
5. MCP 只负责防止路径逃逸；
6. Agent 可传 `sessionName`；
7. Agent 可传 `outputSubdir`，但必须位于 cwd 内部。

默认目录结构：

```text
<projectRoot>/.jlink-mcp/
  policy.json
  sessions/
  captures/
  audit/
  exports/
```

---

## 4. Debug Artifact 支持

### 4.1 支持用于变量解析

| 文件 | 第一版支持 | 说明 |
|---|---:|---|
| `.elf` | 是 | GCC / IAR 常见调试产物 |
| `.out` | 是 | IAR / GCC 输出，按内容探测 |
| `.axf` | 保留支持 | 当前未遇到，但预留 |
| `.map` | 是 | 第一版先支持 IAR `.map` 补充解析 |

### 4.2 只用于 Flash / 校验

| 文件 | 第一版支持 | 是否参与变量解析 |
|---|---:|---:|
| `.hex` | 是 | 否 |
| `.bin` | 是 | 否 |
| `.srec` | 是 | 否 |

原则：

- 变量解析不按扩展名硬判断；
- 优先使用调试信息 / 符号表；
- `.map` 作为补充；
- `.hex / .bin / .srec` 不参与变量解析。

---

## 5. 变量读取范围

第一版支持：

1. global scalar；
2. static scalar；
3. struct fixed member。

第一版不支持：

1. 局部变量；
2. 指针自动解引用；
3. 动态数组；
4. malloc 区对象；
5. 多核 / 多镜像变量解析。

---

## 6. 变量写入范围

第一版支持：

1. RAM 变量写入；
2. struct fixed member 写入；
3. 写入前 plan；
4. 写后 readback；
5. maxWrites 限制；
6. dry-run。

第一版不支持：

1. 任意地址默认写；
2. Flash 区变量写；
3. Peripheral 区变量写；
4. Debug/Core register 区变量写；
5. 数组元素写入默认不做。

---

## 7. 风险等级策略

| 等级 | 操作类型 | 策略 |
|---|---|---|
| R0 | 纯只读、能力查询 | Agent 自动执行 |
| R1 | 变量读取、SVD 读、artifact probe、HSS plan | Agent 自动执行 |
| R2 | policy 允许的 RAM 变量写入 | Agent 自动执行，必须 readback |
| R3 | halt / resume / step / reset、GPIO 输出写、普通 SVD field 写 | Agent 自主判断，必须 operationPlan + audit |
| R4 | Flash 写入、erase、raw GDB、raw probe、关键外设写入 | Agent 可见，但执行需要人工确认 |
| R5 | option byte、security、reserved bit、未知寄存器写、危险系统区写 | 默认禁止 |

---

## 8. Policy 文件

项目内保存：

```text
<projectRoot>/.jlink-mcp/policy.json
```

第一版允许：

```text
R0 / R1 / R2 / R3
```

R4 需要人工确认。  
R5 默认禁止。

策略内容包括：

1. `variableWriteAllowlist`；
2. `svdWriteAllowlist`；
3. `riskOverrides`；
4. `maxWrites`；
5. value range；
6. `requireReadback`；
7. `allowBurstWrite`。

`maxWrites` 超限后：

- 只拒绝该变量继续写；
- 不影响其他变量；
- 不关闭整个 session。

---

## 9. dry-run 模式

所有风险操作都支持：

```json
{
  "dryRun": true
}
```

适用范围：

1. `variable_write`；
2. `svd_write_field`；
3. `flash`；
4. `erase`；
5. `halt`；
6. `resume`；
7. `step`；
8. `reset`；
9. `raw_command`。

---

## 10. J-Link 能力

第一版支持：

1. 本机 J-Link 连接；
2. J-Link 设备识别；
3. J-Link 型号识别；
4. J-Link DLL / 软件版本识别；
5. J-Link 能力查询；
6. J-Link HSS 能力检查。

第一版不支持：

1. 远程 Agent；
2. 远程硬件；
3. 多探针复杂调度。

---

## 11. HSS 高速采样

HSS 是第一版高速读取主路径。

第一版支持：

1. `hss_capability_probe`；
2. `hss_capture_plan`；
3. 单组 HSS capture；
4. Agent 根据 plan 选择变量和采样率；
5. J-Link 版本 / 型号 / 变量数量限制检查；
6. HSS 采样过程中进行受控 RAM 变量写入；
7. 写入动作记录为 capture event；
8. 超限时让 Agent 自主选择：
   - 降低采样率；
   - 减少变量数量；
   - 分多轮采样。

第一版不支持：

1. 多组 HSS 并行采样；
2. 多频率 HSS 并行采样；
3. 自动业务优先级判断。

---

---

## 11A. HSS 高速采样过程中的变量写入

第一版支持 **HSS 高速采样过程中进行受控变量写入**，用于实现“写入激励 + 采样响应”的调试闭环。

### 11A.1 支持场景

1. HSS 正在高速采样；
2. Agent 发起变量写入计划；
3. MCP 根据 policy 和风险等级判断是否允许；
4. 写入 policy 允许的 RAM 变量；
5. 写后 readback；
6. HSS 继续采样；
7. 写入动作记录到 capture event / audit。

典型用途：

1. 写入调试变量；
2. 写入测试激励；
3. 写入目标值；
4. 写入状态切换变量；
5. 对比写入前后变量变化，定位问题原因。

### 11A.2 允许范围

| 操作 | HSS 运行中是否允许 | 规则 |
|---|---:|---|
| R0 / R1 读操作 | 是 | 自动允许 |
| R2 RAM 变量写入 | 是 | policy 允许，必须 readback |
| R3 RAM 变量写入 | 是 | 必须 operationPlan + audit |
| SVD field 写入 | 谨慎允许 | 仅限明确 policy 允许的低风险 field |
| raw GDB / raw probe | 否 | 必须先停止 capture，或进入人工确认流程 |
| flash / erase | 否 | HSS 运行中禁止 |
| halt / reset / step | 默认否 | 会破坏采样连续性，需先 stop capture 或升级 R4 |

### 11A.3 调用流程

```text
hss_capture_start
  ↓
variable_write_plan
  ↓
risk / policy check
  ↓
variable_write_execute
  ↓
readback
  ↓
capture event 记录写入点
  ↓
HSS 继续采样
```

### 11A.4 Capture Event 记录

HSS 运行中发生变量写入时，必须写入 `.capture.json` 的事件列表。

示例：

```json
{
  "type": "variable_write",
  "timeUs": 123456,
  "sampleIndexNear": 1024,
  "target": "Debug_IqRef",
  "oldValue": 0,
  "newValue": 120,
  "readback": 120,
  "risk": "R2",
  "ok": true
}
```

Agent 后续可以基于 event 做窗口查询：

```text
写入前 100ms
写入后 100ms
对比变量响应
```

### 11A.5 采样质量标记

写入过程中可能造成采样抖动、短暂 backend busy 或丢点，因此 sample 的 `statusFlags` 需要支持写入相关标记。

新增建议 flags：

```text
write_nearby
write_in_progress
backend_busy
```

### 11A.6 并发和探针占用规则

HSS capture session 拥有 probe。  
HSS 运行期间的变量写入必须作为 capture session 的子操作进入统一硬件访问队列。

规则：

1. 普通 `variable_write` 不得绕过 capture session 直接抢占 J-Link；
2. capture-time write 必须串行化；
3. 写入完成后继续采样；
4. 写入失败不得破坏 capture metadata；
5. 写入动作必须进入 audit 和 capture event。

### 11A.7 第一版边界

第一版支持：

1. HSS 运行中的 RAM 变量写入；
2. policy 限制；
3. risk check；
4. readback；
5. audit；
6. capture event；
7. 写入附近 sample 质量标记。

第一版不支持：

1. HSS 运行中 flash / erase；
2. HSS 运行中 raw dangerous command；
3. HSS 运行中 reset / halt / step 默认自动执行；
4. 多组 HSS 并行采样中的跨组写入同步；
5. 复杂事务写入。

## 12. Background Memory Access / Live Watch

定位：低侵入、低速、通用读取路径。

第一版支持：

1. 少量变量周期读取；
2. Live Watch；
3. Agent 调试验证；
4. target halted 状态下读取。

限制：

- Background Memory Access 失败后，不允许 MCP 自动 halt；
- 只能返回 fallback suggestion；
- halt 由 Agent 判断，属于 R3。

---

## 13. RSP Memory fallback

定位：HSS / Background Memory 不适用时的低速 fallback。

第一版支持：

1. 少量变量读取；
2. 小范围 memory read；
3. fallback reason 返回给 Agent。

不作为主推高速采样方案。

---

## 14. RTT

RTT 保留为 optional。

定位：项目已有 RTT 或用户接受 MCU 端代码配合时使用。

第一版规则：

1. 不作为默认主路径；
2. 不要求目标项目为了 MCP 修改 MCU 代码；
3. Direct RTT Channel 降级为 optional / experimental；
4. TraceAgent 从主线删除。

---

## 15. SVD 功能

第一版支持：

1. `svd_load`；
2. `svd_list_peripherals`；
3. `svd_list_registers`；
4. `svd_read_register`；
5. `svd_read_field`；
6. `svd_decode_register`；
7. `svd_write_field_plan`；
8. `svd_write_field_execute`；
9. `svd_write_field_readback`。

写入规则：

1. 默认只允许 field-level 写入；
2. register-level 默认禁止；
3. reserved bit 禁止；
4. unknown register 禁止；
5. W1C / W0C / toggle 字段必须显式识别或配置；
6. clock / reset / watchdog / flash / security 默认 R4 或 R5；
7. GPIO 输出电平写入 = R3。

---

## 16. Flash 能力

| 操作 | 策略 |
|---|---|
| flash verify | 自动执行 |
| flash write | R4，需人工确认 |
| erase | R4，默认隐藏或强确认 |

`.hex / .bin / .srec` 只用于 flash / verify，不参与变量解析。

---

## 17. CPU 控制

第一版支持：

1. halt；
2. resume；
3. step；
4. reset。

策略：

1. Agent 自主判断是否需要操作；
2. 不每次问人；
3. 必须生成 operationPlan；
4. 必须写 audit；
5. reset during capture 升级为 R4；
6. reset + flash/raw command 升级为 R4。

---

## 18. Raw GDB / Raw Probe Command

第一版保留，但强约束。

规则：

- Agent 可见；
- plan 可用；
- execute 需要人工确认。

建议工具：

1. `raw_command_plan`；
2. `raw_command_execute`。

执行前必须说明：

1. 为什么要用 raw command；
2. 预期影响；
3. 是否会改变 target 状态；
4. 是否可恢复；
5. 后续验证步骤。

---

## 19. 采样数据格式

### 主格式

```text
.capture.bin
.capture.json
```

### 辅助格式

```text
.csv
.jsonl
```

第一版规则：

1. 不压缩；
2. 按文件大小分段；
3. 默认 `segmentSize = 64MB`；
4. 可配置范围：16MB ~ 512MB；
5. 每个 sample 记录 `statusFlags`；
6. Agent 不直接猜文件名，必须通过 capture index / metadata 读取。

sample 最小结构：

```text
sampleIndex
timestampTicks
statusFlags
values[]
```

statusFlags：

```text
valid
read_error
timeout
overflow
dropped_before_this_sample
target_halted
write_nearby
write_in_progress
backend_busy
```

---

## 20. 分段采样

第一版支持按文件大小分段：

```text
capture_0001.bin
capture_0002.bin
capture_0003.bin
capture.json
```

`capture.json` 必须包含：

1. captureId；
2. backend；
3. symbols；
4. sampling info；
5. segment list；
6. crc；
7. sampleStart；
8. sampleCount；
9. quality summary。

---

## 21. 审计日志

第一版支持：

1. 异步 JSONL；
2. 不阻塞调试主流程；
3. 每个 session 一个 `audit.jsonl`；
4. 支持查询；
5. 支持汇总。

记录范围：

1. variable write；
2. svd write；
3. halt / resume / step / reset；
4. flash；
5. erase；
6. raw command；
7. policy change；
8. backend fallback；
9. capture start / stop。

---

## 22. Session 管理

规则：

1. Agent 可传 `sessionName`；
2. 不传则 MCP 自动生成；
3. 不需要人工确认；
4. session 存放在 `<projectRoot>/.jlink-mcp/sessions/` 下。

默认命名：

```text
YYYYMMDD_HHMMSS_<short-task-name>
```

---

## 23. Agent 能力发现

AGENTS 只放最小入口，不写大段 MCP 手册。

MCP 自己提供：

1. `mcu_capabilities`；
2. `mcu_tool_catalog`；
3. `mcu_backend_status`；
4. `mcu_risk_policy`；
5. MCP resources；
6. MCP prompts；
7. workflow playbook。

Agent 接入后推荐第一步：

```text
mcu_capabilities
```

然后按任务读取对应 workflow。

---

## 24. 返回格式

所有核心工具统一 JSON 返回。

统一 envelope：

```json
{
  "ok": true,
  "operation": "variable_read",
  "data": {},
  "risk": {
    "level": "R1",
    "requiresUserApproval": false
  },
  "backend": {
    "selected": "background-memory",
    "fallbackFrom": null,
    "reason": null
  },
  "artifacts": [],
  "warnings": [],
  "message": "completed"
}
```

---

## 25. 第一版明确不做

1. 多核 / 多镜像；
2. GCC map parser；
3. 远程 Agent / 远程硬件；
4. TraceAgent 主线；
5. Runtime Evidence；
6. CodeGraph Bridge；
7. 离线实验诊断；
8. 采样压缩；
9. 多组 HSS 并行采样；
10. 多频率 HSS 并行采样；
11. 任意地址默认写；
12. SVD register-level 默认写；
13. MCU 端代码修改依赖；
14. 复杂项目根目录识别；
15. Git root 依赖；
16. HSS 运行中的复杂事务写入。

---

## 26. 冻结版一句话

Jlink_MCP v0.2.1 是 Agent 调试 MCU 的通用运行时访问层：

本机 J-Link，cwd 项目目录，支持 Debug Artifact 变量解析、RAM 变量读写、HSS 高速采样、Background Memory / RSP fallback、RTT optional、SVD 寄存器读写、Flash 校验/烧录、风险分级、审计日志和结构化 JSON 返回。
