// Codex invocation adapter; transport events and final results are checked separately.
import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from './process.mjs';
import { atomicJson, readJson } from './storage.mjs';
import { resultSchema, reviewSchema, diagnosisSchema, validate } from './schemas.mjs';
export const roleSchemas = { implement: resultSchema, review: reviewSchema, critical: reviewSchema, diagnose: diagnosisSchema };
export async function callCodex({ codex, root, config, task, role, prompt, directory, signal, onChild, timeoutMs, threadId }) {
  const schema = roleSchemas[role];
  const schemaPath = path.join(directory, 'schema.json');
  const outputPath = path.join(directory, 'result.json');
  await atomicJson(schemaPath, schema);
  await fs.writeFile(path.join(directory, 'prompt.md'), prompt);
  const events = { failed: [], completed: false, threadId: null, usage: null };
  const localAbort = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
  let deniedNetwork = false;
  const common = [...codex, '-a', 'never', '-C', root, '-s', role === 'implement' ? 'workspace-write' : 'read-only', 'exec'];
  const args = [...common, ...(threadId ? ['resume'] : []), '--model', config.models[role], '--json', '--output-schema', schemaPath, '-o', outputPath, ...(threadId ? [threadId] : []), '-'];
  const result = await runProcess(args, {
    cwd: root, input: prompt, prefix: path.join(directory, 'process'), timeoutMs, signal: combinedSignal, onChild,
    onStderr(text) {
      if (/os error 10013|WSAEACCES|connect.*EACCES/i.test(text)) { deniedNetwork = true; localAbort.abort(); }
    },
    onLine(line) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started') events.threadId = event.thread_id;
        if (event.type === 'turn.completed') { events.completed = true; events.usage = event.usage; }
        if (['error', 'turn.failed'].includes(event.type)) events.failed.push(event);
      } catch { /* Raw non-JSON diagnostics remain in stdout.log. */ }
    },
  });
  await atomicJson(path.join(directory, 'execution.json'), { ...result, ...events, model: config.models[role] });
  if (deniedNetwork) throw Object.assign(new Error(`Network access denied by the environment (socket 10013/EACCES). Run the smoke test in your normal authenticated terminal; see ${directory}`), { cleanup: result.cleanup });
  if (result.stopped || result.timedOut) throw Object.assign(new Error(result.stopped ? 'Execution stopped' : 'Agent timeout'), { paused: true, cleanup: result.cleanup });
  if (result.code !== 0 || events.failed.length || !events.completed) {
    const detail = JSON.stringify(events.failed) + result.stderrTail;
    const transient = /(?:connection reset|temporarily unavailable|HTTP 50[234]|ECONNRESET|ETIMEDOUT)/i.test(detail) && !/auth|permission|quota|rate.limit|model.*not/i.test(detail);
    throw Object.assign(new Error(`Codex execution failed (${result.code}); see ${directory}\n${detail.slice(-2000)}`), { transient });
  }
  let data;
  try { data = validate(schema, await readJson(outputPath)); }
  catch (error) { throw new Error(`Invalid Codex final result: ${error.message}; see ${directory}`); }
  return { data, threadId: events.threadId, usage: events.usage, elapsedMs: result.elapsedMs, model: config.models[role] };
}

export function makePrompt({ task, role, config, context, evidence, findings, diagnosis }) {
  const common = `You are working on codex-deck on Windows. Read AGENTS.md first.\nTask: ${JSON.stringify(task, null, 2)}\nReference source (read-only): ${config.referenceRoot}\nRead only the listed documents and source needed for this task. Never read credential files.\nDo not change tools/harness, milestones, docs/spec, docs/adr, AGENTS.md or .gitignore. Do not change acceptance conditions to fit implementation. No commits, pushes, reset, clean or stash. Preserve unrelated user changes. No child agents: the harness owns orchestration.\nEvidence and recent context:\n${JSON.stringify({ context, evidence, findings, diagnosis }, null, 2)}\n`;
  if (role === 'implement') return common + 'Implement or fix this task only. Create the specified verification scripts if missing; they must assert the listed behaviors and fail when unmet. Never use empty/no-op tests or claim success without evidence. Use the existing Codex permissions; if environment or product decisions block progress return blocked with a concrete request. Do not start the next task. Return the required structured result.\n';
  if (role === 'diagnose') return common + 'READ ONLY. Diagnose the recurring failure. Give a specific correction grounded in code and evidence. If a product/spec decision is required, state the exact question. Do not lower requirements.\n';
  return common + `READ ONLY. Review the actual implementation and verification evidence. ${role === 'critical' ? 'Focus on protocol forwarding, approval ownership, process isolation, thread identity, persistence/recovery, and concurrency.' : 'Check requirement coverage, correctness, failure behavior, and tests. For UI inspect saved screenshots and interaction evidence.'}\nInspect files yourself; do not trust implementer claims. Cover every criterion exactly once. Each satisfied criterion needs a concrete file/test/evidence reference. Missing/failed required checks, skipped real-device evidence, incomplete behavior or weakening a test are blocking. Do not run tests or change files; the supervisor ran the checks. Return pass only with zero blocking findings. Put optional style improvements in followup findings.\n`;
}
