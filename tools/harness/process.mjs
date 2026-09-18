// Spawn without shell interpolation; supervise only children owned by this run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export async function resolveCodex(explicit) {
  if (explicit) {
    const full = path.resolve(explicit);
    await fsp.access(full);
    if (/\.(cmd|bat|ps1)$/i.test(full)) throw new Error('Set codexPath to codex.exe or bin/codex.js (shell shims are not executed).');
    return /\.m?js$/i.test(full) ? [process.execPath, full] : [full];
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  for (const dir of [...new Set(dirs.filter(Boolean))]) {
    const binary = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (fs.existsSync(binary)) return [binary];
    const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) {
      if (process.platform === 'win32') {
        const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
        const platformPackage = `codex-win32-${process.arch}`;
        const packages = [path.join(dir, 'node_modules/@openai/codex/node_modules/@openai', platformPackage), path.join(dir, 'node_modules/@openai', platformPackage)];
        for (const pkg of packages) {
          const native = path.join(pkg, 'vendor', `${arch}-pc-windows-msvc`, 'bin/codex.exe');
          if (fs.existsSync(native)) return [native];
        }
      }
      return [process.execPath, js];
    }
  }
  throw new Error('Codex CLI not found. Install/login with the CLI, or set config.codexPath.');
}
export async function resolveCommand(command) {
  if (command[0] === 'node') return [process.execPath, ...command.slice(1)];
  if (command[0] === 'npm') {
    const dirs = [path.dirname(process.execPath), ...(process.env.PATH || '').split(path.delimiter)];
    for (const dir of dirs) {
      const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (fs.existsSync(cli)) return [process.execPath, cli, ...command.slice(1)];
    }
    if (process.platform === 'win32') throw new Error('npm-cli.js not found; cannot safely launch npm.cmd.');
  }
  if (/\.(cmd|bat|ps1)$/i.test(command[0])) throw new Error('Shell shims are not supported in check commands.');
  return command;
}
async function terminate(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return { treeConfirmed: true };
  if (process.platform === 'win32') {
    const treeConfirmed = await new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); resolve(false); }, 3000);
      const done = code => { clearTimeout(timer); resolve(code === 0); };
      killer.once('error', () => done(-1)); killer.once('close', done);
    });
    // Some Windows environments do not expose taskkill. The owned process handle
    // still permits terminating the direct child; no external PID is selected.
    if (child.exitCode === null) child.kill('SIGKILL');
    return { treeConfirmed, pid: child.pid };
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    return { treeConfirmed: true, pid: child.pid };
  }
}
export async function runProcess(command, { cwd, input = '', prefix, timeoutMs, signal, onChild = async () => {}, onLine = () => {}, onStderr = () => {} }) {
  const args = await resolveCommand(command);
  await fsp.mkdir(path.dirname(prefix), { recursive: true });
  const out = fs.createWriteStream(`${prefix}.stdout.log`);
  const err = fs.createWriteStream(`${prefix}.stderr.log`);
  // Consume stream failures and surface them after child cleanup.
  let ioError;
  out.on('error', e => { ioError = e; }); err.on('error', e => { ioError = e; });
  const started = Date.now();
  let stopped = false, timedOut = false, spawnError, pending = '', tail = '', termination;
  const child = spawn(args[0], args.slice(1), { cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = new Promise(resolve => {
    child.once('error', e => { spawnError = e; });
    child.once('close', (code, exitSignal) => resolve({ code, exitSignal }));
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => {
    out.write(text); pending += text;
    let n;
    while ((n = pending.indexOf('\n')) >= 0) { onLine(pending.slice(0, n)); pending = pending.slice(n + 1); }
    if (pending.length > 8 * 1024 * 1024) { ioError = new Error('Event exceeds 8 MiB'); pending = ''; void terminate(child); }
  });
  child.stderr.on('data', text => { err.write(text); tail = (tail + text).slice(-12000); onStderr(text); });
  child.stdin.on('error', e => { if (e.code !== 'EPIPE') ioError = e; });
  const kill = () => termination ??= terminate(child).then(result => {
    // An unconfirmed descendant may keep inherited pipes open after its parent
    // exits. Close our pipe endpoints after a bounded drain; keep cleanup evidence.
    const drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1000);
    drain.unref();
    return result;
  });
  const abort = () => { stopped = true; void kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; void kill(); }, timeoutMs);
  try {
    await onChild(child.pid ?? null);
    if (signal?.aborted) abort();
    child.stdin.end(input);
    const result = await completion;
    if (pending) onLine(pending);
    const flushed = [out, err].map(s => new Promise(resolve => { if (s.destroyed) resolve(); else { s.once('close', resolve); s.end(); } }));
    await Promise.all(flushed);
    if (spawnError) throw spawnError;
    if (ioError) throw ioError;
    const cleanup = termination ? await termination : { treeConfirmed: true };
    return { ...result, timedOut, stopped, cleanup, elapsedMs: Date.now() - started, stderrTail: tail, command: args };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    await terminate(child); await completion;
    out.end(); err.end(); await onChild(null, child.pid);
  }
}
