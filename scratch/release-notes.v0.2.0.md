## What's New

### File Operation Tools
Node.js native file tools (not PTY-based) for stable file editing:
- **read_file** — line numbers, offset/limit paging, tail (last N lines via ring buffer)
- **write_file** — create/overwrite
- **edit_file** — exact string replacement with uniqueness check, replace_all option
- **search_files** — streaming regex search with early termination
- **find_files** — glob pattern file discovery

All tools use single-pass streaming, binary file detection, and skip common non-content directories.

### Unowned Console Support
- Console can start without a proxy (`bashpilot --console`)
- Proxy discovers and claims unowned consoles automatically
- When proxy disconnects, console reverts to unowned state (5s liveness check)
- Reclaimed by new proxy session seamlessly

### Console Management Improvements
- Cached outputs collected on every response (success, switch, timeout)
- Timeout response includes busy status + wait_for_completion instruction
- Title set on console reuse
- Dead console detection with auto-launch
- Default timeout increased to 170s (matching PowerShell.MCP)

### CI
- GitHub Actions: Ubuntu, macOS, Windows x Node 18, 22 (6 matrix)
- 62 unit tests passing on all platforms

## Install / Upgrade

\`\`\`bash
# Claude Code
claude mcp add bashpilot -- npx bashpilot

# Claude Desktop: add to config
{"mcpServers":{"bashpilot":{"command":"npx","args":["bashpilot"]}}}
\`\`\`
