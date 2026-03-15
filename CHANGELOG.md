# Changelog

## 1.1.2

- split the extension branding into a multicolor Marketplace icon and a separate one-color transparent sidebar activity-bar icon
- updated the asset render pipeline so `npm run render:assets` renders the Marketplace icon from its dedicated SVG source

## 1.1.1

- fixed the Agent Grid sidebar contribution to register as a webview, which resolves the `There is no data provider registered` error
- improved the activity-bar icon contrast for dark themes

## 1.1.0

- rebuilt Agent Grid around a single sidebar-first editor with `Default Setup` and saved profiles as the core model
- separated detected CLI starters from profiles and added a built-in `Custom` starter for blank setups
- added a graphical grid preview in the sidebar, including visible hidden panes during live tmux sessions
- added live pane hide/restore and layout switching without recreating tmux contents
- removed usage metrics, migration UX, status bar state, and other stale surface area that made the product harder to understand
- reduced the public command palette surface to the primary setup and support actions
- improved terminal creation behavior so Agent Grid restores the previous terminal creation context after opening its editor-area terminal
- moved SVG asset rendering to a repeatable `rsvg-convert`-based repo script
- updated Marketplace/docs/support copy to match the simplified product model

## 1.0.8

- simplified the main UX around `Configure Workspace`, `Create Workspace`, `Current Setup`, and collapsed advanced actions
- added a guided custom setup flow for pane count, pane names, commands, working directories, and tmux layout
- added explicit save targets for repo config, workspace-only setup, and global defaults for all workspaces
- made setup suggestions CLI-aware so they only reflect detected tools and project signals, with `Custom Setup` always available
- replaced the sidebar activity icon with a proper monochrome glyph
- reduced the contributed command surface so the Command Palette is less overwhelming

## 1.0.7

- removed the unfinished remote telemetry path and kept usage observation local-only
- added direct email feedback support to `info@devsheep.de` from the extension support surface
- updated the README to ask for issues and feature wishes via GitHub or email

## 1.0.6

- fixed config precedence so repo-level `.agent-grid.json` sits between user defaults and workspace overrides
- made support-bundle export safe-by-default with redacted absolute local paths for public issue filing
- added live tmux pane visibility to the sidebar, diagnostics, and support bundle output
- added testable core helpers for effective config resolution and support-bundle rendering
- added onboarding docs and example repo configs for team sharing, WSL, and common workflows
- added Marketplace and sponsor badges to the README header

## 1.0.5

- added a native Agent Grid sidebar with workspace status, actions, presets, profiles, migration tools, and support actions
- added repo-level `.agent-grid.json` support with merge behavior against local VS Code overrides
- added commands to save workspace state and shared profiles directly into the repo config
- added commands to import repo config into workspace settings, clear local overrides, and migrate settings into repo config
- added project-aware preset adaptation for common frontend/backend folders and detected package scripts
- added local-only usage metrics with manual JSON export and reset commands
- added support bundle export and direct issue-tracker access for post-release debugging
- expanded diagnostics and tests for repo config parsing and release packaging

## 1.0.4

- repositioned Agent Grid as an AI terminal workspace for VS Code
- added configurable tmux layouts instead of a fixed 2x2-only shape
- added built-in presets for Claude Code, Codex, Gemini CLI, Aider, Goose, and mixed task layouts
- added saved workspace profiles in `agentGrid.profiles`
- added pane actions for focus, restart, and broadcast
- added a status bar state indicator and environment diagnostics
- added a setup wizard and built-in walkthrough for onboarding
- added tests for the tmux bootstrap core and CI for compile, test, and package validation

## 1.0.3

- improved documentation, packaging, and marketplace assets

## 1.0.1

- refined workspace restore and packaging flow

## 1.0.0

- initial tmux-backed Agent Grid release
