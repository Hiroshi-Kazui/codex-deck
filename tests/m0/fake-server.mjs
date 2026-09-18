import { createInterface } from 'node:readline';

if (process.env.FAKE_EXIT === '1') process.exit(7);
let initialized = false;
let initializeCount = 0;
let lastServerAnswer;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initializeCount++;
    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake-app-server', platformFamily: 'windows', initializeParams: message.params, initializeCount } }) + '\n');
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'test/echo') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { idSeen: message.id, params: message.params, initialized } }) + '\n');
  } else if (message.method === 'test/serverRequest') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { started: true } }) + '\n');
    process.stdout.write(JSON.stringify({ id: 1, method: 'approval/request', params: { message: 'ok?' } }) + '\n');
} else if (message.method === 'test/emitUnknown') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
    process.stdout.write(JSON.stringify({ method: 'future/serverNotice', params: { marker: 'server-to-tui' } }) + '\n');
  } else if (message.method === 'future/clientNotice') {
    process.stdout.write(JSON.stringify({ method: 'test/unknownReceived', params: message.params }) + '\n');
  } else if (message.method === 'test/lastAnswer') {
    process.stdout.write(JSON.stringify({ id: message.id, result: lastServerAnswer }) + '\n');
  } else if (message.id === 1 && (message.result || message.error)) {
    lastServerAnswer = message.result ?? message.error;
    process.stdout.write(JSON.stringify({ method: 'test/serverAnswer', params: lastServerAnswer }) + '\n');
  } else if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unknown' } }) + '\n');
  }
}
