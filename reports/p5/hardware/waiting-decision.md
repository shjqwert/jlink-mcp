# P5 硬件验收｜等待决策

- 任务：`p5-hardware-r2-r4-v2`
- 状态：`等待决策`
- Trust Profile：已按授权原子刷新，唯一变更为 `runtime.helperSha256`、`runtime.sha256`、`profileSha256`；证据见 `runs/2026-07-17T22-09-27-780+08-00/evidence.json`。
- 全绑定 Gate：`targetId=Z20K146M`、`serial=69401227`、SWD 4000 kHz、`script.mode=none`、OUT/MAP、变量布局、Runtime/helper/adapter 均通过；无 reset/halt/resume/write/Flash/Erase。
- HSS：无 reset 计划成功，但 `hss_capture_start` 以 `HSS_HELPER_BAD_JSON` 失败。JCAP 仅含 `capture_planned → fault → pre_start_failure`，`samples.bin` 为 0 字节，未出现 `hss_start`；证据见 `runs/2026-07-17T22-11-54-559+08-00/`。
- R2/R4：未进入 R2，未生成或执行 R4 challenge。
- 目标工程：执行前后均为 1,813 文件，逐文件清单完全相同，manifest digest 均为 `a366f917c6a2f46da86b5cc4e04d933ffdca4aaf69c4ced8e8817cfeeb911b93`；后验清单见 `manifest-after-readonly.json`。
- 阻塞：生产 HSS 启动路径返回不符合 QPC timebase 合同的 helper NDJSON，现有实现不足且修复超出本岗位范围。需主控安排实现修复并重新验证 Runtime/Trust 身份，再创建新的受控硬件验收任务。
