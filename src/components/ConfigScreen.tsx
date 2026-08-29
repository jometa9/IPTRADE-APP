'use client';

import { Switch } from '@/components/ui/switch';
import { clearLogs, deleteAllAccounts, getAccountsStatus, getCtraderAppCredentials, setCtraderAppCredentials } from '@/api';
import type { AccountsStatusResponse } from '@/api';
import { useExternalLink } from '@/hooks/useExternalLink';
import type { AppPreferencesState, AppPreferencesUpdate } from '@/lib/preferences';
import { playAccountOnlineSound } from '@/lib/sounds';
import { getCurrentAppVersion } from '@/lib/version';
import { Loader, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface ConfigScreenProps {
  onPreferencesChange?: () => void;
  preferences: AppPreferencesState;
  updatePreferences: (updates: AppPreferencesUpdate) => Promise<boolean>;
}

export function ConfigScreen({ onPreferencesChange, preferences, updatePreferences }: ConfigScreenProps) {
  const [status, setStatus] = useState<AccountsStatusResponse | null>(null);
  const [loadingSwitch, setLoadingSwitch] = useState<string | null>(null);
  const showNickname = preferences.showNickname;
  const soundsEnabled = preferences.soundsEnabled;
  const showSlaveConfigDetails = preferences.showSlaveConfigDetails;
  const showOrdersTotals = preferences.showOrdersTotals;
  const showResources = preferences.showResources;
  const showBalance = preferences.showBalance;
  const showEquity = preferences.showEquity;
  const showPnl = preferences.showPnl;
  const showOpenOrders = preferences.showOpenOrders;
  const alwaysShowColumns = preferences.alwaysShowColumns;

  useEffect(() => {
    let cancelled = false;
    getAccountsStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleShowNicknameChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('showNickname');
      try {
        const ok = await updatePreferences({ showNickname: checked });
        if (ok) onPreferencesChange?.();
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const handleSoundsEnabledChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('soundsEnabled');
      try {
        const ok = await updatePreferences({ soundsEnabled: checked });
        if (ok) {
          onPreferencesChange?.();
          if (checked) playAccountOnlineSound();
        }
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const handleShowSlaveConfigDetailsChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('showSlaveConfigDetails');
      try {
        const ok = await updatePreferences({ showSlaveConfigDetails: checked });
        if (ok) onPreferencesChange?.();
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const handleShowOrdersTotalsChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('showOrdersTotals');
      try {
        const ok = await updatePreferences({ showOrdersTotals: checked });
        if (ok) onPreferencesChange?.();
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const handleShowResourcesChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('showResources');
      try {
        const ok = await updatePreferences({ showResources: checked });
        if (ok) onPreferencesChange?.();
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const handleShowBalanceChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('showBalance');
      try {
        const ok = await updatePreferences({ showBalance: checked });
        if (ok) onPreferencesChange?.();
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const handleShowEquityChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('showEquity');
      try {
        const ok = await updatePreferences({ showEquity: checked });
        if (ok) onPreferencesChange?.();
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const handleShowPnlChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('showPnl');
      try {
        const ok = await updatePreferences({ showPnl: checked });
        if (ok) onPreferencesChange?.();
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const handleShowOpenOrdersChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('showOpenOrders');
      try {
        const ok = await updatePreferences({ showOpenOrders: checked });
        if (ok) onPreferencesChange?.();
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const handleAlwaysShowColumnsChange = useCallback(
    async (checked: boolean) => {
      setLoadingSwitch('alwaysShowColumns');
      try {
        const ok = await updatePreferences({ alwaysShowColumns: checked });
        if (ok) onPreferencesChange?.();
      } finally {
        setLoadingSwitch(null);
      }
    },
    [updatePreferences, onPreferencesChange]
  );

  const [clearAllStep, setClearAllStep] = useState<'idle' | 'confirm'>('idle');
  const [isClearingAll, setIsClearingAll] = useState(false);
  const [clearAllError, setClearAllError] = useState<string | null>(null);

  const handleClearAllData = useCallback(async () => {
    setIsClearingAll(true);
    setClearAllError(null);
    try {
      await deleteAllAccounts();
      await clearLogs().catch(() => {});
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      window.location.reload();
    } catch (e) {
      setClearAllError(e instanceof Error ? e.message : 'Failed to clear data');
      setIsClearingAll(false);
    }
  }, []);

  const appVersion = status?.app?.app_version ?? getCurrentAppVersion();

  return (
    <div className="w-full self-start h-full min-h-0 overflow-auto  bg-gray-50">
      <div className="flex flex-col">
        <section className="flex flex-col gap-2 p-4 border-t border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Configuration</h2>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-2">
              <p className="text-sm text-gray-600">Interface</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">CPU / RAM info</span>
                  <Switch checked={showResources} onCheckedChange={handleShowResourcesChange} disabled={loadingSwitch === 'showResources'} />
                </div>
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">Open trades in header</span>
                  <Switch checked={showOrdersTotals} onCheckedChange={handleShowOrdersTotalsChange} disabled={loadingSwitch === 'showOrdersTotals'} />
                </div>
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">Connection sounds</span>
                  <Switch checked={soundsEnabled} onCheckedChange={handleSoundsEnabledChange} disabled={loadingSwitch === 'soundsEnabled'} />
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-sm  text-gray-600">Columns</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">Nickname</span>
                  <Switch checked={showNickname} onCheckedChange={handleShowNicknameChange} disabled={loadingSwitch === 'showNickname'} />
                </div>
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">Balance</span>
                  <Switch checked={showBalance} onCheckedChange={handleShowBalanceChange} disabled={loadingSwitch === 'showBalance'} />
                </div>
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">Equity</span>
                  <Switch checked={showEquity} onCheckedChange={handleShowEquityChange} disabled={loadingSwitch === 'showEquity'} />
                </div>
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">PnL</span>
                  <Switch checked={showPnl} onCheckedChange={handleShowPnlChange} disabled={loadingSwitch === 'showPnl'} />
                </div>
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">Open orders</span>
                  <Switch checked={showOpenOrders} onCheckedChange={handleShowOpenOrdersChange} disabled={loadingSwitch === 'showOpenOrders'} />
                </div>
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">Slave config</span>
                  <Switch checked={showSlaveConfigDetails} onCheckedChange={handleShowSlaveConfigDetailsChange} disabled={loadingSwitch === 'showSlaveConfigDetails'} />
                </div>
                <div className="flex items-center h-9 justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm">
                  <span className="text-gray-900 text-sm">Always show columns</span>
                  <Switch checked={alwaysShowColumns} onCheckedChange={handleAlwaysShowColumnsChange} disabled={loadingSwitch === 'alwaysShowColumns'} />
                </div>
              </div>
            </div>
          </div>
        </section>

        <CtraderApiSection />

        <section className="flex flex-col gap-2 p-4 border-t border-gray-200">
          {clearAllStep === 'idle' ? (
            <button
              type="button"
              className="inline-flex self-start items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-60"
              onClick={() => { setClearAllError(null); setClearAllStep('confirm'); }}
            >
              <Trash2 className="h-4 w-4 text-gray-700 shrink-0" />
              Clear all data
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-60"
                onClick={handleClearAllData}
                disabled={isClearingAll}
              >
                {isClearingAll ? (
                  <Loader className="h-4 w-4 animate-spin text-gray-700 shrink-0" />
                ) : (
                  <Trash2 className="h-4 w-4 text-gray-700 shrink-0" />
                )}
                Yes, clear all data
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-60"
                onClick={() => setClearAllStep('idle')}
                disabled={isClearingAll}
              >
                Cancel
              </button>
            </div>
          )}
          {clearAllError && (
            <p className="text-sm text-gray-600">{clearAllError}</p>
          )}
        </section>

          <div className="select-none p-4 border-t border-gray-200 flex flex-col gap-2">
            <p className="text-gray-300 cursor-default">IPTRADE {appVersion}</p>
          </div>
      </div>

    </div>
  );
}

function CtraderApiSection() {
  const { openExternalLink } = useExternalLink();
  const [configured, setConfigured] = useState(false);
  const [savedClientId, setSavedClientId] = useState<string | null>(null);
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCtraderAppCredentials()
      .then((c) => {
        if (cancelled) return;
        setConfigured(c.configured);
        setSavedClientId(c.client_id ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleSave = useCallback(async () => {
    const id = clientIdInput.trim();
    const secret = clientSecretInput.trim();
    if (!id || !secret) {
      setSaveError('Client ID and Client Secret are required');
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      await setCtraderAppCredentials(id, secret);
      setConfigured(true);
      setSavedClientId(id);
      setClientIdInput('');
      setClientSecretInput('');
      setIsEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setIsSaving(false);
    }
  }, [clientIdInput, clientSecretInput]);

  const showForm = isEditing || !configured;

  return (
    <section className="flex flex-col gap-2 p-4 border-t border-gray-200">
      <h2 className="text-lg font-semibold text-gray-900">cTrader API</h2>
      <p className="text-sm text-gray-600 max-w-2xl">
        To link cTrader accounts, IPTRADE uses your own cTrader Open API application. Create one for
        free at{' '}
        <button
          type="button"
          className="cursor-pointer underline hover:text-gray-900"
          onClick={() => openExternalLink('https://openapi.ctrader.com')}
        >
          openapi.ctrader.com
        </button>{' '}
        with the redirect URL <code className="rounded bg-gray-100 px-1">https://jometa9.github.io/IPTRADE/auth/local/callback</code>,
        then paste its Client ID and Secret here. They are stored encrypted on this computer only.
      </p>
      {showForm ? (
        <div className="flex flex-col gap-2 max-w-2xl">
          <input
            type="text"
            value={clientIdInput}
            onChange={(e) => setClientIdInput(e.target.value)}
            placeholder="Client ID"
            autoComplete="off"
            spellCheck={false}
            className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-gray-400"
          />
          <input
            type="password"
            value={clientSecretInput}
            onChange={(e) => setClientSecretInput(e.target.value)}
            placeholder="Client Secret"
            autoComplete="off"
            spellCheck={false}
            className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-gray-400"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-60"
              onClick={handleSave}
              disabled={isSaving}
            >
              {isSaving && <Loader className="h-4 w-4 animate-spin text-gray-700 shrink-0" />}
              Save credentials
            </button>
            {configured && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:opacity-60"
                onClick={() => { setIsEditing(false); setSaveError(null); }}
                disabled={isSaving}
              >
                Cancel
              </button>
            )}
          </div>
          {saveError && <p className="text-sm text-red-600">{saveError}</p>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-900">
            Configured{savedClientId ? ` — ${savedClientId.slice(0, 12)}…` : ''}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
            onClick={() => setIsEditing(true)}
          >
            Replace credentials
          </button>
        </div>
      )}
    </section>
  );
}
