import { createHash, randomBytes } from 'node:crypto';
import { type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createInterface } from 'node:readline';
import { type Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { launchAppServer, type Cli } from './cli.ts';

type Message = Record<string, unknown>;
type JsonId = string | number;

function object(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function idOf(message: Message): JsonId | undefined {
  return typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined;
}
function key(id: JsonId): string { return `${typeof id}:${id}`; }

export class BridgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BridgeError';
  }
}

class Peer {
  private readonly socket: Socket;
  private bytes = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  onMessage: (message: Message) => void = () => {};
  onClose: () => void = () => {};

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.once('end', () => this.close());
    socket.once('close', () => { this.closed = true; this.onClose(); });
    socket.once('error', () => this.close());
  }
  receiveHead(head: Buffer): void { if (head.length) this.receive(head); }

  send(message: Message): void { this.frame(1, Buffer.from(JSON.stringify(message), 'utf8')); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }
  private frame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return;
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, length])
      : length <= 65535 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
      : Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0,
          (length / 0x1000000) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255]);
    this.socket.write(Buffer.concat([header, payload]));
  }
  private receive(chunk: Buffer): void {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    while (this.bytes.length >= 2) {
      const first = this.bytes[0]!;
      const second = this.bytes[1]!;
      const opcode = first & 15;
      const fin = (first & 0x80) !== 0;
      if ((second & 0x80) === 0 || (first & 0x70) !== 0) return this.close();
      let length = second & 127;
      let offset = 2;
      if (length === 126) {
        if (this.bytes.length < 4) return;
        length = this.bytes.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.bytes.length < 10) return;
        const large = this.bytes.readBigUInt64BE(2);
        if (large > 8_388_608n) return this.close();
        length = Number(large); offset = 10;
      }
      if (length > 8_388_608) return this.close();
      if (this.bytes.length < offset + 4 + length) return;
      const mask = this.bytes.subarray(offset, offset + 4);
      const payload = Buffer.from(this.bytes.subarray(offset + 4, offset + 4 + length));
      this.bytes = this.bytes.subarray(offset + 4 + length);
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      if (opcode === 8) return this.close();
      if (opcode === 9) { this.frame(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode === 0) {
        if (!this.fragmentOpcode) return this.close();
        this.fragments.push(payload);
      } else if (opcode === 1 && !this.fragmentOpcode) {
        this.fragmentOpcode = 1;
        this.fragments.push(payload);
      } else return this.close();
      if (this.fragments.reduce((total, part) => total + part.length, 0) > 8_388_608) return this.close();
      if (fin) {
        const body = Buffer.concat(this.fragments);
        this.fragments = []; this.fragmentOpcode = 0;
        if (body.length > 8_388_608) return this.close();
        try {
          const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
          if (!object(parsed)) return this.close();
          this.onMessage(parsed);
        } catch { return this.close(); }
      }
    }
  }
}

export type Bridge = {
  readonly url: string;
  readonly token: string;
  readonly child: ChildProcess;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
};

export type BridgeOptions = {
  cli: Cli;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  spawnServer?: () => ChildProcess;
  onProtocolMessage?: (source: 'app-server' | 'tui' | 'app-server-write' | 'tui-write', message: Readonly<Record<string, unknown>>) => void;
};

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const child = options.spawnServer?.() ?? launchAppServer(options.cli, options.cwd, options.env);
  if (!child.stdin || !child.stdout || !child.stderr) throw new BridgeError('App Server stdio unavailable');
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  const token = randomBytes(32).toString('base64url');
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const wsPending = new Map<string, JsonId>();
  const serverRequests = new Map<string, JsonId>();
  let nextId = 0;
  let peer: Peer | undefined;
  let peerState: 'disconnected' | 'initializing' | 'awaitingInitialized' | 'ready' = 'disconnected';
  let initParams: unknown;
  let initResult: unknown;
  let initInFlight = false;
  let upstreamInitialized = false;
  let failure: Error | undefined;
  let stderrTail = '';
  let closing = false;
  const server: Server = createServer((_request, response) => { response.writeHead(404).end(); });

  function write(message: Message): void {
    if (failure) throw failure;
    if (stdin.destroyed || !stdin.writable) throw new BridgeError('App Server stdin closed');
    try {
      stdin.write(`${JSON.stringify(message)}\n`, (cause?: Error | null) => {
        if (cause) fail(new BridgeError(`App Server stdin write failed: ${cause.message}`, { cause }));
      });
      options.onProtocolMessage?.('app-server-write', Object.freeze({ ...message }));
    } catch (cause) {
      const error = new BridgeError(`App Server stdin write failed: ${String(cause)}`, { cause });
      fail(error);
      throw error;
    }
  }
  function rejectPending(error: Error): void {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear(); wsPending.clear(); serverRequests.clear();
  }
  function fail(error: Error): void {
    if (failure) return;
    failure = error;
    rejectPending(error);
    peer?.close();
    if (server.listening) server.close();
    if (child.exitCode === null) child.kill();
  }
  const lines = createInterface({ input: stdout });
  lines.on('line', (line) => {
    if (closing || failure) return;
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { fail(new BridgeError('App Server sent invalid JSON')); return; }
    if (!object(message)) { fail(new BridgeError('App Server sent a non-object message')); return; }
    try { options.onProtocolMessage?.('app-server', Object.freeze({ ...message })); }
    catch (cause) { fail(new BridgeError(`Protocol observer failed: ${String(cause)}`, { cause })); return; }
    const id = idOf(message);
    if (id !== undefined && typeof message.method !== 'string') {
      const route = pending.get(key(id));
      if (route) {
        pending.delete(key(id));
        if ('error' in message) route.reject(new BridgeError(`App Server request failed: ${JSON.stringify(message.error)}`));
        else route.resolve(message.result);
        return;
      }
      const original = wsPending.get(key(id));
      if (original !== undefined) {
        wsPending.delete(key(id));
        peer?.send({ ...message, id: original });
      }
      return;
    }
    if (id !== undefined && typeof message.method === 'string') {
      if (!peer || peerState !== 'ready') {
        write({ id, error: { code: -32000, message: 'TUI connection unavailable' } });
        return;
      }
      const forwarded = `m0-server-${++nextId}`;
      serverRequests.set(key(forwarded), id);
      try { options.onProtocolMessage?.('tui-write', Object.freeze({ ...message, id: forwarded })); }
      catch (cause) { fail(new BridgeError(`Protocol observer failed: ${String(cause)}`, { cause })); return; }
      peer.send({ ...message, id: forwarded });
      return;
    }
    if (peerState === 'ready') {
      try { options.onProtocolMessage?.('tui-write', Object.freeze({ ...message })); peer?.send(message); }
      catch (cause) { fail(new BridgeError(`TUI notification forwarding failed: ${String(cause)}`, { cause })); }
    }
  });
  stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2048); });
  stdin.on('error', (cause) => fail(new BridgeError(`App Server stdin error: ${cause.message}`, { cause })));
  stdin.on('close', () => { if (!closing) fail(new BridgeError('App Server stdin closed')); });
  child.once('error', (cause) => fail(new BridgeError(`App Server launch failed: ${cause.message}`, { cause })));
  child.once('exit', (code, signal) => {
    if (!closing) fail(new BridgeError(`App Server exited (${code ?? signal}): ${stderrTail}`));
  });

  async function requestInternal(method: string, params?: unknown): Promise<unknown> {
    if (closing) throw new BridgeError('Bridge closed');
    if (failure) throw failure;
    const id = `m0-app-${++nextId}`;
    return await new Promise((resolve, reject) => {
      pending.set(key(id), { resolve, reject });
      try { write({ method, id, ...(params === undefined ? {} : { params }) }); }
      catch (error) { pending.delete(key(id)); reject(error); }
    });
  }
  async function request(method: string, params?: unknown): Promise<unknown> {
    if (closing) throw new BridgeError('Bridge closed');
    if (failure) throw failure;
    if (!upstreamInitialized) throw new BridgeError('App Server is not initialized by the TUI');
    return await requestInternal(method, params);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (cause) => reject(new BridgeError(`App Server launch failed: ${cause.message}`, { cause })));
    });
    server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      if (request.url !== '/' || request.headers.authorization !== `Bearer ${token}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
      }
      if (peer) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
      const keyHeader = request.headers['sec-websocket-key'];
      if (request.headers.upgrade?.toLowerCase() !== 'websocket' || typeof keyHeader !== 'string') {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
      }
      const accept = createHash('sha1').update(`${keyHeader}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const current = new Peer(socket);
      peer = current;
      peerState = 'disconnected';
      current.onClose = () => {
        if (peer !== current) return;
        peer = undefined; peerState = 'disconnected';
        wsPending.clear();
        const unanswered = [...serverRequests.values()];
        serverRequests.clear();
        if (closing || failure) return;
        for (const upstreamId of unanswered) {
          try { write({ id: upstreamId, error: { code: -32000, message: 'TUI connection lost' } }); }
          catch (cause) { fail(new BridgeError(`Could not reject server request after TUI disconnect: ${String(cause)}`, { cause })); }
        }
      };
      current.onMessage = (message) => {
        if (closing || failure || peer !== current) return;
        try {
        options.onProtocolMessage?.('tui', Object.freeze({ ...message }));
        const id = idOf(message);
        if (peerState === 'disconnected') {
          if (message.method === 'initialize' && id !== undefined) {
            if (initResult !== undefined) {
              if (!isDeepStrictEqual(message.params, initParams)) {
                current.send({ id, error: { code: -32602, message: 'Initialize parameters differ from the active App Server connection' } });
                return;
              }
              peerState = 'awaitingInitialized';
              current.send({ id, result: initResult });
              return;
            }
            if (initInFlight) {
              current.send({ id, error: { code: -32000, message: 'App Server initialize is still in progress' } });
              return;
            }
            peerState = 'initializing';
            initInFlight = true;
            initParams = message.params;
            let timer: ReturnType<typeof setTimeout> | undefined;
            void Promise.race([
              requestInternal('initialize', initParams),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new BridgeError('App Server initialize timed out')), options.startupTimeoutMs ?? 10_000);
              }),
            ]).then((result) => {
              initInFlight = false;
              if (failure) return;
              initResult = result;
              if (peer !== current) return;
              peerState = 'awaitingInitialized';
              current.send({ id, result });
            }).catch((cause) => {
              initInFlight = false;
              if (peer === current) current.send({ id, error: { code: -32000, message: `App Server initialize failed: ${String(cause)}` } });
              fail(new BridgeError(`App Server initialize failed: ${String(cause)}`, { cause }));
            }).finally(() => { if (timer) clearTimeout(timer); });
          } else current.close();
          return;
        }
        if (peerState === 'initializing') { current.close(); return; }
        if (peerState === 'awaitingInitialized') {
          if (message.method === 'initialized' && id === undefined) {
            if (!upstreamInitialized) {
              write({ method: 'initialized' });
              upstreamInitialized = true;
            }
            peerState = 'ready';
          }
          else current.close();
          return;
        }
        if (message.method === 'initialize') {
          if (id !== undefined) current.send({ id, error: { code: -32600, message: 'Already initialized' } });
          return;
        }
        if (message.method === 'initialized') return;
        if (id !== undefined && typeof message.method !== 'string') {
          const original = serverRequests.get(key(id));
          if (original !== undefined) {
            serverRequests.delete(key(id));
            write({ ...message, id: original });
          }
          return;
        }
        if (id !== undefined) {
          if (Array.from(wsPending.values()).some((value) => key(value) === key(id))) {
            current.send({ id, error: { code: -32600, message: 'Duplicate pending request ID' } });
            return;
          }
          const forwarded = `m0-ws-${++nextId}`;
          wsPending.set(key(forwarded), id);
          write({ ...message, id: forwarded });
        } else write(message);
        } catch (cause) {
          fail(new BridgeError(`Bridge forwarding failed: ${String(cause)}`, { cause }));
        }
      };
      current.receiveHead(head);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.on('error', (cause) => fail(new BridgeError(`Bridge listener failed: ${cause.message}`, { cause })));
    const address = server.address();
    if (!address || typeof address === 'string') throw new BridgeError('Bridge did not bind a TCP port');
    return {
      url: `ws://127.0.0.1:${address.port}/`, token, child, request,
      close: async () => {
        if (closing) return;
        closing = true;
        peer?.close();
        rejectPending(new BridgeError('Bridge closed'));
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (child.exitCode === null) child.kill();
      },
    };
  } catch (cause) {
    closing = true;
    child.kill();
    if (server.listening) server.close();
    throw cause;
  }
}
