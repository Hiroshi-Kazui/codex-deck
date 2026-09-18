// Persistent evidence, content fingerprints and exclusive execution ownership.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export const ignored = new Set(['.git', '.harness', 'node_modules', 'out', 'dist', 'coverage', 'test-results', 'playwright-report']);
export const protectedPaths = ['AGENTS.md', 'tools/harness', 'milestones', 'docs/spec', 'docs/adr', '.gitignore'];
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(temp, file);
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function acquireLock(root) {
  const file = path.join(root, '.harness', 'lock.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  try { await fs.writeFile(file, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const old = await readJson(file);
    if (alive(old.pid)) throw new Error(`Harness already running (PID ${old.pid}). Use status or stop.`);
    const state = await readJson(path.join(root, '.harness', 'state.json')).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (state?.children?.some(alive)) throw new Error('A child from the previous run is still alive. Verify and close that process before resuming.');
    // Exclusive recovery lock prevents two resumptions from removing each other's lock.
    const recovery = `${file}.recover`;
    const handle = await fs.open(recovery, 'wx');
    try {
      const current = await readJson(file);
      if (current.token !== old.token) throw new Error('Lock changed during recovery; retry.');
      await fs.unlink(file);
      await fs.writeFile(file, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), { flag: 'wx' });
    } finally { await handle.close(); await fs.unlink(recovery); }
  }
  return async () => {
    const current = await readJson(file);
    if (current.token !== token) throw new Error('Lock ownership changed.');
    await fs.unlink(file);
  };
}
export async function snapshot(root) {
  const entries = {};
  async function visit(dir, prefix = '') {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(item.name) || item.name.endsWith('.tsbuildinfo')) continue;
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error(`Symlink/junction in source snapshot is unsupported: ${rel}`);
      if (item.isDirectory()) await visit(file, rel);
      else if (item.isFile()) entries[rel] = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await visit(root);
  return { hash: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
}
export function changed(before, after) {
  return [...new Set([...Object.keys(before.entries), ...Object.keys(after.entries)])].filter(k => before.entries[k] !== after.entries[k]);
}
export function protectedChanges(before, after) {
  return changed(before, after).filter(k => protectedPaths.some(p => k === p || k.startsWith(p + '/')));
}
export function inRoot(root, relative) {
  const result = path.resolve(root, relative);
  const rel = path.relative(root, result);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path must be inside workspace: ${relative}`);
  return result;
}
export async function appendEvent(root, event) {
  await fs.appendFile(path.join(root, '.harness', 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n');
}
