import { useEffect, useState } from 'react';
import type { BootstrapStatus } from '../../shared/ipc.js';

export function App(): JSX.Element {
  const [status, setStatus] = useState<BootstrapStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.deck.getBootstrapStatus().then((value) => { if (!cancelled) setStatus(value); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);
  return <main><h1>codex-deck</h1>{error || status?.ok === false
    ? <p role="alert">Startup failed: {error ?? (status && !status.ok ? status.error : 'Unknown error')}</p>
    : status?.ok ? <p role="status">Native modules ready</p> : <p role="status">Starting…</p>}</main>;
}
