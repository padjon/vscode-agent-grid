# Team Onboarding

Use this flow when you want a repository to ship a shared Agent Grid setup.

## Recommended Flow

1. Add a committed `.agent-grid.json` at the repository root.
2. Put the default team layout in `layout` and `terminals`.
3. Add named `profiles` for distinct workflows like `review`, `release`, or `incident`.
4. Keep user-specific differences in local `agentGrid.*` workspace settings only when necessary.

## Suggested Rollout

1. One maintainer creates a layout locally.
2. Run `Agent Grid: Save Workspace To Repo Config`.
3. Optionally run `Agent Grid: Save Profile To Repo Config` for extra named flows.
4. Commit `.agent-grid.json`.
5. Teammates install Agent Grid and open the repo.
6. Teammates run `Create Workspace` or `Run Setup Wizard` from the sidebar.

## When To Use Workspace Overrides

Use local workspace overrides for:

- different agent CLI choices
- personal test commands
- temporary experiments

Do not use local workspace overrides for:

- the default team workflow
- committed review or release profiles
- repo-wide frontend/backend pane paths

If a repo already has local workspace settings that should become shared, run `Agent Grid: Migrate Settings To Repo Config`.
