# HSS Symbol Resolution

Result: partial.

ELF used: `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\Exe\FOC_SCM.out`.

Resolved safe read-only candidates:

- `s_traceAliveCounter` at `0x20006bdc`, 4 bytes.
- `s_traceAgentSeq` at `0x20006bd4`, 4 bytes.
- `s_traceAgentTimeUs` at `0x20006bd8`, 4 bytes.
- `s_traceAgentInitialized` at `0x20006c32`, 1 byte.
- `s_traceAgentDownLength` at `0x20006c06`, 2 bytes.
- `s_traceAgentInitStatus` at `0x20006c08`, 2 bytes.
- `guwWdgCount` at `0x20006bee`, 2 bytes.

The requested motor-observation example names mostly were not exported as ELF globals. Forbidden selectors such as `bMotorStarted`, `gstMotorCtrl.*`, `gstMotorDbg.*`, and suspicious `run/start/stop/control/ref` names are rejected.
