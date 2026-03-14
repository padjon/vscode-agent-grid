# Agent Grid

Run multiple coding agents side by side in VS Code.

Agent Grid turns one native terminal tab into a pinned tmux-backed `2x2` workspace, so Claude Code, OpenCode, tests, and project commands can all run in parallel without leaving your editor.

![Agent Grid screenshot showing a pinned 2x2 terminal workspace inside VS Code](https://raw.githubusercontent.com/padjon/vscode-agent-grid/main/assets/marketplace-screenshot.png)

## Popular Agent CLIs

Agent Grid is built for terminal-first workflows and fits naturally with the most popular coding-agent CLIs.

Popularity below is inferred from GitHub stars on March 14, 2026:

1. [Gemini CLI](https://github.com/google-gemini/gemini-cli)
2. [Claude Code](https://github.com/anthropics/claude-code)
3. [OpenAI Codex CLI](https://github.com/openai/codex)
4. [Aider](https://github.com/Aider-AI/aider)
5. [Goose](https://github.com/block/goose)
6. [OpenCode](https://github.com/opencode-ai/opencode)

Whether you run one agent or mix several, Agent Grid gives each tool a fixed lane inside VS Code instead of scattering them across terminal tabs.

## Why Agent Grid

- Multi-agent workflow, one screen: keep four terminals visible in a stable grid instead of bouncing between tabs and windows
- Built inside VS Code terminals: no custom webview, no separate app, no strange UI layer
- Fast to reopen: restore the workspace on startup or recreate it in one command
- Predictable layout: every pane has a defined role, name, startup command, and working directory
- Great for real parallel work: one agent can work frontend, one backend, one tests, one ops

## What You Get

- One command: `agent-grid: Create or Recreate Workspace`
- One pinned VS Code terminal tab named `agent-grid`
- One fixed `2x2` tmux grid inside that terminal
- Optional startup commands for each pane when the workspace is created fresh
- Automatic reattach flow when a tmux session is already running
- Automatic restore on next VS Code start when the workspace was left open

## Typical Setup

Agent Grid works best when each pane has a clear purpose:

- Frontend agent
- Backend agent
- Test runner
- Infra, lint, or release tasks

Example `settings.json`:

```json
{
  "agentGrid.tmuxCommand": "tmux",
  "agentGrid.terminals": [
    {
      "name": "Frontend",
      "startupCommand": "claude",
      "cwd": "${workspaceFolder}/apps/frontend"
    },
    {
      "name": "Backend",
      "startupCommand": "opencode",
      "cwd": "${workspaceFolder}/apps/backend"
    },
    {
      "name": "Tests",
      "startupCommand": "npm run test:watch",
      "cwd": "${workspaceFolder}"
    },
    {
      "name": "Ops",
      "startupCommand": "npm run lint -- --watch",
      "cwd": "${workspaceFolder}"
    }
  ]
}
```

Supported placeholders inside `cwd` and `startupCommand`:

- `${workspaceFolder}`
- `${workspaceFolderBasename}`
- `${userHome}`

## Why It Feels Better Than Manual Tabs

When you work with multiple agents, the overhead is rarely the model. It is the window management.

Agent Grid removes that overhead:

- no hunting for the right terminal tab
- no rebuilding the same layout every morning
- no losing the context of which pane does what
- no tradeoff between staying in VS Code and getting tmux-grade pane control

## Requirements

- `tmux` must be installed and available on your `PATH`, or configured via `agentGrid.tmuxCommand`

## Command Behavior

`agent-grid: Create or Recreate Workspace`

- Creates the tmux workspace if it does not exist yet
- If the `agent-grid` tab is already open, asks whether to focus it or recreate it
- If the tmux session is still running without the terminal tab, offers to attach or recreate
- When recreating, destroys the old tmux session and rebuilds the full grid

## Best Use Cases

- Running multiple AI coding agents in parallel
- Splitting frontend, backend, and test workflows into fixed lanes
- Keeping an always-on command pane for lint, builds, or deploy tasks
- Sharing a consistent team setup through committed workspace settings

## Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

## Local Install In WSL

Build the extension and install it into the VS Code instance connected to this WSL environment:

```bash
npm install
npm run install:wsl
```

This script:

- compiles the extension
- builds a `.vsix` with `vsce`
- installs that `.vsix` through the WSL `code` CLI with `--force`

## Publish To Marketplace

Before publishing:

- create the `padjon` publisher in Visual Studio Marketplace if it does not exist yet
- create a Personal Access Token with Marketplace `Manage` scope
- log in once with `npx @vscode/vsce login padjon`

Then publish the current version:

```bash
npm install
npm run publish:vsce
```

Or create a package locally first:

```bash
npm install
npm run vsix
```
