'use client';

import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  useAccounts,
  useCtraderLink,
  useInstallBots,
} from '@/hooks/useAccounts';
import { useSystemSuspended } from '@/context/SystemSuspendedContext';
import { useAuth } from '@/hooks/useAuth';
import type { AppPreferencesState, AppPreferencesUpdate } from '@/lib/preferences';
import type { UpdateInfo } from '@/context/AuthContext';
import { getCurrentAppVersion, isNewerVersion } from '@/lib/version';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CalendarDays,
  HelpCircleIcon,
  Home,
  ListOrdered,
  PieChart,
  Plus,
  ScrollText,
  Settings,
} from 'lucide-react';
import { useExternalLink } from '@/hooks/useExternalLink';
import { cn, urls } from '@/lib/utils';
import type { Resources } from '@/api/types';
import type { SlaveConfig, TradingAccount } from '@/lib/trading/types';
import { AccountOrdersProvider } from '@/context/AccountOrdersContext';
import { HeaderStatusInfo } from '@/components/HeaderStatusInfo';
import { FullPageState } from '@/components/FullPageState';
import { ShuttingDownScreen } from '@/components/ShuttingDownScreen';
import { KeepAlive } from '@/components/KeepAlive';
import { TerminalScreen } from '@/components/terminal/TerminalScreen';
import { HistoryScreen } from '@/components/history/HistoryScreen';

export interface AppOutletContext {
  accounts: TradingAccount[];
  isLoadingAccounts: boolean;
  refetch: () => void | Promise<void>;
  updateAccount: (accountId: string, patch: { config?: SlaveConfig; type?: 'master' | 'slave'; nickname?: string }) => void | Promise<boolean>;
  deleteAccount: (accountId: string) => void | Promise<boolean>;
  onConvertAccount: (accountId: string, newType: 'master' | 'slave') => void | Promise<boolean>;
  onUpdateNickname: (accountId: string, nickname: string) => void | Promise<boolean>;
  onDisconnectAllSlaves: (masterId: string) => void | Promise<boolean>;
  platform: string;
  installResult: { copied?: number; targets?: string[]; warnings?: string[] } | null;
  isInstalling: boolean;
  isInstalled: boolean;
  handleInstallBots: () => Promise<void>;
  openCtraderOAuth: () => Promise<void>;
  onPreferencesChange: () => void;
  preferences: AppPreferencesState;
  updatePreferences: (updates: AppPreferencesUpdate) => Promise<boolean>;
  setGlobalCopierEnabled: (enabled: boolean) => Promise<boolean>;
  setAccountTcpEnabled: (accountId: string, enabled: boolean) => Promise<boolean>;
  isConnectingAccount: boolean;
  showAddScreen: boolean;
  setShowAddScreen: (v: boolean) => void;
  systemSuspended: boolean;
  updateInfo: UpdateInfo | null;
  hasUpdateAvailable: boolean;
}

export function AppLayout({ isShuttingDown = false }: { isShuttingDown?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isSettingsScreen = location.pathname === '/config';
  const isLogsScreen = location.pathname === '/logs';
  const isHistoryScreen = location.pathname === '/history';
  const isTerminalScreen = location.pathname === '/terminal';
  const historyView = useMemo(() => {
    if (!isHistoryScreen) return null;
    const v = new URLSearchParams(location.search).get('view');
    if (v === 'calendar' || v === 'statistics' || v === 'orders' || v === 'analyze') return v;
    return 'calendar';
  }, [isHistoryScreen, location.search]);
  const {
    accounts,
    isLoading: areAccountsLoading,
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
  } = useAccounts();
  const { updateInfo } = useAuth();
  const { systemSuspended, setCurrentCopierEnabled, setSuppressNextOnlineSound, setSuppressNextOfflineSound } = useSystemSuspended();

  useEffect(() => {
    setCurrentCopierEnabled(preferences.globalCopierEnabled);
  }, [preferences.globalCopierEnabled, setCurrentCopierEnabled]);
  const startLinkingRefetch = useCallback(() => {
    refetch();
  }, [refetch]);
  const { openCtraderOAuth, error: ctraderError, clearError: clearCtraderError } = useCtraderLink(refetch, startLinkingRefetch);
  const { isInstalling, isInstalled, installBots, installResult, reset: resetInstallState } = useInstallBots();

  const [platform, setPlatform] = useState<string>('');
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [showAddScreen, setShowAddScreen] = useState(false);

  useEffect(() => {
    if (window.electronAPI?.getPlatform) {
      window.electronAPI.getPlatform().then(setPlatform).catch(() => {});
    }
  }, []);
  useEffect(() => {
    if (window.electronAPI?.getIsFullScreen) {
      window.electronAPI.getIsFullScreen().then(setIsFullScreen).catch(() => {});
    }
    if (!window.electronAPI?.onFullScreenChange) return;
    window.electronAPI.onFullScreenChange(setIsFullScreen);
    return () => window.electronAPI?.removeAllListeners?.('fullscreen-changed');
  }, []);

  useEffect(() => () => resetInstallState(), [resetInstallState]);

  const hasUpdateAvailable = useMemo(() => {
    if (!updateInfo?.appVersion) return false;
    return isNewerVersion(updateInfo.appVersion, getCurrentAppVersion());
  }, [updateInfo]);

  const handleInstallBots = async () => {
    const success = await installBots();
    if (success) {
      setSuppressNextOnlineSound(true);
      setSuppressNextOfflineSound(true);
      refetch();
      resetInstallState();
    }
  };

  const handleOpenConfig = () => navigate('/config');
  const handlePreferencesChange = useCallback(() => {
    refetch();
  }, [refetch]);

  const outletContext: AppOutletContext = {
    accounts,
    isLoadingAccounts: areAccountsLoading,
    refetch,
    updateAccount: async (accountId, patch) => updateAccount(accountId, patch as Parameters<typeof updateAccount>[1]),
    deleteAccount: async (accountId) => {
      const account = accounts.find((a) => a.id === accountId);
      const isMasterWithSlaves =
        account?.type === 'master' &&
        accounts.some(
          (a) =>
            a.type === 'slave' &&
            (a.config?.masterAccountId === accountId ||
              (!!account.tcpUrl && a.masterTcpUrl === account.tcpUrl))
        );
      if (isMasterWithSlaves) {
        await disconnectSlaves(accountId);
      }
      const ok = await deleteAccount(accountId);
      if (ok) navigate('/');
      return ok;
    },
    onConvertAccount: async (accountId, newType) => updateAccount(accountId, { type: newType }),
    onUpdateNickname: async (accountId, nickname) => updateAccount(accountId, { nickname }),
    onDisconnectAllSlaves: async (masterId) => disconnectSlaves(masterId),
    platform,
    installResult,
    isInstalling,
    isInstalled,
    handleInstallBots,
    openCtraderOAuth,
    onPreferencesChange: handlePreferencesChange,
    preferences,
    updatePreferences,
    setGlobalCopierEnabled,
    setAccountTcpEnabled,
    isConnectingAccount,
    showAddScreen,
    setShowAddScreen,
    systemSuspended,
    updateInfo,
    hasUpdateAvailable,
  };

  const isMainHomeRoute = !isSettingsScreen && !isLogsScreen && !isHistoryScreen && !isTerminalScreen;
  const isAddFlowVisible =
    (accounts.length === 0 && isMainHomeRoute) || (accounts.length > 0 && showAddScreen);
  const homeNavMutedNoAccounts = accounts.length === 0 && isMainHomeRoute;
  const openAddScreen = useCallback(() => {
    if (location.pathname !== '/') navigate('/');
    setShowAddScreen(true);
  }, [location.pathname, navigate]);

  return (
    <AccountOrdersProvider>
    <div
      className="h-full min-h-0 font-sans text-neutral-900 antialiased w-full flex flex-col overflow-hidden"
      data-platform={platform || undefined}
    >
      <header className="flex-shrink-0 bg-white">
        <AppHeader
          isFullScreen={isFullScreen}
          activeView={
            isLogsScreen
              ? 'logs'
              : isSettingsScreen
                ? 'config'
                : isHistoryScreen
                  ? historyView === 'statistics'
                    ? 'history-statistics'
                    : historyView === 'orders'
                      ? 'history-orders'
                      : historyView === 'analyze'
                        ? 'history-analyze'
                        : 'history-calendar'
                  : isTerminalScreen
                    ? 'terminal'
                    : isAddFlowVisible
                      ? 'add'
                      : 'home'
          }
          homeNavMutedNoAccounts={homeNavMutedNoAccounts}
          navDisabled={isShuttingDown}
          onGoHome={() => { navigate('/'); setShowAddScreen(false); }}
          showAddAccountButton={accounts.length > 0 || isMainHomeRoute}
          onOpenAddScreen={() => { if (isSettingsScreen || isLogsScreen || isHistoryScreen || isTerminalScreen) navigate('/'); setShowAddScreen(true); }}
          onOpenHistoryCalendar={() => navigate('/history?view=calendar')}
          onOpenHistoryStatistics={() => navigate('/history?view=statistics')}
          onOpenHistoryOrders={() => navigate('/history?view=orders')}
          onOpenTerminal={() => navigate('/terminal')}
          platform={platform}
          onOpenConfig={handleOpenConfig}
          onOpenLogs={() => navigate('/logs')}
          showOrdersTotalsPref={preferences.showOrdersTotals}
          showResourcesPref={preferences.showResources}
          resources={resources}
        />
      </header>
      <main className="flex-1 min-h-0 overflow-auto w-full">
        {isShuttingDown ? (
          <ShuttingDownScreen />
        ) : areAccountsLoading ? (
          <FullPageState title="Loading your accounts..." subtitle="Please wait while we load your accounts..." showSpinner />
        ) : (
          <>
            {!isTerminalScreen && !isHistoryScreen && <Outlet context={outletContext} />}
            <KeepAlive active={isTerminalScreen}>
              <TerminalScreen
                accounts={accounts}
                onOpenAddScreen={openAddScreen}
              />
            </KeepAlive>
            {isHistoryScreen && (
              <HistoryScreen
                accounts={accounts}
                onOpenAddScreen={openAddScreen}
              />
            )}
          </>
        )}
      </main>
    </div>
    </AccountOrdersProvider>
  );
}

type HeaderActiveView =
  | 'home'
  | 'add'
  | 'config'
  | 'logs'
  | 'history-calendar'
  | 'history-statistics'
  | 'history-orders'
  | 'history-analyze'
  | 'terminal';

interface AppHeaderProps {
  isFullScreen?: boolean;
  activeView?: HeaderActiveView;
  homeNavMutedNoAccounts?: boolean;
  navDisabled?: boolean;
  onGoHome?: () => void;
  showAddAccountButton?: boolean;
  onOpenAddScreen?: () => void;
  onOpenHistoryCalendar?: () => void;
  onOpenHistoryStatistics?: () => void;
  onOpenHistoryOrders?: () => void;
  onOpenTerminal?: () => void;
  platform: string;
  onOpenConfig: () => void;
  onOpenLogs?: () => void;
  showOrdersTotalsPref: boolean;
  showResourcesPref?: boolean;
  resources?: Resources | null;
}

function AppHeader({
  isFullScreen = false,
  activeView = 'home',
  homeNavMutedNoAccounts = false,
  navDisabled = false,
  onGoHome,
  showAddAccountButton = false,
  onOpenAddScreen,
  onOpenHistoryCalendar,
  onOpenHistoryStatistics,
  onOpenHistoryOrders,
  onOpenTerminal,
  platform,
  onOpenConfig,
  onOpenLogs,
  showOrdersTotalsPref,
  showResourcesPref = false,
  resources = null,
}: AppHeaderProps) {
  const { openExternalLink } = useExternalLink();
  const titleRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (platform !== 'darwin' || !window.electronAPI?.setWindowButtonPosition) return;
    if (isFullScreen) {
      window.electronAPI?.setWindowButtonPosition?.(null, null);
      return;
    }
    const el = titleRowRef.current;
    if (!el) return;

    const TRAFFIC_LIGHTS_HEIGHT = 16;
    const LEFT_INSET = 12;

    const updatePosition = () => {
      const rect = el.getBoundingClientRect();
      const y = Math.round(rect.height / 2 - TRAFFIC_LIGHTS_HEIGHT / 2);
      window.electronAPI?.setWindowButtonPosition?.(LEFT_INSET, Math.max(0, y));
    };

    updatePosition();
    const ro = new ResizeObserver(updatePosition);
    ro.observe(el);
    return () => ro.disconnect();
  }, [platform, isFullScreen]);

  const handleHelpClick = () => openExternalLink(urls.documentation);

  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const macTrafficLightsPadding = isMac && !isFullScreen;
  const titleRowClass = cn(
    'flex items-center justify-between text-sm w-full',
    isWindows && 'electron-drag-region electron-titlebar-row electron-titlebar-safe-right pl-1 pr-4',

    macTrafficLightsPadding && 'electron-drag-region pl-[72px] pr-4'
  );

  const navButtonClass = (isActive: boolean) =>
    cn(
      'cursor-pointer rounded p-1',
      isActive ? 'text-gray-900' : 'text-gray-400 hover:text-gray-900'
    );

  return (
    <div>
      <div className={cn(macTrafficLightsPadding && 'relative')}>
        {macTrafficLightsPadding && (
          <div
            className="absolute left-0 top-0 bottom-0 w-[72px] flex items-center pl-3.5 gap-2 pointer-events-none"
            aria-hidden
          >
            <span className="rounded-full bg-gray-200 w-3 h-3 shrink-0" />
            <span className="rounded-full bg-gray-200 w-3 h-3 shrink-0" />
            <span className="rounded-full bg-gray-200 w-3 h-3 shrink-0" />
          </div>
        )}
        <div
          ref={titleRowRef}
          className={cn(
            'flex items-center justify-between text-sm text-gray-600',
            isWindows && titleRowClass,
            macTrafficLightsPadding && cn(titleRowClass, 'py-2'),
            isMac && isFullScreen && 'px-4 py-2'
          )}
        >
        <div className="flex items-center gap-4">
          {onGoHome ? (
            <button
              type="button"
              onClick={onGoHome}
              disabled={navDisabled || homeNavMutedNoAccounts}
              aria-label="Go home"
              className={cn(
                'text-lg font-bold text-gray-900 hover:text-gray-700 disabled:cursor-default disabled:hover:text-gray-900',
                !isFullScreen && 'ml-2'
              )}
            >
              IPTRADE
            </button>
          ) : (
            <span className={cn('text-lg font-bold text-gray-900', !isFullScreen && 'ml-2')}>IPTRADE</span>
          )}

        </div>
        <HeaderStatusInfo
          showResourcesPref={showResourcesPref}
          resources={resources}
          showOrdersTotalsPref={showOrdersTotalsPref}
        />
        <div
          className={cn(
            'flex items-center gap-3',
            navDisabled && 'pointer-events-none opacity-60'
          )}
        >
          {showAddAccountButton && onOpenAddScreen && (
            <button type="button" onClick={onOpenAddScreen} className={navButtonClass(activeView === 'add')} aria-label="Add accounts" disabled={navDisabled}>
              <Plus className="h-4 w-4" />
            </button>
          )}
          {onGoHome && (
            <button
              type="button"
              onClick={onGoHome}
              className={
                homeNavMutedNoAccounts
                  ? cn('!cursor-default rounded p-1 text-gray-400 hover:text-gray-400')
                  : navButtonClass(activeView === 'home')
              }
              aria-label="Inicio"
              disabled={navDisabled}
            >
              <Home className="h-4 w-4" />
            </button>
          )}
          {onOpenTerminal && (
            <button
              type="button"
              onClick={onOpenTerminal}
              className={navButtonClass(activeView === 'terminal')}
              aria-label="Terminal"
              disabled={navDisabled}
            >
              <Activity className="h-4 w-4" />
            </button>
          )}
          {onOpenHistoryCalendar && (
            <button
              type="button"
              onClick={onOpenHistoryCalendar}
              className={navButtonClass(activeView === 'history-calendar')}
              aria-label="Calendar"
              disabled={navDisabled}
            >
              <CalendarDays className="h-4 w-4" />
            </button>
          )}
          {onOpenHistoryStatistics && (
            <button
              type="button"
              onClick={onOpenHistoryStatistics}
              className={navButtonClass(activeView === 'history-statistics')}
              aria-label="Statistics"
              disabled={navDisabled}
            >
              <PieChart className="h-4 w-4" />
            </button>
          )}
          {onOpenHistoryOrders && (
            <button
              type="button"
              onClick={onOpenHistoryOrders}
              className={navButtonClass(activeView === 'history-orders')}
              aria-label="Orders history"
              disabled={navDisabled}
            >
              <ListOrdered className="h-4 w-4" />
            </button>
          )}
          <button type="button" onClick={onOpenConfig} className={navButtonClass(activeView === 'config')} aria-label="Settings" disabled={navDisabled}>
            <Settings className="h-4 w-4" />
          </button>
          {onOpenLogs && (
            <button type="button" onClick={onOpenLogs} className={navButtonClass(activeView === 'logs')} aria-label="Live logs" disabled={navDisabled}>
              <ScrollText className="h-4 w-4" />
            </button>
          )}
          <button type="button" onClick={handleHelpClick} className="text-gray-400 hover:text-gray-900 cursor-pointer" aria-label="Help" disabled={navDisabled}>
            <HelpCircleIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => openExternalLink(urls.fiveMTrader)}
            className="cursor-pointer rounded px-1 text-[15px] font-extrabold leading-none text-black hover:text-neutral-700 disabled:opacity-60"
            aria-label="Copy trades in the cloud with 5MTrader — opens 5mtrader.com"
            disabled={navDisabled}
          >
            5
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
