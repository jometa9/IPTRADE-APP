'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { HistoryProvider } from '@/context/HistoryContext';
import { Watermark } from '@/components/Watermark';
import { NoAccountsEmpty } from '@/components/NoAccountsEmpty';
import type { TradingAccount } from '@/lib/trading/types';
import { HistoryFilterHeader } from './HistoryFilterHeader';
import type { HistoryView } from './HistoryNav';
import { CalendarView } from './CalendarView';
import {
  OrdersView,
  loadOrdersPreferences,
  saveOrdersPreferences,
  type OrdersPreferences,
} from './OrdersView';
import { StatisticsView } from './StatisticsView';
import { AnalyzeView } from './AnalyzeView';
import {
  loadStatsPreferences,
  saveStatsPreferences,
  type StatsPreferences,
} from './statisticsPrefs';
import { StatisticsCustomizer } from './StatisticsCustomizer';
import { OrdersCustomizer } from './OrdersCustomizer';
import {
  loadCalendarPreferences,
  saveCalendarPreferences,
  type CalendarPreferences,
} from './calendarPrefs';
import { CalendarCustomizer } from './CalendarCustomizer';

interface HistoryScreenProps {
  accounts: TradingAccount[];
  onOpenAddScreen: () => void;
}

const VIEW_STORAGE_KEY = 'iptrade.history.view.v1';

function isHistoryView(v: unknown): v is HistoryView {
  return v === 'calendar' || v === 'orders' || v === 'statistics' || v === 'analyze';
}

function loadPersistedView(): HistoryView {
  if (typeof window === 'undefined') return 'calendar';
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return isHistoryView(raw) ? raw : 'calendar';
  } catch {
    return 'calendar';
  }
}

function savePersistedView(view: HistoryView): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
  }
}

export function HistoryScreen({ accounts, onOpenAddScreen }: HistoryScreenProps) {
  if (accounts.length === 0) {
    return <NoAccountsEmpty onAddAccounts={onOpenAddScreen} />;
  }
  return <HistoryScreenInner />;
}

function HistoryScreenInner() {
  const location = useLocation();
  const navigate = useNavigate();

  const urlView = useMemo(() => {
    const raw = new URLSearchParams(location.search).get('view');
    return isHistoryView(raw) ? raw : null;
  }, [location.search]);

  const persistedFallbackRef = useRef<HistoryView | null>(null);
  if (persistedFallbackRef.current === null) {
    persistedFallbackRef.current = loadPersistedView();
  }
  const view: HistoryView = urlView ?? persistedFallbackRef.current;

  useEffect(() => {
    savePersistedView(view);
  }, [view]);

  const setView = useCallback(
    (next: HistoryView) => {
      const params = new URLSearchParams(location.search);
      params.set('view', next);
      navigate({ pathname: '/history', search: `?${params.toString()}` }, { replace: true });
    },
    [location.search, navigate]
  );

  const [ordersPrefs, setOrdersPrefs] = useState<OrdersPreferences>(loadOrdersPreferences);
  useEffect(() => { saveOrdersPreferences(ordersPrefs); }, [ordersPrefs]);

  const [statsPrefs, setStatsPrefs] = useState<StatsPreferences>(loadStatsPreferences);
  useEffect(() => {
    saveStatsPreferences(statsPrefs);
  }, [statsPrefs]);
  const [statsCustomizerOpen, setStatsCustomizerOpen] = useState(false);

  const [calendarPrefs, setCalendarPrefs] = useState<CalendarPreferences>(loadCalendarPreferences);
  useEffect(() => {
    saveCalendarPreferences(calendarPrefs);
  }, [calendarPrefs]);
  const [calendarCustomizerOpen, setCalendarCustomizerOpen] = useState(false);

  const [ordersCustomizerOpen, setOrdersCustomizerOpen] = useState(false);

  const onCustomize =
    view === 'statistics'
      ? () => setStatsCustomizerOpen(true)
      : view === 'calendar'
        ? () => setCalendarCustomizerOpen(true)
        : view === 'orders'
          ? () => setOrdersCustomizerOpen(true)
          : undefined;
  const customizeLabel =
    view === 'statistics'
      ? 'Customize statistics'
      : view === 'calendar'
        ? 'Customize calendar'
        : view === 'orders'
          ? 'Customize columns'
          : undefined;

  return (
    <HistoryProvider>
      <div className="flex h-full min-h-0 flex-col">
        <HistoryFilterHeader
          view={view}
          onSelectView={setView}
          onCustomize={onCustomize}
          customizeLabel={customizeLabel}
        />
        <div className="relative flex-1 min-h-0 overflow-hidden">
          <Watermark />
          <div className="relative z-10 h-full">
            {view === 'calendar' && <CalendarView onNavigate={setView} prefs={calendarPrefs} />}
            {view === 'orders' && <OrdersView prefs={ordersPrefs} onPrefsChange={setOrdersPrefs} />}
            {view === 'statistics' && <StatisticsView prefs={statsPrefs} />}
            {view === 'analyze' && <AnalyzeView />}
          </div>
        </div>
      </div>
      <StatisticsCustomizer
        open={statsCustomizerOpen}
        prefs={statsPrefs}
        onChange={setStatsPrefs}
        onClose={() => setStatsCustomizerOpen(false)}
      />
      <CalendarCustomizer
        open={calendarCustomizerOpen}
        prefs={calendarPrefs}
        onChange={setCalendarPrefs}
        onClose={() => setCalendarCustomizerOpen(false)}
      />
      <OrdersCustomizer
        open={ordersCustomizerOpen}
        prefs={ordersPrefs}
        onChange={setOrdersPrefs}
        onClose={() => setOrdersCustomizerOpen(false)}
      />
    </HistoryProvider>
  );
}
