# agent-grid

`agent-grid` is a VS Code extension that opens an optimized tmux-backed `2x2` terminal grid for CLI coding agents like Claude Code or OpenCode.

## What it does

- Adds one command: `agent-grid: Create or Recreate Workspace`
- Opens one native editor terminal tab named `agent-grid`
- Pins that tab when it is created
- Creates a fixed tmux `2x2` pane layout inside the terminal
- Reuses the existing workspace or asks whether to focus or recreate it
- Runs pane startup commands only when the workspace is created fresh
- Restores the workspace on the next VS Code start if it was still open

This keeps the UI fully native in VS Code while using tmux for fast pane orchestration and stable agent-oriented terminal layout.

## Requirements

- `tmux` must be installed and available on your `PATH`, or configured via `agentGrid.tmuxCommand`

## Command

- `agent-grid: Create or Recreate Workspace`
  - creates the tmux workspace if it does not exist yet
  - if the `agent-grid` tab is already open, asks whether to focus it or recreate it
  - when recreating, destroys the old tmux session and rebuilds the full grid

## Settings

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
