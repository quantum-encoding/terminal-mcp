# Terminal MCP Server

MCP server for managing multiplexed terminal sessions via tmux. Lets AI agents spawn, send input to, read output from, and orchestrate multiple concurrent terminal sessions.

## Why

Claude Code (and other MCP clients) can run shell commands, but can't manage long-running processes, interactive sessions, or multiple concurrent terminals. This server bridges that gap using tmux as the multiplexer.

**Key use case: multi-agent orchestration.** Run multiple Claude Code sessions in tmux panes, then use `terminal_send` to type messages into any session — from the target's perspective, a human just typed. This enables Claude-to-Claude communication with full context and permissions.

## Install

Requires [tmux](https://github.com/tmux/tmux) installed and in PATH.

Add to your Claude Code MCP config (`~/.claude/mcp.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "terminal": {
      "command": "npx",
      "args": ["@anthropic-community/terminal-mcp"]
    }
  }
}
```

Or run directly:

```bash
npx @anthropic-community/terminal-mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `terminal_list` | List all active sessions (name, PID, cwd, command) |
| `terminal_spawn` | Create a named session with optional cwd + startup command |
| `terminal_send` | Type text into a session (keystrokes via tmux send-keys) |
| `terminal_read` | Read last N lines from a session (ANSI-stripped) |
| `terminal_close` | Graceful close (Ctrl+C, Ctrl+D, then kill) |
| `terminal_send_signal` | Send Ctrl+C/D/Z/L/\\ to a session |
| `terminal_resize` | Resize pane dimensions |
| `terminal_snapshot` | Overview of ALL sessions — last 5 lines each |
| `terminal_wait` | Poll until output matches a pattern (e.g. "Server ready") |

## Examples

### Run a dev server and wait for it

```
terminal_spawn("server", cwd="/my/project", command="npm run dev")
terminal_wait("server", pattern="ready on port 3000")
```

### Orchestrate multiple Claude sessions

```
# Sessions already running in tmux panes:
terminal_send("backend-claude", "add validation to the create endpoint")
terminal_wait("backend-claude", pattern="? for shortcuts")  # wait for completion
terminal_read("backend-claude", lines=30)  # read the response

terminal_send("frontend-claude", "update the form to match the new API")
```

### Monitor everything at once

```
terminal_snapshot()  # see last 5 lines from every session
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `TERMINAL_MCP_SESSION` | `mcp-terminals` | tmux session name |
| `TERMINAL_MCP_MAX_LINES` | `200` | Default line capture limit |

## How it works

All terminal management goes through tmux:
- `terminal_spawn` → `tmux split-window` + `tmux select-pane -T`
- `terminal_send` → `tmux send-keys`
- `terminal_read` → `tmux capture-pane -p`
- `terminal_close` → `tmux kill-pane`

Name matching is fuzzy — handles tmux title prefixes (like Claude's spinner characters) automatically.

## License

MIT
