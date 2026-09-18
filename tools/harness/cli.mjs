#!/usr/bin/env node
// User-facing entrypoint, with no implicit execution when merely imported.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness, loadProject } from './engine.mjs';
import { atomicJson, readJson, alive, acquireLock, appendEvent } from './storage.mjs';
import { resolveCodex, runProcess } from './process.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function doctor(workspace = root) {
  const { config, tasks } = await loadProject(workspace);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ required');
  const codex = await resolveCodex(config.codexPath);
  await fs.access(config.referenceRoot);
  const dir = path.join(workspace, '.harness/doctor'); await fs.mkdir(dir, { recursive: true });
  const probe = path.join(dir, `write-${process.pid}`); await fs.writeFile(probe, 'probe', { flag: 'wx' }); await fs.unlink(probe);
  const results = {};
  for (const [name, command] of [['codex', [...codex, '--version']], ['git', ['git', 'status', '--short', '--branch']]]) {
    const prefix = path.join(dir, name);
    const r = await runProcess(command, { cwd: workspace, prefix, timeoutMs: 15000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`${name} preflight failed; see ${prefix}.stderr.log`);
    results[name] = (await fs.readFile(`${prefix}.stdout.log`, 'utf8')).trim();
  }
  const modelNetwork = process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1' ? 'blocked-by-environment' : 'unverified';
  const report = { node: process.version, codexCommand: codex, ...results, tasks: tasks.length, referenceRoot: config.referenceRoot, models: config.models, modelNetwork, note: modelNetwork === 'blocked-by-environment' ? 'This environment prevents Codex CLI model calls. A smoke result from another environment does not establish connectivity here.' : 'Authentication, model access, and application verification scripts are checked when invoked; doctor makes no model call.' };
  await atomicJson(path.join(dir, 'report.json'), report); return report;
}
export async function main(args) {
  const [command, ...rest] = args;
  if (command === 'doctor' && !rest.length) console.log(JSON.stringify(await doctor(), null, 2));
  else if (command === 'status' && !rest.length) {
    const state = await readJson(path.join(root, '.harness/state.json')).catch(e => { if (e.code === 'ENOENT') return { status: 'not-started' }; throw e; });
    console.log(JSON.stringify({ status: state.status, currentTask: state.currentTask, reason: state.reason, cleanupRequired: state.cleanupRequired, tasks: Object.fromEntries(Object.entries(state.tasks ?? {}).map(([id, info]) => [id, { status: info.status, attempts: info.attempts, passedAt: info.passedAt }])), children: state.children }, null, 2));
  } else if (command === 'recover' && rest.length === 1 && rest[0] === '--confirm-processes-closed') {
    const release = await acquireLock(root);
    try {
      const state = await readJson(path.join(root, '.harness/state.json'));
      if (state.children?.some(alive)) throw new Error('Recorded child still alive; recovery refused.');
      state.cleanupRequired = null;
      await atomicJson(path.join(root, '.harness/state.json'), state);
      await appendEvent(root, { type: 'operator-confirmed-cleanup' });
      console.log('Operator cleanup confirmation recorded. Use resume.');
    } finally { await release(); }
  } else if (command === 'stop' && !rest.length) {
    const lock = await readJson(path.join(root, '.harness/lock.json'));
    if (!alive(lock.pid)) throw new Error('Runner is not alive; use resume for recovery. No unrelated process was terminated.');
    await fs.writeFile(path.join(root, '.harness/stop'), new Date().toISOString()); console.log('Stop requested. The runner will terminate its owned children and save state.');
  } else if (command === 'run' && (!rest.length || (rest.length === 2 && rest[0] === '--through' && /^M[0-6]$/.test(rest[1])))) {
    await doctor(); await new Harness(root).run({ through: rest[1] ?? 'M6' });
  } else if (command === 'resume' && !rest.length) {
    await doctor(); await new Harness(root).run({ resume: true });
  } else throw new Error('Usage: node tools/harness/cli.mjs doctor|status|stop|resume|run [--through M0..M6]');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
