'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { endpoints, getBaseUrl, getOpenOrders, getWsAuthQuery } from '@/api';
import type { LivePendingRow, LivePositionRow, OpenOrdersResponse } from '@/api';

const RECONNECT_DELAY_MS = 2000;

interface TerminalContextValue {
  positions: LivePositionRow[];
  pending: LivePendingRow[];
  serverNowMs: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const Ctx = createContext<TerminalContextValue | undefined>(undefined);

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [positions, setPositions] = useState<LivePositionRow[]>([]);
  const [pending, setPending] = useState<LivePendingRow[]>([]);
  const [serverNowMs, setServerNowMs] = useState<number>(() => Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getOpenOrders();
      setPositions(data.positions);
      setPending(data.pending);
      setServerNowMs(data.server_now_ms);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'open orders fetch failed');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    const applyPayload = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const data = raw as Partial<OpenOrdersResponse>;
      if (Array.isArray(data.positions)) setPositions(data.positions);
      if (Array.isArray(data.pending)) setPending(data.pending);
      if (typeof data.server_now_ms === 'number') setServerNowMs(data.server_now_ms);
      setError(null);
      setIsLoading(false);
    };

    const connect = async () => {
      if (isDisposed) return;
      try {
        const wsAuth = await getWsAuthQuery();
        if (!wsAuth) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
          return;
        }
        const baseUrl = await getBaseUrl();
        const wsBase = baseUrl.startsWith('https://')
          ? `wss://${baseUrl.slice('https://'.length)}`
          : baseUrl.startsWith('http://')
            ? `ws://${baseUrl.slice('http://'.length)}`
            : baseUrl;
        const params = new URLSearchParams({
          api_key: wsAuth.api_key,
          api_secret: wsAuth.api_secret,
        });
        const url = `${wsBase}${endpoints.orders.openWs}?${params.toString()}`;
        ws = new WebSocket(url);

        ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(String(event.data));
            applyPayload(payload);
          } catch {
          }
        };

        ws.onclose = () => {
          if (isDisposed) return;
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        };

        ws.onerror = () => {
          try {
            ws?.close();
          } catch {
          }
        };
      } catch (e) {
        setError(e instanceof Error ? e.message : 'open orders ws failed');
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    };

    void connect();

    return () => {
      isDisposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
      }
    };
  }, []);

  const value = useMemo<TerminalContextValue>(
    () => ({ positions, pending, serverNowMs, isLoading, error, refresh }),
    [positions, pending, serverNowMs, isLoading, error, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTerminal(): TerminalContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTerminal must be used inside TerminalProvider');
  return v;
}
