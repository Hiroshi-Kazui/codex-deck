import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { startBridge, type Bridge } from '../../src/m0/bridge.ts';
import { resolveCodex, remoteTuiCommand } from '../../src/m0/cli.ts';

type Json = Record<string, unknown>;
type Pty = { write(data: string): void; kill(): void; onData(callback: (data: string) => void): void };
type PtyModule = { spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): Pty };
type Seen = { source: 'app-server' | 'tui'; method?: string; id?: string | number; threadId?: string; turnId?: string; itemType?: string; status?: string; decision?: string };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function obj(value: unknown): Json | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined; }
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function required(value: unknown, label: string): string { assert.ok(typeof value === 'string' && value.length > 0, `${label} missing`); return value; }
async function waitFor<T>(read: () => T | undefined, label: string, ms = 90_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) { const result = read(); if (result !== undefined) return result; await pause(100); }
  throw new Error(`Timed out waiting for ${label}`);
}
function ptyModule(): PtyModule {
  const require = createRequire(import.meta.url);
  const packagePath = process.env.CODEX_DECK_NODE_PTY ?? path.resolve(process.cwd(), '..', 'cockpit', 'node_modules', 'node-pty');
  try { return require(packagePath) as PtyModule; }
  catch (cause) { throw new Error(`Real ConPTY node-pty unavailable at ${packagePath}: ${String(cause)}`); }
}

test('M0-03.LIVE: real Codex 0.154.0 TUI/App Server lifecycle and approval', { timeout: 600_000 }, async () => {
  const cwd = path.resolve(process.cwd(), '.harness', 'live-workspaces', `m0-03-${Date.now()}`);
  const evidenceDir = path.resolve(process.cwd(), '.harness', 'evidence', 'M0-03');
  await mkdir(cwd, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const outcomes: Record<string, unknown> = {};
  const seen: Seen[] = [];
  let bridge: Bridge | undefined;
  let pty: Pty | undefined;
  let cliVersion = 'unresolved';
  let terminalTail = '';
  let failure: Error | undefined;
  try {
    const cli = await resolveCodex();
    cliVersion = cli.version;
    assert.equal(cliVersion, '0.154.0');
    const trust = `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`;
    bridge = await startBridge({
      cli, cwd,
      spawnServer: () => spawn(cli.executable, ['--config', trust, 'app-server', '--listen', 'stdio://'],
        { cwd, env: process.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }),
      onProtocolMessage: (source, message) => {
        const params = obj(message.params);
        const turn = obj(params?.turn);
        const item = obj(params?.item);
        const result = obj(message.result);
        seen.push({ source, method: string(message.method),
          id: typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined,
          threadId: string(params?.threadId), turnId: string(params?.turnId) ?? string(turn?.id),
          itemType: string(item?.type), status: string(turn?.status), decision: string(result?.decision) });
      },
    });
    const command = remoteTuiCommand(cli, cwd, bridge.url, bridge.token);
    const env = Object.fromEntries(Object.entries(command.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
    pty = ptyModule().spawn(command.executable, ['--config', trust, '--sandbox', 'read-only', '--ask-for-approval', 'on-request', ...command.args],
      { name: 'xterm-color', cols: 120, rows: 40, cwd, env });
    pty.onData((data) => { terminalTail = (terminalTail + data).slice(-4096); });
    const activeBridge = bridge;
    await waitFor(() => seen.some((event) => event.source === 'tui' && event.method === 'initialized') ? true : undefined,
      'real TUI initialized', 30_000);
    assert.doesNotMatch(terminalTail, /Do you trust the contents of this directory\?/);
    outcomes.tuiConnected = true;
    await activeBridge.request('thread/list', { limit: 1 });
    outcomes.appServerConnected = true;
    const started = obj(await activeBridge.request('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'read-only' }));
    const first = obj(started?.thread);
    const threadId = required(first?.id, 'thread/start thread ID');
    const sessionId = required(first?.sessionId, 'thread/start session ID');
    const defaultModel = required(started?.model, 'thread/start model');
    outcomes.newThread = { threadId, sessionId };
    async function runTurn(id: string, input: string, model?: string): Promise<string> {
      const reply = obj(await activeBridge.request('turn/start', { threadId: id, input: [{ type: 'text', text: input }], ...(model ? { model } : {}) }));
      const turnId = required(obj(reply?.turn)?.id, 'turn/start turn ID');
      const completed = await waitFor(() => seen.find((event) => event.source === 'app-server' && event.method === 'turn/completed' && event.threadId === id && event.turnId === turnId), `turn/completed ${turnId}`, 180_000);
      assert.equal(completed.status, 'completed', `turn ${turnId} status`);
      return turnId;
    }
    const firstTurnId = await runTurn(threadId, 'Reply exactly M0-03-LIVE-OK. Do not call tools or edit files.');
    outcomes.conversation = { turnId: firstTurnId, status: 'completed' };
    const resumed = obj(await activeBridge.request('thread/resume', { threadId }));
    const resumedThread = obj(resumed?.thread);
    assert.equal(resumedThread?.id, threadId);
    assert.equal(resumedThread?.sessionId, sessionId);
    outcomes.resume = { threadId };
    const forked = obj(await activeBridge.request('thread/fork', { threadId, lastTurnId: firstTurnId }));
    const fork = obj(forked?.thread);
    const forkId = required(fork?.id, 'thread/fork ID');
    assert.notEqual(forkId, threadId);
    if (fork?.forkedFromId !== null && fork?.forkedFromId !== undefined) assert.equal(fork.forkedFromId, threadId);
    outcomes.fork = { threadId: forkId, forkedFromId: threadId, sessionId: required(fork?.sessionId, 'fork session ID') };
    const models = obj(await activeBridge.request('model/list', {}));
    const choices = Array.isArray(models?.data) ? models.data.map((value) => obj(value)).filter((value): value is Json => value !== undefined) : [];
    const available = choices.map((value) => string(value.model) ?? string(value.id)).filter((value): value is string => !!value && value !== defaultModel);
    const changedModel = available.includes('gpt-5.6-terra') ? 'gpt-5.6-terra' : available[0];
    assert.ok(changedModel, `No second model available; model/list returned ${choices.length} entries`);
    const modelTurnId = await runTurn(forkId, 'Reply exactly M0-03-MODEL-OK. Do not call tools or edit files.', changedModel);
    const modelRead = obj(await activeBridge.request('thread/read', { threadId: forkId }));
    assert.equal(obj(modelRead?.thread)?.model, changedModel);
    outcomes.modelChange = { from: defaultModel, to: changedModel, turnId: modelTurnId };
    await activeBridge.request('thread/compact/start', { threadId: forkId });
    await waitFor(() => seen.find((event) => event.source === 'app-server' && event.method === 'item/started' && event.threadId === forkId && event.itemType === 'contextCompaction'),
      'real contextCompaction item', 180_000);
    outcomes.compact = { threadId: forkId, itemType: 'contextCompaction' };
    const approvalInput = 'For this integration check, attempt to create the file M0-03-approval-probe.txt in the current directory using a shell command. Ask for approval when required. If approval is denied, stop; do not retry or use another tool.';
    const approvalStartIndex = seen.length;
    pty.write(approvalInput);
    await pause(250);
    pty.write('\r');
    const tuiTurn = await waitFor(() => seen.slice(approvalStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'turn/started' && !!event.threadId && !!event.turnId),
      'TUI-submitted turn/started', 30_000);
    const approval = await waitFor(() => seen.slice(approvalStartIndex).find((event) => event.source === 'app-server' &&
      (event.method === 'item/commandExecution/requestApproval' || event.method === 'item/fileChange/requestApproval') &&
      event.threadId === tuiTurn.threadId && event.turnId === tuiTurn.turnId), 'TUI turn approval request', 180_000);
    pty.write('d');
    const declined = await waitFor(() => seen.slice(approvalStartIndex).find((event) => event.source === 'tui' &&
      event.decision === 'decline' && typeof event.id === 'string' && event.id.startsWith('m0-server-')),
      'TUI approval decline response', 30_000);
    await waitFor(() => seen.slice(approvalStartIndex).find((event) => event.source === 'app-server' &&
      event.method === 'turn/completed' && event.threadId === tuiTurn.threadId && event.turnId === tuiTurn.turnId),
      'post-approval TUI turn completion', 180_000);
    outcomes.approval = { requestMethod: approval.method, decision: declined.decision,
      threadId: tuiTurn.threadId, turnId: tuiTurn.turnId };
    await assert.rejects(access(path.join(cwd, 'M0-03-approval-probe.txt')));
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { try { pty?.kill(); } catch { /* already exited */ } await bridge?.close(); }
  const evidence = { task: 'M0-03', criterion: 'M0-03.LIVE', startedAt, finishedAt: new Date().toISOString(),
    cliVersion, status: failure ? 'FAIL' : 'PASS', outcomes,
    protocol: seen.filter((event) => event.method === 'turn/completed' || event.method === 'item/started' ||
      event.method === 'item/commandExecution/requestApproval' || event.method === 'item/fileChange/requestApproval' ||
      (event.source === 'tui' && event.decision !== undefined)),
    ...(failure ? { error: String(failure), trustPromptSeen: /Do you trust the contents of this directory\?/.test(terminalTail) } : {}) };
  await writeFile(path.join(evidenceDir, `live-${Date.now()}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  if (failure) throw failure;
});
