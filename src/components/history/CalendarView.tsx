'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListOrdered, PieChart } from 'lucide-react';
import { useHistory } from '@/context/HistoryContext';
import { FullPageState } from '@/components/FullPageState';
import { cn } from '@/lib/utils';
import type { HistoryView } from './HistoryNav';
import {
  QUARTER_WEEK_COLS,
  WEEK_DAY_LABELS,
  buildDealsByDay,
  buildDealsByMonth,
  buildExtendedByDay,
  buildExtendedByMonth,
  dateKey,
  deriveCalendarState,
  deriveQuarterState,
  deriveYearState,
  endOfDay,
  endOfMonth,
  endOfQuarter,
  endOfYear,
  formatCompactNumber,
  monthKey,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfYear,
  sumExtendedDates,
  sumExtendedRange,
  type ExtendedAgg,
  type MonthCell,
  type MonthRow,
  type QuarterRow,
  type WeekCell,
  type WeekRow,
} from './calendarMath';
import {
  defaultCalendarPreferences,
  visibleCalendarMetrics,
  type CalendarMetricId,
  type CalendarPreferences,
} from './calendarPrefs';

function pnlCellClass(pnl: number, hasDeals: boolean, dim = false): string {
  if (!hasDeals) return 'hover:bg-white/60';
  if (Math.abs(pnl) < 0.005) return 'hover:bg-white/60';
  if (pnl > 0) {
    return dim ? 'bg-green-50/60 hover:bg-green-100/70' : 'bg-green-100/60 hover:bg-green-200/70';
  }
  return dim ? 'bg-red-50/60 hover:bg-red-100/70' : 'bg-red-100/60 hover:bg-red-200/70';
}

interface CellTextSizes {
  pnl: string;
  trades: string;
}

const DEFAULT_CELL_TEXT_SIZES: CellTextSizes = {
  pnl: 'text-sm',
  trades: 'text-[10px]',
};

function pickCellTextSizes(cellHeightPx: number): CellTextSizes {
  if (cellHeightPx >= 200) return { pnl: 'text-2xl', trades: 'text-lg' };
  if (cellHeightPx >= 160) return { pnl: 'text-xl', trades: 'text-base' };
  if (cellHeightPx >= 120) return { pnl: 'text-lg', trades: 'text-sm' };
  if (cellHeightPx >= 85) return { pnl: 'text-base', trades: 'text-xs' };
  return DEFAULT_CELL_TEXT_SIZES;
}

function useCellTextSizes(rowCount: number, hasHeaderRow: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [sizes, setSizes] = useState<CellTextSizes>(DEFAULT_CELL_TEXT_SIZES);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const HEADER_ROW_PX = 28;
    const compute = () => {
      const totalH = node.clientHeight;
      const usable = hasHeaderRow ? Math.max(0, totalH - HEADER_ROW_PX) : totalH;
      const rows = Math.max(1, rowCount);
      const cellH = usable / rows;
      const next = pickCellTextSizes(cellH);
      setSizes((prev) => (prev.pnl === next.pnl && prev.trades === next.trades ? prev : next));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(node);
    return () => ro.disconnect();
  }, [rowCount, hasHeaderRow]);

  return { ref, sizes };
}

interface CalendarViewProps {
  onNavigate?: (view: HistoryView) => void;
  prefs?: CalendarPreferences;
}

export function CalendarView({ onNavigate, prefs }: CalendarViewProps) {
  const { granularity } = useHistory();
  const layout = prefs ?? defaultCalendarPreferences();

  if (granularity === 'year') return <YearGrid onNavigate={onNavigate} prefs={layout} />;
  if (granularity === 'quarter') return <QuarterGrid onNavigate={onNavigate} prefs={layout} />;
  return <MonthGrid onNavigate={onNavigate} prefs={layout} />;
}

function pnlSignedClass(pnl: number): string {
  if (Math.abs(pnl) < 0.005) return 'text-gray-500';
  return pnl > 0 ? 'text-green-600' : 'text-red-600';
}

function formatVolume(volume: number): string {
  if (!Number.isFinite(volume) || volume <= 0) return '0';
  if (volume >= 1000) return `${(volume / 1000).toFixed(1)}K`;
  if (volume >= 100) return volume.toFixed(0);
  if (volume >= 10) return volume.toFixed(1);
  return volume.toFixed(2);
}

interface MetricVisual {
  primary: boolean;
  display: string;
  toneClass: string;
}

function metricForCell(id: CalendarMetricId, ext: ExtendedAgg, primary: boolean): MetricVisual | null {
  if (ext.count === 0) return null;
  switch (id) {
    case 'netPnl':
      return {
        primary,
        display: formatCompactNumber(ext.pnl, true),
        toneClass: pnlSignedClass(ext.pnl),
      };
    case 'tradeCount':
      return {
        primary,
        display: `${ext.count} ${ext.count === 1 ? 'trade' : 'trades'}`,
        toneClass: 'text-gray-400',
      };
    case 'winRate': {
      const decided = ext.wins + ext.losses;
      const wr = decided > 0 ? (ext.wins / decided) * 100 : 0;
      return {
        primary,
        display: `${wr.toFixed(0)}% win`,
        toneClass: wr >= 60 ? 'text-green-600' : wr >= 45 ? 'text-amber-600' : 'text-red-600',
      };
    }
    case 'bestTrade':
      return {
        primary,
        display: `${formatCompactNumber(ext.bestPnl, true)} best`,
        toneClass: 'text-green-600',
      };
    case 'worstTrade':
      return {
        primary,
        display: `${formatCompactNumber(ext.worstPnl, true)} worst`,
        toneClass: 'text-red-600',
      };
    case 'volume':
      return {
        primary,
        display: `${formatVolume(ext.volume)} vol`,
        toneClass: 'text-gray-500',
      };
    case 'avgTrade': {
      const avg = ext.count > 0 ? ext.pnl / ext.count : 0;
      return {
        primary,
        display: `${formatCompactNumber(avg, true)} avg`,
        toneClass: pnlSignedClass(avg),
      };
    }
    default:
      return null;
  }
}

interface CellMetricsProps {
  ext: ExtendedAgg | null;
  prefs: CalendarPreferences;
  sizes: CellTextSizes;
}

function CellMetrics({ ext, prefs, sizes }: CellMetricsProps) {
  if (!ext || ext.count === 0) return null;
  const visible = visibleCalendarMetrics(prefs);
  const metricVisuals: MetricVisual[] = [];
  for (let i = 0; i < visible.length; i++) {
    const v = metricForCell(visible[i], ext, i === 0);
    if (v) metricVisuals.push(v);
  }
  if (metricVisuals.length === 0) return null;
  return (
    <>
      {metricVisuals.map((v, i) => (
        <span
          key={`${i}-${v.display}`}
          className={cn(
            'font-semibold tabular-nums leading-tight',
            v.primary ? sizes.pnl : sizes.trades,
            !v.primary && 'font-normal',
            v.toneClass
          )}
        >
          {v.display}
        </span>
      ))}
    </>
  );
}

function MonthGrid({ onNavigate, prefs }: CalendarViewProps) {
  const { allDeals, isLoading, filter, setRange, ensureRangeCovered } = useHistory();
  const today = useMemo(() => new Date(), []);
  const layout = prefs ?? defaultCalendarPreferences();

  const dealsByDay = useMemo(() => buildDealsByDay(allDeals), [allDeals]);
  const extByDay = useMemo(() => buildExtendedByDay(allDeals), [allDeals]);
  const { isCurrentMonth, currentMonth, rows } = useMemo(
    () => deriveCalendarState(filter, today, dealsByDay),
    [filter, today, dealsByDay]
  );

  const visibleRange = useMemo(() => {
    if (rows.length === 0) return null;
    const firstDay = rows[0].days[0].date;
    const lastDay = rows[rows.length - 1].days[6].date;
    return {
      fromMs: startOfDay(firstDay).getTime(),
      toMs: endOfDay(lastDay).getTime(),
    };
  }, [rows]);

  useEffect(() => {
    if (!visibleRange) return;
    ensureRangeCovered(visibleRange.fromMs, visibleRange.toMs);
  }, [visibleRange, ensureRangeCovered]);

  const goToDay = (date: Date, view: HistoryView) => {
    setRange(startOfDay(date).getTime(), endOfDay(date).getTime());
    onNavigate?.(view);
  };

  const goToWeek = (start: Date, end: Date, view: HistoryView) => {
    setRange(startOfDay(start).getTime(), endOfDay(end).getTime());
    onNavigate?.(view);
  };

  const goPrevMonth = useCallback(() => {
    const prev = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    setRange(startOfMonth(prev).getTime(), endOfMonth(prev).getTime());
  }, [currentMonth, setRange]);

  const goNextMonth = useCallback(() => {
    if (isCurrentMonth) return;
    const next = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    setRange(startOfMonth(next).getTime(), endOfMonth(next).getTime());
  }, [currentMonth, isCurrentMonth, setRange]);

  const containerRef = useHorizontalWheelNav(goPrevMonth, goNextMonth, !isCurrentMonth);
  const { ref: gridRef, sizes } = useCellTextSizes(rows.length, true);

  return (
    <div className="flex h-full flex-col">
      <div ref={containerRef} className="relative flex-1 min-h-0 overflow-hidden">
        {isLoading && allDeals.length === 0 ? (
          <FullPageState
            title="Loading calendar"
            subtitle="Fetching your trade history…"
            showSpinner
            className="bg-white"
          />
        ) : (
          <div
            ref={gridRef}
            className="grid h-full grid-cols-8"
            style={{ gridTemplateRows: `auto repeat(${rows.length}, minmax(0, 1fr))` }}
          >
            {WEEK_DAY_LABELS.map((l) => (
              <div
                key={l}
                className="border-r border-b border-gray-200 bg-white px-2 py-1 text-xs uppercase text-gray-500"
              >
                {l}
              </div>
            ))}
            <div className="border-r border-b border-gray-200 bg-white px-2 py-1 text-right text-xs uppercase text-gray-500">
              Summary
            </div>
            {rows.flatMap((row, ri) => [
              ...row.days.map((d, di) => {
                const blank = !d.inMonth;
                if (blank) {
                  return (
                    <div
                      key={`d-${ri}-${di}`}
                      aria-hidden
                      className="border-r border-b border-gray-200 bg-gray-100/60"
                    />
                  );
                }
                const dayExt = extByDay.get(dateKey(d.date)) ?? null;
                return (
                  <div
                    key={`d-${ri}-${di}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => goToDay(d.date, 'orders')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        goToDay(d.date, 'orders');
                      }
                    }}
                    className={cn(
                      'group relative flex h-full min-h-0 cursor-pointer flex-col border-r border-b border-gray-200 p-1.5 text-sm transition-colors focus:outline-none',
                      pnlCellClass(d.pnl, d.hasDeals, !d.inMonth)
                    )}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div
                        className={cn(
                          'flex gap-0.5 transition-opacity',
                          d.hasDeals ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                        )}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            goToDay(d.date, 'statistics');
                          }}
                          className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
                          aria-label="View statistics for this day"
                        >
                          <PieChart className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            goToDay(d.date, 'orders');
                          }}
                          className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
                          aria-label="View orders for this day"
                        >
                          <ListOrdered className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <span className={cn('text-xs', d.inMonth ? 'text-gray-700' : 'text-gray-400')}>
                        {d.date.getDate()}
                      </span>
                    </div>
                    <div className="mt-auto flex flex-col items-end leading-tight">
                      <CellMetrics ext={dayExt} prefs={layout} sizes={sizes} />
                    </div>
                  </div>
                );
              }),
              renderWeekSummary(row, ri, goToWeek, extByDay, layout, sizes),
            ])}
          </div>
        )}
      </div>
    </div>
  );
}

function renderWeekSummary(
  row: WeekRow,
  ri: number,
  goToWeek: (start: Date, end: Date, view: HistoryView) => void,
  extByDay: Map<string, ExtendedAgg>,
  prefs: CalendarPreferences,
  sizes: CellTextSizes
) {
  const inMonthDays = row.days.filter((d) => d.inMonth);
  const ext = sumExtendedDates(
    extByDay,
    inMonthDays.map((d) => d.date)
  );
  const hasData = ext.count > 0;
  const rangeStart = inMonthDays.length > 0 ? inMonthDays[0].date : row.startDate;
  const rangeEnd =
    inMonthDays.length > 0 ? inMonthDays[inMonthDays.length - 1].date : row.endDate;
  return (
    <div
      key={`w-${ri}`}
      role="button"
      tabIndex={0}
      onClick={() => goToWeek(rangeStart, rangeEnd, 'orders')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToWeek(rangeStart, rangeEnd, 'orders');
        }
      }}
      className="group relative flex h-full min-h-0 cursor-pointer flex-col border-r border-b border-gray-200 bg-gray-100/60 p-1.5 text-sm transition-colors hover:bg-gray-200/70 focus:outline-none"
    >
      <div className="flex items-start justify-between gap-1">
        <div
          className={cn(
            'flex gap-0.5 transition-opacity',
            hasData ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToWeek(rangeStart, rangeEnd, 'statistics');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View statistics for this week"
          >
            <PieChart className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToWeek(rangeStart, rangeEnd, 'orders');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View orders for this week"
          >
            <ListOrdered className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="text-xs uppercase  text-gray-600">
          <span className="hidden lg:inline">Week </span>{ri + 1}
        </span>
      </div>
      <div className="mt-auto flex flex-col items-end leading-tight">
        <CellMetrics ext={hasData ? ext : null} prefs={prefs} sizes={sizes} />
      </div>
    </div>
  );
}

function QuarterGrid({ onNavigate, prefs }: CalendarViewProps) {
  const { allDeals, isLoading, filter, setRange, setGranularity, ensureRangeCovered } = useHistory();
  const today = useMemo(() => new Date(), []);
  const layout = prefs ?? defaultCalendarPreferences();

  const dealsByDay = useMemo(() => buildDealsByDay(allDeals), [allDeals]);
  const extByDay = useMemo(() => buildExtendedByDay(allDeals), [allDeals]);
  const { isCurrentQuarter, currentQuarter, rows } = useMemo(
    () => deriveQuarterState(filter, today, dealsByDay),
    [filter, today, dealsByDay]
  );

  useEffect(() => {
    ensureRangeCovered(currentQuarter.getTime(), endOfQuarter(currentQuarter).getTime());
  }, [currentQuarter, ensureRangeCovered]);

  const goToWeek = (start: Date, end: Date) => {
    setRange(startOfDay(start).getTime(), endOfDay(end).getTime());
    setGranularity('month');
    onNavigate?.('calendar');
  };

  const goToWeekView = (start: Date, end: Date, view: HistoryView) => {
    setRange(startOfDay(start).getTime(), endOfDay(end).getTime());
    onNavigate?.(view);
  };

  const goToMonth = (monthDate: Date) => {
    setRange(startOfMonth(monthDate).getTime(), endOfMonth(monthDate).getTime());
    setGranularity('month');
    onNavigate?.('calendar');
  };

  const goToMonthView = (monthDate: Date, view: HistoryView) => {
    setRange(startOfMonth(monthDate).getTime(), endOfMonth(monthDate).getTime());
    onNavigate?.(view);
  };

  const goPrevQuarter = useCallback(() => {
    const prev = new Date(currentQuarter.getFullYear(), currentQuarter.getMonth() - 3, 1);
    setRange(startOfQuarter(prev).getTime(), endOfQuarter(prev).getTime());
  }, [currentQuarter, setRange]);

  const goNextQuarter = useCallback(() => {
    if (isCurrentQuarter) return;
    const next = new Date(currentQuarter.getFullYear(), currentQuarter.getMonth() + 3, 1);
    setRange(startOfQuarter(next).getTime(), endOfQuarter(next).getTime());
  }, [currentQuarter, isCurrentQuarter, setRange]);

  const containerRef = useHorizontalWheelNav(goPrevQuarter, goNextQuarter, !isCurrentQuarter);
  const { ref: gridRef, sizes } = useCellTextSizes(rows.length, true);

  const totalCols = QUARTER_WEEK_COLS + 1;
  return (
    <div className="flex h-full flex-col">
      <div ref={containerRef} className="relative flex-1 min-h-0 overflow-hidden">
        {isLoading && allDeals.length === 0 ? (
          <FullPageState
            title="Loading calendar"
            subtitle="Fetching your trade history…"
            showSpinner
            className="bg-white"
          />
        ) : (
          <div
            ref={gridRef}
            className="grid h-full"
            style={{
              gridTemplateColumns: `repeat(${totalCols}, minmax(0, 1fr))`,
              gridTemplateRows: `auto repeat(${rows.length}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: QUARTER_WEEK_COLS }, (_, i) => (
              <div
                key={`hw-${i}`}
                className="border-r border-b border-gray-200 bg-white px-2 py-1 text-xs uppercase text-gray-500"
              >
                Week {i + 1}
              </div>
            ))}
            <div className="border-r border-b border-gray-200 bg-white px-2 py-1 text-right text-xs uppercase text-gray-500">
              Summary
            </div>
            {rows.flatMap((row, ri) => [
              ...row.weeks.map((w, wi) => {
                if (!w) {
                  return (
                    <div
                      key={`qw-${ri}-${wi}`}
                      aria-hidden
                      className="border-r border-b border-gray-200 bg-gray-100/60"
                    />
                  );
                }
                return renderWeekCellInQuarter(w, ri, wi, goToWeek, goToWeekView, extByDay, layout, sizes);
              }),
              renderMonthSummary(row, ri, goToMonth, goToMonthView, extByDay, layout, sizes),
            ])}
          </div>
        )}
      </div>
    </div>
  );
}

function renderWeekCellInQuarter(
  w: WeekCell,
  ri: number,
  wi: number,
  goToWeek: (start: Date, end: Date) => void,
  goToWeekView: (start: Date, end: Date, view: HistoryView) => void,
  extByDay: Map<string, ExtendedAgg>,
  prefs: CalendarPreferences,
  sizes: CellTextSizes
) {
  const ext = sumExtendedRange(extByDay, w.startDate, w.endDate);
  const hasData = ext.count > 0;
  return (
    <div
      key={`qw-${ri}-${wi}`}
      role="button"
      tabIndex={0}
      onClick={() => goToWeek(w.startDate, w.endDate)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToWeek(w.startDate, w.endDate);
        }
      }}
      className={cn(
        'group relative flex h-full min-h-0 cursor-pointer flex-col border-r border-b border-gray-200 p-1.5 text-sm transition-colors focus:outline-none',
        pnlCellClass(w.pnl, w.hasDeals)
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <div
          className={cn(
            'flex gap-0.5 transition-opacity',
            hasData ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToWeekView(w.startDate, w.endDate, 'statistics');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View statistics for this week"
          >
            <PieChart className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToWeekView(w.startDate, w.endDate, 'orders');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View orders for this week"
          >
            <ListOrdered className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="text-xs text-gray-700">
          {w.startDate.getDate()}–{w.endDate.getDate()}
        </span>
      </div>
      <div className="mt-auto flex flex-col items-end leading-tight">
        <CellMetrics ext={hasData ? ext : null} prefs={prefs} sizes={sizes} />
      </div>
    </div>
  );
}

function renderMonthSummary(
  row: MonthRow,
  ri: number,
  goToMonth: (monthDate: Date) => void,
  goToMonthView: (monthDate: Date, view: HistoryView) => void,
  extByDay: Map<string, ExtendedAgg>,
  prefs: CalendarPreferences,
  sizes: CellTextSizes
) {
  const ext = sumExtendedRange(extByDay, startOfMonth(row.monthDate), endOfMonth(row.monthDate));
  const hasData = ext.count > 0;
  return (
    <div
      key={`qsum-${ri}`}
      role="button"
      tabIndex={0}
      onClick={() => goToMonth(row.monthDate)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToMonth(row.monthDate);
        }
      }}
      className="group relative flex h-full min-h-0 cursor-pointer flex-col border-r border-b border-gray-200 bg-gray-100/60 p-1.5 text-sm transition-colors hover:bg-gray-200/70 focus:outline-none"
    >
      <div className="flex items-start justify-between gap-1">
        <div
          className={cn(
            'flex gap-0.5 transition-opacity',
            hasData ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToMonthView(row.monthDate, 'statistics');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View statistics for this month"
          >
            <PieChart className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToMonthView(row.monthDate, 'orders');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View orders for this month"
          >
            <ListOrdered className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="text-xs uppercase text-gray-600 capitalize">{row.monthLabel}</span>
      </div>
      <div className="mt-auto flex flex-col items-end leading-tight">
        <CellMetrics ext={hasData ? ext : null} prefs={prefs} sizes={sizes} />
      </div>
    </div>
  );
}

function YearGrid({ onNavigate, prefs }: CalendarViewProps) {
  const { allDeals, isLoading, filter, setRange, setGranularity, ensureRangeCovered } = useHistory();
  const today = useMemo(() => new Date(), []);
  const layout = prefs ?? defaultCalendarPreferences();

  const dealsByDay = useMemo(() => buildDealsByDay(allDeals), [allDeals]);
  const dealsByMonth = useMemo(() => buildDealsByMonth(allDeals), [allDeals]);
  const extByDay = useMemo(() => buildExtendedByDay(allDeals), [allDeals]);
  const extByMonth = useMemo(() => buildExtendedByMonth(allDeals), [allDeals]);
  const { isCurrentYear, currentYear, rows } = useMemo(
    () => deriveYearState(filter, today, dealsByDay, dealsByMonth),
    [filter, today, dealsByDay, dealsByMonth]
  );

  useEffect(() => {
    ensureRangeCovered(currentYear.getTime(), endOfYear(currentYear).getTime());
  }, [currentYear, ensureRangeCovered]);

  const goToMonth = (monthDate: Date) => {
    setRange(startOfMonth(monthDate).getTime(), endOfMonth(monthDate).getTime());
    setGranularity('month');
    onNavigate?.('calendar');
  };

  const goToMonthView = (monthDate: Date, view: HistoryView) => {
    setRange(startOfMonth(monthDate).getTime(), endOfMonth(monthDate).getTime());
    onNavigate?.(view);
  };

  const goToQuarter = (qStart: Date) => {
    setRange(startOfQuarter(qStart).getTime(), endOfQuarter(qStart).getTime());
    setGranularity('quarter');
    onNavigate?.('calendar');
  };

  const goToQuarterView = (qStart: Date, view: HistoryView) => {
    setRange(startOfQuarter(qStart).getTime(), endOfQuarter(qStart).getTime());
    onNavigate?.(view);
  };

  const goPrevYear = useCallback(() => {
    const prev = new Date(currentYear.getFullYear() - 1, 0, 1);
    setRange(startOfYear(prev).getTime(), endOfYear(prev).getTime());
  }, [currentYear, setRange]);

  const goNextYear = useCallback(() => {
    if (isCurrentYear) return;
    const next = new Date(currentYear.getFullYear() + 1, 0, 1);
    setRange(startOfYear(next).getTime(), endOfYear(next).getTime());
  }, [currentYear, isCurrentYear, setRange]);

  const containerRef = useHorizontalWheelNav(goPrevYear, goNextYear, !isCurrentYear);
  const { ref: gridRef, sizes } = useCellTextSizes(rows.length, false);

  return (
    <div className="flex h-full flex-col">
      <div ref={containerRef} className="relative flex-1 min-h-0 overflow-hidden">
        {isLoading && allDeals.length === 0 ? (
          <FullPageState
            title="Loading calendar"
            subtitle="Fetching your trade history…"
            showSpinner
            className="bg-white"
          />
        ) : (
          <div
            ref={gridRef}
            className="grid h-full grid-cols-4"
            style={{ gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))` }}
          >
            {rows.flatMap((row, ri) => [
              ...row.months.map((m, mi) =>
                renderMonthCellInYear(m, ri, mi, goToMonth, goToMonthView, extByMonth, layout, sizes)
              ),
              renderQuarterSummary(row, ri, goToQuarter, goToQuarterView, extByDay, layout, sizes),
            ])}
          </div>
        )}
      </div>
    </div>
  );
}

function renderMonthCellInYear(
  m: MonthCell,
  ri: number,
  mi: number,
  goToMonth: (monthDate: Date) => void,
  goToMonthView: (monthDate: Date, view: HistoryView) => void,
  extByMonth: Map<string, ExtendedAgg>,
  prefs: CalendarPreferences,
  sizes: CellTextSizes
) {
  const ext = extByMonth.get(monthKey(m.monthDate)) ?? null;
  return (
    <div
      key={`ym-${ri}-${mi}`}
      role="button"
      tabIndex={0}
      onClick={() => goToMonth(m.monthDate)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToMonth(m.monthDate);
        }
      }}
      className={cn(
        'group relative flex h-full min-h-0 cursor-pointer flex-col border-r border-b border-gray-200 p-1.5 text-sm transition-colors focus:outline-none',
        pnlCellClass(m.pnl, m.hasDeals, m.isFuture)
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <div
          className={cn(
            'flex gap-0.5 transition-opacity',
            m.hasDeals ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToMonthView(m.monthDate, 'statistics');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View statistics for this month"
          >
            <PieChart className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToMonthView(m.monthDate, 'orders');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View orders for this month"
          >
            <ListOrdered className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className={cn('text-xs', m.isFuture ? 'text-gray-400' : 'text-gray-700')}>
          {m.monthLabel}
        </span>
      </div>
      <div className="mt-auto flex flex-col items-end leading-tight">
        <CellMetrics ext={ext} prefs={prefs} sizes={sizes} />
      </div>
    </div>
  );
}

function renderQuarterSummary(
  row: QuarterRow,
  ri: number,
  goToQuarter: (qStart: Date) => void,
  goToQuarterView: (qStart: Date, view: HistoryView) => void,
  extByDay: Map<string, ExtendedAgg>,
  prefs: CalendarPreferences,
  sizes: CellTextSizes
) {
  const ext = sumExtendedRange(extByDay, row.quarterStart, endOfQuarter(row.quarterStart));
  const hasData = ext.count > 0;
  return (
    <div
      key={`yq-${ri}`}
      role="button"
      tabIndex={0}
      onClick={() => goToQuarter(row.quarterStart)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          goToQuarter(row.quarterStart);
        }
      }}
      className="group relative flex h-full min-h-0 cursor-pointer flex-col border-r border-b border-gray-200 bg-gray-100/60 p-1.5 text-sm transition-colors hover:bg-gray-200/70 focus:outline-none"
    >
      <div className="flex items-start justify-between gap-1">
        <div
          className={cn(
            'flex gap-0.5 transition-opacity',
            hasData ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToQuarterView(row.quarterStart, 'statistics');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View statistics for this quarter"
          >
            <PieChart className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goToQuarterView(row.quarterStart, 'orders');
            }}
            className="p-0.5 text-gray-500 transition-colors hover:text-gray-900"
            aria-label="View orders for this quarter"
          >
            <ListOrdered className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className="text-xs uppercase text-gray-600">{row.quarterLabel}</span>
      </div>
      <div className="mt-auto flex flex-col items-end leading-tight">
        <CellMetrics ext={hasData ? ext : null} prefs={prefs} sizes={sizes} />
      </div>
    </div>
  );
}

function useHorizontalWheelNav(
  goPrev: () => void,
  goNext: () => void,
  canGoNext: boolean
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const accumDeltaX = useRef(0);
  const lastNavMs = useRef(0);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const SCROLL_THRESHOLD = 60;
    const NAV_COOLDOWN_MS = 450;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) {
        accumDeltaX.current = 0;
        return;
      }
      e.preventDefault();
      const now = Date.now();
      if (now - lastNavMs.current < NAV_COOLDOWN_MS) return;
      accumDeltaX.current += e.deltaX;
      if (accumDeltaX.current >= SCROLL_THRESHOLD) {
        if (canGoNext) {
          goNext();
          lastNavMs.current = now;
        }
        accumDeltaX.current = 0;
      } else if (accumDeltaX.current <= -SCROLL_THRESHOLD) {
        goPrev();
        lastNavMs.current = now;
        accumDeltaX.current = 0;
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [goPrev, goNext, canGoNext]);

  return containerRef;
}
