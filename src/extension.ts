import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import {
  BUILTIN_PRESETS,
  buildTmuxBootstrapScript,
  mergeProfiles,
  normalizeProfiles,
  normalizeTerminalDefinitions,
  parseRepoConfig,
  readLayoutName,
  sanitizeTmuxName
} from './core';
import type {
  LayoutName,
  RepoConfig,
  TerminalDefinition,
  WorkspacePreset,
  WorkspaceProfile,
  WorkspaceSession
} from './core';

const EXTENSION_NAMESPACE = 'agentGrid';
const SIDEBAR_VIEW_ID = 'agentGrid.sidebar';
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
const OPEN_REPO_CONFIG_COMMAND = 'agentGrid.openRepoConfig';
const SAVE_WORKSPACE_TO_REPO_CONFIG_COMMAND = 'agentGrid.saveWorkspaceToRepoConfig';
const SAVE_PROFILE_TO_REPO_CONFIG_COMMAND = 'agentGrid.saveProfileToRepoConfig';
const IMPORT_REPO_CONFIG_TO_SETTINGS_COMMAND = 'agentGrid.importRepoConfigToSettings';
const CLEAR_WORKSPACE_OVERRIDES_COMMAND = 'agentGrid.clearWorkspaceOverrides';
const MIGRATE_SETTINGS_TO_REPO_CONFIG_COMMAND = 'agentGrid.migrateSettingsToRepoConfig';
const EXPORT_SUPPORT_BUNDLE_COMMAND = 'agentGrid.exportSupportBundle';
const OPEN_ISSUE_TRACKER_COMMAND = 'agentGrid.openIssueTracker';
const EXPORT_USAGE_REPORT_COMMAND = 'agentGrid.exportUsageReport';
const RESET_USAGE_REPORT_COMMAND = 'agentGrid.resetUsageReport';
const SESSION_STATE_KEY = 'agentGrid.open';
const ONBOARDING_KEY = 'agentGrid.onboarded';
const USAGE_METRICS_KEY = 'agentGrid.usageMetrics';
const TERMINAL_TITLE = 'agent-grid';
const DEFAULT_WINDOW_NAME = 'grid';
const REPO_CONFIG_FILE = '.agent-grid.json';
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

interface RepoConfigState {
  path?: string;
  exists: boolean;
  config?: RepoConfig;
  error?: string;
}

interface WorkspaceProjectInfo {
  availableScripts: Set<string>;
  frontendRelativePath?: string;
  backendRelativePath?: string;
  preferredTestCommand?: string;
  preferredLintCommand?: string;
}

interface UsageMetricsEntry {
  count: number;
  firstSeen: string;
  lastSeen: string;
  buckets?: Record<string, number>;
}

interface UsageMetricsState {
  schemaVersion: 1;
  updatedAt?: string;
  events: Record<string, UsageMetricsEntry>;
}

interface UsageMetricsSnapshot {
  enabledInSettings: boolean;
  vscodeTelemetryEnabled: boolean;
  active: boolean;
  totalEvents: number;
  eventTypes: number;
  updatedAt?: string;
}

interface AgentGridSidebarSnapshot {
  hasWorkspaceFolder: boolean;
  hasConfiguredWorkspace: boolean;
  shouldShowWelcome: boolean;
  environment: EnvironmentInfo;
  terminalOpen: boolean;
  detached: boolean;
  session: WorkspaceSession;
  profiles: WorkspaceProfile[];
  presets: WorkspacePreset[];
  repoConfig: RepoConfigState;
  usageMetrics: UsageMetricsSnapshot;
}

interface AgentGridSidebarNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: vscode.ThemeIcon;
  collapsibleState: vscode.TreeItemCollapsibleState;
  command?: vscode.Command;
  children?: AgentGridSidebarNode[];
}

let controller: AgentGridController | undefined;

class AgentGridController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly sidebarProvider: AgentGridSidebarProvider;
  private readonly treeView: vscode.TreeView<AgentGridSidebarNode>;
  private readonly usageMetrics: UsageMetricsService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Agent Grid');
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = SHOW_ACTIONS_COMMAND;
    this.statusBarItem.show();
    this.usageMetrics = new UsageMetricsService(context, this.outputChannel);
    this.sidebarProvider = new AgentGridSidebarProvider();
    this.treeView = vscode.window.createTreeView(SIDEBAR_VIEW_ID, {
      treeDataProvider: this.sidebarProvider,
      showCollapseAll: false
    });
    const repoConfigWatcher = this.createRepoConfigWatcher();

    this.disposables.push(
      this.outputChannel,
      this.statusBarItem,
      this.treeView,
      this.usageMetrics,
      ...(repoConfigWatcher ? [repoConfigWatcher] : []),
      vscode.commands.registerCommand(CREATE_COMMAND, async () => {
        await this.openWorkspace('manual');
      }),
      vscode.commands.registerCommand(SETUP_PRESET_COMMAND, async (presetId?: string) => {
        await this.applyPreset(presetId);
      }),
      vscode.commands.registerCommand(APPLY_PROFILE_COMMAND, async (profileName?: string) => {
        await this.applyProfile(profileName);
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
      vscode.commands.registerCommand(OPEN_REPO_CONFIG_COMMAND, async () => {
        await this.openRepoConfig();
      }),
      vscode.commands.registerCommand(SAVE_WORKSPACE_TO_REPO_CONFIG_COMMAND, async () => {
        await this.saveWorkspaceToRepoConfig();
      }),
      vscode.commands.registerCommand(SAVE_PROFILE_TO_REPO_CONFIG_COMMAND, async () => {
        await this.saveProfileToRepoConfig();
      }),
      vscode.commands.registerCommand(IMPORT_REPO_CONFIG_TO_SETTINGS_COMMAND, async () => {
        await this.importRepoConfigToSettings();
      }),
      vscode.commands.registerCommand(CLEAR_WORKSPACE_OVERRIDES_COMMAND, async () => {
        await this.clearWorkspaceOverrides();
      }),
      vscode.commands.registerCommand(MIGRATE_SETTINGS_TO_REPO_CONFIG_COMMAND, async () => {
        await this.migrateSettingsToRepoConfig();
      }),
      vscode.commands.registerCommand(EXPORT_SUPPORT_BUNDLE_COMMAND, async () => {
        await this.exportSupportBundle();
      }),
      vscode.commands.registerCommand(OPEN_ISSUE_TRACKER_COMMAND, async () => {
        await this.openIssueTracker();
      }),
      vscode.commands.registerCommand(EXPORT_USAGE_REPORT_COMMAND, async () => {
        await this.exportUsageReport();
      }),
      vscode.commands.registerCommand(RESET_USAGE_REPORT_COMMAND, async () => {
        await this.resetUsageReport();
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal.name === TERMINAL_TITLE && !this.findExistingTerminal()) {
          void this.context.workspaceState.update(SESSION_STATE_KEY, false);
        }

        void this.refreshSurface();
      }),
      vscode.window.onDidOpenTerminal(() => {
        void this.refreshSurface();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(EXTENSION_NAMESPACE)) {
          void this.refreshSurface();
        }
      })
    );

    this.usageMetrics.record('activate');
    void this.restoreOnStartup();
    void this.refreshSurface();
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

    if (this.hasConfiguredWorkspaceSettings() || this.hasRepoConfiguration()) {
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
      this.usageMetrics.record('onboarding_action', 'setup_wizard');
      await this.context.workspaceState.update(ONBOARDING_KEY, true);
      await this.runSetupWizard();
      return;
    }

    if (action === 'Open Guide') {
      this.usageMetrics.record('onboarding_action', 'open_guide');
      await this.context.workspaceState.update(ONBOARDING_KEY, true);
      await this.openWalkthrough();
      return;
    }

    if (action === 'Dismiss') {
      this.usageMetrics.record('onboarding_action', 'dismiss');
      await this.context.workspaceState.update(ONBOARDING_KEY, true);
    }
  }

  private createRepoConfigWatcher(): vscode.FileSystemWatcher | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return undefined;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, REPO_CONFIG_FILE));
    watcher.onDidCreate(() => {
      void this.refreshSurface();
    });
    watcher.onDidChange(() => {
      void this.refreshSurface();
    });
    watcher.onDidDelete(() => {
      void this.refreshSurface();
    });
    return watcher;
  }

  async getSidebarSnapshot(existingEnvironment?: EnvironmentInfo): Promise<AgentGridSidebarSnapshot> {
    const repoConfig = this.getRepoConfigState();
    const session = this.getSessionFromSettings();
    const environment = existingEnvironment ?? (await this.inspectEnvironment(session));
    const profiles = this.getProfilesFromSettings();
    const terminalOpen = Boolean(this.findExistingTerminal());
    const detached = environment.state === 'ready' ? await this.hasDetachedTmuxSession(session) : false;
    const hasWorkspaceFolder = Boolean(vscode.workspace.workspaceFolders?.length);
    const hasConfiguredWorkspace = this.hasConfiguredWorkspaceSettings() || this.hasRepoConfiguration(repoConfig) || profiles.length > 0;
    const shouldShowWelcome = !hasWorkspaceFolder || (!hasConfiguredWorkspace && !terminalOpen && !detached);

    return {
      hasWorkspaceFolder,
      hasConfiguredWorkspace,
      shouldShowWelcome,
      environment,
      terminalOpen,
      detached,
      session,
      profiles,
      presets: BUILTIN_PRESETS,
      repoConfig,
      usageMetrics: this.usageMetrics.getSnapshot()
    };
  }

  private async refreshSurface(existingEnvironment?: EnvironmentInfo): Promise<void> {
    await this.refreshStatus(existingEnvironment);
    await this.refreshSidebar(existingEnvironment);
  }

  private async refreshSidebar(existingEnvironment?: EnvironmentInfo): Promise<void> {
    const snapshot = await this.getSidebarSnapshot(existingEnvironment);
    await vscode.commands.executeCommand('setContext', 'agentGrid.hasWorkspaceFolder', snapshot.hasWorkspaceFolder);
    await vscode.commands.executeCommand('setContext', 'agentGrid.showSidebarWelcome', snapshot.shouldShowWelcome);
    this.sidebarProvider.setSnapshot(snapshot);
  }

  private hasConfiguredWorkspaceSettings(): boolean {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const tmuxInspection = config.inspect<string>('tmuxCommand');
    const layoutInspection = config.inspect<string>('layout');
    const terminalsInspection = config.inspect<unknown[]>('terminals');
    const profilesInspection = config.inspect<unknown[]>('profiles');

    return Boolean(
      tmuxInspection?.workspaceValue ||
        tmuxInspection?.workspaceFolderValue ||
        tmuxInspection?.globalValue ||
        layoutInspection?.workspaceValue ||
        layoutInspection?.workspaceFolderValue ||
        layoutInspection?.globalValue ||
      terminalsInspection?.workspaceValue ||
        terminalsInspection?.workspaceFolderValue ||
        terminalsInspection?.globalValue ||
        profilesInspection?.workspaceValue ||
        profilesInspection?.workspaceFolderValue ||
        profilesInspection?.globalValue
    );
  }

  private hasRepoConfiguration(repoConfig: RepoConfigState = this.getRepoConfigState()): boolean {
    if (!repoConfig.config) {
      return false;
    }

    return Boolean(
      repoConfig.config.tmuxCommand ||
        repoConfig.config.layout ||
        (repoConfig.config.terminals && repoConfig.config.terminals.length > 0) ||
        (repoConfig.config.profiles && repoConfig.config.profiles.length > 0)
    );
  }

  private getRepoConfigPath(): string | undefined {
    const workspaceRoot = this.getWorkspaceRoot();
    return workspaceRoot ? path.join(workspaceRoot, REPO_CONFIG_FILE) : undefined;
  }

  private getRepoConfigState(): RepoConfigState {
    const repoConfigPath = this.getRepoConfigPath();
    if (!repoConfigPath) {
      return { exists: false };
    }

    if (!fs.existsSync(repoConfigPath)) {
      return {
        path: repoConfigPath,
        exists: false
      };
    }

    try {
      const raw = fs.readFileSync(repoConfigPath, 'utf8');
      return {
        path: repoConfigPath,
        exists: true,
        config: parseRepoConfig(raw)
      };
    } catch (error) {
      return {
        path: repoConfigPath,
        exists: true,
        error: asErrorMessage(error)
      };
    }
  }

  private getWritableRepoConfig(): { path: string; config: RepoConfig } | undefined {
    const repoConfig = this.getRepoConfigState();
    if (!repoConfig.path) {
      return undefined;
    }

    if (repoConfig.exists && repoConfig.error) {
      return undefined;
    }

    return {
      path: repoConfig.path,
      config: repoConfig.config ?? {}
    };
  }

  private async writeRepoConfig(config: RepoConfig): Promise<void> {
    const writable = this.getWritableRepoConfig();
    if (!writable) {
      throw new Error(`Fix ${REPO_CONFIG_FILE} before saving to repo config.`);
    }

    fs.writeFileSync(writable.path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await this.refreshSurface();
  }

  private async updateWorkspaceOverrides(
    values: Partial<Record<'tmuxCommand' | 'layout' | 'terminals' | 'profiles', unknown>>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);

    if ('tmuxCommand' in values) {
      await config.update('tmuxCommand', values.tmuxCommand, vscode.ConfigurationTarget.Workspace);
    }

    if ('layout' in values) {
      await config.update('layout', values.layout, vscode.ConfigurationTarget.Workspace);
    }

    if ('terminals' in values) {
      await config.update('terminals', values.terminals, vscode.ConfigurationTarget.Workspace);
    }

    if ('profiles' in values) {
      await config.update('profiles', values.profiles, vscode.ConfigurationTarget.Workspace);
    }
  }

  private async openRepoConfig(): Promise<void> {
    const repoConfig = this.getRepoConfigState();
    if (!repoConfig.path) {
      await vscode.window.showErrorMessage('Open a folder or workspace before opening an Agent Grid repo config.');
      return;
    }

    if (!repoConfig.exists) {
      const session = this.getSessionFromSettings();
      const profiles = this.getProfilesFromSettings();
      const initialConfig: RepoConfig = {
        layout: session.layout,
        terminals: session.terminals
      };

      if (session.tmuxCommand !== 'tmux') {
        initialConfig.tmuxCommand = session.tmuxCommand;
      }

      if (profiles.length > 0) {
        initialConfig.profiles = profiles;
      }

      fs.writeFileSync(repoConfig.path, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf8');
      this.usageMetrics.record('repo_config', 'create');
      await vscode.window.showInformationMessage(`Created ${REPO_CONFIG_FILE} in the workspace root.`);
      await this.refreshSurface();
    } else if (repoConfig.error) {
      this.usageMetrics.record('repo_config', 'parse_error');
      await vscode.window.showWarningMessage(`Open and fix ${REPO_CONFIG_FILE}: ${repoConfig.error}`);
    }

    this.usageMetrics.record('repo_config', 'open');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(repoConfig.path));
    await vscode.window.showTextDocument(document);
  }

  private async saveWorkspaceToRepoConfig(): Promise<void> {
    const writable = this.getWritableRepoConfig();
    if (!writable) {
      await vscode.window.showErrorMessage(`Fix ${REPO_CONFIG_FILE} before saving Agent Grid workspace settings into it.`);
      return;
    }

    const session = this.getSessionFromSettings();
    const nextConfig: RepoConfig = {
      ...writable.config,
      layout: session.layout,
      terminals: session.terminals
    };

    if (session.tmuxCommand !== 'tmux') {
      nextConfig.tmuxCommand = session.tmuxCommand;
    } else {
      delete nextConfig.tmuxCommand;
    }

    await this.writeRepoConfig(nextConfig);
    this.usageMetrics.record('repo_config', 'save_workspace');
    await vscode.window.showInformationMessage(`Saved the current Agent Grid workspace into ${REPO_CONFIG_FILE}.`);
  }

  private async saveProfileToRepoConfig(): Promise<void> {
    const writable = this.getWritableRepoConfig();
    if (!writable) {
      await vscode.window.showErrorMessage(`Fix ${REPO_CONFIG_FILE} before saving Agent Grid profiles into it.`);
      return;
    }

    const session = this.getSessionFromSettings();
    const profileName = await vscode.window.showInputBox({
      prompt: 'Name for the repo-level Agent Grid profile',
      value: this.buildDefaultProfileName(),
      validateInput: (value) => (value.trim() ? undefined : 'Profile name is required.')
    });

    if (!profileName?.trim()) {
      return;
    }

    const currentProfiles = writable.config.profiles ?? [];
    const nextProfile: WorkspaceProfile = {
      name: profileName.trim(),
      layout: session.layout,
      terminals: session.terminals
    };
    const nextProfiles = [...currentProfiles];
    const existingIndex = nextProfiles.findIndex((profile) => profile.name === nextProfile.name);

    if (existingIndex >= 0) {
      const overwrite = await vscode.window.showWarningMessage(
        `A repo config profile named "${nextProfile.name}" already exists.`,
        { modal: true },
        'Overwrite'
      );

      if (overwrite !== 'Overwrite') {
        return;
      }

      nextProfiles[existingIndex] = nextProfile;
    } else {
      nextProfiles.push(nextProfile);
    }

    await this.writeRepoConfig({
      ...writable.config,
      profiles: nextProfiles
    });
    this.usageMetrics.record('repo_config', 'save_profile');
    await vscode.window.showInformationMessage(`Saved the "${nextProfile.name}" profile into ${REPO_CONFIG_FILE}.`);
  }

  private async importRepoConfigToSettings(): Promise<void> {
    const repoConfig = this.getRepoConfigState();
    if (!repoConfig.exists || repoConfig.error || !repoConfig.config) {
      await vscode.window.showErrorMessage(`Load a valid ${REPO_CONFIG_FILE} before importing it into workspace settings.`);
      return;
    }

    await this.updateWorkspaceOverrides({
      tmuxCommand: repoConfig.config.tmuxCommand ?? undefined,
      layout: repoConfig.config.layout ?? undefined,
      terminals: repoConfig.config.terminals ?? undefined,
      profiles: repoConfig.config.profiles ?? undefined
    });

    this.usageMetrics.record('migration', 'import_repo_to_settings');
    await this.refreshSurface();
    await vscode.window.showInformationMessage(`Imported ${REPO_CONFIG_FILE} into Agent Grid workspace settings.`);
  }

  private async clearWorkspaceOverrides(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      'Clear Agent Grid workspace overrides from VS Code settings and fall back to repo config or defaults?',
      { modal: true },
      'Clear'
    );

    if (confirmed !== 'Clear') {
      return;
    }

    await this.updateWorkspaceOverrides({
      tmuxCommand: undefined,
      layout: undefined,
      terminals: undefined,
      profiles: undefined
    });

    this.usageMetrics.record('migration', 'clear_workspace_overrides');
    await this.refreshSurface();
    await vscode.window.showInformationMessage('Cleared Agent Grid workspace overrides from VS Code settings.');
  }

  private async migrateSettingsToRepoConfig(): Promise<void> {
    const writable = this.getWritableRepoConfig();
    if (!writable) {
      await vscode.window.showErrorMessage(`Fix ${REPO_CONFIG_FILE} before migrating workspace settings into it.`);
      return;
    }

    const settingsProfiles = this.getConfiguredProfilesFromSettings();
    const currentSession = this.getSessionFromSettings();
    const nextConfig: RepoConfig = {
      ...writable.config,
      layout: currentSession.layout,
      terminals: currentSession.terminals,
      profiles: mergeProfiles(writable.config.profiles ?? [], settingsProfiles)
    };

    if (currentSession.tmuxCommand !== 'tmux') {
      nextConfig.tmuxCommand = currentSession.tmuxCommand;
    } else {
      delete nextConfig.tmuxCommand;
    }

    await this.writeRepoConfig(nextConfig);
    this.usageMetrics.record('migration', 'migrate_settings_to_repo');

    const action = await vscode.window.showInformationMessage(
      `Migrated the current Agent Grid workspace and local profiles into ${REPO_CONFIG_FILE}.`,
      'Clear Workspace Overrides'
    );

    if (action === 'Clear Workspace Overrides') {
      await this.clearWorkspaceOverrides();
    }
  }

  private async openIssueTracker(): Promise<void> {
    this.usageMetrics.record('support', 'open_issue_tracker');
    await vscode.env.openExternal(vscode.Uri.parse('https://github.com/padjon/vscode-agent-grid/issues/new/choose'));
  }

  private async exportSupportBundle(): Promise<void> {
    const bundle = await this.buildSupportBundle();
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: `${bundle}\n`
    });

    this.usageMetrics.record('support', 'export_bundle');
    await vscode.window.showTextDocument(document, {
      preview: false
    });
    await this.refreshSurface();
  }

  private async exportUsageReport(): Promise<void> {
    this.usageMetrics.record('usage_report', 'export');
    await this.usageMetrics.openReportEditor();
    await this.refreshSurface();
  }

  private async resetUsageReport(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      'Reset the local Agent Grid usage report counters stored in VS Code global state?',
      { modal: true },
      'Reset'
    );

    if (confirmed !== 'Reset') {
      return;
    }

    await this.usageMetrics.reset();
    await vscode.window.showInformationMessage('Agent Grid usage report counters were reset.');
    await this.refreshSurface();
  }

  private async openWorkspace(reason: WorkspaceReason): Promise<void> {
    const session = this.getSessionFromSettings();
    const environment = await this.inspectEnvironment(session);

    if (environment.state !== 'ready') {
      if (reason === 'manual') {
        await vscode.window.showErrorMessage(environment.detail);
      }

      await this.refreshSurface(environment);
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
        this.usageMetrics.record('workspace_action', 'focus_existing_terminal');
        await this.revealAndPinTerminal(existingTerminal, false);
        await this.context.workspaceState.update(SESSION_STATE_KEY, true);
        await this.refreshSurface(environment);
        return;
      }

      this.usageMetrics.record('workspace_action', 'recreate_from_existing_terminal');
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

      this.usageMetrics.record('workspace_action', action === 'Recreate' ? 'recreate_detached' : 'attach_detached');
      recreate = action === 'Recreate';
    } else if (reason === 'restore' && existingTerminal) {
      this.usageMetrics.record('workspace_action', 'restore_focus_existing_terminal');
      await this.revealAndPinTerminal(existingTerminal, true);
      await this.context.workspaceState.update(SESSION_STATE_KEY, true);
      await this.refreshSurface(environment);
      return;
    }

    this.usageMetrics.record('workspace_open', reason);
    const terminal = this.createTerminal();
    await this.revealAndPinTerminal(terminal, reason === 'restore');
    terminal.sendText(this.buildBootstrapCommand(session, recreate), true);
    await this.context.workspaceState.update(SESSION_STATE_KEY, true);
    await this.refreshSurface(environment);
  }

  private async applyPreset(selectedPresetId?: string): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      await vscode.window.showErrorMessage('Open a folder or workspace before applying an Agent Grid preset.');
      return;
    }

    const preset =
      selectedPresetId !== undefined
        ? BUILTIN_PRESETS.find((candidate) => candidate.id === selectedPresetId)
        : (
            await vscode.window.showQuickPick(
              BUILTIN_PRESETS.map((candidate) => ({
                label: candidate.label,
                description: candidate.description,
                preset: candidate
              })),
              {
                placeHolder: 'Choose an Agent Grid workspace preset'
              }
            )
          )?.preset;

    if (!preset) {
      return;
    }

    const adaptedPreset = this.adaptPresetToWorkspace(preset, this.inspectWorkspaceProject());
    await this.writeWorkspaceConfiguration(adaptedPreset.layout, adaptedPreset.terminals);
    this.usageMetrics.record('preset_apply', preset.id);

    const action = await vscode.window.showInformationMessage(
      `Applied the "${adaptedPreset.label}" preset to workspace settings.`,
      'Create Workspace'
    );

    await this.refreshSurface();

    if (action === 'Create Workspace') {
      await this.openWorkspace('manual');
    }
  }

  private async openWalkthrough(): Promise<void> {
    this.usageMetrics.record('walkthrough', 'open');
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'padjon.vscode-agent-grid#getting-started', false);
  }

  private async runSetupWizard(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      await vscode.window.showErrorMessage('Open a folder or workspace before running the Agent Grid setup wizard.');
      return;
    }

    const detectedAgents = await this.detectInstalledAgentCommands();
    const projectInfo = this.inspectWorkspaceProject();
    this.usageMetrics.record('setup_wizard', 'open');
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

    if (projectInfo.frontendRelativePath || projectInfo.backendRelativePath || projectInfo.availableScripts.size > 0) {
      presetIds.add('frontend-backend-tests-ops');
    }

    const recommendedPresets = BUILTIN_PRESETS.filter((preset) => presetIds.has(preset.id));
    const remainingPresets = BUILTIN_PRESETS.filter((preset) => !presetIds.has(preset.id));

    const picked = await vscode.window.showQuickPick(
      [
        ...recommendedPresets.map((preset) => ({
          label: preset.label,
          description: `Recommended: ${this.adaptPresetToWorkspace(preset, projectInfo).description}`,
          preset: this.adaptPresetToWorkspace(preset, projectInfo)
        })),
        ...remainingPresets.map((preset) => ({
          label: preset.label,
          description: this.adaptPresetToWorkspace(preset, projectInfo).description,
          preset: this.adaptPresetToWorkspace(preset, projectInfo)
        }))
      ],
      {
        placeHolder:
          detectedAgents.size > 0
            ? `Detected agent CLIs: ${Array.from(detectedAgents).join(', ')}`
            : projectInfo.availableScripts.size > 0
              ? `Detected package scripts: ${Array.from(projectInfo.availableScripts).slice(0, 3).join(', ')}`
              : 'Choose a starter layout for Agent Grid'
      }
    );

    if (!picked) {
      return;
    }

    await this.writeWorkspaceConfiguration(picked.preset.layout, picked.preset.terminals);
    this.usageMetrics.record('setup_wizard', picked.preset.id);
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

      await this.refreshSurface(environment);
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

  private async applyProfile(selectedProfileName?: string): Promise<void> {
    const profiles = this.getProfilesFromSettings();
    if (profiles.length === 0) {
      await vscode.window.showInformationMessage(
        `No saved Agent Grid profiles are configured. Add entries to ${REPO_CONFIG_FILE} or agentGrid.profiles first.`
      );
      return;
    }

    const profile =
      selectedProfileName !== undefined
        ? profiles.find((candidate) => candidate.name === selectedProfileName)
        : (
            await vscode.window.showQuickPick(
              profiles.map((candidate) => ({
                label: candidate.name,
                description: `${candidate.terminals.length} panes, ${candidate.layout}`,
                profile: candidate
              })),
              {
                placeHolder: 'Choose a saved Agent Grid profile'
              }
            )
          )?.profile;

    if (!profile) {
      return;
    }

    await this.writeWorkspaceConfiguration(profile.layout, profile.terminals);
    this.usageMetrics.record('profile_apply');
    const action = await vscode.window.showInformationMessage(
      `Applied the "${profile.name}" profile to workspace settings.`,
      'Create Workspace'
    );

    await this.refreshSurface();

    if (action === 'Create Workspace') {
      await this.openWorkspace('manual');
    }
  }

  private async focusRelativePane(offset: 1 | -1): Promise<void> {
    const success = await this.runPaneMutation(async (session) => {
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

    if (success) {
      this.usageMetrics.record('pane_action', offset === 1 ? 'focus_next' : 'focus_previous');
    }
  }

  private async restartActivePane(): Promise<void> {
    const success = await this.runPaneMutation(async (session) => {
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

    if (success) {
      this.usageMetrics.record('pane_action', 'restart_active');
    }
  }

  private async broadcastCommand(): Promise<void> {
    const command = await vscode.window.showInputBox({
      prompt: 'Command to send to every Agent Grid pane',
      placeHolder: 'npm test'
    });

    if (!command?.trim()) {
      return;
    }

    const success = await this.runPaneMutation(async (session) => {
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

    if (success) {
      this.usageMetrics.record('pane_action', 'broadcast');
    }
  }

  private async runDiagnostics(): Promise<void> {
    const session = this.getSessionFromSettings();
    const repoConfig = this.getRepoConfigState();
    const usageMetrics = this.usageMetrics.getSnapshot();
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
      `Repo config path: ${repoConfig.path ?? '(none)'}`,
      `Repo config state: ${repoConfig.error ? `error: ${repoConfig.error}` : repoConfig.exists ? 'loaded' : 'missing'}`,
      `Usage metrics setting: ${usageMetrics.enabledInSettings ? 'enabled' : 'disabled'}`,
      `VS Code telemetry enabled: ${usageMetrics.vscodeTelemetryEnabled ? 'yes' : 'no'}`,
      `Usage metrics active: ${usageMetrics.active ? 'yes' : 'no'}`,
      `Usage metric events stored: ${usageMetrics.totalEvents}`,
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
    this.usageMetrics.record('diagnostics', 'run');
    await this.refreshSurface(environment);
    await vscode.window.showInformationMessage('Agent Grid environment check written to the "Agent Grid" output channel.');
  }

  private async buildSupportBundle(): Promise<string> {
    const session = this.getSessionFromSettings();
    const repoConfig = this.getRepoConfigState();
    const usageMetrics = this.usageMetrics.getSnapshot();
    const environment = await this.inspectEnvironment(session);
    const detached = environment.state === 'ready' ? await this.hasDetachedTmuxSession(session) : false;
    const terminalOpen = Boolean(this.findExistingTerminal());

    return [
      '# Agent Grid Support Bundle',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Summary',
      '',
      '- Replace the placeholders below with the user-visible problem description and reproduction steps.',
      '- This bundle contains environment and configuration state only.',
      '',
      'Problem:',
      '',
      'Reproduction:',
      '',
      'Expected behavior:',
      '',
      'Actual behavior:',
      '',
      '## Environment',
      '',
      `- Extension version: ${this.context.extension.packageJSON.version ?? 'unknown'}`,
      `- VS Code version: ${vscode.version}`,
      `- Runtime: ${vscode.env.remoteName ?? process.platform}`,
      `- Platform: ${process.platform}`,
      `- Workspace root: ${this.getWorkspaceRoot() ?? '(none)'}`,
      `- Repo config path: ${repoConfig.path ?? '(none)'}`,
      `- Repo config state: ${repoConfig.error ? `error: ${repoConfig.error}` : repoConfig.exists ? 'loaded' : 'missing'}`,
      '',
      '## Agent Grid State',
      '',
      `- Environment state: ${environment.state}`,
      `- Environment detail: ${environment.detail}`,
      `- Terminal open: ${terminalOpen ? 'yes' : 'no'}`,
      `- Detached tmux session: ${detached ? 'yes' : 'no'}`,
      `- Effective tmux command: ${session.tmuxCommand}`,
      `- Effective layout: ${session.layout}`,
      `- Effective panes: ${session.terminals.length}`,
      '',
      '## Effective Panes',
      '',
      ...session.terminals.map((terminal, index) => {
        const cwd = terminal.cwd?.trim() || '${workspaceFolder}';
        const startup = terminal.startupCommand.trim() || '(none)';
        return `- Pane ${index + 1}: name="${terminal.name}" cwd="${cwd}" startup="${startup}"`;
      }),
      '',
      '## Usage Metrics State',
      '',
      `- Metrics enabled in settings: ${usageMetrics.enabledInSettings ? 'yes' : 'no'}`,
      `- VS Code telemetry enabled: ${usageMetrics.vscodeTelemetryEnabled ? 'yes' : 'no'}`,
      `- Metrics active: ${usageMetrics.active ? 'yes' : 'no'}`,
      `- Stored events: ${usageMetrics.totalEvents}`,
      '',
      '## Repo Config JSON',
      '',
      '```json',
      JSON.stringify(repoConfig.config ?? {}, null, 2),
      '```',
      '',
      '## Effective Usage Report',
      '',
      '```json',
      JSON.stringify(this.usageMetrics.buildExportData(), null, 2),
      '```'
    ].join('\n');
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

    const profiles = this.getConfiguredProfilesFromSettings();
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

    this.usageMetrics.record('profile_save');
    await vscode.window.showInformationMessage(`Saved the "${nextProfile.name}" Agent Grid profile to workspace settings.`);
  }

  private async runPaneMutation(action: (session: WorkspaceSession) => Promise<void>): Promise<boolean> {
    const session = this.getSessionFromSettings();
    const environment = await this.inspectEnvironment(session);

    if (environment.state !== 'ready') {
      await vscode.window.showErrorMessage(environment.detail);
      await this.refreshSurface(environment);
      return false;
    }

    if (!(await this.hasDetachedTmuxSession(session)) && !this.findExistingTerminal()) {
      await vscode.window.showInformationMessage('Create the Agent Grid workspace before using pane actions.');
      return false;
    }

    try {
      await action(session);
      await this.refreshSurface(environment);
      return true;
    } catch (error) {
      await vscode.window.showErrorMessage(asErrorMessage(error));
      return false;
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
          await this.refreshSurface(environment);
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
        label: 'Open Repo Config',
        description: `Create or edit ${REPO_CONFIG_FILE} in the workspace root`,
        run: async () => {
          await this.openRepoConfig();
        }
      },
      {
        label: 'Save Workspace To Repo Config',
        description: `Write the current layout and panes into ${REPO_CONFIG_FILE}`,
        run: async () => {
          await this.saveWorkspaceToRepoConfig();
        }
      },
      {
        label: 'Save Profile To Repo Config',
        description: `Append or update a named profile in ${REPO_CONFIG_FILE}`,
        run: async () => {
          await this.saveProfileToRepoConfig();
        }
      },
      {
        label: 'Import Repo Config To Settings',
        description: `Copy ${REPO_CONFIG_FILE} into workspace overrides`,
        run: async () => {
          await this.importRepoConfigToSettings();
        }
      },
      {
        label: 'Migrate Settings To Repo Config',
        description: `Move current workspace settings into ${REPO_CONFIG_FILE}`,
        run: async () => {
          await this.migrateSettingsToRepoConfig();
        }
      },
      {
        label: 'Clear Workspace Overrides',
        description: 'Remove local Agent Grid overrides and fall back to repo config or defaults',
        run: async () => {
          await this.clearWorkspaceOverrides();
        }
      },
      {
        label: 'Export Support Bundle',
        description: 'Open a markdown bundle with diagnostics and effective config',
        run: async () => {
          await this.exportSupportBundle();
        }
      },
      {
        label: 'Open Issue Tracker',
        description: 'Open the Agent Grid issue templates on GitHub',
        run: async () => {
          await this.openIssueTracker();
        }
      },
      {
        label: 'Export Usage Report',
        description: 'Open a JSON report with local aggregate usage counts',
        run: async () => {
          await this.exportUsageReport();
        }
      },
      {
        label: 'Reset Usage Report',
        description: 'Clear the local usage counters stored in VS Code global state',
        run: async () => {
          await this.resetUsageReport();
        }
      },
      {
        label: 'Apply Saved Profile',
        description: `Use a repo-defined profile from ${REPO_CONFIG_FILE} or agentGrid.profiles`,
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

  private inspectWorkspaceProject(): WorkspaceProjectInfo {
    const workspaceRoot = this.getWorkspaceRoot();
    const packageJsonPath = workspaceRoot ? path.join(workspaceRoot, 'package.json') : undefined;
    const availableScripts = new Set<string>();

    if (packageJsonPath && fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, unknown> };
        if (packageJson.scripts && typeof packageJson.scripts === 'object') {
          for (const scriptName of Object.keys(packageJson.scripts)) {
            availableScripts.add(scriptName);
          }
        }
      } catch {
        // Ignore malformed package.json here. Diagnostics cover environment visibility separately.
      }
    }

    return {
      availableScripts,
      frontendRelativePath: this.findFirstExistingRelativeDirectory([
        'apps/frontend',
        'frontend',
        'packages/frontend',
        'app/frontend'
      ]),
      backendRelativePath: this.findFirstExistingRelativeDirectory([
        'apps/backend',
        'backend',
        'api',
        'server',
        'services/api'
      ]),
      preferredTestCommand: this.pickWorkspaceCommand(availableScripts, [
        ['test:watch', 'npm run test:watch'],
        ['test', 'npm test']
      ]),
      preferredLintCommand: this.pickWorkspaceCommand(availableScripts, [
        ['lint:watch', 'npm run lint:watch'],
        ['lint', 'npm run lint']
      ])
    };
  }

  private adaptPresetToWorkspace(preset: WorkspacePreset, projectInfo: WorkspaceProjectInfo): WorkspacePreset {
    const terminals = preset.terminals.map((terminal) => {
      let startupCommand = terminal.startupCommand;
      let cwd = terminal.cwd;

      if (terminal.name === 'Tests' && projectInfo.preferredTestCommand) {
        startupCommand = projectInfo.preferredTestCommand;
      }

      if (terminal.name === 'Lint' && projectInfo.preferredLintCommand) {
        startupCommand = projectInfo.preferredLintCommand;
      }

      if (terminal.name === 'Frontend' && projectInfo.frontendRelativePath) {
        cwd = `${'${workspaceFolder}'}/${projectInfo.frontendRelativePath}`;
      }

      if (terminal.name === 'Backend' && projectInfo.backendRelativePath) {
        cwd = `${'${workspaceFolder}'}/${projectInfo.backendRelativePath}`;
      }

      return {
        ...terminal,
        startupCommand,
        cwd
      };
    });

    const detail: string[] = [];
    if (projectInfo.frontendRelativePath || projectInfo.backendRelativePath) {
      detail.push('adjusted to repo folders');
    }

    if (projectInfo.preferredTestCommand || projectInfo.preferredLintCommand) {
      detail.push('uses detected scripts');
    }

    return {
      ...preset,
      terminals,
      description: detail.length > 0 ? `${preset.description} (${detail.join(', ')})` : preset.description
    };
  }

  private pickWorkspaceCommand(
    availableScripts: Set<string>,
    candidates: Array<[scriptName: string, command: string]>
  ): string | undefined {
    for (const [scriptName, command] of candidates) {
      if (availableScripts.has(scriptName)) {
        return command;
      }
    }

    return undefined;
  }

  private findFirstExistingRelativeDirectory(candidates: string[]): string | undefined {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return undefined;
    }

    for (const relativePath of candidates) {
      if (fs.existsSync(path.join(workspaceRoot, relativePath))) {
        return relativePath;
      }
    }

    return undefined;
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
    const repoConfig = this.getRepoConfigState().config;
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const configuredTerminals = this.readConfiguredSetting<unknown[]>(config.inspect<unknown[]>('terminals'));
    const configuredTmuxCommand = this.readConfiguredSetting<string>(config.inspect<string>('tmuxCommand'));
    const configuredLayout = this.readConfiguredSetting<string>(config.inspect<string>('layout'));
    const terminals = normalizeTerminalDefinitions(configuredTerminals ?? repoConfig?.terminals);

    return {
      tmuxCommand: readTrimmedString(configuredTmuxCommand) ?? repoConfig?.tmuxCommand ?? 'tmux',
      sessionName: this.buildSessionName(),
      windowName: DEFAULT_WINDOW_NAME,
      layout: readLayoutName(configuredLayout) ?? repoConfig?.layout ?? 'tiled',
      terminals
    };
  }

  private getProfilesFromSettings(): WorkspaceProfile[] {
    const repoProfiles = this.getRepoConfigState().config?.profiles ?? [];
    const settingsProfiles = this.getConfiguredProfilesFromSettings();
    return mergeProfiles(repoProfiles, settingsProfiles);
  }

  private getConfiguredProfilesFromSettings(): WorkspaceProfile[] {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const configuredProfiles = this.readConfiguredSetting<unknown[]>(config.inspect<unknown[]>('profiles'));
    return normalizeProfiles(configuredProfiles ?? []);
  }

  private readConfiguredSetting<T>(
    inspection: { workspaceFolderValue?: T; workspaceValue?: T; globalValue?: T } | undefined
  ): T | undefined {
    return inspection?.workspaceFolderValue ?? inspection?.workspaceValue ?? inspection?.globalValue;
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

class AgentGridSidebarProvider implements vscode.TreeDataProvider<AgentGridSidebarNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<AgentGridSidebarNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private snapshot: AgentGridSidebarSnapshot | undefined;

  setSnapshot(snapshot: AgentGridSidebarSnapshot): void {
    this.snapshot = snapshot;
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: AgentGridSidebarNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, element.collapsibleState);
    item.id = element.id;
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.iconPath = element.icon;
    item.command = element.command;
    return item;
  }

  getChildren(element?: AgentGridSidebarNode): vscode.ProviderResult<AgentGridSidebarNode[]> {
    if (!this.snapshot) {
      return [];
    }

    if (element) {
      return element.children ?? [];
    }

    if (this.snapshot.shouldShowWelcome) {
      return [];
    }

    return buildSidebarNodes(this.snapshot);
  }
}

class UsageMetricsService implements vscode.Disposable {
  private readonly extensionVersion: string;
  private state: UsageMetricsState;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.OutputChannel
  ) {
    this.extensionVersion = String(context.extension.packageJSON.version ?? 'unknown');
    this.state = context.globalState.get<UsageMetricsState>(USAGE_METRICS_KEY, {
      schemaVersion: 1,
      events: {}
    });
  }

  dispose(): void {
    // No-op. The service uses workspace/global state only.
  }

  getSnapshot(): UsageMetricsSnapshot {
    const events = Object.values(this.state.events);
    const totalEvents = events.reduce((sum, event) => sum + event.count, 0);

    return {
      enabledInSettings: this.isEnabledInSettings(),
      vscodeTelemetryEnabled: vscode.env.isTelemetryEnabled,
      active: this.isActive(),
      totalEvents,
      eventTypes: events.length,
      updatedAt: this.state.updatedAt
    };
  }

  record(eventName: string, bucket?: string): void {
    if (!this.isActive()) {
      return;
    }

    const now = new Date().toISOString();
    const entry = this.state.events[eventName] ?? {
      count: 0,
      firstSeen: now,
      lastSeen: now
    };

    entry.count += 1;
    entry.lastSeen = now;

    if (bucket) {
      entry.buckets = entry.buckets ?? {};
      entry.buckets[bucket] = (entry.buckets[bucket] ?? 0) + 1;
    }

    this.state.events[eventName] = entry;
    this.state.updatedAt = now;
    this.queuePersist();
  }

  async openReportEditor(): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: `${JSON.stringify(this.buildExportData(), null, 2)}\n`
    });

    await vscode.window.showTextDocument(document, {
      preview: false
    });
  }

  async reset(): Promise<void> {
    this.state = {
      schemaVersion: 1,
      events: {}
    };
    await this.context.globalState.update(USAGE_METRICS_KEY, this.state);
  }

  private isEnabledInSettings(): boolean {
    return vscode.workspace.getConfiguration(EXTENSION_NAMESPACE).get<boolean>('enableUsageMetrics', false);
  }

  private isActive(): boolean {
    return this.isEnabledInSettings() && vscode.env.isTelemetryEnabled;
  }

  buildExportData(): Record<string, unknown> {
    return {
      generatedAt: new Date().toISOString(),
      extensionVersion: this.extensionVersion,
      settings: {
        enableUsageMetrics: this.isEnabledInSettings(),
        vscodeTelemetryEnabled: vscode.env.isTelemetryEnabled,
        active: this.isActive()
      },
      notes: [
        'Counts are stored locally in VS Code global state.',
        'No workspace names, file paths, commands, prompts, or pane contents are recorded.',
        'Export is manual. Nothing is sent anywhere by this feature.'
      ],
      events: this.state.events
    };
  }

  private queuePersist(): void {
    this.writeQueue = this.writeQueue
      .then(() => this.context.globalState.update(USAGE_METRICS_KEY, this.state))
      .catch((error) => {
        this.outputChannel.appendLine(`Agent Grid usage metrics persist failed: ${asErrorMessage(error)}`);
      });
  }
}

function buildSidebarNodes(snapshot: AgentGridSidebarSnapshot): AgentGridSidebarNode[] {
  const status = buildStatusNode(snapshot);
  const workspaceActions = buildWorkspaceActionNodes();
  const migrationNodes = buildMigrationNodes();
  const supportNodes = buildSupportNodes();
  const usageMetricNodes = buildUsageMetricNodes(snapshot);
  const profileNodes = buildProfileNodes(snapshot);
  const presetNodes = buildPresetNodes(snapshot);
  const paneActionNodes = buildPaneActionNodes(snapshot);
  const configuredPaneNodes = buildConfiguredPaneNodes(snapshot.session);

  return [
    status,
    buildSectionNode('workspace', 'Workspace', 'Core actions and setup', new vscode.ThemeIcon('terminal'), workspaceActions),
    buildSectionNode(
      'repo-config',
      'Repo Config',
      snapshot.repoConfig.exists ? REPO_CONFIG_FILE : `Create ${REPO_CONFIG_FILE} in the repo root`,
      new vscode.ThemeIcon('file-code'),
      buildRepoConfigNodes(snapshot)
    ),
    buildSectionNode(
      'migration',
      'Migration',
      'Move between repo config and local workspace overrides',
      new vscode.ThemeIcon('sync'),
      migrationNodes
    ),
    buildSectionNode(
      'usage-metrics',
      'Usage Metrics',
      snapshot.usageMetrics.active
        ? `${snapshot.usageMetrics.totalEvents} events captured locally`
        : 'Disabled by default, exportable when enabled',
      new vscode.ThemeIcon('graph'),
      usageMetricNodes
    ),
    buildSectionNode(
      'support',
      'Support',
      'Export a support bundle or open the issue tracker',
      new vscode.ThemeIcon('comment-discussion'),
      supportNodes
    ),
    buildSectionNode(
      'profiles',
      'Profiles',
      snapshot.profiles.length > 0 ? `${snapshot.profiles.length} saved` : 'Save and reuse workspace setups',
      new vscode.ThemeIcon('bookmark'),
      profileNodes
    ),
    buildSectionNode(
      'presets',
      'Presets',
      `${snapshot.presets.length} built-in layouts`,
      new vscode.ThemeIcon('library'),
      presetNodes
    ),
    buildSectionNode(
      'pane-actions',
      'Pane Actions',
      snapshot.terminalOpen || snapshot.detached ? 'Operate on the live tmux workspace' : 'Create the workspace to enable',
      new vscode.ThemeIcon('run-all'),
      paneActionNodes
    ),
    buildSectionNode(
      'configured-panes',
      'Configured Panes',
      `${snapshot.session.terminals.length} panes in ${snapshot.session.layout}`,
      new vscode.ThemeIcon('list-unordered'),
      configuredPaneNodes
    )
  ];
}

function buildUsageMetricNodes(snapshot: AgentGridSidebarSnapshot): AgentGridSidebarNode[] {
  const nodes = [
    buildActionNode(
      'usage-export',
      'Export Usage Report',
      'Open a JSON report with local aggregate event counts',
      new vscode.ThemeIcon('export'),
      EXPORT_USAGE_REPORT_COMMAND
    ),
    buildActionNode(
      'usage-reset',
      'Reset Usage Report',
      'Clear the local usage counters stored in VS Code global state',
      new vscode.ThemeIcon('trash'),
      RESET_USAGE_REPORT_COMMAND
    ),
    buildActionNode(
      'usage-settings',
      'Open Usage Metrics Setting',
      'Turn local usage metrics on or off',
      new vscode.ThemeIcon('gear'),
      'workbench.action.openSettings',
      ['agentGrid.enableUsageMetrics']
    )
  ];

  if (!snapshot.usageMetrics.enabledInSettings) {
    nodes.unshift(
      buildLeafNode(
        'usage-disabled-setting',
        'Usage Metrics Disabled',
        'Enable agentGrid.enableUsageMetrics to collect local counts',
        'Agent Grid only records aggregate local counters when the setting is enabled.',
        new vscode.ThemeIcon('circle-slash')
      )
    );
    return nodes;
  }

  if (!snapshot.usageMetrics.vscodeTelemetryEnabled) {
    nodes.unshift(
      buildLeafNode(
        'usage-disabled-vscode',
        'VS Code Telemetry Disabled',
        'Turn VS Code telemetry back on to allow local Agent Grid usage counts',
        'Agent Grid respects vscode.env.isTelemetryEnabled before recording usage counts.',
        new vscode.ThemeIcon('warning')
      )
    );
    return nodes;
  }

  nodes.unshift(
    buildLeafNode(
      'usage-enabled',
      'Usage Metrics Active',
      `${snapshot.usageMetrics.totalEvents} events across ${snapshot.usageMetrics.eventTypes} event types`,
      snapshot.usageMetrics.updatedAt
        ? `Last updated ${snapshot.usageMetrics.updatedAt}. Counts are aggregate and local-only.`
        : 'Counts are aggregate and local-only.',
      new vscode.ThemeIcon('graph')
    )
  );

  return nodes;
}

function buildMigrationNodes(): AgentGridSidebarNode[] {
  return [
    buildActionNode(
      'migration-import',
      'Import Repo Config To Settings',
      `Copy ${REPO_CONFIG_FILE} into workspace overrides`,
      new vscode.ThemeIcon('cloud-download'),
      IMPORT_REPO_CONFIG_TO_SETTINGS_COMMAND
    ),
    buildActionNode(
      'migration-migrate',
      'Migrate Settings To Repo Config',
      `Move current workspace settings into ${REPO_CONFIG_FILE}`,
      new vscode.ThemeIcon('cloud-upload'),
      MIGRATE_SETTINGS_TO_REPO_CONFIG_COMMAND
    ),
    buildActionNode(
      'migration-clear',
      'Clear Workspace Overrides',
      'Remove local Agent Grid overrides and fall back to repo config or defaults',
      new vscode.ThemeIcon('clear-all'),
      CLEAR_WORKSPACE_OVERRIDES_COMMAND
    )
  ];
}

function buildSupportNodes(): AgentGridSidebarNode[] {
  return [
    buildActionNode(
      'support-export-bundle',
      'Export Support Bundle',
      'Open a markdown bundle with diagnostics, effective config, and metrics state',
      new vscode.ThemeIcon('report'),
      EXPORT_SUPPORT_BUNDLE_COMMAND
    ),
    buildActionNode(
      'support-open-issues',
      'Open Issue Tracker',
      'Open the Agent Grid issue templates on GitHub',
      new vscode.ThemeIcon('issues'),
      OPEN_ISSUE_TRACKER_COMMAND
    ),
    buildActionNode(
      'support-run-diagnostics',
      'Run Environment Check',
      'Refresh the diagnostic output channel first',
      new vscode.ThemeIcon('pulse'),
      DIAGNOSE_COMMAND
    )
  ];
}

function buildStatusNode(snapshot: AgentGridSidebarSnapshot): AgentGridSidebarNode {
  const paneSummary = `${snapshot.session.terminals.length} panes, ${snapshot.session.layout}`;

  if (snapshot.environment.state === 'native-windows-unsupported') {
    return buildLeafNode(
      'status-wsl-required',
      'WSL Required',
      paneSummary,
      snapshot.environment.detail,
      new vscode.ThemeIcon('warning'),
      DIAGNOSE_COMMAND
    );
  }

  if (snapshot.environment.state === 'tmux-missing') {
    return buildLeafNode(
      'status-tmux-missing',
      'tmux Missing',
      paneSummary,
      snapshot.environment.detail,
      new vscode.ThemeIcon('warning'),
      DIAGNOSE_COMMAND
    );
  }

  if (snapshot.terminalOpen) {
    return buildLeafNode(
      'status-running',
      'Workspace Running',
      paneSummary,
      'The Agent Grid terminal is attached inside VS Code.',
      new vscode.ThemeIcon('terminal'),
      CREATE_COMMAND
    );
  }

  if (snapshot.detached) {
    return buildLeafNode(
      'status-detached',
      'Workspace Detached',
      paneSummary,
      'A matching tmux session exists. Run Create Workspace to reattach.',
      new vscode.ThemeIcon('plug'),
      CREATE_COMMAND
    );
  }

  return buildLeafNode(
    'status-idle',
    'Workspace Idle',
    paneSummary,
    'Create the tmux-backed workspace to start working with Agent Grid.',
    new vscode.ThemeIcon('circle-large-outline'),
    CREATE_COMMAND
  );
}

function buildWorkspaceActionNodes(): AgentGridSidebarNode[] {
  return [
    buildActionNode(
      'workspace-create',
      'Create or Recreate Workspace',
      'Launch or reattach the tmux-backed workspace',
      new vscode.ThemeIcon('play-circle'),
      CREATE_COMMAND
    ),
    buildActionNode(
      'workspace-setup',
      'Run Setup Wizard',
      'Detect common agent CLIs and apply a recommended layout',
      new vscode.ThemeIcon('wand'),
      SETUP_WIZARD_COMMAND
    ),
    buildActionNode(
      'workspace-actions',
      'Show Actions',
      'Open the full command menu for Agent Grid',
      new vscode.ThemeIcon('list-selection'),
      SHOW_ACTIONS_COMMAND
    ),
    buildActionNode(
      'workspace-repo-config',
      'Open Repo Config',
      `Create or edit ${REPO_CONFIG_FILE} in the workspace root`,
      new vscode.ThemeIcon('file-code'),
      OPEN_REPO_CONFIG_COMMAND
    ),
    buildActionNode(
      'workspace-save-repo-workspace',
      'Save Workspace To Repo Config',
      `Write the current layout and panes into ${REPO_CONFIG_FILE}`,
      new vscode.ThemeIcon('save'),
      SAVE_WORKSPACE_TO_REPO_CONFIG_COMMAND
    ),
    buildActionNode(
      'workspace-save-repo-profile',
      'Save Profile To Repo Config',
      `Append or update a named profile in ${REPO_CONFIG_FILE}`,
      new vscode.ThemeIcon('bookmark'),
      SAVE_PROFILE_TO_REPO_CONFIG_COMMAND
    ),
    buildActionNode(
      'workspace-diagnose',
      'Run Environment Check',
      'Write diagnostics and setup hints to the output channel',
      new vscode.ThemeIcon('pulse'),
      DIAGNOSE_COMMAND
    ),
    buildActionNode(
      'workspace-settings',
      'Open Settings',
      'Review layout, panes, profiles, and tmux configuration',
      new vscode.ThemeIcon('gear'),
      'workbench.action.openSettings',
      ['@ext:padjon.vscode-agent-grid agentGrid']
    )
  ];
}

function buildRepoConfigNodes(snapshot: AgentGridSidebarSnapshot): AgentGridSidebarNode[] {
  const repoConfigPath = snapshot.repoConfig.path ?? REPO_CONFIG_FILE;
  const nodes = [
    buildActionNode(
      'repo-config-open',
      snapshot.repoConfig.exists ? 'Open Repo Config' : 'Create Repo Config',
      snapshot.repoConfig.exists ? repoConfigPath : `Create ${REPO_CONFIG_FILE} from the current workspace`,
      new vscode.ThemeIcon('edit'),
      OPEN_REPO_CONFIG_COMMAND
    ),
    buildActionNode(
      'repo-config-save-workspace',
      'Save Workspace To Repo Config',
      `Write the current layout and panes into ${REPO_CONFIG_FILE}`,
      new vscode.ThemeIcon('save'),
      SAVE_WORKSPACE_TO_REPO_CONFIG_COMMAND
    ),
    buildActionNode(
      'repo-config-save-profile',
      'Save Profile To Repo Config',
      `Append or update a named profile in ${REPO_CONFIG_FILE}`,
      new vscode.ThemeIcon('bookmark'),
      SAVE_PROFILE_TO_REPO_CONFIG_COMMAND
    )
  ];

  if (snapshot.repoConfig.error) {
    nodes.push(
      buildLeafNode(
        'repo-config-error',
        'Config Parse Error',
        snapshot.repoConfig.error,
        `Fix ${REPO_CONFIG_FILE} so Agent Grid can load it.`,
        new vscode.ThemeIcon('error'),
        OPEN_REPO_CONFIG_COMMAND
      )
    );
    return nodes;
  }

  if (!snapshot.repoConfig.exists) {
    nodes.push(
      buildLeafNode(
        'repo-config-missing',
        'No Repo Config File',
        'Settings still work, but the repo has no committed base config yet',
        `Create ${REPO_CONFIG_FILE} to share layouts and profiles with the repository.`,
        new vscode.ThemeIcon('info')
      )
    );
    return nodes;
  }

  const sourceSummary = [
    snapshot.repoConfig.config?.layout ? `layout: ${snapshot.repoConfig.config.layout}` : undefined,
    snapshot.repoConfig.config?.terminals ? `${snapshot.repoConfig.config.terminals.length} panes` : undefined,
    snapshot.repoConfig.config?.profiles ? `${snapshot.repoConfig.config.profiles.length} profiles` : undefined
  ]
    .filter(Boolean)
    .join(' • ');

  nodes.push(
    buildLeafNode(
      'repo-config-loaded',
      'Repo Config Loaded',
      sourceSummary || 'Using repo defaults',
      `${REPO_CONFIG_FILE} provides the base Agent Grid configuration for this repository.`,
      new vscode.ThemeIcon('check')
    )
  );

  return nodes;
}

function buildProfileNodes(snapshot: AgentGridSidebarSnapshot): AgentGridSidebarNode[] {
  const nodes = [
    buildActionNode(
      'profiles-save-current',
      'Save Current Workspace As Profile',
      'Persist the current layout and panes into workspace settings as a local override',
      new vscode.ThemeIcon('add'),
      SAVE_PROFILE_COMMAND
    )
  ];

  if (snapshot.profiles.length === 0) {
    nodes.push(
      buildLeafNode(
        'profiles-empty',
        'No Saved Profiles',
        `Store one from your current setup or add profiles to ${REPO_CONFIG_FILE}`,
        `Run Save Current Workspace As Profile or commit profiles in ${REPO_CONFIG_FILE}.`,
        new vscode.ThemeIcon('info')
      )
    );
    return nodes;
  }

  return nodes.concat(
    snapshot.profiles.map((profile) =>
      buildActionNode(
        `profile-${profile.name}`,
        profile.name,
        `${profile.terminals.length} panes, ${profile.layout}`,
        new vscode.ThemeIcon('bookmark'),
        APPLY_PROFILE_COMMAND,
        [profile.name]
      )
    )
  );
}

function buildPresetNodes(snapshot: AgentGridSidebarSnapshot): AgentGridSidebarNode[] {
  return snapshot.presets.map((preset) =>
    buildActionNode(
      `preset-${preset.id}`,
      preset.label,
      preset.description,
      new vscode.ThemeIcon('library'),
      SETUP_PRESET_COMMAND,
      [preset.id]
    )
  );
}

function buildPaneActionNodes(snapshot: AgentGridSidebarSnapshot): AgentGridSidebarNode[] {
  if (!snapshot.terminalOpen && !snapshot.detached) {
    return [
      buildLeafNode(
        'pane-actions-empty',
        'Workspace Not Running',
        'Create the workspace first',
        'Pane actions act on the active tmux session.',
        new vscode.ThemeIcon('info')
      )
    ];
  }

  return [
    buildActionNode(
      'pane-next',
      'Focus Next Pane',
      'Select the next tmux pane',
      new vscode.ThemeIcon('arrow-right'),
      FOCUS_NEXT_PANE_COMMAND
    ),
    buildActionNode(
      'pane-previous',
      'Focus Previous Pane',
      'Select the previous tmux pane',
      new vscode.ThemeIcon('arrow-left'),
      FOCUS_PREVIOUS_PANE_COMMAND
    ),
    buildActionNode(
      'pane-restart',
      'Restart Active Pane',
      'Respawn the current pane and rerun its startup command',
      new vscode.ThemeIcon('debug-restart'),
      RESTART_ACTIVE_PANE_COMMAND
    ),
    buildActionNode(
      'pane-broadcast',
      'Broadcast Command To All Panes',
      'Send one command to every pane in the workspace',
      new vscode.ThemeIcon('broadcast'),
      BROADCAST_COMMAND
    )
  ];
}

function buildConfiguredPaneNodes(session: WorkspaceSession): AgentGridSidebarNode[] {
  return session.terminals.map((terminal, index) => {
    const cwd = terminal.cwd?.trim() || '${workspaceFolder}';
    const startupCommand = terminal.startupCommand.trim();
    const description = startupCommand ? `${cwd} • ${startupCommand}` : cwd;

    return buildLeafNode(
      `configured-pane-${index}`,
      terminal.name || `Pane ${index + 1}`,
      description,
      startupCommand
        ? `Pane ${index + 1} starts in ${cwd} and runs "${startupCommand}" on fresh workspace creation.`
        : `Pane ${index + 1} starts in ${cwd}.`,
      new vscode.ThemeIcon('terminal')
    );
  });
}

function buildSectionNode(
  id: string,
  label: string,
  description: string,
  icon: vscode.ThemeIcon,
  children: AgentGridSidebarNode[]
): AgentGridSidebarNode {
  return {
    id,
    label,
    description,
    tooltip: description,
    icon,
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    children
  };
}

function buildActionNode(
  id: string,
  label: string,
  description: string,
  icon: vscode.ThemeIcon,
  command: string,
  arguments_: unknown[] = []
): AgentGridSidebarNode {
  return {
    id,
    label,
    description,
    tooltip: description,
    icon,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    command: {
      command,
      title: label,
      arguments: arguments_
    }
  };
}

function buildLeafNode(
  id: string,
  label: string,
  description: string,
  tooltip: string,
  icon: vscode.ThemeIcon,
  command?: string
): AgentGridSidebarNode {
  return {
    id,
    label,
    description,
    tooltip,
    icon,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
    command: command
      ? {
          command,
          title: label
        }
      : undefined
  };
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
