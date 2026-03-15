# Release Checklist

## Automated

- `npm test`
- `npm run test:smoke`
- `npm run vsix`

## Manual

- Open the extension in an Extension Development Host
- Verify the sidebar-first `Configure Workspace` flow
- Verify `Agent Grid: Create or Recreate Workspace`
- Verify restore after restarting VS Code
- Verify `Default Setup` and saved profile switching
- Verify `Start from` with `Custom` and detected CLI starters
- Verify advanced repo sharing via `.agent-grid.json`
- Verify `Agent Grid: Run Environment Check`
- Verify `Agent Grid: Export Support Bundle`
- Verify live pane actions: broadcast, switch layout, hide pane, restore hidden pane
- Verify terminal creation location is restored after opening Agent Grid

## Marketplace

- Confirm hero image is first and real screenshot is second
- Review display name, description, keywords, and walkthrough copy
- Update version and `CHANGELOG.md`
- Publish the `.vsix` or run the publish script
