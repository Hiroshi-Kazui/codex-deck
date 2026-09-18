// Deterministic milestone runner: one writer, measured checks, independent reviews.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { acquireLock, appendEvent, atomicJson, changed, inRoot, protectedChanges, readJson, snapshot } from './storage.mjs';
import { configSchema, tasksSchema, reviewPass, validate, resultSchema, diagnosisSchema } from './schemas.mjs';
import { resolveCodex, runProcess } from './process.mjs';
import { callCodex, makePrompt } from './agent.mjs';

export async function loadProject(root) {
  const config = validate(configSchema, await readJson(path.join(root, 'tools/harness/config.json')));
  const tasks = validate(tasksSchema, await readJson(path.join(root, 'milestones/tasks.json')));
  const seen = new Set();
  for (const task of tasks) {
    if (!/^[A-Za-z0-9_-]+$/.test(task.id) || seen.has(task.id)) throw new Error(`Invalid/duplicate task ID ${task.id}`);
    if (task.dependsOn.some(id => !seen.has(id))) throw new Error(`Dependencies must precede ${task.id}`);
    const criteria = task.criteria.map(c => c.id);
    if (new Set(criteria).size !== criteria.length || task.checks.some(c => c.criteria.some(id => !criteria.includes(id)))) throw new Error(`Invalid criteria in ${task.id}`);
    if (criteria.some(id => !task.checks.some(c => c.criteria.includes(id)))) throw new Error(`Criterion has no verification in ${task.id}`);
    for (const read of task.reads) await fs.access(inRoot(root, read));
    seen.add(task.id);
  }
  return { config, tasks };
}

export class Harness {
  constructor(root, { agent = callCodex, processRunner = runProcess, log = console.log, environment = process.env } = {}) {
    this.root = root; this.agent = agent; this.processRunner = processRunner; this.log = log;
    this.environment = environment;
    this.abort = new AbortController(); this.children = new Set(); this.saveChain = Promise.resolve();
  }
  async save() {
    this.state.children = [...this.children];
    const value = structuredClone(this.state);
    this.saveChain = this.saveChain.then(() => atomicJson(path.join(this.root, '.harness/state.json'), value));
    await this.saveChain;
  }
  async record(type, details = {}) {
    await appendEvent(this.root, { runId: this.state.runId, type, ...details });
    this.log(`${new Date().toISOString()} ${type} ${details.task ?? ''} ${details.message ?? ''}`.trim());
  }
  async onChild(pid, oldPid) {
    if (pid) this.children.add(pid); else this.children.delete(oldPid);
    await this.save();
  }
  async assertMutable(before, role) {
    const after = await snapshot(this.root);
    const bad = role === 'implement' ? protectedChanges(before, after) : changed(before, after);
    if (bad.length) throw new Error(`${role} changed protected/read-only files: ${bad.join(', ')}. Review the diff; no automatic rollback.`);
    return after;
  }
  timeLeft() { return Math.max(1, this.deadline - Date.now()); }
  async invoke(task, role, info, context) {
    for (let retry = 0; ; retry++) {
      if (this.abort.signal.aborted) throw Object.assign(new Error('Stopped or run time limit reached'), { paused: true });
      const directory = path.join(this.runDir, `${task.id}-${role}-${crypto.randomUUID()}`);
      const before = await snapshot(this.root);
      const prompt = makePrompt({ task, role, config: this.config, context, evidence: info.evidence, findings: info.findings, diagnosis: info.diagnosis });
      let output, error;
      try {
        output = await this.agent({ codex: this.codex, root: this.root, config: this.config, task, role, prompt, directory, signal: this.abort.signal, onChild: this.onChild.bind(this), timeoutMs: Math.min(this.config.limits.agentMs, this.timeLeft()), threadId: role === 'implement' ? info.threadId : null });
      } catch (e) { error = e; }
      if (error?.cleanup?.treeConfirmed === false) this.state.cleanupRequired = error.cleanup;
      const after = await this.assertMutable(before, role);
      this.state.snapshot = after;
      await this.save();
      if (!error) {
        const schema = role === 'implement' ? resultSchema : role === 'diagnose' ? diagnosisSchema : null;
        if (schema) validate(schema, output.data);
        if (role === 'implement') info.threadId = output.threadId;
        await atomicJson(path.join(directory, 'accepted-result.json'), output);
        await this.record('agent-finished', { task: task.id, role, directory, usage: output.usage, elapsedMs: output.elapsedMs, model: output.model });
        return output.data;
      }
      // Never blindly repeat a failed implementation that already changed files.
      if (!error.transient || retry >= this.config.limits.transientRetries || before.hash !== after.hash) throw error;
      await this.record('retry', { task: task.id, role, message: error.message });
      await new Promise(resolve => setTimeout(resolve, 1000 * (retry + 1)));
    }
  }
  async verify(task, info) {
    info.status = 'verifying'; await this.save();
    const before = await snapshot(this.root);
    const evidence = [];
    for (const check of task.checks) {
      if (this.abort.signal.aborted) throw Object.assign(new Error('Verification interrupted'), { paused: true });
      const prefix = path.join(this.runDir, `${task.id}-check-${crypto.randomUUID()}`);
      const result = await this.processRunner(check.command, { cwd: this.root, prefix, timeoutMs: Math.min(this.config.limits.checkMs, this.timeLeft()), signal: this.abort.signal, onChild: this.onChild.bind(this) });
      if (result.cleanup?.treeConfirmed === false) { this.state.cleanupRequired = result.cleanup; await this.save(); }
      const item = { name: check.name, criteria: check.criteria, sourceHash: before.hash, ...result, stdout: `${prefix}.stdout.log`, stderr: `${prefix}.stderr.log` };
      await atomicJson(`${prefix}.json`, item); evidence.push(item);
      await this.record('check', { task: task.id, name: check.name, code: result.code });
      if (result.stopped || result.timedOut) throw Object.assign(new Error(`Check interrupted: ${check.name}`), { paused: true });
      if (result.code !== 0) break;
    }
    // Verification must never rewrite product sources or acceptance definitions.
    await this.assertMutable(before, 'verify');
    info.evidence = evidence; await this.save();
    return evidence.length === task.checks.length && evidence.every(e => e.code === 0 && !e.timedOut && !e.stopped);
  }
  async execute(task, info) {
    const context = { previous: this.state.lastHandoff ?? '', referenceManifest: 'docs/spec/reference-manifest.json' };
    for (;;) {
      if (info.status !== 'revalidate') {
        if (info.attempts > this.config.limits.fixes) throw new Error(`Fix limit reached for ${task.id}; inspect evidence and make a concrete correction before resume.`);
        if (info.attempts >= 2 && !info.diagnosis) {
          info.diagnosis = await this.invoke(task, 'diagnose', info, context); await this.save();
          info.threadId = null;
          if (info.diagnosis.requiresDecision) throw new Error(`Decision required: ${info.diagnosis.question}`);
        }
        info.status = 'implementing'; info.attempts++; await this.save();
        const implementation = await this.invoke(task, 'implement', info, context);
        info.handoff = implementation.handoff; this.state.lastHandoff = implementation.handoff;
        if (implementation.status === 'blocked' || implementation.blockers.length) throw new Error(`Implementation blocked: ${implementation.blockers.join('; ') || implementation.summary}`);
      }
      if (!await this.verify(task, info)) {
        info.status = 'fixing'; info.findings = [{ problem: 'Required verification failed', evidence: info.evidence }];
        await this.save(); continue;
      }
      info.status = 'reviewing'; await this.save();
      const verifiedHash = (await snapshot(this.root)).hash;
      const roles = task.critical ? ['review', 'critical'] : ['review'];
      // Both reviewers see the same frozen implementation. Settle all before allowing edits.
      const settled = await Promise.allSettled(roles.map(role => this.invoke(task, role, info, context)));
      const failed = settled.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
      const reviews = settled.map(r => r.value);
      if ((await snapshot(this.root)).hash !== verifiedHash) throw new Error('Files changed during review; verification is no longer valid.');
      info.reviews = reviews;
      info.findings = reviews.flatMap(r => r.findings ?? []);
      if (reviews.every(r => reviewPass(r, task))) {
        info.status = 'passed'; info.sourceHash = verifiedHash; info.passedAt = new Date().toISOString();
        this.state.snapshot = await snapshot(this.root); await this.save();
        await this.record('task-passed', { task: task.id }); return;
      }
      info.status = 'fixing'; await this.save();
    }
  }
  async run({ through = 'M6', resume = false, codex } = {}) {
    if (!/^M[0-6]$/.test(through)) throw new Error('through must be M0..M6');
    // The connected Codex agent can work in an environment whose child processes
    // are explicitly denied network access. Do not create a blocked run there.
    if (this.agent === callCodex && this.environment.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
      throw new Error('This execution environment blocks network access for Codex CLI child processes (CODEX_SANDBOX_NETWORK_DISABLED=1). Run the harness from a network-enabled host; no task was started.');
    }
    const release = await acquireLock(this.root);
    let poll, deadlineTimer;
    const signalStop = () => this.abort.abort();
    process.on('SIGINT', signalStop); process.on('SIGTERM', signalStop);
    try {
      const project = await loadProject(this.root);
      this.config = project.config; this.codex = codex ?? await resolveCodex(this.config.codexPath);
      const file = path.join(this.root, '.harness/state.json');
      const previous = await readJson(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (previous && !resume) throw new Error('Previous run exists; use resume.');
      if (resume && !previous) throw new Error('No run to resume.');
      if (previous?.cleanupRequired) throw new Error(`Descendant cleanup could not be confirmed for owned PID ${previous.cleanupRequired.pid}. Close the remaining processes, then use recover --confirm-processes-closed before resume.`);
      const current = await snapshot(this.root);
      this.state = previous ?? { version: 1, tasks: {}, children: [], snapshot: current, through };
      if (resume) through = this.state.through;
      if (previous && previous.snapshot.hash !== current.hash) {
        for (const info of Object.values(this.state.tasks)) {
          info.status = info.status === 'passed' ? 'revalidate' : 'pending';
          info.attempts = 0; info.diagnosis = null; info.evidence = []; info.reviews = []; info.threadId = null;
        }
      } else if (previous) {
        // Implementation already returned successfully. Resume at validation,
        // never pay for another implementation merely because a check stopped.
        for (const info of Object.values(this.state.tasks)) {
          if (['verifying', 'reviewing'].includes(info.status)) info.status = 'revalidate';
        }
      }
      this.state.snapshot = current; this.state.runId = crypto.randomUUID(); this.state.status = 'running'; this.state.reason = null;
      this.runDir = path.join(this.root, '.harness/runs', this.state.runId);
      await fs.mkdir(this.runDir, { recursive: true });
      await fs.rm(path.join(this.root, '.harness/stop'), { force: true });
      this.deadline = Date.now() + this.config.limits.runMs;
      deadlineTimer = setTimeout(() => this.abort.abort(), this.config.limits.runMs);
      poll = setInterval(() => { fs.access(path.join(this.root, '.harness/stop')).then(() => this.abort.abort(), e => { if (e.code !== 'ENOENT') this.abort.abort(); }); }, 500);
      await this.save(); await this.record('run-started');
      for (const task of project.tasks.filter(t => Number(t.milestone.slice(1)) <= Number(through.slice(1)))) {
        if (this.abort.signal.aborted) throw Object.assign(new Error('Run paused by stop or time limit'), { paused: true });
        if (task.dependsOn.some(id => this.state.tasks[id]?.status !== 'passed')) throw new Error(`Unmet dependency: ${task.id}`);
        const info = this.state.tasks[task.id] ??= { status: 'pending', attempts: 0, evidence: [], findings: [] };
        if (info.status === 'passed') continue;
        this.state.currentTask = task.id; await this.save(); await this.record('task-started', { task: task.id });
        await this.execute(task, info);
      }
      this.state.status = 'complete'; this.state.currentTask = null; await this.save(); await this.record('run-complete');
      return this.state;
    } catch (error) {
      if (this.state) {
        this.state.status = error.paused || this.abort.signal.aborted ? 'paused' : 'blocked';
        this.state.reason = error.message;
        // Keep the last trusted snapshot on unexpected edits so resume invalidates evidence.
        await this.save(); await this.record(this.state.status, { task: this.state.currentTask, message: error.message });
      }
      throw error;
    } finally {
      clearInterval(poll); clearTimeout(deadlineTimer);
      process.off('SIGINT', signalStop); process.off('SIGTERM', signalStop);
      await this.saveChain; await release();
    }
  }
}
