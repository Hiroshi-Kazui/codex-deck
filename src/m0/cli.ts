import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';

export const REQUIRED_CODEX_VERSION = '0.154.0';

export type Cli = Readonly<{ executable: string; version: string }>;

export class CliError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CliError';
  }
}

export type ResolveOptions = {
  explicitPath?: string;
  pathEnv?: string;
  expectedVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  probe?: (executable: string) => Promise<string>;
};

function target(platform: NodeJS.Platform, arch: string): { triple: string; packageName: string } {
  const triples: Record<string, { triple: string; packageName: string }> = {
    'win32-x64': { triple: 'x86_64-pc-windows-msvc', packageName: 'codex-win32-x64' },
    'win32-arm64': { triple: 'aarch64-pc-windows-msvc', packageName: 'codex-win32-arm64' },
  };
  const result = triples[`${platform}-${arch}`];
  if (!result) throw new CliError(`Unsupported Codex platform: ${platform}/${arch}`);
  return result;
}

function executablesFromCandidate(candidate: string, platform: NodeJS.Platform, arch: string): string[] {
  const resolved = path.resolve(candidate);
  const base = path.basename(resolved).toLowerCase();
  if (base === 'codex.exe') return [resolved];
  if (base === 'codex.cmd' || base === 'codex.ps1' || base === 'codex') {
    const { triple, packageName } = target(platform, arch);
    const root = path.dirname(resolved);
    return [
      path.join(root, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', packageName,
        'vendor', triple, 'bin', 'codex.exe'),
      path.join(root, 'node_modules', '@openai', packageName, 'vendor', triple, 'bin', 'codex.exe'),
      path.join(root, 'node_modules', '@openai', 'codex', 'vendor', triple, 'bin', 'codex.exe'),
    ];
  }
  throw new CliError(`Codex path must identify codex.exe or a Codex npm shim: ${resolved}`);
}

export async function probeVersion(executable: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = '';
    let error = '';
    let settled = false;
    const child = spawn(executable, ['--version'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill();
      finish(new CliError(`Codex version check timed out: ${executable}`));
    }, 5000);
    function finish(failure?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve(output.trim());
    }
    child.stdout.on('data', (data: Buffer) => { output += data.toString('utf8'); });
    child.stderr.on('data', (data: Buffer) => { error += data.toString('utf8'); });
    child.once('error', (cause) => finish(new CliError(`Cannot start Codex: ${executable}: ${cause.message}`, { cause })));
    child.once('close', (code) => finish(code === 0 ? undefined : new CliError(`Codex version check failed (${code}): ${error.trim()}`)));
  });
}

export async function resolveCodex(options: ResolveOptions = {}): Promise<Cli> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  target(platform, arch);
  const expected = options.expectedVersion ?? REQUIRED_CODEX_VERSION;
  const candidates = options.explicitPath
    ? [options.explicitPath]
    : (options.pathEnv ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
        .flatMap((directory) => ['codex.exe', 'codex.cmd'].map((file) => path.join(directory, file)));
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      for (const executable of executablesFromCandidate(candidate, platform, arch)) {
        try {
          await access(executable, constants.R_OK);
          const canonical = await realpath(executable);
          const reported = await (options.probe ?? probeVersion)(canonical);
          const version = /^codex-cli (\d+\.\d+\.\d+)$/m.exec(reported)?.[1];
          if (version !== expected) {
            errors.push(`${canonical}: expected ${expected}, got ${reported || 'no version'}`);
            continue;
          }
          return Object.freeze({ executable: canonical, version });
        } catch (cause) { errors.push(`${executable}: ${String(cause)}`); }
      }
    } catch (cause) {
      if (options.explicitPath) throw new CliError(`Unable to resolve Codex CLI: ${String(cause)}`, { cause });
      errors.push(`${candidate}: ${String(cause)}`);
    }
  }
  throw new CliError(`Codex CLI ${expected} was not found. ${errors.slice(-3).join(' | ')}`);
}

export function appServerCommand(cli: Cli, cwd: string): { executable: string; args: string[]; cwd: string } {
  return { executable: cli.executable, args: ['app-server', '--listen', 'stdio://'], cwd: path.resolve(cwd) };
}

export function remoteTuiCommand(cli: Cli, cwd: string, url: string, token: string,
  env: NodeJS.ProcessEnv = process.env): { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const variable = 'CODEX_DECK_REMOTE_TOKEN';
  return { executable: cli.executable, args: ['--remote', url, '--remote-auth-token-env', variable, '-C', path.resolve(cwd)],
    cwd: path.resolve(cwd), env: { ...env, [variable]: token } };
}

export function launchAppServer(cli: Cli, cwd: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const command = appServerCommand(cli, cwd);
  return spawn(command.executable, command.args, {
    cwd: command.cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export type TuiExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null; error?: CliError }>;
export type TuiProcess = Readonly<{ child: ChildProcess; exited: Promise<TuiExit> }>;

export async function launchRemoteTui(cli: Cli, cwd: string, url: string, token: string,
  env: NodeJS.ProcessEnv = process.env): Promise<TuiProcess> {
  const command = remoteTuiCommand(cli, cwd, url, token, env);
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd, env: command.env, windowsHide: true, shell: false, stdio: 'inherit',
  });
  let startupError: CliError | undefined;
  let firstExit: TuiExit | undefined;
  const exited = new Promise<TuiExit>((resolve) => {
    child.once('error', (cause) => {
      const error = new CliError(`TUI launch failed: ${cause.message}`, { cause });
      startupError = error;
      resolve({ code: null, signal: null, error });
    });
    child.once('exit', (code, signal) => {
      firstExit = { code, signal, error: new CliError(`TUI exited during startup (${code ?? signal})`) };
      resolve(firstExit);
    });
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  if (startupError) throw startupError;
  if (firstExit?.error) throw firstExit.error;
  return { child, exited };
}
