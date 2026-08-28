import React, { useEffect, useState } from 'react';
import { LoadingScreen } from './LoadingScreen';

const POLL_INTERVAL_MS = 800;
const MAX_WAIT_MS = 120_000;

export const ApiStartupGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [apiReady, setApiReady] = useState(false);

  useEffect(() => {
    const check = window.electronAPI?.checkServerStatus;
    if (!check) {
      setApiReady(true);
      return;
    }

    let cancelled = false;
    const startAt = Date.now();

    const ensureApi = async () => {
      while (!cancelled) {
        try {
          if (Date.now() - startAt > MAX_WAIT_MS) {
            setApiReady(true);
            return;
          }
          const { ok } = await check();
          if (cancelled) return;
          if (ok) {
            setApiReady(true);
            return;
          }
        } catch {
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    };

    ensureApi();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!apiReady && window.electronAPI?.checkServerStatus) {
    return (
      <div className="h-full min-h-0">
        <LoadingScreen message="Starting app..." />
      </div>
    );
  }

  return <>{children}</>;
};
