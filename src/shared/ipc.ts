export const APP_NAME = 'codex-deck' as const;
export const IPC_BOOTSTRAP = 'deck:bootstrap' as const;

export type BootstrapStatus =
  | { ok: true; name: typeof APP_NAME; storagePath: string; native: { pty: true; sqlite: true } }
  | { ok: false; name: typeof APP_NAME; storagePath: string; error: string };

export interface DeckApi {
  getBootstrapStatus(): Promise<BootstrapStatus>;
}
