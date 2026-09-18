import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { storageDirectory } from '../../src/shared/storage.js';

describe('storageDirectory', () => {
  it('keeps codex-deck separate from cockpit under an absolute AppData root', () => {
    const appData = path.resolve(os.tmpdir(), 'isolated-appdata');
    expect(storageDirectory(appData)).toBe(path.join(appData, 'codex-deck'));
    expect(storageDirectory(appData)).not.toBe(path.join(appData, 'cockpit'));
  });
  it('rejects a relative root', () => {
    expect(() => storageDirectory('relative')).toThrow('App data path must be absolute');
  });
});
