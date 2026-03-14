export type LayoutName = 'tiled' | 'even-horizontal' | 'even-vertical' | 'main-horizontal' | 'main-vertical';

export interface TerminalDefinition {
  name: string;
  startupCommand: string;
  cwd?: string;
}

export interface WorkspaceSession {
  tmuxCommand: string;
  sessionName: string;
  windowName: string;
  layout: LayoutName;
  terminals: TerminalDefinition[];
}

export interface WorkspacePreset {
  id: string;
  label: string;
  description: string;
  layout: LayoutName;
  terminals: TerminalDefinition[];
}

export interface WorkspaceProfile {
  name: string;
  layout: LayoutName;
  terminals: TerminalDefinition[];
}

export const DEFAULT_TERMINALS: TerminalDefinition[] = [
  { name: 'Agent 1', startupCommand: '', cwd: '${workspaceFolder}' },
  { name: 'Agent 2', startupCommand: '', cwd: '${workspaceFolder}' },
  { name: 'Agent 3', startupCommand: '', cwd: '${workspaceFolder}' },
  { name: 'Agent 4', startupCommand: '', cwd: '${workspaceFolder}' }
];

export const BUILTIN_PRESETS: WorkspacePreset[] = [
  {
    id: 'solo-dev',
    label: 'Solo Dev Workspace',
    description: 'One agent, one test pane, and one shell for focused daily work.',
    layout: 'main-horizontal',
    terminals: [
      { name: 'Agent', startupCommand: '', cwd: '${workspaceFolder}' },
      { name: 'Tests', startupCommand: 'npm run test:watch', cwd: '${workspaceFolder}' },
      { name: 'Shell', startupCommand: '', cwd: '${workspaceFolder}' }
    ]
  },
  {
    id: 'claude-codex-tests',
    label: 'Claude + Codex + Tests',
    description: 'Claude Code, Codex, tests, and a general shell in a tiled workspace.',
    layout: 'tiled',
    terminals: [
      { name: 'Claude', startupCommand: 'claude', cwd: '${workspaceFolder}' },
      { name: 'Codex', startupCommand: 'codex', cwd: '${workspaceFolder}' },
      { name: 'Tests', startupCommand: 'npm run test:watch', cwd: '${workspaceFolder}' },
      { name: 'Shell', startupCommand: '', cwd: '${workspaceFolder}' }
    ]
  },
  {
    id: 'claude-focused',
    label: 'Claude Code Focus',
    description: 'Claude Code as the main pane with supporting shells.',
    layout: 'main-vertical',
    terminals: [
      { name: 'Claude', startupCommand: 'claude', cwd: '${workspaceFolder}' },
      { name: 'Tests', startupCommand: 'npm run test:watch', cwd: '${workspaceFolder}' },
      { name: 'Lint', startupCommand: 'npm run lint -- --watch', cwd: '${workspaceFolder}' }
    ]
  },
  {
    id: 'codex-focused',
    label: 'OpenAI Codex Focus',
    description: 'Codex as the main pane with tests and shell support.',
    layout: 'main-vertical',
    terminals: [
      { name: 'Codex', startupCommand: 'codex', cwd: '${workspaceFolder}' },
      { name: 'Tests', startupCommand: 'npm run test:watch', cwd: '${workspaceFolder}' },
      { name: 'Shell', startupCommand: '', cwd: '${workspaceFolder}' }
    ]
  },
  {
    id: 'gemini',
    label: 'Gemini CLI Workspace',
    description: 'Gemini CLI with tests and a command pane.',
    layout: 'main-horizontal',
    terminals: [
      { name: 'Gemini', startupCommand: 'gemini', cwd: '${workspaceFolder}' },
      { name: 'Tests', startupCommand: 'npm run test:watch', cwd: '${workspaceFolder}' },
      { name: 'Shell', startupCommand: '', cwd: '${workspaceFolder}' }
    ]
  },
  {
    id: 'aider',
    label: 'Aider Workspace',
    description: 'Aider with shell and test panes.',
    layout: 'main-horizontal',
    terminals: [
      { name: 'Aider', startupCommand: 'aider', cwd: '${workspaceFolder}' },
      { name: 'Tests', startupCommand: 'npm run test:watch', cwd: '${workspaceFolder}' },
      { name: 'Shell', startupCommand: '', cwd: '${workspaceFolder}' }
    ]
  },
  {
    id: 'goose',
    label: 'Goose Workspace',
    description: 'Goose with shell and test panes.',
    layout: 'main-horizontal',
    terminals: [
      { name: 'Goose', startupCommand: 'goose', cwd: '${workspaceFolder}' },
      { name: 'Tests', startupCommand: 'npm run test:watch', cwd: '${workspaceFolder}' },
      { name: 'Shell', startupCommand: '', cwd: '${workspaceFolder}' }
    ]
  },
  {
    id: 'frontend-backend-tests-ops',
    label: 'Frontend / Backend / Tests / Ops',
    description: 'A classic four-lane engineering layout for teams.',
    layout: 'tiled',
    terminals: [
      { name: 'Frontend', startupCommand: '', cwd: '${workspaceFolder}/apps/frontend' },
      { name: 'Backend', startupCommand: '', cwd: '${workspaceFolder}/apps/backend' },
      { name: 'Tests', startupCommand: 'npm run test:watch', cwd: '${workspaceFolder}' },
      { name: 'Ops', startupCommand: '', cwd: '${workspaceFolder}' }
    ]
  },
  {
    id: 'mixed-agents',
    label: 'Mixed Agents Workspace',
    description: 'Claude Code, Codex, Gemini CLI, and tests in one tiled workspace.',
    layout: 'tiled',
    terminals: [
      { name: 'Claude', startupCommand: 'claude', cwd: '${workspaceFolder}' },
      { name: 'Codex', startupCommand: 'codex', cwd: '${workspaceFolder}' },
      { name: 'Gemini', startupCommand: 'gemini', cwd: '${workspaceFolder}' },
      { name: 'Tests', startupCommand: 'npm run test:watch', cwd: '${workspaceFolder}' }
    ]
  }
];

export function buildTmuxBootstrapScript(
  session: WorkspaceSession,
  recreate: boolean,
  expandVariables: (value: string) => string,
  resolveCwd: (cwd: string | undefined) => string | undefined,
  fallbackCwd: string
): string {
  const tmuxCommand = shellQuote(expandVariables(session.tmuxCommand));
  const sessionName = shellQuote(session.sessionName);
  const windowName = shellQuote(session.windowName);
  const lines: string[] = [`${tmuxCommand} start-server >/dev/null 2>&1 || true`];

  if (recreate) {
    lines.push(`${tmuxCommand} kill-session -t ${sessionName} >/dev/null 2>&1 || true`);
  }

  lines.push(`if ! ${tmuxCommand} has-session -t ${sessionName} >/dev/null 2>&1; then`);

  const baseCwd = resolveCwd(session.terminals[0]?.cwd) ?? fallbackCwd;
  lines.push(`  ${tmuxCommand} new-session -d -s ${sessionName} -n ${windowName} -c ${shellQuote(baseCwd)}`);

  for (let index = 1; index < session.terminals.length; index += 1) {
    const paneCwd = resolveCwd(session.terminals[index]?.cwd) ?? baseCwd;
    lines.push(`  ${tmuxCommand} split-window -t ${sessionName}:${windowName} -c ${shellQuote(paneCwd)}`);
  }

  lines.push(`  ${tmuxCommand} select-layout -t ${sessionName}:${windowName} ${shellQuote(session.layout)}`);

  session.terminals.forEach((terminal, index) => {
    const target = `${session.sessionName}:${session.windowName}.${index}`;
    if (terminal.name.trim()) {
      lines.push(`  ${tmuxCommand} select-pane -t ${shellQuote(target)} -T ${shellQuote(expandVariables(terminal.name))}`);
    }

    const startupCommand = expandVariables(terminal.startupCommand).trim();
    if (startupCommand) {
      lines.push(`  ${tmuxCommand} send-keys -t ${shellQuote(target)} ${shellQuote(startupCommand)} C-m`);
    }
  });

  lines.push('fi', `${tmuxCommand} attach-session -t ${sessionName}`);
  return lines.join('\n');
}

export function buildDefaultTerminal(index: number): TerminalDefinition {
  return {
    name: `Agent ${index}`,
    startupCommand: '',
    cwd: '${workspaceFolder}'
  };
}

export function readLayoutName(value: unknown): LayoutName | undefined {
  if (
    value === 'tiled' ||
    value === 'even-horizontal' ||
    value === 'even-vertical' ||
    value === 'main-horizontal' ||
    value === 'main-vertical'
  ) {
    return value;
  }

  return undefined;
}

export function sanitizeTmuxName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'agent-grid';
}

function shellQuote(value: string): string {
  return `'${escapeForSingleQuotes(value)}'`;
}

function escapeForSingleQuotes(value: string): string {
  return value.replace(/'/g, `'"'"'`);
}
