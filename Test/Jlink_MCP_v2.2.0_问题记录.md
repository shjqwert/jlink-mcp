# J-Link MCP v2.2.0 问题记录

## HW-V220-006：运行态 exact-device attach/release 导致 HardFault

- 级别：P0（已关闭）
- 最短复现：在 HM_C095/Z20K146M 上用 `Z20K146M` 作为运行态 memory-session attach profile，释放后在复位前观察到 `IPSR=3`、`CFSR=0x00020000`、`HFSR=0x40000000`。
- 根因：SEGGER exact-device 运行态 attach/release 路径改变了目标执行上下文；缺少复位不是根因，普通 Close 与精确进程终止均可复现。
- 修复：保留 `device=Z20K146M` 作为固件/烧录身份，要求用户显式配置 `gdbDevice` 作为运行态 attach profile；HM_C095 使用 `Cortex-M4`。memory-session、HSS capability/observe/restore/capture 均使用 attach profile，artifact manifest 继续绑定真实 device。轮询关闭后在同一 Probe lease 内完成目标状态、Cortex-M fault 状态、observer release identity 与释放前状态资格校验，未知状态 fail-closed。
- 软件回归：完整 `npm run test:release` 通过；direct-operations 99/99，完整 unit 526/526，JCAP 19/19，surface 8/8。
- 硬件回归：`Cortex-M4` 最短 native release A/B 的运行态观察窗口全程 `CFSR=0`、`HFSR=0` 且观察到 Thread mode；生产 `background_poll` 采集 `f9e73a6f-c038-4aa3-8c62-8f46c89f38a5` completed。完整矩阵曾复现 HSS exact-device 后 `VECTACTIVE=3`、`CFSR=0x01030000`、`HFSR=0x40000000`；修复后最小 HSS 采集 `103b2a2d-b8bc-4f49-9d67-1dc5264a8fb8` completed，post-capture fault gate、变量恢复和 post-client-close owner 门禁均通过。
- 关闭条件：最短硬件复现、生产轮询关闭与独立 post-release fault gate 均通过；最终发布矩阵仍作为发布验收，不反向修改本问题根因结论。
