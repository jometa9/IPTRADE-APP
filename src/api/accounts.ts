import type { SlaveConfig, TradingAccount } from '@/lib/trading/types';
import { endpoints } from './endpoints';
import { deleteRequest, getJson, putJson } from './client';
import type {
  AccountsStatusResponse,
  ApiResponse,
  ConfigureAccountBody,
  UpdatePreferencesBody,
} from './types';

export async function getAccountsStatus(): Promise<AccountsStatusResponse> {
  return getJson<AccountsStatusResponse>(endpoints.accounts.status);
}

export async function configureAccount(
  accountId: string,
  body: ConfigureAccountBody
): Promise<ApiResponse<null>> {
  return putJson<ApiResponse<null>>(endpoints.accounts.byId(accountId), body);
}

export async function deleteAccount(accountId: string): Promise<Response> {
  return deleteRequest(endpoints.accounts.byId(accountId));
}

export async function deleteAllAccounts(): Promise<Response> {
  return deleteRequest(endpoints.accounts.deleteAll);
}

export async function updatePreferences(body: UpdatePreferencesBody): Promise<unknown> {
  return putJson(endpoints.preferences, body);
}

export async function setAccountTcp(accountId: string, enabled: boolean): Promise<unknown> {
  return putJson(endpoints.accounts.tcp(accountId, enabled), {});
}

function parseSymbolTranslations(arr: string[] | null | undefined): { from: string; to: string }[] {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr
    .map((s) => {
      const idx = s.indexOf(':');
      if (idx < 0) return { from: s.trim(), to: '' };
      return { from: s.slice(0, idx).trim(), to: s.slice(idx + 1).trim() };
    })
    .filter((t) => t.from || t.to);
}

export function normalizeAccountsStatus(data: AccountsStatusResponse): TradingAccount[] {
  const all = data.accounts ?? [];
  const byTcpUrl = new Map<string, string>();
  all.forEach((m) => {
    if (m.role === 'master' && m.tcp_url) byTcpUrl.set(m.tcp_url, m.account_id);
  });
  return all.map((a) => {
    const role = (a.role || 'pending').toLowerCase();
    const type: 'master' | 'slave' | 'pending' =
      role === 'master' ? 'master' : role === 'slave' ? 'slave' : 'pending';
    const masterTcpUrl = a.master_tcp_url || null;
    const masterId =
      a.master_account_id ?? (masterTcpUrl ? byTcpUrl.get(masterTcpUrl) ?? null : null);
    const displayId = a.account_id;
    const mode = (a.lot_type || '').toLowerCase() === 'fixed' ? 'fixedLot' : 'multiplier';
    const symbolTranslate = parseSymbolTranslations(a.symbol_translations);
    const config: SlaveConfig = {
      masterAccountId: masterId,
      masterTcpUrl: masterTcpUrl,
      mode: mode as 'fixedLot' | 'multiplier',
      multiplier: a.lot_multiplier ?? 1,
      fixedLot: a.fixed_lot ?? undefined,
      reverseTrading: a.reverse_trading ?? undefined,
      exactMatch: a.exact_match ?? false,
      symbolTranslate: symbolTranslate.length > 0 ? symbolTranslate : undefined,
      prefix: a.prefix
        ? { enabled: a.prefix.enabled, value: a.prefix.value ?? '', action: (a.prefix.action ?? 'add') as 'add' | 'remove' }
        : undefined,
      suffix: a.suffix
        ? { enabled: a.suffix.enabled, value: a.suffix.value ?? '', action: (a.suffix.action ?? 'add') as 'add' | 'remove' }
        : undefined,
    };
    const connection: 'connected' | 'connecting' | 'offline' =
      a.status === 'connected'
        ? 'connected'
        : a.status === 'offline'
          ? 'offline'
          : 'connecting';
    const connectionType = a.connectionType ?? a.connection_type ?? null;
    return {
      id: a.account_id,
      accountId: a.account_id,
      displayId,
      nickname: a.nickname ?? undefined,
      platform: a.platform || 'ctrader',
      server: a.server ?? undefined,
      type,
      connection,
      reconnectType: a.reconnect_type ?? null,
      connectionType,
      tcpUrl: a.tcp_url ?? null,
      masterTcpUrl: masterTcpUrl,
      slaveIds: a.slave_ids ?? undefined,
      apiUrl: a.api_url ?? null,
      config,
      balance: a.balance ?? null,
      unrealizedPnl: a.unrealized_pnl ?? null,
      equity: a.equity ?? null,
      tcpEnabled: a.tcp_enabled ?? null,
    } as TradingAccount;
  });
}
