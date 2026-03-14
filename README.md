# Agent Grid

[![CI](https://github.com/padjon/vscode-agent-grid/actions/workflows/ci.yml/badge.svg)](https://github.com/padjon/vscode-agent-grid/actions/workflows/ci.yml)

Run terminal-first AI workflows inside one persistent VS Code workspace.

Agent Grid turns one native terminal tab into a tmux-backed workspace for Claude Code, Codex, Gemini CLI, Aider, Goose, test runners, and project commands. It keeps each workflow in a fixed lane, restores the workspace when VS Code comes back, and stays inside the editor instead of pushing you into separate apps or scattered terminal tabs.

![Agent Grid hero showing a multi-agent terminal workspace inside VS Code](https://raw.githubusercontent.com/padjon/vscode-agent-grid/main/assets/marketplace-hero.png)

## Why Install It

- Keep multiple agents and tasks visible at once inside VS Code
- Reopen the same workspace quickly instead of rebuilding your terminal layout
- Use committed workspace settings so a team can share the same setup
- Stay terminal-native with tmux instead of moving to a custom webview UI

## Best Fit

Agent Grid is built for developers who already like terminal-first tools:

- Claude Code
- OpenAI Codex
- Gemini CLI
- Aider
- Goose
- your own test, lint, build, or ops commands

## What You Get

- One pinned VS Code terminal tab named `agent-grid`
- A tmux-backed pane workspace with configurable layouts
- Automatic attach when a matching tmux session already exists
- Optional startup commands for each pane on fresh workspace creation
- Restore on the next VS Code start when the workspace was left open
- Built-in presets to bootstrap common agent and task layouts

## Real Workspace

![Agent Grid screenshot showing a real tmux-backed terminal workspace inside VS Code](https://raw.githubusercontent.com/padjon/vscode-agent-grid/main/assets/marketplace-screenshot.png)

## Requirements

- `tmux` is required
- Windows support is WSL-first. Native Windows terminals are not the target runtime for this extension

If `tmux` is missing, Agent Grid will guide you toward the right install path for your environment.

## Quick Start

1. Install `tmux`
2. Open a project in VS Code
3. Run `Agent Grid: Run Setup Wizard`, `Agent Grid: Open Getting Started Guide`, or `Agent Grid: Apply Workspace Preset`
4. Run `Agent Grid: Create or Recreate Workspace`

## Example Configuration

```json
{
  "agentGrid.layout": "tiled",
  "agentGrid.tmuxCommand": "tmux",
  "agentGrid.terminals": [
    {
      "name": "Claude",
      "startupCommand": "claude",
      "cwd": "${workspaceFolder}"
    },
    {
      "name": "Codex",
      "startupCommand": "codex",
      "cwd": "${workspaceFolder}"
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

## Layouts

Available values for `agentGrid.layout`:

- `tiled`
- `even-horizontal`
- `even-vertical`
- `main-horizontal`
- `main-vertical`

`tiled` is the default and produces the familiar `2x2` shape when four panes are configured.

## Startup Behavior

- `agentGrid.autoRestore`: reopen the workspace on the next VS Code start when it was left open
- `agentGrid.promptOnboarding`: show or suppress the first-run setup prompt

## Presets

Built-in presets are included for:

- Solo dev
- Claude Code
- OpenAI Codex
- Gemini CLI
- Aider
- Goose
- Mixed agent plus test workflow
- Frontend, backend, tests, ops

Use `Agent Grid: Apply Workspace Preset` to write one into your workspace settings.

You can also define repository-specific reusable profiles in `agentGrid.profiles` and apply them later with `Agent Grid: Apply Saved Profile`.

If you already have a workspace configuration you like, run `Agent Grid: Save Current Workspace As Profile` to append it to `agentGrid.profiles` in workspace settings.

Example `agentGrid.profiles`:

```json
{
  "agentGrid.profiles": [
    {
      "name": "Daily Solo",
      "layout": "main-horizontal",
      "terminals": [
        {
          "name": "Claude",
          "startupCommand": "claude",
          "cwd": "${workspaceFolder}"
        },
        {
          "name": "Tests",
          "startupCommand": "npm run test:watch",
          "cwd": "${workspaceFolder}"
        },
        {
          "name": "Shell",
          "startupCommand": "",
          "cwd": "${workspaceFolder}"
        }
      ]
    },
    {
      "name": "Review Mode",
      "layout": "tiled",
      "terminals": [
        {
          "name": "Codex",
          "startupCommand": "codex",
          "cwd": "${workspaceFolder}"
        },
        {
          "name": "Claude",
          "startupCommand": "claude",
          "cwd": "${workspaceFolder}"
        },
        {
          "name": "Tests",
          "startupCommand": "npm test",
          "cwd": "${workspaceFolder}"
        },
        {
          "name": "Shell",
          "startupCommand": "",
          "cwd": "${workspaceFolder}"
        }
      ]
    }
  ]
}
```

## Commands

- `Agent Grid: Create or Recreate Workspace`
- `Agent Grid: Run Setup Wizard`
- `Agent Grid: Open Getting Started Guide`
- `Agent Grid: Apply Workspace Preset`
- `Agent Grid: Apply Saved Profile`
- `Agent Grid: Show Actions`
- `Agent Grid: Focus Next Pane`
- `Agent Grid: Focus Previous Pane`
- `Agent Grid: Restart Active Pane`
- `Agent Grid: Broadcast Command To All Panes`
- `Agent Grid: Save Current Workspace As Profile`
- `Agent Grid: Run Environment Check`

## Command Behavior

`Agent Grid: Create or Recreate Workspace`

- creates the tmux workspace if it does not exist yet
- focuses the existing terminal tab when it is already open
- offers to attach when the tmux session is still running without the tab
- rebuilds the session when you choose recreate

`Agent Grid: Run Environment Check`

- writes the current environment, tmux detection, layout, and session state into the `Agent Grid` output channel
- helps users diagnose missing tmux, wrong runtime, or detached-session states

`Agent Grid: Run Setup Wizard`

- detects common agent CLIs such as Claude, Codex, Gemini, Aider, and Goose
- recommends a starter preset based on what is installed
- can immediately create the workspace or save the result as a reusable profile

`Agent Grid: Open Getting Started Guide`

- opens the built-in walkthrough from the VS Code walkthrough UI
- gives first-time users a guided path through setup, creation, and profile saving

## Development

```bash
npm install
npm run compile
npm test
npm run test:smoke
```

## Release Checklist

- run `npm test`
- run `npm run test:smoke`
- run `npm run vsix`
- manually verify setup wizard, create workspace, restore, profile save/apply, and diagnostics in a real VS Code session

Then press `F5` in VS Code to launch an Extension Development Host.

## Local Install In WSL

Build the extension and install it into the VS Code instance connected to this WSL environment:

```bash
npm install
npm run install:wsl
```

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
