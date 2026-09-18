// Fault-injection coverage uses temporary workspaces; no real account/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Harness, loadProject } from '../engine.mjs';
import { atomicJson, snapshot, acquireLock, readJson } from '../storage.mjs';
import { validate, resultSchema, reviewPass } from '../schemas.mjs';
import { runProcess } from '../process.mjs';
import { callCodex } from '../agent.mjs';

const baseConfig = { version: 1, referenceRoot: '.', models: { implement: 'sol', review: 'sol', critical: 'astra', diagnose: 'astra' }, limits: { agentMs: 10000, checkMs: 10000, runMs: 30000, fixes: 3, transientRetries: 0 }, codexPath: null };
const implementation = { status: 'complete', summary: 'implemented', files: ['app.txt'], tests: ['test'], blockers: [], handoff: 'next' };
function pass(task) { return { status: 'pass', summary: 'verified', criteria: task.criteria.map(c => ({ id: c.id, satisfied: true, evidence: 'check log and app.txt' })), findings: [] }; }
const failure = { severity: 'blocking', criterion: 'T1.A', location: 'app.txt:1', problem: 'wrong', impact: 'incorrect result', fix: 'correct', verification: 'assert' };
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'deck harness 日本語 '));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const task = { id: 'T1', milestone: 'M0', title: 'test', dependsOn: [], critical: false, reads: [], scope: ['app.txt'], criteria: [{ id: 'T1.A', text: 'works' }], checks: [{ name: 'test', command: ['node', '-e', 'process.exit(0)'], criteria: ['T1.A'] }] };
  const config = { ...baseConfig, ...options, limits: { ...baseConfig.limits, ...options.limits } };
  await atomicJson(path.join(root, 'tools/harness/config.json'), config);
  await atomicJson(path.join(root, 'milestones/tasks.json'), [task]);
  return { root, task, config };
}
const goodProcess = async () => ({ code: 0, timedOut: false, stopped: false, elapsedMs: 1 });
function agentFor(root, calls = []) {
  return async ({ role, task }) => {
    calls.push(role);
    if (role === 'implement') { await fs.writeFile(path.join(root, 'app.txt'), 'implemented'); return { data: implementation, threadId: 'test-thread' }; }
    if (role === 'diagnose') return { data: { cause: 'bug', correction: 'fix', requiresDecision: false, question: '' } };
    return { data: pass(task) };
  };
}

test('schemas reject missing/unknown fields, wrong numeric values, unsupported keywords', () => {
  validate(resultSchema, implementation);
  assert.throws(() => validate(resultSchema, { ...implementation, extra: true }));
  assert.throws(() => validate(resultSchema, { ...implementation, files: null }));
  assert.throws(() => validate({ type: 'integer', minimum: 1 }, 1.1));
  assert.throws(() => validate({ type: 'string', pattern: 'x' }, 'x'), /Unsupported/);
});
test('PASS with blocking, absent criteria or duplicate criteria is rejected', async t => {
  const { task } = await fixture(t);
  assert.equal(reviewPass(pass(task), task), true);
  assert.equal(reviewPass({ ...pass(task), findings: [failure] }, task), false);
  assert.equal(reviewPass({ ...pass(task), criteria: [] }, task), false);
  assert.equal(reviewPass({ ...pass(task), criteria: [...pass(task).criteria, ...pass(task).criteria] }, task), false);
});
test('full loop works before first Git commit; passed task is not rerun on resume', async t => {
  const { root } = await fixture(t); const calls = [];
  const runner = () => new Harness(root, { agent: agentFor(root, calls), processRunner: goodProcess, log() {} });
  const state = await runner().run({ through: 'M0', codex: ['fake'] });
  assert.equal(state.status, 'complete'); assert.deepEqual(calls, ['implement', 'review']);
  await runner().run({ resume: true, codex: ['fake'] });
  assert.deepEqual(calls, ['implement', 'review']);
});
test('real agent refuses an explicitly network-disabled environment before creating run state', async t => {
  const { root } = await fixture(t);
  const harness = new Harness(root, { environment: { CODEX_SANDBOX_NETWORK_DISABLED: '1' }, log() {} });
  await assert.rejects(harness.run({ codex: ['fake'] }), /blocks network access/);
  await assert.rejects(fs.access(path.join(root, '.harness/state.json')), { code: 'ENOENT' });
});
test('failed verification goes directly to fix without review; exhaustion blocks', async t => {
  const { root } = await fixture(t, { limits: { fixes: 1 } }); const calls = [];
  const h = new Harness(root, { agent: agentFor(root, calls), processRunner: async () => ({ code: 1 }), log() {} });
  await assert.rejects(h.run({ codex: ['fake'] }), /Fix limit/);
  assert.deepEqual(calls, ['implement', 'implement']);
  assert.equal((await readJson(path.join(root, '.harness/state.json'))).status, 'blocked');
});
test('missing verification command blocks instead of succeeding', async t => {
  const { root, task } = await fixture(t, { limits: { fixes: 0 } });
  task.checks[0].command = ['node', 'missing-check.mjs'];
  await atomicJson(path.join(root, 'milestones/tasks.json'), [task]);
  const h = new Harness(root, { agent: agentFor(root), log() {} });
  await assert.rejects(h.run({ codex: ['fake'] }), /Fix limit/);
});
test('review failure triggers fix, retains original findings, resumes implementer ID', async t => {
  const { root } = await fixture(t); let reviews = 0; const ids = [];
  const base = agentFor(root);
  const agent = async opts => {
    if (opts.role === 'implement') ids.push(opts.threadId);
    if (opts.role === 'review' && reviews++ === 0) return { data: { ...pass(opts.task), status: 'fail', findings: [failure] } };
    return base(opts);
  };
  const state = await new Harness(root, { agent, processRunner: goodProcess, log() {} }).run({ codex: ['fake'] });
  assert.equal(state.status, 'complete'); assert.deepEqual(ids, [undefined, 'test-thread']);
});
test('repeated failures request Astra diagnosis and cannot lower criteria', async t => {
  const { root } = await fixture(t); const calls = [];
  const base = agentFor(root, calls);
  const agent = async opts => {
    const result = await base(opts);
    if (opts.role === 'review') return { data: { ...pass(opts.task), status: 'fail', findings: [failure] } };
    return result;
  };
  await assert.rejects(new Harness(root, { agent, processRunner: goodProcess, log() {} }).run({ codex: ['fake'] }), /Fix limit/);
  assert.equal(calls.filter(x => x === 'diagnose').length, 1);
  assert.equal(calls.filter(x => x === 'implement').length, 4);
});
test('protected changes by implementer stop the run and preserve diff', async t => {
  const { root } = await fixture(t);
  const agent = async () => { await fs.writeFile(path.join(root, 'AGENTS.md'), 'weaken rules'); return { data: implementation }; };
  await assert.rejects(new Harness(root, { agent, processRunner: goodProcess, log() {} }).run({ codex: ['fake'] }), /protected/);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'weaken rules');
});
test('reviewer cannot edit sources; checker cannot rewrite sources', async t => {
  for (const kind of ['review', 'verify']) {
    const { root } = await fixture(t); const base = agentFor(root);
    const agent = async opts => { const r = await base(opts); if (opts.role === kind) await fs.writeFile(path.join(root, 'app.txt'), 'tampered'); return r; };
    const processRunner = async () => { if (kind === 'verify') await fs.writeFile(path.join(root, 'app.txt'), 'tampered'); return goodProcess(); };
    await assert.rejects(new Harness(root, { agent, processRunner, log() {} }).run({ codex: ['fake'] }), /read-only/);
  }
});
test('external change invalidates evidence and revalidates without blindly reimplementing', async t => {
  const { root } = await fixture(t); const calls = []; const opts = { agent: agentFor(root, calls), processRunner: goodProcess, log() {} };
  await new Harness(root, opts).run({ codex: ['fake'] });
  await fs.writeFile(path.join(root, 'app.txt'), 'external change');
  await new Harness(root, opts).run({ codex: ['fake'], resume: true });
  assert.deepEqual(calls, ['implement', 'review', 'review']);
});
test('exclusive lock blocks second writer; stale lock can be recovered', async t => {
  const { root } = await fixture(t);
  const release = await acquireLock(root);
  await assert.rejects(acquireLock(root), /already running/); await release();
  await atomicJson(path.join(root, '.harness/lock.json'), { pid: 2147483647, token: 'old' });
  const releaseRecovered = await acquireLock(root); await releaseRecovered();
});
test('stale runner with live child blocks recovery without killing that child', async t => {
  const { root } = await fixture(t);
  await atomicJson(path.join(root, '.harness/lock.json'), { pid: 2147483647, token: 'old' });
  await atomicJson(path.join(root, '.harness/state.json'), { children: [process.pid] });
  await assert.rejects(acquireLock(root), /child.*alive/);
});
test('interrupted run resumes and critical reviews both run', async t => {
  const { root, task } = await fixture(t); task.critical = true;
  await atomicJson(path.join(root, 'milestones/tasks.json'), [task]);
  let first = true; const calls = [];
  const agent = async opts => { if (first) { first = false; throw Object.assign(new Error('interrupted'), { paused: true }); } return agentFor(root, calls)(opts); };
  await assert.rejects(new Harness(root, { agent, processRunner: goodProcess, log() {} }).run({ codex: ['fake'] }), /interrupted/);
  const state = await new Harness(root, { agent, processRunner: goodProcess, log() {} }).run({ codex: ['fake'], resume: true });
  assert.equal(state.status, 'complete'); assert.ok(calls.includes('critical'));
});
test('task DAG and unmapped criterion are rejected', async t => {
  const { root, task } = await fixture(t); task.dependsOn = ['future'];
  await atomicJson(path.join(root, 'milestones/tasks.json'), [task]);
  await assert.rejects(loadProject(root), /Dependencies/);
  task.dependsOn = []; task.checks[0].criteria = [];
  await atomicJson(path.join(root, 'milestones/tasks.json'), [task]);
  await assert.rejects(loadProject(root), /no verification/);
});
test('snapshot includes untracked files and ignores build artifacts', async t => {
  const { root } = await fixture(t); const initial = await snapshot(root);
  await fs.mkdir(path.join(root, 'out')); await fs.writeFile(path.join(root, 'out/test'), 'build');
  assert.equal((await snapshot(root)).hash, initial.hash);
  await fs.writeFile(path.join(root, 'untracked.txt'), 'data');
  assert.notEqual((await snapshot(root)).hash, initial.hash);
});
test('process runner handles Japanese/spaces, missing binaries, timeout and abort', async t => {
  const { root } = await fixture(t); const prefix = path.join(root, '.harness/probe');
  const r = await runProcess(['node', '-e', 'process.stdin.pipe(process.stdout)'], { cwd: root, input: '日本語 $() ` text', prefix, timeoutMs: 3000 });
  assert.equal(r.code, 0); assert.equal(await fs.readFile(prefix + '.stdout.log', 'utf8'), '日本語 $() ` text');
  await assert.rejects(runProcess(['definitely-not-a-real-command-xyz'], { cwd: root, prefix, timeoutMs: 1000 }), /ENOENT/);
  const timed = await runProcess(['node', '-e', 'setTimeout(()=>{},2000)'], { cwd: root, prefix, timeoutMs: 100 });
  assert.equal(timed.timedOut, true);
  const abort = new AbortController(); setTimeout(() => abort.abort(), 100);
  const stopped = await runProcess(['node', '-e', 'setTimeout(()=>{},2000)'], { cwd: root, prefix, timeoutMs: 3000, signal: abort.signal });
  assert.equal(stopped.stopped, true);
});
test('Codex adapter requires successful events AND valid structured output', async t => {
  const { root, config, task } = await fixture(t);
  for (const mode of ['good', 'bad-json', 'missing-result', 'event-error', 'exit-error', 'no-completion']) {
    const file = path.join(root, `fake-${mode}.mjs`);
    const source = `import fs from 'node:fs'; const a=process.argv; const output=a[a.indexOf('-o')+1]; process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'thread.started',thread_id:'test'})); ${mode === 'missing-result' ? '' : `fs.writeFileSync(output, ${JSON.stringify(mode === 'bad-json' ? '{bad' : JSON.stringify(implementation))});`} ${mode === 'event-error' ? "console.log(JSON.stringify({type:'error',message:'failed'}));" : ''} ${mode === 'no-completion' ? '' : "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}}));"} process.exitCode=${mode === 'exit-error' ? 1 : 0}; });`;
    await fs.writeFile(file, source);
    const opts = { codex: [process.execPath, file], root, config, task, role: 'implement', prompt: 'test', directory: path.join(root, '.harness', mode), timeoutMs: 3000 };
    if (mode === 'good') assert.equal((await callCodex(opts)).data.status, 'complete');
    else await assert.rejects(callCodex(opts));
  }
});
test('unconfirmed tree cleanup prevents automatic resume', async t => {
  const { root } = await fixture(t);
  const agent = async () => { throw Object.assign(new Error('timeout'), { paused: true, cleanup: { treeConfirmed: false, pid: 12345 } }); };
  await assert.rejects(new Harness(root, { agent, log() {} }).run({ codex: ['fake'] }), /timeout/);
  const state = await readJson(path.join(root, '.harness/state.json'));
  assert.equal(state.cleanupRequired.treeConfirmed, false);
  await assert.rejects(new Harness(root, { agent, log() {} }).run({ codex: ['fake'], resume: true }), /cleanup could not be confirmed/);
});
test('run deadline interrupts the active call and saves paused state', async t => {
  const { root } = await fixture(t, { limits: { runMs: 50 } });
  const agent = async ({ signal }) => {
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    throw Object.assign(new Error('deadline'), { paused: true });
  };
  await assert.rejects(new Harness(root, { agent, log() {} }).run({ codex: ['fake'] }), /deadline/);
  assert.equal((await readJson(path.join(root, '.harness/state.json'))).status, 'paused');
});
test('network permission denial stops promptly and is not classified as transient', async t => {
  const { root, config, task } = await fixture(t);
  const file = path.join(root, 'denied.mjs');
  await fs.writeFile(file, "process.stdin.resume(); process.stdin.on('end',()=>{console.error('connect failed (os error 10013)');setTimeout(()=>{},2000);});");
  await assert.rejects(callCodex({ codex: [process.execPath, file], root, config, task, role: 'implement', prompt: 'test', directory: path.join(root, '.harness/denied'), timeoutMs: 5000 }), e => /Network access denied/.test(e.message) && !e.transient);
});
test('pause during verification resumes validation without another model implementation', async t => {
  const { root } = await fixture(t); const calls = [];
  const options = { agent: agentFor(root, calls), log() {} };
  const interruptedCheck = async () => { throw Object.assign(new Error('check paused'), { paused: true }); };
  await assert.rejects(new Harness(root, { ...options, processRunner: interruptedCheck }).run({ codex: ['fake'] }), /check paused/);
  await new Harness(root, { ...options, processRunner: goodProcess }).run({ codex: ['fake'], resume: true });
  assert.deepEqual(calls, ['implement', 'review']);
});
