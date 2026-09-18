// Explicit live-model smoke test; isolated workspace, tiny task, bounded calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Harness, loadProject } from './engine.mjs';
import { atomicJson } from './storage.mjs';
import { runProcess } from './process.mjs';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { config } = await loadProject(project);
const root = path.join(project, '.harness', 'smoke', crypto.randomUUID());
await fs.mkdir(root, { recursive: true });
const smokeConfig = { ...config, referenceRoot: root, limits: { ...config.limits, agentMs: 180000, checkMs: 10000, runMs: 600000, fixes: 1, transientRetries: 0 } };
await atomicJson(path.join(root, 'tools/harness/config.json'), smokeConfig);
await fs.writeFile(path.join(root, 'tools/harness/acceptance.mjs'), "import assert from 'node:assert/strict'; import { add } from '../../sum.mjs'; assert.equal(add(2,3),5); assert.equal(add(-5,2),-3); assert.equal(add(0,0),0); console.log('3 assertions passed');\n");
await fs.writeFile(path.join(root, 'AGENTS.md'), '# Isolated harness smoke test\nImplement only sum.mjs exporting add(a,b) returning a+b. Read tools/harness/acceptance.mjs but never modify it or harness config. No network, package installs, commits, or other files. Reviewers must be read-only.\n');
await atomicJson(path.join(root, 'milestones/tasks.json'), [{ id: 'SMOKE', milestone: 'M0', title: 'Export add(a,b) in sum.mjs', dependsOn: [], critical: true, reads: ['AGENTS.md'], scope: ['sum.mjs'], criteria: [{ id: 'SMOKE.ADD', text: 'sum.mjs exports add with correct addition of positive, negative, and zero inputs; unchanged acceptance.mjs passes.' }], checks: [{ name: 'sum acceptance', command: ['node', 'tools/harness/acceptance.mjs'], criteria: ['SMOKE.ADD'] }] }]);
await runProcess(['git', 'init', '--quiet', root], { cwd: root, prefix: path.join(root, '.harness/init'), timeoutMs: 10000 });
console.log(`Live smoke workspace: ${root}`);
let interrupted = false;
try {
  const first = new Harness(root, { processRunner: async (...args) => {
    if (!interrupted) { interrupted = true; throw Object.assign(new Error('Intentional smoke pause after implementation'), { paused: true }); }
    return runProcess(...args);
  } });
  try { await first.run({ through: 'M0' }); }
  catch (e) { if (!e.message.includes('Intentional smoke pause')) throw e; }
  const final = await new Harness(root).run({ resume: true });
  if (final.status !== 'complete') throw new Error('Smoke did not complete');
  await atomicJson(path.join(project, '.harness/live-smoke.json'), { status: 'passed', root, at: new Date().toISOString(), models: config.models, pausedAndResumed: interrupted });
  console.log('Live smoke passed: implementation, intentional pause/resume, checks, Sol and Astra reviews.');
} catch (error) {
  await atomicJson(path.join(project, '.harness/live-smoke.json'), { status: 'blocked', root, at: new Date().toISOString(), reason: error.message });
  console.error(error.message); process.exitCode = 1;
}
