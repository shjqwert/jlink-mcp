# Jlink_MCP 后续功能增长表

## 1. 增长原则

后续功能增长遵循以下原则：

1. 不破坏 v0.2.1 的核心边界；
2. 不引入项目特调；
3. 不让 MCP 变成项目大脑；
4. MCP 仍然是 Agent 的 MCU Runtime Access 工具层；
5. 高速读取、写入成功率、数据可靠性优先；
6. 后续能力以插件化、可选化、可降级为主。

---

## 2. 版本增长总览

| 版本 | 功能增长项 | 说明 |
|---|---|---|
| v0.3 | 多核 / 多镜像支持 | 支持多 core、多 image、多 artifact 映射 |
| v0.3 | GCC `.map` parser | 第一版只做 IAR map，后续补 GCC |
| v0.3 | `.axf` 深度兼容 | 增加 Keil / ARMCC 产物验证 |
| v0.3 | 数组固定 index 读取 | 如 `arr[3]`，只支持固定 index |
| v0.3 | 数组固定 index 写入 | 受 policy 控制 |
| v0.3 | 多组 HSS 分时采样 | Agent 可把变量分组多轮采样 |
| v0.3 | 多频率采样计划 | 高频变量和低频变量分层采样 |
| v0.3 | HSS 自动采样计划优化 | 根据变量数量、大小、变化频率给出推荐方案 |
| v0.3 | 更完整的 capture query | 支持按时间范围、变量名、segment、capture event 查询 |
| v0.3 | Capture-time write 窗口查询增强 | 支持围绕写入事件自动查询写入前后窗口 |
| v0.4 | 远程硬件代理 | Agent 与 J-Link 不在同一台机器 |
| v0.4 | CI Runner 硬件测试模式 | 支持自动化硬件回归测试 |
| v0.4 | 采样压缩 `.capture.zst` | 可选压缩，不影响第一版高速写入 |
| v0.4 | 更完整的 vendor artifact parser | 适配更多编译器产物 |
| v0.4 | SVD register-level 特殊授权写 | 仅限强约束场景 |
| v0.4 | 外设风险模板库 | GPIO/TIM/DMA/ADC/CAN/UART 等风险模板 |
| v0.5 | 可选 RTT protocol adapter | 插件化，不进主线 |
| v0.5 | TraceAgent 插件化 | 作为 optional protocol plugin |
| v0.5 | 多探针管理 | 多 J-Link、多目标板 |
| v0.5 | 更高级审计报告 | 自动生成调试过程报告 |
| v0.5 | 数据可视化导出 | 导出给外部画图/分析工具 |
| v0.6 | 远程实验室调度 | 多设备、多任务调度 |
| v0.6 | 长时间稳定性采样 | 长时间分段、断点续采、恢复 |
| v0.6 | 安全策略模板市场/库 | 不同 MCU / 项目类型复用策略 |

---

## 3. v0.3 增长计划

### 3.1 多核 / 多镜像支持

目标：

- 支持多 core；
- 支持 bootloader + app；
- 支持多个 Debug Artifact；
- 支持变量属于不同 image / core 的情况。

示例：

```text
artifact_app.elf
artifact_boot.out
core_app
core_net
```

需要新增能力：

1. artifact group；
2. active image selection；
3. core selection；
4. symbol namespace；
5. capture target mapping。

---

### 3.2 GCC `.map` parser

v0.2.1 先支持 IAR `.map`。  
v0.3 增加 GCC map parser。

用途：

- 当 `.elf/.out` 调试信息不足时，作为符号地址补充；
- 支持变量地址查找；
- 类型信息仍以 Debug Artifact 为主，map 只能补地址。

---

### 3.3 `.axf` 深度兼容

目标：

- 验证 Keil / ARMCC `.axf`；
- 支持 symbol table；
- 支持 DWARF / debug info；
- 必要时增加 vendor-specific parser。

---

### 3.4 数组固定 index 读取 / 写入

支持：

```text
arr[3]
buffer[10]
table[2].field
```

限制：

1. 只支持固定 index；
2. 不支持动态 index；
3. 不支持指针数组自动展开；
4. 写入必须受 policy 控制；
5. 必须校验地址和边界。

---

### 3.5 多组 HSS 分时采样

目标：

- Agent 可以把变量分为多组；
- 每组单独采样；
- 适用于变量数量超过 J-Link HSS 限制的场景。

示例：

```text
Group A: 高频变量，1000Hz
Group B: 中频变量，100Hz
Group C: 低频变量，10Hz
```

第一阶段可做分时采样，不做真正并行采样。

---

### 3.6 多频率采样计划

目标：

- 根据变量变化频率、采样需求、J-Link 限制，给出推荐采样计划；
- Agent 最终选择计划；
- MCP 只负责校验计划是否可执行。

---

### 3.7 HSS 自动采样计划优化

目标：

- 输入变量列表；
- 输入每个变量优先级 / 变化频率 / minimumRateHz；
- 输出推荐变量组合和采样率；
- 当超过 HSS 限制时，建议降频、减变量或拆分多轮。

---

### 3.8 更完整的 capture query

增强查询：

1. 按时间范围；
2. 按变量名；
3. 按 segment；
4. 按 statusFlags；
5. 按采样质量；
6. 按 capture event；
7. 查询写入前后窗口；
8. 输出统计摘要。

---

### 3.9 Capture-time write 窗口查询增强

v0.2.1 支持 HSS 采样过程中的受控变量写入，并记录 capture event。  
v0.3 增强事件查询能力。

目标：

1. 根据 `variable_write` event 自动定位 sampleIndex；
2. 自动查询写入前 / 写入后窗口；
3. 支持多次写入事件对齐；
4. 支持导出 event-centered CSV / JSONL；
5. 帮助 Agent 对比写入前后响应。

---

## 4. v0.4 增长计划

### 4.1 远程硬件代理

目标：

- Agent 与 J-Link 不在同一台机器；
- 支持实验室 PC 连接 J-Link；
- Codex / Agent 通过远程通道调用硬件能力。

需要关注：

1. 网络权限；
2. 安全认证；
3. 操作审计；
4. 数据传输；
5. 远程 capture 文件同步。

---

### 4.2 CI Runner 硬件测试模式

目标：

- 在 CI / 自动化环境中接入硬件；
- 支持自动 flash、运行、采样、导出；
- 支持回归验证。

注意：

- CI 模式需要更强的安全策略；
- 需要严格防止误操作真实硬件。

---

### 4.3 采样压缩 `.capture.zst`

目标：

- 降低长期采样文件体积；
- 不影响第一版高速写入主路径；
- 默认不启用；
- 后处理压缩优先。

策略：

```text
capture.bin -> capture.zst
capture.json 保留索引和压缩信息
```

---

### 4.4 更完整的 vendor artifact parser

目标支持更多编译器 / 工具链：

1. IAR；
2. GCC；
3. Keil / ARMCC；
4. Green Hills；
5. TI；
6. 其他后续补充。

---

### 4.5 SVD register-level 特殊授权写

v0.2.1 默认只支持 field-level 写入。  
v0.4 可支持特殊授权的 register-level 写入。

要求：

1. 必须 explicit allowlist；
2. 必须 dry-run；
3. 必须 read-modify-write；
4. 必须保留 reserved bits；
5. 必须 audit；
6. 高风险寄存器仍然 R4/R5。

---

### 4.6 外设风险模板库

目标：

为常见外设提供默认风险模板。

示例：

| 外设 | 默认风险 |
|---|---|
| GPIO 输出 | R3 |
| TIM / PWM | R3/R4 |
| DMA | R4 |
| FLASH controller | R4/R5 |
| RCC / CLOCK | R4 |
| WATCHDOG | R4/R5 |
| ADC | R2/R3 |
| UART | R2/R3 |
| CAN | R3/R4 |

---

## 5. v0.5 增长计划

### 5.1 可选 RTT protocol adapter

RTT 不进入主路径，但可以作为 optional plugin。

目标：

- 项目已有 RTT 时使用；
- 不要求项目为了 MCP 修改 MCU 代码；
- 支持插件式协议解析。

---

### 5.2 TraceAgent 插件化

TraceAgent 从主线删除。  
后续可作为 optional plugin。

要求：

1. 不硬编码项目变量；
2. 不绑定 HM-C095；
3. policy 外置；
4. 协议 schema 外置；
5. 只在用户启用 plugin 时加载。

---

### 5.3 多探针管理

目标：

- 支持多个 J-Link；
- 支持多目标板；
- 支持 probe selection；
- 支持 probe capability cache。

---

### 5.4 更高级审计报告

从 audit.jsonl 生成报告：

1. 本次调试做了什么；
2. 哪些变量被写入；
3. 哪些寄存器被修改；
4. 是否发生 reset / halt；
5. 采样文件在哪里；
6. 关键风险操作有哪些。

---

### 5.5 数据可视化导出

目标：

- 导出给外部画图工具；
- 支持 CSV/JSONL 聚合；
- 支持生成简单图表数据；
- 不在 MCP 内做业务诊断。

---

## 6. v0.6 增长计划

### 6.1 远程实验室调度

目标：

- 多设备；
- 多任务；
- 多 Agent；
- 共享硬件资源；
- 调度锁；
- 使用记录。

---

### 6.2 长时间稳定性采样

目标：

- 长时间分段；
- 断点续采；
- 恢复；
- segment 校验；
- 中断后继续；
- 长时间采样质量统计。

---

### 6.3 安全策略模板市场 / 库

目标：

- 为不同 MCU / 项目类型复用策略；
- 减少每个项目手写 policy；
- 但不引入项目特调。

示例：

```text
policy-template-stm32-basic.json
policy-template-nrf52-basic.json
policy-template-motor-control-safe.json
policy-template-gpio-readonly.json
```

---

## 7. 长期不进入主线的内容

以下内容不建议进入主线：

1. 项目特调逻辑；
2. 业务诊断结论；
3. 固定电机 / FOC / HM-C095 规则；
4. 强依赖 MCU 端改代码的能力；
5. 自动修改项目源码的逻辑；
6. CodeGraph Bridge；
7. Runtime Evidence；
8. 离线实验分析主线化。

---

## 8. 增长表一句话

Jlink_MCP 后续增长方向是：  
在不破坏“通用 MCU Runtime Access 工具层”定位的前提下，逐步增强 artifact 兼容、采样能力、远程硬件、SVD 写入、安全审计和可选协议插件。
