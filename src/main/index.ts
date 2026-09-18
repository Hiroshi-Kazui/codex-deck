import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, IPC_BOOTSTRAP, type BootstrapStatus } from '../shared/ipc.js';
import { storageDirectory } from '../shared/storage.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probeNative(storagePath: string): Promise<BootstrapStatus> {
  try {
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const database = new Database(':memory:');
    try {
      const row = database.prepare('SELECT 1 AS value').get() as { value: number };
      if (row.value !== 1) throw new Error('SQLite query failed');
    } finally {
      database.close();
    }
    const pty = require('node-pty') as typeof import('node-pty');
    await new Promise<void>((resolve, reject) => {
      let child: import('node-pty').IPty;
      try {
        child = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'exit', '0'], {
          name: 'xterm', cols: 80, rows: 24, cwd: storagePath, env: process.env
        });
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('ConPTY probe timed out'));
      }, 10_000);
      child.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode === 0) resolve(); else reject(new Error('ConPTY probe exited ' + exitCode));
      });
    });
    return { ok: true, name: APP_NAME, storagePath, native: { pty: true, sqlite: true } };
  } catch (error) {
    return { ok: false, name: APP_NAME, storagePath, error: errorMessage(error) };
  }
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: {
      preload: path.join(dirname, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  window.once('ready-to-show', () => window.show());
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(path.join(dirname, '../renderer/index.html'));
  }
}

function applyTestAppDataOverride(): void {
  const raw = process.env.CODEX_DECK_TEST_APPDATA;
  if (raw === undefined) return;
  if (app.isPackaged || !path.isAbsolute(raw)) throw new Error('Invalid test AppData override');
  const candidate = path.resolve(raw);
  const relative = path.relative(path.resolve(os.tmpdir()), candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      !path.basename(candidate).startsWith('codex-deck-m1-') ||
      !statSync(candidate).isDirectory()) {
    throw new Error('Test AppData override must be an existing codex-deck-m1-* directory under the OS temp directory');
  }
  app.setPath('appData', candidate);
}

let storagePath: string;
try {
  app.setName(APP_NAME);
  applyTestAppDataOverride();
  storagePath = storageDirectory(app.getPath('appData'));
  mkdirSync(storagePath, { recursive: true });
  app.setPath('userData', storagePath);
} catch (error) {
  dialog.showErrorBox('codex-deck storage error', errorMessage(error));
  app.quit();
  throw error;
}

void app.whenReady().then(async () => {
  const status = await probeNative(storagePath);
  ipcMain.handle(IPC_BOOTSTRAP, () => status);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error: unknown) => {
  dialog.showErrorBox('codex-deck startup error', errorMessage(error));
  app.quit();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
