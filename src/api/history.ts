import { request } from './client';
import type { ApiResponse } from './types';

export interface HistoryDeal {
  deal_id: string;
  account_id: string;
  platform: string;
  server?: string | null;
  connection_type?: string | null;
  symbol: string;
  side: string;
  volume: number;
  open_price?: number | null;
  close_price?: number | null;
  open_time_ms: number;
  close_time_ms: number;
  sl?: number | null;
  tp?: number | null;
  commission: number;
  swap: number;
  profit: number;
  net_profit: number;
  position_id?: string | null;
  ticket?: number | null;
}

export interface CoveredRange {
  from_ms: number;
  to_ms: number;
}

export interface HistorySyncStatus {
  account_id: string;
  last_synced_ms: number;
  oldest_synced_ms: number;
  deals_count: number;
  covered_ranges?: CoveredRange[];
}

export interface HistoryDealsResponse {
  deals: HistoryDeal[];
  sync_status: HistorySyncStatus[];
  server_now_ms: number;
}

export interface GetHistoryDealsParams {
  fromMs?: number;
  toMs?: number;
  accountIds?: string[];
  sinceMs?: number;
  forceRefresh?: boolean;
}

export async function getHistoryDeals(
  params: GetHistoryDealsParams = {}
): Promise<HistoryDealsResponse> {
  const search = new URLSearchParams();
  if (params.fromMs != null) search.set('from_ms', String(params.fromMs));
  if (params.toMs != null) search.set('to_ms', String(params.toMs));
  if (params.accountIds && params.accountIds.length > 0) {
    search.set('account_ids', params.accountIds.join(','));
  }
  if (params.sinceMs != null) search.set('since_ms', String(params.sinceMs));
  if (params.forceRefresh) search.set('force_refresh', 'true');
  const qs = search.toString();
  const path = `/api/history/deals${qs ? `?${qs}` : ''}`;
  const res = await request(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as ApiResponse<HistoryDealsResponse>;
  if (!data.success || !data.data) {
    throw new Error(data.errors?.[0] ?? data.message ?? 'history fetch failed');
  }
  return data.data;
}

export async function getHistoryEligibleAccounts(): Promise<HistoryAccount[]> {
  const res = await request('/api/history/accounts');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as ApiResponse<HistoryAccount[]>;
  return data.data ?? [];
}

export interface HistoryAccount {
  account_id: string;
  platform: string;
  server: string | null;
  nickname: string | null;
  connection_type: string | null;
  role: string | null;
  eligible: boolean;
}
