import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTmuxBootstrapScript,
  mergeProfiles,
  normalizeProfiles,
  normalizeTerminalDefinitions,
  parseRepoConfig,
  readLayoutName,
  sanitizeTmuxName
} from '../out/core.js';

test('buildTmuxBootstrapScript creates panes, layout, and startup commands', () => {
  const script = buildTmuxBootstrapScript(
    {
      tmuxCommand: 'tmux',
      sessionName: 'agent-grid-demo',
      windowName: 'grid',
      layout: 'tiled',
      terminals: [
        { name: 'Claude', startupCommand: 'claude', cwd: '/repo' },
        { name: 'Tests', startupCommand: 'npm test', cwd: '/repo' },
        { name: 'Shell', startupCommand: '', cwd: '/repo/tools' }
      ]
    },
    true,
    (value) => value,
    (cwd) => cwd,
    '/fallback'
  );

  assert.match(script, /'tmux' start-server/);
  assert.match(script, /kill-session -t 'agent-grid-demo'/);
  assert.match(script, /new-session -d -s 'agent-grid-demo' -n 'grid' -c '\/repo'/);
  assert.equal((script.match(/split-window/g) ?? []).length, 2);
  assert.match(script, /select-layout -t 'agent-grid-demo':'grid' 'tiled'/);
  assert.match(script, /select-pane -t 'agent-grid-demo:grid.0' -T 'Claude'/);
  assert.match(script, /send-keys -t 'agent-grid-demo:grid.1' 'npm test' C-m/);
  assert.match(script, /attach-session -t 'agent-grid-demo'/);
});

test('buildTmuxBootstrapScript falls back to provided cwd', () => {
  const script = buildTmuxBootstrapScript(
    {
      tmuxCommand: 'tmux',
      sessionName: 'agent-grid-demo',
      windowName: 'grid',
      layout: 'main-vertical',
      terminals: [{ name: 'Shell', startupCommand: '', cwd: undefined }]
    },
    false,
    (value) => value,
    () => undefined,
    '/fallback'
  );

  assert.match(script, /new-session -d -s 'agent-grid-demo' -n 'grid' -c '\/fallback'/);
  assert.match(script, /select-layout -t 'agent-grid-demo':'grid' 'main-vertical'/);
});

test('readLayoutName accepts supported values only', () => {
  assert.equal(readLayoutName('tiled'), 'tiled');
  assert.equal(readLayoutName('main-horizontal'), 'main-horizontal');
  assert.equal(readLayoutName('invalid-layout'), undefined);
});

test('sanitizeTmuxName strips unsupported characters', () => {
  assert.equal(sanitizeTmuxName('agent grid/demo'), 'agent-grid-demo');
  assert.equal(sanitizeTmuxName('***'), 'agent-grid');
});

test('parseRepoConfig normalizes layout, terminals, and profiles', () => {
  const config = parseRepoConfig(
    JSON.stringify({
      layout: 'main-horizontal',
      tmuxCommand: 'tmux',
      terminals: [
        { name: 'Claude', startupCommand: 'claude', cwd: '${workspaceFolder}' },
        { name: 'Shell', startupCommand: '', cwd: '${workspaceFolder}' }
      ],
      profiles: [
        {
          name: 'Review',
          layout: 'tiled',
          terminals: [{ name: 'Codex', startupCommand: 'codex', cwd: '${workspaceFolder}' }]
        }
      ]
    })
  );

  assert.equal(config.layout, 'main-horizontal');
  assert.equal(config.tmuxCommand, 'tmux');
  assert.equal(config.terminals?.length, 2);
  assert.equal(config.profiles?.[0]?.name, 'Review');
  assert.equal(config.profiles?.[0]?.terminals[0]?.name, 'Codex');
});

test('normalize helpers keep sane defaults for invalid repo config data', () => {
  const terminals = normalizeTerminalDefinitions([{ name: 'Claude' }, { bogus: true }]);
  const profiles = normalizeProfiles([{ name: 'Daily', terminals: [{ startupCommand: 'npm test' }] }, { name: '' }]);

  assert.equal(terminals.length, 2);
  assert.equal(terminals[0].name, 'Claude');
  assert.equal(terminals[1].name, 'Agent 2');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'Daily');
  assert.equal(profiles[0].terminals[0].name, 'Agent 1');
});

test('mergeProfiles lets settings override repo defaults by name', () => {
  const merged = mergeProfiles(
    [
      {
        name: 'Daily',
        layout: 'tiled',
        terminals: [{ name: 'Claude', startupCommand: 'claude', cwd: '/repo' }]
      }
    ],
    [
      {
        name: 'Daily',
        layout: 'main-horizontal',
        terminals: [{ name: 'Codex', startupCommand: 'codex', cwd: '/repo' }]
      },
      {
        name: 'Review',
        layout: 'tiled',
        terminals: [{ name: 'Tests', startupCommand: 'npm test', cwd: '/repo' }]
      }
    ]
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].layout, 'main-horizontal');
  assert.equal(merged[0].terminals[0].name, 'Codex');
  assert.equal(merged[1].name, 'Review');
});
