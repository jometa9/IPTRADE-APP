import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { getHistoryDeals, getHistoryEligibleAccounts } from '@/api';
import type {
  HistoryAccount,
  HistoryDeal,
  HistorySyncStatus,
} from '@/api';
import { clearLegacyHistoryStorage, isRangeFullyCovered, mergeCoveredRange } from '@/lib/historyCache';
import type { CoveredRange } from '@/api';
import type { Granularity } from '@/components/history/calendarMath';

interface HistoryFilterState {
  selectedAccountIds: string[];
  fromMs: number | null;
  toMs: number | null;
}

const FILTER_DEFAULT_DAYS = 28;
const ACCOUNTS_REFETCH_INTERVAL_MS = 5 * 60_000;
const TODAY_FRESHNESS_TOLERANCE_MS = 30_000;
const TODAY_OVERLAP_MS = 60 * 60_000;
const FILTER_STORAGE_KEY = 'iptrade.history.filter.v1';
const GRANULARITY_STORAGE_KEY = 'iptrade.history.granularity.v1';

function isGranularity(v: unknown): v is Granularity {
  return v === 'month' || v === 'quarter' || v === 'year';
}

function loadPersistedGranularity(): Granularity {
  if (typeof window === 'undefined') return 'month';
  try {
    const raw = window.localStorage.getItem(GRANULARITY_STORAGE_KEY);
    if (!raw) return 'month';
    return isGranularity(raw) ? raw : 'month';
  } catch {
    return 'month';
  }
}

function savePersistedGranularity(g: Granularity): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(GRANULARITY_STORAGE_KEY, g);
  } catch {
  }
}

function loadPersistedFilter(): HistoryFilterState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HistoryFilterState>;
    const selectedAccountIds = Array.isArray(parsed.selectedAccountIds)
      ? parsed.selectedAccountIds.filter((id): id is string => typeof id === 'string')
      : [];
    const fromMs = typeof parsed.fromMs === 'number' ? parsed.fromMs : null;
    const toMs = typeof parsed.toMs === 'number' ? parsed.toMs : null;
    return { selectedAccountIds, fromMs, toMs };
  } catch {
    return null;
  }
}

function savePersistedFilter(filter: HistoryFilterState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filter));
  } catch {
  }
}

interface HistoryContextValue {
  filter: HistoryFilterState;
  setSelectedAccountIds: (ids: string[]) => void;
  setRange: (fromMs: number | null, toMs: number | null) => void;
  resetFilter: () => void;
  ensureRangeCovered: (fromMs: number, toMs: number) => void;
  granularity: Granularity;
  setGranularity: (g: Granularity) => void;
  accounts: HistoryAccount[];
  deals: HistoryDeal[];
  allDeals: HistoryDeal[];
  syncStatus: HistorySyncStatus[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
  serverNowMs: number;
}

const Ctx = createContext<HistoryContextValue | undefined>(undefined);

function defaultFilter(): HistoryFilterState {
  const now = Date.now();
  return {
    selectedAccountIds: [],
    fromMs: now - FILTER_DEFAULT_DAYS * 86_400_000,
    toMs: now,
  };
}

function dealTime(d: HistoryDeal): number {
  return d.close_time_ms > 0 ? d.close_time_ms : d.open_time_ms;
}

function startOfUtcDay(ms: number): number {
  if (ms <= 0) return 0;
  return Math.floor(ms / 86_400_000) * 86_400_000;
}

interface FetchPlan {
  shouldFetch: boolean;
  fromMs: number;
  toMs: number;
  sinceMs?: number;
  todayOnly: boolean;
}

function planFetch(
  requestedFrom: number,
  requestedTo: number,
  syncEntries: HistorySyncStatus[],
  force: boolean
): FetchPlan {
  if (force) {
    return {
      shouldFetch: true,
      fromMs: requestedFrom,
      toMs: requestedTo,
      todayOnly: false,
    };
  }
  const todayFrom = startOfUtcDay(Date.now()) - TODAY_OVERLAP_MS;
  const requestIncludesToday = requestedTo >= todayFrom;
  const now = Date.now();

  let allHistoricalCovered = true;
  let minLastSynced = Infinity;
  for (const s of syncEntries) {
    const ranges = s.covered_ranges ?? [];
    if (!isRangeFullyCovered(ranges, requestedFrom, requestedTo)) {
      allHistoricalCovered = false;
    }
    if (s.last_synced_ms > 0 && s.last_synced_ms < minLastSynced) {
      minLastSynced = s.last_synced_ms;
    }
  }
  if (syncEntries.length === 0) allHistoricalCovered = false;
  const todayFresh =
    !requestIncludesToday ||
    (Number.isFinite(minLastSynced) && now - minLastSynced <= TODAY_FRESHNESS_TOLERANCE_MS);

  if (allHistoricalCovered && todayFresh) {
    return { shouldFetch: false, fromMs: requestedFrom, toMs: requestedTo, todayOnly: false };
  }

  if (allHistoricalCovered && !todayFresh) {
    const fromMs = Number.isFinite(minLastSynced)
      ? Math.max(todayFrom, minLastSynced - 60_000)
      : todayFrom;
    const sinceMs = Number.isFinite(minLastSynced)
      ? Math.max(todayFrom, minLastSynced)
      : todayFrom;
    return { shouldFetch: true, fromMs, toMs: now, sinceMs, todayOnly: true };
  }

  return { shouldFetch: true, fromMs: requestedFrom, toMs: requestedTo, todayOnly: false };
}

function dealsEqual(a: HistoryDeal, b: HistoryDeal): boolean {
  return (
    a.deal_id === b.deal_id &&
    a.close_time_ms === b.close_time_ms &&
    a.open_time_ms === b.open_time_ms &&
    a.profit === b.profit &&
    a.swap === b.swap &&
    a.commission === b.commission &&
    a.net_profit === b.net_profit &&
    a.volume === b.volume &&
    a.symbol === b.symbol &&
    a.side === b.side &&
    a.open_price === b.open_price &&
    a.close_price === b.close_price
  );
}

clearLegacyHistoryStorage();

export function HistoryProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [filter, setFilter] = useState<HistoryFilterState>(() => loadPersistedFilter() ?? defaultFilter());
  const [granularity, setGranularityState] = useState<Granularity>(() => loadPersistedGranularity());

  useEffect(() => {
    savePersistedFilter(filter);
  }, [filter]);

  useEffect(() => {
    if (location.pathname !== '/history') return;
    const params = new URLSearchParams(location.search);
    const accountParam = params.get('account');
    if (!accountParam) return;
    setFilter((f) => {
      if (f.selectedAccountIds.length === 1 && f.selectedAccountIds[0] === accountParam) return f;
      return { ...f, selectedAccountIds: [accountParam] };
    });
  }, [location.key, location.pathname, location.search]);

  const setGranularity = useCallback((g: Granularity) => {
    setGranularityState(g);
    savePersistedGranularity(g);
  }, []);

  const [accounts, setAccounts] = useState<HistoryAccount[]>([]);
  const [dealsByAccount, setDealsByAccount] = useState<Map<string, HistoryDeal[]>>(() => new Map());
  const [syncByAccount, setSyncByAccount] = useState<Map<string, HistorySyncStatus>>(() => new Map());
  const [loadedRangesByAccount, setLoadedRangesByAccount] = useState<Map<string, CoveredRange[]>>(() => new Map());
  const [serverNowMs, setServerNowMs] = useState<number>(() => Date.now());
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inFlightKeysRef = useRef<Set<string>>(new Set());
  const pendingEnsureRef = useRef<{ fromMs: number; toMs: number } | null>(null);

  const targetIds = useMemo(() => {
    const eligibleIds = new Set(accounts.filter((a) => a.eligible).map((a) => a.account_id));
    if (filter.selectedAccountIds.length === 0) return Array.from(eligibleIds);
    return filter.selectedAccountIds.filter((id) => eligibleIds.has(id));
  }, [accounts, filter.selectedAccountIds]);

  useEffect(() => {
    const eligible = new Set(accounts.filter((a) => a.eligible).map((a) => a.account_id));
    setDealsByAccount((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!eligible.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setSyncByAccount((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!eligible.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setLoadedRangesByAccount((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of next.keys()) {
        if (!eligible.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [accounts]);

  const allDeals = useMemo(() => {
    const out: HistoryDeal[] = [];
    for (const id of targetIds) {
      const arr = dealsByAccount.get(id);
      if (!arr) continue;
      for (const d of arr) {
        if (d.close_time_ms > 0) out.push(d);
      }
    }
    return out;
  }, [dealsByAccount, targetIds]);

  const syncStatus = useMemo(() => {
    return targetIds.map<HistorySyncStatus>((id) => {
      const s = syncByAccount.get(id);
      return (
        s ?? {
          account_id: id,
          last_synced_ms: 0,
          oldest_synced_ms: 0,
          deals_count: 0,
          covered_ranges: [],
        }
      );
    });
  }, [syncByAccount, targetIds]);

  const deals = useMemo(() => {
    const fromMs = filter.fromMs ?? Date.now() - FILTER_DEFAULT_DAYS * 86_400_000;
    const toMs = filter.toMs ?? Date.now();
    const out: HistoryDeal[] = [];
    for (const d of allDeals) {
      const t = dealTime(d);
      if (t >= fromMs && t <= toMs) out.push(d);
    }
    return out;
  }, [allDeals, filter.fromMs, filter.toMs]);

  const fetchRange = useCallback(
    async (
      requestedFrom: number,
      requestedTo: number,
      options: { force?: boolean } = {}
    ): Promise<void> => {
      if (targetIds.length === 0) {
        setIsLoading(false);
        setIsRefreshing(false);
        return;
      }

      const cachedSync = targetIds.map<HistorySyncStatus>((id) => {
        const s = syncByAccount.get(id);
        const loaded = loadedRangesByAccount.get(id) ?? [];
        return {
          account_id: id,
          last_synced_ms: s?.last_synced_ms ?? 0,
          oldest_synced_ms: s?.oldest_synced_ms ?? 0,
          deals_count: s?.deals_count ?? 0,
          covered_ranges: loaded,
        };
      });
      const force = options.force === true;
      const plan = planFetch(requestedFrom, requestedTo, cachedSync, force);
      if (!plan.shouldFetch) {
        setIsLoading(false);
        return;
      }

      const targetsKey = [...targetIds].sort().join(',');
      const key = `${force ? 'F' : 'N'}|${plan.fromMs}|${plan.toMs}|${plan.sinceMs ?? ''}|${targetsKey}`;
      if (inFlightKeysRef.current.has(key)) return;
      inFlightKeysRef.current.add(key);

      setError(null);
      setIsRefreshing(true);

      try {
        const data = await getHistoryDeals({
          fromMs: plan.fromMs,
          toMs: plan.toMs,
          accountIds: targetIds,
          sinceMs: plan.sinceMs,
          forceRefresh: force,
        });

        const byAccount = new Map<string, HistoryDeal[]>();
        for (const d of data.deals) {
          const arr = byAccount.get(d.account_id);
          if (arr) arr.push(d);
          else byAccount.set(d.account_id, [d]);
        }

        setDealsByAccount((prev) => {
          const next = new Map(prev);
          for (const id of targetIds) {
            const incoming = byAccount.get(id) ?? [];
            if (incoming.length === 0 && plan.todayOnly) continue;
            const existing = next.get(id) ?? [];
            const map = new Map<string, HistoryDeal>();
            for (const d of existing) map.set(d.deal_id, d);
            let changed = false;
            for (const d of incoming) {
              const prevDeal = map.get(d.deal_id);
              if (!prevDeal || !dealsEqual(prevDeal, d)) {
                changed = true;
                map.set(d.deal_id, d);
              }
            }
            if (changed || existing.length === 0) {
              const merged = Array.from(map.values()).sort((a, b) => dealTime(a) - dealTime(b));
              next.set(id, merged);
            }
          }
          return next;
        });

        setSyncByAccount((prev) => {
          const next = new Map(prev);
          for (const s of data.sync_status) {
            next.set(s.account_id, s);
          }
          return next;
        });
        const loadedSlice: CoveredRange = {
          from_ms: plan.todayOnly ? plan.fromMs : requestedFrom,
          to_ms: plan.todayOnly ? plan.toMs : requestedTo,
        };
        setLoadedRangesByAccount((prev) => {
          const next = new Map(prev);
          for (const id of targetIds) {
            const existing = next.get(id) ?? [];
            next.set(id, mergeCoveredRange(existing, loadedSlice));
          }
          return next;
        });
        setServerNowMs(data.server_now_ms);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'history fetch failed');
      } finally {
        inFlightKeysRef.current.delete(key);
        setIsLoading(false);
        if (inFlightKeysRef.current.size === 0) {
          setIsRefreshing(false);
        }
      }
    },
    [targetIds, syncByAccount, loadedRangesByAccount]
  );

  const fetchRangeRef = useRef(fetchRange);
  useEffect(() => {
    fetchRangeRef.current = fetchRange;
  });

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      const fromMs = filter.fromMs ?? Date.now() - FILTER_DEFAULT_DAYS * 86_400_000;
      const toMs = filter.toMs ?? Date.now();
      await fetchRangeRef.current(fromMs, toMs, options);
    },
    [filter.fromMs, filter.toMs]
  );

  const eligibleAbortRef = useRef(false);
  useEffect(() => {
    eligibleAbortRef.current = false;
    let timer: number | null = null;

    const fetchOnce = async () => {
      try {
        const list = await getHistoryEligibleAccounts();
        if (!eligibleAbortRef.current) setAccounts(list);
      } catch {
      }
    };

    void fetchOnce();
    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void fetchOnce();
    }, ACCOUNTS_REFETCH_INTERVAL_MS);

    return () => {
      eligibleAbortRef.current = true;
      if (timer != null) window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (targetIds.length === 0) return;
    const fromMs = filter.fromMs ?? Date.now() - FILTER_DEFAULT_DAYS * 86_400_000;
    const toMs = filter.toMs ?? Date.now();
    void fetchRangeRef.current(fromMs, toMs);
    const pending = pendingEnsureRef.current;
    if (pending && (pending.fromMs < fromMs || pending.toMs > toMs)) {
      void fetchRangeRef.current(pending.fromMs, pending.toMs);
    }
  }, [targetIds, filter.fromMs, filter.toMs]);

  const setSelectedAccountIds = useCallback(
    (ids: string[]) => setFilter((f) => ({ ...f, selectedAccountIds: ids })),
    []
  );
  const setRange = useCallback(
    (fromMs: number | null, toMs: number | null) =>
      setFilter((f) => ({ ...f, fromMs, toMs })),
    []
  );
  const resetFilter = useCallback(() => setFilter(defaultFilter()), []);

  const ensureRangeCovered = useCallback((fromMs: number, toMs: number) => {
    if (toMs <= fromMs) return;
    pendingEnsureRef.current = { fromMs, toMs };
    void fetchRangeRef.current(fromMs, toMs);
  }, []);

  const value = useMemo<HistoryContextValue>(
    () => ({
      filter,
      setSelectedAccountIds,
      setRange,
      resetFilter,
      ensureRangeCovered,
      granularity,
      setGranularity,
      accounts,
      deals,
      allDeals,
      syncStatus,
      isLoading,
      isRefreshing,
      error,
      refresh,
      serverNowMs,
    }),
    [
      filter,
      setSelectedAccountIds,
      setRange,
      resetFilter,
      ensureRangeCovered,
      granularity,
      setGranularity,
      accounts,
      deals,
      allDeals,
      syncStatus,
      isLoading,
      isRefreshing,
      error,
      refresh,
      serverNowMs,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useHistory(): HistoryContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useHistory must be used inside HistoryProvider');
  return v;
}
