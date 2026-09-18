import { randomUUID } from 'node:crypto';
import type { Bridge } from './bridge.ts';

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${label} in App Server response`);
  return value;
}

export type ThreadRun = Readonly<{
  threadId: string;
  sessionId: string;
  runId: string;
  forkedFromId?: string;
}>;
export type TurnRun = Readonly<ThreadRun & { turnId: string }>;

export class ThreadLifecycle {
  private readonly active = new Map<string, ThreadRun>();
  private readonly models = new Map<string, string>();
  private readonly bridge: Pick<Bridge, 'request'>;
  constructor(bridge: Pick<Bridge, 'request'>) { this.bridge = bridge; }

  private readThread(result: unknown, operation: string): { id: string; sessionId: string; forkedFromId?: string } {
    if (!object(result) || !object(result.thread)) throw new Error(`Invalid ${operation} response: missing thread`);
    const thread = result.thread;
    const id = nonempty(thread.id, 'thread.id');
    const sessionId = nonempty(thread.sessionId, 'thread.sessionId');
    const forkedFromId = thread.forkedFromId === undefined || thread.forkedFromId === null
      ? undefined : nonempty(thread.forkedFromId, 'thread.forkedFromId');
    return { id, sessionId, ...(forkedFromId === undefined ? {} : { forkedFromId }) };
  }
  private record(thread: { id: string; sessionId: string; forkedFromId?: string }): ThreadRun {
    const run: ThreadRun = Object.freeze({
      threadId: thread.id, sessionId: thread.sessionId, runId: randomUUID(),
      ...(thread.forkedFromId === undefined ? {} : { forkedFromId: thread.forkedFromId }),
    });
    this.active.set(run.threadId, run);
    return run;
  }
  private requireThread(threadId: string): ThreadRun {
    const run = this.active.get(threadId);
    if (!run) throw new Error(`Thread is not active in this run: ${threadId}`);
    return run;
  }
  async start(cwd: string, model?: string): Promise<ThreadRun> {
    nonempty(cwd, 'cwd');
    if (model !== undefined) nonempty(model, 'model');
    const result = await this.bridge.request('thread/start', { cwd, ...(model === undefined ? {} : { model }) });
    const run = this.record(this.readThread(result, 'thread/start'));
    if (model !== undefined) this.models.set(run.threadId, model);
    return run;
  }
  async resume(threadId: string, model?: string): Promise<ThreadRun> {
    nonempty(threadId, 'threadId');
    if (model !== undefined) nonempty(model, 'model');
    const result = await this.bridge.request('thread/resume', { threadId, ...(model === undefined ? {} : { model }) });
    const thread = this.readThread(result, 'thread/resume');
    if (thread.id !== threadId) throw new Error(`thread/resume returned ${thread.id} for ${threadId}`);
    const run = this.record(thread);
    if (model !== undefined) this.models.set(run.threadId, model);
    return run;
  }
  async fork(threadId: string, lastTurnId?: string): Promise<ThreadRun> {
    nonempty(threadId, 'threadId');
    if (lastTurnId !== undefined) nonempty(lastTurnId, 'lastTurnId');
    const result = await this.bridge.request('thread/fork', {
      threadId, ...(lastTurnId === undefined ? {} : { lastTurnId }),
    });
    const thread = this.readThread(result, 'thread/fork');
    if (thread.id === threadId) throw new Error('thread/fork returned the source thread ID');
    if (thread.forkedFromId !== undefined && thread.forkedFromId !== threadId)
      throw new Error(`thread/fork returned a different parent: ${thread.forkedFromId}`);
    return this.record({ ...thread, forkedFromId: threadId });
  }
  setModel(threadId: string, model: string): void {
    this.requireThread(threadId);
    this.models.set(threadId, nonempty(model, 'model'));
  }
  async startTurn(threadId: string, text: string): Promise<TurnRun> {
    const run = this.requireThread(threadId);
    if (!text.trim()) throw new Error('Turn input is empty');
    const model = this.models.get(threadId);
    const result = await this.bridge.request('turn/start', {
      threadId, input: [{ type: 'text', text }], ...(model === undefined ? {} : { model }),
    });
    if (!object(result) || !object(result.turn)) throw new Error('Invalid turn/start response: missing turn');
    return Object.freeze({ ...run, turnId: nonempty(result.turn.id, 'turn.id') });
  }
  async compact(threadId: string): Promise<void> {
    this.requireThread(threadId);
    await this.bridge.request('thread/compact/start', { threadId });
  }
}
