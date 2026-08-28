'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Grid3x3,
  Loader,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import { buildHistoryCsv, defaultExportFilename, downloadCsv } from '@/lib/csvExport';
import { useHistory } from '@/context/HistoryContext';
import { cn } from '@/lib/utils';
import { AccountsPicker } from '@/components/AccountsPicker';
import {
  WEEK_DAY_LABELS,
  buildDealsByDay,
  buildDealsByMonth,
  dateKey,
  deriveCalendarState,
  deriveQuarterState,
  deriveYearState,
  endOfDay,
  endOfMonth,
  endOfQuarter,
  endOfYear,
  formatCompactNumber,
  quarterIndex,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeekSunday,
  startOfYear,
  type Granularity,
} from './calendarMath';
import type { HistoryView } from './HistoryNav';

function pnlTextClass(value: number): string {
  if (Math.abs(value) < 0.005) return 'text-gray-900';
  return value > 0 ? 'text-green-600' : 'text-red-600';
}

function formatMonthDay(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatRangeDate(ms: number | null, placeholder: string): string {
  if (ms == null) return placeholder;
  const d = new Date(ms);
  return `${formatMonthDay(d)} ${d.getFullYear()}`;
}

function formatCompactRange(fromMs: number | null, toMs: number | null): string {
  if (fromMs == null && toMs == null) return 'Date range';
  if (fromMs == null) return `… - ${formatRangeDate(toMs, '')}`;
  if (toMs == null) return `${formatRangeDate(fromMs, '')} - …`;
  const f = new Date(fromMs);
  const t = new Date(toMs);
  if (f.getFullYear() === t.getFullYear()) {
    return `${formatMonthDay(f)} - ${formatMonthDay(t)} ${f.getFullYear()}`;
  }
  return `${formatRangeDate(fromMs, '')} - ${formatRangeDate(toMs, '')}`;
}

interface DateRangePickerProps {
  fromMs: number | null;
  toMs: number | null;
  onChange: (fromMs: number | null, toMs: number | null) => void;
}

function DateRangePicker({ fromMs, toMs, onChange }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<'days' | 'months' | 'years'>('days');
  const ref = useRef<HTMLDivElement | null>(null);

  const [viewMonth, setViewMonth] = useState<Date>(() =>
    startOfMonth(fromMs != null ? new Date(fromMs) : new Date())
  );
  const [yearGridStart, setYearGridStart] = useState<number>(
    () => Math.floor(new Date().getFullYear() / 12) * 12
  );
  const [draftStart, setDraftStart] = useState<number | null>(null);
  const [draftEnd, setDraftEnd] = useState<number | null>(null);
  const [hoverDate, setHoverDate] = useState<number | null>(null);
  const [hoverMonthMs, setHoverMonthMs] = useState<number | null>(null);
  const [hoverYearMs, setHoverYearMs] = useState<number | null>(null);

  const selectingEnd = draftStart != null && draftEnd == null;

  useEffect(() => {
    if (!open) return;
    const fStart = fromMs != null ? startOfDay(new Date(fromMs)).getTime() : null;
    const tStart = toMs != null ? startOfDay(new Date(toMs)).getTime() : null;
    setDraftStart(fStart);
    setDraftEnd(tStart);
    setHoverDate(null);
    setHoverMonthMs(null);
    setHoverYearMs(null);
    setPickerMode('days');
    const initial = startOfMonth(fromMs != null ? new Date(fromMs) : new Date());
    setViewMonth(initial);
    setYearGridStart(Math.floor(initial.getFullYear() / 12) * 12);
  }, [open, fromMs, toMs]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: 'long' });
  const yearLabel = viewMonth.getFullYear();
  const todayStart = startOfDay(new Date()).getTime();

  const days = useMemo(() => {
    const firstDay = startOfMonth(viewMonth);
    const gridStart = startOfWeekSunday(firstDay);
    const list: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      list.push({ date: d, inMonth: d.getMonth() === viewMonth.getMonth() });
    }
    return list;
  }, [viewMonth]);

  const goPrevYear = () =>
    setViewMonth(new Date(viewMonth.getFullYear() - 1, viewMonth.getMonth(), 1));
  const goNextYear = () =>
    setViewMonth(new Date(viewMonth.getFullYear() + 1, viewMonth.getMonth(), 1));
  const goPrevMonth = () =>
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1));
  const goNextMonth = () =>
    setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1));

  const nextYearStart = new Date(viewMonth.getFullYear() + 1, viewMonth.getMonth(), 1).getTime();
  const nextMonthStart = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1).getTime();
  const disableNextYear = nextYearStart > todayStart;
  const disableNextMonth = nextMonthStart > todayStart;

  const handleDayClick = (dayStartMs: number) => {
    if (selectingEnd) {
      let s = draftStart!;
      let e = dayStartMs;
      if (e < s) [s, e] = [e, s];
      setDraftStart(s);
      setDraftEnd(e);
      onChange(s, endOfDay(new Date(e)).getTime());
    } else {
      setDraftStart(dayStartMs);
      setDraftEnd(null);
      onChange(dayStartMs, null);
    }
  };

  const handleMonthClick = (year: number, monthIdx: number) => {
    const monthStart = startOfMonth(new Date(year, monthIdx, 1)).getTime();
    const monthEnd = endOfMonth(new Date(year, monthIdx, 1)).getTime();
    if (selectingEnd) {
      const lo = Math.min(draftStart!, monthStart);
      const hi = Math.max(draftStart!, monthStart);
      const hiMonthEnd = endOfMonth(new Date(hi)).getTime();
      setDraftStart(lo);
      setDraftEnd(hi);
      setHoverMonthMs(null);
      onChange(lo, hiMonthEnd);
      setPickerMode('days');
      setViewMonth(startOfMonth(new Date(lo)));
    } else {
      setDraftStart(monthStart);
      setDraftEnd(null);
      setHoverMonthMs(null);
      onChange(monthStart, monthEnd);
    }
  };

  const handleYearClick = (year: number) => {
    const yearStart = startOfYear(new Date(year, 0, 1)).getTime();
    const yearEnd = endOfYear(new Date(year, 0, 1)).getTime();
    if (selectingEnd) {
      const lo = Math.min(draftStart!, yearStart);
      const hi = Math.max(draftStart!, yearStart);
      const hiYearEnd = endOfYear(new Date(hi)).getTime();
      setDraftStart(lo);
      setDraftEnd(hi);
      setHoverYearMs(null);
      onChange(lo, hiYearEnd);
      setPickerMode('months');
      setViewMonth(startOfMonth(new Date(lo)));
    } else {
      setDraftStart(yearStart);
      setDraftEnd(null);
      setHoverYearMs(null);
      onChange(yearStart, yearEnd);
    }
  };

  const draftStartYearMs =
    draftStart != null ? startOfYear(new Date(draftStart)).getTime() : null;
  const draftEndYearMs = draftEnd != null ? startOfYear(new Date(draftEnd)).getTime() : null;
  const previewEndYearMs =
    selectingEnd && hoverYearMs != null ? hoverYearMs : draftEndYearMs;
  const yearRangeLo =
    draftStartYearMs != null && previewEndYearMs != null
      ? Math.min(draftStartYearMs, previewEndYearMs)
      : draftStartYearMs;
  const yearRangeHi =
    draftStartYearMs != null && previewEndYearMs != null
      ? Math.max(draftStartYearMs, previewEndYearMs)
      : draftEndYearMs;
  const todayYearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  const yearGridYears = useMemo(
    () => Array.from({ length: 12 }, (_, i) => yearGridStart + i),
    [yearGridStart]
  );
  const goPrevYearGrid = () => setYearGridStart((s) => s - 12);
  const goNextYearGrid = () => setYearGridStart((s) => s + 12);
  const disableNextYearGrid = yearGridStart + 12 > new Date().getFullYear();

  const monthShortNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)));
  }, []);

  const previewEnd = selectingEnd && hoverDate != null ? hoverDate : draftEnd;
  const rangeLo =
    draftStart != null && previewEnd != null ? Math.min(draftStart, previewEnd) : draftStart;
  const rangeHi =
    draftStart != null && previewEnd != null ? Math.max(draftStart, previewEnd) : draftEnd;

  const draftStartMonthMs =
    draftStart != null ? startOfMonth(new Date(draftStart)).getTime() : null;
  const draftEndMonthMs = draftEnd != null ? startOfMonth(new Date(draftEnd)).getTime() : null;
  const previewEndMonthMs =
    selectingEnd && hoverMonthMs != null ? hoverMonthMs : draftEndMonthMs;
  const monthRangeLo =
    draftStartMonthMs != null && previewEndMonthMs != null
      ? Math.min(draftStartMonthMs, previewEndMonthMs)
      : draftStartMonthMs;
  const monthRangeHi =
    draftStartMonthMs != null && previewEndMonthMs != null
      ? Math.max(draftStartMonthMs, previewEndMonthMs)
      : draftEndMonthMs;

  const compactLabel = formatCompactRange(fromMs, toMs);
  const hasSelection = fromMs != null || toMs != null;
  const toggleOpen = () => setOpen((v) => !v);

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        onClick={toggleOpen}
        aria-label="Open date range picker"
        className={cn(
          'flex h-9 items-center gap-2 whitespace-nowrap border-r border-gray-200 px-3 text-sm tabular-nums hover:bg-gray-100 hover:text-gray-900',
          hasSelection ? 'text-gray-600' : 'text-gray-400'
        )}
      >
        <span>{compactLabel}</span>
        <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center border-b border-gray-200">
            <button
              type="button"
              onClick={pickerMode === 'years' ? goPrevYearGrid : goPrevYear}
              className="flex h-9 w-9 items-center justify-center border-r border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
              aria-label={pickerMode === 'years' ? 'Previous years' : 'Previous year'}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {pickerMode === 'years' ? (
              <span className="flex-1 text-center text-sm tabular-nums text-gray-600">
                {yearGridStart} – {yearGridStart + 11}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setHoverYearMs(null);
                  setYearGridStart(Math.floor(viewMonth.getFullYear() / 12) * 12);
                  setPickerMode('years');
                }}
                aria-label="Pick year"
                className="flex-1 h-9 text-center text-sm tabular-nums text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              >
                {yearLabel}
              </button>
            )}
            <button
              type="button"
              onClick={pickerMode === 'years' ? goNextYearGrid : goNextYear}
              disabled={pickerMode === 'years' ? disableNextYearGrid : disableNextYear}
              className="flex h-9 w-9 items-center justify-center border-l border-gray-200 text-gray-500 enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed"
              aria-label={pickerMode === 'years' ? 'Next years' : 'Next year'}
            >
              <ChevronRight
                className={cn(
                  'h-4 w-4',
                  (pickerMode === 'years' ? disableNextYearGrid : disableNextYear) && 'opacity-30'
                )}
              />
            </button>
          </div>
          {pickerMode === 'days' && (
            <div className="flex items-center border-b border-gray-200">
              <button
                type="button"
                onClick={goPrevMonth}
                className="flex h-9 w-9 items-center justify-center border-r border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                aria-label="Previous month"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setHoverMonthMs(null);
                  setPickerMode('months');
                }}
                aria-label="Pick month"
                className="flex-1 h-9 text-center text-sm capitalize text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              >
                {monthLabel}
              </button>
              <button
                type="button"
                onClick={goNextMonth}
                disabled={disableNextMonth}
                className="flex h-9 w-9 items-center justify-center border-l border-gray-200 text-gray-500 enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed"
                aria-label="Next month"
              >
                <ChevronRight className={cn('h-4 w-4', disableNextMonth && 'opacity-30')} />
              </button>
            </div>
          )}
          {pickerMode === 'days' && (
            <div className="grid grid-cols-7 border-b border-gray-200">
              {WEEK_DAY_LABELS.map((label) => (
                <span
                  key={label}
                  className="flex h-7 items-center justify-center border-r border-gray-200 text-xs text-gray-400 [&:nth-child(7n)]:border-r-0"
                >
                  {label.slice(0, 2)}
                </span>
              ))}
            </div>
          )}
          {pickerMode === 'days' && (
            <div
              className="grid grid-cols-7"
              onMouseLeave={() => setHoverDate(null)}
            >
              {days.map(({ date, inMonth }) => {
                const k = dateKey(date);
                const dayStart = startOfDay(date).getTime();
                const isFuture = dayStart > todayStart;
                const isStart = rangeLo != null && dayStart === rangeLo;
                const isEnd = rangeHi != null && dayStart === rangeHi;
                const isInRange =
                  rangeLo != null && rangeHi != null && dayStart > rangeLo && dayStart < rangeHi;
                const isEdge = isStart || isEnd;
                return (
                  <button
                    key={k}
                    type="button"
                    disabled={isFuture}
                    onClick={() => handleDayClick(dayStart)}
                    onMouseEnter={() => setHoverDate(dayStart)}
                    className={cn(
                      'flex h-9 cursor-pointer items-center justify-center border-b border-r border-gray-200 text-sm tabular-nums enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed [&:nth-child(7n)]:border-r-0 [&:nth-last-child(-n+7)]:border-b-0',
                      inMonth ? 'text-gray-600' : 'text-gray-300',
                      isFuture && 'text-gray-300',
                      isInRange && 'bg-gray-100 text-gray-900',
                      isEdge &&
                        'bg-gray-900 text-white enabled:hover:bg-gray-900 enabled:hover:text-white'
                    )}
                  >
                    {date.getDate()}
                  </button>
                );
              })}
            </div>
          )}
          {pickerMode === 'months' && (
            <div
              className="grid grid-cols-3"
              onMouseLeave={() => setHoverMonthMs(null)}
            >
              {monthShortNames.map((label, idx) => {
                const monthStart = new Date(viewMonth.getFullYear(), idx, 1);
                const monthStartMs = monthStart.getTime();
                const isFuture = monthStartMs > todayStart;
                const isStart = monthRangeLo != null && monthStartMs === monthRangeLo;
                const isEnd = monthRangeHi != null && monthStartMs === monthRangeHi;
                const isInRange =
                  monthRangeLo != null &&
                  monthRangeHi != null &&
                  monthStartMs > monthRangeLo &&
                  monthStartMs < monthRangeHi;
                const isEdge = isStart || isEnd;
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={isFuture}
                    onClick={() => handleMonthClick(viewMonth.getFullYear(), idx)}
                    onMouseEnter={() => setHoverMonthMs(monthStartMs)}
                    className={cn(
                      'flex h-12 cursor-pointer items-center justify-center border-b border-r border-gray-200 text-sm capitalize text-gray-600 enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300 [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0',
                      isInRange && 'bg-gray-100 text-gray-900',
                      isEdge &&
                        'bg-gray-900 text-white enabled:hover:bg-gray-900 enabled:hover:text-white'
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {pickerMode === 'years' && (
            <div
              className="grid grid-cols-3"
              onMouseLeave={() => setHoverYearMs(null)}
            >
              {yearGridYears.map((yr) => {
                const yrStart = new Date(yr, 0, 1).getTime();
                const isFuture = yrStart > todayYearStart;
                const isStart = yearRangeLo != null && yrStart === yearRangeLo;
                const isEnd = yearRangeHi != null && yrStart === yearRangeHi;
                const isInRange =
                  yearRangeLo != null &&
                  yearRangeHi != null &&
                  yrStart > yearRangeLo &&
                  yrStart < yearRangeHi;
                const isEdge = isStart || isEnd;
                return (
                  <button
                    key={yr}
                    type="button"
                    disabled={isFuture}
                    onClick={() => handleYearClick(yr)}
                    onMouseEnter={() => setHoverYearMs(yrStart)}
                    className={cn(
                      'flex h-12 cursor-pointer items-center justify-center border-b border-r border-gray-200 text-sm tabular-nums text-gray-600 enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300 [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0',
                      isInRange && 'bg-gray-100 text-gray-900',
                      isEdge &&
                        'bg-gray-900 text-white enabled:hover:bg-gray-900 enabled:hover:text-white'
                    )}
                  >
                    {yr}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface HistoryFilterHeaderProps {
  view: HistoryView;
  onSelectView: (view: HistoryView) => void;
  onCustomize?: () => void;
  customizeLabel?: string;
}

export function HistoryFilterHeader({
  view,
  onSelectView,
  onCustomize,
  customizeLabel,
}: HistoryFilterHeaderProps) {
  const {
    filter,
    setSelectedAccountIds,
    setRange,
    granularity,
    setGranularity,
    accounts,
    refresh,
    isLoading,
    isRefreshing,
    allDeals,
    deals,
  } = useHistory();
  const busy = isLoading || isRefreshing;
  const [periodPickerOpen, setPeriodPickerOpen] = useState(false);
  const periodPickerRef = useRef<HTMLDivElement | null>(null);
  const [pickerYear, setPickerYear] = useState<number>(() => new Date().getFullYear());

  const monthShortLabels = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)));
  }, []);
  const todayYear = new Date().getFullYear();
  const todayMonth = new Date().getMonth();
  const todayQuarter = quarterIndex(new Date());

  const isCalendar = view === 'calendar';

  const dealsByDay = useMemo(() => (isCalendar ? buildDealsByDay(allDeals) : null), [isCalendar, allDeals]);
  const dealsByMonth = useMemo(
    () => (isCalendar && granularity === 'year' ? buildDealsByMonth(allDeals) : null),
    [isCalendar, granularity, allDeals]
  );

  const monthState = useMemo(() => {
    if (!isCalendar || granularity !== 'month' || !dealsByDay) return null;
    return deriveCalendarState(filter, new Date(), dealsByDay);
  }, [isCalendar, granularity, filter, dealsByDay]);

  const quarterState = useMemo(() => {
    if (!isCalendar || granularity !== 'quarter' || !dealsByDay) return null;
    return deriveQuarterState(filter, new Date(), dealsByDay);
  }, [isCalendar, granularity, filter, dealsByDay]);

  const yearState = useMemo(() => {
    if (!isCalendar || granularity !== 'year' || !dealsByDay || !dealsByMonth) return null;
    return deriveYearState(filter, new Date(), dealsByDay, dealsByMonth);
  }, [isCalendar, granularity, filter, dealsByDay, dealsByMonth]);

  const periodAnchor = useMemo(() => {
    const today = new Date();
    const todayStart = startOfDay(today).getTime();
    const anchorDay =
      filter.toMs == null
        ? startOfDay(today)
        : startOfDay(new Date(filter.toMs)).getTime() > todayStart
          ? startOfDay(today)
          : startOfDay(new Date(filter.toMs));
    if (granularity === 'month') {
      const date = startOfMonth(anchorDay);
      const monthShort = date.toLocaleDateString(undefined, { month: 'short' });
      return {
        kind: 'month' as const,
        date,
        isCurrent:
          date.getFullYear() === today.getFullYear() &&
          date.getMonth() === today.getMonth(),
        label: `${monthShort} ${date.getFullYear()}`,
      };
    }
    if (granularity === 'quarter') {
      const date = startOfQuarter(anchorDay);
      const qIdx = quarterIndex(date);
      return {
        kind: 'quarter' as const,
        date,
        isCurrent:
          date.getFullYear() === today.getFullYear() &&
          qIdx === quarterIndex(today),
        label: `Q${qIdx + 1} ${date.getFullYear()}`,
      };
    }
    const date = startOfYear(anchorDay);
    return {
      kind: 'year' as const,
      date,
      isCurrent: date.getFullYear() === today.getFullYear(),
      label: String(date.getFullYear()),
    };
  }, [filter.toMs, granularity]);

  const periodLabel = periodAnchor.label;

  const periodStats =
    monthState?.stats ?? quarterState?.stats ?? yearState?.stats ?? null;

  const totalLabel =
    granularity === 'year'
      ? 'Year total'
      : granularity === 'quarter'
        ? 'Quarter total'
        : 'Month total';

  const goPrev = () => {
    const d = periodAnchor.date;
    if (periodAnchor.kind === 'month') {
      const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      setRange(startOfMonth(prev).getTime(), endOfMonth(prev).getTime());
    } else if (periodAnchor.kind === 'quarter') {
      const prev = new Date(d.getFullYear(), d.getMonth() - 3, 1);
      setRange(startOfQuarter(prev).getTime(), endOfQuarter(prev).getTime());
    } else {
      const prev = new Date(d.getFullYear() - 1, 0, 1);
      setRange(startOfYear(prev).getTime(), endOfYear(prev).getTime());
    }
  };

  const isAtLatest = periodAnchor.isCurrent;

  const goNext = () => {
    if (isAtLatest) return;
    const d = periodAnchor.date;
    if (periodAnchor.kind === 'month') {
      if (periodAnchor.isCurrent) {
        const today = new Date();
        setRange(startOfMonth(today).getTime(), endOfMonth(today).getTime());
        return;
      }
      const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      setRange(startOfMonth(next).getTime(), endOfMonth(next).getTime());
    } else if (periodAnchor.kind === 'quarter') {
      const next = new Date(d.getFullYear(), d.getMonth() + 3, 1);
      setRange(startOfQuarter(next).getTime(), endOfQuarter(next).getTime());
    } else {
      const next = new Date(d.getFullYear() + 1, 0, 1);
      setRange(startOfYear(next).getTime(), endOfYear(next).getTime());
    }
  };

  useEffect(() => {
    if (!periodPickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (periodPickerRef.current && !periodPickerRef.current.contains(e.target as Node)) {
        setPeriodPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [periodPickerOpen]);

  useEffect(() => {
    setPeriodPickerOpen(false);
  }, [granularity]);

  const openPeriodPicker = () => {
    setPickerYear(periodAnchor.date.getFullYear());
    setPeriodPickerOpen((v) => !v);
  };

  const selectMonth = (year: number, monthIdx: number) => {
    const target = new Date(year, monthIdx, 1);
    setRange(startOfMonth(target).getTime(), endOfMonth(target).getTime());
    setPeriodPickerOpen(false);
  };

  const selectQuarter = (year: number, qIdx: number) => {
    const target = new Date(year, qIdx * 3, 1);
    setRange(startOfQuarter(target).getTime(), endOfQuarter(target).getTime());
    setPeriodPickerOpen(false);
  };

  const selectYear = (year: number) => {
    const target = new Date(year, 0, 1);
    setRange(startOfYear(target).getTime(), endOfYear(target).getTime());
    setPeriodPickerOpen(false);
  };

  const handleGranularityChange = (g: Granularity) => {
    if (g === granularity) return;
    setGranularity(g);
    const anchor = filter.fromMs != null ? new Date(filter.fromMs) : new Date();
    if (g === 'month') {
      setRange(startOfMonth(anchor).getTime(), endOfMonth(anchor).getTime());
    } else if (g === 'quarter') {
      setRange(startOfQuarter(anchor).getTime(), endOfQuarter(anchor).getTime());
    } else {
      setRange(startOfYear(anchor).getTime(), endOfYear(anchor).getTime());
    }
  };

  const showGranularity = view !== 'analyze';

  const showTodayButton = useMemo(() => {
    if (showGranularity) return !periodAnchor.isCurrent;
    const now = Date.now();
    if (filter.fromMs == null || filter.toMs == null) return false;
    return now < filter.fromMs || now > filter.toMs;
  }, [showGranularity, periodAnchor, filter.fromMs, filter.toMs]);

  const handleJumpToToday = useCallback(() => {
    const today = new Date();
    if (showGranularity) {
      if (granularity === 'month') {
        setRange(startOfMonth(today).getTime(), endOfMonth(today).getTime());
      } else if (granularity === 'quarter') {
        setRange(startOfQuarter(today).getTime(), endOfQuarter(today).getTime());
      } else {
        setRange(startOfYear(today).getTime(), endOfYear(today).getTime());
      }
      return;
    }
    const toMs = endOfDay(today).getTime();
    setRange(toMs - 28 * 86_400_000, toMs);
  }, [showGranularity, granularity, setRange]);

  const pickerAccounts = useMemo(
    () =>
      accounts.map((a) => ({
        id: a.account_id,
        nickname: a.nickname,
        server: a.server,
        platform: a.platform,
        eligible: a.eligible,
      })),
    [accounts]
  );

  const handleExportCsv = useCallback(() => {
    if (deals.length === 0) return;
    const csv = buildHistoryCsv({
      deals,
      accounts,
      fromMs: filter.fromMs,
      toMs: filter.toMs,
    });
    downloadCsv(defaultExportFilename(filter.fromMs, filter.toMs), csv);
  }, [deals, accounts, filter.fromMs, filter.toMs]);

  const lastNonAnalyzeRef = useRef<HistoryView>(view === 'analyze' ? 'statistics' : view);
  useEffect(() => {
    if (view !== 'analyze') lastNonAnalyzeRef.current = view;
  }, [view]);
  const toggleAnalyze = useCallback(() => {
    onSelectView(view === 'analyze' ? lastNonAnalyzeRef.current : 'analyze');
  }, [onSelectView, view]);

  return (
    <div className="flex items-center border-y border-gray-200 bg-white text-sm">
      {showGranularity && (
        <>
          <GranularityToggle value={granularity} onChange={handleGranularityChange} />
          <button
            type="button"
            onClick={goPrev}
            className="flex h-9 w-9 items-center justify-center border-r border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            aria-label={`Previous ${granularity}`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div ref={periodPickerRef} className="relative">
            <button
              type="button"
              onClick={openPeriodPicker}
              className="flex h-9 min-w-[6.5rem] items-center justify-center whitespace-nowrap border-r border-gray-200 px-3 text-center text-sm capitalize text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            >
              {periodLabel}
            </button>
            {periodPickerOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                {granularity !== 'year' && (
                  <div className="flex items-center border-b border-gray-200">
                    <button
                      type="button"
                      onClick={() => setPickerYear((y) => y - 1)}
                      className="flex h-9 w-9 items-center justify-center border-r border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                      aria-label="Previous year"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="flex-1 text-center text-sm tabular-nums text-gray-600">
                      {pickerYear}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPickerYear((y) => y + 1)}
                      disabled={pickerYear >= todayYear}
                      className="flex h-9 w-9 items-center justify-center border-l border-gray-200 text-gray-500 enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed"
                      aria-label="Next year"
                    >
                      <ChevronRight className={cn('h-4 w-4', pickerYear >= todayYear && 'opacity-30')} />
                    </button>
                  </div>
                )}
                {granularity === 'month' && (
                  <div className="grid grid-cols-3">
                    {monthShortLabels.map((label, idx) => {
                      const isFuture =
                        pickerYear > todayYear || (pickerYear === todayYear && idx > todayMonth);
                      const isSelected =
                        periodAnchor.kind === 'month' &&
                        periodAnchor.date.getFullYear() === pickerYear &&
                        periodAnchor.date.getMonth() === idx;
                      return (
                        <button
                          key={label}
                          type="button"
                          disabled={isFuture}
                          onClick={() => selectMonth(pickerYear, idx)}
                          className={cn(
                            'flex h-10 cursor-pointer items-center justify-center border-b border-r border-gray-200 text-sm capitalize text-gray-600 [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0 enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300',
                            isSelected && 'bg-gray-100 text-gray-900'
                          )}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
                {granularity === 'quarter' && (
                  <div className="grid grid-cols-2">
                    {[0, 1, 2, 3].map((qIdx) => {
                      const isFuture = pickerYear > todayYear || (pickerYear === todayYear && qIdx > todayQuarter);
                      const isSelected =
                        periodAnchor.kind === 'quarter' &&
                        periodAnchor.date.getFullYear() === pickerYear &&
                        quarterIndex(periodAnchor.date) === qIdx;
                      return (
                        <button
                          key={qIdx}
                          type="button"
                          disabled={isFuture}
                          onClick={() => selectQuarter(pickerYear, qIdx)}
                          className={cn(
                            'flex h-10 cursor-pointer items-center justify-center border-b border-r border-gray-200 text-sm text-gray-600 [&:nth-child(2n)]:border-r-0 [&:nth-last-child(-n+2)]:border-b-0 enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300',
                            isSelected && 'bg-gray-100 text-gray-900'
                          )}
                        >
                          Q{qIdx + 1}
                        </button>
                      );
                    })}
                  </div>
                )}
                {granularity === 'year' && (
                  <div className="grid grid-cols-3">
                    {Array.from({ length: 12 }, (_, i) => todayYear - 11 + i).map((yr) => {
                      const isFuture = yr > todayYear;
                      const isSelected =
                        periodAnchor.kind === 'year' &&
                        periodAnchor.date.getFullYear() === yr;
                      return (
                        <button
                          key={yr}
                          type="button"
                          disabled={isFuture}
                          onClick={() => selectYear(yr)}
                          className={cn(
                            'flex h-10 cursor-pointer items-center justify-center border-b border-r border-gray-200 text-sm tabular-nums text-gray-600 [&:nth-child(3n)]:border-r-0 [&:nth-last-child(-n+3)]:border-b-0 enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed disabled:text-gray-300',
                            isSelected && 'bg-gray-100 text-gray-900'
                          )}
                        >
                          {yr}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={goNext}
            disabled={isAtLatest}
            className="flex h-9 w-9 items-center justify-center border-r border-gray-200 text-gray-500 enabled:hover:bg-gray-100 enabled:hover:text-gray-900 disabled:cursor-not-allowed"
            aria-label={`Next ${granularity}`}
          >
            <ChevronRight className={cn('h-4 w-4', isAtLatest && 'opacity-30')} />
          </button>
        </>
      )}
      {!isCalendar && (
        <DateRangePicker
          fromMs={filter.fromMs}
          toMs={filter.toMs}
          onChange={(from, to) => setRange(from, to)}
        />
      )}
      {showTodayButton && (
        <button
          type="button"
          onClick={handleJumpToToday}
          className="flex h-9 items-center justify-center border-r border-gray-200 px-3 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
        >
          Today
        </button>
      )}
      {periodStats && (
        <ResponsiveStats
          items={[
            {
              key: 'days',
              content: (
                <>
                  <span className="text-gray-400">Trading days</span>
                  <span className="tabular-nums text-gray-600">
                    {formatCompactNumber(periodStats.daysTraded)}
                  </span>
                </>
              ),
            },
            {
              key: 'trades',
              content: (
                <>
                  <span className="text-gray-400">Trades</span>
                  <span className="tabular-nums text-gray-600">
                    {formatCompactNumber(periodStats.totalTrades)}
                  </span>
                </>
              ),
            },
            {
              key: 'total',
              content: (
                <>
                  <span className="text-gray-400">{totalLabel}</span>
                  <span className={cn('tabular-nums', pnlTextClass(periodStats.pnl))}>
                    {formatCompactNumber(periodStats.pnl, true)}
                  </span>
                </>
              ),
            },
          ]}
        />
      )}
      <AccountsPicker
        className="ml-auto"
        triggerClassName="border-l border-gray-200"
        accounts={pickerAccounts}
        selectedIds={filter.selectedAccountIds}
        onChange={setSelectedAccountIds}
      />
      <button
        type="button"
        onClick={toggleAnalyze}
        aria-pressed={view === 'analyze'}
        className={cn(
          'flex h-9 w-9 items-center justify-center border-l border-gray-200',
          view === 'analyze'
            ? 'bg-gray-100 text-gray-900'
            : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
        )}
        aria-label="Analyze (pivot view)"
      >
        <Grid3x3 className="h-4 w-4 shrink-0" />
      </button>
      {onCustomize && (
        <button
          type="button"
          onClick={onCustomize}
          className="flex h-9 w-9 items-center justify-center border-l border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          aria-label={customizeLabel ?? 'Customize'}
        >
          <Settings2 className="h-4 w-4 shrink-0" />
        </button>
      )}
      {view === 'orders' && (
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={deals.length === 0}
          className="flex h-9 w-9 items-center justify-center border-l border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Export CSV"
        >
          <Download className="h-4 w-4 shrink-0" />
        </button>
      )}
      <button
        type="button"
        onClick={() => { void refresh({ force: true }); }}
        disabled={busy}
        className="flex h-9 w-9 items-center justify-center border-l border-gray-200 text-gray-700 hover:bg-gray-100 disabled:opacity-60"
        aria-label="Refresh"
      >
        {busy ? <Loader className="h-4 w-4 animate-spin shrink-0" /> : <RefreshCw className="h-4 w-4 shrink-0" />}
      </button>
    </div>
  );
}

interface GranularityToggleProps {
  value: Granularity;
  onChange: (g: Granularity) => void;
}

const GRANULARITY_OPTIONS: { id: Granularity; label: string }[] = [
  { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' },
  { id: 'year', label: 'Year' },
];

interface ResponsiveStatsProps {
  items: { key: string; content: ReactNode }[];
}

function ResponsiveStats({ items }: ResponsiveStatsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const compute = () => {
      const GAP = 16;
      const SAFETY_PADDING = 32;
      const available = Math.max(0, container.clientWidth - SAFETY_PADDING);
      const children = Array.from(measure.children) as HTMLElement[];
      const widths = children.map((c) => c.getBoundingClientRect().width);

      let used = 0;
      let count = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        const w = widths[i] ?? 0;
        const needed = count > 0 ? GAP + w : w;
        if (used + needed <= available) {
          used += needed;
          count += 1;
        } else {
          break;
        }
      }
      const next = Math.max(1, count);
      setVisibleCount((prev) => (prev === next ? prev : next));
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(container);
    return () => ro.disconnect();
  });

  const firstVisibleIdx = items.length - visibleCount;

  return (
    <div ref={containerRef} className="relative h-9 min-w-0 flex-1 overflow-hidden">
      <div className="flex h-full items-center justify-center gap-x-4 px-3 text-sm">
        {items.map((it, i) =>
          i < firstVisibleIdx ? null : (
            <div key={it.key} className="flex items-center gap-1.5 whitespace-nowrap">
              {it.content}
            </div>
          )
        )}
      </div>
      <div
        ref={measureRef}
        aria-hidden
        className="invisible pointer-events-none absolute left-0 top-0 flex h-9 items-center gap-x-4 px-3 text-sm"
      >
        {items.map((it) => (
          <div key={it.key} className="flex items-center gap-1.5 whitespace-nowrap">
            {it.content}
          </div>
        ))}
      </div>
    </div>
  );
}

function GranularityToggle({ value, onChange }: GranularityToggleProps) {
  return (
    <div className="flex h-9 shrink-0 items-center">
      {GRANULARITY_OPTIONS.map(({ id, label }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            className={cn(
              'flex h-9 items-center justify-center border-r border-gray-200 px-3 text-sm',
              active
                ? 'bg-gray-100 text-gray-900'
                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
