import { test, expect } from '@playwright/test';
import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

test('M1-01: Electron native ABI, isolated storage, and typed preload IPC work', async () => {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-deck-m1-'));
  const electron = await _electron.launch({
    args: ['.'], executablePath: require('electron') as string,
    env: { ...process.env, CODEX_DECK_TEST_APPDATA: isolatedRoot }
  });
  try {
    const page = await electron.firstWindow();
    const preferences = await electron.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      if (!contents) throw new Error('Main window is missing');
      const inspectable = contents as typeof contents & {
        getLastWebPreferences(): {
          contextIsolation?: boolean;
          nodeIntegration?: boolean;
          sandbox?: boolean;
        } | null;
      };
      if (typeof inspectable.getLastWebPreferences !== 'function') {
        throw new Error('Electron web preferences inspection is unavailable');
      }
      return inspectable.getLastWebPreferences();
    });
    expect(preferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    await expect(page.getByRole('status')).toHaveText('Native modules ready');
    await expect(page.getByRole('alert')).toHaveCount(0);
    const paths = await electron.evaluate(({ app }) => ({ appData: app.getPath('appData'), userData: app.getPath('userData') }));
    expect(paths.appData).toBe(isolatedRoot);
    expect(paths.userData).toBe(path.join(isolatedRoot, 'codex-deck'));
    const api = await page.evaluate(async () => ({
      keys: Object.keys(window.deck), status: await window.deck.getBootstrapStatus(),
      nodeRequire: typeof (window as unknown as { require?: unknown }).require
    }));
    expect(api.keys).toEqual(['getBootstrapStatus']);
    expect(api.nodeRequire).toBe('undefined');
    expect(api.status).toEqual({ ok: true, name: 'codex-deck', storagePath: paths.userData, native: { pty: true, sqlite: true } });
  } finally {
    await electron.close();
    const tempRoot = path.resolve(os.tmpdir());
    if (!path.resolve(isolatedRoot).startsWith(tempRoot + path.sep) || !path.basename(isolatedRoot).startsWith('codex-deck-m1-')) throw new Error('Refusing to remove test data outside temp');
    await rm(isolatedRoot, { recursive: true, force: true });
  }
});
