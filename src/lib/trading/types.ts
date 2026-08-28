export interface PrefixSuffixConfig {
  enabled: boolean;
  value: string;
  action: 'add' | 'remove';
}

export interface SymbolTranslation {
  from: string;
  to: string;
}

export interface SlaveConfig {
  masterAccountId: string | null;
  masterTcpUrl?: string | null;
  mode: 'fixedLot' | 'multiplier';
  fixedLot?: number;
  multiplier?: number;
  prefix?: string | PrefixSuffixConfig;
  suffix?: string | PrefixSuffixConfig;
  symbolTranslate?: boolean | SymbolTranslation[];
  reverseTrading?: boolean;
  exactMatch?: boolean;
}

export interface TradingAccount {
  id: string;
  accountId: string;
  displayId: string;
  nickname?: string;
  platform: string;
  server?: string | null;
  type: 'master' | 'slave' | 'pending';
  connection: 'connected' | 'connecting' | 'offline';
  reconnectType?: string | null;
  connectionType?: string | null;
  config?: SlaveConfig;
  tcpUrl?: string | null;
  masterTcpUrl?: string | null;
  slaveIds?: string[] | null;
  apiUrl?: string | null;
  balance?: number | null;
  unrealizedPnl?: number | null;
  equity?: number | null;
  tcpEnabled?: boolean | null;
}
