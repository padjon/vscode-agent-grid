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

export interface RepoConfig {
  tmuxCommand?: string;
  layout?: LayoutName;
  terminals?: TerminalDefinition[];
  profiles?: WorkspaceProfile[];
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

export function normalizeTerminalDefinitions(values: unknown[] | undefined): TerminalDefinition[] {
  const rawTerminals = Array.isArray(values) && values.length > 0 ? values.slice(0, 8) : DEFAULT_TERMINALS;
  const terminals = rawTerminals
    .map((value, index) => {
      const defaults = DEFAULT_TERMINALS[index] ?? buildDefaultTerminal(index + 1);
      const terminal = isRecord(value) ? value : {};

      return {
        name: readTrimmedString(terminal.name) ?? defaults.name,
        startupCommand: readString(terminal.startupCommand) ?? defaults.startupCommand,
        cwd: readTrimmedString(terminal.cwd) ?? defaults.cwd
      };
    })
    .filter((terminal) => terminal.name || terminal.startupCommand || terminal.cwd);

  return terminals.length > 0 ? terminals : DEFAULT_TERMINALS;
}

export function normalizeProfiles(values: unknown[] | undefined): WorkspaceProfile[] {
  const configuredProfiles = Array.isArray(values) ? values : [];
  const profiles: WorkspaceProfile[] = [];

  for (const value of configuredProfiles) {
    if (!isRecord(value)) {
      continue;
    }

    const name = readTrimmedString(value.name);
    const layout = readLayoutName(value.layout) ?? 'tiled';
    const rawTerminals = Array.isArray(value.terminals) ? value.terminals : undefined;

    if (!name || !rawTerminals || rawTerminals.length === 0) {
      continue;
    }

    const terminals = normalizeTerminalDefinitions(rawTerminals);

    if (terminals.length === 0) {
      continue;
    }

    profiles.push({
      name,
      layout,
      terminals
    });
  }

  return profiles;
}

export function parseRepoConfig(raw: string): RepoConfig {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    return {};
  }

  const tmuxCommand = readTrimmedString(parsed.tmuxCommand);
  const layout = readLayoutName(parsed.layout);
  const terminals = Array.isArray(parsed.terminals) ? normalizeTerminalDefinitions(parsed.terminals) : undefined;
  const profiles = Array.isArray(parsed.profiles) ? normalizeProfiles(parsed.profiles) : undefined;

  return {
    tmuxCommand,
    layout,
    terminals,
    profiles
  };
}

export function mergeProfiles(baseProfiles: WorkspaceProfile[], overrideProfiles: WorkspaceProfile[]): WorkspaceProfile[] {
  const merged = [...baseProfiles];

  for (const profile of overrideProfiles) {
    const existingIndex = merged.findIndex((candidate) => candidate.name === profile.name);

    if (existingIndex >= 0) {
      merged[existingIndex] = profile;
    } else {
      merged.push(profile);
    }
  }

  return merged;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
