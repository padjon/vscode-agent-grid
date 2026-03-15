export type PresetLayoutName = 'tiled' | 'even-horizontal' | 'even-vertical' | 'main-horizontal' | 'main-vertical';

export interface GridPaneArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridLayout {
  rows: number;
  cols: number;
  areas: GridPaneArea[];
}

export type WorkspaceLayout =
  | {
      kind: 'preset';
      preset: PresetLayoutName;
      grid: GridLayout;
    }
  | {
      kind: 'grid';
      grid: GridLayout;
    };

export interface TerminalDefinition {
  name: string;
  startupCommand: string;
  cwd?: string;
}

export interface WorkspaceSession {
  tmuxCommand: string;
  sessionName: string;
  windowName: string;
  layout: WorkspaceLayout;
  terminals: TerminalDefinition[];
}

export interface WorkspaceProfile {
  name: string;
  layout: WorkspaceLayout;
  terminals: TerminalDefinition[];
}

export interface RepoConfig {
  tmuxCommand?: string;
  layout?: PresetLayoutName;
  grid?: GridLayout;
  terminals?: TerminalDefinition[];
  profiles?: WorkspaceProfile[];
}

export interface SettingsLayerConfig {
  tmuxCommand?: string;
  layout?: unknown;
  grid?: unknown;
  terminals?: unknown[];
  profiles?: unknown[];
}

export type ConfigLayerSource = 'workspace' | 'repo' | 'user' | 'default' | 'none';

export interface EffectiveConfigLayers {
  tmuxCommand: ConfigLayerSource;
  layout: ConfigLayerSource;
  terminals: ConfigLayerSource;
  profiles: ConfigLayerSource;
}

export interface EffectiveWorkspaceConfig {
  tmuxCommand: string;
  layout: WorkspaceLayout;
  terminals: TerminalDefinition[];
  profiles: WorkspaceProfile[];
  layers: EffectiveConfigLayers;
}

export interface SupportBundlePane {
  name: string;
  cwd?: string;
  startupCommand: string;
}

export interface SupportBundleLivePane {
  index: number;
  active: boolean;
  title: string;
  currentCommand: string;
  currentPath?: string;
}

export interface SupportBundleInput {
  generatedAt: string;
  extensionVersion: string;
  vscodeVersion: string;
  runtime: string;
  platform: string;
  workspaceRoot?: string;
  repoConfigPath?: string;
  repoConfigState: string;
  environmentState: string;
  environmentDetail: string;
  terminalOpen: boolean;
  detachedTmuxSession: boolean;
  effectiveTmuxCommand: string;
  effectiveLayout: string;
  effectivePanes: SupportBundlePane[];
  effectiveConfigSource: string;
  activeSetup: string;
  livePanes: SupportBundleLivePane[];
  repoConfig: RepoConfig;
  safeForPublic: boolean;
}

export const DEFAULT_TERMINALS: TerminalDefinition[] = [
  { name: 'Agent 1', startupCommand: '', cwd: '${workspaceFolder}' },
  { name: 'Agent 2', startupCommand: '', cwd: '${workspaceFolder}' },
  { name: 'Agent 3', startupCommand: '', cwd: '${workspaceFolder}' },
  { name: 'Agent 4', startupCommand: '', cwd: '${workspaceFolder}' }
];

interface LeafArea extends GridPaneArea {
  terminalIndex: number;
}

interface LayoutLeaf {
  kind: 'leaf';
  area: LeafArea;
}

interface LayoutSplit {
  kind: 'split';
  axis: 'vertical' | 'horizontal';
  first: LayoutTree;
  second: LayoutTree;
  firstSpan: number;
  secondSpan: number;
}

type LayoutTree = LayoutLeaf | LayoutSplit;

export interface TmuxLayoutLeaf {
  kind: 'leaf';
  terminalIndex: number;
  area: GridPaneArea;
}

export interface TmuxLayoutSplit {
  kind: 'split';
  axis: 'vertical' | 'horizontal';
  first: TmuxLayoutPlan;
  second: TmuxLayoutPlan;
  firstSpan: number;
  secondSpan: number;
}

export type TmuxLayoutPlan = TmuxLayoutLeaf | TmuxLayoutSplit;

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
  const terminals = normalizeTerminalsForLayout(session.terminals, session.layout.grid.areas.length);
  const layoutTree = buildLayoutTree(session.layout.grid);
  const lines: string[] = [`TMUX_BIN=${tmuxCommand}`, '$TMUX_BIN start-server >/dev/null 2>&1 || true'];

  if (recreate) {
    lines.push(`$TMUX_BIN kill-session -t ${sessionName} >/dev/null 2>&1 || true`);
  }

  lines.push(`if ! $TMUX_BIN has-session -t ${sessionName} >/dev/null 2>&1; then`);

  const baseCwd = resolveCwd(terminals[0]?.cwd) ?? fallbackCwd;
  lines.push(`  $TMUX_BIN new-session -d -s ${sessionName} -n ${windowName} -c ${shellQuote(baseCwd)}`);
  lines.push(`  pane_0="$($TMUX_BIN display-message -p -t ${sessionName}:${windowName}.0 '#{pane_id}')"`);

  const layoutResult = buildLayoutShell(layoutTree, 'pane_0', 1, terminals, resolveCwd, fallbackCwd);
  lines.push(...layoutResult.lines);

  for (const [terminalIndex, paneVar] of layoutResult.leafVars.entries()) {
    const terminal = terminals[terminalIndex];
    const target = `"$${paneVar}"`;
    if (terminal.name.trim()) {
      lines.push(`  $TMUX_BIN select-pane -t ${target} -T ${shellQuote(expandVariables(terminal.name))}`);
    }

    const startupCommand = expandVariables(terminal.startupCommand).trim();
    if (startupCommand) {
      lines.push(`  $TMUX_BIN send-keys -t ${target} ${shellQuote(startupCommand)} C-m`);
    }
  }

  lines.push('fi', `$TMUX_BIN attach-session -t ${sessionName}`);
  return lines.join('\n');
}

export function buildDefaultTerminal(index: number): TerminalDefinition {
  return {
    name: `Agent ${index}`,
    startupCommand: '',
    cwd: '${workspaceFolder}'
  };
}

export function readLayoutName(value: unknown): PresetLayoutName | undefined {
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

export function normalizeGridLayout(value: unknown): GridLayout | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rows = readPositiveInteger(value.rows);
  const cols = readPositiveInteger(value.cols);
  const rawAreas = Array.isArray(value.areas) ? value.areas : undefined;
  if (!rows || !cols || !rawAreas || rawAreas.length === 0) {
    return undefined;
  }

  const areas = rawAreas
    .map((raw) => {
      if (!isRecord(raw)) {
        return undefined;
      }

      const x = readNonNegativeInteger(raw.x);
      const y = readNonNegativeInteger(raw.y);
      const width = readPositiveInteger(raw.width);
      const height = readPositiveInteger(raw.height);
      if (x === undefined || y === undefined || !width || !height) {
        return undefined;
      }

      return { x, y, width, height };
    })
    .filter((area): area is GridPaneArea => Boolean(area));

  if (areas.length === 0 || areas.length > 8) {
    return undefined;
  }

  const normalized: GridLayout = {
    rows,
    cols,
    areas: sortGridAreas(areas)
  };

  return validateGridCoverage(normalized) ? normalized : undefined;
}

export function buildPresetGridLayout(preset: PresetLayoutName, paneCount: number): GridLayout {
  const count = Math.max(1, Math.min(8, paneCount));

  if (preset === 'even-horizontal') {
    return createUniformGrid(1, count);
  }

  if (preset === 'even-vertical') {
    return createUniformGrid(count, 1);
  }

  if (preset === 'main-horizontal') {
    if (count === 1) {
      return createUniformGrid(1, 1);
    }

    const cols = Math.max(1, count - 1);
    const areas: GridPaneArea[] = [{ x: 0, y: 0, width: cols, height: 1 }];
    for (let index = 0; index < count - 1; index += 1) {
      areas.push({ x: index, y: 1, width: 1, height: 1 });
    }
    return { rows: 2, cols, areas };
  }

  if (preset === 'main-vertical') {
    if (count === 1) {
      return createUniformGrid(1, 1);
    }

    const rows = Math.max(1, count - 1);
    const areas: GridPaneArea[] = [{ x: 0, y: 0, width: 1, height: rows }];
    for (let index = 0; index < count - 1; index += 1) {
      areas.push({ x: 1, y: index, width: 1, height: 1 });
    }
    return { rows, cols: 2, areas };
  }

  const baseCols = Math.ceil(Math.sqrt(count));
  const baseRows = Math.ceil(count / baseCols);
  let areas = createUniformGrid(baseRows, baseCols).areas;
  while (areas.length > count) {
    const merged = tryMergeTrailingAreas(areas);
    if (!merged) {
      break;
    }
    areas = merged;
  }
  return { rows: baseRows, cols: baseCols, areas: sortGridAreas(areas) };
}

export function normalizeWorkspaceLayout(layout: unknown, grid: unknown, paneCount: number): WorkspaceLayout {
  const normalizedGrid = normalizeGridLayout(grid);
  if (normalizedGrid) {
    return {
      kind: 'grid',
      grid: normalizedGrid
    };
  }

  const preset = readLayoutName(layout) ?? 'tiled';
  return {
    kind: 'preset',
    preset,
    grid: buildPresetGridLayout(preset, paneCount)
  };
}

export function describeWorkspaceLayout(layout: WorkspaceLayout): string {
  if (layout.kind === 'preset') {
    return `${layout.preset} starter (${layout.grid.rows}x${layout.grid.cols} grid)`;
  }

  return `custom ${layout.grid.rows}x${layout.grid.cols} grid`;
}

export function getLayoutPaneCount(layout: WorkspaceLayout): number {
  return layout.grid.areas.length;
}

export function buildTmuxLayoutPlan(layout: WorkspaceLayout): TmuxLayoutPlan {
  return convertTreeToPlan(buildLayoutTree(layout.grid));
}

export function sortGridAreas(areas: GridPaneArea[]): GridPaneArea[] {
  return [...areas].sort((left, right) => {
    if (left.y !== right.y) {
      return left.y - right.y;
    }
    if (left.x !== right.x) {
      return left.x - right.x;
    }
    if (left.height !== right.height) {
      return right.height - left.height;
    }
    return right.width - left.width;
  });
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
    const rawTerminals = Array.isArray(value.terminals) ? value.terminals : undefined;

    if (!name || !rawTerminals || rawTerminals.length === 0) {
      continue;
    }

    const terminals = normalizeTerminalDefinitions(rawTerminals);

    profiles.push({
      name,
      layout: normalizeWorkspaceLayout(value.layout, value.grid, terminals.length),
      terminals: normalizeTerminalsForLayout(terminals, normalizeWorkspaceLayout(value.layout, value.grid, terminals.length).grid.areas.length)
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
  const grid = normalizeGridLayout(parsed.grid);
  const terminals = Array.isArray(parsed.terminals) ? normalizeTerminalDefinitions(parsed.terminals) : undefined;
  const profiles = Array.isArray(parsed.profiles) ? normalizeProfiles(parsed.profiles) : undefined;

  return {
    tmuxCommand,
    layout,
    grid,
    terminals,
    profiles
  };
}

export function resolveEffectiveWorkspaceConfig(layers: {
  workspace: SettingsLayerConfig;
  repo?: RepoConfig;
  user: SettingsLayerConfig;
}): EffectiveWorkspaceConfig {
  const workspaceTmux = readTrimmedString(layers.workspace.tmuxCommand);
  const repoTmux = layers.repo?.tmuxCommand;
  const userTmux = readTrimmedString(layers.user.tmuxCommand);

  const workspaceTerminals = normalizeTerminalOverride(layers.workspace.terminals);
  const repoTerminals = normalizeTerminalOverride(layers.repo?.terminals);
  const userTerminals = normalizeTerminalOverride(layers.user.terminals);

  const terminals = workspaceTerminals ?? repoTerminals ?? userTerminals ?? DEFAULT_TERMINALS;

  const workspaceLayout = normalizeLayoutOverride(layers.workspace.layout, layers.workspace.grid, terminals.length);
  const repoLayout = normalizeLayoutOverride(layers.repo?.layout, layers.repo?.grid, terminals.length);
  const userLayout = normalizeLayoutOverride(layers.user.layout, layers.user.grid, terminals.length);

  const workspaceProfiles = normalizeProfileOverride(layers.workspace.profiles);
  const repoProfiles = normalizeProfileOverride(layers.repo?.profiles);
  const userProfiles = normalizeProfileOverride(layers.user.profiles);

  const tmuxCommand = workspaceTmux ?? repoTmux ?? userTmux ?? 'tmux';
  const layout = workspaceLayout ?? repoLayout ?? userLayout ?? normalizeWorkspaceLayout('tiled', undefined, terminals.length);
  const profiles = mergeProfiles(mergeProfiles(userProfiles ?? [], repoProfiles ?? []), workspaceProfiles ?? []);

  return {
    tmuxCommand,
    layout,
    terminals: normalizeTerminalsForLayout(terminals, layout.grid.areas.length),
    profiles,
    layers: {
      tmuxCommand: workspaceTmux ? 'workspace' : repoTmux ? 'repo' : userTmux ? 'user' : 'default',
      layout: workspaceLayout ? 'workspace' : repoLayout ? 'repo' : userLayout ? 'user' : 'default',
      terminals: workspaceTerminals ? 'workspace' : repoTerminals ? 'repo' : userTerminals ? 'user' : 'default',
      profiles: workspaceProfiles ? 'workspace' : repoProfiles ? 'repo' : userProfiles ? 'user' : 'none'
    }
  };
}

export function describeEffectiveConfigLayers(layers: EffectiveConfigLayers): string {
  const activeSources = new Set<ConfigLayerSource>(
    [layers.tmuxCommand, layers.layout, layers.terminals, layers.profiles].filter(
      (source): source is ConfigLayerSource => source !== 'none' && source !== 'default'
    )
  );

  if (activeSources.size === 0) {
    return 'defaults';
  }

  const ordered = ['repo', 'workspace', 'user'].filter((source) => activeSources.has(source as ConfigLayerSource));
  const labels = ordered.map((source) => {
    if (source === 'workspace') {
      return 'workspace overrides';
    }

    if (source === 'repo') {
      return 'repo config';
    }

    return 'user settings';
  });

  return labels.join(' + ');
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

export function redactPathForPublicReport(value: string | undefined, workspaceRoot?: string): string | undefined {
  if (!value) {
    return value;
  }

  if (workspaceRoot && value === workspaceRoot) {
    return '<workspace>';
  }

  if (workspaceRoot && value.startsWith(`${workspaceRoot}${pathSeparator(value)}`)) {
    return `<workspace>${value.slice(workspaceRoot.length)}`;
  }

  if (value.startsWith('/')) {
    return redactUnixPath(value);
  }

  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return redactWindowsPath(value);
  }

  return value;
}

export function buildSupportBundleMarkdown(input: SupportBundleInput): string {
  const workspaceRoot = input.safeForPublic ? redactPathForPublicReport(input.workspaceRoot, input.workspaceRoot) : input.workspaceRoot;
  const repoConfigPath = input.safeForPublic
    ? redactPathForPublicReport(input.repoConfigPath, input.workspaceRoot)
    : input.repoConfigPath;
  const tmuxCommand = input.safeForPublic
    ? redactPathForPublicReport(input.effectiveTmuxCommand, input.workspaceRoot)
    : input.effectiveTmuxCommand;

  return [
    '# Agent Grid Support Bundle',
    '',
    `Generated: ${input.generatedAt}`,
    `Mode: ${input.safeForPublic ? 'Safe for public issue' : 'Full detail'}`,
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
    `- Extension version: ${input.extensionVersion}`,
    `- VS Code version: ${input.vscodeVersion}`,
    `- Runtime: ${input.runtime}`,
    `- Platform: ${input.platform}`,
    `- Workspace root: ${workspaceRoot ?? '(none)'}`,
    `- Repo config path: ${repoConfigPath ?? '(none)'}`,
    `- Repo config state: ${input.repoConfigState}`,
    '',
    '## Agent Grid State',
    '',
    `- Environment state: ${input.environmentState}`,
    `- Environment detail: ${input.environmentDetail}`,
    `- Terminal open: ${input.terminalOpen ? 'yes' : 'no'}`,
    `- Detached tmux session: ${input.detachedTmuxSession ? 'yes' : 'no'}`,
    `- Effective config source: ${input.effectiveConfigSource}`,
    `- Active setup: ${input.activeSetup}`,
    `- Effective tmux command: ${tmuxCommand}`,
    `- Effective layout: ${input.effectiveLayout}`,
    `- Effective panes: ${input.effectivePanes.length}`,
    '',
    '## Effective Panes',
    '',
    ...input.effectivePanes.map((pane, index) => {
      const cwd = input.safeForPublic ? redactPathForPublicReport(pane.cwd, input.workspaceRoot) : pane.cwd;
      const startup = pane.startupCommand.trim() || '(none)';
      return `- Pane ${index + 1}: name="${pane.name}" cwd="${cwd ?? '(default)'}" startup="${startup}"`;
    }),
    '',
    '## Live Panes',
    '',
    ...(input.livePanes.length > 0
      ? input.livePanes.map((pane) => {
          const currentPath = input.safeForPublic
            ? redactPathForPublicReport(pane.currentPath, input.workspaceRoot)
            : pane.currentPath;
          return `- Pane ${pane.index + 1}: active=${pane.active ? 'yes' : 'no'} title="${pane.title}" command="${pane.currentCommand}" cwd="${currentPath ?? '(unknown)'}"`;
        })
      : ['- No live pane state available']),
    '',
    '## Repo Config JSON',
    '',
    '```json',
    JSON.stringify(input.repoConfig ?? {}, null, 2),
    '```'
  ].join('\n');
}

function buildLayoutShell(
  tree: LayoutTree,
  paneVar: string,
  nextVarIndex: number,
  terminals: TerminalDefinition[],
  resolveCwd: (cwd: string | undefined) => string | undefined,
  fallbackCwd: string
): { lines: string[]; leafVars: Map<number, string>; nextVarIndex: number } {
  if (tree.kind === 'leaf') {
    return {
      lines: [],
      leafVars: new Map([[tree.area.terminalIndex, paneVar]]),
      nextVarIndex
    };
  }

  const secondVar = `pane_${nextVarIndex}`;
  const secondLeaf = findFirstLeaf(tree.second);
  const secondCwd = resolveCwd(terminals[secondLeaf.terminalIndex]?.cwd) ?? fallbackCwd;
  const secondPercent = Math.max(1, Math.round((100 * tree.secondSpan) / (tree.firstSpan + tree.secondSpan)));
  const splitFlag = tree.axis === 'vertical' ? '-h' : '-v';
  const lines = [
    `  ${secondVar}="$($TMUX_BIN split-window -P -F '#{pane_id}' ${splitFlag} -l '${secondPercent}%' -t "$${paneVar}" -c ${shellQuote(secondCwd)})"`
  ];

  const firstResult = buildLayoutShell(tree.first, paneVar, nextVarIndex + 1, terminals, resolveCwd, fallbackCwd);
  const secondResult = buildLayoutShell(
    tree.second,
    secondVar,
    firstResult.nextVarIndex,
    terminals,
    resolveCwd,
    fallbackCwd
  );

  return {
    lines: [...lines, ...firstResult.lines, ...secondResult.lines],
    leafVars: new Map([...firstResult.leafVars.entries(), ...secondResult.leafVars.entries()]),
    nextVarIndex: secondResult.nextVarIndex
  };
}

function buildLayoutTree(grid: GridLayout): LayoutTree {
  const orderedAreas = sortGridAreas(grid.areas).map((area, index) => ({
    ...area,
    terminalIndex: index
  }));

  return buildTreeFromAreas(orderedAreas);
}

function buildTreeFromAreas(areas: LeafArea[]): LayoutTree {
  if (areas.length === 1) {
    return {
      kind: 'leaf',
      area: areas[0]
    };
  }

  const bounds = getBounds(areas);

  for (let cut = 1; cut < bounds.width; cut += 1) {
    const splitX = bounds.x + cut;
    const left = areas.filter((area) => area.x + area.width <= splitX);
    const right = areas.filter((area) => area.x >= splitX);
    if (left.length === 0 || right.length === 0 || left.length + right.length !== areas.length) {
      continue;
    }
    if (areas.some((area) => area.x < splitX && area.x + area.width > splitX)) {
      continue;
    }

    return {
      kind: 'split',
      axis: 'vertical',
      first: buildTreeFromAreas(left),
      second: buildTreeFromAreas(right),
      firstSpan: cut,
      secondSpan: bounds.width - cut
    };
  }

  for (let cut = 1; cut < bounds.height; cut += 1) {
    const splitY = bounds.y + cut;
    const top = areas.filter((area) => area.y + area.height <= splitY);
    const bottom = areas.filter((area) => area.y >= splitY);
    if (top.length === 0 || bottom.length === 0 || top.length + bottom.length !== areas.length) {
      continue;
    }
    if (areas.some((area) => area.y < splitY && area.y + area.height > splitY)) {
      continue;
    }

    return {
      kind: 'split',
      axis: 'horizontal',
      first: buildTreeFromAreas(top),
      second: buildTreeFromAreas(bottom),
      firstSpan: cut,
      secondSpan: bounds.height - cut
    };
  }

  throw new Error('Grid layout could not be converted into tmux split operations.');
}

function convertTreeToPlan(tree: LayoutTree): TmuxLayoutPlan {
  if (tree.kind === 'leaf') {
    return {
      kind: 'leaf',
      terminalIndex: tree.area.terminalIndex,
      area: {
        x: tree.area.x,
        y: tree.area.y,
        width: tree.area.width,
        height: tree.area.height
      }
    };
  }

  return {
    kind: 'split',
    axis: tree.axis,
    first: convertTreeToPlan(tree.first),
    second: convertTreeToPlan(tree.second),
    firstSpan: tree.firstSpan,
    secondSpan: tree.secondSpan
  };
}

function createUniformGrid(rows: number, cols: number): GridLayout {
  const areas: GridPaneArea[] = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      areas.push({ x, y, width: 1, height: 1 });
    }
  }
  return {
    rows,
    cols,
    areas
  };
}

function tryMergeTrailingAreas(areas: GridPaneArea[]): GridPaneArea[] | undefined {
  const sorted = sortGridAreas(areas);
  for (let index = sorted.length - 1; index > 0; index -= 1) {
    const first = sorted[index - 1];
    const second = sorted[index];
    const merged = tryMergePair(first, second);
    if (!merged) {
      continue;
    }

    const next = [...sorted];
    next.splice(index - 1, 2, merged);
    return sortGridAreas(next);
  }

  return undefined;
}

function tryMergePair(first: GridPaneArea, second: GridPaneArea): GridPaneArea | undefined {
  if (first.y === second.y && first.height === second.height && first.x + first.width === second.x) {
    return {
      x: first.x,
      y: first.y,
      width: first.width + second.width,
      height: first.height
    };
  }

  if (first.x === second.x && first.width === second.width && first.y + first.height === second.y) {
    return {
      x: first.x,
      y: first.y,
      width: first.width,
      height: first.height + second.height
    };
  }

  return undefined;
}

function validateGridCoverage(grid: GridLayout): boolean {
  const covered = new Set<string>();

  for (const area of grid.areas) {
    if (area.x < 0 || area.y < 0 || area.width <= 0 || area.height <= 0) {
      return false;
    }
    if (area.x + area.width > grid.cols || area.y + area.height > grid.rows) {
      return false;
    }

    for (let y = area.y; y < area.y + area.height; y += 1) {
      for (let x = area.x; x < area.x + area.width; x += 1) {
        const key = `${x}:${y}`;
        if (covered.has(key)) {
          return false;
        }
        covered.add(key);
      }
    }
  }

  return covered.size === grid.rows * grid.cols;
}

function normalizeLayoutOverride(layout: unknown, grid: unknown, paneCount: number): WorkspaceLayout | undefined {
  if (layout === undefined && grid === undefined) {
    return undefined;
  }

  return normalizeWorkspaceLayout(layout, grid, paneCount);
}

function normalizeTerminalOverride(values: unknown[] | TerminalDefinition[] | undefined): TerminalDefinition[] | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }

  return normalizeTerminalDefinitions(values);
}

function normalizeProfileOverride(values: unknown[] | WorkspaceProfile[] | undefined): WorkspaceProfile[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  return normalizeProfiles(values);
}

function normalizeTerminalsForLayout(terminals: TerminalDefinition[], paneCount: number): TerminalDefinition[] {
  const normalized = normalizeTerminalDefinitions(terminals);
  const adjusted = normalized.slice(0, paneCount);

  while (adjusted.length < paneCount) {
    adjusted.push(buildDefaultTerminal(adjusted.length + 1));
  }

  return adjusted;
}

function findFirstLeaf(tree: LayoutTree): LeafArea {
  return tree.kind === 'leaf' ? tree.area : findFirstLeaf(tree.first);
}

function getBounds(areas: LeafArea[]): GridPaneArea {
  const minX = Math.min(...areas.map((area) => area.x));
  const minY = Math.min(...areas.map((area) => area.y));
  const maxX = Math.max(...areas.map((area) => area.x + area.width));
  const maxY = Math.max(...areas.map((area) => area.y + area.height));
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
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

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function redactUnixPath(value: string): string {
  const segments = value.split('/').filter(Boolean);
  if (segments.length === 0) {
    return value;
  }

  if (segments[0] === 'home' && segments.length >= 2) {
    return `~/.../${segments.at(-1)}`;
  }

  return `/.../${segments.at(-1)}`;
}

function redactWindowsPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) {
    return value;
  }

  return `${parts[0]}\\...\\${parts.at(-1)}`;
}

function pathSeparator(value: string): string {
  return value.includes('\\') ? '\\' : '/';
}
