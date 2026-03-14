# Changelog

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
