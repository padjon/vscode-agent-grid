#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const vsixName = `${packageJson.name}-${packageJson.version}.vsix`;
const vsixPath = path.join(repoRoot, vsixName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: options.env ?? process.env,
    shell: false
  });

  return result.status ?? 1;
}

function isStaleIpcHook(value) {
  return typeof value === 'string' && value.length > 0 && !fs.existsSync(value);
}

function buildInstallEnv() {
  const env = { ...process.env };
  if (isStaleIpcHook(env.VSCODE_IPC_HOOK_CLI)) {
    delete env.VSCODE_IPC_HOOK_CLI;
  }
  return env;
}

function findCodeServerBinary() {
  const vscodeServerRoot = path.join(os.homedir(), '.vscode-server', 'bin');
  if (!fs.existsSync(vscodeServerRoot)) {
    return undefined;
  }

  const entries = fs
    .readdirSync(vscodeServerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      binary: path.join(vscodeServerRoot, entry.name, 'bin', 'code-server'),
      mtimeMs: fs.statSync(path.join(vscodeServerRoot, entry.name)).mtimeMs
    }))
    .filter((entry) => fs.existsSync(entry.binary))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return entries[0]?.binary;
}

if (!fs.existsSync(vsixPath)) {
  console.error(`Expected VSIX not found: ${vsixPath}`);
  process.exit(1);
}

const installArgs = ['--install-extension', vsixPath, '--force'];
let status = run('code', installArgs, { env: buildInstallEnv() });

if (status === 0) {
  process.exit(0);
}

const codeServerBinary = findCodeServerBinary();
if (codeServerBinary) {
  const userDataDir = path.join(os.tmpdir(), 'agent-grid-code-user-data');
  fs.mkdirSync(userDataDir, { recursive: true });

  status = run(
    codeServerBinary,
    [
      '--install-extension',
      vsixPath,
      '--force',
      '--start-server',
      '--accept-server-license-terms',
      '--user-data-dir',
      userDataDir
    ],
    { env: buildInstallEnv() }
  );

  if (status === 0) {
    process.exit(0);
  }
}

console.error('');
console.error('Agent Grid could not install the VSIX into VS Code automatically.');
console.error('Most common cause in WSL: VS Code is not currently reachable from this shell.');
console.error('');
console.error('Try one of these:');
console.error('1. Open this folder in VS Code WSL first, then rerun `npm run install:wsl`.');
console.error(`2. Install manually: code --install-extension "${vsixPath}" --force`);
if (codeServerBinary) {
  console.error(`3. Install with the local VS Code server binary: "${codeServerBinary}" --install-extension "${vsixPath}" --force --start-server --accept-server-license-terms`);
} else {
  console.error('3. If `code` still points at a stale session, start a fresh shell and try again.');
}
process.exit(status);
