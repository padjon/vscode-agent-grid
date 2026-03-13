import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_NAMESPACE = 'agentGrid';
const CREATE_COMMAND = 'agentGrid.create';
const SESSION_STATE_KEY = 'agentGrid.open';
const TERMINAL_TITLE = 'agent-grid';
const DEFAULT_WINDOW_NAME = 'grid';
const PIN_EDITOR_COMMAND = 'workbench.action.pinEditor';

interface TerminalDefinition {
  name: string;
  startupCommand: string;
  cwd?: string;
}

interface WorkspaceSession {
  tmuxCommand: string;
  sessionName: string;
  windowName: string;
  terminals: TerminalDefinition[];
}

const DEFAULT_TERMINALS: TerminalDefinition[] = [
  { name: 'Agent 1', startupCommand: '', cwd: '${workspaceFolder}' },
  { name: 'Agent 2', startupCommand: '', cwd: '${workspaceFolder}' },
  { name: 'Agent 3', startupCommand: '', cwd: '${workspaceFolder}' },
  { name: 'Agent 4', startupCommand: '', cwd: '${workspaceFolder}' }
];

let controller: AgentGridController | undefined;

class AgentGridController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.commands.registerCommand(CREATE_COMMAND, async () => {
        await this.openWorkspace('manual');
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal.name !== TERMINAL_TITLE) {
          return;
        }

        if (!this.findExistingTerminal()) {
          void this.context.workspaceState.update(SESSION_STATE_KEY, false);
        }
      })
    );

    void this.restoreOnStartup();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async restoreOnStartup(): Promise<void> {
    const wasOpen = this.context.workspaceState.get<boolean>(SESSION_STATE_KEY, false);
    if (!wasOpen) {
      return;
    }

    await this.openWorkspace('restore');
  }

  private async openWorkspace(reason: 'manual' | 'restore'): Promise<void> {
    const session = this.getSessionFromSettings();
    const existingTerminal = this.findExistingTerminal();
    let recreate = false;

    if (reason === 'manual' && existingTerminal) {
      const action = await vscode.window.showInformationMessage(
        'The agent-grid tab is already open.',
        { modal: true },
        'Focus',
        'Recreate'
      );

      if (!action) {
        return;
      }

      if (action === 'Focus') {
        existingTerminal.show(false);
        await this.context.workspaceState.update(SESSION_STATE_KEY, true);
        return;
      }

      recreate = true;
      await this.disposeTerminal(existingTerminal);
    } else if (reason === 'restore' && existingTerminal) {
      existingTerminal.show(true);
      await this.context.workspaceState.update(SESSION_STATE_KEY, true);
      return;
    }

    const terminal = this.createTerminal();
    terminal.show(reason === 'restore');
    await vscode.commands.executeCommand(PIN_EDITOR_COMMAND);
    terminal.sendText(this.buildBootstrapCommand(session, recreate), true);
    await this.context.workspaceState.update(SESSION_STATE_KEY, true);
  }

  private createTerminal(): vscode.Terminal {
    return vscode.window.createTerminal({
      name: TERMINAL_TITLE,
      cwd: this.getWorkspaceRoot(),
      location: {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false
      },
      isTransient: false,
      iconPath: new vscode.ThemeIcon('terminal')
    });
  }

  private findExistingTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find((terminal) => terminal.name === TERMINAL_TITLE);
  }

  private async disposeTerminal(terminal: vscode.Terminal): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const complete = () => {
        if (settled) {
          return;
        }

        settled = true;
        closeListener.dispose();
        resolve();
      };

      const closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) {
          complete();
        }
      });

      terminal.dispose();
      setTimeout(complete, 1000);
    });
  }

  private getSessionFromSettings(): WorkspaceSession {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const configuredTerminals = config.get<unknown[]>('terminals', []);

    const terminals = DEFAULT_TERMINALS.map((defaults, index) => {
      const value = configuredTerminals[index];
      const terminal = isRecord(value) ? value : {};

      return {
        name: readTrimmedString(terminal.name) ?? defaults.name,
        startupCommand: readString(terminal.startupCommand) ?? defaults.startupCommand,
        cwd: readTrimmedString(terminal.cwd) ?? defaults.cwd
      };
    });

    return {
      tmuxCommand: readTrimmedString(config.get<string>('tmuxCommand')) ?? 'tmux',
      sessionName: this.buildSessionName(),
      windowName: DEFAULT_WINDOW_NAME,
      terminals
    };
  }

  private buildSessionName(): string {
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
    if (workspaceName) {
      return sanitizeTmuxName(`agent-grid-${workspaceName}`);
    }

    return 'agent-grid';
  }

  private buildBootstrapCommand(session: WorkspaceSession, recreate: boolean): string {
    return buildTmuxBootstrapScript(
      session,
      recreate,
      this.expandVariables.bind(this),
      this.resolveCwd.bind(this)
    );
  }

  private getWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private resolveCwd(cwd: string | undefined): string | undefined {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!cwd) {
      return workspaceRoot;
    }

    if (!workspaceRoot && cwd.includes('${workspaceFolder')) {
      return undefined;
    }

    let resolved = this.expandVariables(cwd);
    resolved = expandHomeDirectory(resolved);

    if (path.isAbsolute(resolved) || !workspaceRoot) {
      return resolved;
    }

    return path.resolve(workspaceRoot, resolved);
  }

  private expandVariables(value: string): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const replacements: Array<[string, string | undefined]> = [
      ['${workspaceFolder}', workspaceFolder?.uri.fsPath],
      ['${workspaceFolderBasename}', workspaceFolder?.name],
      ['${userHome}', os.homedir()]
    ];

    return replacements.reduce((result, [token, replacement]) => {
      if (!replacement) {
        return result;
      }

      return result.split(token).join(replacement);
    }, value);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  controller = new AgentGridController(context);
  context.subscriptions.push(controller);
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}

function buildTmuxBootstrapScript(
  session: WorkspaceSession,
  recreate: boolean,
  expandVariables: (value: string) => string,
  resolveCwd: (cwd: string | undefined) => string | undefined
): string {
  const tmuxCommand = shellQuote(expandVariables(session.tmuxCommand));
  const sessionName = shellQuote(session.sessionName);
  const windowName = shellQuote(session.windowName);
  const lines: string[] = [`${tmuxCommand} start-server >/dev/null 2>&1 || true`];

  if (recreate) {
    lines.push(`${tmuxCommand} kill-session -t ${sessionName} >/dev/null 2>&1 || true`);
  }

  lines.push(`if ! ${tmuxCommand} has-session -t ${sessionName} >/dev/null 2>&1; then`);

  const baseCwd = resolveCwd(session.terminals[0]?.cwd) ?? process.cwd();
  lines.push(
    `  ${tmuxCommand} new-session -d -s ${sessionName} -n ${windowName} -c ${shellQuote(baseCwd)}`,
    `  ${tmuxCommand} split-window -h -t ${sessionName}:${windowName}.0 -c ${shellQuote(
      resolveCwd(session.terminals[1]?.cwd) ?? baseCwd
    )}`,
    `  ${tmuxCommand} split-window -v -t ${sessionName}:${windowName}.0 -c ${shellQuote(
      resolveCwd(session.terminals[2]?.cwd) ?? baseCwd
    )}`,
    `  ${tmuxCommand} split-window -v -t ${sessionName}:${windowName}.1 -c ${shellQuote(
      resolveCwd(session.terminals[3]?.cwd) ?? baseCwd
    )}`,
    `  ${tmuxCommand} select-layout -t ${sessionName}:${windowName} tiled`
  );

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

function sanitizeTmuxName(value: string): string {
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

function expandHomeDirectory(value: string): string {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}
