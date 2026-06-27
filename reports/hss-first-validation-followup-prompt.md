# HSS-first Validation Follow-up Prompt

你是嵌入式调试与 MCP 工具链专家。请基于下面事实，帮我给 `Jlink_mcp` 规划下一轮最省时间、最可靠的验证与修复路线，重点避免在别的项目复用本 MCP 时重复踩坑。

## 背景

- 工程：`D:\AI_Project\Trunk\Jlink_mcp`
- 目标板：HM_C095，MCU `Z20K146MC`
- J-Link：SEGGER J-Link V8.84，S/N `69401227`
- 固件：`D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\Exe\FOC_SCM.out`
- 本轮目标：实现并验证 HSS-first 多 backend runtime capture；优先 HSS，其次 direct RTT channel，再 memory-poll RSP fallback。

## 已完成

- HSS-first backend router、backend benchmark、external import、direct RTT channel、memory-poll RSP 已实现并接入 MCP tools。
- RTT channel discovery/read/write、TraceAgent write frame codec、TraceAgent stream decoder 已实现。
- JScope/HSS preflight 已执行：`JScope.exe`、`JLink_x64.dll` 存在，DLL 包含 `JLINK_HSS_GetCaps/Start/Read/Stop` 字符串。
- JScope GUI 能通过 `FOC.jscope` + `-USB 69401227` 打开采样 UI；证据在 `reports/jscope-hss-preflight.png`。
- 实板 direct RTT 写 `guwWdgFlg=1/0` 被 MCU 消费并读回成功。
- OpenSpec 已归档并同步主规格。
- 验证通过：`npm run lint`、`npm run build`、`npm test`、`npm run test:hm-c095`、`npm run test:write`、`npm run test:elf`、`npm run test:capture-ipc`、`npm run test:coverage`、`openspec.cmd validate --all --strict`。

## 未完成或阻塞

1. HSS headless benchmark/export 未完成。
   - JScope 已能 GUI preflight，但未确认可自动 start/stop/export 的 CLI。
   - 本机 J-Link 安装包没有可直接采用的 `JLINK_HSS_*` typed header/prototype。
   - 当前 blocker：需要 SEGGER 官方 CLI/export 路径，或实现经过类型确认的 DLL adapter。

2. RSP direct RTT 实板路径未作为稳定 fallback 通过。
   - `JLinkGDBServerCL.exe` 可启动，但 RSP `monitor go`/target-running 策略在实板上不稳定。
   - 一次性 `JLink.exe mem` 会影响目标运行状态，不适合作为 live stream 方案。

3. RTT stream 质量未达标。
   - 30s direct RTT polling stream 捕获到数据，但有 CRC failures、discarded bytes、sequence gaps。
   - ACK frame 未观察到。
   - 后续需要 HSS 或更可靠的 target-running direct memory path。

## 本轮踩坑与规避建议

1. 不要只依赖 `JLINK_HSS_ENABLED` / `JLINK_SDK_DIR` 判断 HSS。
   - 本机没有 SDK header，但存在 `JScope.exe` 和 `JLink_x64.dll`。
   - 正确 preflight：检查 JScope、DLL、DLL 内 HSS export 字符串、现有 `.jscope` 项目。

2. Windows sandbox 会让 Node 测试写 Temp 失败。
   - 现象：`EPERM` 写 `C:\Users\SHJ\AppData\Local\Temp`。
   - 规避：需要时提升权限；测试里临时目录优先放仓库 `.tmp` 并清理。

3. coverage 初跑未过不是业务失败。
   - 新增 HSS/RSP 分支后 backend/rtt/traceagent line coverage 一度为 92.93%，低于 95%。
   - 规避：补最小离线单测覆盖 HSS preflight、RSP monitor/read/write error path；最终 95.25% 通过。

4. `RspMemoryIo.monitor()` 有过真实小 bug。
   - 原因：先判断 `response.startsWith("O")`，把 `"OK"` 误判为 console-output 包，导致超时。
   - 修复：先判断 `response === "OK"`，再处理 `O...` 输出包。

5. PowerShell DLL 轮询路径容易被脚本细节污染。
   - 过程中遇到 U16/U32/CRC/轮询节奏问题。
   - 规避：后续实板 tight-loop 优先用小型 C#/native helper，减少 PowerShell 字节处理误差。

6. JScope GUI preflight 不等于 headless benchmark。
   - GUI 能打开采样 UI，只能证明 HSS/JScope 工具链可用。
   - 没有机器可读导出前，不要把 GUI 截图当 throughput benchmark。

## 请回答

1. 下一轮最小可行方案是什么：优先找 JScope headless export，还是直接做 `JLINK_HSS_*` DLL adapter？
2. 如果做 DLL adapter，最小安全验证矩阵是什么，如何避免目标停机或误写？
3. 对没有 HSS 的项目，RTT/RSP fallback 应该如何设计，才不会再次被 target halt/reset、Temp 权限、脚本轮询误差拖慢？
4. 哪些检查应该做成 MCP preflight，让其他项目复用时一开始就暴露这些问题？
