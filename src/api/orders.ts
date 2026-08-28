import { request } from './client';
import { endpoints } from './endpoints';
import type { ApiResponse } from './types';

export interface LivePositionRow {
  account_id: string;
  platform: string;
  server: string | null;
  nickname: string | null;
  role: string | null;
  ticket: number;
  symbol: string;
  side: string;
  type: string;
  volume: number;
  open_price: number;
  sl: number | null;
  tp: number | null;
  age_seconds: number;
  profit: number;
}

export interface LivePendingRow {
  account_id: string;
  platform: string;
  server: string | null;
  nickname: string | null;
  role: string | null;
  ticket: number;
  symbol: string;
  side: string;
  type: string;
  volume: number;
  price: number;
  sl: number | null;
  tp: number | null;
  age_seconds: number;
  magic: number | null;
}

export interface OpenOrdersResponse {
  positions: LivePositionRow[];
  pending: LivePendingRow[];
  server_now_ms: number;
}

export async function getOpenOrders(): Promise<OpenOrdersResponse> {
  const res = await request(endpoints.orders.open);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as ApiResponse<OpenOrdersResponse>;
  if (!data.success || !data.data) {
    throw new Error(data.errors?.[0] ?? data.message ?? 'open orders fetch failed');
  }
  return data.data;
}
