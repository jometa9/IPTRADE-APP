export interface AppPreferencesState {
  showNickname: boolean;
  soundsEnabled: boolean;
  globalCopierEnabled: boolean;
  showSlaveConfigDetails: boolean;
  showOrdersTotals: boolean;
  showResources: boolean;
  showBalance: boolean;
  showEquity: boolean;
  showPnl: boolean;
  showOpenOrders: boolean;
  alwaysShowColumns: boolean;
}

export const DEFAULT_PREFERENCES: AppPreferencesState = {
  showNickname: true,
  soundsEnabled: true,
  globalCopierEnabled: true,
  showSlaveConfigDetails: false,
  showOrdersTotals: false,
  showResources: true,
  showBalance: true,
  showEquity: false,
  showPnl: true,
  showOpenOrders: true,
  alwaysShowColumns: false,
};

export interface AppPreferencesUpdate {
  showNickname?: boolean;
  soundsEnabled?: boolean;
  globalCopierEnabled?: boolean;
  showSlaveConfigDetails?: boolean;
  showOrdersTotals?: boolean;
  showResources?: boolean;
  showBalance?: boolean;
  showEquity?: boolean;
  showPnl?: boolean;
  showOpenOrders?: boolean;
  alwaysShowColumns?: boolean;
}

export interface AppPreferencesApiShape {
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

export function mapPreferencesFromApi(p: AppPreferencesApiShape): AppPreferencesState {
  return {
    showNickname: p.show_nickname !== false,
    soundsEnabled: p.sounds_enabled === true,
    globalCopierEnabled: p.global_copier_enabled !== false,
    showSlaveConfigDetails: p.show_slave_config_details === true,
    showOrdersTotals: p.show_orders_totals === true,
    showResources: p.show_resources !== false,
    showBalance: p.show_balance !== false,
    showEquity: p.show_equity === true,
    showPnl: p.show_pnl !== false,
    showOpenOrders: p.show_open_orders !== false,
    alwaysShowColumns: p.always_show_columns === true,
  };
}
