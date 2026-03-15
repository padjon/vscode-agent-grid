# Workflow Recipes

These are good starting points for committed repo configs or saved profiles.

## Solo Dev

- main pane: Claude or Codex
- second pane: tests
- third pane: shell

Use the built-in `Custom` starter or a detected CLI starter, then shape the grid in the sidebar.

## Review Mode

- pane 1: Codex
- pane 2: Claude
- pane 3: tests
- pane 4: shell

Good when one agent inspects diffs while another proposes fixes.

## Frontend / Backend / Tests / Ops

- pane 1: frontend cwd
- pane 2: backend cwd
- pane 3: tests
- pane 4: ops shell

Start from the detected agents starter when Agent Grid finds multiple installed CLIs, then refine the grid and pane commands in the sidebar.

## Mixed Agents

- pane 1: Claude
- pane 2: Codex
- pane 3: Gemini
- pane 4: tests

Use when you want parallel agent exploration plus a visible validation lane.
