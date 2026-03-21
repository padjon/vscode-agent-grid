import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import {
  buildDefaultTerminal,
  buildPresetGridLayout,
  buildSupportBundleMarkdown,
  buildTmuxLayoutPlan,
  buildTmuxBootstrapScript,
  describeWorkspaceLayout,
  getLayoutPaneCount,
  mergeProfiles,
  normalizeGridLayout,
  normalizeProfiles,
  normalizeTerminalDefinitions,
  normalizeWorkspaceLayout,
  parseRepoConfig,
  readLayoutName,
  resolveEffectiveWorkspaceConfig,
  sanitizeTmuxName
} from './core';
import type {
  EffectiveConfigLayers,
  GridLayout,
  PresetLayoutName,
  RepoConfig,
  SettingsLayerConfig,
  SupportBundleLivePane,
  SupportBundlePane,
  TerminalDefinition,
  TmuxLayoutPlan,
  WorkspaceLayout,
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
type ConfigurationDestination = 'user' | 'repo' | 'workspace';

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
  layout: WorkspaceLayout;
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
  paneIndex?: number;
  title: string;
  currentCommand: string;
}

interface SidebarState {
  hasWorkspaceFolder: boolean;
  statusLabel: string;
  statusDetail: string;
  statusTone: 'idle' | 'running' | 'warning';
  activeSetupId: string;
  availableSetups: ActiveSetupOption[];
  selectedStorage: ConfigurationDestination;
  availableDestinations: Array<{
    value: ConfigurationDestination;
    label: string;
    description: string;
    disabled?: boolean;
  }>;
  template: ConfigurationTemplate;
  starterTemplates: SidebarStarterOption[];
  canDeleteProfile: boolean;
  canApplyWorkspaceDraft: boolean;
  applyWorkspaceDraftLabel: string;
  canUseLivePaneActions: boolean;
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
  onApplyWorkspaceDraft: (template: ConfigurationTemplate) => Promise<void>;
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
      onApplyWorkspaceDraft: async (template) => {
        await this.applyWorkspaceDraft(template);
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
        if (terminal.name === TERMINAL_TITLE && this.listAgentGridTerminals().length === 0) {
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
      availableSetups: [
        {
          id: 'default',
          label: 'Default Setup',
          description: `${effectiveConfig.terminals.length} panes • ${describeWorkspaceLayout(effectiveConfig.layout)} • ${this.describeDefaultSetupSource(effectiveConfig.layers)}`
        },
        ...effectiveConfig.profiles.map((profile) => {
          const storage = this.getProfileStorage(profile.name, repoConfig.config);
          const storageLabel = storage === 'workspace' ? 'This Workspace' : storage === 'repo' ? 'Shared' : 'Personal';
          return {
            id: this.buildProfileSetupId(profile.name),
            label: profile.name,
            description: `${profile.terminals.length} panes • ${describeWorkspaceLayout(profile.layout)} • ${storageLabel}`
          };
        })
      ],
      selectedStorage: activeSetup.storage,
      availableDestinations: [
        { value: 'user', label: 'Personal', description: 'Save in your personal Agent Grid settings' },
        {
          value: 'workspace',
          label: 'This Workspace',
          description: `Save in .vscode/settings.json for this workspace only`,
          disabled: !vscode.workspace.workspaceFolders?.length
        },
        {
          value: 'repo',
          label: 'Shared In Repo',
          description: `Save in ${REPO_CONFIG_FILE} so this repo can share the setup`,
          disabled: !vscode.workspace.workspaceFolders?.length
        }
      ],
      template: activeSetup.template,
      starterTemplates: this.getStarterTemplates(),
      canDeleteProfile: activeSetup.kind === 'profile',
      canApplyWorkspaceDraft: environment.state === 'ready' && Boolean(vscode.workspace.workspaceFolders?.length),
      applyWorkspaceDraftLabel: terminalOpen || detached ? 'Apply To Running Workspace' : 'Open Draft Workspace',
      canUseLivePaneActions: terminalOpen || detached,
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
          layout: {
            kind: 'grid',
            grid: buildPresetGridLayout('tiled', 4)
          },
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
          layout: {
            kind: 'grid',
            grid: buildPresetGridLayout('main-horizontal', 3)
          },
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
        layout: {
          kind: 'grid',
          grid: buildPresetGridLayout('tiled', terminals.length)
        },
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
        label: activeProfile.name,
        description: `Profile: ${activeProfile.name}`,
        profileName: activeProfile.name,
        template: {
          layout: {
            kind: 'grid',
            grid: structuredClone(activeProfile.layout.grid)
          },
          terminals: activeProfile.terminals
        },
        storage: source
      };
    }

    return {
      id: 'default',
      kind: 'default',
      label: 'Default Setup',
      description: 'Default Setup',
      template: {
        layout: {
          kind: 'grid',
          grid: structuredClone(effectiveConfig.layout.grid)
        },
        terminals: effectiveConfig.terminals
      },
      storage:
        effectiveConfig.layers.layout === 'workspace' || effectiveConfig.layers.terminals === 'workspace'
          ? 'workspace'
          : effectiveConfig.layers.layout === 'repo' || effectiveConfig.layers.terminals === 'repo'
            ? 'repo'
            : 'user'
    };
  }

  private describeDefaultSetupSource(layers: EffectiveConfigLayers): string {
    if (layers.layout === 'workspace' || layers.terminals === 'workspace') {
      return 'Currently loaded from workspace settings.';
    }
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
    } else if (source === 'workspace') {
      await this.updateWorkspaceSettings({
        profiles: this.getWorkspaceConfiguredProfiles().filter((profile) => profile.name !== profileName)
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
        layout: template.layout.kind === 'preset' ? template.layout.preset : undefined,
        grid: structuredClone(template.layout.grid),
        terminals: normalizeTerminalDefinitions(template.terminals)
      });
      return;
    }

    const values = {
      layout: template.layout.kind === 'preset' ? template.layout.preset : undefined,
      grid: structuredClone(template.layout.grid),
      terminals: normalizeTerminalDefinitions(template.terminals)
    };

    if (destination === 'workspace') {
      await this.updateWorkspaceSettings(values);
      return;
    }

    await this.updateUserDefaults(values);
  }

  private async saveProfileTemplate(
    profileName: string,
    destination: ConfigurationDestination,
    template: ConfigurationTemplate
  ): Promise<void> {
    const profile: WorkspaceProfile = {
      name: profileName,
      layout:
        template.layout.kind === 'preset'
          ? { kind: 'preset', preset: template.layout.preset, grid: structuredClone(template.layout.grid) }
          : { kind: 'grid', grid: structuredClone(template.layout.grid) },
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

    if (destination === 'workspace') {
      await this.updateWorkspaceSettings({
        profiles: mergeProfiles(this.getWorkspaceConfiguredProfiles(), [profile])
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
    const previousEditor = captureEditorState(vscode.window.activeTextEditor);
    let previousTerminal = vscode.window.activeTerminal;
    let recreate = false;

    if (reason === 'restore' && existingTerminal) {
      await this.context.workspaceState.update(SESSION_STATE_KEY, true);
      await this.refreshSurface(environment);
      return;
    }

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
      if (previousTerminal === existingTerminal) {
        previousTerminal = undefined;
      }
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

    const terminal = this.createTerminal();
    await this.revealAndPinTerminal(terminal, previousEditor, previousTerminal);
    terminal.sendText(this.buildBootstrapCommand(session, recreate), true);
    await this.context.workspaceState.update(SESSION_STATE_KEY, true);
    await this.refreshSurface(environment);
  }

  private async openDraftWorkspace(session: WorkspaceSession, environment?: EnvironmentInfo): Promise<void> {
    const resolvedEnvironment = environment ?? (await this.inspectEnvironment(session));
    if (resolvedEnvironment.state !== 'ready') {
      await vscode.window.showErrorMessage(resolvedEnvironment.detail);
      await this.refreshSurface(resolvedEnvironment);
      return;
    }

    const previousTerminal = vscode.window.activeTerminal;
    const previousEditor = captureEditorState(vscode.window.activeTextEditor);
    const terminal = this.createTerminal();
    await this.revealAndPinTerminal(terminal, previousEditor, previousTerminal);
    terminal.sendText(this.buildBootstrapCommand(session, false), true);
    await this.context.workspaceState.update(SESSION_STATE_KEY, true);
    await this.refreshSurface(resolvedEnvironment);
  }

  private createTerminal(): vscode.Terminal {
    return vscode.window.createTerminal({
      name: TERMINAL_TITLE,
      cwd: this.getWorkspaceRoot(),
      location: {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: true
      },
      isTransient: true,
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
      if (this.tryShowTerminal(previousTerminal, true)) {
        if (previousEditor) {
          await vscode.window.showTextDocument(previousEditor.document, {
            viewColumn: previousEditor.viewColumn,
            preserveFocus: true,
            selection: previousEditor.selection
          });
        }
        return;
      }

      if (previousEditor) {
        await vscode.window.showTextDocument(previousEditor.document, {
          viewColumn: previousEditor.viewColumn,
          preserveFocus: true,
          selection: previousEditor.selection
        });
      }
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
      if (previousEditor) {
        await vscode.window.showTextDocument(previousEditor.document, {
          viewColumn: previousEditor.viewColumn,
          preserveFocus: false,
          selection: previousEditor.selection
        });
      }
      return;
    }

    if (previousEditor) {
      await vscode.window.showTextDocument(previousEditor.document, {
        viewColumn: previousEditor.viewColumn,
        preserveFocus: true,
        selection: previousEditor.selection
      });
    }
  }

  private findExistingTerminal(): vscode.Terminal | undefined {
    return this.listAgentGridTerminals()[0];
  }

  private listAgentGridTerminals(): vscode.Terminal[] {
    return vscode.window.terminals.filter((terminal) => terminal.name === TERMINAL_TITLE);
  }

  private tryShowTerminal(terminal: vscode.Terminal, preserveFocus: boolean): boolean {
    try {
      terminal.show(preserveFocus);
      return true;
    } catch {
      return false;
    }
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

  private async listVisiblePaneDetails(
    session: WorkspaceSession
  ): Promise<Array<{ index: number; active: boolean; paneId: string }>> {
    const output = await this.execTmux(session, [
      'list-panes',
      '-t',
      `${session.sessionName}:${session.windowName}`,
      '-F',
      '#{pane_index}\t#{pane_active}\t#{pane_id}'
    ]);

    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [indexText = '', activeText = '0', paneId = ''] = line.split('\t');
        return {
          index: Number(indexText),
          active: activeText === '1',
          paneId
        };
      })
      .filter((pane) => Number.isInteger(pane.index) && pane.paneId);
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
        const paneIndex = this.parseHiddenPaneIndex(windowName);
        const pane = await this.execTmux(session, [
          'list-panes',
          '-t',
          `${session.sessionName}:${windowName}`,
          '-F',
          '#{pane_title}\t#{pane_current_command}'
        ]);
        const [title = windowName, currentCommand = ''] = pane.split('\t');
        hiddenPanes.push({ windowName, paneIndex, title, currentCommand });
      }

      return hiddenPanes;
    } catch {
      return [];
    }
  }

  private async applyWorkspaceDraft(template: ConfigurationTemplate): Promise<void> {
    const session = this.getSessionFromTemplate(template);
    const environment = await this.inspectEnvironment(session);

    if (environment.state !== 'ready') {
      await vscode.window.showErrorMessage(environment.detail);
      await this.refreshSurface(environment);
      return;
    }

    const terminalOpen = Boolean(this.findExistingTerminal());
    const detached = await this.hasDetachedTmuxSession(session);

    if (!terminalOpen && !detached) {
      await this.openDraftWorkspace(session, environment);
      return;
    }

    await this.runPaneMutationWithSession(session, async (runningSession) => {
      await this.applyTemplateToRunningSession(runningSession, template);
    });
  }

  private async hideLivePane(paneIndex: number): Promise<void> {
    await this.runPaneMutation(async (session) => {
      const target = `${session.sessionName}:${session.windowName}.${paneIndex}`;
      const hiddenWindowName = `${HIDDEN_WINDOW_PREFIX}-${paneIndex}-${Date.now()}`;
      await this.execTmux(session, ['break-pane', '-d', '-t', target, '-n', hiddenWindowName]);
    });
  }

  private async restoreHiddenPane(windowName: string): Promise<void> {
    await this.runPaneMutation(async (session) => {
      await this.restoreHiddenPaneWindow(session, windowName);
      const targetLayout = this.getSessionFromSettings().layout;
      if ((await this.listVisiblePaneDetails(session)).length === getLayoutPaneCount(targetLayout)) {
        await this.applyLayoutToRunningSession(session, targetLayout);
      }
    });
  }

  private async restoreHiddenPaneWindow(session: WorkspaceSession, windowName: string): Promise<void> {
    await this.execTmux(session, [
      'join-pane',
      '-s',
      `${session.sessionName}:${windowName}.0`,
      '-t',
      `${session.sessionName}:${session.windowName}`
    ]);
    await this.execTmux(session, ['kill-window', '-t', `${session.sessionName}:${windowName}`]);
  }

  private async applyTemplateToRunningSession(session: WorkspaceSession, template: ConfigurationTemplate): Promise<void> {
    const paneTargets = await this.applyLayoutToRunningSession(session, template.layout);
    for (let index = 0; index < paneTargets.length; index += 1) {
      const pane = template.terminals[index] ?? buildDefaultTerminal(index + 1);
      const title = pane.name.trim() || `Pane ${index + 1}`;
      await this.execTmux(session, ['select-pane', '-t', paneTargets[index], '-T', title]);
    }
  }

  private async applyLayoutToRunningSession(session: WorkspaceSession, layout: WorkspaceLayout): Promise<string[]> {
    let visiblePanes = await this.listVisiblePaneDetails(session);
    const desiredPaneCount = getLayoutPaneCount(layout);

    while (visiblePanes.length > desiredPaneCount) {
      const paneToHide = visiblePanes.pop();
      if (!paneToHide) {
        break;
      }
      const hiddenWindowName = `${HIDDEN_WINDOW_PREFIX}-${paneToHide.index}-${Date.now()}`;
      await this.execTmux(session, ['break-pane', '-d', '-s', paneToHide.paneId, '-n', hiddenWindowName]);
      visiblePanes = await this.listVisiblePaneDetails(session);
    }

    if (visiblePanes.length < desiredPaneCount) {
      const hiddenPanes = await this.listHiddenPanes(session);
      for (const hiddenPane of hiddenPanes) {
        if (visiblePanes.length >= desiredPaneCount) {
          break;
        }
        await this.restoreHiddenPaneWindow(session, hiddenPane.windowName);
        visiblePanes = await this.listVisiblePaneDetails(session);
      }
    }

    if (visiblePanes.length !== desiredPaneCount) {
      throw new Error(
        `Agent Grid could not match the requested pane count live. Visible: ${visiblePanes.length}, target: ${desiredPaneCount}. Open the draft workspace or save and recreate the workspace instead.`
      );
    }

    const plan = buildTmuxLayoutPlan(layout);
    const anchorPane = visiblePanes[0];
    if (!anchorPane) {
      throw new Error('No visible tmux pane was found for the current Agent Grid session.');
    }

    const detachedWindows: Array<{ paneId: string; windowName: string }> = [];
    for (let index = 1; index < visiblePanes.length; index += 1) {
      const pane = visiblePanes[index];
      const windowName = `${HIDDEN_WINDOW_PREFIX}-reflow-${Date.now()}-${index}`;
      await this.execTmux(session, ['break-pane', '-d', '-s', pane.paneId, '-n', windowName]);
      detachedWindows.push({ paneId: pane.paneId, windowName });
    }

    const paneTargets = await this.buildLiveLayoutFromPlan(session, plan, anchorPane.paneId);
    for (let index = 1; index < paneTargets.length; index += 1) {
      const detached = detachedWindows[index - 1];
      const targetPaneId = paneTargets[index];
      await this.execTmux(session, ['swap-pane', '-s', detached.paneId, '-t', targetPaneId]);
      await this.execTmux(session, ['kill-window', '-t', `${session.sessionName}:${detached.windowName}`]);
    }
    return paneTargets;
  }

  private async buildLiveLayoutFromPlan(
    session: WorkspaceSession,
    plan: TmuxLayoutPlan,
    paneId: string
  ): Promise<string[]> {
    if (plan.kind === 'leaf') {
      return [paneId];
    }

    const splitFlag = plan.axis === 'vertical' ? '-h' : '-v';
    const secondPercent = Math.max(1, Math.round((100 * plan.secondSpan) / (plan.firstSpan + plan.secondSpan)));
    const newPaneId = await this.execTmux(session, [
      'split-window',
      '-P',
      '-F',
      '#{pane_id}',
      splitFlag,
      '-l',
      `${secondPercent}%`,
      '-t',
      paneId
    ]);

    const firstOrder = await this.buildLiveLayoutFromPlan(session, plan.first, paneId);
    const secondOrder = await this.buildLiveLayoutFromPlan(session, plan.second, newPaneId);
    return [...firstOrder, ...secondOrder];
  }

  private parseHiddenPaneIndex(windowName: string): number | undefined {
    const match = windowName.match(new RegExp(`^${HIDDEN_WINDOW_PREFIX}-(\\d+)-\\d+$`));
    if (!match) {
      return undefined;
    }

    const paneIndex = Number(match[1]);
    return Number.isInteger(paneIndex) ? paneIndex : undefined;
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
    return this.runPaneMutationWithSession(this.getSessionFromSettings(), action);
  }

  private async runPaneMutationWithSession(
    session: WorkspaceSession,
    action: (session: WorkspaceSession) => Promise<void>
  ): Promise<boolean> {
    const environment = await this.inspectEnvironment(session);

    if (environment.state !== 'ready') {
      await vscode.window.showErrorMessage(environment.detail);
      await this.refreshSurface(environment);
      return false;
    }

    if (!(await this.hasDetachedTmuxSession(session)) && !this.findExistingTerminal()) {
      await vscode.window.showInformationMessage('Open the draft workspace before using live pane actions.');
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
      `Configured layout: ${describeWorkspaceLayout(session.layout)}`,
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
      effectiveLayout: describeWorkspaceLayout(session.layout),
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
      grid: this.readWorkspaceOverride<unknown>(config.inspect<unknown>('grid')),
      terminals: this.readWorkspaceOverride<unknown[]>(config.inspect<unknown[]>('terminals')),
      profiles: this.readWorkspaceOverride<unknown[]>(config.inspect<unknown[]>('profiles'))
    };
  }

  private getUserSettingsLayer(): SettingsLayerConfig {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    return {
      tmuxCommand: this.readUserSetting<string>(config.inspect<string>('tmuxCommand')),
      layout: this.readUserSetting<string>(config.inspect<string>('layout')),
      grid: this.readUserSetting<unknown>(config.inspect<unknown>('grid')),
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

  private getSessionFromTemplate(
    template: ConfigurationTemplate,
    effectiveConfig: ReturnType<AgentGridController['getEffectiveWorkspaceConfig']> = this.getEffectiveWorkspaceConfig()
  ): WorkspaceSession {
    const paneCount = getLayoutPaneCount(template.layout);
    const normalized = normalizeTerminalDefinitions(template.terminals).slice(0, paneCount);
    while (normalized.length < paneCount) {
      normalized.push(buildDefaultTerminal(normalized.length + 1));
    }

    return {
      tmuxCommand: effectiveConfig.tmuxCommand,
      sessionName: this.buildSessionName(),
      windowName: DEFAULT_WINDOW_NAME,
      layout: template.layout,
      terminals: normalized
    };
  }

  private getUserConfiguredProfiles(): WorkspaceProfile[] {
    return normalizeProfiles(this.getUserSettingsLayer().profiles ?? []);
  }

  private getRepoConfiguredProfiles(repoConfig: RepoConfig | undefined = this.getRepoConfigState().config): WorkspaceProfile[] {
    return normalizeProfiles(repoConfig?.profiles ?? []);
  }

  private getWorkspaceConfiguredProfiles(): WorkspaceProfile[] {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    const inspection = config.inspect<unknown[]>('profiles');
    return normalizeProfiles(inspection?.workspaceFolderValue ?? inspection?.workspaceValue ?? []);
  }

  private getProfileStorage(profileName: string, repoConfig: RepoConfig | undefined): ConfigurationDestination {
    if (this.getWorkspaceConfiguredProfiles().some((profile) => profile.name === profileName)) {
      return 'workspace';
    }
    if (this.getRepoConfiguredProfiles(repoConfig).some((profile) => profile.name === profileName)) {
      return 'repo';
    }
    return 'user';
  }

  private async updateUserDefaults(
    values: Partial<Record<'tmuxCommand' | 'layout' | 'grid' | 'terminals' | 'profiles', unknown>>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    if ('tmuxCommand' in values) {
      await config.update('tmuxCommand', values.tmuxCommand, vscode.ConfigurationTarget.Global);
    }
    if ('layout' in values) {
      await config.update('layout', values.layout, vscode.ConfigurationTarget.Global);
    }
    if ('grid' in values) {
      await config.update('grid', values.grid, vscode.ConfigurationTarget.Global);
    }
    if ('terminals' in values) {
      await config.update('terminals', values.terminals, vscode.ConfigurationTarget.Global);
    }
    if ('profiles' in values) {
      await config.update('profiles', values.profiles, vscode.ConfigurationTarget.Global);
    }
  }

  private async updateWorkspaceSettings(
    values: Partial<Record<'layout' | 'grid' | 'terminals' | 'profiles', unknown>>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAMESPACE);
    if ('layout' in values) {
      await config.update('layout', values.layout, vscode.ConfigurationTarget.Workspace);
    }
    if ('grid' in values) {
      await config.update('grid', values.grid, vscode.ConfigurationTarget.Workspace);
    }
    if ('terminals' in values) {
      await config.update('terminals', values.terminals, vscode.ConfigurationTarget.Workspace);
    }
    if ('profiles' in values) {
      await config.update('profiles', values.profiles, vscode.ConfigurationTarget.Workspace);
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
      case 'applyWorkspaceDraft':
        if (isRecord(message.payload)) {
          const template = this.readTemplate(message.payload.template);
          if (template) {
            await this.actions.onApplyWorkspaceDraft(template);
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
    return value === 'user' || value === 'repo' || value === 'workspace' ? value : undefined;
  }

  private readTemplate(value: unknown): ConfigurationTemplate | undefined {
    if (!isRecord(value)) {
      return undefined;
    }

    const layout = this.readWorkspaceLayout(value.layout);
    const terminals = normalizeTerminalDefinitions(Array.isArray(value.terminals) ? value.terminals : []);
    if (!layout || terminals.length === 0) {
      return undefined;
    }

    return { layout, terminals };
  }

  private readWorkspaceLayout(value: unknown): WorkspaceLayout | undefined {
    if (isRecord(value) && value.kind === 'grid') {
      const grid = normalizeGridLayout(value.grid);
      if (grid) {
        return {
          kind: 'grid',
          grid
        };
      }
    }

    if (isRecord(value) && value.kind === 'preset') {
      const preset = readLayoutName(value.preset);
      if (preset) {
        return normalizeWorkspaceLayout(preset, value.grid, Array.isArray(value.terminals) ? value.terminals.length : 4);
      }
    }

    const preset = readLayoutName(value);
    return preset ? normalizeWorkspaceLayout(preset, undefined, 4) : undefined;
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
        --surface: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-editor-background) 12%);
        --surface-strong: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-sideBar-background) 16%);
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
        border-radius: 12px;
        padding: 12px;
        background: transparent;
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
      .starter-row, .footer-links {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .starter-pill {
        border-radius: 999px;
        background: transparent;
        color: var(--vscode-foreground);
      }
      .grid-editor {
        display: grid;
        gap: 6px;
        padding: 8px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface-strong);
      }
      .grid-cell {
        min-height: 44px;
        border-radius: 10px;
        border: 1px solid var(--border);
        display: grid;
        place-items: center;
        font-size: 11px;
        font-weight: 700;
        color: var(--vscode-foreground);
        cursor: pointer;
        transition: transform 120ms ease, outline-color 120ms ease, opacity 120ms ease;
      }
      .grid-cell:hover {
        transform: translateY(-1px);
      }
      .grid-cell.selected {
        outline: 2px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }
      .grid-cell.hidden {
        opacity: 0.48;
      }
      .pane-list { display: grid; gap: 10px; }
      .pane-card {
        border: 0;
        border-top: 1px solid var(--border);
        border-radius: 0;
        padding: 10px 0 0;
        display: grid;
        gap: 8px;
        background: transparent;
      }
      .pane-card:first-child {
        border-top: 0;
        padding-top: 0;
      }
      .pane-title { font-size: 12px; font-weight: 600; }
      .pane-meta { color: var(--muted); font-size: 11px; }
      .actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .actions.two { grid-template-columns: 1fr 1fr; }
      .two-col { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
      .setup-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
      .full-width { width: 100%; }
      .input-action { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
      .ghost-pane-list {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 8px;
      }
      .ghost-pane {
        border: 1px dashed var(--border);
        border-radius: 8px;
        padding: 8px;
        display: grid;
        gap: 4px;
        background: transparent;
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
      let template;
      let showNewSetupForm = false;
      let pendingNewSetupName = '';

      window.addEventListener('message', (event) => {
        if (event.data?.type === 'state') {
          const prevActiveSetupId = state?.activeSetupId;
          state = event.data.payload;
          if (!template || state.activeSetupId !== prevActiveSetupId) {
            template = structuredClone(state.template);
          }
          showNewSetupForm = false;
          pendingNewSetupName = '';
          render();
        }
      });

      function render() {
        const app = document.getElementById('app');
        if (!state) {
          app.innerHTML = '<div class="empty">Loading Agent Grid...</div>';
          return;
        }

        const setupOptions = state.availableSetups.map((item) =>
          '<option value="' + escapeHtml(item.id) + '"' + (item.id === state.activeSetupId ? ' selected' : '') + '>' + escapeHtml(item.label) + '</option>'
        ).join('');
        const storageOptions = state.availableDestinations.map((item) =>
          '<option value="' + escapeHtml(item.value) + '"' + (item.value === state.selectedStorage ? ' selected' : '') + (item.disabled ? ' disabled' : '') + '>' + escapeHtml(item.label) + '</option>'
        ).join('');

        app.innerHTML = [
          '<div class="card status">',
            '<div class="status-badge tone-' + escapeHtml(state.statusTone) + '">' + escapeHtml(state.statusLabel) + '</div>',
            '<div class="muted">' + escapeHtml(state.statusDetail) + '</div>',
            '<div class="setup-row">',
              '<label>Setup<select id="activeSetup">' + setupOptions + '</select></label>',
              '<button class="secondary" id="newSetup">+ New</button>',
            '</div>',
            (function() {
              const sel = state.availableSetups.find(function(s) { return s.id === state.activeSetupId; });
              return sel ? '<div class="muted">' + escapeHtml(sel.description) + '</div>' : '';
            }()),
            '<div id="newSetupForm" style="display:' + (showNewSetupForm ? '' : 'none') + '">',
              '<label>Name<input id="newSetupName" placeholder="My Workspace Setup" value="' + escapeHtml(pendingNewSetupName) + '" /></label>',
              '<div class="actions two">',
                '<button id="confirmNewSetup">Create</button>',
                '<button class="secondary" id="cancelNewSetup">Cancel</button>',
              '</div>',
            '</div>',
          '</div>',
          '<div class="card stack">',
            '<div class="section-title">Workspace Setup</div>',
            '<div class="subtle-label">Shape starters</div>',
            '<div id="shapeStarters" class="starter-row"></div>',
            '<div class="subtle-label">Grid editor</div>',
            '<div class="muted">Click cells to select them. Merge a rectangle into one pane, or split a merged pane back into smaller panes. Agent Grid supports up to 8 panes.</div>',
            '<div class="two-col"><label>Rows<select id="gridRows">' + buildSizeOptions(template.layout.grid.rows) + '</select></label><label>Columns<select id="gridCols">' + buildSizeOptions(template.layout.grid.cols) + '</select></label></div>',
            '<div id="gridEditor" class="grid-editor"></div>',
            '<div class="actions two"><button class="secondary" id="mergeSelection">Merge Selection</button><button class="secondary" id="splitSelection">Split Selected Pane</button></div>',
            (state.canApplyWorkspaceDraft ? '<button class="secondary" id="applyWorkspaceDraft">' + escapeHtml(state.applyWorkspaceDraftLabel) + '</button>' : ''),
            '<div class="subtle-label">Startup command for all panes</div>',
            '<div class="input-action"><input id="bulkStartup" placeholder="Leave empty for plain shells" /><button class="secondary" id="applyBulkStartup">Apply To All</button></div>',
            '<div class="subtle-label">Send command to all live panes</div>',
            '<div class="input-action"><input id="broadcastCommand" placeholder="npm test" /><button class="secondary" id="sendBroadcast">Send Now</button></div>',
            '<div id="panes" class="pane-list"></div>',
            (state.hiddenPanes.length > 0
              ? '<div class="subtle-label">Hidden right now</div><div id="hiddenPanes" class="ghost-pane-list"></div>'
              : ''),
            '<div class="subtle-label">Save</div>',
            '<label>Save to<select id="destination">' + storageOptions + '</select></label>',
            '<div class="actions two">',
              '<button id="saveOnly">Save</button>',
              '<button id="saveAndCreate"' + (state.hasWorkspaceFolder ? '' : ' disabled') + '>Save + Open</button>',
            '</div>',
            (state.canDeleteProfile ? '<button class="secondary full-width" id="deleteProfile">Delete Setup</button>' : ''),
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
        const shapeStarters = document.getElementById('shapeStarters');
        const gridEditor = document.getElementById('gridEditor');
        const gridRows = document.getElementById('gridRows');
        const gridCols = document.getElementById('gridCols');
        const destinationSelect = document.getElementById('destination');
        const workspaceToken = "${'${workspaceFolder}'}";
        const hiddenPaneIndexes = new Set(
          state.hiddenPanes
            .map((pane) => pane.paneIndex)
            .filter((value) => Number.isInteger(value))
        );
        let selectedCells = [];

        function buildDefaultPane(index) {
          return {
            name: 'Pane ' + (index + 1),
            startupCommand: '',
            cwd: workspaceToken
          };
        }

        function clonePane(pane, index) {
          return {
            name: pane?.name || ('Pane ' + (index + 1)),
            startupCommand: pane?.startupCommand || '',
            cwd: pane?.cwd || workspaceToken
          };
        }

        function ensurePaneCount(count) {
          while (template.terminals.length < count) {
            template.terminals.push(buildDefaultPane(template.terminals.length));
          }
          template.terminals = template.terminals.slice(0, count).map((pane, index) => clonePane(pane, index));
        }

        function sortAreas(areas) {
          return [...areas].sort((left, right) => {
            if (left.y !== right.y) return left.y - right.y;
            if (left.x !== right.x) return left.x - right.x;
            if (left.height !== right.height) return right.height - left.height;
            return right.width - left.width;
          });
        }

        function buildUniformGrid(rows, cols) {
          const areas = [];
          for (let y = 0; y < rows; y += 1) {
            for (let x = 0; x < cols; x += 1) {
              areas.push({ x, y, width: 1, height: 1 });
            }
          }
          return { rows, cols, areas };
        }

        function mergeTrailingAreas(areas) {
          const sorted = sortAreas(areas);
          for (let index = sorted.length - 1; index > 0; index -= 1) {
            const first = sorted[index - 1];
            const second = sorted[index];
            if (first.y === second.y && first.height === second.height && first.x + first.width === second.x) {
              const next = [...sorted];
              next.splice(index - 1, 2, { x: first.x, y: first.y, width: first.width + second.width, height: first.height });
              return sortAreas(next);
            }
            if (first.x === second.x && first.width === second.width && first.y + first.height === second.y) {
              const next = [...sorted];
              next.splice(index - 1, 2, { x: first.x, y: first.y, width: first.width, height: first.height + second.height });
              return sortAreas(next);
            }
          }
          return sorted;
        }

        function buildPresetGrid(preset, paneCount) {
          const count = Math.max(1, Math.min(8, paneCount));
          if (preset === 'even-horizontal') return buildUniformGrid(1, count);
          if (preset === 'even-vertical') return buildUniformGrid(count, 1);
          if (preset === 'main-horizontal') {
            if (count === 1) return buildUniformGrid(1, 1);
            const cols = Math.max(1, count - 1);
            const areas = [{ x: 0, y: 0, width: cols, height: 1 }];
            for (let index = 0; index < count - 1; index += 1) {
              areas.push({ x: index, y: 1, width: 1, height: 1 });
            }
            return { rows: 2, cols, areas };
          }
          if (preset === 'main-vertical') {
            if (count === 1) return buildUniformGrid(1, 1);
            const rows = Math.max(1, count - 1);
            const areas = [{ x: 0, y: 0, width: 1, height: rows }];
            for (let index = 0; index < count - 1; index += 1) {
              areas.push({ x: 1, y: index, width: 1, height: 1 });
            }
            return { rows, cols: 2, areas };
          }
          const cols = Math.ceil(Math.sqrt(count));
          const rows = Math.ceil(count / cols);
          let areas = buildUniformGrid(rows, cols).areas;
          while (areas.length > count) {
            areas = mergeTrailingAreas(areas);
          }
          return { rows, cols, areas: sortAreas(areas) };
        }

        function sameArea(left, right) {
          return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
        }

        function overlapArea(left, right) {
          const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
          const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
          return width * height;
        }

        function remapTerminals(previousGrid, previousTerminals, nextGrid) {
          const previousAreas = sortAreas(previousGrid.areas);
          const nextAreas = sortAreas(nextGrid.areas);
          const used = new Set();
          return nextAreas.map((area, index) => {
            let candidateIndex = previousAreas.findIndex((previousArea, previousIndex) => !used.has(previousIndex) && sameArea(previousArea, area));

            if (candidateIndex < 0) {
              let bestScore = 0;
              for (let previousIndex = 0; previousIndex < previousAreas.length; previousIndex += 1) {
                if (used.has(previousIndex)) {
                  continue;
                }
                const score = overlapArea(previousAreas[previousIndex], area);
                if (score > bestScore) {
                  bestScore = score;
                  candidateIndex = previousIndex;
                }
              }
            }

            if (candidateIndex >= 0) {
              used.add(candidateIndex);
              return clonePane(previousTerminals[candidateIndex], index);
            }

            return buildDefaultPane(index);
          });
        }

        function applyGrid(nextGrid) {
          const normalizedGrid = {
            rows: nextGrid.rows,
            cols: nextGrid.cols,
            areas: sortAreas(nextGrid.areas)
          };
          const previousGrid = structuredClone(template.layout.grid);
          const previousTerminals = structuredClone(template.terminals);
          template.layout = { kind: 'grid', grid: normalizedGrid };
          template.terminals = remapTerminals(previousGrid, previousTerminals, normalizedGrid);
          ensurePaneCount(normalizedGrid.areas.length);
          gridRows.value = String(normalizedGrid.rows);
          gridCols.value = String(normalizedGrid.cols);
          selectedCells = [];
          renderGridEditor();
          renderPanes();
        }

        function applyUniformSize(rows, cols) {
          if (rows * cols > 8) {
            window.alert('Agent Grid supports up to 8 panes. Merge cells if you need a larger canvas with fewer active panes.');
            gridRows.value = String(template.layout.grid.rows);
            gridCols.value = String(template.layout.grid.cols);
            return;
          }
          applyGrid(buildUniformGrid(rows, cols));
        }

        function paneAtCell(x, y) {
          return template.layout.grid.areas.findIndex((area) =>
            x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height
          );
        }

        function colorForPane(index) {
          const hue = (index * 57) % 360;
          return 'hsla(' + hue + ', 62%, 52%, 0.22)';
        }

        function selectedCellObjects() {
          return selectedCells.map((key) => {
            const [x, y] = key.split(':').map(Number);
            return { x, y };
          });
        }

        function selectedRectangle() {
          const cells = selectedCellObjects();
          if (cells.length === 0) return undefined;
          const xs = cells.map((cell) => cell.x);
          const ys = cells.map((cell) => cell.y);
          const minX = Math.min(...xs);
          const maxX = Math.max(...xs);
          const minY = Math.min(...ys);
          const maxY = Math.max(...ys);
          if ((maxX - minX + 1) * (maxY - minY + 1) !== cells.length) return undefined;
          return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
        }

        function canMergeSelection() {
          const rect = selectedRectangle();
          if (!rect || selectedCells.length < 2) return false;
          return template.layout.grid.areas.every((area) => {
            const overlaps = !(area.x + area.width <= rect.x || area.x >= rect.x + rect.width || area.y + area.height <= rect.y || area.y >= rect.y + rect.height);
            if (!overlaps) return true;
            return area.x >= rect.x && area.y >= rect.y && area.x + area.width <= rect.x + rect.width && area.y + area.height <= rect.y + rect.height;
          });
        }

        function canSplitSelection() {
          if (selectedCells.length === 0) return false;
          const owners = [...new Set(selectedCellObjects().map((cell) => paneAtCell(cell.x, cell.y)))];
          if (owners.length !== 1 || owners[0] < 0) return false;
          const area = template.layout.grid.areas[owners[0]];
          return area.width > 1 || area.height > 1;
        }

        function renderShapeStarters() {
          const presets = [
            { value: 'tiled', label: 'Tiled' },
            { value: 'main-vertical', label: 'Main Vertical' },
            { value: 'main-horizontal', label: 'Main Horizontal' },
            { value: 'even-vertical', label: 'Columns' },
            { value: 'even-horizontal', label: 'Rows' }
          ];
          shapeStarters.innerHTML = presets.map((preset) =>
            '<button type="button" class="starter-pill secondary" data-shape="' + preset.value + '">' + preset.label + '</button>'
          ).join('');
          shapeStarters.querySelectorAll('[data-shape]').forEach((button) => {
            button.addEventListener('click', () => {
              applyGrid(buildPresetGrid(button.dataset.shape, template.terminals.length));
            });
          });
        }

        function renderGridEditor() {
          gridEditor.style.gridTemplateColumns = 'repeat(' + template.layout.grid.cols + ', minmax(0, 1fr))';
          gridEditor.innerHTML = '';
          for (let y = 0; y < template.layout.grid.rows; y += 1) {
            for (let x = 0; x < template.layout.grid.cols; x += 1) {
              const owner = paneAtCell(x, y);
              const key = x + ':' + y;
              const cell = document.createElement('button');
              cell.type = 'button';
              const isHidden = hiddenPaneIndexes.has(owner);
              cell.className = 'grid-cell' + (selectedCells.includes(key) ? ' selected' : '') + (isHidden ? ' hidden' : '');
              cell.textContent = owner >= 0 ? (isHidden ? 'H' + (owner + 1) : String(owner + 1)) : '';
              cell.style.background = owner >= 0 ? colorForPane(owner) : 'transparent';
              cell.title =
                owner >= 0
                  ? (template.terminals[owner]?.name || ('Pane ' + (owner + 1))) + (isHidden ? ' (hidden live)' : '')
                  : 'Empty cell';
              cell.addEventListener('click', () => {
                if (selectedCells.includes(key)) {
                  selectedCells = selectedCells.filter((value) => value !== key);
                } else {
                  selectedCells = [...selectedCells, key];
                }
                document.getElementById('mergeSelection').disabled = !canMergeSelection();
                document.getElementById('splitSelection').disabled = !canSplitSelection();
                renderGridEditor();
              });
              gridEditor.appendChild(cell);
            }
          }
          document.getElementById('mergeSelection').disabled = !canMergeSelection();
          document.getElementById('splitSelection').disabled = !canSplitSelection();
        }

        function renderPanes() {
          panesRoot.innerHTML = template.terminals.map((pane, index) => [
            '<div class="pane-card">',
              '<div class="pane-title">Pane ' + (index + 1) + '</div>',
              '<div class="pane-meta">' + (hiddenPaneIndexes.has(index) ? 'Hidden in the running workspace right now.' : 'Visible in the running workspace.') + '</div>',
              '<label>Name<input data-pane="' + index + '" data-field="name" value="' + escapeHtml(pane.name || ('Pane ' + (index + 1))) + '" /></label>',
              '<label>Startup command<input data-pane="' + index + '" data-field="startupCommand" value="' + escapeHtml(pane.startupCommand || '') + '" placeholder="Leave empty for a plain shell" /></label>',
              '<label>Working directory<input data-pane="' + index + '" data-field="cwd" value="' + escapeHtml(pane.cwd || workspaceToken) + '" placeholder="' + workspaceToken + '" /></label>',
              (state.canUseLivePaneActions && !hiddenPaneIndexes.has(index) ? '<button class="secondary" data-hide-pane="' + index + '">Hide Now</button>' : ''),
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
            '<div class="ghost-pane">' +
              '<div>' + escapeHtml(pane.title || 'Hidden pane') + '</div>' +
              '<div class="muted">' + escapeHtml(pane.currentCommand || 'Plain shell') + '</div>' +
              '<button class="linkish" data-restore-window="' + escapeHtml(pane.windowName) + '">Show Again</button>' +
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
              layout: {
                kind: 'grid',
                grid: {
                  rows: template.layout.grid.rows,
                  cols: template.layout.grid.cols,
                  areas: sortAreas(template.layout.grid.areas)
                }
              },
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

        gridRows.addEventListener('change', () => {
          applyUniformSize(Number(gridRows.value), Number(gridCols.value));
        });

        gridCols.addEventListener('change', () => {
          applyUniformSize(Number(gridRows.value), Number(gridCols.value));
        });

        document.getElementById('newSetup').addEventListener('click', () => {
          showNewSetupForm = true;
          const form = document.getElementById('newSetupForm');
          if (form) {
            form.style.display = '';
            const nameInput = document.getElementById('newSetupName');
            if (nameInput) nameInput.focus();
          }
        });

        document.getElementById('confirmNewSetup').addEventListener('click', () => {
          const nameInput = document.getElementById('newSetupName');
          const profileName = (nameInput ? nameInput.value : '').trim();
          if (!profileName) return;
          pendingNewSetupName = profileName;
          vscode.postMessage({ type: 'saveAsNewProfile', payload: { profileName, ...currentPayload(), createWorkspace: false } });
        });

        document.getElementById('cancelNewSetup').addEventListener('click', () => {
          showNewSetupForm = false;
          pendingNewSetupName = '';
          const form = document.getElementById('newSetupForm');
          if (form) form.style.display = 'none';
        });

        document.getElementById('saveOnly').addEventListener('click', () => {
          vscode.postMessage({ type: 'saveActiveSetup', payload: { setupId: state.activeSetupId, ...currentPayload(), createWorkspace: false } });
        });

        document.getElementById('saveAndCreate').addEventListener('click', () => {
          vscode.postMessage({ type: 'saveActiveSetup', payload: { setupId: state.activeSetupId, ...currentPayload(), createWorkspace: true } });
        });

        const deleteProfileBtn = document.getElementById('deleteProfile');
        if (deleteProfileBtn) {
          deleteProfileBtn.addEventListener('click', () => {
            const profileName = state.activeSetupId.replace('profile:', '');
            if (!window.confirm('Delete setup "' + profileName + '"?')) {
              return;
            }
            vscode.postMessage({ type: 'deleteProfile', payload: { profileName } });
          });
        }

        document.getElementById('applyBulkStartup').addEventListener('click', () => {
          const value = document.getElementById('bulkStartup').value || '';
          template.terminals = template.terminals.map((pane) => ({ ...pane, startupCommand: value }));
          renderPanes();
        });

        document.getElementById('sendBroadcast').addEventListener('click', () => {
          const command = (document.getElementById('broadcastCommand').value || '').trim();
          if (!command) {
            return;
          }
          vscode.postMessage({ type: 'broadcastCommand', payload: { command } });
        });

        const liveLayoutButton = document.getElementById('applyWorkspaceDraft');
        if (liveLayoutButton) {
          liveLayoutButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'applyWorkspaceDraft', payload: { template: currentPayload().template } });
          });
        }

        document.getElementById('mergeSelection').addEventListener('click', () => {
          const rect = selectedRectangle();
          if (!rect || !canMergeSelection()) {
            return;
          }

          const nextAreas = template.layout.grid.areas.filter((area) => {
            const overlaps = !(area.x + area.width <= rect.x || area.x >= rect.x + rect.width || area.y + area.height <= rect.y || area.y >= rect.y + rect.height);
            return !overlaps;
          });
          nextAreas.push(rect);
          applyGrid({
            rows: template.layout.grid.rows,
            cols: template.layout.grid.cols,
            areas: nextAreas
          });
        });

        document.getElementById('splitSelection').addEventListener('click', () => {
          if (!canSplitSelection()) {
            return;
          }

          const owners = [...new Set(selectedCellObjects().map((cell) => paneAtCell(cell.x, cell.y)))];
          const owner = owners[0];
          const targetArea = template.layout.grid.areas[owner];
          const nextAreas = template.layout.grid.areas.filter((_, index) => index !== owner);
          for (let y = targetArea.y; y < targetArea.y + targetArea.height; y += 1) {
            for (let x = targetArea.x; x < targetArea.x + targetArea.width; x += 1) {
              nextAreas.push({ x, y, width: 1, height: 1 });
            }
          }
          applyGrid({
            rows: template.layout.grid.rows,
            cols: template.layout.grid.cols,
            areas: nextAreas
          });
        });

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

        ensurePaneCount(template.layout.grid.areas.length);
        renderShapeStarters();
        renderGridEditor();
        renderPanes();
        renderHiddenPanes();
      }

      function buildSizeOptions(selected) {
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
