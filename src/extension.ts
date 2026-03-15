import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import {
  buildSupportBundleMarkdown,
  buildTmuxBootstrapScript,
  mergeProfiles,
  normalizeProfiles,
  normalizeTerminalDefinitions,
  parseRepoConfig,
  readLayoutName,
  resolveEffectiveWorkspaceConfig,
  sanitizeTmuxName
} from './core';
import type {
  EffectiveConfigLayers,
  LayoutName,
  RepoConfig,
  SettingsLayerConfig,
  SupportBundleLivePane,
  SupportBundlePane,
  TerminalDefinition,
  WorkspaceProfile,
  WorkspaceSession
} from './core';

const EXTENSION_NAMESPACE = 'agentGrid';
const SIDEBAR_VIEW_ID = 'agentGrid.sidebar';
const CONFIGURE_WORKSPACE_COMMAND = 'agentGrid.configureWorkspace';
const CREATE_COMMAND = 'agentGrid.create';
const DIAGNOSE_COMMAND = 'agentGrid.diagnose';
const OPEN_WALKTHROUGH_COMMAND = 'agentGrid.openWalkthrough';
const EXPORT_SUPPORT_BUNDLE_COMMAND = 'agentGrid.exportSupportBundle';
const OPEN_ISSUE_TRACKER_COMMAND = 'agentGrid.openIssueTracker';
const EMAIL_FEEDBACK_COMMAND = 'agentGrid.emailFeedback';

const SESSION_STATE_KEY = 'agentGrid.open';
const ONBOARDING_KEY = 'agentGrid.onboarded';
const ACTIVE_SETUP_KEY = 'agentGrid.activeSetup';

const TERMINAL_TITLE = 'agent-grid';
const DEFAULT_WINDOW_NAME = 'grid';
const REPO_CONFIG_FILE = '.agent-grid.json';
const HIDDEN_WINDOW_PREFIX = 'agent-grid-hidden';
const PIN_EDITOR_COMMANDS = ['workbench.action.pinEditor', 'workbench.action.keepEditor'];

type WorkspaceReason = 'manual' | 'restore';
type EnvironmentState = 'ready' | 'tmux-missing' | 'native-windows-unsupported';
type ConfigurationDestination = 'user' | 'repo';

interface EnvironmentInfo {
  state: EnvironmentState;
  detail: string;
}

interface RepoConfigState {
  path?: string;
  exists: boolean;
  config?: RepoConfig;
  error?: string;
}

interface WorkspaceProjectInfo {
  availableScripts: Set<string>;
  preferredTestCommand?: string;
}

interface ConfigurationTemplate {
  layout: LayoutName;
  terminals: TerminalDefinition[];
}

interface SidebarStarterOption {
  id: string;
  label: string;
  description: string;
  template: ConfigurationTemplate;
}

interface ActiveSetupOption {
  id: string;
  label: string;
  description: string;
}

interface ActiveSetupModel {
  id: string;
  kind: 'default' | 'profile';
  label: string;
  description: string;
  profileName?: string;
  template: ConfigurationTemplate;
  storage: ConfigurationDestination;
}

interface HiddenPaneInfo {
  windowName: string;
  title: string;
  currentCommand: string;
}

interface SidebarState {
  hasWorkspaceFolder: boolean;
  statusLabel: string;
  statusDetail: string;
  statusTone: 'idle' | 'running' | 'warning';
  activeSetupId: string;
  activeSetupLabel: string;
  activeSetupDetail: string;
  availableSetups: ActiveSetupOption[];
  selectedStorage: ConfigurationDestination;
  storageDetail: string;
  availableDestinations: Array<{
    value: ConfigurationDestination;
    label: string;
    description: string;
    disabled?: boolean;
  }>;
  template: ConfigurationTemplate;
  starterTemplates: SidebarStarterOption[];
  canUpdateProfile: boolean;
  canDeleteProfile: boolean;
  canApplyLiveLayout: boolean;
  hiddenPanes: HiddenPaneInfo[];
}

interface AgentGridSidebarActions {
  onSelectActiveSetup: (setupId: string) => Promise<void>;
  onSaveActiveSetup: (
    setupId: string,
    destination: ConfigurationDestination,
    template: ConfigurationTemplate,
    createWorkspace: boolean
  ) => Promise<void>;
  onSaveAsNewProfile: (
    profileName: string,
    destination: ConfigurationDestination,
    template: ConfigurationTemplate,
    createWorkspace: boolean
  ) => Promise<void>;
  onDeleteProfile: (profileName: string) => Promise<void>;
  onBroadcastCommand: (command: string) => Promise<void>;
  onApplyLiveLayout: (layout: LayoutName) => Promise<void>;
  onHideLivePane: (paneIndex: number) => Promise<void>;
  onRestoreHiddenPane: (windowName: string) => Promise<void>;
  onRunDiagnostics: () => Promise<void>;
  onExportSupportBundle: () => Promise<void>;
  onOpenGuide: () => Promise<void>;
  onOpenIssueTracker: () => Promise<void>;
  onEmailFeedback: () => Promise<void>;
}

let controller: AgentGridController | undefined;

class AgentGridController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly outputChannel: vscode.OutputChannel;
  private readonly sidebarProvider: AgentGridSidebarWebviewProvider;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('Agent Grid');
    this.sidebarProvider = new AgentGridSidebarWebviewProvider(context.extensionUri, {
      onSelectActiveSetup: async (setupId) => {
        await this.setActiveSetupId(setupId);
        await this.refreshSurface();
      },
      onSaveActiveSetup: async (setupId, destination, template, createWorkspace) => {
        await this.saveActiveSetup(setupId, destination, template, createWorkspace);
      },
      onSaveAsNewProfile: async (profileName, destination, template, createWorkspace) => {
        await this.saveAsNewProfile(profileName, destination, template, createWorkspace);
      },
      onDeleteProfile: async (profileName) => {
        await this.deleteProfile(profileName);
      },
      onBroadcastCommand: async (command) => {
        await this.broadcastCommand(command);
      },
      onApplyLiveLayout: async (layout) => {
        await this.applyLiveLayout(layout);
      },
      onHideLivePane: async (paneIndex) => {
        await this.hideLivePane(paneIndex);
      },
      onRestoreHiddenPane: async (windowName) => {
        await this.restoreHiddenPane(windowName);
      },
      onRunDiagnostics: async () => {
        await this.runDiagnostics();
      },
      onExportSupportBundle: async () => {
        await this.exportSupportBundle();
      },
      onOpenGuide: async () => {
        await this.openWalkthrough();
      },
      onOpenIssueTracker: async () => {
        await this.openIssueTracker();
      },
      onEmailFeedback: async () => {
        await this.emailFeedback();
      }
    });

    const repoConfigWatcher = this.createRepoConfigWatcher();

    this.disposables.push(
      this.outputChannel,
      this.sidebarProvider,
      vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, this.sidebarProvider, {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }),
      ...(repoConfigWatcher ? [repoConfigWatcher] : []),
      vscode.commands.registerCommand(CONFIGURE_WORKSPACE_COMMAND, async () => {
        await this.configureWorkspace();
      }),
      vscode.commands.registerCommand(CREATE_COMMAND, async () => {
        await this.openWorkspace('manual');
      }),
      vscode.commands.registerCommand(DIAGNOSE_COMMAND, async () => {
        await this.runDiagnostics();
      }),
      vscode.commands.registerCommand(OPEN_WALKTHROUGH_COMMAND, async () => {
        await this.openWalkthrough();
      }),
      vscode.commands.registerCommand(EXPORT_SUPPORT_BUNDLE_COMMAND, async () => {
        await this.exportSupportBundle();
      }),
      vscode.commands.registerCommand(OPEN_ISSUE_TRACKER_COMMAND, async () => {
        await this.openIssueTracker();
      }),
      vscode.commands.registerCommand(EMAIL_FEEDBACK_COMMAND, async () => {
        await this.emailFeedback();
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

    if (!this.context.workspaceState.get<boolean>(SESSION_STATE_KEY, false)) {
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

    if (this.context.workspaceState.get<boolean>(ONBOARDING_KEY, false)) {
      return;
    }

    const action = await vscode.window.showInformationMessage(
      'Agent Grid can set up a tmux-backed terminal workspace in the sidebar.',
      'Configure Workspace',
      'Open Guide',
      'Dismiss'
    );

    await this.context.workspaceState.update(ONBOARDING_KEY, true);

    if (action === 'Configure Workspace') {
      await this.configureWorkspace();
    } else if (action === 'Open Guide') {
      await this.openWalkthrough();
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

  private async refreshSurface(existingEnvironment?: EnvironmentInfo): Promise<void> {
    void existingEnvironment;
    this.sidebarProvider.setState(await this.getSidebarState());
  }

  private async getSidebarState(): Promise<SidebarState> {
    const repoConfig = this.getRepoConfigState();
    const effectiveConfig = this.getEffectiveWorkspaceConfig(repoConfig.config);
    const session = this.getSessionFromSettings(effectiveConfig);
    const environment = await this.inspectEnvironment(session);
    const terminalOpen = Boolean(this.findExistingTerminal());
    const detached = environment.state === 'ready' ? await this.hasDetachedTmuxSession(session) : false;
    const hiddenPanes = environment.state === 'ready' && (terminalOpen || detached) ? await this.listHiddenPanes(session) : [];
    const activeSetup = this.getActiveSetupModel(effectiveConfig, repoConfig);

    return {
      hasWorkspaceFolder: Boolean(vscode.workspace.workspaceFolders?.length),
      statusLabel:
        environment.state === 'native-windows-unsupported'
          ? 'WSL Required'
          : environment.state === 'tmux-missing'
            ? 'tmux Missing'
            : terminalOpen
              ? 'Workspace Running'
              : detached
                ? 'Workspace Detached'
                : 'Workspace Idle',
      statusDetail: environment.detail,
      statusTone:
        environment.state === 'ready'
          ? terminalOpen || detached
            ? 'running'
            : 'idle'
          : 'warning',
      activeSetupId: activeSetup.id,
      activeSetupLabel: activeSetup.label,
      activeSetupDetail: activeSetup.description,
      availableSetups: [
        {
          id: 'default',
          label: 'Default Setup',
          description: this.describeDefaultSetupSource(effectiveConfig.layers)
        },
        ...effectiveConfig.profiles.map((profile) => ({
          id: this.buildProfileSetupId(profile.name),
          label: profile.name,
          description: `${profile.terminals.length} panes • ${profile.layout}`
        }))
      ],
      selectedStorage: activeSetup.storage,
      storageDetail: this.getStorageDetail(activeSetup.storage),
      availableDestinations: [
        { value: 'user', label: 'Personal', description: 'Save in your personal Agent Grid settings' },
        {
          value: 'repo',
          label: 'Shared In Repo',
          description: `Save in ${REPO_CONFIG_FILE} so this repo can share the setup`,
          disabled: !vscode.workspace.workspaceFolders?.length
        }
      ],
      template: activeSetup.template,
      starterTemplates: this.getStarterTemplates(),
      canUpdateProfile: activeSetup.kind === 'profile',
      canDeleteProfile: activeSetup.kind === 'profile',
      canApplyLiveLayout: environment.state === 'ready' && (terminalOpen || detached),
      hiddenPanes
    };
  }

  private getStarterTemplates(): SidebarStarterOption[] {
    return [
      {
        id: 'custom',
        label: 'Custom',
        description: 'Start from a plain editable grid.',
        template: {
          layout: 'tiled',
          terminals: normalizeTerminalDefinitions([])
        }
      },
      ...this.getSuggestedStarters(this.inspectWorkspaceProject())
    ];
  }

  private getSuggestedStarters(projectInfo: WorkspaceProjectInfo): SidebarStarterOption[] {
    const detected = new Set<string>();
    const candidates = ['claude', 'codex', 'gemini', 'aider', 'goose'];
    for (const command of candidates) {
      if (isExecutableOnPath(command)) {
        detected.add(command);
      }
    }

    const starters: SidebarStarterOption[] = [];
    const multi = this.buildDetectedAgentsPreset(detected, projectInfo);
    if (multi) {
      starters.push(multi);
    }

    for (const command of candidates) {
      if (!detected.has(command)) {
        continue;
      }

      starters.push({
        id: `${command}-starter`,
        label: `${this.getAgentLabel(command)} Starter`,
        description: `Start from a ${this.getAgentLabel(command)}-focused grid.`,
        template: {
          layout: 'main-horizontal',
          terminals: [
            { name: this.getAgentLabel(command), startupCommand: command, cwd: '${workspaceFolder}' },
            { name: 'Shell', startupCommand: '', cwd: '${workspaceFolder}' },
            {
              name: projectInfo.preferredTestCommand ? 'Tests' : 'Shell 2',
              startupCommand: projectInfo.preferredTestCommand ?? '',
              cwd: '${workspaceFolder}'
            }
          ]
        }
      });
    }

    return starters;
  }

  private buildDetectedAgentsPreset(
    detectedAgents: Set<string>,
    projectInfo: WorkspaceProjectInfo
  ): SidebarStarterOption | undefined {
    const ordered = ['claude', 'codex', 'gemini', 'aider', 'goose'].filter((command) => detectedAgents.has(command));
    if (ordered.length < 2) {
      return undefined;
    }

    const terminals = ordered.slice(0, 3).map((command) => ({
      name: this.getAgentLabel(command),
      startupCommand: command,
      cwd: '${workspaceFolder}'
    }));

    terminals.push({
      name: projectInfo.preferredTestCommand ? 'Tests' : 'Shell',
      startupCommand: projectInfo.preferredTestCommand ?? '',
      cwd: '${workspaceFolder}'
    });

    return {
      id: 'detected-agents',
      label: 'Detected Agents',
      description: `Detected here: ${ordered.join(', ')}`,
      template: {
        layout: 'tiled',
        terminals
      }
    };
  }

  private getAgentLabel(command: string): string {
    switch (command) {
      case 'claude':
        return 'Claude';
      case 'codex':
        return 'Codex';
      case 'gemini':
        return 'Gemini';
      case 'aider':
        return 'Aider';
      case 'goose':
        return 'Goose';
      default:
        return command;
    }
  }

  private inspectWorkspaceProject(): WorkspaceProjectInfo {
    const workspaceRoot = this.getWorkspaceRoot();
    const packageJsonPath = workspaceRoot ? path.join(workspaceRoot, 'package.json') : undefined;
    const availableScripts = new Set<string>();

    if (packageJsonPath && fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, unknown> };
        if (packageJson.scripts) {
          for (const scriptName of Object.keys(packageJson.scripts)) {
            availableScripts.add(scriptName);
          }
        }
      } catch {
        // Ignore malformed package.json.
      }
    }

    return {
      availableScripts,
      preferredTestCommand: availableScripts.has('test:watch')
        ? 'npm run test:watch'
        : availableScripts.has('test')
          ? 'npm test'
          : undefined
    };
  }

  private getActiveSetupModel(
    effectiveConfig: ReturnType<AgentGridController['getEffectiveWorkspaceConfig']>,
    repoConfig: RepoConfigState
  ): ActiveSetupModel {
    const activeSetupId = this.getActiveSetupId();
    const profileName = activeSetupId.startsWith('profile:') ? activeSetupId.slice('profile:'.length) : undefined;
    const activeProfile = profileName ? effectiveConfig.profiles.find((profile) => profile.name === profileName) : undefined;

    if (activeProfile) {
      const source = this.getProfileStorage(activeProfile.name, repoConfig.config);
      return {
        id: this.buildProfileSetupId(activeProfile.name),
        kind: 'profile',
        label: `Profile: ${activeProfile.name}`,
        description: `Editing the "${activeProfile.name}" profile. This is the active setup used when you create the workspace.`,
        profileName: activeProfile.name,
        template: {
          layout: activeProfile.layout,
          terminals: activeProfile.terminals
        },
        storage: source === 'repo' ? 'repo' : 'user'
      };
    }

    return {
      id: 'default',
      kind: 'default',
      label: 'Default Setup',
      description: `Editing the default setup. This is the active setup used when you create the workspace. ${this.describeDefaultSetupSource(effectiveConfig.layers)}`,
      template: {
        layout: effectiveConfig.layout,
        terminals: effectiveConfig.terminals
      },
      storage: effectiveConfig.layers.layout === 'repo' || effectiveConfig.layers.terminals === 'repo' ? 'repo' : 'user'
    };
  }

  private describeDefaultSetupSource(layers: EffectiveConfigLayers): string {
    if (layers.layout === 'repo' && layers.terminals === 'repo') {
      return `Currently loaded from ${REPO_CONFIG_FILE}.`;
    }
    if (layers.layout === 'user' && layers.terminals === 'user') {
      return 'Currently loaded from your personal defaults.';
    }
    if (layers.layout === 'default' && layers.terminals === 'default') {
      return 'Currently using the built-in defaults.';
    }
    return `Currently mixed: layout from ${layers.layout}, panes from ${layers.terminals}.`;
  }

  private getStorageDetail(destination: ConfigurationDestination): string {
    if (destination === 'repo') {
      return `Stores Agent Grid setup in ${REPO_CONFIG_FILE} so a team can use the same workspace layout in this repository.`;
    }
    return 'Stores the setup in your personal Agent Grid settings and uses it as the base setup across workspaces.';
  }

  private buildProfileSetupId(profileName: string): string {
    return `profile:${profileName}`;
  }

  private getActiveSetupId(): string {
    return this.context.workspaceState.get<string>(ACTIVE_SETUP_KEY, 'default');
  }

  private async setActiveSetupId(setupId: string): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_SETUP_KEY, setupId);
  }

  private async saveActiveSetup(
    setupId: string,
    destination: ConfigurationDestination,
    template: ConfigurationTemplate,
    createWorkspace: boolean
  ): Promise<void> {
    if (setupId === 'default') {
      await this.saveDefaultSetup(destination, template);
    } else if (setupId.startsWith('profile:')) {
      await this.saveProfileTemplate(setupId.slice('profile:'.length), destination, template);
    }

    await this.setActiveSetupId(setupId);
    await this.context.workspaceState.update(ONBOARDING_KEY, true);
    await this.refreshSurface();

    if (createWorkspace && vscode.workspace.workspaceFolders?.length) {
      await this.openWorkspace('manual');
    }
  }

  private async saveAsNewProfile(
    profileName: string,
    destination: ConfigurationDestination,
    template: ConfigurationTemplate,
    createWorkspace: boolean
  ): Promise<void> {
    const trimmedName = profileName.trim();
    if (!trimmedName) {
      return;
    }

    await this.saveProfileTemplate(trimmedName, destination, template);
    await this.setActiveSetupId(this.buildProfileSetupId(trimmedName));
    await this.context.workspaceState.update(ONBOARDING_KEY, true);
    await this.refreshSurface();

    if (createWorkspace && vscode.workspace.workspaceFolders?.length) {
      await this.openWorkspace('manual');
    }
  }

  private async deleteProfile(profileName: string): Promise<void> {
    const source = this.getProfileStorage(profileName, this.getRepoConfigState().config);

    if (source === 'repo') {
      const writable = this.getWritableRepoConfig();
      if (!writable) {
        await vscode.window.showErrorMessage(`Fix ${REPO_CONFIG_FILE} before deleting a shared profile.`);
        return;
      }

      await this.writeRepoConfig({
        ...writable.config,
        profiles: (writable.config.profiles ?? []).filter((profile) => profile.name !== profileName)
      });
    } else {
      await this.updateUserDefaults({
        profiles: this.getUserConfiguredProfiles().filter((profile) => profile.name !== profileName)
      });
    }

    await this.setActiveSetupId('default');
    await this.refreshSurface();
  }

  private async saveDefaultSetup(destination: ConfigurationDestination, template: ConfigurationTemplate): Promise<void> {
    if (destination === 'repo') {
      const writable = this.getWritableRepoConfig();
      if (!writable) {
        await vscode.window.showErrorMessage(`Fix ${REPO_CONFIG_FILE} before saving a shared default setup.`);
        return;
      }

      await this.writeRepoConfig({
        ...writable.config,
        layout: template.layout,
        terminals: normalizeTerminalDefinitions(template.terminals)
      });
      return;
    }

    await this.updateUserDefaults({
      layout: template.layout,
      terminals: normalizeTerminalDefinitions(template.terminals)
    });
  }

  private async saveProfileTemplate(
    profileName: string,
    destination: ConfigurationDestination,
    template: ConfigurationTemplate
  ): Promise<void> {
    const profile: WorkspaceProfile = {
      name: profileName,
      layout: template.layout,
      terminals: normalizeTerminalDefinitions(template.terminals)
    };

    if (destination === 'repo') {
      const writable = this.getWritableRepoConfig();
      if (!writable) {
        await vscode.window.showErrorMessage(`Fix ${REPO_CONFIG_FILE} before saving a shared profile.`);
        return;
      }

      await this.writeRepoConfig({
        ...writable.config,
        profiles: mergeProfiles(writable.config.profiles ?? [], [profile])
      });
      return;
    }

    await this.updateUserDefaults({
      profiles: mergeProfiles(this.getUserConfiguredProfiles(), [profile])
    });
  }

  private async configureWorkspace(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.agentGrid');
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
        await this.revealAndPinTerminal(existingTerminal);
        await this.context.workspaceState.update(SESSION_STATE_KEY, true);
        await this.refreshSurface(environment);
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
    }

    const previousTerminal = vscode.window.activeTerminal;
    const previousEditor = captureEditorState(vscode.window.activeTextEditor);
    const terminal = this.createTerminal();
    await this.revealAndPinTerminal(terminal, previousEditor, previousTerminal);
    terminal.sendText(this.buildBootstrapCommand(session, recreate), true);
    await this.context.workspaceState.update(SESSION_STATE_KEY, true);
    await this.refreshSurface(environment);
  }

  private createTerminal(): vscode.Terminal {
    return vscode.window.createTerminal({
      name: TERMINAL_TITLE,
      cwd: this.getWorkspaceRoot(),
      location: {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: true
      },
      isTransient: false,
      iconPath: new vscode.ThemeIcon('terminal')
    });
  }

  private async revealAndPinTerminal(
    terminal: vscode.Terminal,
    previousEditor?: { document: vscode.TextDocument; viewColumn: vscode.ViewColumn | undefined; selection: vscode.Selection },
    previousTerminal?: vscode.Terminal
  ): Promise<void> {
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

    await this.restoreTerminalCreationContext(previousEditor, previousTerminal, terminal);
  }

  private async restoreTerminalCreationContext(
    previousEditor:
      | { document: vscode.TextDocument; viewColumn: vscode.ViewColumn | undefined; selection: vscode.Selection }
      | undefined,
    previousTerminal: vscode.Terminal | undefined,
    createdTerminal: vscode.Terminal
  ): Promise<void> {
    if (previousTerminal && previousTerminal !== createdTerminal) {
      previousTerminal.show(true);
      return;
    }

    const preferredLocation = vscode.workspace
      .getConfiguration('terminal.integrated')
      .get<string>('defaultLocation', 'panel');

    if (preferredLocation === 'editor') {
      return;
    }

    try {
      await vscode.commands.executeCommand('workbench.action.terminal.focus');
    } catch {
      return;
    }

    if (previousEditor) {
      await vscode.window.showTextDocument(previousEditor.document, {
        viewColumn: previousEditor.viewColumn,
        preserveFocus: false,
        selection: previousEditor.selection
      });
    }
  }

  private findExistingTerminal(): vscode.Terminal | undefined {
    return vscode.window.terminals.find((terminal) => terminal.name === TERMINAL_TITLE);
  }

  private async disposeTerminal(terminal: vscode.Terminal): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        closeListener.dispose();
        resolve();
      };

      const closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) {
          done();
        }
      });

      terminal.dispose();
      setTimeout(done, 1000);
    });
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
        // Try the next command for compatibility.
      }
    }
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

    if (vscode.env.remoteName === 'wsl') {
      return {
        state: 'tmux-missing',
        detail: 'tmux was not found in this WSL environment. Install it there, then recreate the workspace.'
      };
    }

    return {
      state: 'tmux-missing',
      detail: 'tmux was not found. Install it or configure agentGrid.tmuxCommand before creating the workspace.'
    };
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

  private async listPanes(session: WorkspaceSession): Promise<Array<{ index: number; active: boolean }>> {
    const output = await this.execTmux(session, [
      'list-panes',
      '-t',
      `${session.sessionName}:${session.windowName}`,
      '-F',
      '#{pane_index}\t#{pane_active}'
    ]);

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [indexText = '', activeText = '0'] = line.split('\t');
        return {
          index: Number(indexText),
          active: activeText === '1'
        };
      })
      .filter((pane) => Number.isInteger(pane.index));
  }

  private async listLivePanes(session: WorkspaceSession): Promise<SupportBundleLivePane[]> {
    try {
      const output = await this.execTmux(session, [
        'list-panes',
        '-t',
        `${session.sessionName}:${session.windowName}`,
        '-F',
        '#{pane_index}\t#{pane_active}\t#{pane_title}\t#{pane_current_command}\t#{pane_current_path}'
      ]);

      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [indexText = '', activeText = '0', title = '', currentCommand = '', currentPath = ''] = line.split('\t');
          return {
            index: Number(indexText),
            active: activeText === '1',
            title,
            currentCommand,
            currentPath
          };
        })
        .filter((pane) => Number.isInteger(pane.index));
    } catch {
      return [];
    }
  }

  private async listHiddenPanes(session: WorkspaceSession): Promise<HiddenPaneInfo[]> {
    try {
      const windows = await this.execTmux(session, ['list-windows', '-t', session.sessionName, '-F', '#{window_name}']);
      const hiddenWindows = windows
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`${HIDDEN_WINDOW_PREFIX}-`));

      const hiddenPanes: HiddenPaneInfo[] = [];
      for (const windowName of hiddenWindows) {
        const pane = await this.execTmux(session, [
          'list-panes',
          '-t',
          `${session.sessionName}:${windowName}`,
          '-F',
          '#{pane_title}\t#{pane_current_command}'
        ]);
        const [title = windowName, currentCommand = ''] = pane.split('\t');
        hiddenPanes.push({ windowName, title, currentCommand });
      }

      return hiddenPanes;
    } catch {
      return [];
    }
  }

  private async applyLiveLayout(layout: LayoutName): Promise<void> {
    await this.runPaneMutation(async (session) => {
      await this.execTmux(session, ['select-layout', '-t', `${session.sessionName}:${session.windowName}`, layout]);
    });
  }

  private async hideLivePane(paneIndex: number): Promise<void> {
    await this.runPaneMutation(async (session) => {
      const target = `${session.sessionName}:${session.windowName}.${paneIndex}`;
      const hiddenWindowName = `${HIDDEN_WINDOW_PREFIX}-${Date.now()}`;
      await this.execTmux(session, ['break-pane', '-d', '-t', target, '-n', hiddenWindowName]);
      await this.execTmux(session, ['select-layout', '-t', `${session.sessionName}:${session.windowName}`, this.getSessionFromSettings().layout]);
    });
  }

  private async restoreHiddenPane(windowName: string): Promise<void> {
    await this.runPaneMutation(async (session) => {
      await this.execTmux(session, [
        'join-pane',
        '-s',
        `${session.sessionName}:${windowName}.0`,
        '-t',
        `${session.sessionName}:${session.windowName}`
      ]);
      await this.execTmux(session, ['kill-window', '-t', `${session.sessionName}:${windowName}`]);
      await this.execTmux(session, ['select-layout', '-t', `${session.sessionName}:${session.windowName}`, this.getSessionFromSettings().layout]);
    });
  }

  private async broadcastCommand(initialCommand?: string): Promise<void> {
    const command =
      initialCommand ??
      (await vscode.window.showInputBox({
        prompt: 'Command to send to every Agent Grid pane',
        placeHolder: 'npm test'
      }));

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

  private async runPaneMutation(action: (session: WorkspaceSession) => Promise<void>): Promise<boolean> {
    const session = this.getSessionFromSettings();
    const environment = await this.inspectEnvironment(session);

    if (environment.state !== 'ready') {
      await vscode.window.showErrorMessage(environment.detail);
      await this.refreshSurface(environment);
      return false;
    }

    if (!(await this.hasDetachedTmuxSession(session)) && !this.findExistingTerminal()) {
      await vscode.window.showInformationMessage('Create the Agent Grid workspace before using live pane actions.');
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

  private async runDiagnostics(): Promise<void> {
    const session = this.getSessionFromSettings();
    const repoConfig = this.getRepoConfigState();
    const effectiveConfig = this.getEffectiveWorkspaceConfig(repoConfig.config);
    const environment = await this.inspectEnvironment(session);
    const detached = environment.state === 'ready' ? await this.hasDetachedTmuxSession(session) : false;
    const terminalOpen = Boolean(this.findExistingTerminal());
    const livePanes = environment.state === 'ready' && (terminalOpen || detached) ? await this.listLivePanes(session) : [];
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
      `Remote name: ${vscode.env.remoteName ?? '(local)'}`,
      `Platform: ${process.platform}`,
      `tmux command: ${tmuxCommand || '(empty)'}`,
      `tmux version: ${tmuxVersion}`,
      `Environment state: ${environment.state}`,
      `Environment detail: ${environment.detail}`,
      `Configured layout: ${session.layout}`,
      `Configured panes: ${session.terminals.length}`,
      `Active setup source: ${this.describeDefaultSetupSource(effectiveConfig.layers)}`,
      `Terminal open: ${terminalOpen ? 'yes' : 'no'}`,
      `Detached tmux session: ${detached ? 'yes' : 'no'}`,
      `Live pane states available: ${livePanes.length}`
    ];

    this.outputChannel.clear();
    this.outputChannel.appendLine('Agent Grid Environment Check');
    this.outputChannel.appendLine('');
    for (const line of lines) {
      this.outputChannel.appendLine(line);
    }

    if (livePanes.length > 0) {
      this.outputChannel.appendLine('');
      this.outputChannel.appendLine('Live panes:');
      for (const pane of livePanes) {
        this.outputChannel.appendLine(
          `- [${pane.active ? 'active' : 'idle'}] ${pane.title || `Pane ${pane.index + 1}`} :: ${pane.currentCommand} :: ${pane.currentPath ?? '(unknown cwd)'}`
        );
      }
    }

    this.outputChannel.show(true);
    await vscode.window.showInformationMessage('Agent Grid environment check written to the "Agent Grid" output channel.');
  }

  private async buildSupportBundle(safeForPublic: boolean): Promise<string> {
    const session = this.getSessionFromSettings();
    const repoConfig = this.getRepoConfigState();
    const effectiveConfig = this.getEffectiveWorkspaceConfig(repoConfig.config);
    const environment = await this.inspectEnvironment(session);
    const detached = environment.state === 'ready' ? await this.hasDetachedTmuxSession(session) : false;
    const terminalOpen = Boolean(this.findExistingTerminal());
    const livePanes = environment.state === 'ready' && (terminalOpen || detached) ? await this.listLivePanes(session) : [];
    const panes: SupportBundlePane[] = session.terminals.map((terminal) => ({
      name: terminal.name,
      cwd: terminal.cwd?.trim() || '${workspaceFolder}',
      startupCommand: terminal.startupCommand
    }));

    return buildSupportBundleMarkdown({
      generatedAt: new Date().toISOString(),
      extensionVersion: String(this.context.extension.packageJSON.version ?? 'unknown'),
      vscodeVersion: vscode.version,
      runtime: vscode.env.remoteName ?? process.platform,
      platform: process.platform,
      workspaceRoot: this.getWorkspaceRoot(),
      repoConfigPath: repoConfig.path,
      repoConfigState: repoConfig.error ? `error: ${repoConfig.error}` : repoConfig.exists ? 'loaded' : 'missing',
      environmentState: environment.state,
      environmentDetail: environment.detail,
      terminalOpen,
      detachedTmuxSession: detached,
      effectiveTmuxCommand: session.tmuxCommand,
      effectiveLayout: session.layout,
      effectivePanes: panes,
      effectiveConfigSource: this.describeDefaultSetupSource(effectiveConfig.layers),
      activeSetup: this.getActiveSetupModel(effectiveConfig, repoConfig).label,
      livePanes,
      repoConfig: repoConfig.config ?? {},
      safeForPublic
    });
  }

  private async exportSupportBundle(): Promise<void> {
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Safe for Public Issue', description: 'Recommended: redact absolute local paths', safeForPublic: true },
        { label: 'Full Detail', description: 'Include absolute local paths for private debugging', safeForPublic: false }
      ],
      { placeHolder: 'Choose the level of detail for the support bundle' }
    );

    if (!mode) {
      return;
    }

    const bundle = await this.buildSupportBundle(mode.safeForPublic);
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: `${bundle}\n`
    });

    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async openIssueTracker(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse('https://github.com/padjon/vscode-agent-grid/issues/new/choose'));
  }

  private async emailFeedback(): Promise<void> {
    await vscode.env.openExternal(
      vscode.Uri.parse(
        'mailto:info@devsheep.de?subject=Agent%20Grid%20Feedback&body=Please%20tell%20us%20about%20issues%2C%20feature%20wishes%2C%20or%20workflow%20ideas.'
      )
    );
  }

  private async openWalkthrough(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openWalkthrough', 'padjon.vscode-agent-grid#getting-started', false);
  }

  private buildSessionName(): string {
    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name;
    return workspaceName ? sanitizeTmuxName(`agent-grid-${workspaceName}`) : 'agent-grid';
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
      return { path: repoConfigPath, exists: false };
    }

    try {
      return {
        path: repoConfigPath,
        exists: true,
        config: parseRepoConfig(fs.readFileSync(repoConfigPath, 'utf8'))
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
  }

  private getWorkspaceSettingsLayer(): SettingsLayerConfig {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    return {
      tmuxCommand: this.readWorkspaceOverride<string>(config.inspect<string>('tmuxCommand')),
      layout: this.readWorkspaceOverride<string>(config.inspect<string>('layout')),
      terminals: this.readWorkspaceOverride<unknown[]>(config.inspect<unknown[]>('terminals')),
      profiles: this.readWorkspaceOverride<unknown[]>(config.inspect<unknown[]>('profiles'))
    };
  }

  private getUserSettingsLayer(): SettingsLayerConfig {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    return {
      tmuxCommand: this.readUserSetting<string>(config.inspect<string>('tmuxCommand')),
      layout: this.readUserSetting<string>(config.inspect<string>('layout')),
      terminals: this.readUserSetting<unknown[]>(config.inspect<unknown[]>('terminals')),
      profiles: this.readUserSetting<unknown[]>(config.inspect<unknown[]>('profiles'))
    };
  }

  private readWorkspaceOverride<T>(inspection: { workspaceFolderValue?: T; workspaceValue?: T } | undefined): T | undefined {
    return inspection?.workspaceFolderValue ?? inspection?.workspaceValue;
  }

  private readUserSetting<T>(inspection: { globalValue?: T } | undefined): T | undefined {
    return inspection?.globalValue;
  }

  private getEffectiveWorkspaceConfig(repoConfig: RepoConfig | undefined = this.getRepoConfigState().config) {
    return resolveEffectiveWorkspaceConfig({
      workspace: this.getWorkspaceSettingsLayer(),
      repo: repoConfig,
      user: this.getUserSettingsLayer()
    });
  }

  private getSessionFromSettings(
    effectiveConfig: ReturnType<AgentGridController['getEffectiveWorkspaceConfig']> = this.getEffectiveWorkspaceConfig()
  ): WorkspaceSession {
    const activeSetupId = this.getActiveSetupId();
    const activeProfileName = activeSetupId.startsWith('profile:') ? activeSetupId.slice('profile:'.length) : undefined;
    const activeProfile = activeProfileName ? effectiveConfig.profiles.find((profile) => profile.name === activeProfileName) : undefined;

    return {
      tmuxCommand: effectiveConfig.tmuxCommand,
      sessionName: this.buildSessionName(),
      windowName: DEFAULT_WINDOW_NAME,
      layout: activeProfile?.layout ?? effectiveConfig.layout,
      terminals: activeProfile?.terminals ?? effectiveConfig.terminals
    };
  }

  private getUserConfiguredProfiles(): WorkspaceProfile[] {
    return normalizeProfiles(this.getUserSettingsLayer().profiles ?? []);
  }

  private getRepoConfiguredProfiles(repoConfig: RepoConfig | undefined = this.getRepoConfigState().config): WorkspaceProfile[] {
    return normalizeProfiles(repoConfig?.profiles ?? []);
  }

  private getProfileStorage(profileName: string, repoConfig: RepoConfig | undefined): 'repo' | 'user' {
    if (this.getRepoConfiguredProfiles(repoConfig).some((profile) => profile.name === profileName)) {
      return 'repo';
    }
    return 'user';
  }

  private async updateUserDefaults(
    values: Partial<Record<'tmuxCommand' | 'layout' | 'terminals' | 'profiles', unknown>>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    if ('tmuxCommand' in values) {
      await config.update('tmuxCommand', values.tmuxCommand, vscode.ConfigurationTarget.Global);
    }
    if ('layout' in values) {
      await config.update('layout', values.layout, vscode.ConfigurationTarget.Global);
    }
    if ('terminals' in values) {
      await config.update('terminals', values.terminals, vscode.ConfigurationTarget.Global);
    }
    if ('profiles' in values) {
      await config.update('profiles', values.profiles, vscode.ConfigurationTarget.Global);
    }
  }
}

class AgentGridSidebarWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private state: SidebarState | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: AgentGridSidebarActions
  ) {}

  dispose(): void {
    // No-op.
  }

  setState(state: SidebarState): void {
    this.state = state;
    this.postState();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage(async (message) => {
      await this.handleMessage(message);
    });
    this.postState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'selectActiveSetup':
        if (isRecord(message.payload) && typeof message.payload.setupId === 'string') {
          await this.actions.onSelectActiveSetup(message.payload.setupId);
        }
        return;
      case 'saveActiveSetup':
        if (isRecord(message.payload) && typeof message.payload.setupId === 'string') {
          const destination = this.readDestination(message.payload.destination);
          const template = this.readTemplate(message.payload.template);
          if (destination && template) {
            await this.actions.onSaveActiveSetup(message.payload.setupId, destination, template, Boolean(message.payload.createWorkspace));
          }
        }
        return;
      case 'saveAsNewProfile':
        if (isRecord(message.payload) && typeof message.payload.profileName === 'string') {
          const destination = this.readDestination(message.payload.destination);
          const template = this.readTemplate(message.payload.template);
          if (destination && template) {
            await this.actions.onSaveAsNewProfile(
              message.payload.profileName,
              destination,
              template,
              Boolean(message.payload.createWorkspace)
            );
          }
        }
        return;
      case 'deleteProfile':
        if (isRecord(message.payload) && typeof message.payload.profileName === 'string') {
          await this.actions.onDeleteProfile(message.payload.profileName);
        }
        return;
      case 'broadcastCommand':
        if (isRecord(message.payload) && typeof message.payload.command === 'string') {
          await this.actions.onBroadcastCommand(message.payload.command);
        }
        return;
      case 'applyLiveLayout':
        if (isRecord(message.payload)) {
          const layout = readLayoutName(message.payload.layout);
          if (layout) {
            await this.actions.onApplyLiveLayout(layout);
          }
        }
        return;
      case 'hideLivePane':
        if (isRecord(message.payload) && typeof message.payload.paneIndex === 'number') {
          await this.actions.onHideLivePane(message.payload.paneIndex);
        }
        return;
      case 'restoreHiddenPane':
        if (isRecord(message.payload) && typeof message.payload.windowName === 'string') {
          await this.actions.onRestoreHiddenPane(message.payload.windowName);
        }
        return;
      case 'runDiagnostics':
        await this.actions.onRunDiagnostics();
        return;
      case 'exportSupportBundle':
        await this.actions.onExportSupportBundle();
        return;
      case 'openGuide':
        await this.actions.onOpenGuide();
        return;
      case 'openIssueTracker':
        await this.actions.onOpenIssueTracker();
        return;
      case 'emailFeedback':
        await this.actions.onEmailFeedback();
        return;
      default:
        return;
    }
  }

  private readDestination(value: unknown): ConfigurationDestination | undefined {
    return value === 'user' || value === 'repo' ? value : undefined;
  }

  private readTemplate(value: unknown): ConfigurationTemplate | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    const layout = readLayoutName(value.layout);
    const terminals = normalizeTerminalDefinitions(Array.isArray(value.terminals) ? value.terminals : []);
    if (!layout || terminals.length === 0) {
      return undefined;
    }

    return { layout, terminals };
  }

  private postState(): void {
    if (!this.view || !this.state) {
      return;
    }

    void this.view.webview.postMessage({
      type: 'state',
      payload: this.state
    });
  }

  private getHtml(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: light dark;
        --border: var(--vscode-editorWidget-border, rgba(127,127,127,0.35));
        --muted: var(--vscode-descriptionForeground);
        --bg-subtle: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-button-background) 12%);
      }
      body {
        font-family: var(--vscode-font-family);
        margin: 0;
        padding: 16px;
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
      }
      .stack { display: grid; gap: 14px; }
      .card {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px;
        background: var(--bg-subtle);
      }
      .status { display: grid; gap: 8px; }
      .status-badge {
        display: inline-flex;
        width: fit-content;
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
      }
      .tone-idle { background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-foreground) 20%); }
      .tone-running { background: color-mix(in srgb, var(--vscode-button-background) 30%, transparent); }
      .tone-warning { background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, #a15c00) 35%, transparent); }
      .muted { color: var(--muted); font-size: 12px; line-height: 1.45; }
      label { display: grid; gap: 6px; font-size: 12px; }
      select, input, button {
        font: inherit;
      }
      select, input {
        width: 100%;
        box-sizing: border-box;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 8px;
      }
      button {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px 10px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
      }
      button.secondary {
        background: transparent;
        color: var(--vscode-foreground);
      }
      button.linkish {
        background: transparent;
        border: 0;
        color: var(--vscode-textLink-foreground);
        padding: 0;
        text-align: left;
      }
      button:disabled, select:disabled, input:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .section-title {
        font-size: 13px;
        font-weight: 700;
      }
      .subtle-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
      }
      .layout-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .grid-preview-shell {
        display: grid;
        gap: 8px;
      }
      .grid-preview {
        display: grid;
        gap: 6px;
        min-height: 146px;
      }
      .grid-preview.layout-tiled {
        grid-template-columns: 1fr 1fr;
      }
      .grid-preview.layout-even-vertical {
        grid-auto-flow: column;
        grid-auto-columns: 1fr;
      }
      .grid-preview.layout-even-horizontal {
        grid-template-columns: 1fr;
      }
      .grid-preview.layout-main-horizontal {
        grid-template-columns: 1fr 1fr;
      }
      .grid-preview.layout-main-horizontal .preview-pane[data-index="0"] {
        grid-column: 1 / -1;
        min-height: 54px;
      }
      .grid-preview.layout-main-vertical {
        grid-template-columns: 1.2fr 0.8fr;
      }
      .grid-preview.layout-main-vertical .preview-pane[data-index="0"] {
        grid-row: 1 / span 3;
        min-height: 132px;
      }
      .preview-pane {
        min-height: 38px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-button-background) 18%);
        display: grid;
        align-content: center;
        padding: 10px;
        gap: 4px;
      }
      .preview-pane strong {
        font-size: 12px;
        font-weight: 700;
      }
      .preview-pane span {
        font-size: 11px;
        color: var(--muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .preview-pane.hidden {
        border-style: dashed;
        opacity: 0.72;
        background: transparent;
      }
      .layout-option {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px;
        background: transparent;
        text-align: left;
        color: var(--vscode-foreground);
      }
      .layout-option.active {
        border-color: var(--vscode-focusBorder);
        background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
      }
      .layout-preview {
        display: grid;
        gap: 3px;
        margin-bottom: 8px;
      }
      .layout-preview span {
        display: block;
        height: 8px;
        border-radius: 3px;
        background: color-mix(in srgb, var(--vscode-button-background) 35%, var(--vscode-editor-background));
      }
      .layout-preview.cols-2 { grid-template-columns: 1fr 1fr; }
      .layout-preview.cols-3 { grid-template-columns: 1.3fr 1fr 1fr; }
      .pane-list { display: grid; gap: 10px; }
      .pane-card {
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px;
        display: grid;
        gap: 8px;
      }
      .pane-title { font-size: 12px; font-weight: 600; }
      .actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .actions.two { grid-template-columns: 1fr 1fr; }
      .two-col { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
      .footer-links { display: flex; flex-wrap: wrap; gap: 10px; }
      .chip-list { display: flex; flex-wrap: wrap; gap: 8px; }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 999px;
        border: 1px solid var(--border);
        padding: 6px 10px;
        font-size: 12px;
      }
      details summary {
        cursor: pointer;
        font-size: 12px;
        color: var(--vscode-textLink-foreground);
      }
      .empty { color: var(--muted); font-size: 12px; }
    </style>
  </head>
  <body>
    <div id="app" class="stack"><div class="empty">Loading Agent Grid...</div></div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      let state;

      window.addEventListener('message', (event) => {
        if (event.data?.type === 'state') {
          state = event.data.payload;
          render();
        }
      });

      function render() {
        const app = document.getElementById('app');
        if (!state) {
          app.innerHTML = '<div class="empty">Loading Agent Grid...</div>';
          return;
        }

        const template = structuredClone(state.template);
        const setupOptions = state.availableSetups.map((item) =>
          '<option value="' + escapeHtml(item.id) + '"' + (item.id === state.activeSetupId ? ' selected' : '') + '>' + escapeHtml(item.label) + '</option>'
        ).join('');
        const starterOptions = state.starterTemplates.map((item) =>
          '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + '</option>'
        ).join('');
        const storageOptions = state.availableDestinations.map((item) =>
          '<option value="' + escapeHtml(item.value) + '"' + (item.value === state.selectedStorage ? ' selected' : '') + (item.disabled ? ' disabled' : '') + '>' + escapeHtml(item.label) + '</option>'
        ).join('');

        app.innerHTML = [
          '<div class="card status">',
            '<div class="status-badge tone-' + escapeHtml(state.statusTone) + '">' + escapeHtml(state.statusLabel) + '</div>',
            '<div class="muted">' + escapeHtml(state.statusDetail) + '</div>',
            '<label>Active setup<select id="activeSetup">' + setupOptions + '</select></label>',
            '<div class="muted">' + escapeHtml(state.activeSetupDetail) + '</div>',
          '</div>',
          '<div class="card stack">',
            '<div class="section-title">Configure Grid</div>',
            '<div class="muted">' + escapeHtml(state.activeSetupLabel) + '</div>',
            (state.starterTemplates.length > 0
              ? '<label>Start from<select id="starter"><option value="">Keep current editor</option>' + starterOptions + '</select></label>'
              : ''),
            '<div class="grid-preview-shell"><div class="subtle-label">Preview</div><div id="gridPreview" class="grid-preview"></div></div>',
            '<div class="subtle-label">Layout</div>',
            '<div id="layoutPicker" class="layout-grid"></div>',
            '<div class="two-col"><label>Pane count<select id="paneCount">' + buildPaneCountOptions(template.terminals.length) + '</select></label>' +
              (state.canApplyLiveLayout ? '<button class="secondary" id="applyLiveLayout">Apply Layout Live</button>' : '<div></div>') + '</div>',
            '<div class="subtle-label">Startup command for all panes</div>',
            '<div class="two-col"><input id="bulkStartup" placeholder="Leave empty for plain shells" /><button class="secondary" id="applyBulkStartup">Apply To All</button></div>',
            '<div class="subtle-label">Send command to all live panes</div>',
            '<div class="two-col"><input id="broadcastCommand" placeholder="npm test" /><button class="secondary" id="sendBroadcast">Send Now</button></div>',
            '<div id="panes" class="pane-list"></div>',
            (state.hiddenPanes.length > 0
              ? '<div class="subtle-label">Hidden right now</div><div id="hiddenPanes" class="chip-list"></div>'
              : ''),
            '<div class="actions">',
              '<button id="saveOnly">Save</button>',
              '<button id="saveAsProfile">Save As New Profile</button>',
              '<button id="saveAndCreate"' + (state.hasWorkspaceFolder ? '' : ' disabled') + '>Save + Create</button>',
            '</div>',
            '<div class="actions two">',
              '<button class="secondary" id="updateProfile"' + (state.canUpdateProfile ? '' : ' disabled') + '>Update Profile</button>',
              '<button class="secondary" id="deleteProfile"' + (state.canDeleteProfile ? '' : ' disabled') + '>Delete Profile</button>',
            '</div>',
          '</div>',
          '<div class="card stack">',
            '<details>',
              '<summary title="Stores Agent Grid setup in .agent-grid.json so a team can use the same workspace layout in this repository.">Advanced Storage</summary>',
              '<div class="stack" style="margin-top:10px;">',
                '<label>Save location<select id="destination">' + storageOptions + '</select></label>',
                '<div id="storageDetail" class="muted">' + escapeHtml(state.storageDetail) + '</div>',
              '</div>',
            '</details>',
          '</div>',
          '<div class="card stack">',
            '<div class="section-title">Support</div>',
            '<div class="footer-links">',
              '<button class="secondary" id="runDiagnostics">Environment Check</button>',
              '<button class="secondary" id="exportSupportBundle">Create Support Report</button>',
            '</div>',
            '<div class="footer-links">',
              '<button class="linkish" id="openGuide">Guide</button>',
              '<button class="linkish" id="openIssues">GitHub Issues</button>',
              '<button class="linkish" id="emailFeedback">Email Feedback</button>',
            '</div>',
          '</div>'
        ].join('');

        const panesRoot = document.getElementById('panes');
        const hiddenPanesRoot = document.getElementById('hiddenPanes');
        const activeSetupSelect = document.getElementById('activeSetup');
        const starterSelect = document.getElementById('starter');
        const gridPreview = document.getElementById('gridPreview');
        const layoutPicker = document.getElementById('layoutPicker');
        const paneCountSelect = document.getElementById('paneCount');
        const destinationSelect = document.getElementById('destination');
        const storageDetail = document.getElementById('storageDetail');
        const workspaceToken = "${'${workspaceFolder}'}";

        function ensurePaneCount(count) {
          while (template.terminals.length < count) {
            template.terminals.push({
              name: 'Pane ' + (template.terminals.length + 1),
              startupCommand: '',
              cwd: workspaceToken
            });
          }
          template.terminals = template.terminals.slice(0, count);
        }

        function buildLayoutPicker() {
          const layouts = [
            { value: 'tiled', label: 'Tiled', preview: '<div class="layout-preview cols-2"><span></span><span></span><span></span><span></span></div>' },
            { value: 'main-vertical', label: 'Main Vertical', preview: '<div class="layout-preview cols-3"><span></span><span></span><span></span></div>' },
            { value: 'main-horizontal', label: 'Main Horizontal', preview: '<div class="layout-preview"><span style="height:14px"></span><span></span><span></span></div>' },
            { value: 'even-vertical', label: 'Even Vertical', preview: '<div class="layout-preview cols-2"><span style="height:18px"></span><span style="height:18px"></span></div>' },
            { value: 'even-horizontal', label: 'Even Horizontal', preview: '<div class="layout-preview"><span></span><span></span><span></span></div>' }
          ];

          layoutPicker.innerHTML = layouts.map((layout) =>
            '<button class="layout-option' + (template.layout === layout.value ? ' active' : '') + '" data-layout="' + layout.value + '">' +
              layout.preview +
              '<div>' + layout.label + '</div>' +
            '</button>'
          ).join('');

          layoutPicker.querySelectorAll('[data-layout]').forEach((button) => {
            button.addEventListener('click', (event) => {
              event.preventDefault();
              template.layout = button.dataset.layout;
              buildLayoutPicker();
              renderPreview();
            });
          });
        }

        function renderPreview() {
          const hiddenPanes = state.hiddenPanes || [];
          gridPreview.className = 'grid-preview layout-' + template.layout;
          gridPreview.innerHTML = template.terminals.map((pane, index) =>
            '<div class="preview-pane" data-index="' + index + '">' +
              '<strong>' + escapeHtml(pane.name || ('Pane ' + (index + 1))) + '</strong>' +
              '<span>' + escapeHtml((pane.startupCommand || '').trim() || 'Plain shell') + '</span>' +
            '</div>'
          ).join('') + hiddenPanes.map((pane) =>
            '<div class="preview-pane hidden">' +
              '<strong>' + escapeHtml(pane.title || 'Hidden pane') + '</strong>' +
              '<span>' + escapeHtml((pane.currentCommand || '').trim() || 'Hidden right now') + '</span>' +
            '</div>'
          ).join('');
        }

        function renderPanes() {
          panesRoot.innerHTML = template.terminals.map((pane, index) => [
            '<div class="pane-card">',
              '<div class="pane-title">Pane ' + (index + 1) + '</div>',
              '<label>Name<input data-pane="' + index + '" data-field="name" value="' + escapeHtml(pane.name || ('Pane ' + (index + 1))) + '" /></label>',
              '<label>Startup command<input data-pane="' + index + '" data-field="startupCommand" value="' + escapeHtml(pane.startupCommand || '') + '" placeholder="Leave empty for a plain shell" /></label>',
              '<label>Working directory<input data-pane="' + index + '" data-field="cwd" value="' + escapeHtml(pane.cwd || workspaceToken) + '" placeholder="' + workspaceToken + '" /></label>',
              (state.canApplyLiveLayout ? '<button class="secondary" data-hide-pane="' + index + '">Hide Now</button>' : ''),
            '</div>'
          ].join('')).join('');

          panesRoot.querySelectorAll('input').forEach((input) => {
            input.addEventListener('input', (event) => {
              const target = event.target;
              const paneIndex = Number(target.dataset.pane);
              const field = target.dataset.field;
              if (!Number.isInteger(paneIndex) || !field) {
                return;
              }
              template.terminals[paneIndex][field] = target.value;
              renderPreview();
            });
          });

          panesRoot.querySelectorAll('[data-hide-pane]').forEach((button) => {
            button.addEventListener('click', () => {
              const paneIndex = Number(button.dataset.hidePane);
              if (!Number.isInteger(paneIndex)) {
                return;
              }
              vscode.postMessage({ type: 'hideLivePane', payload: { paneIndex } });
            });
          });
        }

        function renderHiddenPanes() {
          if (!hiddenPanesRoot) {
            return;
          }
          hiddenPanesRoot.innerHTML = state.hiddenPanes.map((pane) =>
            '<div class="chip">' +
              '<span>' + escapeHtml(pane.title || 'Hidden pane') + '</span>' +
              '<button class="linkish" data-restore-window="' + escapeHtml(pane.windowName) + '">Show</button>' +
            '</div>'
          ).join('');

          hiddenPanesRoot.querySelectorAll('[data-restore-window]').forEach((button) => {
            button.addEventListener('click', () => {
              vscode.postMessage({ type: 'restoreHiddenPane', payload: { windowName: button.dataset.restoreWindow } });
            });
          });
        }

        function currentPayload() {
          return {
            destination: destinationSelect.value,
            template: {
              layout: template.layout,
              terminals: template.terminals.map((pane, index) => ({
                name: (pane.name || ('Pane ' + (index + 1))).trim(),
                startupCommand: (pane.startupCommand || '').trim(),
                cwd: (pane.cwd || '').trim()
              }))
            }
          };
        }

        activeSetupSelect.addEventListener('change', () => {
          vscode.postMessage({ type: 'selectActiveSetup', payload: { setupId: activeSetupSelect.value } });
        });

        if (starterSelect) {
          starterSelect.addEventListener('change', () => {
            const selected = state.starterTemplates.find((item) => item.id === starterSelect.value);
            if (!selected) {
              return;
            }
            if (!window.confirm('Replace the current editor contents with this starter?')) {
              starterSelect.value = '';
              return;
            }
            template.layout = selected.template.layout;
            template.terminals = structuredClone(selected.template.terminals);
            paneCountSelect.value = String(template.terminals.length);
            buildLayoutPicker();
            renderPreview();
            renderPanes();
          });
        }

        paneCountSelect.addEventListener('change', () => {
          ensurePaneCount(Number(paneCountSelect.value));
          renderPreview();
          renderPanes();
        });

        destinationSelect.addEventListener('change', () => {
          const selected = state.availableDestinations.find((item) => item.value === destinationSelect.value);
          storageDetail.textContent = selected ? selected.description : '';
        });

        document.getElementById('saveOnly').addEventListener('click', () => {
          vscode.postMessage({ type: 'saveActiveSetup', payload: { setupId: state.activeSetupId, ...currentPayload(), createWorkspace: false } });
        });

        document.getElementById('saveAndCreate').addEventListener('click', () => {
          vscode.postMessage({ type: 'saveActiveSetup', payload: { setupId: state.activeSetupId, ...currentPayload(), createWorkspace: true } });
        });

        document.getElementById('saveAsProfile').addEventListener('click', () => {
          const profileName = window.prompt('New profile name');
          if (!profileName || !profileName.trim()) {
            return;
          }
          vscode.postMessage({ type: 'saveAsNewProfile', payload: { profileName: profileName.trim(), ...currentPayload(), createWorkspace: false } });
        });

        document.getElementById('updateProfile').addEventListener('click', () => {
          vscode.postMessage({ type: 'saveActiveSetup', payload: { setupId: state.activeSetupId, ...currentPayload(), createWorkspace: false } });
        });

        document.getElementById('deleteProfile').addEventListener('click', () => {
          if (!state.canDeleteProfile) {
            return;
          }
          const profileName = state.activeSetupId.replace('profile:', '');
          if (!window.confirm('Delete profile "' + profileName + '"?')) {
            return;
          }
          vscode.postMessage({ type: 'deleteProfile', payload: { profileName } });
        });

        document.getElementById('applyBulkStartup').addEventListener('click', () => {
          const value = document.getElementById('bulkStartup').value || '';
          template.terminals = template.terminals.map((pane) => ({ ...pane, startupCommand: value }));
          renderPreview();
          renderPanes();
        });

        document.getElementById('sendBroadcast').addEventListener('click', () => {
          const command = (document.getElementById('broadcastCommand').value || '').trim();
          if (!command) {
            return;
          }
          vscode.postMessage({ type: 'broadcastCommand', payload: { command } });
        });

        const liveLayoutButton = document.getElementById('applyLiveLayout');
        if (liveLayoutButton) {
          liveLayoutButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'applyLiveLayout', payload: { layout: template.layout } });
          });
        }

        document.getElementById('runDiagnostics').addEventListener('click', () => {
          vscode.postMessage({ type: 'runDiagnostics' });
        });
        document.getElementById('exportSupportBundle').addEventListener('click', () => {
          vscode.postMessage({ type: 'exportSupportBundle' });
        });
        document.getElementById('openGuide').addEventListener('click', () => {
          vscode.postMessage({ type: 'openGuide' });
        });
        document.getElementById('openIssues').addEventListener('click', () => {
          vscode.postMessage({ type: 'openIssueTracker' });
        });
        document.getElementById('emailFeedback').addEventListener('click', () => {
          vscode.postMessage({ type: 'emailFeedback' });
        });

        ensurePaneCount(template.terminals.length);
        buildLayoutPicker();
        renderPreview();
        renderPanes();
        renderHiddenPanes();
      }

      function buildPaneCountOptions(selected) {
        return [1,2,3,4,5,6].map((count) =>
          '<option value="' + count + '"' + (count === selected ? ' selected' : '') + '>' + count + '</option>'
        ).join('');
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }
    </script>
  </body>
</html>`;
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

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 16; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function isExecutableOnPath(command: string): boolean {
  const rawPath = process.env.PATH;
  if (!rawPath) {
    return false;
  }

  for (const directory of rawPath.split(path.delimiter)) {
    if (!directory) {
      continue;
    }

    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}
