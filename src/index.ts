#!/usr/bin/env node

/**
 * Terminal MCP Server — multiplexed terminal sessions for Claude Code.
 *
 * Manages named terminal sessions via tmux. Lets AI agents spawn shells,
 * run commands, read output, and orchestrate multiple concurrent processes.
 *
 * Setup in ~/.claude/mcp.json:
 *   { "servers": { "terminal": {
 *       "command": "npx",
 *       "args": ["@quantum-encoding-europe-limited/terminal-mcp"]
 *   }}}
 *
 * Or run directly:
 *   npx @quantum-encoding-europe-limited/terminal-mcp
 *
 * Requires: tmux installed and available in PATH.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "node:child_process";

// ── Config ──

/** Detect the current tmux session, or fall back to env/default. */
function detectTmuxSession(): string {
  if (process.env.TERMINAL_MCP_SESSION) return process.env.TERMINAL_MCP_SESSION;
  // If we're inside tmux, use the current session
  if (process.env.TMUX) {
    try {
      return execSync("tmux display-message -p '#S'", { stdio: "pipe", encoding: "utf-8" }).trim();
    } catch { /* fall through */ }
  }
  return "mcp-terminals";
}
const TMUX_SESSION = detectTmuxSession();
const MAX_OUTPUT_LINES = parseInt(process.env.TERMINAL_MCP_MAX_LINES || "200", 10);
const SHELL = process.env.SHELL || "/bin/bash";

/** Escape a string for safe use in shell commands. */
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── tmux helpers ──

function tmuxExists(): boolean {
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function ensureSession(): void {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`, { stdio: "pipe" });
  } catch {
    // Create detached session with a placeholder window
    execSync(`tmux new-session -d -s ${TMUX_SESSION} -n _init`, { stdio: "pipe" });
  }
}

function tmux(cmd: string): string {
  try {
    return execSync(`tmux ${cmd}`, { stdio: "pipe", encoding: "utf-8" }).trim();
  } catch (e: any) {
    throw new Error(`tmux error: ${e.stderr || e.message}`);
  }
}

/** Strip leading non-alphanumeric characters (spinner prefixes like ✳, ⏺, ✽). */
function cleanName(raw: string): string {
  return raw.replace(/^[^a-zA-Z0-9]+/, "").trim();
}

/** Find a pane by name — exact match first, then substring/cleaned match. */
function findPane(name: string): PaneInfo | undefined {
  const panes = listPanes();
  return panes.find((p) => p.name === name)
    || panes.find((p) => cleanName(p.name) === name)
    || panes.find((p) => p.name.includes(name))
    || panes.find((p) => cleanName(p.name).includes(name));
}

/** Strip ANSI escape codes from terminal output. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
             .replace(/\x1b\][^\x07]*\x07/g, "")     // OSC sequences
             .replace(/\x1b[()][AB012]/g, "")          // charset
             .replace(/\r/g, "");
}

/** Get list of panes in our session. */
interface PaneInfo {
  name: string;
  index: string;
  pid: string;
  cwd: string;
  command: string;
  active: boolean;
  width: number;
  height: number;
}

function listPanes(): PaneInfo[] {
  ensureSession();
  try {
    const raw = tmux(
      `list-panes -t ${TMUX_SESSION} -F "#{pane_index}|#{pane_title}|#{pane_pid}|#{pane_current_path}|#{pane_current_command}|#{pane_active}|#{pane_width}|#{pane_height}"`
    );
    return raw.split("\n").filter(Boolean).map((line) => {
      const [index, name, pid, cwd, command, active, width, height] = line.split("|");
      return {
        name: name || `pane-${index}`,
        index,
        pid,
        cwd,
        command,
        active: active === "1",
        width: parseInt(width, 10),
        height: parseInt(height, 10),
      };
    });
  } catch {
    return [];
  }
}

/** Capture visible pane content. */
function capturePane(paneIndex: string, lines?: number): string {
  const limit = lines || MAX_OUTPUT_LINES;
  const raw = tmux(`capture-pane -t ${TMUX_SESSION}:0.${paneIndex} -p -S -${limit}`);
  return stripAnsi(raw);
}

// ── MCP Server ──

const server = new McpServer({
  name: "terminal",
  version: "0.1.0",
});

// ── Tools ──

server.tool(
  "terminal_list",
  "List all active terminal sessions with their names, PIDs, working directories, and current commands.",
  {},
  async () => {
    if (!tmuxExists()) {
      return { content: [{ type: "text", text: "Error: tmux is not installed. Install with: brew install tmux (macOS) or apt install tmux (Linux)" }] };
    }

    const panes = listPanes();
    if (panes.length === 0) {
      return { content: [{ type: "text", text: "No active terminal sessions. Use terminal_spawn to create one." }] };
    }

    const table = panes.map((p) =>
      `  ${cleanName(p.name) || p.name} (pane ${p.index}) — PID ${p.pid}, ${p.command} in ${p.cwd}`
    ).join("\n");

    return {
      content: [{ type: "text", text: `Active terminals (tmux session: ${TMUX_SESSION}):\n${table}` }],
    };
  }
);

server.tool(
  "terminal_spawn",
  `Spawn a new named terminal session. Optionally start it in a specific directory and/or run a command immediately.

Use 'mode' to control how Claude sessions run:
- "interactive" (default): Normal foreground session with permission prompts.
- "background": Auto-allows safe tools (Bash, Edit, Read, Write, Glob, Grep, Agent) but blocks destructive git commands (force push, reset --hard, branch -D, clean -f) and rm -rf. Best when you want autonomous work with guardrails.
- "resume": Resume an existing Claude session by name with the same background safety guardrails.`,
  {
    name: z.string().describe("Name for this terminal (e.g. 'backend', 'tests', 'server')"),
    cwd: z.string().optional().describe("Working directory to start in"),
    command: z.string().optional().describe("Command to run immediately after spawning (e.g. 'npm run dev')"),
    shell: z.string().optional().describe("Shell to use (default: $SHELL)"),
    mode: z.enum(["interactive", "background", "resume"]).optional()
      .describe("Session mode: 'interactive' (default), 'background' (skip permissions), 'resume' (resume existing session)"),
  },
  async ({ name, cwd, command, shell: shellOverride, mode }) => {
    if (!tmuxExists()) {
      return { content: [{ type: "text", text: "Error: tmux is not installed" }] };
    }

    ensureSession();

    // Check if name already exists
    const existing = findPane(name);
    if (existing) {
      return { content: [{ type: "text", text: `Terminal '${name}' already exists (pane ${existing.index}). Use terminal_send to interact with it.` }] };
    }

    // Build launch command based on mode
    // Background mode uses --allowedTools for safe operations and
    // --disallowedTools to block destructive git commands.
    // NEVER use --dangerously-skip-permissions — it bypasses all safety.
    const backgroundFlags = [
      '--allowedTools "Bash(*) Edit Read Write Glob Grep Agent"',
      '--disallowedTools "Bash(git push --force*) Bash(git reset --hard*) Bash(git checkout -- *) Bash(git clean -f*) Bash(git branch -D*) Bash(rm -rf*) Bash(rm -r *)"',
    ].join(" ");

    let launchCmd = command || "";
    if (!command && mode === "background") {
      launchCmd = `claude ${backgroundFlags}`;
    } else if (!command && mode === "resume") {
      launchCmd = `claude --resume "${name}" ${backgroundFlags}`;
    }

    // Create a new pane
    const cdFlag = cwd ? `-c ${shellEscape(cwd)}` : "";
    const useShell = shellOverride || SHELL;
    tmux(`split-window -t ${TMUX_SESSION} ${cdFlag} ${shellEscape(useShell)}`);

    // Get the new pane's index (last one created)
    const panes = listPanes();
    const newPane = panes[panes.length - 1];

    // Set the pane title
    if (newPane) {
      tmux(`select-pane -t ${TMUX_SESSION}:0.${newPane.index} -T "${name}"`);

      // Re-tile for clean layout
      try { tmux(`select-layout -t ${TMUX_SESSION} tiled`); } catch { /* ignore */ }

      // Send launch command
      if (launchCmd) {
        tmux(`send-keys -t ${TMUX_SESSION}:0.${newPane.index} -- ${shellEscape(launchCmd)} Enter`);
      }
    }

    const modeLabel = mode === "background" ? " (background, safe tools only, destructive ops blocked)"
      : mode === "resume" ? ` (resuming session '${name}', safe tools only)`
      : "";

    return {
      content: [{ type: "text", text: `Spawned terminal '${name}' (pane ${newPane?.index})${cwd ? ` in ${cwd}` : ""}${launchCmd ? `, running: ${launchCmd}` : ""}${modeLabel}` }],
    };
  }
);

server.tool(
  "terminal_send",
  "Send input (keystrokes) to a named terminal session. Use this to type commands, answer prompts, or send signals.",
  {
    name: z.string().describe("Terminal name to send input to"),
    input: z.string().describe("Text to type into the terminal"),
    enter: z.boolean().optional().describe("Press Enter after the input (default: true)"),
  },
  async ({ name, input, enter }) => {
    const pane = findPane(name);
    if (!pane) {
      const available = listPanes().map((p) => p.name).join(", ");
      return { content: [{ type: "text", text: `Terminal '${name}' not found. Available: ${available || "none"}` }] };
    }

    // For short input, use send-keys directly. For longer input, use
    // load-buffer + paste-buffer to avoid escaping issues and freezes.
    if (input.length <= 80 && !input.includes("'") && !input.includes("\n")) {
      tmux(`send-keys -t ${TMUX_SESSION}:0.${pane.index} -- ${shellEscape(input)} ${enter !== false ? "Enter" : ""}`);
    } else {
      const tmp = `/tmp/tmux-mcp-${Date.now()}.txt`;
      require("node:fs").writeFileSync(tmp, input);
      tmux(`load-buffer ${tmp}`);
      tmux(`paste-buffer -t ${TMUX_SESSION}:0.${pane.index}`);
      require("node:fs").unlinkSync(tmp);
      if (enter !== false) {
        tmux(`send-keys -t ${TMUX_SESSION}:0.${pane.index} Enter`);
      }
    }

    // Brief pause to let output appear, then capture
    await new Promise((r) => setTimeout(r, 300));
    const output = capturePane(pane.index, 30);
    const lastLines = output.split("\n").filter(Boolean).slice(-15).join("\n");

    return {
      content: [{ type: "text", text: `Sent to '${name}': ${input}\n\nRecent output:\n${lastLines}` }],
    };
  }
);

server.tool(
  "terminal_read",
  "Read the current visible output from a terminal session. Returns the last N lines of output with ANSI codes stripped.",
  {
    name: z.string().describe("Terminal name to read from"),
    lines: z.number().optional().describe("Number of lines to capture (default: 50, max: 500)"),
  },
  async ({ name, lines }) => {
    const pane = findPane(name);
    if (!pane) {
      const available = listPanes().map((p) => p.name).join(", ");
      return { content: [{ type: "text", text: `Terminal '${name}' not found. Available: ${available || "none"}` }] };
    }

    const limit = Math.min(lines || 50, 500);
    const output = capturePane(pane.index, limit);

    return {
      content: [{ type: "text", text: `Output from '${name}' (last ${limit} lines):\n\n${output}` }],
    };
  }
);

server.tool(
  "terminal_close",
  "Close a terminal session by name. Sends SIGTERM to the process running in the pane.",
  {
    name: z.string().describe("Terminal name to close"),
    force: z.boolean().optional().describe("Force kill with SIGKILL if SIGTERM doesn't work (default: false)"),
  },
  async ({ name, force }) => {
    const pane = findPane(name);
    if (!pane) {
      return { content: [{ type: "text", text: `Terminal '${name}' not found` }] };
    }

    if (force) {
      tmux(`kill-pane -t ${TMUX_SESSION}:0.${pane.index}`);
    } else {
      // Send Ctrl+C then Ctrl+D for graceful shutdown
      tmux(`send-keys -t ${TMUX_SESSION}:0.${pane.index} C-c`);
      await new Promise((r) => setTimeout(r, 500));
      tmux(`send-keys -t ${TMUX_SESSION}:0.${pane.index} C-d`);
      await new Promise((r) => setTimeout(r, 500));

      // Check if still alive
      const stillThere = findPane(name);
      if (stillThere) {
        tmux(`kill-pane -t ${TMUX_SESSION}:0.${stillThere.index}`);
      }
    }

    return {
      content: [{ type: "text", text: `Closed terminal '${name}'` }],
    };
  }
);

server.tool(
  "terminal_send_signal",
  "Send a signal to a terminal session (Ctrl+C to interrupt, Ctrl+Z to suspend, Ctrl+D to EOF, etc).",
  {
    name: z.string().describe("Terminal name"),
    signal: z.enum(["ctrl-c", "ctrl-d", "ctrl-z", "ctrl-l", "ctrl-\\"])
      .describe("Signal to send: ctrl-c (interrupt), ctrl-d (EOF), ctrl-z (suspend), ctrl-l (clear), ctrl-\\ (quit)"),
  },
  async ({ name, signal }) => {
    const pane = findPane(name);
    if (!pane) {
      return { content: [{ type: "text", text: `Terminal '${name}' not found` }] };
    }

    const keyMap: Record<string, string> = {
      "ctrl-c": "C-c",
      "ctrl-d": "C-d",
      "ctrl-z": "C-z",
      "ctrl-l": "C-l",
      "ctrl-\\": "C-\\\\",
    };

    tmux(`send-keys -t ${TMUX_SESSION}:0.${pane.index} ${keyMap[signal]}`);

    await new Promise((r) => setTimeout(r, 300));
    const output = capturePane(pane.index, 10);
    const lastLines = output.split("\n").filter(Boolean).slice(-5).join("\n");

    return {
      content: [{ type: "text", text: `Sent ${signal} to '${name}'\n\nRecent output:\n${lastLines}` }],
    };
  }
);

server.tool(
  "terminal_resize",
  "Resize a terminal pane (useful before reading output from width-sensitive programs).",
  {
    name: z.string().describe("Terminal name"),
    width: z.number().optional().describe("New width in columns"),
    height: z.number().optional().describe("New height in rows"),
  },
  async ({ name, width, height }) => {
    const pane = findPane(name);
    if (!pane) {
      return { content: [{ type: "text", text: `Terminal '${name}' not found` }] };
    }

    if (width) {
      tmux(`resize-pane -t ${TMUX_SESSION}:0.${pane.index} -x ${width}`);
    }
    if (height) {
      tmux(`resize-pane -t ${TMUX_SESSION}:0.${pane.index} -y ${height}`);
    }

    return {
      content: [{ type: "text", text: `Resized '${name}' to ${width || pane.width}x${height || pane.height}` }],
    };
  }
);

server.tool(
  "terminal_snapshot",
  "Take a snapshot of all terminals — names, commands, last few lines of output. Useful for getting an overview of what's happening across all sessions.",
  {},
  async () => {
    const panes = listPanes();
    if (panes.length === 0) {
      return { content: [{ type: "text", text: "No active terminals." }] };
    }

    const snapshots = panes.map((p) => {
      const output = capturePane(p.index, 10);
      const lastLines = output.split("\n").filter(Boolean).slice(-5).join("\n");
      return `── ${p.name} (${p.command} in ${p.cwd}) ──\n${lastLines}`;
    });

    return {
      content: [{ type: "text", text: snapshots.join("\n\n") }],
    };
  }
);

server.tool(
  "terminal_wait",
  "Wait for a terminal to show specific output (e.g. 'Server ready' or '$ '). Polls every second up to the timeout. Useful for waiting for builds, servers to start, etc.",
  {
    name: z.string().describe("Terminal name to watch"),
    pattern: z.string().describe("Text pattern to wait for (substring match, case-insensitive)"),
    timeout: z.number().optional().describe("Max seconds to wait (default: 30, max: 120)"),
  },
  async ({ name, pattern, timeout }) => {
    const pane = findPane(name);
    if (!pane) {
      return { content: [{ type: "text", text: `Terminal '${name}' not found` }] };
    }

    const maxWait = Math.min(timeout || 30, 120);
    const lowerPattern = pattern.toLowerCase();

    for (let i = 0; i < maxWait; i++) {
      const output = capturePane(pane.index, 30).toLowerCase();
      if (output.includes(lowerPattern)) {
        const fullOutput = capturePane(pane.index, 20);
        return {
          content: [{ type: "text", text: `Pattern "${pattern}" found in '${name}' after ${i}s:\n\n${fullOutput}` }],
        };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const finalOutput = capturePane(pane.index, 20);
    return {
      content: [{ type: "text", text: `Timeout (${maxWait}s) waiting for "${pattern}" in '${name}'. Last output:\n\n${finalOutput}` }],
    };
  }
);

// ── Start ──

async function main() {
  // Quick sanity check
  if (!tmuxExists()) {
    process.stderr.write("Warning: tmux not found in PATH. Install tmux to use this server.\n");
    process.stderr.write("  macOS: brew install tmux\n");
    process.stderr.write("  Linux: apt install tmux / dnf install tmux\n");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("Terminal MCP server running\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
