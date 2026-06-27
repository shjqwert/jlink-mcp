# Write Entrypoint Inventory

Validation scope: offline inventory only. No J-Link, GDB, RTT, flash, reset, halt, resume, erase, or target write was invoked by the Jlink-MCP validation tests.

| Entrypoint                   | Location                                   | Production MCP tool | Allowlisted                      | Readback verified                 | Arbitrary-address capable | Dangerous               | Used by default validation |
| ---------------------------- | ------------------------------------------ | ------------------- | -------------------------------- | --------------------------------- | ------------------------- | ----------------------- | -------------------------- |
| `write_memory`               | `src/mcp/server.ts`                        | yes                 | no                               | no                                | yes                       | yes                     | no                         |
| `gdb_command`                | `src/mcp/server.ts`                        | yes                 | no                               | caller-defined                    | yes                       | yes                     | no                         |
| `gdb_load` with `flash=true` | `src/mcp/server.ts`                        | yes                 | no                               | toolchain-defined                 | no                        | yes                     | no                         |
| `flash`                      | `src/mcp/server.ts`                        | yes                 | no                               | probe-defined                     | no                        | yes                     | no                         |
| `erase`                      | `src/mcp/server.ts`                        | yes                 | no                               | no                                | no                        | yes                     | no                         |
| `probe_command`              | `src/mcp/server.ts`                        | yes                 | no                               | no                                | yes                       | yes                     | no                         |
| `capture_control`            | `src/mcp/server.ts`                        | yes                 | reviewed start/stop mapping only | yes, through capture control path | no                        | conditionally dangerous | no                         |
| `capture_stop` stop mapping  | `src/mcp/server.ts` / `src/mcp/capture.ts` | yes                 | reviewed stop mapping only       | yes                               | no                        | safety-critical         | no                         |
| Probe backend `writeMemory`  | `src/probe/*`                              | backend API         | no                               | no                                | yes                       | yes                     | no                         |
| Probe backend `executeRaw`   | `src/probe/*`                              | backend API         | no                               | no                                | yes                       | yes                     | no                         |

Decision: default HM_C095 validation uses only `src/mcp/write/*` fake memory and policy checks. It does not route through production write, raw GDB, raw probe, capture control, or hardware paths.
