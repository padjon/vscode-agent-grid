# Agent Grid

Run terminal-first AI workflows inside one persistent VS Code workspace.

Agent Grid turns one native terminal tab into a tmux-backed workspace for Claude Code, Codex, Gemini CLI, Aider, Goose, test runners, and project commands. It keeps each workflow in a fixed lane, restores the workspace when VS Code comes back, and stays inside the editor instead of pushing you into separate apps or scattered terminal tabs.

![Agent Grid hero showing a multi-agent terminal workspace inside VS Code](https://raw.githubusercontent.com/padjon/vscode-agent-grid/main/assets/marketplace-hero.png)

## Why Install It

- Keep multiple agents and tasks visible at once inside VS Code
- Reopen the same workspace quickly instead of rebuilding your terminal layout
- Use a committed repo config so a team can share the same setup
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
- A native `Agent Grid` sidebar with status, actions, presets, profiles, and pane overview
- Automatic attach when a matching tmux session already exists
- Optional startup commands for each pane on fresh workspace creation
- Restore on the next VS Code start when the workspace was left open
- Built-in presets to bootstrap common agent and task layouts
- Optional `.agent-grid.json` repo config for shared defaults across the team
- Setup wizard and presets that adapt to detected scripts and common frontend/backend repo paths
- Optional local usage metrics with manual JSON export for funnel analysis

## Real Workspace

![Agent Grid screenshot showing a real tmux-backed terminal workspace inside VS Code](https://raw.githubusercontent.com/padjon/vscode-agent-grid/main/assets/marketplace-screenshot.png)

## Requirements

- `tmux` is required
- Windows support is WSL-first. Native Windows terminals are not the target runtime for this extension

If `tmux` is missing, Agent Grid will guide you toward the right install path for your environment.

## Quick Start

1. Install `tmux`
2. Open a project in VS Code
3. Open the `Agent Grid` sidebar in the activity bar
4. Run `Setup Wizard`, `Create Workspace`, or choose a preset/profile from the sidebar

You can still access the same flow from the Command Palette with `Agent Grid: Run Setup Wizard`, `Agent Grid: Open Getting Started Guide`, or `Agent Grid: Apply Workspace Preset`.

## Repo Config

Agent Grid can load a committed repo-level config file from the workspace root:

- `.agent-grid.json` is the shared base config for the repository
- `agentGrid.*` VS Code settings still override it for local differences
- `Agent Grid: Open Repo Config` creates the file from your current effective setup if it does not exist yet
- `Agent Grid: Save Workspace To Repo Config` writes the current effective layout and panes into the repo file
- `Agent Grid: Save Profile To Repo Config` appends or updates a named shared profile in the repo file
- `Agent Grid: Import Repo Config To Settings` copies the repo config into workspace overrides
- `Agent Grid: Clear Workspace Overrides` removes local overrides so the repo config or defaults take over
- `Agent Grid: Migrate Settings To Repo Config` moves the current local setup into the shared repo file

Example `.agent-grid.json`:

```json
{
  "layout": "tiled",
  "terminals": [
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
      "name": "Shell",
      "startupCommand": "",
      "cwd": "${workspaceFolder}"
    }
  ],
  "profiles": [
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

## Usage Metrics

Agent Grid can collect local aggregate usage counters to help you understand onboarding and feature adoption after release.

- disabled by default
- only active when `agentGrid.enableUsageMetrics` is enabled
- also respects the global VS Code telemetry setting
- records aggregate event counts only
- does not record workspace names, file paths, commands, prompts, or pane contents
- exports only when you manually run `Agent Grid: Export Usage Report`

Documented event names and buckets are listed in [USAGE_METRICS.md](./USAGE_METRICS.md).

## Support

Agent Grid now has a built-in support loop for post-release issues:

- `Agent Grid: Run Environment Check` refreshes the output-channel diagnostics
- `Agent Grid: Export Support Bundle` opens a markdown bundle with environment state, effective config, repo-config status, and usage-metrics state
- `Agent Grid: Open Issue Tracker` opens the GitHub issue templates

That gives users and maintainers one consistent artifact for setup, WSL, tmux, restore, and migration bugs.

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

When possible, Agent Grid adapts preset startup commands and pane directories to the current repository. For example, it will prefer detected `test` or `test:watch` scripts and common frontend/backend folders instead of assuming one fixed project layout.

You can also define repository-specific reusable profiles in `agentGrid.profiles` and apply them later with `Agent Grid: Apply Saved Profile`.

If you already have a workspace configuration you like, run `Agent Grid: Save Current Workspace As Profile` to append it to `agentGrid.profiles` in workspace settings.

## Sidebar

The native `Agent Grid` sidebar gives you the main workflow without quick-pick hopping:

- current workspace state: running, detached, idle, or setup issue
- one-click workspace actions and diagnostics
- repo config status, creation, and parse-error visibility
- migration actions between repo config and workspace overrides
- usage metrics status plus export and reset actions
- support bundle export and direct issue-tracker access
- saved profiles that apply directly from the tree
- built-in presets that write to workspace settings immediately
- a readable overview of the currently configured panes

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
- `Agent Grid: Open Repo Config`
- `Agent Grid: Export Usage Report`
- `Agent Grid: Reset Usage Report`
- `Agent Grid: Save Workspace To Repo Config`
- `Agent Grid: Save Profile To Repo Config`
- `Agent Grid: Import Repo Config To Settings`
- `Agent Grid: Clear Workspace Overrides`
- `Agent Grid: Migrate Settings To Repo Config`
- `Agent Grid: Export Support Bundle`
- `Agent Grid: Open Issue Tracker`
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
- includes repo config and usage metrics state

`Agent Grid: Run Setup Wizard`

- detects common agent CLIs such as Claude, Codex, Gemini, Aider, and Goose
- recommends a starter preset based on what is installed
- adapts preset commands and pane directories to detected package scripts and common repo folders
- can immediately create the workspace or save the result as a reusable profile

`Agent Grid: Open Getting Started Guide`

- opens the built-in walkthrough from the VS Code walkthrough UI
- gives first-time users a guided path through setup, creation, and profile saving
