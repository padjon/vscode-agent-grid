# Team Onboarding

Use this flow when you want a repository to ship a shared Agent Grid setup.

## Recommended Flow

1. Add a committed `.agent-grid.json` at the repository root.
2. Put the default team setup in `grid` and `terminals`.
3. Add named `profiles` for distinct workflows like `review`, `release`, or `incident`.
4. Keep user-specific differences in local `agentGrid.*` workspace settings only when necessary.

## Suggested Rollout

1. One maintainer creates a setup locally in the sidebar.
2. Open the `Agent Grid` sidebar and configure the `Default Setup` or a profile.
3. In `Advanced Storage`, switch to `Shared In Repo` and save.
4. Commit `.agent-grid.json`.
5. Teammates install Agent Grid and open the repo.
6. Teammates open the `Agent Grid` sidebar and choose `Save + Create`.

## When To Use Personal Defaults

Use personal defaults for:

- different agent CLI choices
- personal test commands
- temporary experiments

Do not use personal defaults for:

- the default team workflow
- committed review or release profiles
- repo-wide frontend/backend pane paths

If a repository should be shared with the team, save it into `.agent-grid.json` from the advanced storage section instead of keeping it only in personal settings.
