import { spawn, type ChildProcessByStdio } from 'child_process';
import { createHash } from 'crypto';
import { mkdir, readFile, readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import type { Readable } from 'stream';
import { SandboxManager } from '../security/sandbox-manager.js';

const ACQUIRED_ROOT = resolve(homedir(), '.nco', 'acquired');
const TMP_ROOT = '/tmp';

export interface AcquisitionInstallSpec {
  packageName: string;
  version: string;
}

export interface AcquisitionInstallResult {
  installDir: string;
  packageDir: string;
  packageSha256: string;
}

export interface AcquisitionInstallerDeps {
  spawnImpl?: typeof spawn;
}

export function buildInstallCommand(installDir: string, spec: AcquisitionInstallSpec): { command: string; args: string[] } {
  return {
    command: 'npm',
    args: [
      'install',
      '--ignore-scripts',
      '--no-save',
      '--prefix',
      installDir,
      `${spec.packageName}@${spec.version}`,
    ],
  };
}

export async function installAcquiredPackage(
  spec: AcquisitionInstallSpec,
  deps: AcquisitionInstallerDeps = {},
): Promise<AcquisitionInstallResult> {
  const sandbox = createAcquisitionSandbox();
  const installDir = resolve(ACQUIRED_ROOT, sanitizeSegment(`${spec.packageName}@${spec.version}`));
  const packageDir = resolve(installDir, 'node_modules', spec.packageName);
  const { command, args } = buildInstallCommand(installDir, spec);

  sandbox.assertCommand(command, args);
  sandbox.assertPath(installDir);
  await mkdir(installDir, { recursive: true });

  const spawnImpl = deps.spawnImpl ?? spawn;
  const release = await sandbox.acquireSlot();
  try {
    const child = spawnImpl(command, args, {
      cwd: TMP_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      signal: AbortSignal.timeout(sandbox.getTimeout()),
    });
    const result = await waitForExitWithTimeout(child, sandbox.getTimeout());
    if (result.timedOut || result.code !== 0) {
      sandbox.recordFailure(result.stderr || result.stdout || 'npm install failed');
      throw new Error((result.stderr || result.stdout || 'npm install failed').slice(0, 2000));
    }

    const packageSha256 = await hashDirectory(packageDir);
    sandbox.recordSuccess();
    return { installDir, packageDir, packageSha256 };
  } finally {
    release();
  }
}

function createAcquisitionSandbox(): SandboxManager {
  return new SandboxManager({
    agentId: 'acquisition-installer',
    paths: {
      allowedPaths: [ACQUIRED_ROOT, TMP_ROOT],
      deniedPaths: ['/etc', '/usr', '/var'],
    },
    commands: {
      allowedCommands: ['npm'],
      deniedCommands: [],
    },
    resources: {
      maxConcurrentActions: 1,
      maxExecutionTime: 120_000,
    },
  });
}

async function waitForExitWithTimeout(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.on('data', (chunk: Buffer | string) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += chunk.toString(); });

  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.once('error', err => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.once('close', code => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

async function hashDirectory(dir: string): Promise<string> {
  const hash = createHash('sha256');
  await hashDirectoryEntry(dir, hash);
  return hash.digest('hex');
}

async function hashDirectoryEntry(entryPath: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const entryStat = await stat(entryPath);
  if (entryStat.isDirectory()) {
    hash.update(`dir:${basename(entryPath)}`);
    const names = await readdir(entryPath);
    names.sort();
    for (const name of names) {
      await hashDirectoryEntry(join(entryPath, name), hash);
    }
    return;
  }

  hash.update(`file:${basename(entryPath)}:${entryStat.size}`);
  hash.update(await readFile(entryPath));
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
}
