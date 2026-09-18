import path from 'node:path';
import { APP_NAME } from './ipc.js';

export function storageDirectory(appData: string): string {
  if (!path.isAbsolute(appData)) throw new Error('App data path must be absolute');
  return path.join(appData, APP_NAME);
}
