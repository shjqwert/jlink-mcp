# Agent-First J-Link MCP Preconditions

Recorded: 2026-07-19 (Asia/Shanghai)

## Status

| Area | Status | Evidence / constraint |
| --- | --- | --- |
| Repository baseline | PASS | `D:\AI_Project\Trunk\Jlink_mcp`, baseline commit `930cb7e1fdefca16fe2be56bc9b370c89fd6e892` |
| Development branch | PASS | `codex/refactor-agent-first-mcp` |
| Target project | PASS | `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config` |
| Debug Artifact and MAP | PASS | Latest OUT/MAP exist, hashes frozen below, and OUT contains ELF/DWARF sections |
| Flash image association | PASS | User confirmed the S19, OUT, and MAP are from the same build; their hashes form the initial Artifact manifest |
| MCU and Probe identity | PASS | Z20K146M, J-Link serial 69401227, J-Link software V8.84, J-Link hardware V9.40 |
| Physical connection | PASS (observed) | SWD at 4000 kHz, target voltage observed at 4.64 V, non-mutating connection succeeded |
| Current target/Artifact match | UNVERIFIED | T12 flash+verify must run before symbol writes or HSS hardware acceptance |
| Erase permission | PASS | Current hardware run uses `allowErase=true`; T13 must immediately recover with the associated S19 |
| SVD | BLOCKED | No Z20K146M SVD was found locally or through the vendor's public download surface, and the user cannot provide one |
| Offline UI | NOT_TESTED | Existing Offline UI code is retained but is outside modification and acceptance scope |

No flash, erase, reset, halt, resume, memory write, register write, variable write, or HSS capture was performed while preparing this file.

## Repository and Git

- Baseline branch at discovery: `codex/refactor-jlink-hss-jcap-offline-analysis-report`.
- Baseline commit: `930cb7e1fdefca16fe2be56bc9b370c89fd6e892`.
- Development branch: `codex/refactor-agent-first-mcp`.
- The completed prior change is archived at `openspec/changes/archive/2026-07-18-refactor-jlink-hss-jcap-offline-analysis/` without syncing its obsolete approval requirements into the new change.
- Existing unrelated staged and unstaged user changes must not be included in this change's commits.

## Target Artifact Manifest

| Role | Path | Bytes | Last write (+08:00) | SHA-256 |
| --- | --- | ---: | --- | --- |
| Typed debug Artifact | `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\Exe\FOC_SCM.out` | 3,404,458 | 2026-07-19T00:28:17.2611099 | `332813C39A4C84BB41E8F84C994F8CFDAEB0A27B7E9B1B53E6E88D134F481657` |
| MAP | `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\List\FOC_SCM.map` | 257,502 | 2026-07-19T00:28:17.0225062 | `29968AFBBF907E56866272A18CD93B37ECF72A0F2E912C372B6256EAEF2FE421` |
| Flash image | `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\Exe\FOC_SCM.S19` | 612,748 | 2026-07-19T00:28:42.2863178 | `29A4E72BE3F198A2533A012C906C8EECD82931FD680BE0F5B98DBA5E98D6CF25` |

The OUT has ELF magic and contains `.debug_info`, `.debug_abbrev`, `.debug_types`, `.debug_line`, and related DWARF sections. MAP-only symbols remain type-unknown unless a trusted typed Artifact supplies their layout.

Automatic discovery is confined to `projectRoot`. Explicit absolute Artifact, MAP, SVD, and flash paths may be outside it only after canonicalization, content validation, hashing, and `external=true` reporting.

## Hardware

- MCU: `Z20K146M`.
- SEGGER installation: `C:\Program Files\SEGGER\JLink_V884`.
- J-Link software: V8.84.
- Probe serial: `69401227`.
- Probe hardware: V9.40; firmware reported as J-Link V9 compiled 2021-05-07.
- Interface: SWD.
- Speed: 4000 kHz.
- Observed target voltage: 4.64 V.
- Recovery image: the associated `FOC_SCM.S19` above.
- Erase: explicitly allowed for this board/run; the acceptance runner still requires `allowErase=true` in run configuration.

The observed connection used no-init/no-reset/no-halt intent and reached the GDB waiting state. This proves discovery connectivity only, not long-duration stability or current target firmware identity.

## Test Variables

The following addresses are observations for this frozen Artifact generation, not reusable identities. Runtime tools must resolve logical names again and reject stale layout references.

| Role | Logical name | Type | Address | Size | Behavior and test rule |
| --- | --- | --- | --- | ---: | --- |
| Stable read-only | `MotorSvpwm.c::gs_aucSectorTable[0]` | `uint8` | root `0x00022C7C` | 1 | Const flash table element; read only; expected source value `0` |
| Safe RAM write | `g_hssDbgWriteProbe` | `uint32` | `0x20000804` | 4 | Use `0x13579BDF`; capture old value and restore it. `0xFFFFFFFF` is reserved because firmware rewrites it to `0xA5A55A5A` |
| Fast waveform | `g_hssDbgSawFocIsr` | `uint32` | `0x20006B30` | 4 | Updated each FOC ISR from the low 16 bits of its counter; target program overwrites it cyclically |
| State/counter | `g_hssDbgCounterTask1ms` | `uint32` | `0x20006BA8` | 4 | Increments in the 1 ms task; target program overwrites it cyclically |

T14 Full uses the following fixed ten-variable synchronized frame, all `uint32`:

| Variable | Address |
| --- | --- |
| `g_hssDbgWriteProbe` | `0x20000804` |
| `g_hssDbgPatternFocIsr` | `0x20000800` |
| `g_hssDbgCounterFocIsr` | `0x20006B2C` |
| `g_hssDbgSawFocIsr` | `0x20006B30` |
| `g_hssDbgToggleFocIsr` | `0x20006B34` |
| `g_hssDbgRawAdcM1U` | `0x20006B38` |
| `g_hssDbgRawAdcM1V` | `0x20006B3C` |
| `g_hssDbgRawAdcM2U` | `0x20006B40` |
| `g_hssDbgRawAdcM2V` | `0x20006B44` |
| `g_hssDbgCounterTask1ms` | `0x20006BA8` |

## Hardware Acceptance Ordering

1. Run software-only build, lint, unit, simulated integration, package-format, queue, and failure-path tests.
2. Execute T12 flash+verify first, using the associated S19, to establish a live `verified` Artifact match.
3. Execute read, write, CPU-control, HSS, JCAP, rebuild, and bounded-query cases according to their dependencies rather than numeric test ID.
4. T14 Smoke: four confirmed variables, 100 Hz, 10 seconds.
5. T14 Full: the fixed ten variables, 1 kHz, 60 seconds; at least 57,000 of 60,000 expected frames and explicit drop/overflow counts.
6. T15: ten variables at 1 kHz for 60 seconds; write `g_hssDbgWriteProbe` near 20 seconds and restore the captured old value near 40 seconds, both with verification and aligned events.
7. T13 erase only while `allowErase=true`, then immediately flash+verify the associated S19 and restore execution explicitly.
8. SVD peripheral-register hardware cases remain `BLOCKED` until an exact Z20K146M SVD is configured. Explicit `read_memory`/`write_memory` may be used instead but cannot be reported as SVD test coverage.

## Evidence and Output

- All runtime/test output stays under the repository's ignored `test-output/` tree.
- A run directory is created only when an explicit `runId` is supplied.
- Normal captures without `runId` use `test-output/captures/`; explicit CSV exports use `test-output/exports/`.
- No Commit 7 hardware-summary snapshot is required. Local AI and Offline UI consumers read ignored evidence directly.
- Status values are `PASS`, `FAIL`, `BLOCKED`, `SKIPPED_WITH_REASON`, or `NOT_TESTED`; missing prerequisites are never reported as passing.
