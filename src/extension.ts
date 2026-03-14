import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import {
  BUILTIN_PRESETS,
  DEFAULT_TERMINALS,
  buildDefaultTerminal,
  buildTmuxBootstrapScript,
  readLayoutName,
  sanitizeTmuxName
} from './core';
import type {
  LayoutName,
  TerminalDefinition,
  WorkspacePreset,
  WorkspaceProfile,
  WorkspaceSession
} from './core';

const EXTENSION_NAMESPACE = 'agentGrid';
const CREATE_COMMAND = 'agentGrid.create';
const SETUP_PRESET_COMMAND = 'agentGrid.setupPreset';
const SHOW_ACTIONS_COMMAND = 'agentGrid.showActions';
const APPLY_PROFILE_COMMAND = 'agentGrid.applyProfile';
const FOCUS_NEXT_PANE_COMMAND = 'agentGrid.focusNextPane';
const FOCUS_PREVIOUS_PANE_COMMAND = 'agentGrid.focusPreviousPane';
const RESTART_ACTIVE_PANE_COMMAND = 'agentGrid.restartActivePane';
const BROADCAST_COMMAND = 'agentGrid.broadcastCommand';
const DIAGNOSE_COMMAND = 'agentGrid.diagnose';
const SAVE_PROFILE_COMMAND = 'agentGrid.saveProfile';
const SETUP_WIZARD_COMMAND = 'agentGrid.setupWizard';
const OPEN_WALKTHROUGH_COMMAND = 'agentGrid.openWalkthrough';
const SESSION_STATE_KEY = 'agentGrid.open';
const ONBOARDING_KEY = 'agentGrid.onboarded';
const TERMINAL_TITLE = 'agent-grid';
const DEFAULT_WINDOW_NAME = 'grid';
const PIN_EDITOR_COMMANDS = ['workbench.action.pinEditor', 'workbench.action.keepEditor'];

type WorkspaceReason = 'manual' | 'restore';
type EnvironmentState = 'ready' | 'tmux-missing' | 'native-windows-unsupported';

interface EnvironmentInfo {
  state: EnvironmentState;
  detail: string;
}

interface PaneInfo {
  index: number;
  active: boolean;
}

let controller: AgentGridController | undefined;

class AgentGridController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly outputChannel: vscode.OutputChannel;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Agent Grid');
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = SHOW_ACTIONS_COMMAND;
    this.statusBarItem.show();

    this.disposables.push(
      this.outputChannel,
      this.statusBarItem,
      vscode.commands.registerCommand(CREATE_COMMAND, async () => {
        await this.openWorkspace('manual');
      }),
      vscode.commands.registerCommand(SETUP_PRESET_COMMAND, async () => {
        await this.applyPreset();
      }),
      vscode.commands.registerCommand(APPLY_PROFILE_COMMAND, async () => {
        await this.applyProfile();
      }),
      vscode.commands.registerCommand(SHOW_ACTIONS_COMMAND, async () => {
        await this.showActions();
      }),
      vscode.commands.registerCommand(FOCUS_NEXT_PANE_COMMAND, async () => {
        await this.focusRelativePane(1);
      }),
      vscode.commands.registerCommand(FOCUS_PREVIOUS_PANE_COMMAND, async () => {
        await this.focusRelativePane(-1);
      }),
      vscode.commands.registerCommand(RESTART_ACTIVE_PANE_COMMAND, async () => {
        await this.restartActivePane();
      }),
      vscode.commands.registerCommand(BROADCAST_COMMAND, async () => {
        await this.broadcastCommand();
      }),
      vscode.commands.registerCommand(DIAGNOSE_COMMAND, async () => {
        await this.runDiagnostics();
      }),
      vscode.commands.registerCommand(SAVE_PROFILE_COMMAND, async () => {
        await this.saveCurrentWorkspaceAsProfile();
      }),
      vscode.commands.registerCommand(SETUP_WIZARD_COMMAND, async () => {
        await this.runSetupWizard();
      }),
      vscode.commands.registerCommand(OPEN_WALKTHROUGH_COMMAND, async () => {
        await this.openWalkthrough();
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal.name === TERMINAL_TITLE && !this.findExistingTerminal()) {
          void this.context.workspaceState.update(SESSION_STATE_KEY, false);
        }

        void this.refreshStatus();
      }),
      vscode.window.onDidOpenTerminal(() => {
        void this.refreshStatus();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(EXTENSION_NAMESPACE)) {
          void this.refreshStatus();
        }
      })
    );

    void this.restoreOnStartup();
    void this.refreshStatus();
    void this.promptOnboarding();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async restoreOnStartup(): Promise<void> {
    const autoRestore = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE).get<boolean>('autoRestore', true);
    if (!autoRestore) {
      return;
    }

    const wasOpen = this.context.workspaceState.get<boolean>(SESSION_STATE_KEY, false);
    if (!wasOpen) {
      return;
    }

    await this.openWorkspace('restore');
  }

  private async promptOnboarding(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return;
    }

    const promptOnboarding = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE).get<boolean>('promptOnboarding', true);
    if (!promptOnboarding) {
      return;
    }

    const alreadyOnboarded = this.context.workspaceState.get<boolean>(ONBOARDING_KEY, false);
    if (alreadyOnboarded) {
      return;
    }

    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const terminalsInspection = config.inspect<unknown[]>('terminals');
    const profilesInspection = config.inspect<unknown[]>('profiles');
    const hasConfiguredTerminals = Boolean(
      terminalsInspection?.workspaceValue || terminalsInspection?.workspaceFolderValue || terminalsInspection?.globalValue
    );
    const hasProfiles = Boolean(
      profilesInspection?.workspaceValue || profilesInspection?.workspaceFolderValue || profilesInspection?.globalValue
    );

    if (hasConfiguredTerminals || hasProfiles) {
      await this.context.workspaceState.update(ONBOARDING_KEY, true);
      return;
    }

    const action = await vscode.window.showInformationMessage(
      'Agent Grid can set up a tmux-backed workspace for your agents and tasks.',
      'Run Setup Wizard',
      'Open Guide',
      'Dismiss'
    );

    if (action === 'Run Setup Wizard') {
      await this.context.workspaceState.update(ONBOARDING_KEY, true);
      await this.runSetupWizard();
      return;
    }

    if (action === 'Open Guide') {
      await this.context.workspaceState.update(ONBOARDING_KEY, true);
      await this.openWalkthrough();
      return;
    }

    if (action === 'Dismiss') {
      await this.context.workspaceState.update(ONBOARDING_KEY, true);
    }
  }

  private async openWorkspace(reason: WorkspaceReason): Promise<void> {
    const session = this.getSessionFromSettings();
    const environment = await this.inspectEnvironment(session);

    if (environment.state !== 'ready') {
      if (reason === 'manual') {
        await vscode.window.showErrorMessage(environment.detail);
      }

      await this.refreshStatus(environment);
      return;
    }

    const existingTerminal = this.findExistingTerminal();
    let recreate = false;

    if (reason === 'manual' && existingTerminal) {
      const action = await vscode.window.showInformationMessage(
        'The Agent Grid terminal is already open.',
        { modal: true },
        'Focus',
        'Recreate'
      );

      if (!action) {
        return;
      }

      if (action === 'Focus') {
        await this.revealAndPinTerminal(existingTerminal, false);
        await this.context.workspaceState.update(SESSION_STATE_KEY, true);
        await this.refreshStatus(environment);
        return;
      }

      recreate = true;
      await this.disposeTerminal(existingTerminal);
    } else if (reason === 'manual' && (await this.hasDetachedTmuxSession(session))) {
      const action = await vscode.window.showInformationMessage(
        'The Agent Grid workspace is still running in tmux.',
        { modal: true },
        'Attach',
        'Recreate'
      );

      if (!action) {
        return;
      }

      recreate = action === 'Recreate';
    } else if (reason === 'restore' && existingTerminal) {
      await this.revealAndPinTerminal(existingTerminal, true);
      await this.context.workspaceState.update(SESSION_STATE_KEY, true);
      await this.refreshStatus(environment);
      return;
    }

    const terminal = this.createTerminal();
    await this.revealAndPinTerminal(terminal, reason === 'restore');
    terminal.sendText(this.buildBootstrapCommand(session, recreate), true);
    await this.context.workspaceState.update(SESSION_STATE_KEY, true);
    await this.refreshStatus(environment);
  }

  private async applyPreset(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      await vscode.window.showErrorMessage('Open a folder or workspace before applying an Agent Grid preset.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      BUILTIN_PRESETS.map((preset) => ({
        label: preset.label,
        description: preset.description,
        preset
      })),
      {
        placeHolder: 'Choose an Agent Grid workspace preset'
      }
    );

    if (!picked) {
      return;
    }

    await this.writeWorkspaceConfiguration(picked.preset.layout, picked.preset.terminals);

    const action = await vscode.window.showInformationMessage(
      `Applied the "${picked.preset.label}" preset to workspace settings.`,
      'Create Workspace'
    );

    await this.refreshStatus();

    if (action === 'Create Workspace') {
      await this.openWorkspace('manual');
    }
  }

  private async openWalkthrough(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'padjon.vscode-agent-grid#getting-started', false);
  }

  private async runSetupWizard(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      await vscode.window.showErrorMessage('Open a folder or workspace before running the Agent Grid setup wizard.');
      return;
    }

    const detectedAgents = await this.detectInstalledAgentCommands();
    const presetIds = new Set<string>();

    presetIds.add('solo-dev');

    if (detectedAgents.size >= 2) {
      presetIds.add('mixed-agents');
      presetIds.add('claude-codex-tests');
    }

    if (detectedAgents.has('claude')) {
      presetIds.add('claude-focused');
    }

    if (detectedAgents.has('codex')) {
      presetIds.add('codex-focused');
    }

    if (detectedAgents.has('gemini')) {
      presetIds.add('gemini');
    }

    if (detectedAgents.has('aider')) {
      presetIds.add('aider');
    }

    if (detectedAgents.has('goose')) {
      presetIds.add('goose');
    }

    presetIds.add('frontend-backend-tests-ops');

    const recommendedPresets = BUILTIN_PRESETS.filter((preset) => presetIds.has(preset.id));
    const remainingPresets = BUILTIN_PRESETS.filter((preset) => !presetIds.has(preset.id));

    const picked = await vscode.window.showQuickPick(
      [
        ...recommendedPresets.map((preset) => ({
          label: preset.label,
          description: `Recommended: ${preset.description}`,
          preset
        })),
        ...remainingPresets.map((preset) => ({
          label: preset.label,
          description: preset.description,
          preset
        }))
      ],
      {
        placeHolder:
          detectedAgents.size > 0
            ? `Detected agent CLIs: ${Array.from(detectedAgents).join(', ')}`
            : 'Choose a starter layout for Agent Grid'
      }
    );

    if (!picked) {
      return;
    }

    await this.writeWorkspaceConfiguration(picked.preset.layout, picked.preset.terminals);
    await this.context.workspaceState.update(ONBOARDING_KEY, true);

    const environment = await this.inspectEnvironment(this.getSessionFromSettings());
    if (environment.state !== 'ready') {
      const action = await vscode.window.showWarningMessage(
        `Preset applied. ${environment.detail}`,
        'Run Environment Check',
        'Open Settings'
      );

      if (action === 'Run Environment Check') {
        await this.runDiagnostics();
      } else if (action === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:padjon.vscode-agent-grid agentGrid');
      }

      await this.refreshStatus(environment);
      return;
    }

    const action = await vscode.window.showInformationMessage(
      `Applied "${picked.preset.label}".`,
      'Create Workspace',
      'Save As Profile'
    );

    if (action === 'Create Workspace') {
      await this.openWorkspace('manual');
      return;
    }

    if (action === 'Save As Profile') {
      await this.saveCurrentWorkspaceAsProfile();
    }
  }

  private async applyProfile(): Promise<void> {
    const profiles = this.getProfilesFromSettings();
    if (profiles.length === 0) {
      await vscode.window.showInformationMessage(
        'No saved Agent Grid profiles are configured. Add entries to agentGrid.profiles in workspace settings first.'
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      profiles.map((profile) => ({
        label: profile.name,
        description: `${profile.terminals.length} panes, ${profile.layout}`,
        profile
      })),
      {
        placeHolder: 'Choose a saved Agent Grid profile'
      }
    );

    if (!picked) {
      return;
    }

    await this.writeWorkspaceConfiguration(picked.profile.layout, picked.profile.terminals);
    const action = await vscode.window.showInformationMessage(
      `Applied the "${picked.profile.name}" profile to workspace settings.`,
      'Create Workspace'
    );

    await this.refreshStatus();

    if (action === 'Create Workspace') {
      await this.openWorkspace('manual');
    }
  }

  private async focusRelativePane(offset: 1 | -1): Promise<void> {
    await this.runPaneMutation(async (session) => {
      const panes = await this.listPanes(session);
      if (panes.length === 0) {
        throw new Error('No tmux panes were found for the current Agent Grid session.');
      }

      const activeIndex = panes.findIndex((pane) => pane.active);
      const current = activeIndex >= 0 ? activeIndex : 0;
      const next = (current + offset + panes.length) % panes.length;
      const targetPane = panes[next];

      await this.execTmux(session, ['select-pane', '-t', `${session.sessionName}:${session.windowName}.${targetPane.index}`]);
    });
  }

  private async restartActivePane(): Promise<void> {
    await this.runPaneMutation(async (session) => {
      const panes = await this.listPanes(session);
      const activePane = panes.find((pane) => pane.active) ?? panes[0];
      if (!activePane) {
        throw new Error('No tmux panes were found for the current Agent Grid session.');
      }

      const definition = session.terminals[activePane.index];
      const target = `${session.sessionName}:${session.windowName}.${activePane.index}`;
      const cwd = this.resolveCwd(definition?.cwd) ?? this.getWorkspaceRoot() ?? process.cwd();
      const startupCommand = this.expandVariables(definition?.startupCommand ?? '').trim();
      const args = ['respawn-pane', '-k', '-t', target, '-c', cwd];

      if (startupCommand) {
        args.push(startupCommand);
      }

      await this.execTmux(session, args);
    });
  }

  private async broadcastCommand(): Promise<void> {
    const command = await vscode.window.showInputBox({
      prompt: 'Command to send to every Agent Grid pane',
      placeHolder: 'npm test'
    });

    if (!command?.trim()) {
      return;
    }

    await this.runPaneMutation(async (session) => {
      const panes = await this.listPanes(session);
      for (const pane of panes) {
        await this.execTmux(session, [
          'send-keys',
          '-t',
          `${session.sessionName}:${session.windowName}.${pane.index}`,
          command.trim(),
          'C-m'
        ]);
      }
    });
  }

  private async runDiagnostics(): Promise<void> {
    const session = this.getSessionFromSettings();
    const environment = await this.inspectEnvironment(session);
    const detached = environment.state === 'ready' ? await this.hasDetachedTmuxSession(session) : false;
    const terminalOpen = Boolean(this.findExistingTerminal());
    const tmuxCommand = expandHomeDirectory(this.expandVariables(session.tmuxCommand).trim());
    let tmuxVersion = 'unavailable';

    if (environment.state === 'ready') {
      try {
        tmuxVersion = await this.execTmux(session, ['-V']);
      } catch (error) {
        tmuxVersion = `error: ${asErrorMessage(error)}`;
      }
    }

    const lines = [
      `Timestamp: ${new Date().toISOString()}`,
      `Workspace root: ${this.getWorkspaceRoot() ?? '(none)'}`,
      `Remote name: ${vscode.env.remoteName ?? '(local)'}`,
      `Platform: ${process.platform}`,
      `tmux command: ${tmuxCommand || '(empty)'}`,
      `tmux version: ${tmuxVersion}`,
      `Environment state: ${environment.state}`,
      `Environment detail: ${environment.detail}`,
      `Configured layout: ${session.layout}`,
      `Configured panes: ${session.terminals.length}`,
      `Terminal open: ${terminalOpen ? 'yes' : 'no'}`,
      `Detached tmux session: ${detached ? 'yes' : 'no'}`
    ];

    this.outputChannel.clear();
    this.outputChannel.appendLine('Agent Grid Environment Check');
    this.outputChannel.appendLine('');

    for (const line of lines) {
      this.outputChannel.appendLine(line);
    }

    if (environment.state === 'tmux-missing') {
      this.outputChannel.appendLine('');
      this.outputChannel.appendLine('Recommended next step: install tmux or set agentGrid.tmuxCommand correctly.');
    } else if (environment.state === 'native-windows-unsupported') {
      this.outputChannel.appendLine('');
      this.outputChannel.appendLine('Recommended next step: reopen the repository in WSL and install tmux there.');
    } else if (!terminalOpen && !detached) {
      this.outputChannel.appendLine('');
      this.outputChannel.appendLine('Recommended next step: run Agent Grid: Create or Recreate Workspace.');
    }

    this.outputChannel.show(true);
    await this.refreshStatus(environment);
    await vscode.window.showInformationMessage('Agent Grid environment check written to the "Agent Grid" output channel.');
  }

  private async saveCurrentWorkspaceAsProfile(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      await vscode.window.showErrorMessage('Open a folder or workspace before saving an Agent Grid profile.');
      return;
    }

    const session = this.getSessionFromSettings();
    const profileName = await vscode.window.showInputBox({
      prompt: 'Name for the saved Agent Grid profile',
      value: this.buildDefaultProfileName(),
      validateInput: (value) => (value.trim() ? undefined : 'Profile name is required.')
    });

    if (!profileName?.trim()) {
      return;
    }

    const profiles = this.getProfilesFromSettings();
    const existingIndex = profiles.findIndex((profile) => profile.name === profileName.trim());

    if (existingIndex >= 0) {
      const overwrite = await vscode.window.showWarningMessage(
        `A profile named "${profileName.trim()}" already exists.`,
        { modal: true },
        'Overwrite'
      );

      if (overwrite !== 'Overwrite') {
        return;
      }
    }

    const nextProfile: WorkspaceProfile = {
      name: profileName.trim(),
      layout: session.layout,
      terminals: session.terminals
    };
    const nextProfiles = existingIndex >= 0 ? [...profiles] : [...profiles, nextProfile];

    if (existingIndex >= 0) {
      nextProfiles[existingIndex] = nextProfile;
    }

    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    await config.update('profiles', nextProfiles, vscode.ConfigurationTarget.Workspace);

    await vscode.window.showInformationMessage(`Saved the "${nextProfile.name}" Agent Grid profile to workspace settings.`);
  }

  private async runPaneMutation(action: (session: WorkspaceSession) => Promise<void>): Promise<void> {
    const session = this.getSessionFromSettings();
    const environment = await this.inspectEnvironment(session);

    if (environment.state !== 'ready') {
      await vscode.window.showErrorMessage(environment.detail);
      await this.refreshStatus(environment);
      return;
    }

    if (!(await this.hasDetachedTmuxSession(session)) && !this.findExistingTerminal()) {
      await vscode.window.showInformationMessage('Create the Agent Grid workspace before using pane actions.');
      return;
    }

    try {
      await action(session);
      await this.refreshStatus(environment);
    } catch (error) {
      await vscode.window.showErrorMessage(asErrorMessage(error));
    }
  }

  private async showActions(): Promise<void> {
    const session = this.getSessionFromSettings();
    const environment = await this.inspectEnvironment(session);
    const existingTerminal = this.findExistingTerminal();
    const items: Array<{ label: string; description: string; run: () => Promise<void> }> = [];

    if (existingTerminal) {
      items.push({
        label: 'Focus Workspace',
        description: 'Reveal the pinned agent-grid terminal',
        run: async () => {
          await this.revealAndPinTerminal(existingTerminal, false);
          await this.refreshStatus(environment);
        }
      });
    }

    items.push(
      {
        label: 'Create or Recreate Workspace',
        description: 'Start the tmux-backed workspace or reattach to it',
        run: async () => {
          await this.openWorkspace('manual');
        }
      },
      {
        label: 'Apply Workspace Preset',
        description: 'Write a preset layout into workspace settings',
        run: async () => {
          await this.applyPreset();
        }
      },
      {
        label: 'Run Setup Wizard',
        description: 'Detect common agent CLIs and apply a recommended starter layout',
        run: async () => {
          await this.runSetupWizard();
        }
      },
      {
        label: 'Open Getting Started Guide',
        description: 'Open the built-in walkthrough for first-time setup',
        run: async () => {
          await this.openWalkthrough();
        }
      },
      {
        label: 'Apply Saved Profile',
        description: 'Use a repo-defined profile from agentGrid.profiles',
        run: async () => {
          await this.applyProfile();
        }
      },
      {
        label: 'Focus Next Pane',
        description: 'Select the next tmux pane in the current workspace',
        run: async () => {
          await this.focusRelativePane(1);
        }
      },
      {
        label: 'Focus Previous Pane',
        description: 'Select the previous tmux pane in the current workspace',
        run: async () => {
          await this.focusRelativePane(-1);
        }
      },
      {
        label: 'Restart Active Pane',
        description: 'Respawn the current pane and rerun its startup command',
        run: async () => {
          await this.restartActivePane();
        }
      },
      {
        label: 'Broadcast Command To All Panes',
        description: 'Send one command to every pane in the workspace',
        run: async () => {
          await this.broadcastCommand();
        }
      },
      {
        label: 'Save Current Workspace As Profile',
        description: 'Store the current layout and pane config in agentGrid.profiles',
        run: async () => {
          await this.saveCurrentWorkspaceAsProfile();
        }
      },
      {
        label: 'Run Environment Check',
        description: 'Write diagnostics and setup hints to the Agent Grid output channel',
        run: async () => {
          await this.runDiagnostics();
        }
      },
      {
        label: 'Open Agent Grid Settings',
        description: 'Review layout, panes, and tmux command settings',
        run: async () => {
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:padjon.vscode-agent-grid agentGrid');
        }
      }
    );

    if (environment.state !== 'ready') {
      items.unshift({
        label: 'Environment Guidance',
        description: environment.detail,
        run: async () => {
          await vscode.window.showInformationMessage(environment.detail);
        }
      });
    }

    const picked = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: item.label,
        description: item.description,
        run: item.run
      })),
      {
        placeHolder: 'Choose an Agent Grid action'
      }
    );

    if (picked) {
      await picked.run();
    }
  }

  private async writeWorkspaceConfiguration(layout: LayoutName, terminals: TerminalDefinition[]): Promise<void> {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    await config.update('layout', layout, vscode.ConfigurationTarget.Workspace);
    await config.update('terminals', terminals, vscode.ConfigurationTarget.Workspace);
    await this.context.workspaceState.update(ONBOARDING_KEY, true);
  }

  private buildDefaultProfileName(): string {
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
    return workspaceName ? `${workspaceName} workspace` : 'Agent Grid workspace';
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

  private async hasDetachedTmuxSession(session: WorkspaceSession): Promise<boolean> {
    if (this.findExistingTerminal()) {
      return false;
    }

    const tmuxCommand = expandHomeDirectory(this.expandVariables(session.tmuxCommand).trim());
    if (!tmuxCommand) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      execFile(tmuxCommand, ['has-session', '-t', session.sessionName], (error) => {
        resolve(!error);
      });
    });
  }

  private async inspectEnvironment(session: WorkspaceSession): Promise<EnvironmentInfo> {
    if (process.platform === 'win32' && vscode.env.remoteName !== 'wsl') {
      return {
        state: 'native-windows-unsupported',
        detail:
          'Agent Grid is WSL-first on Windows. Open the project in WSL and install tmux there, then run Agent Grid from the WSL extension host.'
      };
    }

    const tmuxCommand = expandHomeDirectory(this.expandVariables(session.tmuxCommand).trim());
    if (!tmuxCommand) {
      return {
        state: 'tmux-missing',
        detail: 'Set agentGrid.tmuxCommand to a valid tmux executable before creating the workspace.'
      };
    }

    const tmuxAvailable = await new Promise<boolean>((resolve) => {
      execFile(tmuxCommand, ['-V'], (error) => {
        resolve(!error);
      });
    });

    if (tmuxAvailable) {
      return {
        state: 'ready',
        detail: 'tmux is available.'
      };
    }

    return {
      state: 'tmux-missing',
      detail: this.buildTmuxInstallHint()
    };
  }

  private async detectInstalledAgentCommands(): Promise<Set<string>> {
    const detected = new Set<string>();
    const candidates = ['claude', 'codex', 'gemini', 'aider', 'goose'];

    for (const command of candidates) {
      if (await this.commandExists(command)) {
        detected.add(command);
      }
    }

    return detected;
  }

  private async commandExists(command: string): Promise<boolean> {
    if (process.platform === 'win32' && vscode.env.remoteName !== 'wsl') {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      execFile('bash', ['-lc', `command -v ${command}`], (error) => {
        resolve(!error);
      });
    });
  }

  private async execTmux(session: WorkspaceSession, args: string[]): Promise<string> {
    const tmuxCommand = expandHomeDirectory(this.expandVariables(session.tmuxCommand).trim());

    return new Promise<string>((resolve, reject) => {
      execFile(tmuxCommand, args, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        resolve(stdout.trim());
      });
    });
  }

  private async listPanes(session: WorkspaceSession): Promise<PaneInfo[]> {
    const output = await this.execTmux(session, [
      'list-panes',
      '-t',
      `${session.sessionName}:${session.windowName}`,
      '-F',
      '#{pane_index} #{pane_active}'
    ]);

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [indexText, activeText] = line.split(/\s+/, 2);
        return {
          index: Number(indexText),
          active: activeText === '1'
        };
      })
      .filter((pane) => Number.isInteger(pane.index));
  }

  private buildTmuxInstallHint(): string {
    if (vscode.env.remoteName === 'wsl') {
      return 'tmux was not found in this WSL environment. Install it there, for example with `sudo apt install tmux`, then recreate the workspace.';
    }

    if (process.platform === 'darwin') {
      return 'tmux was not found. Install it first, for example with `brew install tmux`, then recreate the workspace.';
    }

    if (process.platform === 'linux') {
      return 'tmux was not found. Install it with your Linux package manager, then recreate the workspace.';
    }

    return 'tmux was not found. Configure agentGrid.tmuxCommand or install tmux before creating the workspace.';
  }

  private async revealAndPinTerminal(terminal: vscode.Terminal, preserveFocus: boolean): Promise<void> {
    const previousEditor = preserveFocus ? captureEditorState(vscode.window.activeTextEditor) : undefined;

    terminal.show(false);
    await this.waitForActiveTerminal(terminal);
    await this.pinActiveEditor();

    if (previousEditor) {
      await vscode.window.showTextDocument(previousEditor.document, {
        viewColumn: previousEditor.viewColumn,
        preserveFocus: false,
        selection: previousEditor.selection
      });
    }
  }

  private async waitForActiveTerminal(terminal: vscode.Terminal, timeoutMs = 1000): Promise<void> {
    if (vscode.window.activeTerminal === terminal) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }

        settled = true;
        changeListener.dispose();
        timeout.dispose();
        resolve();
      };

      const changeListener = vscode.window.onDidChangeActiveTerminal((activeTerminal) => {
        if (activeTerminal === terminal) {
          finish();
        }
      });

      const timeout = setDisposableTimeout(finish, timeoutMs);
    });
  }

  private async pinActiveEditor(): Promise<void> {
    for (const command of PIN_EDITOR_COMMANDS) {
      try {
        await vscode.commands.executeCommand(command);
        return;
      } catch {
        // Try the next command for compatibility across VS Code versions.
      }
    }
  }

  private async refreshStatus(existingEnvironment?: EnvironmentInfo): Promise<void> {
    const session = this.getSessionFromSettings();
    const environment = existingEnvironment ?? (await this.inspectEnvironment(session));

    if (environment.state === 'native-windows-unsupported') {
      this.statusBarItem.text = '$(warning) Agent Grid: WSL Required';
      this.statusBarItem.tooltip = environment.detail;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    if (environment.state === 'tmux-missing') {
      this.statusBarItem.text = '$(warning) Agent Grid: tmux Missing';
      this.statusBarItem.tooltip = environment.detail;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      return;
    }

    this.statusBarItem.backgroundColor = undefined;

    if (this.findExistingTerminal()) {
      this.statusBarItem.text = '$(terminal) Agent Grid: Running';
      this.statusBarItem.tooltip = 'The agent-grid terminal is open.';
      return;
    }

    if (await this.hasDetachedTmuxSession(session)) {
      this.statusBarItem.text = '$(plug) Agent Grid: Detached';
      this.statusBarItem.tooltip = 'A matching tmux session is running without the terminal tab attached.';
      return;
    }

    this.statusBarItem.text = '$(terminal) Agent Grid: Idle';
    this.statusBarItem.tooltip = 'Run Agent Grid: Create or Recreate Workspace to start the tmux-backed workspace.';
  }

  private getSessionFromSettings(): WorkspaceSession {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const configuredTerminals = config.get<unknown[]>('terminals', []);
    const rawTerminals = configuredTerminals.length > 0 ? configuredTerminals.slice(0, 8) : DEFAULT_TERMINALS;
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

    return {
      tmuxCommand: readTrimmedString(config.get<string>('tmuxCommand')) ?? 'tmux',
      sessionName: this.buildSessionName(),
      windowName: DEFAULT_WINDOW_NAME,
      layout: readLayoutName(config.get<string>('layout')) ?? 'tiled',
      terminals: terminals.length > 0 ? terminals : DEFAULT_TERMINALS
    };
  }

  private getProfilesFromSettings(): WorkspaceProfile[] {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const configuredProfiles = config.get<unknown[]>('profiles', []);
    const profiles: WorkspaceProfile[] = [];

    for (const value of configuredProfiles) {
      if (!isRecord(value)) {
        continue;
      }

      const name = readTrimmedString(value.name);
      const layout = readLayoutName(value.layout) ?? 'tiled';
      const terminalsValue = Array.isArray(value.terminals) ? value.terminals : [];
      const terminals: TerminalDefinition[] = terminalsValue
        .slice(0, 8)
        .map((terminalValue, index) => {
          const defaults = DEFAULT_TERMINALS[index] ?? buildDefaultTerminal(index + 1);
          const terminal = isRecord(terminalValue) ? terminalValue : {};

          return {
            name: readTrimmedString(terminal.name) ?? defaults.name,
            startupCommand: readString(terminal.startupCommand) ?? defaults.startupCommand,
            cwd: readTrimmedString(terminal.cwd) ?? defaults.cwd
          };
        })
        .filter((terminal) => terminal.name || terminal.startupCommand || terminal.cwd);

      if (!name || terminals.length === 0) {
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
      this.resolveCwd.bind(this),
      process.cwd()
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

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Agent Grid failed to complete the tmux action.';
}

function setDisposableTimeout(callback: () => void, delay: number): vscode.Disposable {
  const handle = setTimeout(callback, delay);
  return new vscode.Disposable(() => {
    clearTimeout(handle);
  });
}

function captureEditorState(editor: vscode.TextEditor | undefined):
  | { document: vscode.TextDocument; viewColumn: vscode.ViewColumn | undefined; selection: vscode.Selection }
  | undefined {
  if (!editor) {
    return undefined;
  }

  return {
    document: editor.document,
    viewColumn: editor.viewColumn,
    selection: editor.selection
  };
}
