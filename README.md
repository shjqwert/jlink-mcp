<p align="center">
  <img src="logo.png" alt="jlink-mcp logo" width="200">
</p>

<h1 align="center">jlink-mcp</h1>

<p align="center">
  <strong>Give AI hands to touch silicon.</strong><br>
  An MCP server that lets LLMs debug embedded devices through SEGGER J-Link probes.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Server-blue?style=for-the-badge" alt="MCP Server">
  <img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/J--Link-SEGGER-00979D?style=for-the-badge" alt="J-Link">
  <img src="https://img.shields.io/badge/ARM-Cortex--M-0091BD?style=for-the-badge" alt="ARM Cortex-M">
</p>

<p align="center">
  <a href="https://github.com/Klievan/jlink-mcp/stargazers"><img src="https://img.shields.io/github/stars/Klievan/jlink-mcp?style=flat-square" alt="GitHub Stars"></a>
  <a href="https://github.com/Klievan/jlink-mcp/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Klievan/jlink-mcp?style=flat-square" alt="License"></a>
  <a href="https://www.npmjs.com/package/jlink-mcp"><img src="https://img.shields.io/npm/v/jlink-mcp?style=flat-square&color=cb0000" alt="npm"></a>
  <a href="https://www.npmjs.com/package/jlink-mcp"><img src="https://img.shields.io/npm/dt/jlink-mcp?style=flat-square&color=cb0000" alt="npm downloads"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Klievan.jlink-mcp"><img src="https://img.shields.io/visual-studio-marketplace/v/Klievan.jlink-mcp?style=flat-square&label=VSCode" alt="VSCode Marketplace"></a>
  <a href="https://smithery.ai/server/@Klievan/jlink-mcp"><img src="https://smithery.ai/badge/@Klievan/jlink-mcp" alt="Smithery"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-Compatible-green?style=flat-square" alt="MCP Compatible"></a>
</p>

---

## What is this?

**jlink-mcp** connects AI assistants (Claude, Copilot, etc.) to your embedded hardware via [SEGGER J-Link](https://www.segger.com/products/debug-probes/j-link/) debug probes using the [Model Context Protocol](https://modelcontextprotocol.io).

Instead of manually typing J-Link commands, your AI assistant can:

- **Read registers and memory** to understand device state
- **Flash firmware** and reset devices
- **Stream RTT logs** and search them by level/module/regex
- **Diagnose crashes** by auto-decoding ARM Cortex-M fault registers
- **Control execution** — halt, resume, reset
- **Start GDB servers** for full debugging sessions

## Quick Start

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "jlink": {
      "command": "node",
      "args": ["/path/to/jlink-mcp/out/mcp/standalone.js"],
      "env": {
        "JLINK_DEVICE": "nRF52840_XXAA"
      }
    }
  }
}
```

### Claude Code

Add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "jlink": {
      "command": "node",
      "args": ["out/mcp/standalone.js"],
      "cwd": "/path/to/jlink-mcp",
      "env": {
        "JLINK_DEVICE": "nRF52840_XXAA"
      }
    }
  }
}
```

### VSCode Extension

Install the extension (requires VSCode 1.99+). It auto-registers the MCP server via the native `vscode.lm` API. Configure the device in settings:

```
jlinkMcp.jlink.device = "nRF52840_XXAA"
```

Copilot Chat and Claude in VSCode will automatically discover the registered tools.

### From Source

```bash
git clone https://github.com/Klievan/jlink-mcp.git
cd jlink-mcp
npm install
npm run compile
JLINK_DEVICE=nRF52840_XXAA node out/mcp/standalone.js
```

## Tools

### Workflow Tools (start here)

| Tool | Description |
|------|-------------|
| `start_debug_session` | **One-call setup.** Starts GDB server + connects RTT + returns boot log. |
| `snapshot` | Captures full device state: registers, fault status, stack dump, RTT output. |
| `diagnose_crash` | Auto-reads and decodes ARM Cortex-M fault registers (CFSR, HFSR, MMFAR, BFAR) with exception stack frame. |

### Device Control

| Tool | Description |
|------|-------------|
| `device_info` | Probe type, target CPU, compact register summary |
| `halt` | Halt CPU |
| `resume` | Resume CPU |
| `reset` | Reset device (optionally halt after reset) |

### Memory & Registers

| Tool | Description |
|------|-------------|
| `read_memory` | Read memory at address (clean hex dump output) |
| `read_registers` | All CPU registers in compact format |
| `read_register` | Read specific register (PC, SP, R0-R12, etc.) |

### Flash

| Tool | Description |
|------|-------------|
| `flash_plan` → `flash` | Plan and execute an approved firmware flash |
| `erase_plan` → `erase` | Plan and execute an approved flash erase |

R4 execution uses one protected local step: run `jlink-mcp approve <challengeId>` in a real TTY, verify the displayed digest and summary, and type the exact challenge ID once. The broker retains that approval in memory for one execution; no approval token is printed or passed through the Agent.

### GDB Server

| Tool | Description |
|------|-------------|
| `gdb_server_start` | Start probe's GDB server |
| `gdb_server_stop` | Stop GDB server + disconnect RTT |
| `gdb_server_status` | GDB server and RTT status |

### RTT (Real-Time Transfer)

| Tool | Description |
|------|-------------|
| `rtt_connect` | Connect to RTT telnet port |
| `rtt_disconnect` | Disconnect from RTT |
| `rtt_read` | Read recent log lines (ANSI stripped, Zephyr format parsed) |
| `rtt_search` | **Filter logs** by level (`err`/`wrn`/`inf`/`dbg`), module, or regex |
| `rtt_clear` | Clear RTT buffer |

### Artifact, HSS, and JCAP

| Tool | Description |
|------|-------------|
| `artifact_probe` | Discover content-identified target artifacts |
| `symbol_search` / `symbol_resolve` | Resolve safe runtime variable layouts |
| `hot_variable_add` / `hot_variable_refresh` | Cache and refresh validated layouts |
| `hss_capture_plan` / `hss_capture_start` | Plan and start the validated J-Link HSS path |
| `hss_capture_status` / `hss_capture_stop` | Inspect and finalize HSS captures |
| `capture_summary` / `capture_series` / `capture_event_window` | Query bounded Indexed JCAP evidence |
| `analysis_profiles` / `analysis_run` | Run deterministic analysis-v0 profiles |

### Advanced

| Tool | Description |
|------|-------------|
| `probe_command_plan` → `probe_command` | Plan and execute an approved raw probe command |
| `get_config` | Current probe and server configuration |

## Probe Backend

jlink-mcp uses the SEGGER J-Link backend in production:

```bash
PROBE_TYPE=jlink JLINK_DEVICE=nRF52840_XXAA node out/mcp/standalone.js
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    MCP Client                        │
│          (Claude, Copilot, any MCP client)           │
└──────────────────────┬──────────────────────────────┘
                       │ JSON-RPC over stdio
┌──────────────────────▼──────────────────────────────┐
│                  jlink-mcp                           │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │   Tools  │  │ Resources │  │      Prompts      │  │
│  └────┬─────┘  └────┬─────┘  └───────┬───────────┘  │
│       │              │                │              │
│  ┌────▼──────────────▼────────────────▼───────────┐  │
│  │              ProbeBackend                       │  │
│  │                   J-Link                      │  │
│  └────────────────────┬──────────────────────────┘  │
│                       │                             │
│  ┌────────────────────▼─────┐ ┌──────────────────┐  │
│  │        RTTClient         │ │  ProcessManager  │  │
│  └──────────────────────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │    Debug Probe (USB)    │
          │  → Target MCU (SWD/JTAG)│
          └─────────────────────────┘
```

### Source Layout

```
src/
├── probe/
│   ├── backend.ts      # ProbeBackend abstract class + shared utilities
│   ├── jlink.ts        # SEGGER J-Link implementation
│   └── factory.ts      # Probe creation from config
├── mcp/
│   ├── server.ts       # MCP server
│   └── standalone.ts   # Standalone entry (stdio transport)
├── rtt/
│   └── rtt-client.ts   # RTT client with ANSI stripping + Zephyr log parsing
├── utils/
│   ├── config.ts       # VSCode settings / env var config
│   ├── logger.ts       # Logging
│   └── process-manager.ts # Child process lifecycle
└── extension.ts        # VSCode extension + MCP provider registration
```

## Design Decisions (LLM-Optimized)

This server was built by having an AI use it against real hardware, then fixing every friction point:

- **Output parsing** strips 40+ lines of J-Link connection banners. Only data comes back.
- **Registers** are compact: `Core: PC=0xBF54 SP=0x20062880 ...` instead of 65 raw lines.
- **FP registers** only shown if non-zero (they're usually all zeros).
- **RTT output** has ANSI escape codes stripped and Zephyr log format parsed into structured fields.
- **Composite tools** (`start_debug_session`, `snapshot`, `diagnose_crash`) replace multi-step workflows with single calls.
- **Fault decoding** is automatic — reads CFSR/HFSR/MMFAR/BFAR and explains each bit.
- **`rtt_search`** lets you find errors without reading the entire log.

## Continuous variable capture

Windows x64 builds can capture ELF-resolved RAM scalars through validated HSS sessions and store them as JCAP packages.

Saved JCAP packages can be queried and analyzed offline with the production analysis tools.

### HSS MVP-B Scalar baseline

MVP-B Scalar is the current release baseline for HM_C095 HSS capture-time writes: 1kHz read-only capture and 1kHz scalar active write/readback have passing evidence in [docs/hss-hm-c095-1khz-fix-verification.md](docs/hss-hm-c095-1khz-fix-verification.md). Production array writes are intentionally deferred to the next phase; keep generated `.tmp/` and `.jlink-mcp/captures|exports` artifacts out of git.

## Environment Variables

### J-Link

| Variable | Default | Description |
|----------|---------|-------------|
| `PROBE_TYPE` | `jlink` | Production probe backend; other values are rejected |
| `JLINK_DEVICE` | `Unspecified` | Target device (e.g., `nRF52840_XXAA`, `STM32F407VG`) |
| `JLINK_INSTALL_DIR` | Auto-detect | Path to SEGGER J-Link installation |
| `JLINK_INTERFACE` | `SWD` | Debug interface: `SWD` or `JTAG` |
| `JLINK_SPEED` | `4000` | Connection speed in kHz |
| `JLINK_SERIAL` | | J-Link serial number (multi-probe) |
| `JLINK_GDB_PORT` | `2331` | GDB server port |
| `JLINK_RTT_PORT` | `19021` | RTT telnet port |

## Prerequisites

- **[SEGGER J-Link Software](https://www.segger.com/downloads/jlink/)** installed (JLinkExe, JLinkGDBServer)
- A J-Link debug probe connected to an ARM Cortex-M target
- Node.js 18+

## License

MIT - see [LICENSE](LICENSE)

---

<p align="center">
  Built by <a href="https://github.com/thesprkfactory">The Sprk Factory</a>
</p>
