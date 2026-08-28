import {
  getAccountsStatus,
  normalizeAccountsStatus,
  configureAccount,
  deleteAccount as apiDeleteAccount,
  getOAuthUrl,
  completeOAuth,
  installBots as apiInstallBots,
  updatePreferences as apiUpdatePreferences,
  setSystemEngine,
  setAccountTcp,
} from '@/api';
import type {
  AppPreferencesState,
  AppPreferencesUpdate,
} from '@/lib/preferences';
import { DEFAULT_PREFERENCES, mapPreferencesFromApi } from '@/lib/preferences';
import { playAccountOfflineSound, playAccountOnlineSound, setSoundsEnabled } from '@/lib/sounds';
import type { Resources } from '@/api/types';
import type { SlaveConfig, TradingAccount } from '@/lib/trading/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSystemSuspended } from '@/context/SystemSuspendedContext';

export type { AppPreferencesState };

interface UseAccountsResult {
  accounts: TradingAccount[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  isConnectingAccount: boolean;
  preferences: AppPreferencesState;
  updatePreferences: (updates: AppPreferencesUpdate) => Promise<boolean>;
  setGlobalCopierEnabled: (enabled: boolean) => Promise<boolean>;
  setAccountTcpEnabled: (accountId: string, enabled: boolean) => Promise<boolean>;
  updateAccount: (
    id: string,
    updates: { nickname?: string; type?: 'pending' | 'master' | 'slave'; config?: SlaveConfig; disconnectFromMaster?: boolean }
  ) => Promise<boolean>;
  deleteAccount: (id: string) => Promise<boolean>;
  disconnectSlaves: (masterId: string) => Promise<boolean>;
  resources: Resources | null;
}

const POLLING_INTERVAL = 2500;
const TCP_TOGGLE_BUFFER_MS = 3000;

export function useAccounts(): UseAccountsResult {
  const { suppressNextOfflineSound, setSuppressNextOfflineSound, suppressNextOnlineSound, setSuppressNextOnlineSound } = useSystemSuspended();
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnectingAccount, setIsConnectingAccount] = useState(false);
  const [preferences, setPreferences] = useState<AppPreferencesState>(DEFAULT_PREFERENCES);
  const [resources, setResources] = useState<Resources | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const prevConnectionByAccountRef = useRef<Map<string, 'connected' | 'connecting' | 'offline'>>(new Map());
  const appliedTcpOnStartupRef = useRef(false);
  const alwaysShowColumnsRef = useRef(false);
  const pendingTcpOverridesRef = useRef<Map<string, { value: boolean; expiresAt: number }>>(new Map());

  const applyPendingTcpOverrides = useCallback((list: TradingAccount[]): TradingAccount[] => {
    const overrides = pendingTcpOverridesRef.current;
    if (overrides.size === 0) return list;
    const now = Date.now();
    for (const [id, entry] of overrides) {
      if (entry.expiresAt <= now) overrides.delete(id);
    }
    if (overrides.size === 0) return list;
    return list.map((a) => {
      const o = overrides.get(a.id);
      return o ? { ...a, tcpEnabled: o.value } : a;
    });
  }, []);
  const fetchAccounts = useCallback(async () => {
    try {
      const data = await getAccountsStatus();
      if (mountedRef.current) {
        const newAccounts = applyPendingTcpOverrides(normalizeAccountsStatus(data));
        const soundsEnabled = data.app?.sounds_enabled === true;
        const prev = prevConnectionByAccountRef.current;
        if (soundsEnabled) {
          let anyWentOnline = false;
          let anyWentOffline = false;
          for (const a of newAccounts) {
            const prevConn = prev.get(a.id);
            const nowOnline = a.connection === 'connected';
            const nowOffline = a.connection === 'offline';
            if ((prevConn === undefined || prevConn !== 'connected') && nowOnline) anyWentOnline = true;
            else if (prevConn === 'connected' && nowOffline) anyWentOffline = true;
          }
          if (anyWentOnline) {
            if (suppressNextOnlineSound) setSuppressNextOnlineSound(false);
            else playAccountOnlineSound();
          }
          if (anyWentOffline) {
            if (suppressNextOfflineSound) setSuppressNextOfflineSound(false);
            else playAccountOfflineSound();
          }
        }
        prevConnectionByAccountRef.current = new Map(newAccounts.map((a) => [a.id, a.connection]));
        setAccounts(newAccounts);
        setError(null);
        setIsConnectingAccount(Boolean(data.app?.linking_ctrader_accounts));
        if (data.app) {
          setPreferences({
            ...mapPreferencesFromApi(data.app),
            alwaysShowColumns: alwaysShowColumnsRef.current,
          });
        }
        setResources(data.resources ?? null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch accounts');
      }
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, [suppressNextOfflineSound, setSuppressNextOfflineSound, suppressNextOnlineSound, setSuppressNextOnlineSound, applyPendingTcpOverrides]);

  const refetch = useCallback(async () => {
    await fetchAccounts();
  }, [fetchAccounts]);

  useEffect(() => {
    if (
      isLoading ||
      accounts.length === 0 ||
      !preferences.globalCopierEnabled ||
      appliedTcpOnStartupRef.current
    ) {
      return;
    }
    appliedTcpOnStartupRef.current = true;
    (async () => {
      try {
        await setSystemEngine('on');
      } catch {
      }
    })();
  }, [isLoading, accounts, preferences.globalCopierEnabled]);

  const setGlobalCopierEnabled = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      try {
        await apiUpdatePreferences({ global_copier_enabled: enabled });
        await setSystemEngine(enabled ? 'on' : 'off');
        await fetchAccounts();
        return true;
      } catch (err) {
        if (mountedRef.current)
          setError(err instanceof Error ? err.message : 'Failed to set motor state');
        return false;
      }
    },
    [fetchAccounts]
  );

  const setAccountTcpEnabled = useCallback(
    async (accountId: string, enabled: boolean): Promise<boolean> => {
      pendingTcpOverridesRef.current.set(accountId, {
        value: enabled,
        expiresAt: Date.now() + TCP_TOGGLE_BUFFER_MS,
      });
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, tcpEnabled: enabled } : a))
      );
      try {
        await setAccountTcp(accountId, enabled);
        await fetchAccounts();
        return true;
      } catch (err) {
        pendingTcpOverridesRef.current.delete(accountId);
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to toggle copy');
        }
        await fetchAccounts();
        return false;
      }
    },
    [fetchAccounts]
  );

  const updatePreferences = useCallback(
    async (updates: AppPreferencesUpdate): Promise<boolean> => {
      const body: Parameters<typeof apiUpdatePreferences>[0] = {};
      if (updates.showNickname !== undefined) body.show_nickname = updates.showNickname;
      if (updates.soundsEnabled !== undefined) body.sounds_enabled = updates.soundsEnabled;
      if (updates.globalCopierEnabled !== undefined) body.global_copier_enabled = updates.globalCopierEnabled;
      if (updates.showSlaveConfigDetails !== undefined) body.show_slave_config_details = updates.showSlaveConfigDetails;
      if (updates.showOrdersTotals !== undefined) body.show_orders_totals = updates.showOrdersTotals;
      if (updates.showResources !== undefined) body.show_resources = updates.showResources;
      if (updates.showBalance !== undefined) body.show_balance = updates.showBalance;
      if (updates.showEquity !== undefined) body.show_equity = updates.showEquity;
      if (updates.showPnl !== undefined) body.show_pnl = updates.showPnl;
      if (updates.showOpenOrders !== undefined) body.show_open_orders = updates.showOpenOrders;
      if (updates.alwaysShowColumns !== undefined) {
        alwaysShowColumnsRef.current = updates.alwaysShowColumns;
        setPreferences((prev) => ({ ...prev, alwaysShowColumns: updates.alwaysShowColumns! }));
      }
      if (Object.keys(body).length === 0) return true;
      try {
        await apiUpdatePreferences(body);
        await fetchAccounts();
        return true;
      } catch (err) {
        if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed to update preferences');
        return false;
      }
    },
    [fetchAccounts]
  );

  const updateAccount = useCallback(
    async (
      id: string,
      updates: { nickname?: string; type?: 'pending' | 'master' | 'slave'; config?: SlaveConfig; disconnectFromMaster?: boolean }
    ): Promise<boolean> => {
      if (updates.disconnectFromMaster) {
        try {
          const res = await configureAccount(id, { disconnect_from_master: true, role: 'slave' });
          if (!res?.success) {
            if (mountedRef.current) setError(res?.errors?.[0] ?? res?.message ?? 'Failed to disconnect');
            return false;
          }
          fetchAccounts();
          return true;
        } catch (err) {
          if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed to disconnect');
          return false;
        }
      }
      let role = updates.type;
      const config = updates.config;
      let masterTcpUrl: string | null | undefined = config?.masterTcpUrl;
      if (masterTcpUrl === undefined && config?.masterAccountId) {
        const master = accounts.find((m) => m.id === config!.masterAccountId);
        masterTcpUrl = master?.tcpUrl ?? null;
      }
      if (role === undefined && config !== undefined) {
        const current = accounts.find((a) => a.id === id);
        const wantSlave = !!config.masterAccountId || !!(config.masterTcpUrl && config.masterTcpUrl.trim());
        if (current?.type === 'slave' && !wantSlave) {
          role = 'slave';
          const explicitlyDisconnected = config?.masterAccountId == null && config?.masterTcpUrl === null;
          if (!explicitlyDisconnected && (masterTcpUrl === undefined || masterTcpUrl === null)) {
            masterTcpUrl = current.masterTcpUrl ?? current.config?.masterTcpUrl ?? null;
          }
        } else {
          role = wantSlave ? 'slave' : 'pending';
        }
      }
      const body: {
        nickname?: string | null;
        role?: string;
        master_account_id?: string | null;
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
      } = {};
      if (updates.nickname !== undefined) body.nickname = updates.nickname;
      if (role) body.role = role;
      if (config?.masterAccountId !== undefined) body.master_account_id = config.masterAccountId || null;
      if (masterTcpUrl !== undefined) body.master_tcp_url = masterTcpUrl;
      if (role === 'slave' && masterTcpUrl === null && (config?.masterAccountId == null || config?.masterAccountId === '')) {
        body.disconnect_from_master = true;
        body.master_account_id = null;
      }
      if (config) {
        body.lot_type = config.mode === 'fixedLot' ? 'fixed' : 'multiplier';
        if (config.fixedLot !== undefined) body.fixed_lot = config.fixedLot;
        if (config.multiplier !== undefined) body.lot_multiplier = config.multiplier;
        body.reverse_trading = config.reverseTrading ?? false;
        body.exact_match = config.exactMatch ?? false;
        body.symbol_translations = Array.isArray(config.symbolTranslate)
          ? config.symbolTranslate
              .filter((t) => t.from?.trim() || t.to?.trim())
              .map((t) => `${(t.from ?? '').trim()}:${(t.to ?? '').trim()}`)
          : [];
        const toPrefixSuffix = (
          c: SlaveConfig['prefix']
        ): { enabled: boolean; value: string; action: string } | null => {
          if (c == null) return null;
          if (typeof c === 'string') return { enabled: !!c, value: c || '', action: 'add' };
          return { enabled: c.enabled, value: c.value ?? '', action: c.action ?? 'add' };
        };
        body.prefix = toPrefixSuffix(config.prefix);
        body.suffix = toPrefixSuffix(config.suffix);
      }
      try {
        const res = await configureAccount(id, body);
        if (!res?.success) {
          if (mountedRef.current) setError(res?.errors?.[0] ?? res?.message ?? 'Failed to update');
          return false;
        }
        fetchAccounts();
        return true;
      } catch (err) {
        if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed to update');
        return false;
      }
    },
    [accounts, fetchAccounts]
  );

  const deleteAccount = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await apiDeleteAccount(id);
        if (response.ok) {
          await fetchAccounts();
          return true;
        }
        const data = await response.json().catch(() => ({}));
        if (mountedRef.current) setError((data as { error?: string }).error || 'Failed to delete');
        return false;
      } catch (err) {
        if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed to delete');
        return false;
      }
    },
    [fetchAccounts]
  );


  const disconnectSlaves = useCallback(
    async (masterId: string): Promise<boolean> => {
      const master = accounts.find((a) => a.id === masterId && a.type === 'master');
      if (!master) return false;
      const slaves = accounts.filter(
        (a) =>
          a.type === 'slave' &&
          (a.config?.masterAccountId === masterId || (!!master.tcpUrl && a.masterTcpUrl === master.tcpUrl))
      );
      for (const slave of slaves) {
        await updateAccount(slave.id, { disconnectFromMaster: true });
      }
      await fetchAccounts();
      return true;
    },
    [accounts, updateAccount, fetchAccounts]
  );

  useEffect(() => {
    setSoundsEnabled(preferences.soundsEnabled);
  }, [preferences.soundsEnabled]);

  useEffect(() => {
    mountedRef.current = true;
    fetchAccounts();
    pollingRef.current = setInterval(fetchAccounts, POLLING_INTERVAL);
    return () => {
      mountedRef.current = false;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [fetchAccounts]);

  return {
    accounts,
    isLoading,
    error,
    refetch,
    isConnectingAccount,
    preferences,
    updatePreferences,
    setGlobalCopierEnabled,
    setAccountTcpEnabled,
    updateAccount,
    deleteAccount,
    disconnectSlaves,
    resources,
  };
}

export interface InstallBotsResult {
  copied?: number;
  targets?: string[];
  warnings?: string[];
}

interface UseInstallBotsResult {
  isInstalling: boolean;
  isInstalled: boolean;
  error: string | null;
  installResult: InstallBotsResult | null;
  installBots: () => Promise<boolean>;
  reset: () => void;
}

export function useInstallBots(): UseInstallBotsResult {
  const [isInstalling, setIsInstalling] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<InstallBotsResult | null>(null);

  const installBots = useCallback(
    async (): Promise<boolean> => {
      if (isInstalling) return false;
      setIsInstalling(true);
      setError(null);
      setInstallResult(null);
      try {
        const data = await apiInstallBots();
        if (data.success && (data.copied ?? 0) > 0) {
          setIsInstalled(true);
          setInstallResult({
            copied: data.copied,
            targets: data.targets,
            warnings: data.warnings,
          });
          return true;
        }
        if (data.success && (data.copied ?? 0) === 0) {
          setInstallResult({
            copied: 0,
            targets: data.targets ?? [],
            warnings: data.warnings ?? (data.targets?.length === 0 ? ['No MetaTrader folders found on this machine'] : []),
          });
          setError(data.warnings?.[0] ?? 'No MetaTrader folders found on this machine');
          return false;
        }
        setError(data.error || 'Failed to install');
        setInstallResult(data.copied != null ? { copied: data.copied, targets: data.targets, warnings: data.warnings } : null);
        return false;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to install');
        return false;
      } finally {
        setIsInstalling(false);
      }
    },
    [isInstalling]
  );

  const reset = useCallback(() => {
    setIsInstalled(false);
    setError(null);
    setInstallResult(null);
  }, []);

  return { isInstalling, isInstalled, error, installResult, installBots, reset };
}

interface UseCtraderLinkResult {
  openCtraderOAuth: () => Promise<void>;
  error: string | null;
  clearError: () => void;
}

export function useCtraderLink(onComplete?: () => void, onStartLinking?: () => void): UseCtraderLinkResult {
  const [error, setError] = useState<string | null>(null);
  const completedCodeRef = useRef<string | null>(null);

  const openCtraderOAuth = useCallback(async () => {
    setError(null);
    try {
      const data = await getOAuthUrl();
      if (data.success && data.data?.url) {
        const oauthUrl = data.data.url;
        if (window.electronAPI?.openExternalLink) {
          await window.electronAPI.openExternalLink(oauthUrl);
        } else {
          window.open(oauthUrl, '_blank');
        }
      } else {
        setError(data.error || 'No URL returned');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  }, []);

  const completeCtrader = useCallback(
    async (code: string) => {
      if (completedCodeRef.current === code) {
        return;
      }
      completedCodeRef.current = code;
      onStartLinking?.();
      try {
        await completeOAuth(code);
        onComplete?.();
      } catch (e) {
        completedCodeRef.current = null;
        setError(e instanceof Error ? e.message : 'Error linking accounts');
      }
    },
    [onComplete, onStartLinking]
  );

  useEffect(() => {
    const handleDeepLink = (data: unknown) => {
      const url = typeof data === 'string' ? data : (data as { url?: string })?.url;
      if (url && url.toLowerCase().startsWith('iptrade://ctrader')) {
        window.electronAPI?.clearPendingDeepLink?.(url);
        try {
          const u = new URL(url);
          const error = u.searchParams.get('error');
          const errorDesc = u.searchParams.get('error_description');
          if (error) {
            setError(errorDesc || error || 'cTrader OAuth error');
            return;
          }
          const code = u.searchParams.get('code');
          if (code) {
            completeCtrader(code);
          }
        } catch (_e) {
        }
      }
    };
    const checkPendingDeepLink = async () => {
      const pending = await window.electronAPI?.getPendingDeepLink?.();
      if (pending) handleDeepLink({ url: pending });
    };
    void checkPendingDeepLink();

    if (window.electronAPI?.onDeepLink) {
      window.electronAPI.onDeepLink(handleDeepLink);
    }
    const onAuthCallback = (e: Event) => {
      const detail = (e as CustomEvent<{ url?: string }>).detail;
      handleDeepLink(detail?.url ?? detail);
    };
    window.addEventListener('auth-callback', onAuthCallback);
    return () => {
      window.removeEventListener('auth-callback', onAuthCallback);
      if (window.electronAPI?.removeAllListeners) window.electronAPI.removeAllListeners('deep-link');
    };
  }, [completeCtrader]);

  return { openCtraderOAuth, error, clearError: () => setError(null) };
}
