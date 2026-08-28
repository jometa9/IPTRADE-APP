export { getBaseUrl, getWsAuthQuery, request, getJson, postJson, putJson, deleteRequest } from './client';
export type { RequestOptions, WsAuthQuery } from './client';
export { endpoints } from './endpoints';
export type {
  ApiResponse,
  AccountStatusDto,
  AccountsStatusResponse,
  AppSettings,
  UpdatePreferencesBody,
  ConfigureAccountBody,
  CtraderOAuthUrlResponse,
} from './types';
export {
  getAccountsStatus,
  configureAccount,
  deleteAccount,
  deleteAllAccounts,
  normalizeAccountsStatus,
  updatePreferences,
  setAccountTcp,
} from './accounts';
export type {
  ConnectionStatusDto,
} from './types';
export { getOAuthUrl, completeOAuth, getCtraderAppCredentials, setCtraderAppCredentials } from './authCtrader';
export type { CtraderAppCredentialsStatus } from './authCtrader';
export { installBots } from './bots';
export type { BotsInstallResponse } from './bots';
export { setSystemEngine, getLogs, clearLogs, getBuildInfo } from './system';
export type { BuildInfo } from './system';
export { getHistoryDeals, getHistoryEligibleAccounts } from './history';
export type {
  HistoryDeal,
  HistorySyncStatus,
  HistoryDealsResponse,
  HistoryAccount,
  CoveredRange,
} from './history';
export { getOpenOrders } from './orders';
export type { LivePositionRow, LivePendingRow, OpenOrdersResponse } from './orders';