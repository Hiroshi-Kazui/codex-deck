import { useEffect, useState } from 'react';
import type { BootstrapStatus } from '../../shared/ipc.js';

export function App(): JSX.Element {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const bridge = window.deck;
        if (!bridge || typeof bridge.getBootstrapStatus !== 'function') {
          throw new Error('App bridge is unavailable. Restart codex-deck.');
        }
        const result = await bridge.getBootstrapStatus();
        if (active) setStatus(result);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => { active = false; };
  }, []);
  return <main><h1>codex-deck</h1>{error || status?.ok === false
    ? <p role="alert">Startup failed: {error ?? (status && !status.ok ? status.error : 'Unknown error')}</p>
    : status?.ok ? <p role="status">Native modules ready</p> : <p role="status">Starting…</p>}</main>;
}
