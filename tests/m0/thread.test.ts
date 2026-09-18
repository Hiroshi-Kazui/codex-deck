import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadLifecycle } from '../../src/m0/thread.ts';

type Call = { method: string; params: unknown };
function server() {
  const calls: Call[] = [];
  let nextThread = 0;
  let nextTurn = 0;
  const threads = new Map<string, { id: string; sessionId: string; forkedFromId?: string }>();
  const bridge = {
    async request(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params });
      const input = params as Record<string, unknown>;
      if (method === 'thread/start') {
        const id = `thread-${++nextThread}`;
        const thread = { id, sessionId: `session-${nextThread}` };
        threads.set(id, thread);
        return { thread };
      }
      if (method === 'thread/resume') {
        const thread = threads.get(String(input.threadId));
        if (!thread) throw new Error('unknown thread');
        return { thread };
      }
      if (method === 'thread/fork') {
        const parent = threads.get(String(input.threadId));
        if (!parent) throw new Error('unknown parent');
        const thread = { id: `thread-${++nextThread}`, sessionId: parent.sessionId, forkedFromId: parent.id };
        threads.set(thread.id, thread);
        return { thread };
      }
      if (method === 'turn/start') {
        if (!threads.has(String(input.threadId))) throw new Error('unknown thread');
        return { turn: { id: `turn-${++nextTurn}`, status: 'inProgress' } };
      }
      if (method === 'thread/compact/start') {
        if (!threads.has(String(input.threadId))) throw new Error('unknown thread');
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
  return { bridge, calls };
}

test('new, exact resume, and fork keep thread, session, and run identities separate', async () => {
  const { bridge, calls } = server();
  const lifecycle = new ThreadLifecycle(bridge);
  const first = await lifecycle.start('C:\\repo');
  assert.equal(first.threadId, 'thread-1');
  assert.equal(first.sessionId, 'session-1');
  assert.ok(first.runId);
  const resumed = await lifecycle.resume(first.threadId);
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(resumed.sessionId, first.sessionId);
  assert.notEqual(resumed.runId, first.runId);
  const fork = await lifecycle.fork(first.threadId, 'turn-1');
  assert.equal(fork.threadId, 'thread-2');
  assert.equal(fork.sessionId, first.sessionId);
  assert.notEqual(fork.runId, resumed.runId);
  assert.equal(fork.forkedFromId, first.threadId);
  assert.deepEqual(calls[1], { method: 'thread/resume', params: { threadId: 'thread-1' } });
  assert.deepEqual(calls[2], { method: 'thread/fork', params: { threadId: 'thread-1', lastTurnId: 'turn-1' } });
  await assert.rejects(lifecycle.resume('thread-not-found'), /unknown thread/);
});

test('model selection is applied to the next turn and compact targets the exact thread', async () => {
  const { bridge, calls } = server();
  const lifecycle = new ThreadLifecycle(bridge);
  const run = await lifecycle.start('C:\\repo', 'model-A');
  const turn = await lifecycle.startTurn(run.threadId, 'hello');
  assert.equal(turn.threadId, run.threadId);
  assert.equal(turn.sessionId, run.sessionId);
  assert.equal(turn.runId, run.runId);
  assert.equal(turn.turnId, 'turn-1');
  lifecycle.setModel(run.threadId, 'model-B');
  await lifecycle.startTurn(run.threadId, 'continue');
  await lifecycle.compact(run.threadId);
  assert.deepEqual(calls[0], { method: 'thread/start', params: { cwd: 'C:\\repo', model: 'model-A' } });
  assert.deepEqual(calls[1], { method: 'turn/start', params: { threadId: run.threadId, input: [{ type: 'text', text: 'hello' }], model: 'model-A' } });
  assert.deepEqual(calls[2], { method: 'turn/start', params: { threadId: run.threadId, input: [{ type: 'text', text: 'continue' }], model: 'model-B' } });
  assert.deepEqual(calls[3], { method: 'thread/compact/start', params: { threadId: run.threadId } });
  await assert.rejects(lifecycle.compact('other-thread'), /not active/);
  await assert.rejects(lifecycle.startTurn(run.threadId, '  '), /empty/);
});

test('unexpected identities in server responses are rejected before becoming active', async () => {
  const mismatch = new ThreadLifecycle({ request: async () => ({ thread: { id: 'wrong', sessionId: 's' } }) });
  await assert.rejects(mismatch.resume('expected'), /returned wrong for expected/);
  const missingSession = new ThreadLifecycle({ request: async () => ({ thread: { id: 't' } }) });
  await assert.rejects(missingSession.start('C:\\repo'), /thread.sessionId/);
  const wrongParent = new ThreadLifecycle({ request: async () => ({ thread: { id: 'new', sessionId: 's', forkedFromId: 'other' } }) });
  await assert.rejects(wrongParent.fork('source'), /different parent/);
});
