import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTmuxBootstrapScript } from '../out/core.js';

const execFile = promisify(execFileCallback);

async function commandExists(command) {
  try {
    await execFile('bash', ['-lc', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}

test('generated bootstrap script creates and configures a tmux workspace end-to-end', async (t) => {
  if (!(await commandExists('tmux'))) {
    t.skip('tmux is not installed');
    return;
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-grid-smoke-'));
  const socketName = `agent-grid-smoke-${process.pid}`;
  const wrapperPath = path.join(tempRoot, 'tmux-wrapper.sh');
  const pane0File = path.join(tempRoot, 'pane0.txt');
  const pane1File = path.join(tempRoot, 'pane1.txt');

  try {
    await writeFile(
      wrapperPath,
      `#!/usr/bin/env bash\nexec tmux -L ${socketName} -f /dev/null "$@"\n`,
      'utf8'
    );
    await chmod(wrapperPath, 0o755);

    const script = buildTmuxBootstrapScript(
      {
        tmuxCommand: wrapperPath,
        sessionName: 'agent-grid-smoke',
        windowName: 'grid',
        layout: 'tiled',
        terminals: [
          { name: 'Claude', startupCommand: `printf pane0 > ${pane0File}`, cwd: tempRoot },
          { name: 'Tests', startupCommand: `printf pane1 > ${pane1File}`, cwd: tempRoot }
        ]
      },
      true,
      (value) => value,
      (cwd) => cwd,
      tempRoot
    );

    const scriptWithoutAttach = script.split('\n').slice(0, -1).join('\n');
    await execFile('bash', ['-lc', scriptWithoutAttach], { cwd: tempRoot });

    const [pane0Value, pane1Value] = await Promise.all([waitForFile(pane0File), waitForFile(pane1File)]);
    assert.equal(pane0Value, 'pane0');
    assert.equal(pane1Value, 'pane1');

    const { stdout } = await execFile(wrapperPath, [
      'list-panes',
      '-t',
      'agent-grid-smoke:grid',
      '-F',
      '#{pane_index}:#{pane_title}'
    ]);
    const paneTitles = stdout.trim().split(/\r?\n/);

    assert.deepEqual(paneTitles, ['0:Claude', '1:Tests']);
  } finally {
    try {
      await execFile(wrapperPath, ['kill-server']);
    } catch {
      // Ignore cleanup failures if tmux never started.
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});
