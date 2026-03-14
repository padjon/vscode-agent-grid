# WSL Setup

Agent Grid is WSL-first on Windows.

## Recommended Setup

1. Open the repository in WSL with the VS Code Remote - WSL extension.
2. Install `tmux` inside the WSL distribution.
3. Install your preferred agent CLIs inside WSL.
4. Run Agent Grid from the WSL extension host, not from native Windows.

## Example Install Commands

Ubuntu or Debian:

```bash
sudo apt update
sudo apt install tmux
```

## Common Problems

`tmux Missing`

- `tmux` is not installed in the WSL distro
- `agentGrid.tmuxCommand` points to the wrong executable

`WSL Required`

- the repository is open in native Windows instead of WSL

`Detached`

- the tmux session is still running but the VS Code terminal tab is not attached
- run `Create Workspace` again to reattach

For support, run `Agent Grid: Run Environment Check` and `Agent Grid: Export Support Bundle`.
