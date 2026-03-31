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
      "args": ["@quantum-encoding-europe-limited/terminal-mcp"]
    }
  }
}
```

Or run directly:

```bash
npx @quantum-encoding-europe-limited/terminal-mcp
```

## Tools

| Tool | Description |
|------|-------------|
| `terminal_list` | List all active sessions (name, PID, cwd, command) |
| `terminal_spawn` | Create a named session with optional cwd, startup command, and mode |
| `terminal_send` | Type text into a session (keystrokes via tmux send-keys) |
| `terminal_read` | Read last N lines from a session (ANSI-stripped) |
| `terminal_close` | Graceful close (Ctrl+C, Ctrl+D, then kill) |
| `terminal_send_signal` | Send Ctrl+C/D/Z/L/\\ to a session |
| `terminal_resize` | Resize pane dimensions |
| `terminal_snapshot` | Overview of ALL sessions — last 5 lines each |
| `terminal_wait` | Poll until output matches a pattern (e.g. "Server ready") |

## Spawn Modes

`terminal_spawn` supports a `mode` parameter for controlling how Claude sessions run:

| Mode | Behaviour |
|------|-----------|
| `interactive` | **(default)** Normal foreground session with permission prompts. Best when you need to approve tool calls. |
| `background` | Auto-allows safe tools (Bash, Edit, Read, Write, Glob, Grep, Agent) but **blocks destructive ops** (git force push, git reset --hard, git branch -D, git clean -f, rm -rf). Best for autonomous work with guardrails. |
| `resume` | Resume an existing Claude session by name, with the same background safety guardrails. |

```
terminal_spawn("scanner", cwd="/my/project", mode="background")
// Launches: claude --allowedTools "Bash(*) Edit Read Write Glob Grep Agent"
//                  --disallowedTools "Bash(git push --force*) Bash(git reset --hard*) ..."

terminal_spawn("scanner", mode="resume")
// Launches: claude --resume "scanner" --allowedTools ... --disallowedTools ...
```

**Note:** Background mode never uses `--dangerously-skip-permissions`. It uses curated allow/deny lists so agents can work autonomously without being able to force-push, delete branches, or wipe files.

## Examples

### Run a dev server and wait for it

```
terminal_spawn("server", cwd="/my/project", command="npm run dev")
terminal_wait("server", pattern="ready on port 3000")
```

### Orchestrate multiple Claude sessions

```
# Spawn specialists in background mode (no permission prompts)
terminal_spawn("backend", cwd="/work/api", mode="background")
terminal_spawn("frontend", cwd="/work/app", mode="background")

# Wait for Claude to start, then send tasks
terminal_wait("backend", pattern="? for shortcuts")
terminal_send("backend", "add input validation to the POST /users endpoint")

terminal_wait("frontend", pattern="? for shortcuts")
terminal_send("frontend", "update the user form to match the new API validation")
```

### Monitor everything at once

```
terminal_snapshot()  # see last 5 lines from every session
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `TERMINAL_MCP_SESSION` | auto-detected / `mcp-terminals` | tmux session name |
| `TERMINAL_MCP_MAX_LINES` | `200` | Default line capture limit |

If running inside tmux, the current session is auto-detected. Otherwise falls back to `TERMINAL_MCP_SESSION` or creates `mcp-terminals`.

## How it works

All terminal management goes through tmux:
- `terminal_spawn` → `tmux split-window` + `tmux select-pane -T`
- `terminal_send` → `tmux send-keys` (short input) or `tmux load-buffer` + `paste-buffer` (long input, avoids escaping issues)
- `terminal_read` → `tmux capture-pane -p`
- `terminal_close` → `tmux kill-pane`

Name matching is fuzzy — handles tmux title prefixes (like Claude's spinner characters ✳ ✽ ⏺) automatically.

## License

MIT
