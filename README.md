# bashpilot

Shared console MCP server for bash. AI and user work in the same terminal session.

## What This Does

AI calls `start_console` and a bash terminal window opens. You type commands as usual. When AI sends commands via MCP, they appear in the same terminal — you see every command and its output in real time. Session state (cwd, env vars, functions) persists across calls.

This is the same "shared console" concept as [PowerShell.MCP](https://github.com/yotsuda/PowerShell.MCP), implemented for bash using [VS Code's shell integration](https://code.visualstudio.com/docs/terminal/shell-integration) approach (OSC 633 escape sequences).

## Architecture

```mermaid
graph TB
    Client["MCP Client<br/>(Claude Code, etc.)"]

    subgraph MCP["bashpilot MCP server (stdio)"]
        CM["Console<br/>Manager"]
        Tools["start_console<br/>execute_command"]
    end

    subgraph Consoles["Visible Terminal Windows"]
        subgraph C1["#9876 Falcon"]
            PTY1["PTY + bash<br/>(+ OSC 633)"]
        end
        subgraph C2["#5432 Cobalt"]
            PTY2["PTY + bash<br/>(+ OSC 633)"]
        end
    end

    Client -- "stdio" --> MCP
    CM -- "Unix socket / TCP" --> C1
    CM -- "Unix socket / TCP" --> C2
    CM -. "auto-switch<br/>if busy" .-> C2
```

## Quick Start

### Register with Claude Code

```bash
claude mcp add bashpilot -- npx bashpilot
```

That's it. Claude Code will start bashpilot automatically. When AI calls `start_console`, a terminal window opens.

### Or install globally

```bash
npm install -g bashpilot
claude mcp add bashpilot -- bashpilot
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `start_console` | Open a visible bash terminal window. Returns system info (user, hostname, OS). Reuses standby console if available. Pass `reason` to force a new one. |
| `execute_command` | Run a command in the shared terminal. Output is visible to user in real time and returned via MCP. If the active console is busy, auto-switches to a standby or launches a new one. |

## How It Works

1. **MCP client starts bashpilot** via stdio (no manual terminal startup needed).

2. **`start_console`** launches a visible terminal window running bash with shell integration. The window is named (e.g., "bashpilot — #9876 Falcon"). System info is returned in the response.

3. **Shell integration**: A small script hooks into `PROMPT_COMMAND` and the `DEBUG` trap to emit OSC 633 markers for command lifecycle tracking.

4. **`execute_command`** writes the command to the PTY. The user sees it in the terminal. Output is captured and returned via MCP. If the active console is busy, bashpilot automatically switches to a standby console or launches a new one (without executing — the client is asked to verify the directory and re-execute).

5. **Dual streaming**: Output goes to the terminal (user sees it) AND is captured for the MCP response simultaneously.

6. **Console discovery**: Each console listens on a Unix domain socket (or TCP with port file on Windows) with a naming convention that encodes ownership. The proxy discovers consoles by scanning the filesystem.

## Supported Platforms

- Linux (native bash)
- macOS (native bash / zsh with bash installed)
- Windows (Git Bash via MSYS2)

## Limitations

- Only one command per console at a time (auto-switches to new console if busy)
- Very long output (>1MB) is truncated
- Interactive commands (vi, top, etc.) are not supported via MCP
- The user must keep the terminal window(s) open
- Characters typed during console startup may interfere with the first AI command

## License

MIT
