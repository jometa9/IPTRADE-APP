export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  errors?: string[];
}

export type ConnectionStatusDto = 'connected' | 'connecting' | 'offline';

export type ReconnectTypeDto =
  | 'reauth_oauth'
  | 'server_maintenance'
  | 'retry_credentials'
  | 'reauth_mt5';

export interface AccountStatusDto {
  account_id: string;
  nickname?: string | null;
  platform: string;
  server?: string | null;
  role?: string | null;
  tcp_url?: string | null;
  master_account_id?: string | null;
  master_tcp_url?: string | null;
  api_url?: string | null;
  is_live?: boolean | null;
  status?: ConnectionStatusDto;
  reconnect_type?: ReconnectTypeDto | string | null;
  connectionType?: string | null;
  connection_type?: string | null;
  tcp_enabled?: boolean | null;
  lot_type?: string | null;
  lot_multiplier?: number | null;
  fixed_lot?: number | null;
  reverse_trading?: boolean | null;
  exact_match?: boolean | null;
  symbol_translations?: string[] | null;
  prefix?: { enabled: boolean; value: string; action: string } | null;
  suffix?: { enabled: boolean; value: string; action: string } | null;
  slave_ids?: string[] | null;
  balance?: number | null;
  unrealized_pnl?: number | null;
  equity?: number | null;
}

export interface AppSettings {
  linking_ctrader_accounts: boolean;
  deleting_all_accounts: boolean;
  show_nickname: boolean;
  sounds_enabled: boolean;
  global_copier_enabled: boolean;
  show_slave_config_details: boolean;
  show_orders_totals?: boolean;
  show_resources?: boolean;
  show_balance?: boolean;
  show_equity?: boolean;
  show_pnl?: boolean;
  show_open_orders?: boolean;
  always_show_columns?: boolean;
  app_version?: string | null;
}

export interface Resources {
  cpu_usage_percent: number;
  ram_used_percent: number;
}

export interface AccountsStatusResponse {
  accounts: AccountStatusDto[];
  app: AppSettings;
  resources: Resources;
}

export interface UpdatePreferencesBody {
  show_nickname?: boolean;
  sounds_enabled?: boolean;
  global_copier_enabled?: boolean;
  show_slave_config_details?: boolean;
  show_orders_totals?: boolean;
  show_resources?: boolean;
  show_balance?: boolean;
  show_equity?: boolean;
  show_pnl?: boolean;
  show_open_orders?: boolean;
  always_show_columns?: boolean;
}

export interface ConfigureAccountBody {
  nickname?: string | null;
  role?: string;
  master_tcp_url?: string | null;
  disconnect_from_master?: boolean;
  lot_type?: string;
  lot_multiplier?: number;
  fixed_lot?: number;
  reverse_trading?: boolean;
  exact_match?: boolean;
  symbol_translations?: string[];
  prefix?: { enabled: boolean; value: string; action: string } | null;
  suffix?: { enabled: boolean; value: string; action: string } | null;
}

export interface CtraderOAuthUrlResponse {
  success: boolean;
  data?: { url: string };
  error?: string;
}
