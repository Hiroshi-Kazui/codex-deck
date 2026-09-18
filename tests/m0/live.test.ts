import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { startBridge, type Bridge } from '../../src/m0/bridge.ts';
import { resolveCodex, remoteTuiCommand } from '../../src/m0/cli.ts';

type Json = Record<string, unknown>;
const LIVE_MARKER = 'M0-03-LIVE-OK';
const MODEL_MARKER = 'M0-03-MODEL-OK';
type Pty = { write(data: string): void; kill(): void; onData(callback: (data: string) => void): void };
type PtyModule = { spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): Pty };
type Seen = { source: 'app-server' | 'tui' | 'app-server-write' | 'tui-write'; method?: string; id?: string | number; threadId?: string; turnId?: string; itemType?: string; itemId?: string; messageMarker?: string; status?: string; decision?: string; availableDecisions?: string[] | null; threadResultId?: string; responseSessionId?: string; responseModel?: string };
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
  const connectionGeneration = randomUUID();
  const previousSystemDrive = process.env.SystemDrive;
  const systemDrive = path.parse(cwd).root.slice(0, 2);
  process.env.SystemDrive = systemDrive;
  let bridge: Bridge | undefined;
  let pty: Pty | undefined;
  let cliVersion = 'unresolved';
  let terminalTail = '';
  let terminalWindow = '';
  const renderedMarkers = new Set<string>();
  let failure: Error | undefined;
  try {
    const cli = await resolveCodex();
    cliVersion = cli.version;
    assert.equal(cliVersion, '0.154.0');
    const trust = `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`;
    const notice = 'notice.hide_rate_limit_model_nudge=true';
    bridge = await startBridge({
      cli, cwd,
      spawnServer: () => spawn(cli.executable, ['--config', trust, '--config', notice, 'app-server', '--listen', 'stdio://'],
        { cwd, env: process.env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }),
      onProtocolMessage: (source, message) => {
        const params = obj(message.params);
        const turn = obj(params?.turn);
        const item = obj(params?.item);
        const result = obj(message.result);
        const availableDecisions = Array.isArray(params?.availableDecisions) ? params.availableDecisions.filter((decision): decision is string => typeof decision === 'string') : params?.availableDecisions === null || params?.availableDecisions === undefined ? null : undefined;
        seen.push({ source, method: string(message.method),
          id: typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined,
          threadId: string(params?.threadId), turnId: string(params?.turnId) ?? string(turn?.id),
          itemType: string(item?.type), itemId: string(item?.id),
          messageMarker: message.method === 'item/completed' && item?.type === 'agentMessage' &&
            (item?.text === LIVE_MARKER || item?.text === MODEL_MARKER) ? item.text as string : undefined,
          status: string(turn?.status), decision: string(result?.decision), availableDecisions,
          threadResultId: string(obj(result?.thread)?.id), responseSessionId: string(obj(result?.thread)?.sessionId),
          responseModel: string(result?.model) ?? string(obj(result?.thread)?.model) });
      },
    });
    const command = remoteTuiCommand(cli, cwd, bridge.url, bridge.token);
    const env = Object.fromEntries(Object.entries(command.env).filter((pair): pair is [string, string] => typeof pair[1] === 'string'));
    env.SystemDrive = systemDrive;
    pty = ptyModule().spawn(command.executable, ['--config', trust, '--config', notice, '--sandbox', 'read-only', '--ask-for-approval', 'on-request', ...command.args],
      { name: 'xterm-color', cols: 120, rows: 40, cwd, env });
    pty.onData((data) => {
      terminalTail = (terminalTail + data).slice(-4096);
      terminalWindow = (terminalWindow + data).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').slice(-16384);
      for (const marker of [LIVE_MARKER, MODEL_MARKER]) if (terminalWindow.includes(marker)) renderedMarkers.add(marker);
    });
    const activeBridge = bridge;
    await waitFor(() => seen.some((event) => event.source === 'tui' && event.method === 'initialized') ? true : undefined,
      'real TUI initialized', 30_000);
    assert.doesNotMatch(terminalTail, /Do you trust the contents of this directory\?/);
    outcomes.tuiConnected = true;
    await activeBridge.request('thread/list', { limit: 1 });
    outcomes.appServerConnected = true;
    const conversationStartIndex = seen.length;
    terminalWindow = '';
    pty.write('Reply with only these four parts joined with hyphens: M0, 03, LIVE, OK. Do not call tools or edit files.');
    await pause(250);
    pty.write('\r');
    const submitted = await waitFor(() => seen.slice(conversationStartIndex).find((event) =>
      event.source === 'tui' && event.method === 'turn/start' && !!event.threadId),
      'TUI-originated turn/start', 30_000);
    const threadId = required(submitted.threadId, 'TUI turn thread ID');
    const firstStarted = await waitFor(() => seen.slice(conversationStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'turn/started' && event.threadId === threadId && !!event.turnId),
      'TUI turn/started', 30_000);
    const firstTurnId = required(firstStarted.turnId, 'TUI turn ID');
    const firstMessage = await waitFor(() => seen.slice(conversationStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'item/completed' && event.threadId === threadId &&
      event.turnId === firstTurnId && event.itemType === 'agentMessage' && event.messageMarker === LIVE_MARKER),
      'exact completed agentMessage', 180_000);
    const firstItemId = required(firstMessage.itemId, 'completed agentMessage item ID');
    await waitFor(() => seen.slice(conversationStartIndex).find((event) =>
      event.source === 'tui-write' && event.method === 'item/completed' && event.threadId === threadId &&
      event.turnId === firstTurnId && event.itemId === firstItemId && event.messageMarker === LIVE_MARKER),
      'agentMessage delivered to TUI', 30_000);
    const firstCompleted = await waitFor(() => seen.slice(conversationStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'turn/completed' && event.threadId === threadId && event.turnId === firstTurnId),
      'TUI turn/completed', 180_000);
    assert.equal(firstCompleted.status, 'completed');
    await waitFor(() => renderedMarkers.has(LIVE_MARKER) ? true : undefined, 'TUI rendered exact answer', 30_000);
    const firstRead = obj(await activeBridge.request('thread/read', { threadId }));
    const first = obj(firstRead?.thread);
    assert.equal(first?.id, threadId);
    const bootstrap = seen.find((event) => event.source === 'app-server' && event.threadResultId === threadId && event.responseSessionId);
    const sessionId = required(first?.sessionId ?? bootstrap?.responseSessionId, 'TUI thread session ID');
    const defaultModel = required(first?.model ?? bootstrap?.responseModel, 'TUI thread model');
    outcomes.newThread = { threadId, sessionId, origin: 'tui' };
    outcomes.conversation = { threadId, turnId: firstTurnId, itemId: firstItemId,
      status: firstCompleted.status, exactAgentMessage: true, deliveredToTui: true, renderedInTui: true };
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
    const modelStartIndex = seen.length;
    const modelReply = obj(await activeBridge.request('turn/start', { threadId: forkId,
      input: [{ type: 'text', text: 'Reply with only these four parts joined with hyphens: M0, 03, MODEL, OK. Do not call tools or edit files.' }],
      model: changedModel }));
    const modelTurnId = required(obj(modelReply?.turn)?.id, 'model turn ID');
    const modelMessage = await waitFor(() => seen.slice(modelStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'item/completed' && event.threadId === forkId &&
      event.turnId === modelTurnId && event.itemType === 'agentMessage' && event.messageMarker === MODEL_MARKER),
      'model exact completed agentMessage', 180_000);
    const modelItemId = required(modelMessage.itemId, 'model message item ID');
    const modelCompleted = await waitFor(() => seen.slice(modelStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'turn/completed' && event.threadId === forkId && event.turnId === modelTurnId),
      'model turn/completed', 180_000);
    assert.equal(modelCompleted.status, 'completed');
    const modelRead = obj(await activeBridge.request('thread/read', { threadId: forkId }));
    assert.equal(obj(modelRead?.thread)?.model, changedModel);
    outcomes.modelChange = { from: defaultModel, to: changedModel, turnId: modelTurnId, itemId: modelItemId, exactAgentMessage: true };
    const compactStartIndex = seen.length;
    const compactReply = obj(await activeBridge.request('thread/compact/start', { threadId: forkId }));
    assert.deepEqual(compactReply, {});
    const compactStarted = await waitFor(() => seen.slice(compactStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'item/started' && event.threadId === forkId && event.itemType === 'contextCompaction'),
      'contextCompaction item/started', 180_000);
    const compactTurnId = required(compactStarted.turnId, 'compaction turn ID');
    const compactItemId = required(compactStarted.itemId, 'compaction item ID');
    await waitFor(() => seen.slice(compactStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'item/completed' && event.threadId === forkId &&
      event.turnId === compactTurnId && event.itemId === compactItemId && event.itemType === 'contextCompaction'),
      'contextCompaction item/completed', 180_000);
    const compactCompleted = await waitFor(() => seen.slice(compactStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'turn/completed' && event.threadId === forkId && event.turnId === compactTurnId),
      'compaction turn/completed', 180_000);
    assert.equal(compactCompleted.status, 'completed');
    outcomes.compact = { threadId: forkId, turnId: compactTurnId, itemId: compactItemId, status: compactCompleted.status };
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
    assert.notEqual(approval.id, undefined, 'approval request ID missing');
    assert.notEqual(approval.availableDecisions, undefined, 'invalid availableDecisions shape');
    const availableDecisions = approval.availableDecisions!;
    const effectiveDecisions = availableDecisions ?? ['accept', 'acceptForSession', 'cancel'];
    const rejectDecision = effectiveDecisions.includes('cancel') ? 'cancel'
      : effectiveDecisions.includes('decline') ? 'decline' : undefined;
    assert.ok(rejectDecision, 'No rejection in availableDecisions: ' + effectiveDecisions.join(', '));
    const forwarded = await waitFor(() => seen.slice(approvalStartIndex).find((event) =>
      event.source === 'tui-write' && event.method === approval.method && event.threadId === tuiTurn.threadId &&
      event.turnId === tuiTurn.turnId), 'forwarded approval request ID');
    assert.notEqual(forwarded.id, undefined, 'forwarded approval ID missing');
    pty.write(rejectDecision === 'cancel' ? '\x1b' : 'd');
    const rejected = await waitFor(() => seen.slice(approvalStartIndex).find((event) =>
      event.source === 'tui' && event.id === forwarded.id &&
      (event.decision === 'cancel' || event.decision === 'decline')),
      'TUI approval rejection response', 30_000);
    assert.ok(effectiveDecisions.includes(rejected.decision!), 'TUI chose an unavailable decision');
    const upstream = await waitFor(() => seen.slice(approvalStartIndex).find((event) =>
      event.source === 'app-server-write' && event.id === approval.id && event.decision === rejected.decision),
      'approval response to App Server original ID', 30_000);
    const completedApproval = await waitFor(() => seen.slice(approvalStartIndex).find((event) =>
      event.source === 'app-server' && event.method === 'turn/completed' &&
      event.threadId === tuiTurn.threadId && event.turnId === tuiTurn.turnId),
      'post-approval TUI turn completion', 180_000);
    assert.ok(completedApproval.status === 'completed' || completedApproval.status === 'interrupted', 'Unexpected approval turn status: ' + completedApproval.status);
    outcomes.approval = { connectionGeneration, requestMethod: approval.method,
      availableDecisions, effectiveDecisions, requestedDecision: rejectDecision, decision: rejected.decision,
      appServerRequestId: approval.id, tuiRequestId: forwarded.id, appServerResponseId: upstream.id,
      threadId: tuiTurn.threadId, turnId: tuiTurn.turnId, status: completedApproval.status };
    await assert.rejects(access(path.join(cwd, 'M0-03-approval-probe.txt')));
  } catch (cause) { failure = cause instanceof Error ? cause : new Error(String(cause)); }
  finally { try { pty?.kill(); } catch { /* already exited */ } await bridge?.close();
    if (previousSystemDrive === undefined) delete process.env.SystemDrive; else process.env.SystemDrive = previousSystemDrive; }
  const evidence = { task: 'M0-03', criterion: 'M0-03.LIVE', startedAt, finishedAt: new Date().toISOString(),
    cliVersion, connectionGeneration, status: failure ? 'FAIL' : 'PASS', outcomes,
    protocol: seen.filter((event) => event.method === 'turn/completed' || event.method === 'item/started' || event.method === 'item/completed' ||
      event.method === 'item/commandExecution/requestApproval' || event.method === 'item/fileChange/requestApproval' ||
      (event.source === 'tui' && event.decision !== undefined) ||
      (event.source === 'tui-write' && (event.method === 'item/commandExecution/requestApproval' || event.method === 'item/fileChange/requestApproval')) ||
      (event.source === 'app-server-write' && event.decision !== undefined)),
    ...(failure ? { error: String(failure), trustPromptSeen: /Do you trust the contents of this directory\?/.test(terminalTail) } : {}) };
  await writeFile(path.join(evidenceDir, `live-${Date.now()}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  if (failure) throw failure;
});
