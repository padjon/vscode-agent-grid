# Release Checklist

## Automated

- `npm test`
- `npm run test:smoke`
- `npm run vsix`

## Manual

- Open the extension in an Extension Development Host
- Verify `Agent Grid: Run Setup Wizard`
- Verify `Agent Grid: Create or Recreate Workspace`
- Verify restore after restarting VS Code
- Verify `Agent Grid: Save Current Workspace As Profile`
- Verify `Agent Grid: Apply Saved Profile`
- Verify repo config flows: open, save workspace, save profile, import to settings, clear overrides, migrate settings
- Verify `Agent Grid: Run Environment Check`
- Verify `Agent Grid: Export Support Bundle`
- Verify pane actions: next, previous, restart, broadcast

## Marketplace

- Confirm hero image is first and real screenshot is second
- Review display name, description, keywords, and walkthrough copy
- Update version and `CHANGELOG.md`
- Publish the `.vsix` or run the publish script
