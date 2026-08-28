'use client';

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

export const FLASH_DURATION_MS = 600;
export const FLASH_TRANSITION_MS = FLASH_DURATION_MS / 2;
import { endpoints, getBaseUrl, getWsAuthQuery } from '@/api';

export interface AccountInfoDto {
  account_id: string;
  server?: string | null;
  currency?: string | null;
  balance?: number | null;
  equity?: number | null;
  unrealized_pnl?: number | null;
  leverage?: number | null;
  margin?: number | null;
}

export interface AccountOrdersItem {
  account_id: string;
  open_orders: number;
  pending_orders: number;
  balance?: number | null;
  pnl?: number | null;
  equity?: number | null;
  account?: AccountInfoDto | null;
}

interface AggregatePayload {
  type?: string;
  open_orders?: number;
  pending_orders?: number;
  accounts?: AccountOrdersItem[];
}

export interface OrdersByAccountId {
  balance: number | null;
  pnl: number | null;
  equity: number | null;
  openTrades: number;
  pendingTrades: number;
}

export type OrdersByAccountIdRecord = Record<string, OrdersByAccountId>;

interface AccountOrdersContextType {
  openOrders: number;
  pendingOrders: number;
  openFlash: 'up' | 'down' | null;
  pendingFlash: 'up' | 'down' | null;
  flashingAccountIds: Set<string>;
  ordersByAccountId: OrdersByAccountIdRecord;
  ordersUpdateTrigger: number;
}

const AccountOrdersContext = createContext<AccountOrdersContextType | null>(null);

export function AccountOrdersProvider({ children }: { children: React.ReactNode }) {
  const [openOrders, setOpenOrders] = useState(0);
  const [pendingOrders, setPendingOrders] = useState(0);
  const [openFlash, setOpenFlash] = useState<'up' | 'down' | null>(null);
  const [pendingFlash, setPendingFlash] = useState<'up' | 'down' | null>(null);
  const [flashingAccountIds, setFlashingAccountIds] = useState<Set<string>>(new Set());
  const [ordersByAccountId, setOrdersByAccountId] = useState<OrdersByAccountIdRecord>({});
  const [ordersUpdateTrigger, setOrdersUpdateTrigger] = useState(0);
  const prevOpenRef = useRef(0);
  const prevPendingRef = useRef(0);
  const prevByAccountRef = useRef<Map<string, { open: number; pending: number }>>(new Map());
  const flashTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isDisposed = false;

    const connect = async () => {
      if (isDisposed) return;
      try {
        const wsAuth = await getWsAuthQuery();
        if (!wsAuth) {
          reconnectTimer = setTimeout(connect, 2000);
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
        const url = `${wsBase}${endpoints.accounts.orders}?${params.toString()}`;
        ws = new WebSocket(url);

        ws.onmessage = (event) => {
          try {
            const payload = JSON.parse(String(event.data)) as AggregatePayload;
            const newOpen = Number(payload.open_orders ?? 0);
            const newPending = Number(payload.pending_orders ?? 0);

            if (newOpen !== prevOpenRef.current) {
              setOpenFlash(newOpen > prevOpenRef.current ? 'up' : 'down');
              prevOpenRef.current = newOpen;
            }
            if (newPending !== prevPendingRef.current) {
              setPendingFlash(newPending > prevPendingRef.current ? 'up' : 'down');
              prevPendingRef.current = newPending;
            }

            setOpenOrders(newOpen);
            setPendingOrders(newPending);

            const accounts = payload.accounts ?? [];
            const nextRecord: OrdersByAccountIdRecord = {};
            for (const acc of accounts) {
              const aid = String(acc.account_id ?? '');
              if (aid) {
                const balance = acc.balance ?? acc.account?.balance ?? null;
                const pnl = acc.pnl ?? acc.account?.unrealized_pnl ?? null;
                const equityFromMsg = acc.equity ?? acc.account?.equity ?? null;
                const equity =
                  equityFromMsg ??
                  (balance != null && pnl != null ? balance + pnl : null);
                nextRecord[aid] = {
                  balance,
                  pnl,
                  equity,
                  openTrades: Number(acc.open_orders ?? 0),
                  pendingTrades: Number(acc.pending_orders ?? 0),
                };
              }
            }
            setOrdersByAccountId((prev) => {
              const merged = { ...prev };
              for (const [k, v] of Object.entries(nextRecord)) {
                const prevRow = prev[k];
                merged[k] = {
                  balance: v.balance ?? prevRow?.balance ?? null,
                  pnl: v.pnl ?? prevRow?.pnl ?? null,
                  equity: v.equity ?? prevRow?.equity ?? null,
                  openTrades: v.openTrades,
                  pendingTrades: v.pendingTrades ?? prevRow?.pendingTrades ?? 0,
                };
              }
              return merged;
            });
            setOrdersUpdateTrigger((n) => n + 1);

            for (const acc of accounts) {
              const aid = String(acc.account_id ?? '');
              if (!aid) continue;
              const prev = prevByAccountRef.current.get(aid);
              const currOpen = Number(acc.open_orders ?? 0);
              const currPending = Number(acc.pending_orders ?? 0);
              const changed = prev != null && (prev.open !== currOpen || prev.pending !== currPending);
              prevByAccountRef.current.set(aid, { open: currOpen, pending: currPending });
              if (changed) {
                setFlashingAccountIds((s) => new Set(s).add(aid));
                const existing = flashTimeoutsRef.current.get(aid);
                if (existing) clearTimeout(existing);
                flashTimeoutsRef.current.set(
                  aid,
                  setTimeout(() => {
                    flashTimeoutsRef.current.delete(aid);
                    setFlashingAccountIds((prev) => {
                      const next = new Set(prev);
                      next.delete(aid);
                      return next;
                    });
                  }, FLASH_DURATION_MS)
                );
              }
            }
          } catch {
            setOpenOrders(0);
            setPendingOrders(0);
          }
        };

        ws.onclose = () => {
          if (isDisposed) return;
          reconnectTimer = setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          try {
            ws?.close();
          } catch {
          }
        };
      } catch {
        reconnectTimer = setTimeout(connect, 2000);
      }
    };

    connect();

    return () => {
      isDisposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const t of flashTimeoutsRef.current.values()) clearTimeout(t);
      flashTimeoutsRef.current.clear();
      try {
        ws?.close();
      } catch {
      }
    };
  }, []);

  useEffect(() => {
    if (openFlash) {
      const t = setTimeout(() => setOpenFlash(null), FLASH_DURATION_MS);
      return () => clearTimeout(t);
    }
  }, [openFlash]);

  useEffect(() => {
    if (pendingFlash) {
      const t = setTimeout(() => setPendingFlash(null), FLASH_DURATION_MS);
      return () => clearTimeout(t);
    }
  }, [pendingFlash]);

  const value: AccountOrdersContextType = {
    openOrders,
    pendingOrders,
    openFlash,
    pendingFlash,
    flashingAccountIds,
    ordersByAccountId,
    ordersUpdateTrigger,
  };

  return (
    <AccountOrdersContext.Provider value={value}>
      {children}
    </AccountOrdersContext.Provider>
  );
}

export function useAccountOrders(): AccountOrdersContextType {
  const ctx = useContext(AccountOrdersContext);
  if (!ctx) {
    return {
      openOrders: 0,
      pendingOrders: 0,
      openFlash: null,
      pendingFlash: null,
      flashingAccountIds: new Set(),
      ordersByAccountId: {},
      ordersUpdateTrigger: 0,
    };
  }
  return ctx;
}
