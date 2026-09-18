import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startBridge } from '../../src/m0/bridge.ts';
import { appServerCommand, CliError, launchRemoteTui, remoteTuiCommand, resolveCodex, REQUIRED_CODEX_VERSION, type Cli } from '../../src/m0/cli.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeScript = path.join(here, 'fake-server.mjs');
const fakeCli: Cli = { executable: process.execPath, version: REQUIRED_CODEX_VERSION };

function spawnFake(env: NodeJS.ProcessEnv = process.env) {
  return spawn(process.execPath, [fakeScript], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
}

class TestWs {
  readonly socket: Socket;
  private buffer = Buffer.alloc(0);
  private messages: Record<string, unknown>[] = [];
  private waiters: ((message: Record<string, unknown>) => void)[] = [];
  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (data: Buffer) => this.read(data));
  }
  static async connect(url: string, token: string): Promise<TestWs> {
    const parsed = new URL(url);
    const socket = net.connect(Number(parsed.port), parsed.hostname);
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const nonce = randomBytes(16).toString('base64');
    socket.write(`GET / HTTP/1.1\r\nHost: ${parsed.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${nonce}\r\nAuthorization: Bearer ${token}\r\n\r\n`);
    let response = Buffer.alloc(0);
    while (!response.includes('\r\n\r\n')) {
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        socket.once('data', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('socket closed')));
      });
      response = Buffer.concat([response, chunk]);
    }
    const boundary = response.indexOf('\r\n\r\n') + 4;
    const header = response.subarray(0, boundary).toString();
    if (!header.startsWith('HTTP/1.1 101 ')) { socket.destroy(); throw new Error(`WebSocket handshake failed: ${header.split('\r\n')[0]}`); }
    const expected = createHash('sha1').update(`${nonce}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    assert.ok(header.includes(`Sec-WebSocket-Accept: ${expected}`));
    const ws = new TestWs(socket);
    if (boundary < response.length) ws.read(response.subarray(boundary));
    return ws;
  }
  send(message: Record<string, unknown>): void {
    const payload = Buffer.from(JSON.stringify(message));
    assert.ok(payload.length < 65536);
    const mask = randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
    const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 255]);
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  async next(): Promise<Record<string, unknown>> {
    const ready = this.messages.shift();
    if (ready) return ready;
    return await Promise.race([
      new Promise<Record<string, unknown>>((resolve) => this.waiters.push(resolve)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('WebSocket response timed out')), 3000)),
    ]);
  }
  close(): void { this.socket.destroy(); }
  private read(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 2) {
      let length = this.buffer[1]! & 127;
      let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      if (this.buffer.length < offset + length) return;
      const message = JSON.parse(this.buffer.subarray(offset, offset + length).toString()) as Record<string, unknown>;
      this.buffer = this.buffer.subarray(offset + length);
      const waiter = this.waiters.shift();
      if (waiter) waiter(message); else this.messages.push(message);
    }
  }
}

async function connectEventually(url: string, token: string): Promise<TestWs> {
  let last: unknown;
  for (let attempt = 0; attempt < 15; attempt++) {
    try { return await TestWs.connect(url, token); }
    catch (cause) { last = cause; await new Promise((resolve) => setTimeout(resolve, 30)); }
  }
  throw last;
}

async function finishInit(ws: TestWs): Promise<void> {
  ws.send({ method: 'initialized' });
  ws.send({ id: 99, method: 'test/echo' });
  assert.equal((await ws.next()).id, 99);
}

test('resolver handles Japanese and spaced paths, exact version, and launch failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex deck 日本語 '));
  try {
    const exe = path.join(directory, 'codex.exe');
    await writeFile(exe, 'fake');
    const resolved = await resolveCodex({ explicitPath: exe, probe: async () => 'codex-cli 0.154.0' });
    assert.equal(resolved.executable, exe);
    assert.equal(resolved.version, '0.154.0');
    const app = appServerCommand(resolved, directory);
    const tui = remoteTuiCommand(resolved, directory, 'ws://127.0.0.1:12345/', 'secret', {});
    assert.equal(app.executable, tui.executable);
    assert.equal(app.cwd, directory);
    assert.equal(tui.cwd, directory);
    assert.deepEqual(app.args, ['app-server', '--listen', 'stdio://']);
    assert.deepEqual(tui.args, ['--remote', 'ws://127.0.0.1:12345/', '--remote-auth-token-env', 'CODEX_DECK_REMOTE_TOKEN', '-C', directory]);
    assert.equal(tui.env.CODEX_DECK_REMOTE_TOKEN, 'secret');
    assert.ok(!tui.args.includes('secret'));
    await assert.rejects(resolveCodex({ explicitPath: exe, probe: async () => 'codex-cli 0.153.0' }), CliError);
    await assert.rejects(resolveCodex({ explicitPath: path.join(directory, 'missing.exe') }), CliError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual local Codex CLI resolves to 0.154.0 from PATH', async () => {
  const cli = await resolveCodex();
  assert.equal(cli.version, REQUIRED_CODEX_VERSION);
  assert.ok(cli.executable.toLowerCase().endsWith('codex.exe'));
});

test('TUI launch reports missing executable and invalid cwd without uncaught errors', async () => {
  const missing: Cli = { executable: path.join(os.tmpdir(), 'missing-codex.exe'), version: REQUIRED_CODEX_VERSION };
  await assert.rejects(launchRemoteTui(missing, process.cwd(), 'ws://127.0.0.1:1/', 'token'), /TUI launch failed/);
  const cli = await resolveCodex();
  await assert.rejects(launchRemoteTui(cli, path.join(os.tmpdir(), 'missing-codex-cwd'), 'ws://127.0.0.1:1/', 'token'), /TUI launch failed/);
  await assert.rejects(launchRemoteTui({ executable: process.execPath, version: REQUIRED_CODEX_VERSION },
    process.cwd(), 'ws://127.0.0.1:1/', 'token'), /TUI exited during startup/);
});

test('actual Codex 0.154.0 App Server completes stdio initialize and bridge handshake', async () => {
  const cli = await resolveCodex();
  const bridge = await startBridge({ cli, cwd: process.cwd() });
  let ws: TestWs | undefined;
  try {
    ws = await TestWs.connect(bridge.url, bridge.token);
    ws.send({ id: 17, method: 'initialize', params: { clientInfo: { name: 'test_tui', version: '0.0.0' } } });
    const response = await ws.next();
    assert.equal(response.id, 17);
    assert.ok(response.result && typeof response.result === 'object');
    ws.send({ method: 'initialized' });
  } finally { ws?.close(); await bridge.close(); }
});

test('bridge initializes stdio once and isolates app and TUI request IDs', async () => {
  const bridge = await startBridge({ cli: fakeCli, cwd: process.cwd(), spawnServer: spawnFake });
  let ws: TestWs | undefined;
  try {
    assert.match(bridge.url, /^ws:\/\/127\.0\.0\.1:\d+\/$/);
    assert.ok(bridge.token.length >= 40);
    await assert.rejects(bridge.request('test/echo'), /not initialized/);
    await assert.rejects(TestWs.connect(bridge.url, 'wrong'));
    ws = await TestWs.connect(bridge.url, bridge.token);
    const initParams = { clientInfo: { name: 'tui', version: '0.154.0' }, capabilities: { experimentalApi: true } };
    ws.send({ id: 1, method: 'initialize', params: initParams });
    assert.deepEqual(await ws.next(), { id: 1, result: { userAgent: 'fake-app-server', platformFamily: 'windows', initializeParams: initParams, initializeCount: 1 } });
    await finishInit(ws);
    const app = bridge.request('test/echo', { source: 'app' });
    ws.send({ id: 1, method: 'test/echo', params: { source: 'tui' } });
    const appResult = await app as { idSeen: string; params: { source: string }; initialized: boolean };
    const tuiResult = await ws.next();
    assert.match(appResult.idSeen, /^m0-app-/);
    assert.equal(appResult.initialized, true);
    assert.equal(tuiResult.id, 1);
    assert.match((tuiResult.result as { idSeen: string }).idSeen, /^m0-ws-/);
    assert.notEqual(appResult.idSeen, (tuiResult.result as { idSeen: string }).idSeen);
    ws.send({ id: 2, method: 'initialize' });
    assert.deepEqual(await ws.next(), { id: 2, error: { code: -32600, message: 'Already initialized' } });
  } finally { ws?.close(); await bridge.close(); }
});

test('reconnect reuses matching initialization and rejects changed capabilities', async () => {
  const bridge = await startBridge({ cli: fakeCli, cwd: process.cwd(), spawnServer: spawnFake });
  const params = { clientInfo: { name: 'tui' }, capabilities: { experimentalApi: true } };
  let ws: TestWs | undefined;
  try {
    ws = await TestWs.connect(bridge.url, bridge.token);
    ws.send({ id: 1, method: 'initialize', params });
    assert.equal((await ws.next()).id, 1);
    await finishInit(ws);
    ws.close();
    ws = await connectEventually(bridge.url, bridge.token);
    ws.send({ id: 2, method: 'initialize', params: { ...params, capabilities: { experimentalApi: false } } });
    assert.deepEqual(await ws.next(), { id: 2, error: { code: -32602, message: 'Initialize parameters differ from the active App Server connection' } });
    ws.close();
    ws = await connectEventually(bridge.url, bridge.token);
    ws.send({ id: 3, method: 'initialize', params });
    const response = await ws.next();
    assert.equal((response.result as { initializeCount: number }).initializeCount, 1);
    await finishInit(ws);
    assert.equal((await bridge.request('test/echo') as { initialized: boolean }).initialized, true);
  } finally { ws?.close(); await bridge.close(); }
});

test('server-origin request is routed back without colliding with client ID', async () => {
  const bridge = await startBridge({ cli: fakeCli, cwd: process.cwd(), spawnServer: spawnFake });
  let ws: TestWs | undefined;
  try {
    ws = await TestWs.connect(bridge.url, bridge.token);
    ws.send({ id: 1, method: 'initialize' }); await ws.next(); await finishInit(ws);
    await bridge.request('test/serverRequest');
    const request = await ws.next();
    assert.equal(request.method, 'approval/request');
    assert.match(String(request.id), /^m0-server-/);
    ws.send({ id: request.id, result: { decision: 'accept' } });
    assert.deepEqual(await ws.next(), { method: 'test/serverAnswer', params: { decision: 'accept' } });
  } finally { ws?.close(); await bridge.close(); }
});

test('TUI disconnect rejects unanswered server request and allows reconnect', async () => {
  const bridge = await startBridge({ cli: fakeCli, cwd: process.cwd(), spawnServer: spawnFake });
  let ws: TestWs | undefined;
  try {
    ws = await TestWs.connect(bridge.url, bridge.token);
    ws.send({ id: 1, method: 'initialize' }); await ws.next(); await finishInit(ws);
    await bridge.request('test/serverRequest');
    assert.equal((await ws.next()).method, 'approval/request');
    ws.close();
    ws = await connectEventually(bridge.url, bridge.token);
    ws.send({ id: 2, method: 'initialize' }); await ws.next();
    ws.send({ method: 'initialized' }); ws.send({ id: 99, method: 'test/echo' });
    let echo = await ws.next();
    if (echo.id !== 99) {
      assert.deepEqual(echo, { method: 'test/serverAnswer', params: { code: -32000, message: 'TUI connection lost' } });
      echo = await ws.next();
    }
    assert.equal(echo.id, 99);
    assert.deepEqual(await bridge.request('test/lastAnswer'), { code: -32000, message: 'TUI connection lost' });
  } finally { ws?.close(); await bridge.close(); }
});

test('asynchronous stdin write failure rejects pending request and terminates bridge', async () => {
  const bridge = await startBridge({ cli: fakeCli, cwd: process.cwd(), spawnServer: spawnFake });
  let ws: TestWs | undefined;
  try {
    ws = await TestWs.connect(bridge.url, bridge.token);
    ws.send({ id: 1, method: 'initialize' }); await ws.next(); await finishInit(ws);
    const stdin = bridge.child.stdin!;
    Object.defineProperty(stdin, 'write', { configurable: true, value: (_data: unknown, callback: (error: Error) => void) => {
      queueMicrotask(() => callback(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })));
      return false;
    } });
    await assert.rejects(bridge.request('test/echo'), /stdin write failed: broken pipe/);
    await assert.rejects(bridge.request('test/echo'), /stdin write failed: broken pipe/);
  } finally { ws?.close(); await bridge.close(); }
});

test('app-server early exit reports startup failure', async () => {
  const bridge = await startBridge({ cli: fakeCli, cwd: process.cwd(), startupTimeoutMs: 1000,
    spawnServer: () => spawnFake({ ...process.env, FAKE_EXIT: '1' }) });
  try {
    await new Promise<void>((resolve) => bridge.child.once('exit', () => resolve()));
    await assert.rejects(bridge.request('test/echo'), /exited \(7\)/);
  } finally { await bridge.close(); }
});

test('missing App Server executable reports spawn failure', async () => {
  await assert.rejects(startBridge({
    cli: { executable: path.join(os.tmpdir(), 'missing-codex-app-server.exe'), version: REQUIRED_CODEX_VERSION },
    cwd: process.cwd(),
  }), /App Server launch failed/);
});

test('approval waits for the TUI decision and unknown notifications cross both directions', async () => {
  const bridge = await startBridge({ cli: fakeCli, cwd: process.cwd(), spawnServer: spawnFake });
  let ws: TestWs | undefined;
  try {
    ws = await TestWs.connect(bridge.url, bridge.token);
    ws.send({ id: 1, method: 'initialize' }); await ws.next(); await finishInit(ws);
    await bridge.request('test/serverRequest');
    const approval = await ws.next();
    assert.equal(approval.method, 'approval/request');
    assert.deepEqual(await bridge.request('test/lastAnswer'), undefined);
    ws.send({ id: approval.id, result: { decision: 'decline' } });
    assert.deepEqual(await ws.next(), { method: 'test/serverAnswer', params: { decision: 'decline' } });
    assert.deepEqual(await bridge.request('test/lastAnswer'), { decision: 'decline' });
    await bridge.request('test/emitUnknown');
    assert.deepEqual(await ws.next(), { method: 'future/serverNotice', params: { marker: 'server-to-tui' } });
    ws.send({ method: 'future/clientNotice', params: { marker: 'tui-to-server' } });
    assert.deepEqual(await ws.next(), { method: 'test/unknownReceived', params: { marker: 'tui-to-server' } });
  } finally { ws?.close(); await bridge.close(); }
});

test('four independent connections isolate IDs and reject stopped or crashed generations', async () => {
  const bridges = await Promise.all(Array.from({ length: 4 }, () =>
    startBridge({ cli: fakeCli, cwd: process.cwd(), spawnServer: spawnFake })));
  const sockets: TestWs[] = [];
  let replacement: Awaited<ReturnType<typeof startBridge>> | undefined;
  let replacementSocket: TestWs | undefined;
  try {
    for (let i = 0; i < 4; i++) {
      const ws = await TestWs.connect(bridges[i]!.url, bridges[i]!.token);
      sockets.push(ws);
      ws.send({ id: 1, method: 'initialize', params: { clientInfo: { name: `pane-${i}`, version: '0.154.0' } } });
      assert.equal((await ws.next()).id, 1);
      await finishInit(ws);
    }
    const requests = bridges.map((bridge, i) => bridge.request('test/echo', { marker: `app-${i}` }));
    sockets.forEach((ws, i) => ws.send({ id: 7, method: 'test/echo', params: { marker: `tui-${i}` } }));
    const appResults = await Promise.all(requests) as { params: { marker: string } }[];
    const tuiResults = await Promise.all(sockets.map((ws) => ws.next()));
    for (let i = 0; i < 4; i++) {
      assert.equal(appResults[i]!.params.marker, `app-${i}`);
      assert.equal((tuiResults[i]!.result as { params: { marker: string } }).params.marker, `tui-${i}`);
      assert.equal(tuiResults[i]!.id, 7);
      assert.notEqual(bridges[i]!.token, bridges[(i + 1) % 4]!.token);
    }
    const stopped = bridges[2]!;
    sockets[2]!.close();
    await stopped.close();
    await assert.rejects(stopped.request('test/echo'), /Bridge closed/);
    replacement = await startBridge({ cli: fakeCli, cwd: process.cwd(), spawnServer: spawnFake });
    assert.notEqual(replacement.token, stopped.token);
    await assert.rejects(TestWs.connect(replacement.url, stopped.token));
    replacementSocket = await TestWs.connect(replacement.url, replacement.token);
    replacementSocket.send({ id: 1, method: 'initialize' });
    assert.equal((await replacementSocket.next()).id, 1);
    await finishInit(replacementSocket);
    assert.equal((await replacement.request('test/echo', { marker: 'replacement' }) as { params: { marker: string } }).params.marker, 'replacement');
    const crashed = bridges[3]!;
    crashed.child.kill();
    await new Promise<void>((resolve) => crashed.child.once('exit', () => resolve()));
    await assert.rejects(crashed.request('test/echo'), /App Server exited/);
    await assert.rejects(TestWs.connect(crashed.url, crashed.token));
    assert.equal((await bridges[0]!.request('test/echo', { marker: 'survivor' }) as { params: { marker: string } }).params.marker, 'survivor');
  } finally {
    replacementSocket?.close();
    sockets.forEach((ws) => ws.close());
    await Promise.allSettled([...bridges, ...(replacement ? [replacement] : [])].map((bridge) => bridge.close()));
  }
});

test('concurrent approval responses preserve original IDs including zero', async () => {
  const routed: { source: string; message: Readonly<Record<string, unknown>> }[] = [];
  const bridge = await startBridge({ cli: fakeCli, cwd: process.cwd(), spawnServer: spawnFake,
    onProtocolMessage: (source, message) => routed.push({ source, message }) });
  let ws: TestWs | undefined;
  try {
    ws = await TestWs.connect(bridge.url, bridge.token);
    ws.send({ id: 1, method: 'initialize' }); await ws.next(); await finishInit(ws);
    await Promise.all([bridge.request('test/serverRequest'), bridge.request('test/serverRequestZero')]);
    const approvals = [await ws.next(), await ws.next()];
    const zero = approvals.find((message) => Array.isArray((message.params as Record<string, unknown>)?.availableDecisions));
    const one = approvals.find((message) => message !== zero);
    assert.ok(zero && one);
    assert.equal(zero.method, 'approval/request');
    assert.equal(one.method, 'approval/request');
    assert.notEqual(zero.id, one.id);
    ws.send({ id: zero.id, result: { decision: 'cancel' } });
    ws.send({ id: one.id, result: { decision: 'decline' } });
    const answers = [await ws.next(), await ws.next()];
    assert.deepEqual(new Set(answers.map((answer) => answer.method)), new Set(['test/serverZeroAnswer', 'test/serverAnswer']));
    assert.deepEqual(await bridge.request('test/lastZeroAnswer'), { decision: 'cancel' });
    assert.deepEqual(await bridge.request('test/lastAnswer'), { decision: 'decline' });
    assert.ok(routed.some(({ source, message }) => source === 'app-server-write' && message.id === 0 &&
      (message.result as Record<string, unknown>)?.decision === 'cancel'));
    assert.ok(routed.some(({ source, message }) => source === 'app-server-write' && message.id === 1 &&
      (message.result as Record<string, unknown>)?.decision === 'decline'));
  } finally { ws?.close(); await bridge.close(); }
});
