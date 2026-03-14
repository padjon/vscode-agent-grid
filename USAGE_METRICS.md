# Usage Metrics

Agent Grid can collect local aggregate counters for a small set of product events.

These counters are:

- disabled by default
- stored locally in VS Code global state
- gated by both `agentGrid.enableUsageMetrics` and the global VS Code telemetry setting
- exportable only when you manually run `Agent Grid: Export Usage Report`

They do not include:

- workspace names
- file paths
- prompts
- commands you type
- terminal or pane contents
- model output

## Events

- `activate`
  Records extension activation when usage metrics are active.

- `onboarding_action`
  Buckets: `setup_wizard`, `open_guide`, `dismiss`

- `workspace_open`
  Buckets: `manual`, `restore`

- `workspace_action`
  Buckets: `focus_existing_terminal`, `recreate_from_existing_terminal`, `attach_detached`, `recreate_detached`, `restore_focus_existing_terminal`

- `setup_wizard`
  Bucket `open` plus built-in preset ids such as `solo-dev`, `claude-focused`, or `mixed-agents`

- `walkthrough`
  Buckets: `open`

- `preset_apply`
  Buckets: built-in preset ids such as `solo-dev`, `claude-focused`, or `mixed-agents`

- `profile_apply`
  No buckets

- `profile_save`
  No buckets

- `pane_action`
  Buckets: `focus_next`, `focus_previous`, `restart_active`, `broadcast`

- `repo_config`
  Buckets: `create`, `open`, `parse_error`, `save_workspace`, `save_profile`

- `migration`
  Buckets: `import_repo_to_settings`, `clear_workspace_overrides`, `migrate_settings_to_repo`

- `support`
  Buckets: `export_bundle`, `open_issue_tracker`

- `diagnostics`
  Buckets: `run`

- `usage_report`
  Buckets: `export`
