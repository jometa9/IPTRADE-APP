'use client';

import { Input } from '@/components/ui/input';
import { ManualScrollbar } from '@/components/ui/ManualScrollbar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  useAccounts,
  useCtraderLink,
  useInstallBots,
} from '@/hooks/useAccounts';
import { useAuth } from '@/hooks/useAuth';
import { useExternalLink } from '@/hooks/useExternalLink';
import type { SlaveConfig, SymbolTranslation, TradingAccount } from '@/lib/trading/types';
import { getPlatformDisplayName } from '@/lib/trading/utils';
import { cn, urls } from '@/lib/utils';
import React, { type ChangeEvent, type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import {
  CalendarDays,
  ChevronRight,
  Cog,
  CornerDownRight,
  Eye,
  EyeOff,
  HelpCircleIcon,
  ListOrdered,
  Loader,
  LogOutIcon,
  PencilIcon,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import { ConfigScreen } from './ConfigScreen';
import { FullPageState } from './FullPageState';
import type { Resources } from '@/api/types';
import { FLASH_TRANSITION_MS, useAccountOrders } from '@/context/AccountOrdersContext';
import type { AppOutletContext } from '@/layouts/AppLayout';
import { AddAccountFlow } from '@/components/add-account';
import { HeaderStatusInfo } from '@/components/HeaderStatusInfo';

type ViewState = 'empty' | 'accounts';
type AppView = 'main' | 'config';

interface TradeWindowProps {
  accounts?: TradingAccount[];
  isLoadingAccounts?: boolean;
  onUpdateSlaveConfig?: (accountId: string, config: SlaveConfig) => void | Promise<void>;
  onDeleteAccount?: (accountId: string) => void | Promise<void>;
  onConvertAccount?: (accountId: string, newType: 'master' | 'slave') => void | Promise<void>;
  onUpdateNickname?: (accountId: string, nickname: string) => void | Promise<void>;
  onDisconnectAllSlaves?: (masterId: string) => void | Promise<void>;
  onRefetchAccounts?: () => void | Promise<void>;
}

export function TradeWindow({
  accounts = [],
  isLoadingAccounts = false,
  onUpdateSlaveConfig,
  onDeleteAccount,
  onConvertAccount,
  onUpdateNickname: onUpdateNicknameProp,
  onDisconnectAllSlaves: onDisconnectAllSlavesProp,
  onRefetchAccounts,
}: TradeWindowProps) {
  const {
    refetch,
    preferences,
    updatePreferences,
    resources,
    setAccountTcpEnabled,
  } = useAccounts();
  const startLinkingRefetch = useCallback(() => {
    refetch();
  }, [refetch]);
  const { openCtraderOAuth, error: ctraderError, clearError: clearCtraderError } = useCtraderLink(onRefetchAccounts ?? refetch, startLinkingRefetch);
  const { isInstalling, isInstalled, installBots, installResult, reset: resetInstallState } = useInstallBots();

  const [appView, setAppView] = useState<AppView>('main');
  const [viewState, setViewState] = useState<ViewState>(() => (accounts.length > 0 ? 'accounts' : 'empty'));
  const [showAddScreen, setShowAddScreen] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [openWithDeleteAccountId, setOpenWithDeleteAccountId] = useState<string | null>(null);
  const [loadingAccountActionId, setLoadingAccountActionId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [platform, setPlatform] = useState<string>('');
  const accountsScrollContainerRef = useRef<HTMLDivElement>(null);
  const showOrdersTotalsPref = preferences.showOrdersTotals;
  const showNicknamePref = preferences.showNickname;

  useEffect(() => {
    if (window.electronAPI?.getPlatform) {
      window.electronAPI.getPlatform().then(setPlatform).catch(() => { });
    }
  }, []);

  useEffect(() => {
    return () => resetInstallState();
  }, [resetInstallState]);

  useEffect(() => {
    setViewState(accounts.length > 0 ? 'accounts' : 'empty');
  }, [accounts.length]);

  useEffect(() => {
    if (editingAccountId && !accounts.some((a) => a.id === editingAccountId)) {
      setEditingAccountId(null);
    }
  }, [editingAccountId, accounts]);

  const masterAccounts = useMemo(() => accounts.filter((a) => a.type === 'master'), [accounts]);
  const atTotalAccountLimit = false;
  const canAddOrConvert = true;
  const fixedLotSize: number | null = null;

  const handleInstallBots = useCallback(async () => {
    if (isInstalling || isInstalled) return;
    const success = await installBots();
    if (success) {
      onRefetchAccounts?.();
      resetInstallState();
    }
  }, [isInstalling, isInstalled, installBots, onRefetchAccounts, resetInstallState]);

  const handleSaveConfig = useCallback(
    async (accountId: string, config: SlaveConfig, closeAfterSave: boolean = true, nickname?: string) => {
      setLoadingAccountActionId(accountId);
      try {
        await Promise.resolve(onUpdateSlaveConfig?.(accountId, config));
        if (nickname !== undefined) await Promise.resolve(onUpdateNicknameProp?.(accountId, nickname));
        if (closeAfterSave) setEditingAccountId(null);
      } finally {
        setLoadingAccountActionId(null);
      }
    },
    [onUpdateSlaveConfig, onUpdateNicknameProp]
  );

  const handleToggleGroup = useCallback((accountId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [accountId]: prev[accountId] === false }));
  }, []);

  const handleDeleteAccount = useCallback(
    (accountId: string) => {
      onDeleteAccount?.(accountId);
      setEditingAccountId(null);
    },
    [onDeleteAccount]
  );

  const handleConvertAccount = useCallback(
    async (accountId: string, newType: 'master' | 'slave') => {
      setLoadingAccountActionId(accountId);
      try {
        await Promise.resolve(onConvertAccount?.(accountId, newType));
        if (newType !== 'slave') setEditingAccountId(null);
      } finally {
        setLoadingAccountActionId(null);
      }
    },
    [onConvertAccount]
  );

  const handleDisconnectAllSlaves = useCallback(
    async (masterId: string) => {
      setLoadingAccountActionId(masterId);
      try {
        await Promise.resolve(onDisconnectAllSlavesProp?.(masterId));
        setEditingAccountId(null);
      } finally {
        setLoadingAccountActionId(null);
      }
    },
    [onDisconnectAllSlavesProp]
  );

  const handleUpdateNickname = useCallback(
    async (accountId: string, nickname: string) => {
      setLoadingAccountActionId(accountId);
      try {
        await Promise.resolve(onUpdateNicknameProp?.(accountId, nickname));
        setEditingAccountId(null);
      } finally {
        setLoadingAccountActionId(null);
      }
    },
    [onUpdateNicknameProp]
  );

  const handlePreferencesChange = useCallback(() => {
    refetch();
  }, [refetch]);

  const renderContent = () => {
    if (appView === 'config') {
      return (
        <ConfigScreen
          onPreferencesChange={handlePreferencesChange}
          preferences={preferences}
          updatePreferences={updatePreferences}
        />
      );
    }
    if (isLoadingAccounts) return <LoadingAccountsState />;
    if (accounts.length > 0) {
      if (showAddScreen) {
        return (
          <AddAccountFlow
            onAddAccountCtrader={openCtraderOAuth}
            onInstallClick={handleInstallBots}
            isInstalling={isInstalling}
            isInstalled={isInstalled}
            installResult={installResult}
            isWindows={platform === 'win32'}
            onBack={() => setShowAddScreen(false)}
          />
        );
      }
      return (
        <div className="flex flex-col h-full min-h-0">
          <div ref={accountsScrollContainerRef} className={cn("flex-1 min-h-0", preferences.alwaysShowColumns ? "overflow-auto" : "overflow-y-auto overflow-x-hidden")}>
            <AccountsTable
              scrollContainerRef={accountsScrollContainerRef}
              accounts={accounts}
              masterAccounts={masterAccounts}
              editingAccountId={editingAccountId}
              onEdit={(id) => {
                setOpenWithDeleteAccountId(null);
                setEditingAccountId(editingAccountId === id ? null : id);
              }}
              onEditForDelete={(id) => {
                setOpenWithDeleteAccountId(id);
                setEditingAccountId(id);
              }}
              openWithDeleteAccountId={openWithDeleteAccountId}
              onSaveConfig={handleSaveConfig}
              expandedGroups={expandedGroups}
              onToggleGroup={handleToggleGroup}
              onDeleteAccount={handleDeleteAccount}
              onConvertAccount={handleConvertAccount}
              onUpdateNickname={handleUpdateNickname}
              onSetAccountTcpEnabled={setAccountTcpEnabled}
              onDisconnectAllSlaves={handleDisconnectAllSlaves}
              onReauthCtrader={openCtraderOAuth}
              canAddOrConvert={canAddOrConvert}
              fixedLotSize={fixedLotSize}
              showNicknamePref={showNicknamePref}
              showSlaveConfigDetailsPref={preferences.showSlaveConfigDetails}
              showBalancePref={preferences.showBalance}
              showEquityPref={preferences.showEquity}
              showPnlPref={preferences.showPnl}
              showOpenOrdersPref={preferences.showOpenOrders}
              alwaysShowColumnsPref={preferences.alwaysShowColumns}
              loadingAccountActionId={loadingAccountActionId}
              deletingAccountId={null}
            />
          </div>
        </div>
      );
    }
    if (viewState === 'empty') {
      return (
        <AddAccountFlow
          onAddAccountCtrader={openCtraderOAuth}
          onInstallClick={handleInstallBots}
          isInstalling={isInstalling}
          isInstalled={isInstalled}
          installResult={installResult}
          isWindows={platform === 'win32'}
        />
      );
    }
    return null;
  };

  return (
    <div className="w-full relative">
      <WindowChrome
        onOpenConfig={() => setAppView('config')}
        showOrdersTotalsPref={showOrdersTotalsPref}
        showResourcesPref={preferences.showResources}
        resources={resources}
        isAddScreenOverlay={accounts.length > 0 && showAddScreen}
        onCloseAddScreen={() => setShowAddScreen(false)}
      />
      <div className="h-full w-full">
        {renderContent()}
      </div>
    </div>
  );
}

function MotorBanner({
  enabled,
  onToggle,
  loading,
  systemSuspended,
}: {
  enabled: boolean;
  onToggle: (enabled: boolean) => Promise<boolean>;
  loading: boolean;
  systemSuspended?: boolean;
}) {
  const [internalLoading, setInternalLoading] = useState(false);

  const loading_ = loading || internalLoading;
  const effectivelyOn = !systemSuspended && enabled;

  const handleChange = useCallback(
    async (checked: boolean) => {
      setInternalLoading(true);
      try {
        await onToggle(checked);
      } finally {
        setInternalLoading(false);
      }
    },
    [onToggle]
  );

  const isOn = effectivelyOn;
  const bgClasses = isOn
    ? 'bg-green-100 text-gray-600'
    : 'bg-red-100 text-gray-600';

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm',
        bgClasses
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-gray-600">
        <Cog
          className={cn('h-4 w-4 shrink-0 text-gray-900', isOn && 'animate-[spin_2s_linear_infinite]')}
          aria-hidden
        />
        <span className="font-medium">
          Trading engine is {isOn ? 'running healthy' : 'stopped'}
        </span>
        {systemSuspended && enabled && (
          <span className="font-medium">(paused due to system sleep)</span>
        )}

      </div>
      <div className="flex shrink-0 items-center gap-3">
        {loading_ && <Loader className="h-4 w-4 shrink-0 animate-spin text-gray-500" />}
        <Switch
          checked={enabled}
          onCheckedChange={handleChange}
          disabled={loading_ || systemSuspended}
        />
      </div>
    </div>
  );
}

export function OrdersTotalsInline() {
  const { openOrders, pendingOrders, openFlash, pendingFlash } = useAccountOrders();
  const transitionStyle = { transition: `color ${FLASH_TRANSITION_MS}ms ease-in-out` } as const;
  const flash = !!(openFlash || pendingFlash);
  const total = openOrders + pendingOrders;
  return (
    <span
      className={cn('text-sm', !flash && 'text-gray-400', flash && 'text-emerald-600')}
      style={transitionStyle}
    >
      OPEN {openOrders}/{total}
    </span>
  );
}

function UpdateBanner({
  updateInfo,
  platform,
  onDismiss,
}: {
  updateInfo: { appVersion: string; windowsDownloadUrl?: string | null; macDownloadUrl?: string | null };
  platform: string;
  onDismiss: () => void;
}) {
  const { openExternalLink } = useExternalLink();
  const updateDownloadUrl =
    platform === 'darwin' ? (updateInfo.macDownloadUrl ?? null) : (updateInfo.windowsDownloadUrl ?? null);

  return (
    <div className="flex items-center justify-between gap-2 px-4 py-2 text-sm bg-amber-50 text-amber-600">
      <span>
        New version {updateInfo.appVersion} available.
        {updateDownloadUrl ? (
          <>
            {' '}
            <button
              type="button"
              onClick={() => updateDownloadUrl && openExternalLink(updateDownloadUrl)}
              className="underline font-medium hover:no-underline"
            >
              Download now
            </button>
          </>
        ) : (
          ' Check the website for the latest installer.'
        )}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="rounded text-amber-600 hover:text-amber-800 shrink-0 cursor-pointer"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function HomeContent(ctx: AppOutletContext) {
  const showAddScreen = ctx.showAddScreen;
  const setShowAddScreen = ctx.setShowAddScreen;
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [openWithDeleteAccountId, setOpenWithDeleteAccountId] = useState<string | null>(null);
  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null);
  const [loadingAccountActionId, setLoadingAccountActionId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [dismissedUpdateBanner, setDismissedUpdateBanner] = useState(false);
  const accountsScrollContainerRef = useRef<HTMLDivElement>(null);

  const [verticalScrollMetrics, setVerticalScrollMetrics] = useState<{
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  } | null>(null);

  const updateVerticalScrollMetrics = useCallback(() => {
    const el = accountsScrollContainerRef.current;
    if (!el) return;
    setVerticalScrollMetrics({
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    });
  }, []);

  useEffect(() => {
    const el = accountsScrollContainerRef.current;
    if (!el) return;
    updateVerticalScrollMetrics();
    const ro = new ResizeObserver(updateVerticalScrollMetrics);
    ro.observe(el);
    el.addEventListener('scroll', updateVerticalScrollMetrics);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', updateVerticalScrollMetrics);
    };
  }, [updateVerticalScrollMetrics, ctx.accounts.length]);

  const handleVerticalScrollChange = useCallback((v: number) => {
    if (accountsScrollContainerRef.current) accountsScrollContainerRef.current.scrollTop = v;
  }, []);

  const hasVerticalScroll = verticalScrollMetrics != null && verticalScrollMetrics.scrollHeight > verticalScrollMetrics.clientHeight;

  const handleHorizontalScroll = useCallback((e: React.WheelEvent) => {
    const el = accountsScrollContainerRef.current;
    if (!el) return;
    const { scrollWidth, clientWidth } = el;
    if (scrollWidth <= clientWidth) return;
    const deltaX = e.deltaX !== 0 ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (deltaX !== 0) {
      e.preventDefault();
      el.scrollLeft += deltaX;
    }
  }, []);

  useEffect(() => {
    ctx.refetch();
  }, [ctx.refetch]);

  const masterAccounts = useMemo(() => ctx.accounts.filter((a) => a.type === 'master'), [ctx.accounts]);
  const atTotalAccountLimit = false;
  const canAddOrConvert = true;
  const fixedLotSize: number | null = null;
  useEffect(() => {
    if (editingAccountId && !ctx.accounts.some((a) => a.id === editingAccountId)) {
      setEditingAccountId(null);
      setOpenWithDeleteAccountId(null);
    }
  }, [editingAccountId, ctx.accounts]);

  const wasConnectingRef = useRef(false);
  useEffect(() => {
    if (ctx.isConnectingAccount) {
      wasConnectingRef.current = true;
      return;
    }
    if (wasConnectingRef.current && ctx.accounts.length > 0) {
      wasConnectingRef.current = false;
      setShowAddScreen(false);
    } else if (!ctx.isConnectingAccount) {
      wasConnectingRef.current = false;
    }
  }, [ctx.isConnectingAccount, ctx.accounts.length, setShowAddScreen]);

  const prevAccountIdsRef = useRef<string[] | null>(null);
  useEffect(() => {
    const currentIds = ctx.accounts.map((a) => a.id);
    if (prevAccountIdsRef.current === null) {
      prevAccountIdsRef.current = currentIds;
      return;
    }
    const prevSet = new Set(prevAccountIdsRef.current);
    const addedIds = ctx.accounts.filter((a) => !prevSet.has(a.id)).map((a) => a.id);
    if (addedIds.length > 0) {
      const cameFromEmptyAddFlow = prevAccountIdsRef.current.length === 0;
      const userWasOnAddFlow = showAddScreen || cameFromEmptyAddFlow;
      if (userWasOnAddFlow) {
        setShowAddScreen(false);
        setEditingAccountId(null);
        setOpenWithDeleteAccountId(null);
      }
    }
    prevAccountIdsRef.current = currentIds;
  }, [ctx.accounts, showAddScreen, setShowAddScreen]);

  const handleSaveConfig = useCallback(
    async (
      accountId: string,
      config: SlaveConfig,
      closeAfterSave: boolean = true,
      nickname?: string
    ) => {
      setLoadingAccountActionId(accountId);
      try {
        await ctx.updateAccount(accountId, {
          config,
          ...(nickname !== undefined && { nickname }),
        });
        if (closeAfterSave) setEditingAccountId(null);
      } finally {
        setLoadingAccountActionId(null);
      }
    },
    [ctx]
  );

  const handleConvertAccount = useCallback(
    async (accountId: string, newType: 'master' | 'slave') => {
      setLoadingAccountActionId(accountId);
      const start = Date.now();
      try {
        await ctx.onConvertAccount(accountId, newType);
        if (newType !== 'slave') setEditingAccountId(null);
      } finally {
        const elapsed = Date.now() - start;
        const remaining = Math.max(0, 500 - elapsed);
        if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
        setLoadingAccountActionId(null);
      }
    },
    [ctx]
  );

  const handleUpdateNickname = useCallback(
    async (accountId: string, nickname: string) => {
      setLoadingAccountActionId(accountId);
      try {
        await ctx.onUpdateNickname(accountId, nickname);
        setEditingAccountId(null);
      } finally {
        setLoadingAccountActionId(null);
      }
    },
    [ctx]
  );

  const handleDisconnectAllSlaves = useCallback(
    async (masterId: string) => {
      setLoadingAccountActionId(masterId);
      try {
        await ctx.onDisconnectAllSlaves(masterId);
        setEditingAccountId(null);
      } finally {
        setLoadingAccountActionId(null);
      }
    },
    [ctx]
  );

  if (ctx.isLoadingAccounts) return <LoadingAccountsState />;
  if (ctx.isConnectingAccount) {
    return <ConnectingAccountsState />;
  }
  if (ctx.accounts.length > 0) {
    if (showAddScreen) {
      return (
        <AddAccountFlow
          onAddAccountCtrader={ctx.openCtraderOAuth}
          onInstallClick={ctx.handleInstallBots}
          isInstalling={ctx.isInstalling}
          isInstalled={ctx.isInstalled}
          installResult={ctx.installResult}
          isWindows={ctx.platform === 'win32'}
          onBack={() => setShowAddScreen(false)}
        />
      );
    }
    return (
      <div className="h-full min-h-0 flex flex-col">
        <div className="shrink-0 overflow-hidden border-t border-gray-200">
          <MotorBanner
            enabled={ctx.preferences.globalCopierEnabled}
            onToggle={ctx.setGlobalCopierEnabled}
            loading={false}
            systemSuspended={ctx.systemSuspended}
          />
        </div>

        {ctx.hasUpdateAvailable && ctx.updateInfo && !dismissedUpdateBanner && (
          <div className="shrink-0 overflow-hidden border-t border-gray-200">
            <UpdateBanner
              updateInfo={ctx.updateInfo}
              platform={ctx.platform}
              onDismiss={() => setDismissedUpdateBanner(true)}
            />
          </div>
        )}

        <div
          id="home-accounts-root"
          className="flex flex-col flex-1 min-h-0 relative overflow-hidden border-t border-gray-200"
          onWheel={handleHorizontalScroll}
        >
          <div
            className="fixed inset-0 flex items-center justify-center pointer-events-none select-none z-0"
            aria-hidden="true"
          >
            <div className="flex flex-col gap-0 leading-none">
              <span className="text-4xl text-gray-100 p-0 m-0 leading-none">瞬写</span>
              <span className="text-5xl font-bold text-gray-100 p-0 m-0 leading-none">IPTRADE</span>
            </div>
          </div>
          <div className="flex flex-1 min-h-0">
            <div ref={accountsScrollContainerRef} className={cn("flex-1 min-h-0 relative z-10", ctx.preferences.alwaysShowColumns ? "overflow-auto" : "overflow-y-auto overflow-x-hidden")}>
              <AccountsTable
                scrollContainerRef={accountsScrollContainerRef}
                scrollbarPortalTargetId="home-accounts-root"
                accounts={ctx.accounts}
                masterAccounts={masterAccounts}
                editingAccountId={editingAccountId}
                onEdit={(id) => {
                  setOpenWithDeleteAccountId(null);
                  setEditingAccountId(editingAccountId === id ? null : id);
                }}
                onEditForDelete={(id) => {
                  setOpenWithDeleteAccountId(id);
                  setEditingAccountId(id);
                }}
                openWithDeleteAccountId={openWithDeleteAccountId}
                onSaveConfig={handleSaveConfig}
                expandedGroups={expandedGroups}
                onToggleGroup={(accountId) => setExpandedGroups((prev) => ({ ...prev, [accountId]: prev[accountId] === false }))}
                onDeleteAccount={async (accountId: string) => {
                  setEditingAccountId(null);
                  setOpenWithDeleteAccountId(null);
                  setDeletingAccountId(accountId);
                  try {
                    await ctx.deleteAccount(accountId);
                  } finally {
                    setDeletingAccountId(null);
                  }
                }}
                onConvertAccount={handleConvertAccount}
                onUpdateNickname={handleUpdateNickname}
                onSetAccountTcpEnabled={ctx.setAccountTcpEnabled}
                loadingAccountActionId={loadingAccountActionId}
                onDisconnectAllSlaves={handleDisconnectAllSlaves}
                onReauthCtrader={ctx.openCtraderOAuth}
                canAddOrConvert={canAddOrConvert}
                fixedLotSize={fixedLotSize}
                showNicknamePref={ctx.preferences.showNickname}
                showSlaveConfigDetailsPref={ctx.preferences.showSlaveConfigDetails}
                showBalancePref={ctx.preferences.showBalance}
                showEquityPref={ctx.preferences.showEquity}
                showPnlPref={ctx.preferences.showPnl}
                showOpenOrdersPref={ctx.preferences.showOpenOrders}
                alwaysShowColumnsPref={ctx.preferences.alwaysShowColumns}
                deletingAccountId={deletingAccountId}
              />
            </div>
            {hasVerticalScroll && verticalScrollMetrics && (
              <div className="flex shrink-0 flex-col py-2 px-2 bg-white border-l border-gray-200">
                <ManualScrollbar
                  orientation="vertical"
                  value={verticalScrollMetrics.scrollTop}
                  viewportSize={verticalScrollMetrics.clientHeight}
                  contentSize={verticalScrollMetrics.scrollHeight}
                  onChange={handleVerticalScrollChange}
                  className="flex-1 min-h-0"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <AddAccountFlow
      onAddAccountCtrader={ctx.openCtraderOAuth}
      onInstallClick={ctx.handleInstallBots}
      isInstalling={ctx.isInstalling}
      isInstalled={ctx.isInstalled}
      installResult={ctx.installResult}
      isWindows={ctx.platform === 'win32'}
    />
  );
}

interface WindowChromeProps {
  onOpenConfig: () => void;
  showOrdersTotalsPref: boolean;
  showResourcesPref?: boolean;
  resources?: Resources | null;
  isAddScreenOverlay?: boolean;
  onCloseAddScreen?: () => void;
}

function WindowChrome({
  onOpenConfig,
  showOrdersTotalsPref,
  showResourcesPref = false,
  resources = null,
  isAddScreenOverlay = false,
  onCloseAddScreen,
}: WindowChromeProps) {
  const { openExternalLink } = useExternalLink();

  const handleHelpClick = () => openExternalLink(urls.documentation);

  if (isAddScreenOverlay && onCloseAddScreen) {
    return (
      <div className="px-4 py-2">
        <div className="flex items-center justify-between text-sm w-full">
          <span className="text-lg font-bold text-gray-900">IPTRADE</span>
          <HeaderStatusInfo
            showResourcesPref={showResourcesPref}
            resources={resources}
            showOrdersTotalsPref={showOrdersTotalsPref}
          />
          <button
            type="button"
            onClick={onCloseAddScreen}
            className="rounded-lg text-gray-400 hover:text-gray-900 p-1 cursor-pointer"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-2">
      <div className="flex items-center justify-between text-sm text-gray-600">
        <div className="flex items-center gap-4">
          <span className="text-lg font-bold text-gray-900">IPTRADE</span>
        </div>
        <HeaderStatusInfo
          showResourcesPref={showResourcesPref}
          resources={resources}
          showOrdersTotalsPref={showOrdersTotalsPref}
        />
        <div className="flex items-center gap-4">
          <button type="button" onClick={onOpenConfig} className="text-gray-400 hover:text-gray-900 cursor-pointer" aria-label="Settings">
            <Settings className="h-4 w-4" />
          </button>
          <button type="button" onClick={handleHelpClick} className="text-gray-400 hover:text-gray-900 cursor-pointer" aria-label="Help">
            <HelpCircleIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectingAccountsState() {
  return (
    <FullPageState
      title="Connecting accounts"
      subtitle="Linking your account. This may take a moment."
      showSpinner
    />
  );
}

function LoadingAccountsState() {
  return (
    <FullPageState
      title="Loading your accounts..."
      subtitle="Please wait while we load your accounts..."
      showSpinner
    />
  );
}

interface AccountsTableProps {
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  scrollbarPortalTargetId?: string;
  accounts: TradingAccount[];
  masterAccounts: TradingAccount[];
  editingAccountId: string | null;
  onEdit: (accountId: string) => void;
  onEditForDelete: (accountId: string) => void;
  openWithDeleteAccountId: string | null;
  onSaveConfig: (accountId: string, config: SlaveConfig, closeAfterSave?: boolean, nickname?: string) => void | Promise<void>;
  expandedGroups: Record<string, boolean>;
  onToggleGroup: (accountId: string) => void;
  onDeleteAccount: (accountId: string) => void;
  onConvertAccount: (accountId: string, newType: 'master' | 'slave') => void | Promise<void>;
  onUpdateNickname: (accountId: string, nickname: string) => void | Promise<void>;
  onSetAccountTcpEnabled: (accountId: string, enabled: boolean) => void | Promise<unknown>;
  loadingAccountActionId: string | null;
  onDisconnectAllSlaves: (masterId: string) => void | Promise<void>;
  onReauthCtrader?: () => void | Promise<void>;
  canAddOrConvert: boolean;
  fixedLotSize: number | null;
  showNicknamePref: boolean;
  showSlaveConfigDetailsPref: boolean;
  showBalancePref: boolean;
  showEquityPref: boolean;
  showPnlPref: boolean;
  showOpenOrdersPref: boolean;
  alwaysShowColumnsPref: boolean;
  deletingAccountId: string | null;
}

function AccountsTable({
  scrollContainerRef,
  scrollbarPortalTargetId,
  accounts,
  masterAccounts,
  editingAccountId,
  onEdit,
  onEditForDelete,
  openWithDeleteAccountId,
  onSaveConfig,
  expandedGroups,
  onToggleGroup,
  onDeleteAccount,
  onConvertAccount,
  onUpdateNickname,
  onSetAccountTcpEnabled,
  onDisconnectAllSlaves,
  onReauthCtrader,
  canAddOrConvert,
  fixedLotSize,
  showNicknamePref,
  showSlaveConfigDetailsPref,
  showBalancePref,
  showEquityPref,
  showPnlPref,
  showOpenOrdersPref,
  alwaysShowColumnsPref,
  loadingAccountActionId,
  deletingAccountId,
}: AccountsTableProps) {
  const navigate = useNavigate();
  const { flashingAccountIds, ordersByAccountId } = useAccountOrders();
  const editFormRowRef = useRef<HTMLTableRowElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const tableScrollRef = scrollContainerRef as React.RefObject<HTMLDivElement>;
  const scrollbarTrackRef = useRef<HTMLDivElement | null>(null);
  const [scrollMetrics, setScrollMetrics] = useState<{
    scrollLeft: number;
    clientWidth: number;
    scrollWidth: number;
  } | null>(null);
  const isDraggingRef = useRef(false);
  const dragClickOffsetInThumbRef = useRef(0);

  const [containerWidth, setContainerWidth] = useState<number>(0);
  const tableRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    if (alwaysShowColumnsPref) return;
    const el = tableScrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    return () => { observer.disconnect(); };
  }, [alwaysShowColumnsPref]);

  type OptionalColumnKey = 'configSummary' | 'slaveConfig' | 'equity' | 'openOrders' | 'nickname' | 'platform' | 'balance' | 'pnl';
  const COLUMN_HIDE_PRIORITY: { key: OptionalColumnKey; pref: boolean; width: number }[] = useMemo(() => [
    { key: 'configSummary',  pref: true,                       width: 160 },
    { key: 'slaveConfig',    pref: showSlaveConfigDetailsPref, width: 120 },
    { key: 'equity',         pref: showEquityPref,             width: 90 },
    { key: 'openOrders',     pref: showOpenOrdersPref,         width: 70 },
    { key: 'nickname',       pref: showNicknamePref,           width: 100 },
    { key: 'platform',       pref: true,                       width: 100 },
    { key: 'balance',        pref: showBalancePref,            width: 90 },
    { key: 'pnl',            pref: showPnlPref,               width: 80 },
  ], [showSlaveConfigDetailsPref, showEquityPref, showOpenOrdersPref, showNicknamePref, showBalancePref, showPnlPref]);

  const [forcedHiddenCols, setForcedHiddenCols] = useState<Set<OptionalColumnKey>>(new Set());
  const forcedHiddenColsRef = useRef(forcedHiddenCols);
  forcedHiddenColsRef.current = forcedHiddenCols;

  const COLUMN_HIDE_FILL_RATIO = 0.96;

  useLayoutEffect(() => {
    const table = tableRef.current;
    const container = tableScrollRef.current;
    if (!table || !container || alwaysShowColumnsPref) return;

    const savedWidth = table.style.width;
    table.style.width = 'auto';
    const tableWidth = table.offsetWidth;
    table.style.width = savedWidth;

    const available = container.clientWidth * COLUMN_HIDE_FILL_RATIO;

    const hiddenSnapshot = forcedHiddenColsRef.current;
    const hiddenDueToSpace = COLUMN_HIDE_PRIORITY.filter(c => c.pref && hiddenSnapshot.has(c.key));
    const sumHiddenWidths = hiddenDueToSpace.reduce((sum, c) => sum + c.width, 0);
    const virtualTotal = tableWidth + sumHiddenWidths;

    const newHidden = new Set<OptionalColumnKey>();
    let running = virtualTotal;
    for (const col of COLUMN_HIDE_PRIORITY) {
      if (!col.pref) continue;
      if (running <= available) break;
      newHidden.add(col.key);
      running -= col.width;
    }

    setForcedHiddenCols((prev) => {
      if (prev.size === newHidden.size && [...newHidden].every((k) => prev.has(k))) return prev;
      return newHidden;
    });
  }, [containerWidth, alwaysShowColumnsPref, COLUMN_HIDE_PRIORITY]);

  const effectiveColumns = useMemo(() => {
    if (alwaysShowColumnsPref) {
      return {
        nickname: showNicknamePref,
        balance: showBalancePref,
        equity: showEquityPref,
        pnl: showPnlPref,
        openOrders: showOpenOrdersPref,
        slaveConfig: showSlaveConfigDetailsPref,
        configSummary: true,
        platform: true,
      };
    }
    return {
      nickname:       showNicknamePref       && !forcedHiddenCols.has('nickname'),
      balance:        showBalancePref         && !forcedHiddenCols.has('balance'),
      equity:         showEquityPref          && !forcedHiddenCols.has('equity'),
      pnl:            showPnlPref             && !forcedHiddenCols.has('pnl'),
      openOrders:     showOpenOrdersPref      && !forcedHiddenCols.has('openOrders'),
      slaveConfig:    showSlaveConfigDetailsPref && !forcedHiddenCols.has('slaveConfig'),
      configSummary:  !forcedHiddenCols.has('configSummary'),
      platform:       !forcedHiddenCols.has('platform'),
    };
  }, [alwaysShowColumnsPref, forcedHiddenCols, showNicknamePref, showBalancePref, showEquityPref, showPnlPref, showOpenOrdersPref, showSlaveConfigDetailsPref]);

  const showNickname = effectiveColumns.nickname;
  const showBalance = effectiveColumns.balance;
  const showEquity = effectiveColumns.equity;
  const showPnl = effectiveColumns.pnl;
  const showOpenOrders = effectiveColumns.openOrders;
  const showSlaveConfigDetails = effectiveColumns.slaveConfig;
  const showConfigSummary = effectiveColumns.configSummary;
  const showPlatform = effectiveColumns.platform;

  const updateScrollState = useCallback(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, scrollWidth } = el;
    setScrollMetrics({ scrollLeft, clientWidth, scrollWidth });
  }, []);

  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    updateScrollState();
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    el.addEventListener('scroll', updateScrollState);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', updateScrollState);
    };
  }, [updateScrollState, accounts.length]);

  const handleScrollbarTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest('[role="presentation"]')) return;
      const el = tableScrollRef.current;
      const track = scrollbarTrackRef.current;
      if (!el || !track || !scrollMetrics || scrollMetrics.scrollWidth <= scrollMetrics.clientWidth) return;
      const rect = track.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const trackWidth = rect.width;
      const ratio = Math.max(0, Math.min(1, x / trackWidth));
      const maxScroll = scrollMetrics.scrollWidth - scrollMetrics.clientWidth;
      el.scrollLeft = ratio * maxScroll;
    },
    [scrollMetrics]
  );

  const handleScrollbarThumbMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const el = tableScrollRef.current;
    const track = scrollbarTrackRef.current;
    const thumb = e.currentTarget as HTMLElement;
    if (!el || !track) return;
    isDraggingRef.current = true;
    const thumbRect = thumb.getBoundingClientRect();
    dragClickOffsetInThumbRef.current = e.clientX - thumbRect.left;
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const el = tableScrollRef.current;
      const track = scrollbarTrackRef.current;
      if (!el || !track) return;
      const { scrollWidth, clientWidth } = el;
      const maxScroll = scrollWidth - clientWidth;
      if (maxScroll <= 0) return;
      const trackRect = track.getBoundingClientRect();
      const trackWidth = trackRect.width;
      const thumbWidth = trackWidth * (clientWidth / scrollWidth);
      const thumbTravel = trackWidth - thumbWidth;
      if (thumbTravel <= 0) return;
      const desiredThumbLeft = e.clientX - trackRect.left - dragClickOffsetInThumbRef.current;
      const ratio = Math.max(0, Math.min(1, desiredThumbLeft / thumbTravel));
      el.scrollLeft = ratio * maxScroll;
    };
    const onMouseUp = () => {
      isDraggingRef.current = false;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);
  const tableColumnCount =
    7 +
    (showNickname ? 1 : 0) +
    (showPlatform ? 1 : 0) +
    (showBalance ? 1 : 0) +
    (showEquity ? 1 : 0) +
    (showPnl ? 1 : 0) +
    (showOpenOrders ? 1 : 0) +
    (showSlaveConfigDetails ? 1 : 0) +
    (showConfigSummary ? 1 : 0);
  const compareAccountsByAccountId = useCallback((a: TradingAccount, b: TradingAccount) => {
    const left = (a.accountId ?? a.displayId ?? a.id ?? '').trim();
    const right = (b.accountId ?? b.displayId ?? b.id ?? '').trim();
    const byAccountId = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    if (byAccountId !== 0) return byAccountId;
    return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
  }, []);

  const runScrollToEditForm = useCallback(() => {
    if (!scrollContainerRef?.current || !editFormRowRef.current) return;
    const container = scrollContainerRef.current;
    const row = editFormRowRef.current;
    const contRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const visibleTop = container.scrollTop;
    const visibleBottom = container.scrollTop + contRect.height;
    const rowTop = rowRect.top - contRect.top + container.scrollTop;
    const rowBottom = rowTop + rowRect.height;
    let newScrollTop = container.scrollTop;
    if (rowTop < visibleTop && rowBottom > visibleBottom) {
      newScrollTop = rowTop;
    } else if (rowTop < visibleTop) {
      newScrollTop = rowTop;
    } else if (rowBottom > visibleBottom) {
      newScrollTop = rowBottom - contRect.height;
    }
    if (newScrollTop !== container.scrollTop) {
      container.scrollTo({ top: newScrollTop, behavior: 'smooth' });
    }
  }, [scrollContainerRef]);

  useEffect(() => {
    if (!editingAccountId || !scrollContainerRef?.current) {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      return;
    }
    const id = setTimeout(() => {
      runScrollToEditForm();
      const row = editFormRowRef.current;
      if (row) {
        resizeObserverRef.current?.disconnect();
        resizeObserverRef.current = new ResizeObserver(runScrollToEditForm);
        resizeObserverRef.current.observe(row);
      }
    }, 0);
    return () => {
      clearTimeout(id);
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [editingAccountId, scrollContainerRef, runScrollToEditForm]);

  const groupedSlaves = useMemo(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const masters = accounts.filter((a) => a.type === 'master');
    const groups: Record<string, TradingAccount[]> = {};
    for (const master of masters) {
      if (master.slaveIds?.length) {
        const mappedSlaves = master.slaveIds
          .map((id) => byId.get(id))
          .filter((account): account is TradingAccount => account !== undefined && account.type === 'slave');
        if (mappedSlaves.length) {
          groups[master.id] = [...mappedSlaves].sort(compareAccountsByAccountId);
        }
      } else {
        const list = accounts.filter(
          (a) =>
            a.type === 'slave' &&
            (a.config?.masterAccountId === master.id || (!!master.tcpUrl && a.masterTcpUrl === master.tcpUrl))
        );
        if (list.length) groups[master.id] = [...list].sort(compareAccountsByAccountId);
      }
    }
    return groups;
  }, [accounts, compareAccountsByAccountId]);

  const groupedSlaveIds = useMemo(() => {
    const ids = new Set<string>();
    Object.values(groupedSlaves).forEach((list) => list.forEach((s) => ids.add(s.id)));
    return ids;
  }, [groupedSlaves]);

  const topLevelAccounts = useMemo(() => {
    const getPriority = (account: TradingAccount): number => {
      if (account.type === 'pending') return 0;
      const hasGroupedSlaves = account.type === 'master' && (groupedSlaves[account.id]?.length ?? 0) > 0;
      if (hasGroupedSlaves) return 2;
      return 1;
    };
    return accounts
      .filter((a) => !groupedSlaveIds.has(a.id))
      .sort((a, b) => {
        const byPriority = getPriority(a) - getPriority(b);
        if (byPriority !== 0) return byPriority;
        return compareAccountsByAccountId(a, b);
      });
  }, [accounts, groupedSlaveIds, groupedSlaves, compareAccountsByAccountId]);

  const masterSlaveCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.entries(groupedSlaves).forEach(([mid, slaves]) => {
      counts[mid] = slaves.filter((s) => s.connection === 'connected').length;
    });
    return counts;
  }, [groupedSlaves]);

  const formatConfigNumber = useCallback((value: number | undefined | null): string => {
    if (value == null || Number.isNaN(value)) return '';
    return Number(value.toFixed(4)).toString();
  }, []);

  const buildSlaveDetailsSummary = useCallback((account: TradingAccount): string[] => {
    if (account.type !== 'slave') return [];
    const details: string[] = [];
    const mode = account.config?.mode ?? 'multiplier';
    if (mode === 'fixedLot') {
      const fixedLot = account.config?.fixedLot ?? 0;
      details.push(`${formatConfigNumber(fixedLot)}`);
    } else {
      const multiplier = account.config?.multiplier ?? 1;
      details.push(`x${formatConfigNumber(multiplier)}`);
    }

    if (account.config?.reverseTrading) {
      details.push('Reverse');
    }

    if (account.config?.exactMatch) {
      details.push('Exact match');
    }

    const symbolTranslations = Array.isArray(account.config?.symbolTranslate)
      ? account.config?.symbolTranslate
        .filter((item) => (item.from ?? '').trim() || (item.to ?? '').trim())
        .map((item) => `${(item.from ?? '').trim()}:${(item.to ?? '').trim()}`)
      : [];
    if (symbolTranslations.length > 0) {
      details.push(symbolTranslations.join(', '));
    }

    const prefix = account.config?.prefix;
    if (typeof prefix === 'string' && prefix.trim()) {
      details.push(`+${prefix.trim()}`);
    } else if (prefix && typeof prefix !== 'string' && prefix.enabled && (prefix.value ?? '').trim()) {
      const action = prefix.action === 'remove' ? '-' : '+';
      details.push(`${action}${prefix.value.trim()}`);
    }

    const suffix = account.config?.suffix;
    if (typeof suffix === 'string' && suffix.trim()) {
      details.push(`+${suffix.trim()}`);
    } else if (suffix && typeof suffix !== 'string' && suffix.enabled && (suffix.value ?? '').trim()) {
      const action = suffix.action === 'remove' ? '-' : '+';
      details.push(`${action}${suffix.value.trim()}`);
    }

    return details;
  }, [formatConfigNumber]);

  const renderClassicConfigSummary = useCallback((account: TradingAccount): string => {
    if (account.type === 'slave' && (account.config?.masterAccountId || account.masterTcpUrl)) {
      const masterId = account.config?.masterAccountId ?? (account.masterTcpUrl ? masterAccounts.find((m) => m.tcpUrl === account.masterTcpUrl)?.id : null);
      const isExternalMaster = !masterId && !!account.masterTcpUrl;
      if (isExternalMaster) {
        return 'External master';
      }
      const masterLabel = (masterId ? masterAccounts.find((m) => m.id === masterId)?.displayId : null) ?? masterId ?? account.config?.masterAccountId ?? 'master';
      return `Listening ${masterLabel}`;
    }

    if (account.type === 'master') {
      const count = groupedSlaves[account.id]?.length ?? 0;
      return count === 0 ? 'No slaves assigned' : `${count} ${count === 1 ? 'slave assigned' : 'slaves assigned'}`;
    }
    if (account.type === 'pending') return 'No config assigned';
    if (account.type !== 'slave') return '—';
    const hasMaster = !!(account.config?.masterAccountId || account.masterTcpUrl);
    if (!hasMaster) return 'No master assigned';
    const localMasterId = account.config?.masterAccountId ?? (account.masterTcpUrl ? masterAccounts.find((m) => m.tcpUrl === account.masterTcpUrl)?.id : null);
    if (!localMasterId && account.masterTcpUrl) {
      return 'External master';
    }
    const masterLabel = masterAccounts.find((m) => m.id === account.config?.masterAccountId)?.displayId ?? account.config?.masterAccountId ?? 'master';
    return `Listening ${masterLabel}`;
  }, [groupedSlaves, masterAccounts]);

  const renderDetailedSlaveConfig = useCallback((account: TradingAccount): string => {
    if (!showSlaveConfigDetails || account.type !== 'slave') return '—';
    const details = buildSlaveDetailsSummary(account);
    if (details.length === 0) return '—';
    return details.join(' ');
  }, [buildSlaveDetailsSummary, showSlaveConfigDetails]);

  const rowToneClasses = (account: TradingAccount) => {
    if (deletingAccountId == account.id) return 'bg-gray-50 opacity-50 pointer-events-none';
    if (account.connection === 'offline') return 'bg-red-50 hover:bg-red-50';
    if (account.connection === 'connecting') return 'bg-gray-50 hover:bg-gray-50';
    if (account.type === 'pending') return 'bg-orange-100 hover:bg-orange-100';
    if (account.type === 'master') {
      const c = masterSlaveCounts[account.id] ?? 0;
      return c > 0 ? 'bg-blue-100 hover:bg-blue-100' : 'bg-gray-100 hover:bg-gray-100';
    }
    if (account.type === 'slave') {
      const hasMaster = !!(account.config?.masterAccountId || account.masterTcpUrl);
      return hasMaster ? 'bg-white hover:bg-white' : 'bg-yellow-50 hover:bg-yellow-50';
    }
    return 'hover:bg-white';
  };

  const renderAccountCells = (account: TradingAccount) => {
    const isOffline = account.connection === 'offline';
    const isConnecting = account.connection === 'connecting';
    const isConnected = account.connection === 'connected';
    const isDeleting = deletingAccountId === account.id;
    const isTemporaryBrokerError = account.reconnectType === 'server_maintenance' || account.reconnectType === 'cant_route_request';

    const historyAccountId = String(account.accountId ?? account.displayId ?? account.id);
    const goToHistory = (view: 'calendar' | 'orders') => {
      navigate(`/history?view=${view}&account=${encodeURIComponent(historyAccountId)}`);
    };

    return (
      <>
        <TableCell className="font-medium whitespace-nowrap">{account.displayId}</TableCell>
        {showNickname && <TableCell className="whitespace-nowrap">{account.nickname ?? '—'}</TableCell>}
        {showPlatform && <TableCell className="whitespace-nowrap">{getPlatformDisplayName(account.platform)}</TableCell>}
        <TableCell className="whitespace-nowrap">{account.server ?? '—'}</TableCell>
        <TableCell className="whitespace-nowrap">
          <div className={cn('capitalize', isConnected ? 'text-green-600' : isOffline ? 'text-red-600' : 'text-gray-600')}>
            {isConnected ? 'Connected' : isOffline
              ? (account.reconnectType === 'server_maintenance' ? 'Broker maintenance'
                : account.reconnectType === 'cant_route_request' ? 'Connection error'
                  : 'Offline')
              : 'Connecting'}
          </div>
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <div className="capitalize">
            {account.type === 'pending' ? 'Pending' : account.type === 'master' ? 'Master' : account.type === 'slave' ? 'Slave' : 'Unknown'}
          </div>
        </TableCell>
        <TableCell className="whitespace-nowrap">
          {(() => {
            const isPending = account.type === 'pending';
            const isDisabled = isPending || !isConnected;
            const checked = isPending ? true : account.tcpEnabled !== false;
            return (
              <Switch
                checked={checked}
                disabled={isDisabled}
                onCheckedChange={(next) => {
                  if (isDisabled) return;
                  void onSetAccountTcpEnabled(account.id, next);
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Toggle copy for ${account.displayId}`}
              />
            );
          })()}
        </TableCell>
        {showBalance && (
          <TableCell className="text-right tabular-nums whitespace-nowrap">
            {(() => {
              const key = String(account.accountId ?? account.displayId ?? account.id);
              const o = ordersByAccountId[key];
              const balance = o?.balance ?? account.balance ?? null;
              if (balance != null) return balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return '—';
            })()}
          </TableCell>
        )}
        {showEquity && (
          <TableCell className="text-right tabular-nums whitespace-nowrap">
            {(() => {
              const key = String(account.accountId ?? account.displayId ?? account.id);
              const o = ordersByAccountId[key];
              const bal = o?.balance ?? account.balance ?? null;
              const pnl = o?.pnl ?? account.unrealizedPnl ?? null;
              const equity =
                o?.equity ??
                account.equity ??
                (bal != null && pnl != null ? bal + pnl : null);
              if (equity != null) return equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return '—';
            })()}
          </TableCell>
        )}
        {showPnl && (
          <TableCell className="text-right tabular-nums whitespace-nowrap">
            {(() => {
              const key = String(account.accountId ?? account.displayId ?? account.id);
              const o = ordersByAccountId[key];
              const pnl = o?.pnl ?? account.unrealizedPnl ?? null;
              if (pnl != null) {
                const displayN = Math.abs(pnl) < 1e-10 ? 0 : pnl;
                return <span className={displayN >= 0 ? 'text-green-600' : 'text-red-600'}>{displayN.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
              }
              return '—';
            })()}
          </TableCell>
        )}
        {showOpenOrders && (
          <TableCell className="text-right tabular-nums whitespace-nowrap">
            {(() => {
              const key = String(account.accountId ?? account.displayId ?? account.id);
              const o = ordersByAccountId[key];
              if (o == null) return '—';
              const open = o.openTrades;
              const pend = o.pendingTrades ?? 0;
              const total = open + pend;
              return `${open}/${total}`;
            })()}
          </TableCell>
        )}
        {showSlaveConfigDetails && (
          <TableCell className="whitespace-nowrap text-xs text-gray-600">{renderDetailedSlaveConfig(account)}</TableCell>
        )}
        {showConfigSummary && (
          <TableCell className="whitespace-nowrap text-xs text-gray-600">{renderClassicConfigSummary(account)}</TableCell>
        )}
        <TableCell className="whitespace-nowrap">
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); goToHistory('calendar'); }}
              aria-label={`Open calendar for ${account.displayId}`}
              className="cursor-pointer hover:text-gray-400 p-1 rounded"
            >
              <CalendarDays className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); goToHistory('orders'); }}
              aria-label={`Open order history for ${account.displayId}`}
              className="cursor-pointer hover:text-gray-400 p-1 rounded"
            >
              <ListOrdered className="h-4 w-4" />
            </button>
            {(() => {
              if (account.type === 'pending' && !canAddOrConvert) {
                if (editingAccountId === account.id) {
                  return (
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={() => onEdit(account.id)}
                      className="cursor-pointer hover:text-gray-400 p-1 rounded"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  );
                }
                if (isOffline) {
                  return (
                    <button
                      type="button"
                      aria-label="Delete"
                      onClick={() => onEditForDelete(account.id)}
                      className="cursor-pointer hover:text-gray-400 p-1 rounded"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  );
                }
                return (
                  <button
                    type="button"
                    aria-label={editingAccountId === account.id ? 'Close' : 'Edit'}
                    onClick={() => onEdit(account.id)}
                    className="cursor-pointer hover:text-gray-400 p-1 rounded"
                  >
                    {editingAccountId === account.id ? <X className="h-4 w-4" /> : <PencilIcon className="h-4 w-4" />}
                  </button>
                );
              }
              if (isOffline) return (
                <>
                  {onReauthCtrader && (account.platform || '').toLowerCase() === 'ctrader' && (
                    <button
                      type="button"
                      onClick={() => onReauthCtrader()}
                      className="inline-flex items-center gap-1 cursor-pointer hover:text-gray-400 p-1 rounded text-xs font-medium"
                    >
                      <RefreshCw className="h-4 w-4 shrink-0" />
                    </button>
                  )}
                  {editingAccountId === account.id ? (
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={() => onEdit(account.id)}
                      className="cursor-pointer hover:text-gray-400 p-1 rounded"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label="Delete"
                      onClick={() => onEditForDelete(account.id)}
                      className="cursor-pointer hover:text-gray-400 p-1 rounded"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </>
              );

              if (isConnecting || isTemporaryBrokerError) {
                return (
                  <button
                    type="button"
                    aria-label={editingAccountId === account.id ? 'Close' : 'Edit'}
                    onClick={() => onEdit(account.id)}
                    className="cursor-pointer hover:text-gray-400 p-1 rounded"
                  >
                    {editingAccountId === account.id ? <X className="h-4 w-4" /> : <PencilIcon className="h-4 w-4" />}
                  </button>
                );
              }
              return (
                <button
                  type="button"
                  aria-label={editingAccountId === account.id ? 'Close' : 'Edit'}
                  onClick={() => onEdit(account.id)}
                  className="cursor-pointer hover:text-gray-400 p-1 rounded"
                >
                  {editingAccountId === account.id ? <X className="h-4 w-4" /> : <PencilIcon className="h-4 w-4" />}
                </button>
              );
            })()}
          </div>
        </TableCell>
      </>
    );
  };

  return (
    <div className="min-w-full relative">
      <Table
        ref={tableRef}
        className={cn(
          "text-sm border-separate border-spacing-0 [&_th]:px-4 [&_td]:px-4",
          alwaysShowColumnsPref ? "min-w-max" : "w-full"
        )}
      >
        <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-gray-50 [&_th]:border-b [&_th]:border-gray-200">
          <TableRow className="align-middle bg-gray-50 hover:bg-gray-50">
            <TableHead className="whitespace-nowrap" />
            <TableHead className="whitespace-nowrap">Account</TableHead>
            {showNickname && <TableHead className="whitespace-nowrap">Nickname</TableHead>}
            {showPlatform && <TableHead className="whitespace-nowrap">Platform</TableHead>}
            <TableHead className="whitespace-nowrap">Server</TableHead>
            <TableHead className="whitespace-nowrap">Status</TableHead>
            <TableHead className="whitespace-nowrap">Type</TableHead>
            <TableHead className="whitespace-nowrap">Copy</TableHead>
            {showBalance && <TableHead className="text-right whitespace-nowrap">Balance</TableHead>}
            {showEquity && <TableHead className="text-right whitespace-nowrap">Equity</TableHead>}
            {showPnl && <TableHead className="text-right whitespace-nowrap">PnL</TableHead>}
            {showOpenOrders && (
              <TableHead className="text-right whitespace-nowrap">
                Open
              </TableHead>
            )}
            {showSlaveConfigDetails && <TableHead className="whitespace-nowrap">Config</TableHead>}
            {showConfigSummary && <TableHead className="whitespace-nowrap"></TableHead>}
            <TableHead className="whitespace-nowrap"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {topLevelAccounts.map((account, accountIndex) => {
            const childSlaves = account.type === 'master' ? (groupedSlaves[account.id] ?? []) : [];
            const canExpand = account.type === 'master' && childSlaves.length > 0;
            const hasSlaveChildren = childSlaves.length > 0;
            const isExpanded = expandedGroups[account.id] !== false;
            const masterRowBorder = account.type === 'master' && hasSlaveChildren && !isExpanded;
            const isLastAccount = accountIndex === topLevelAccounts.length - 1;
            const hasExpandedSlaves = account.type === 'master' && isExpanded && childSlaves.length > 0;
            const mainRowIsLast = isLastAccount && editingAccountId !== account.id && !hasExpandedSlaves;
            return (
              <React.Fragment key={account.id}>
                <TableRow className={cn('align-middle', rowToneClasses(account), '[&_td]:border-b [&_td]:border-gray-200', flashingAccountIds.has(account.id) && 'bg-emerald-50/50')} style={{ transition: `background-color ${FLASH_TRANSITION_MS}ms ease-in-out` }}>
                  <TableCell className="w-8 whitespace-nowrap">
                    <button
                      type="button"
                      aria-label={canExpand ? 'Toggle connected accounts' : undefined}
                      onClick={() => canExpand && onToggleGroup(account.id)}
                      disabled={!canExpand}
                      className={cn('flex h-6 w-6 items-center justify-center rounded border border-transparent cursor-pointer', canExpand && 'hover:text-gray-400')}
                    >
                      <ChevronRight className={cn('h-4 w-4 transition-transform', isExpanded ? 'rotate-90' : '', !canExpand && 'invisible')} />
                    </button>
                  </TableCell>
                  {renderAccountCells(account)}
                </TableRow>
                {editingAccountId === account.id && (
                  <TableRow
                    ref={(el) => { editFormRowRef.current = el; }}
                    className={cn((!isLastAccount || hasExpandedSlaves) && '[&_td]:border-b [&_td]:border-gray-200')}
                  >
                    <TableCell colSpan={tableColumnCount} className={cn("p-3 overflow-hidden", !alwaysShowColumnsPref && "max-w-0")}>
                      <div className="min-w-0">
                        {account.type === 'master' ? (
                          <MasterConfigRow
                            account={account}
                            slaveCount={masterSlaveCounts[account.id] ?? 0}
                            onCancel={() => onEdit(account.id)}
                            onDelete={onDeleteAccount}
                            onConvertToSlave={onConvertAccount}
                            onUpdateNickname={onUpdateNickname}
                            onDisconnectAllSlaves={onDisconnectAllSlaves}
                            initialShowDelete={openWithDeleteAccountId === account.id}
                            isLastRow={isLastAccount && !hasExpandedSlaves}
                            isLoading={loadingAccountActionId === account.id}
                            isConnecting={account.connection === 'connecting'}
                          />
                        ) : account.type === 'pending' ? (
                          <PendingConfigRow
                            account={account}
                            onCancel={() => onEdit(account.id)}
                            onDelete={onDeleteAccount}
                            onConvertToSlave={onConvertAccount}
                            onConvertToMaster={onConvertAccount}
                            onUpdateNickname={onUpdateNickname}
                            canAddOrConvert={canAddOrConvert}
                            initialShowDelete={openWithDeleteAccountId === account.id}
                            isLastRow={isLastAccount && !hasExpandedSlaves}
                            isLoading={loadingAccountActionId === account.id}
                            isConnecting={account.connection === 'connecting'}
                          />
                        ) : (
                          <SlaveConfigRow
                            account={account}
                            masterAccounts={masterAccounts}
                            onCancel={() => onEdit(account.id)}
                            onSave={onSaveConfig}
                            onUpdateNickname={onUpdateNickname}
                            onDelete={onDeleteAccount}
                            onConvertAccount={onConvertAccount}
                            fixedLotSize={fixedLotSize}
                            initialShowDelete={openWithDeleteAccountId === account.id}
                            isLastRow={isLastAccount && !hasExpandedSlaves}
                            isLoading={loadingAccountActionId === account.id}
                            isConnecting={account.connection === 'connecting'}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {account.type === 'master' && isExpanded &&
                  childSlaves.map((slave, slaveIndex) => {
                    const isLastSlave = slaveIndex === childSlaves.length - 1;
                    const slaveRowIsLast = isLastAccount && isLastSlave && editingAccountId !== slave.id;
                    const slaveEditingRowIsLast = isLastAccount && isLastSlave && editingAccountId === slave.id;
                    return (
                      <React.Fragment key={slave.id}>
                        <TableRow className={cn('align-middle', rowToneClasses(slave), '[&_td]:border-b [&_td]:border-gray-200', flashingAccountIds.has(slave.id) && 'bg-emerald-50/50')} style={{ transition: `background-color ${FLASH_TRANSITION_MS}ms ease-in-out` }}>
                          <TableCell className="w-8 whitespace-nowrap">
                            <span className="flex h-6 w-6 items-center justify-center rounded border border-transparent">
                              <CornerDownRight className="h-4 w-4 text-gray-900" />
                            </span>
                          </TableCell>
                          {renderAccountCells(slave)}
                        </TableRow>
                        {editingAccountId === slave.id && (
                          <TableRow
                            ref={(el) => { editFormRowRef.current = el; }}
                            className={cn(!slaveEditingRowIsLast && '[&_td]:border-b [&_td]:border-gray-200')}
                          >
                            <TableCell colSpan={tableColumnCount} className={cn("p-3 overflow-hidden", !alwaysShowColumnsPref && "max-w-0")}>
                              <div className="min-w-0">
                                {(
                                  <SlaveConfigRow
                                    account={slave}
                                    masterAccounts={masterAccounts}
                                    onCancel={() => onEdit(slave.id)}
                                    onSave={onSaveConfig}
                                    onUpdateNickname={onUpdateNickname}
                                    onDelete={onDeleteAccount}
                                    onConvertAccount={onConvertAccount}
                                    fixedLotSize={fixedLotSize}
                                    initialShowDelete={openWithDeleteAccountId === slave.id}
                                    isLastRow={slaveEditingRowIsLast}
                                    isLoading={loadingAccountActionId === slave.id}
                                    isConnecting={slave.connection === 'connecting'}
                                  />
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </React.Fragment>
                    );
                  })}
              </React.Fragment>
            );
          })}
        </TableBody>
      </Table>
      {scrollbarPortalTargetId &&
        scrollMetrics &&
        scrollMetrics.scrollWidth > scrollMetrics.clientWidth &&
        (() => {
          const target = document.getElementById(scrollbarPortalTargetId);
          return target
            ? createPortal(
              <div className="flex items-center px-2 py-2 bg-white border-t border-gray-200 shrink-0">
                <div
                  ref={scrollbarTrackRef}
                  role="scrollbar"
                  aria-orientation="horizontal"
                  aria-valuenow={scrollMetrics.scrollLeft}
                  aria-valuemin={0}
                  aria-valuemax={scrollMetrics.scrollWidth - scrollMetrics.clientWidth}
                  className="relative h-2 flex-1 bg-gray-200 rounded-full overflow-hidden"
                  onClick={handleScrollbarTrackClick}
                >
                  <div
                    className="absolute top-0 h-full bg-gray-300 rounded-full  active:shrink-0 min-w-[24px]"
                    style={{
                      width: `${(scrollMetrics.clientWidth / scrollMetrics.scrollWidth) * 100}%`,
                      left: `${(scrollMetrics.scrollLeft / (scrollMetrics.scrollWidth - scrollMetrics.clientWidth)) * (100 - (scrollMetrics.clientWidth / scrollMetrics.scrollWidth) * 100)}%`,
                    }}
                    onMouseDown={handleScrollbarThumbMouseDown}
                    role="presentation"
                  />
                </div>
              </div>,
              target
            )
            : null;
        })()}
    </div>
  );
}

interface MasterConfigRowProps {
  account: TradingAccount;
  slaveCount: number;
  onCancel: () => void;
  onDelete: (id: string) => void;
  onConvertToSlave: (id: string, newType: 'slave') => void;
  onUpdateNickname: (id: string, nickname: string) => void;
  onDisconnectAllSlaves: (masterId: string) => void | Promise<void>;
  initialShowDelete?: boolean;
  isLastRow?: boolean;
  isLoading?: boolean;
  isConnecting?: boolean;
}

const MASTER_NICKNAME_MAX = 15;

function MasterConfigRow({ account, slaveCount, onCancel, onDelete, onConvertToSlave, onUpdateNickname, onDisconnectAllSlaves, initialShowDelete, isLastRow, isLoading = false, isConnecting = false }: MasterConfigRowProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(initialShowDelete ?? false);
  const [showDisconnectSlavesConfirm, setShowDisconnectSlavesConfirm] = useState(false);
  const [nickname, setNickname] = useState(account.nickname ?? '');

  const handleNicknameChange = (e: ChangeEvent<HTMLInputElement>) => {
    setNickname(e.target.value.slice(0, MASTER_NICKNAME_MAX));
  };

  const hasNicknameChange = nickname !== (account.nickname ?? '');

  const handleSaveNickname = async () => {
    if (hasNicknameChange) await Promise.resolve(onUpdateNickname(account.id, nickname));
    onCancel();
  };

  const boxClass = 'rounded-xl border border-gray-200 bg-gray-50 p-4';
  if (showDisconnectSlavesConfirm) {
    const label = slaveCount === 1 ? '1 slave' : `${slaveCount} slaves`;
    return (
      <div className={cn(boxClass, 'relative')}>
        {isLoading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-white/80 text-center text-gray-600" aria-busy="true">
            <Loader className="h-4 w-4 text-gray-400 m-2 animate-spin" />
            <p className="text-lg font-semibold text-gray-400">Disconnecting slaves</p>
          </div>
        )}
        <div className="mb-4 flex items-start justify-between gap-2">
          <h3 className="text-lg font-semibold text-gray-900">Disconnect all slaves?</h3>

          <button type="button" aria-label="Close" onClick={onCancel} className="cursor-pointer hover:text-gray-400 p-1 rounded shrink-0 disabled:opacity-50 disabled:cursor-not-allowed" disabled={isLoading}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center justify-start gap-2">
          <Button variant="outline" size="sm" className="h-9 rounded-lg border border-gray-200 bg-white shadow-none hover:bg-gray-50" disabled={isLoading} onClick={() => setShowDisconnectSlavesConfirm(false)}>Cancel</Button>
          <Button variant="outline" size="sm" className="h-9 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 shadow-none hover:bg-amber-100 hover:text-amber-800" disabled={isLoading} onClick={async () => { await Promise.resolve(onDisconnectAllSlaves(account.id)); onCancel(); }}>Disconnect all slaves</Button>
        </div>
      </div>
    );
  }
  const hasSlaves = slaveCount > 0;
  if (showDeleteConfirm) {
    return (
      <div className={boxClass}>
        <div className="mb-4 flex items-start justify-between gap-2">
          <h3 className="text-lg font-semibold text-gray-900">Delete this account?</h3>
          <button type="button" aria-label="Close" onClick={onCancel} className="cursor-pointer hover:text-gray-400 p-1 rounded shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center justify-start gap-2">
          <Button variant="outline" size="sm" className="h-9 rounded-lg border border-gray-200 bg-white shadow-none hover:bg-gray-50" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
          <Button variant="outline" size="sm" className="h-9 rounded-lg border border-red-200 bg-red-50 text-red-700 shadow-none hover:bg-red-100 hover:text-red-800" onClick={() => { onDelete(account.id); onCancel(); }}>Delete</Button>
        </div>
      </div>
    );
  }
  return (
    <div className={cn(boxClass, 'relative')}>
      {isLoading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-white/80 text-center text-gray-600" aria-busy="true">
          <Loader className="h-4 w-4 text-gray-600 m-2 animate-spin" />
          <p className="text-lg font-semibold text-gray-600">Saving</p>
        </div>
      )}
      <div className="mb-4 flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-gray-900">Master account {account.displayId}</h3>
        <button type="button" aria-label="Close" onClick={onCancel} className="cursor-pointer hover:text-gray-400 p-1 rounded shrink-0 disabled:opacity-50 disabled:cursor-not-allowed" disabled={isLoading}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 grid-cols-2">
          <div className="col-span-1 flex flex-wrap items-end justify-start gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 rounded-lg border border-red-200 bg-red-50 text-red-700 shadow-none hover:bg-red-100 hover:text-red-800"
                disabled={isLoading}
                onClick={() => setShowDeleteConfirm(true)}
              >
                Delete
              </Button>
              {hasSlaves && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 shadow-none hover:bg-amber-100 hover:text-amber-800"
                  disabled={isLoading || isConnecting}
                  onClick={() => setShowDisconnectSlavesConfirm(true)}
                >
                  Disconnect all slaves
                </Button>
              )}
              {!hasSlaves && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 shadow-none hover:bg-amber-100 hover:text-amber-800"
                  disabled={isLoading || isConnecting}
                  onClick={() => onConvertToSlave(account.id, 'slave')}
                >
                  Convert to slave
                </Button>
              )}
          </div>
          <div className="col-span-1">
            <div className="flex overflow-hidden rounded-lg border border-gray-200 bg-white">
              <span className="inline-flex h-9 shrink-0 items-center px-3 text-sm text-gray-500">Nickname</span>
              <Input
                placeholder="e.g. Main account"
                aria-label="Nickname"
                maxLength={MASTER_NICKNAME_MAX}
                value={nickname}
                onChange={handleNicknameChange}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && hasNicknameChange && !isLoading) {
                    e.preventDefault();
                    void handleSaveNickname();
                  }
                }}
                className="h-9 flex-1 rounded-none border-0 border-l border-gray-200 bg-white shadow-none"
                disabled={isLoading}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0 rounded-none border-0 border-l border-green-200 bg-green-50 text-green-700 shadow-none hover:bg-green-100 hover:text-green-800"
                disabled={!hasNicknameChange || isLoading}
                onClick={handleSaveNickname}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface PendingConfigRowProps {
  account: TradingAccount;
  onCancel: () => void;
  onDelete: (id: string) => void;
  onConvertToSlave: (id: string, newType: 'slave') => void;
  onConvertToMaster: (id: string, newType: 'master') => void;
  onUpdateNickname: (id: string, nickname: string) => void;
  canAddOrConvert: boolean;
  initialShowDelete?: boolean;
  isLastRow?: boolean;
  isLoading?: boolean;
  isConnecting?: boolean;
}

function PendingConfigRow({ account, onCancel, onDelete, onConvertToSlave, onConvertToMaster, onUpdateNickname, canAddOrConvert, initialShowDelete, isLastRow, isLoading = false, isConnecting = false }: PendingConfigRowProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(initialShowDelete ?? false);
  const [nickname, setNickname] = useState(account.nickname ?? '');

  const NICKNAME_MAX = 15;
  const handleNicknameChange = (e: ChangeEvent<HTMLInputElement>) => {
    setNickname(e.target.value.slice(0, NICKNAME_MAX));
  };

  const hasNicknameChange = nickname !== (account.nickname ?? '');

  const handleSaveNickname = async () => {
    if (hasNicknameChange) await Promise.resolve(onUpdateNickname(account.id, nickname));
    onCancel();
  };

  const boxClass = 'rounded-xl border border-gray-200 bg-gray-50 p-4';
  if (showDeleteConfirm) {
    return (
      <div className={boxClass}>
        <div className="mb-4 flex items-start justify-between gap-2">
          <h3 className="text-lg font-semibold text-gray-900">Delete this account?</h3>
          <button type="button" aria-label="Close" onClick={onCancel} className="cursor-pointer hover:text-gray-400 p-1 rounded shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center justify-start gap-2">
          <Button variant="outline" size="sm" className="h-9 rounded-lg border border-gray-200 bg-white shadow-none hover:bg-gray-50" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
          <Button variant="outline" size="sm" className="h-9 rounded-lg border border-red-200 bg-red-50 text-red-700 shadow-none hover:bg-red-100 hover:text-red-800" onClick={() => { onDelete(account.id); onCancel(); }}>Delete</Button>
        </div>
      </div>
    );
  }
  return (
    <div className={cn(boxClass, 'relative')}>
      {isLoading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-white/80 text-center text-gray-600" aria-busy="true">
          <Loader className="h-4 w-4 text-gray-600 m-2 animate-spin" />
          <p className="text-lg font-semibold text-gray-600">Processing</p>
        </div>
      )}
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Pending account {account.displayId}</h3>
          {!canAddOrConvert && (
            <p className="mt-0.5 text-sm text-amber-600">Account limit reached. Go to Billing to update your limits.</p>
          )}
        </div>
        <button type="button" aria-label="Close" onClick={onCancel} className="cursor-pointer hover:text-gray-400 p-1 rounded shrink-0 disabled:opacity-50 disabled:cursor-not-allowed" disabled={isLoading}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 grid-cols-2">
          <div className="col-span-1 flex flex-wrap items-end justify-start gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 rounded-lg border border-red-200 bg-red-50 text-red-700 shadow-none hover:bg-red-100 hover:text-red-800"
                disabled={isLoading}
                onClick={() => setShowDeleteConfirm(true)}
              >
                Delete
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  'h-9 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 shadow-none hover:bg-blue-100 hover:text-blue-800',
                  (!canAddOrConvert || isConnecting) && 'pointer-events-none opacity-50'
                )}
                disabled={isLoading || isConnecting}
                onClick={() => { if (canAddOrConvert && !isConnecting) onConvertToMaster(account.id, 'master'); }}
              >
                Convert to master
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  'h-9 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 shadow-none hover:bg-amber-100 hover:text-amber-800',
                  (!canAddOrConvert || isConnecting) && 'pointer-events-none opacity-50'
                )}
                disabled={isLoading || isConnecting}
                onClick={() => { if (canAddOrConvert && !isConnecting) onConvertToSlave(account.id, 'slave'); }}
              >
                Convert to slave
              </Button>
          </div>
          <div className="col-span-1">
            <div className="flex overflow-hidden rounded-lg border border-gray-200 bg-white">
              <span className="inline-flex h-9 shrink-0 items-center px-3 text-sm text-gray-500">Nickname</span>
              <Input
                placeholder="e.g. Main account"
                aria-label="Nickname"
                maxLength={NICKNAME_MAX}
                value={nickname}
                onChange={handleNicknameChange}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && hasNicknameChange && !isLoading) {
                    e.preventDefault();
                    void handleSaveNickname();
                  }
                }}
                className="h-9 flex-1 rounded-none border-0 border-l border-gray-200 bg-white shadow-none"
                disabled={isLoading}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0 rounded-none border-0 border-l border-green-200 bg-green-50 text-green-700 shadow-none hover:bg-green-100 hover:text-green-800"
                disabled={!hasNicknameChange || isLoading}
                onClick={handleSaveNickname}
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SlaveConfigRowProps {
  account: TradingAccount;
  masterAccounts: TradingAccount[];
  onCancel: () => void;
  onSave: (accountId: string, config: SlaveConfig, closeAfterSave?: boolean, nickname?: string) => void | Promise<void>;
  onUpdateNickname: (accountId: string, nickname: string) => void;
  onDelete?: (accountId: string) => void;
  onConvertAccount?: (accountId: string, newType: 'master' | 'slave') => void;
  fixedLotSize: number | null;
  initialShowDelete?: boolean;
  isLastRow?: boolean;
  isLoading?: boolean;
  isConnecting?: boolean;
}

const SLAVE_NICKNAME_MAX = 15;
const MULTIPLIER_MAX_DECIMALS = 4;
const MULTIPLIER_MAX_INTEGER_DIGITS = 4;
const FIXED_LOT_MAX_DECIMALS = 2;
const EXTERNAL_MASTER = '__external__' as const;
const DEFAULT_FIXED_LOT = 0.01;
const DEFAULT_LOT_MULTIPLIER = 1;

function resolveSlaveMasterSelection(
  account: TradingAccount,
  masterAccounts: TradingAccount[]
): string | null {
  const cfg = account.config ?? { masterAccountId: null };
  const localId =
    cfg.masterAccountId ??
    (account.masterTcpUrl ? masterAccounts.find((m) => m.tcpUrl === account.masterTcpUrl)?.id ?? null : null);
  if (localId) return localId;
  if (account.masterTcpUrl) return EXTERNAL_MASTER;
  return null;
}

function isExternalMasterSelection(value: string | null): value is typeof EXTERNAL_MASTER {
  return value === EXTERNAL_MASTER;
}

function sanitizeNumericText(value: string, maxDecimals?: number, maxIntegerDigits?: number): string {
  let out = value.replace(/[^\d.]/g, '');
  const firstDot = out.indexOf('.');
  if (firstDot !== -1) {
    out = out.slice(0, firstDot + 1) + out.slice(firstDot + 1).replace(/\./g, '');
    if (typeof maxDecimals === 'number' && maxDecimals >= 0) {
      const integerPart = out.slice(0, firstDot + 1);
      const decimalPart = out.slice(firstDot + 1, firstDot + 1 + maxDecimals);
      out = integerPart + decimalPart;
    }
  }
  if (typeof maxIntegerDigits === 'number' && maxIntegerDigits >= 0) {
    const dotIdx = out.indexOf('.');
    const intPart = dotIdx !== -1 ? out.slice(0, dotIdx) : out;
    const rest = dotIdx !== -1 ? out.slice(dotIdx) : '';
    if (intPart.length > maxIntegerDigits) {
      out = intPart.slice(0, maxIntegerDigits) + rest;
    }
  }
  return out;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parsePrefix(c: SlaveConfig['prefix']) {
  if (!c) return { enabled: false, action: 'add' as const, value: '' };
  if (typeof c === 'string') return { enabled: c.length > 0, action: 'add' as const, value: c };
  return { enabled: c.enabled, action: c.action ?? 'add', value: c.value ?? '' };
}
function parseSuffix(c: SlaveConfig['suffix']) {
  if (!c) return { enabled: false, action: 'add' as const, value: '' };
  if (typeof c === 'string') return { enabled: c.length > 0, action: 'add' as const, value: c };
  return { enabled: c.enabled, action: c.action ?? 'add', value: c.value ?? '' };
}
function parseSymbolTranslate(c: SlaveConfig['symbolTranslate']): SymbolTranslation[] {
  if (!c) return [];
  if (typeof c === 'boolean') return [];
  return Array.isArray(c) ? c : [];
}

function sanitizeCompleteSymbolTranslations(entries: SymbolTranslation[]): SymbolTranslation[] | undefined {
  const completeEntries = entries
    .map((entry) => ({
      from: (entry.from ?? '').trim(),
      to: (entry.to ?? '').trim(),
    }))
    .filter((entry) => entry.from && entry.to);

  return completeEntries.length > 0 ? completeEntries : undefined;
}

function slaveConfigsEqual(a: SlaveConfig, b: SlaveConfig): boolean {
  if (a.masterAccountId !== b.masterAccountId) return false;
  if ((a.masterTcpUrl ?? null) !== (b.masterTcpUrl ?? null)) return false;
  if ((a.mode ?? 'multiplier') !== (b.mode ?? 'multiplier')) return false;
  if ((a.fixedLot ?? null) !== (b.fixedLot ?? null)) return false;
  if ((a.multiplier ?? null) !== (b.multiplier ?? null)) return false;
  if ((a.reverseTrading ?? false) !== (b.reverseTrading ?? false)) return false;
  if ((a.exactMatch ?? false) !== (b.exactMatch ?? false)) return false;
  const pa = a.prefix;
  const pb = b.prefix;
  const paNorm = !pa ? { enabled: false, action: 'add' as const, value: '' } : typeof pa === 'string' ? { enabled: pa.length > 0, action: 'add' as const, value: pa } : { enabled: pa.enabled, action: pa.action ?? 'add', value: pa.value ?? '' };
  const pbNorm = !pb ? { enabled: false, action: 'add' as const, value: '' } : typeof pb === 'string' ? { enabled: pb.length > 0, action: 'add' as const, value: pb } : { enabled: pb.enabled, action: pb.action ?? 'add', value: pb.value ?? '' };
  if (paNorm.enabled !== pbNorm.enabled || paNorm.action !== pbNorm.action || paNorm.value !== pbNorm.value) return false;
  const sa = a.suffix;
  const sb = b.suffix;
  const saNorm = !sa ? { enabled: false, action: 'add' as const, value: '' } : typeof sa === 'string' ? { enabled: sa.length > 0, action: 'add' as const, value: sa } : { enabled: sa.enabled, action: sa.action ?? 'add', value: sa.value ?? '' };
  const sbNorm = !sb ? { enabled: false, action: 'add' as const, value: '' } : typeof sb === 'string' ? { enabled: sb.length > 0, action: 'add' as const, value: sb } : { enabled: sb.enabled, action: sb.action ?? 'add', value: sb.value ?? '' };
  if (saNorm.enabled !== sbNorm.enabled || saNorm.action !== sbNorm.action || saNorm.value !== sbNorm.value) return false;
  const ta = Array.isArray(a.symbolTranslate) ? a.symbolTranslate : [];
  const tb = Array.isArray(b.symbolTranslate) ? b.symbolTranslate : [];
  if (ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) {
    if ((ta[i].from ?? '') !== (tb[i].from ?? '') || (ta[i].to ?? '') !== (tb[i].to ?? '')) return false;
  }
  return true;
}

function SlaveConfigRow({ account, masterAccounts, onCancel, onSave, onUpdateNickname, onDelete, onConvertAccount, fixedLotSize, initialShowDelete, isLastRow, isLoading = false, isConnecting = false }: SlaveConfigRowProps) {
  const hasPlanFixedLot = fixedLotSize != null && fixedLotSize > 0;
  const cfg: SlaveConfig = account.config ?? { masterAccountId: null, mode: 'multiplier' };
  const [masterSelection, setMasterSelection] = useState<string | null>(() =>
    resolveSlaveMasterSelection(account, masterAccounts)
  );
  const [nickname, setNickname] = useState(account.nickname ?? '');
  const [mode, setMode] = useState<'fixedLot' | 'multiplier'>(hasPlanFixedLot ? 'fixedLot' : (cfg.mode ?? 'multiplier'));
  const [fixedLotInput, setFixedLotInput] = useState(() =>
    hasPlanFixedLot && fixedLotSize != null
      ? String(fixedLotSize)
      : cfg.fixedLot != null
        ? String(cfg.fixedLot)
        : String(DEFAULT_FIXED_LOT)
  );
  const [multiplierInput, setMultiplierInput] = useState(() =>
    sanitizeNumericText(
      cfg.multiplier != null ? String(cfg.multiplier) : String(DEFAULT_LOT_MULTIPLIER),
      MULTIPLIER_MAX_DECIMALS,
      MULTIPLIER_MAX_INTEGER_DIGITS
    )
  );
  const [prefixEnabled, setPrefixEnabled] = useState(parsePrefix(cfg.prefix).enabled);
  const [prefixAction, setPrefixAction] = useState<'add' | 'remove'>(parsePrefix(cfg.prefix).action);
  const [prefixValue, setPrefixValue] = useState(parsePrefix(cfg.prefix).value);
  const [suffixEnabled, setSuffixEnabled] = useState(parseSuffix(cfg.suffix).enabled);
  const [suffixAction, setSuffixAction] = useState<'add' | 'remove'>(parseSuffix(cfg.suffix).action);
  const [suffixValue, setSuffixValue] = useState(parseSuffix(cfg.suffix).value);
  const [symbolTranslateEnabled, setSymbolTranslateEnabled] = useState(
    Array.isArray(cfg.symbolTranslate) ? cfg.symbolTranslate.length > 0 : !!cfg.symbolTranslate
  );
  const [symbolTranslations, setSymbolTranslations] = useState<SymbolTranslation[]>(
    parseSymbolTranslate(cfg.symbolTranslate).length > 0 ? parseSymbolTranslate(cfg.symbolTranslate) : [{ from: '', to: '' }]
  );
  const [reverseTrading, setReverseTrading] = useState(cfg.reverseTrading ?? false);
  const [exactMatch, setExactMatch] = useState(cfg.exactMatch ?? false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(initialShowDelete ?? false);

  const markDirty = useCallback(() => { }, []);

  const prevAccountIdRef = useRef(account.id);
  useEffect(() => {
    if (prevAccountIdRef.current !== account.id) {
      prevAccountIdRef.current = account.id;
      const c = account.config ?? { masterAccountId: null, mode: 'multiplier' as const };
      setMasterSelection(resolveSlaveMasterSelection(account, masterAccounts));
      setFixedLotInput(
        hasPlanFixedLot && fixedLotSize != null
          ? String(fixedLotSize)
          : c.fixedLot != null
            ? String(c.fixedLot)
            : String(DEFAULT_FIXED_LOT)
      );
      setMultiplierInput(
        sanitizeNumericText(
          c.multiplier != null ? String(c.multiplier) : String(DEFAULT_LOT_MULTIPLIER),
          MULTIPLIER_MAX_DECIMALS,
          MULTIPLIER_MAX_INTEGER_DIGITS
        )
      );
    }
  }, [account.id, account.config?.fixedLot, account.config?.multiplier, account.masterTcpUrl, hasPlanFixedLot, fixedLotSize, masterAccounts]);

  const initialConfig = useMemo((): SlaveConfig => {
    const c = cfg;
    const selection = resolveSlaveMasterSelection(account, masterAccounts);
    const resolvedMid = isExternalMasterSelection(selection) ? null : selection;
    const master = resolvedMid ? masterAccounts.find((m) => m.id === resolvedMid) : null;
    const externalTcpUrl = isExternalMasterSelection(selection) && account.masterTcpUrl ? account.masterTcpUrl : null;
    const effectiveMode = hasPlanFixedLot ? 'fixedLot' : (c.mode ?? 'multiplier');
    const fixedLotVal = hasPlanFixedLot ? fixedLotSize! : c.fixedLot;
    const multiplierVal = c.multiplier;
    const pf = parsePrefix(c.prefix);
    const sf = parseSuffix(c.suffix);
    const st = parseSymbolTranslate(c.symbolTranslate);
    const prefixConfig = { enabled: pf.enabled, value: pf.value, action: pf.action };
    const suffixConfig = { enabled: sf.enabled, value: sf.value, action: sf.action };
    const symbolTranslateConfig = sanitizeCompleteSymbolTranslations(st);
    return {
      masterAccountId: resolvedMid,
      masterTcpUrl: master?.tcpUrl ?? externalTcpUrl,
      mode: effectiveMode,
      fixedLot: fixedLotVal,
      multiplier: multiplierVal,
      prefix: prefixConfig,
      suffix: suffixConfig,
      symbolTranslate: symbolTranslateConfig,
      reverseTrading: c.reverseTrading ?? false,
      exactMatch: c.exactMatch ?? false,
    };
  }, [account.id, account.masterTcpUrl, cfg, hasPlanFixedLot, fixedLotSize, masterAccounts]);

  const handleNicknameChange = (e: ChangeEvent<HTMLInputElement>) => {
    setNickname(e.target.value.slice(0, SLAVE_NICKNAME_MAX));
  };

  const hasNicknameChange = nickname !== (account.nickname ?? '');

  const addSymbolTranslation = () => {
    markDirty();
    setSymbolTranslations((prev) => [...prev, { from: '', to: '' }]);
  };
  const updateSymbolTranslation = (index: number, field: 'from' | 'to', value: string) => {
    markDirty();
    setSymbolTranslations((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };
  const removeSymbolTranslation = (index: number) => {
    markDirty();
    if (symbolTranslations.length <= 1) {
      setSymbolTranslateEnabled(false);
      setSymbolTranslations([{ from: '', to: '' }]);
      return;
    }
    setSymbolTranslations((prev) => prev.filter((_, i) => i !== index));
  };

  const buildConfig = useCallback((): SlaveConfig => {
    const isExternal = isExternalMasterSelection(masterSelection);
    const master = masterSelection && !isExternal ? masterAccounts.find((m) => m.id === masterSelection) : null;
    const effectiveMode = hasPlanFixedLot ? 'fixedLot' : mode;
    const parsedFixedLot = parseFloat(fixedLotInput);
    const fixedLotVal = hasPlanFixedLot
      ? fixedLotSize
      : Number.isFinite(parsedFixedLot)
        ? roundToDecimals(parsedFixedLot, FIXED_LOT_MAX_DECIMALS)
        : DEFAULT_FIXED_LOT;
    const parsedMultiplier = parseFloat(multiplierInput);
    const baseMultiplierVal = Number.isFinite(parsedMultiplier)
      ? roundToDecimals(parsedMultiplier, MULTIPLIER_MAX_DECIMALS)
      : DEFAULT_LOT_MULTIPLIER;
    const multiplierVal = baseMultiplierVal;
    const prefixConfig = { enabled: prefixEnabled, value: prefixValue, action: prefixAction };
    const suffixConfig = { enabled: suffixEnabled, value: suffixValue, action: suffixAction };
    const symbolTranslateConfig = symbolTranslateEnabled
      ? sanitizeCompleteSymbolTranslations(symbolTranslations)
      : undefined;
    return {
      masterAccountId: isExternal ? null : masterSelection,
      masterTcpUrl: isExternal ? (account.masterTcpUrl ?? null) : (master?.tcpUrl ?? null),
      mode: effectiveMode,
      fixedLot: fixedLotVal,
      multiplier: multiplierVal,
      prefix: prefixConfig,
      suffix: suffixConfig,
      symbolTranslate: symbolTranslateConfig,
      reverseTrading,
      exactMatch,
    };
  }, [
    masterSelection,
    account.masterTcpUrl,
    masterAccounts,
    hasPlanFixedLot,
    fixedLotSize,
    mode,
    fixedLotInput,
    multiplierInput,
    prefixEnabled,
    prefixValue,
    prefixAction,
    suffixEnabled,
    suffixValue,
    suffixAction,
    symbolTranslateEnabled,
    symbolTranslations,
    reverseTrading,
    exactMatch,
  ]);

  const hasConfigChanges = useMemo(
    () => !slaveConfigsEqual(buildConfig(), initialConfig),
    [buildConfig, initialConfig]
  );
  const hasChanges = hasConfigChanges || hasNicknameChange;

  const handleSave = async () => {
    if (!hasChanges) return;
    await Promise.resolve(onSave(account.id, buildConfig(), true, hasNicknameChange ? nickname : undefined));
  };

  const boxClass = 'rounded-xl border border-gray-200 bg-gray-50 p-4';
  const configDisabled = isLoading || isConnecting;
  if (showDeleteConfirm) {
    return (
      <div className={boxClass}>
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Delete this account?</h3>
            <p className="mt-0.5 text-sm text-gray-400">This will remove {account.displayId} from your list. This action cannot be undone.</p>
          </div>
          <button type="button" aria-label="Close" onClick={onCancel} className="cursor-pointer hover:text-gray-400 p-1 rounded shrink-0 disabled:opacity-50 disabled:cursor-not-allowed">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center justify-start gap-2">
          <Button variant="outline" size="sm" className="h-9 rounded-lg border border-gray-200 bg-white shadow-none hover:bg-gray-50" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
          <Button variant="outline" size="sm" className="h-9 rounded-lg border border-red-200 bg-red-50 text-red-700 shadow-none hover:bg-red-100 hover:text-red-800" onClick={() => { onDelete?.(account.id); onCancel(); }}>Delete</Button>
        </div>
      </div>
    );
  }
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!hasChanges || isLoading) return;
        void handleSave();
      }}
      className={cn(boxClass, 'relative')}
    >
      {isLoading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-white/80 text-center text-gray-600" aria-busy="true">
          <Loader className="h-4 w-4 text-gray-400 m-2 animate-spin" />
          <p className="text-lg font-semibold text-gray-400">Saving</p>
        </div>
      )}
      <div className="mb-4 flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-gray-900">Slave account {account.displayId}</h3>
        <button type="button" aria-label="Close" onClick={onCancel} className="cursor-pointer hover:text-gray-400 p-1 rounded shrink-0 disabled:opacity-50 disabled:cursor-not-allowed" disabled={isLoading}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div className="flex overflow-hidden rounded-lg border border-gray-200 bg-white">
              <span className="inline-flex h-9 shrink-0 items-center px-3 text-sm text-gray-500">Nickname</span>
              <Input
                placeholder="e.g. Main account"
                aria-label="Nickname"
                maxLength={SLAVE_NICKNAME_MAX}
                value={nickname}
                onChange={handleNicknameChange}
                className="h-9 flex-1 rounded-none border-0 border-l border-gray-200 bg-white shadow-none"
                disabled={isLoading}
              />
            </div>
          </div>
          <div>
            <div className="flex overflow-hidden rounded-lg border border-gray-200 bg-white">
              <span className="inline-flex h-9 shrink-0 items-center px-3 text-sm text-gray-500">Copy from</span>
              <Select
                value={masterSelection ?? 'none'}
                disabled={configDisabled}
                onValueChange={(v) => {
                  if (v === 'none') {
                    markDirty();
                    setMasterSelection(null);
                    return;
                  }
                  markDirty();
                  setMasterSelection(v);
                }}
              >
                <SelectTrigger className="h-9 flex-1 rounded-none border-0 border-l border-gray-200 bg-white shadow-none focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none" aria-label="Connect to master">
                  <SelectValue placeholder="Connect to master">
                    {isExternalMasterSelection(masterSelection)
                      ? 'External master'
                      : masterSelection
                        ? `Master ${masterAccounts.find((m) => m.id === masterSelection)?.displayId ?? masterSelection}`
                        : 'No master selected'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="overflow-hidden rounded-lg border border-gray-200 bg-white p-0 [&_[data-radix-select-viewport]]:p-0">
                  <SelectItem
                    value="none"
                    className="cursor-pointer rounded-none border-b border-gray-200 py-2 pl-3 pr-8 text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:bg-gray-100 data-[state=checked]:bg-gray-100 data-[state=checked]:text-gray-900 last:border-b-0"
                  >
                    No master selected
                  </SelectItem>
                  {isExternalMasterSelection(masterSelection) && (
                    <SelectItem
                      value={EXTERNAL_MASTER}
                      className="cursor-pointer rounded-none border-b border-gray-200 py-2 pl-3 pr-8 text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:bg-gray-100 data-[state=checked]:bg-gray-100 data-[state=checked]:text-gray-900 last:border-b-0"
                    >
                      External master
                    </SelectItem>
                  )}
                  {masterAccounts.filter((m) => m.id !== account.id).map((m) => {
                    return (
                      <SelectItem
                        key={m.id}
                        value={m.id}
                        className={cn(
                          'cursor-pointer rounded-none border-b border-gray-200 py-2 pl-3 pr-8 text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:bg-gray-100 data-[state=checked]:bg-gray-100 data-[state=checked]:text-gray-900 last:border-b-0'
                        )}
                      >
                        <span className="block">{m.displayId}</span>
                        <span className="block text-xs mt-0.5">
                          {[m.nickname || '', m.server || '', getPlatformDisplayName(m.platform)].filter(Boolean).join(' ')}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <div className="flex overflow-hidden rounded-lg border border-input bg-white">
              <label className={cn('flex h-9 min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2', hasPlanFixedLot && 'opacity-90')}>
                <div className="flex items-center flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                  <span className={cn('text-sm text-gray-500', hasPlanFixedLot && 'opacity-60')}>Fixed lot</span>
                </div>
                <Switch
                  checked={hasPlanFixedLot ? true : mode === 'fixedLot'}
                  onCheckedChange={(checked) => { if (!hasPlanFixedLot) { markDirty(); setMode(checked ? 'fixedLot' : 'multiplier'); } }}
                  disabled={hasPlanFixedLot || configDisabled}
                  className="shrink-0"
                />
              </label>
              <Input
                type="text"
                inputMode="decimal"
                placeholder=""
                aria-label="Fixed lot"
                value={hasPlanFixedLot ? String(fixedLotSize) : fixedLotInput}
                onChange={(e) => { if (!hasPlanFixedLot) { markDirty(); setFixedLotInput(sanitizeNumericText(e.target.value, FIXED_LOT_MAX_DECIMALS)); } }}
                onBlur={() => { if (!hasPlanFixedLot && fixedLotInput.trim() === '') setFixedLotInput(String(DEFAULT_FIXED_LOT)); }}
                disabled={hasPlanFixedLot || mode !== 'fixedLot' || configDisabled}
                className={cn(
                  'h-9 w-20 shrink-0 rounded-none border-0 border-l border-input bg-white shadow-none',
                  (hasPlanFixedLot || mode !== 'fixedLot') && 'opacity-60'
                )}
              />
            </div>
          </div>
          <div>
            <div className="flex overflow-hidden rounded-lg border border-input bg-white">
              <label className={cn('flex h-9 min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2', hasPlanFixedLot && 'opacity-90')}>
                <div className="flex items-center flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                  <span className={cn('text-sm text-gray-500', hasPlanFixedLot && 'opacity-60')}>Multiplier</span>
                </div>
                <Switch
                  checked={hasPlanFixedLot ? false : mode === 'multiplier'}
                  onCheckedChange={(checked) => { if (!hasPlanFixedLot) { markDirty(); setMode(checked ? 'multiplier' : 'fixedLot'); } }}
                  disabled={hasPlanFixedLot || configDisabled}
                  className="shrink-0"
                />
              </label>
              <Input
                type="text"
                inputMode="decimal"
                placeholder=""
                aria-label="Multiplier"
                value={multiplierInput}
                onChange={(e) => { markDirty(); setMultiplierInput(sanitizeNumericText(e.target.value, MULTIPLIER_MAX_DECIMALS, MULTIPLIER_MAX_INTEGER_DIGITS)); }}
                onBlur={() => { if (multiplierInput.trim() === '') setMultiplierInput(String(DEFAULT_LOT_MULTIPLIER)); }}
                onPaste={(e) => {
                  e.preventDefault();
                  const el = e.target as HTMLInputElement;
                  const start = el.selectionStart ?? 0;
                  const end = el.selectionEnd ?? 0;
                  const merged = multiplierInput.slice(0, start) + e.clipboardData.getData('text') + multiplierInput.slice(end);
                  const sanitized = sanitizeNumericText(merged, MULTIPLIER_MAX_DECIMALS, MULTIPLIER_MAX_INTEGER_DIGITS);
                  markDirty();
                  setMultiplierInput(sanitized);
                }}
                onKeyDown={(e) => {
                  if (e.key === '.' || (e.key >= '0' && e.key <= '9')) {
                    const el = e.target as HTMLInputElement;
                    const start = el.selectionStart ?? 0;
                    const end = el.selectionEnd ?? 0;
                    const next = multiplierInput.slice(0, start) + (e.key === '.' ? '.' : e.key) + multiplierInput.slice(end);
                    const dotIdx = next.indexOf('.');
                    const intPart = dotIdx !== -1 ? next.slice(0, dotIdx) : next;
                    if (intPart.length > MULTIPLIER_MAX_INTEGER_DIGITS) e.preventDefault();
                    if (dotIdx !== -1) {
                      const decimals = next.length - dotIdx - 1;
                      if (decimals > MULTIPLIER_MAX_DECIMALS) e.preventDefault();
                    }
                  }
                }}
                                disabled={hasPlanFixedLot || mode !== 'multiplier' || configDisabled}
                className={cn(
                  'h-9 w-20 shrink-0 rounded-none border-0 border-l border-input bg-white shadow-none',
                  (hasPlanFixedLot || mode !== 'multiplier') && 'opacity-60'
                )}
              />
            </div>
          </div>
          <div>
            <label className="flex items-center justify-between rounded-lg border border-input bg-white px-3 py-2 h-9">
              <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                <span className="text-sm text-gray-500">Reverse trading</span>
              </div>
              <Switch
                checked={reverseTrading}
                onCheckedChange={(v) => { markDirty(); setReverseTrading(v); }}
                disabled={configDisabled}
              />
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="flex items-center justify-between rounded-lg border border-input bg-white px-3 py-2 h-9">
              <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                <span className="text-sm text-gray-500">Exact match</span>
              </div>
              <Switch checked={exactMatch} onCheckedChange={(v) => { markDirty(); setExactMatch(v); }} disabled={configDisabled} />
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div className="flex overflow-hidden rounded-lg border border-input bg-white">
              <span className="inline-flex h-9 shrink-0 items-center px-3 text-sm text-gray-500">Prefix</span>
              {prefixEnabled ? (
                <>
                  <div className="inline-flex h-9 shrink-0 items-center border-l border-gray-200 px-2">
                    <div className="inline-flex overflow-hidden rounded-md border border-gray-200 bg-white">
                      <button
                        type="button"
                        aria-label="Set prefix action to add"
                        disabled={configDisabled}
                        onClick={() => { markDirty(); setPrefixAction('add'); }}
                        className={cn(
                          'px-2.5 text-xs transition-colors border-r border-gray-200',
                          prefixAction === 'add'
                            ? 'bg-gray-100 text-gray-900'
                            : 'bg-white text-gray-500 hover:bg-gray-50',
                          configDisabled && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        aria-label="Set prefix action to remove"
                        disabled={configDisabled}
                        onClick={() => { markDirty(); setPrefixAction('remove'); }}
                        className={cn(
                          'px-2.5 text-xs transition-colors',
                          prefixAction === 'remove'
                            ? 'bg-gray-100 text-gray-900'
                            : 'bg-white text-gray-500 hover:bg-gray-50',
                          configDisabled && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <Input
                    placeholder="Value"
                    aria-label="Prefix value"
                    value={prefixValue}
                    onChange={(e) => { markDirty(); setPrefixValue(e.target.value); }}
                    className="h-9 min-w-0 flex-1 rounded-none border-0 border-l border-gray-200 bg-white shadow-none"
                    disabled={configDisabled}
                  />
                </>
              ) : (
                <span className="h-9 min-w-0 flex-1" />
              )}
              <div className={cn("inline-flex h-9 shrink-0 items-center px-2", prefixEnabled && "border-l border-gray-200")}>
                <Switch checked={prefixEnabled} onCheckedChange={(v) => { markDirty(); setPrefixEnabled(v); }} disabled={configDisabled} className="shrink-0" />
              </div>
            </div>
          </div>
          <div>
            <div className="flex overflow-hidden rounded-lg border border-input bg-white">
              <span className="inline-flex h-9 shrink-0 items-center px-3 text-sm text-gray-500">Suffix</span>
              {suffixEnabled ? (
                <>
                  <div className="inline-flex h-9 shrink-0 items-center border-l border-gray-200 px-2">
                    <div className="inline-flex overflow-hidden rounded-md border border-gray-200 bg-white">
                      <button
                        type="button"
                        aria-label="Set suffix action to add"
                        disabled={configDisabled}
                        onClick={() => { markDirty(); setSuffixAction('add'); }}
                        className={cn(
                          'px-2.5 text-xs transition-colors border-r border-gray-200',
                          suffixAction === 'add'
                            ? 'bg-gray-100 text-gray-900'
                            : 'bg-white text-gray-500 hover:bg-gray-50',
                          configDisabled && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        aria-label="Set suffix action to remove"
                        disabled={configDisabled}
                        onClick={() => { markDirty(); setSuffixAction('remove'); }}
                        className={cn(
                          'px-2.5 text-xs transition-colors',
                          suffixAction === 'remove'
                            ? 'bg-gray-100 text-gray-900'
                            : 'bg-white text-gray-500 hover:bg-gray-50',
                          configDisabled && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <Input
                    placeholder="Value"
                    aria-label="Suffix value"
                    value={suffixValue}
                    onChange={(e) => { markDirty(); setSuffixValue(e.target.value); }}
                    className="h-9 min-w-0 flex-1 rounded-none border-0 border-l border-gray-200 bg-white shadow-none"
                    disabled={configDisabled}
                  />
                </>
              ) : (
                <span className="h-9 min-w-0 flex-1" />
              )}
              <div className={cn("inline-flex h-9 shrink-0 items-center px-2", suffixEnabled && "border-l border-gray-200")}>
                <Switch checked={suffixEnabled} onCheckedChange={(v) => { markDirty(); setSuffixEnabled(v); }} disabled={configDisabled} className="shrink-0" />
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="flex h-9 overflow-hidden rounded-lg border border-input bg-white">
            <div className="flex min-w-0 flex-1 items-center px-3" onClick={(e) => e.stopPropagation()}>
              <span className="shrink-0 text-sm text-gray-500">Symbol translate</span>
            </div>
            {symbolTranslateEnabled && (
              <button
                type="button"
                aria-label="Add symbol translation row"
                disabled={configDisabled}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center border-l border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={(e) => {
                  e.stopPropagation();
                  addSymbolTranslation();
                }}
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
            <div className={cn("inline-flex h-9 shrink-0 items-center px-2", symbolTranslateEnabled && "border-l border-gray-200")}>
              <Switch checked={symbolTranslateEnabled} onCheckedChange={(checked) => { markDirty(); setSymbolTranslateEnabled(checked); if (!checked) setSymbolTranslations([{ from: '', to: '' }]); }} disabled={configDisabled} className="shrink-0" />
            </div>
          </div>
          {symbolTranslateEnabled && (
            <div className="mt-2 overflow-hidden rounded-lg border border-gray-200 bg-white">
              {symbolTranslations.map((t, index) => (
                <div key={index} className={cn('flex flex-nowrap items-center', index !== symbolTranslations.length - 1 && 'border-b border-gray-200')}>
                  <Input
                    placeholder="From"
                    value={t.from ?? ''}
                    onChange={(e) => updateSymbolTranslation(index, 'from', e.target.value)}
                    className="h-9 min-w-0 flex-1 rounded-none border-0 bg-white shadow-none"
                    disabled={configDisabled}
                  />
                  <Input
                    placeholder="To"
                    value={t.to ?? ''}
                    onChange={(e) => updateSymbolTranslation(index, 'to', e.target.value)}
                    className="h-9 min-w-0 flex-1 rounded-none border-0 border-l border-gray-200 bg-white shadow-none"
                    disabled={configDisabled}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-none border-0 border-l border-gray-200 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    onClick={() => removeSymbolTranslation(index)}
                    disabled={configDisabled}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" className="h-9 shrink-0 rounded-lg border border-red-200 bg-red-50 text-red-700 shadow-none hover:bg-red-100 hover:text-red-800" disabled={isLoading} onClick={() => setShowDeleteConfirm(true)}>Delete</Button>
            <Button type="button" variant="outline" size="sm" className={cn('h-9 shrink-0 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 shadow-none hover:bg-blue-100 hover:text-blue-800', isConnecting && 'pointer-events-none opacity-50')} disabled={isLoading || isConnecting} onClick={() => { if (!isConnecting) onConvertAccount?.(account.id, 'master'); }}>Convert to master</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" className="h-9 shrink-0 rounded-lg border border-gray-200 bg-gray-100 text-gray-700 shadow-none hover:bg-gray-200 hover:text-gray-800" disabled={isLoading} onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="outline" size="sm" className="h-9 shrink-0 rounded-lg border border-green-200 bg-green-50 text-green-700 shadow-none hover:bg-green-100 hover:text-green-800" disabled={!hasChanges || isLoading}>Save edit</Button>
          </div>
        </div>
      </div>
    </form>
  );
}
