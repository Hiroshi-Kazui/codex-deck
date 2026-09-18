import { contextBridge, ipcRenderer } from 'electron';
import { IPC_BOOTSTRAP, type BootstrapStatus, type DeckApi } from '../shared/ipc.js';

const api: DeckApi = Object.freeze({
  getBootstrapStatus: () => ipcRenderer.invoke(IPC_BOOTSTRAP) as Promise<BootstrapStatus>
});

contextBridge.exposeInMainWorld('deck', api);
