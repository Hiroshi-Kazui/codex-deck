import type { DeckApi } from '../../shared/ipc.js';

declare global {
  interface Window { deck: DeckApi }
}

export {};
