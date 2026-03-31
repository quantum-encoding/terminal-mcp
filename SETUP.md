# Terminal MCP — Optimal Setup Guide

This file is designed to be read by Claude Code to self-configure the terminal MCP server. Ask Claude: "read SETUP.md from the terminal-mcp package and configure my environment."

## Step 1: Install tmux

```bash
# macOS
brew install tmux

# Linux (Debian/Ubuntu)
sudo apt install tmux

# Linux (Fedora)
sudo dnf install tmux
```

## Step 2: Add MCP server config

Add to `~/.claude/mcp.json` (global) or `.mcp.json` (per-project):

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

## Step 3: Enable tmux mouse scrolling

Add to `~/.tmux.conf` (create if it doesn't exist):

```
set -g mouse on
```

Then reload: `tmux source-file ~/.tmux.conf`

## Step 4: Configure project permissions

For background mode (autonomous agents) to work without permission prompts,
add a `.claude/settings.local.json` to each project you'll orchestrate from:

```json
{
  "permissions": {
    "allow": [
      "Bash(grep:*)",
      "Bash(find:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(wc:*)",
      "Bash(git status*)",
      "Bash(git log*)",
      "Bash(git diff*)",
      "Bash(git add*)",
      "Bash(git commit*)",
      "Bash(git push)",
      "Bash(git push origin*)",
      "Bash(npm run*)",
      "Bash(npm install*)",
      "Bash(cargo build*)",
      "Bash(cargo check*)",
      "Bash(cargo test*)",
      "Bash(go build*)",
      "Bash(go test*)",
      "Bash(go run*)",
      "Read(/Users/$USER/work/**)"
    ],
    "deny": [
      "Bash(git push --force*)",
      "Bash(git reset --hard*)",
      "Bash(git checkout -- *)",
      "Bash(git clean -f*)",
      "Bash(git branch -D*)",
      "Bash(rm -rf*)",
      "Bash(rm -r *)"
    ]
  }
}
```

Adjust the `Read()` path to match your workspace root. This allows Claude to
read files across sibling projects (needed for cross-repo scanning/auditing).

## Step 5: Start a tmux session

```bash
# Start a named session
tmux new-session -s work

# The terminal MCP auto-detects the current tmux session.
# All spawned panes appear in your existing session.
```

## How the modes work

### Interactive (default)
```
terminal_spawn({ name: "dev", cwd: "/my/project" })
```
Opens a shell. You manually run `claude` and interact normally.

### Background (autonomous agents)
```
terminal_spawn({ name: "scanner", cwd: "/my/project", mode: "background" })
```
Launches Claude with `--allowedTools` for safe operations and `--disallowedTools`
blocking destructive git/rm commands. No permission prompts — Claude works autonomously.

**Allowed in background mode:** Bash, Edit, Read, Write, Glob, Grep, Agent
**Blocked in background mode:** git force push, git reset --hard, git branch -D, git clean -f, rm -rf

### Resume (continue previous session)
```
terminal_spawn({ name: "scanner", mode: "resume" })
```
Resumes an existing Claude session by name with the same background safety guardrails.

## Orchestration patterns

### Fan-out: dispatch tasks to multiple specialists
```
// Spawn specialists
terminal_spawn({ name: "backend", cwd: "/work/api", mode: "background" })
terminal_spawn({ name: "frontend", cwd: "/work/app", mode: "background" })

// Wait for Claude to start (auto-detects permission prompts)
terminal_wait({ name: "backend", pattern: "? for shortcuts" })
terminal_wait({ name: "frontend", pattern: "? for shortcuts" })

// Send tasks
terminal_send({ name: "backend", input: "add input validation to POST /users" })
terminal_send({ name: "frontend", input: "update the form to match the new API" })
```

### Monitor + approve: handle permission prompts
```
// terminal_wait returns [permission_needed] if a prompt appears
result = terminal_wait({ name: "worker", pattern: "Done", timeout: 120 })

// If permission prompt detected, approve it
if result includes "[permission_needed]":
    terminal_send({ name: "worker", input: "" })  // Enter to confirm
```

### Snapshot: check all sessions at once
```
terminal_snapshot()
// Returns last 5 lines from every active pane
```

## Troubleshooting

**Pane names keep changing:** Claude Code overwrites tmux pane titles with
spinner characters. The MCP handles this via fuzzy name matching — it strips
non-alphanumeric prefixes and does substring matching automatically.

**Long messages freeze terminal:** Messages over 80 chars use tmux `load-buffer`
+ `paste-buffer` instead of `send-keys` to avoid shell escaping issues.

**MCP server not appearing:** Each project needs its own `.mcp.json` (or use
the global `~/.claude/mcp.json`). Project-level configs override global.

**Permission prompts blocking agents:** Either use `mode: "background"` when
spawning, or add permissions to `.claude/settings.local.json` in the project.
