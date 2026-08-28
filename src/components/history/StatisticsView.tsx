'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Award,
  BarChart3,
  Flame,
  Snowflake,
  Target,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useHistory } from '@/context/HistoryContext';
import { cn } from '@/lib/utils';
import { FullPageState } from '@/components/FullPageState';
import { ManualScrollbar } from '@/components/ui/ManualScrollbar';
import {
  ChartCard,
  EquityCurveChart,
  DailyPnlBarsChart,
  DrawdownChart,
  SymbolBarsChart,
  HourBarsChart,
  WeekdayBarsChart,
  HourDayHeatmap,
  HistogramChart,
  PeriodHeatmap,
  ScoreRadarChart,
  DonutChart,
  WinRateGauge,
  DurationBarsChart,
} from './Charts';
import {
  computeCoreStats,
  computeEquityCurve,
  computeDrawdownStats,
  computeDailyBuckets,
  computeRatioStats,
  computeSymbolBuckets,
  computeHourBuckets,
  computeWeekdayBuckets,
  computeHourDayMatrix,
  computeHistogram,
  computePeriodCalendarCells,
  computeDurationBuckets,
  computeIptradeScore,
} from './statisticsMath';
import { defaultStatsPreferences, type StatsPreferences, type StatsSectionId } from './statisticsPrefs';
import { IptradeScoreCard } from './IptradeScoreCard';

function formatMoney(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPnlSigned(value: number): string {
  if (Math.abs(value) < 0.005) return '0.00';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatMoney(value)}`;
}

function formatHoldingTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDate(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatRatio(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '∞';
  return value.toFixed(decimals);
}


interface HeroStatProps {
  label: string;
  value: string;
  hint?: string;
  tone?: 'positive' | 'negative' | 'neutral';
  icon?: React.ReactNode;
  accent?: 'green' | 'red' | 'amber' | 'blue' | 'gray';
}

function HeroStat({ label, value, hint, tone = 'neutral', icon, accent = 'gray' }: HeroStatProps) {
  const accentBg = {
    green: 'bg-green-50',
    red: 'bg-red-50',
    amber: 'bg-amber-50',
    blue: 'bg-sky-50',
    gray: '',
  }[accent];
  const iconColor = {
    green: 'text-green-600 bg-green-100',
    red: 'text-red-600 bg-red-100',
    amber: 'text-amber-600 bg-amber-100',
    blue: 'text-sky-600 bg-sky-100',
    gray: 'text-gray-600 bg-gray-100',
  }[accent];
  const valueTone =
    tone === 'positive' ? 'text-green-700' : tone === 'negative' ? 'text-red-700' : 'text-gray-900';
  return (
    <div className={cn('border-r border-b border-gray-200 p-3 flex items-start gap-3', accentBg)}>
      {icon && (
        <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center', iconColor)}>
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-semibold uppercase r text-gray-500">{label}</div>
        <div
          className={cn(
            'mt-0.5 font-bold tabular-nums leading-tight',
            'text-xl sm:text-2xl',
            valueTone
          )}
        >
          {value}
        </div>
        {hint && <div className="mt-0.5 text-[11px] text-gray-500 truncate">{hint}</div>}
      </div>
    </div>
  );
}


interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: 'positive' | 'negative' | 'neutral';
}

function KpiCard({ label, value, hint, tone = 'neutral' }: KpiCardProps) {
  const toneClass =
    tone === 'positive' ? 'text-green-700' : tone === 'negative' ? 'text-red-700' : 'text-gray-900';
  return (
    <div className="border-r border-b border-gray-200 p-3">
      <div className="text-[10px] font-semibold uppercase r text-gray-500 truncate">
        {label}
      </div>
      <div className={cn('mt-1 font-semibold tabular-nums text-base', toneClass)}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-gray-400 truncate">{hint}</div>}
    </div>
  );
}


interface StatisticsViewProps {
  prefs?: StatsPreferences;
}

export function StatisticsView({ prefs }: StatisticsViewProps = {}) {
  const { deals, allDeals, isLoading, isRefreshing, filter, serverNowMs } = useHistory();
  const layout = prefs ?? defaultStatsPreferences();

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [scrollMetrics, setScrollMetrics] = useState<{
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  } | null>(null);

  const updateScrollState = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setScrollMetrics({
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    });
  }, []);

  const visibleKey = layout.order.filter((id) => layout.visible[id]).join(',');

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    updateScrollState();
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener('scroll', updateScrollState);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', updateScrollState);
    };
  }, [updateScrollState, visibleKey]);

  const handleVerticalScrollbarChange = useCallback((nextValue: number) => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = nextValue;
  }, []);

  const hasVerticalScroll = !!scrollMetrics && scrollMetrics.scrollHeight > scrollMetrics.clientHeight;

  const closedDeals = useMemo(() => deals.filter((d) => d.close_time_ms > 0), [deals]);

  const core = useMemo(() => computeCoreStats(closedDeals), [closedDeals]);
  const equity = useMemo(() => computeEquityCurve(closedDeals), [closedDeals]);
  const drawdown = useMemo(() => computeDrawdownStats(equity, core.netTotal), [equity, core.netTotal]);
  const daily = useMemo(() => computeDailyBuckets(closedDeals), [closedDeals]);
  const ratios = useMemo(
    () =>
      computeRatioStats(daily, drawdown.maxDrawdown, {
        wins: core.wins,
        losses: core.losses,
        totalTrades: core.totalTrades,
      }),
    [daily, drawdown.maxDrawdown, core.wins, core.losses, core.totalTrades]
  );
  const symbols = useMemo(() => computeSymbolBuckets(closedDeals), [closedDeals]);
  const hours = useMemo(() => computeHourBuckets(closedDeals), [closedDeals]);
  const weekdays = useMemo(() => computeWeekdayBuckets(closedDeals), [closedDeals]);
  const hourDay = useMemo(() => computeHourDayMatrix(closedDeals), [closedDeals]);
  const histogram = useMemo(
    () => computeHistogram(closedDeals.map((d) => d.net_profit), 24),
    [closedDeals]
  );
  const durations = useMemo(() => computeDurationBuckets(closedDeals), [closedDeals]);

  const [filterFromMs, filterToMs] = useMemo<[number, number]>(() => {
    let from = filter.fromMs;
    let to = filter.toMs;
    if (from == null) {
      let earliest = Date.now() - 28 * 86_400_000;
      if (closedDeals.length > 0) {
        earliest = closedDeals[0].close_time_ms || closedDeals[0].open_time_ms;
        for (const d of closedDeals) {
          const t = d.close_time_ms || d.open_time_ms;
          if (t < earliest) earliest = t;
        }
      }
      from = earliest;
    }
    if (to == null) to = serverNowMs || Date.now();
    return [from, to];
  }, [filter.fromMs, filter.toMs, closedDeals, serverNowMs]);
  const periodCells = useMemo(
    () => computePeriodCalendarCells(daily, filterFromMs, filterToMs),
    [daily, filterFromMs, filterToMs]
  );
  const score = useMemo(
    () =>
      computeIptradeScore(core, drawdown, ratios, {
        totalTrades: core.totalTrades,
      }),
    [core, drawdown, ratios]
  );

  const topSymbols = useMemo(() => symbols.slice(0, 10), [symbols]);
  const bottomSymbols = useMemo(() => [...symbols].reverse().slice(0, 10), [symbols]);
  const symbolDistribution = useMemo(() => {
    const palette = [
      '#0ea5e9',
      '#22c55e',
      '#f97316',
      '#a855f7',
      '#ec4899',
      '#eab308',
      '#14b8a6',
      '#ef4444',
      '#6366f1',
      '#84cc16',
    ];
    const top = symbols
      .map((s) => ({ ...s }))
      .sort((a, b) => b.trades - a.trades)
      .slice(0, 8);
    const otherTrades = symbols.slice(8).reduce((s, x) => s + x.trades, 0);
    const segments = top.map((s, i) => ({
      label: s.symbol,
      value: s.trades,
      color: palette[i % palette.length],
    }));
    if (otherTrades > 0) {
      segments.push({ label: 'Other', value: otherTrades, color: '#9ca3af' });
    }
    return segments;
  }, [symbols]);

  const busy = isLoading || isRefreshing;
  if (busy && allDeals.length === 0) {
    return (
      <FullPageState
        title="Loading statistics"
        subtitle="Crunching your trade history to compute performance metrics…"
        showSpinner
        className="bg-white"
      />
    );
  }
  if (closedDeals.length === 0) {
    return (
      <FullPageState
        title="No closed trades in this period"
        subtitle="Statistics will appear here once you have closed trades within the selected filters."
        showSpinner={false}
        icon={<BarChart3 className="h-6 w-6 text-gray-400 m-2" />}
        className="bg-white"
      />
    );
  }

  const longWinRate = core.longTrades > 0 ? (core.longWins / core.longTrades) * 100 : 0;
  const shortWinRate = core.shortTrades > 0 ? (core.shortWins / core.shortTrades) * 100 : 0;
  const netTone = core.netTotal > 0 ? 'positive' : core.netTotal < 0 ? 'negative' : 'neutral';
  const netAccent = core.netTotal > 0 ? 'green' : core.netTotal < 0 ? 'red' : 'gray';
  const streakIsWin = core.currentStreakKind === 'win';
  const streakIsLoss = core.currentStreakKind === 'loss';
  const expectancyTone =
    core.expectancy > 0 ? 'positive' : core.expectancy < 0 ? 'negative' : 'neutral';

  const kellyTone =
    core.kellyPercent > 0 ? 'positive' : core.kellyPercent < 0 ? 'negative' : 'neutral';
  const sqnTone = core.sqn > 1.7 ? 'positive' : core.sqn < 0 ? 'negative' : 'neutral';
  const profitPerLotTone =
    core.profitPerLot > 0 ? 'positive' : core.profitPerLot < 0 ? 'negative' : 'neutral';
  const zScoreHint =
    Math.abs(core.zScore) < 1.96
      ? 'random sequence'
      : core.zScore < 0
      ? 'streaks (negative Z)'
      : 'alternating (positive Z)';
  const periodSubtitle = (() => {
    if (!Number.isFinite(filterFromMs) || !Number.isFinite(filterToMs)) return 'Daily P&L';
    const days = Math.max(
      1,
      Math.round((filterToMs - filterFromMs) / 86_400_000)
    );
    return `${days} day${days === 1 ? '' : 's'} ${formatDate(filterFromMs)} → ${formatDate(filterToMs)}`;
  })();

  const sections: Record<StatsSectionId, React.ReactNode> = {
    hero: (
      <section key="hero" className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4">
        <HeroStat
          label="Net P&L"
          value={formatPnlSigned(core.netTotal)}
          tone={netTone}
          accent={netAccent}
          icon={
            core.netTotal >= 0 ? (
              <TrendingUp className="h-5 w-5" />
            ) : (
              <TrendingDown className="h-5 w-5" />
            )
          }
          hint={`${core.totalTrades} trade${core.totalTrades === 1 ? '' : 's'} Expectancy ${formatPnlSigned(core.expectancy)}`}
        />
        <HeroStat
          label="Profit factor"
          value={formatRatio(core.profitFactor)}
          tone={core.profitFactor >= 1.5 ? 'positive' : core.profitFactor >= 1 ? 'neutral' : 'negative'}
          accent={core.profitFactor >= 1 ? 'blue' : 'red'}
          icon={<Target className="h-5 w-5" />}
          hint={`Gross ${formatPnlSigned(core.grossProfit)} / ${formatPnlSigned(-core.grossLoss)}`}
        />
        <HeroStat
          label="Max drawdown"
          value={formatPnlSigned(-drawdown.maxDrawdown)}
          tone={drawdown.maxDrawdown > 0 ? 'negative' : 'neutral'}
          accent={drawdown.maxDrawdown > 0 ? 'amber' : 'gray'}
          icon={<ArrowDownRight className="h-5 w-5" />}
          hint={drawdown.maxDrawdownPct > 0 ? `${drawdown.maxDrawdownPct.toFixed(1)}% peak-to-trough` : 'No drawdown'}
        />
        <HeroStat
          label="Current streak"
          value={
            core.currentStreakKind === 'none'
              ? 'No streak'
              : `${core.currentStreak}${streakIsWin ? 'W' : streakIsLoss ? 'L' : ''}`
          }
          tone={streakIsWin ? 'positive' : streakIsLoss ? 'negative' : 'neutral'}
          accent={streakIsWin ? 'green' : streakIsLoss ? 'red' : 'gray'}
          icon={
            streakIsWin ? (
              <Flame className="h-5 w-5" />
            ) : streakIsLoss ? (
              <Snowflake className="h-5 w-5" />
            ) : (
              <Award className="h-5 w-5" />
            )
          }
          hint={`Best ${core.maxConsecutiveWins}W Worst ${core.maxConsecutiveLosses}L`}
        />
      </section>
    ),
    scoreEquity: (
      <section key="scoreEquity" className="grid grid-cols-1 lg:grid-cols-12">
        <ChartCard
          title="IPTRADE Score"
          subtitle="Proprietary composite grade"
          className="lg:col-span-4 xl:col-span-3"
          bodyFlush
        >
          <IptradeScoreCard score={score} />
        </ChartCard>

        <ChartCard
          title="Equity curve"
          subtitle="Cumulative net P&L over time"
          className="lg:col-span-8 xl:col-span-9"
          action={
            <div className="flex items-center gap-1.5 text-xs">
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 font-medium',
                  core.netTotal >= 0
                    ? 'bg-green-100 text-green-700'
                    : 'bg-red-100 text-red-700'
                )}
              >
                {core.netTotal >= 0 ? (
                  <ArrowUpRight className="h-3 w-3" />
                ) : (
                  <ArrowDownRight className="h-3 w-3" />
                )}
                {formatPnlSigned(core.netTotal)}
              </span>
            </div>
          }
        >
          <EquityCurveChart points={equity} />
        </ChartCard>
      </section>
    ),
    winRateRatios: (
      <section key="winRateRatios" className="grid grid-cols-1 lg:grid-cols-12 bg-gray-100/60">
        <ChartCard
          title="Win rate"
          subtitle={`${core.totalTrades} closed trades${core.breakEven ? ` ${core.breakEven} BE` : ''}`}
          className="lg:col-span-3"
        >
          <div className="flex h-full flex-col items-center justify-center">
            <WinRateGauge winRate={core.winRate} wins={core.wins} losses={core.losses} />
          </div>
        </ChartCard>

        <ChartCard
          title="Key ratios"
          subtitle="Risk-adjusted performance"
          className="lg:col-span-9"
        >
          <div className="-mx-3 -mb-3 grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 border-t border-gray-200 [&>*:nth-last-child(-n+2)]:border-b-0 sm:[&>*:nth-last-child(-n+3)]:border-b-0 xl:[&>*:nth-last-child(-n+6)]:border-b-0 max-sm:[&>*:nth-child(2n)]:border-r-0 sm:max-xl:[&>*:nth-child(3n)]:border-r-0 xl:[&>*:nth-child(6n)]:border-r-0">
            <KpiCard
              label="Expectancy"
              value={formatPnlSigned(core.expectancy)}
              tone={expectancyTone}
              hint="per trade"
            />
            <KpiCard
              label="Avg W / L"
              value={formatRatio(core.avgWinLossRatio)}
              hint={`+${formatMoney(core.avgWin)} / -${formatMoney(core.avgLoss)}`}
            />
            <KpiCard
              label="Recovery"
              value={formatRatio(drawdown.recoveryFactor)}
              hint="Net / Max DD"
            />
            <KpiCard label="Sharpe" value={formatRatio(ratios.sharpe)} hint="annualized" />
            <KpiCard label="Sortino" value={formatRatio(ratios.sortino)} hint="annualized" />
            <KpiCard label="Calmar" value={formatRatio(ratios.calmar)} hint="annualized" />
            <KpiCard
              label="Day win rate"
              value={`${ratios.dayWinRate.toFixed(1)}%`}
              hint={`${ratios.positiveDays}+ / ${ratios.negativeDays}- (${ratios.totalDays}d)`}
            />
            <KpiCard
              label="Best trade"
              value={formatPnlSigned(core.bestTrade)}
              tone="positive"
            />
            <KpiCard
              label="Worst trade"
              value={formatPnlSigned(core.worstTrade)}
              tone="negative"
            />
            <KpiCard
              label="Best day"
              value={formatPnlSigned(ratios.bestDay)}
              tone="positive"
              hint={ratios.bestDayMs ? formatDate(ratios.bestDayMs) : undefined}
            />
            <KpiCard
              label="Worst day"
              value={formatPnlSigned(ratios.worstDay)}
              tone="negative"
              hint={ratios.worstDayMs ? formatDate(ratios.worstDayMs) : undefined}
            />
            <KpiCard
              label="Avg holding"
              value={formatHoldingTime(core.avgHoldingMs)}
              hint={`vol ${core.totalVolume.toFixed(2)}`}
            />
          </div>
        </ChartCard>
      </section>
    ),
    advanced: (
      <section key="advanced">
        <ChartCard
          title="Advanced metrics"
          subtitle="Edge, efficiency and statistical signal"
          className="bg-gray-100/60"
        >
          <div className="-mx-3 -mb-3 grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 border-t border-gray-200 [&>*:nth-last-child(-n+2)]:border-b-0 sm:[&>*:nth-last-child(-n+4)]:border-b-0 xl:[&>*:nth-last-child(-n+8)]:border-b-0 max-sm:[&>*:nth-child(2n)]:border-r-0 sm:max-xl:[&>*:nth-child(4n)]:border-r-0 xl:[&>*:nth-child(8n)]:border-r-0">
            <KpiCard
              label="Kelly %"
              value={`${core.kellyPercent.toFixed(1)}%`}
              tone={kellyTone}
              hint="optimal bet size"
            />
            <KpiCard
              label="SQN"
              value={formatRatio(core.sqn)}
              tone={sqnTone}
              hint={
                core.sqn >= 5
                  ? 'super system'
                  : core.sqn >= 2.5
                  ? 'excellent'
                  : core.sqn >= 1.7
                  ? 'good'
                  : core.sqn >= 1
                  ? 'average'
                  : 'below avg'
              }
            />
            <KpiCard label="Z-score" value={formatRatio(core.zScore)} hint={zScoreHint} />
            <KpiCard
              label="Stdev / trade"
              value={formatMoney(core.stdevTrade)}
              hint="risk per trade"
            />
            <KpiCard
              label="Profit / lot"
              value={formatPnlSigned(core.profitPerLot)}
              tone={profitPerLotTone}
              hint={`vol ${core.totalVolume.toFixed(2)}`}
            />
            <KpiCard
              label="Trades / day"
              value={ratios.avgTradesPerDay.toFixed(1)}
              hint={`${ratios.totalDays} active day${ratios.totalDays === 1 ? '' : 's'}`}
            />
            <KpiCard
              label="Winners / day"
              value={ratios.avgWinnersPerDay.toFixed(1)}
              tone="positive"
            />
            <KpiCard
              label="Losers / day"
              value={ratios.avgLosersPerDay.toFixed(1)}
              tone="negative"
            />
          </div>
        </ChartCard>
      </section>
    ),
    dailyPnl: (
      <section key="dailyPnl">
        <ChartCard
          title="Daily P&L"
          subtitle={`${daily.length} trading day${daily.length === 1 ? '' : 's'}`}
          action={
            <div className="hidden sm:flex items-center gap-3 text-[11px] text-gray-500">
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 bg-green-600" /> profit
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 bg-red-600" /> loss
              </span>
            </div>
          }
        >
          <DailyPnlBarsChart data={daily} height={220} />
        </ChartCard>
      </section>
    ),
    drawdownDistribution: (
      <section key="drawdownDistribution" className="grid grid-cols-1 lg:grid-cols-2 bg-gray-100/60">
        <ChartCard
          title="Drawdown"
          subtitle={
            drawdown.maxDrawdownDurationMs > 0
              ? `Max DD lasted ${formatHoldingTime(drawdown.maxDrawdownDurationMs)} ${formatDate(drawdown.maxDrawdownStartMs)} → ${formatDate(drawdown.maxDrawdownEndMs)}`
              : 'No drawdown in this range'
          }
          action={
            drawdown.maxDrawdown > 0 ? (
              <span className="text-xs font-semibold text-red-700">
                -{formatMoney(drawdown.maxDrawdown)}
              </span>
            ) : null
          }
        >
          <DrawdownChart points={equity} height={200} />
        </ChartCard>
        <ChartCard
          title="P&L distribution"
          subtitle="Per-trade histogram"
          action={
            <span className="text-[11px] text-gray-500 tabular-nums">
              {core.wins}W / {core.losses}L
            </span>
          }
        >
          <HistogramChart bins={histogram} height={200} />
        </ChartCard>
      </section>
    ),
    duration: (
      <section key="duration">
        <ChartCard
          title="Trade duration"
          subtitle="Net P&L by hold time bucket"
          action={
            <span className="text-[11px] text-gray-500">
              Avg hold {formatHoldingTime(core.avgHoldingMs)}
            </span>
          }
        >
          <DurationBarsChart data={durations} height={220} />
        </ChartCard>
      </section>
    ),
    timePatterns: (
      <section key="timePatterns" className="grid grid-cols-1 lg:grid-cols-2 bg-gray-100/60">
        <ChartCard title="By weekday" subtitle="Net P&L per day of week (open time)">
          <WeekdayBarsChart data={weekdays} height={180} />
        </ChartCard>
        <ChartCard title="By hour" subtitle="Net P&L per hour of day (open time)">
          <HourBarsChart data={hours} height={180} />
        </ChartCard>
      </section>
    ),
    heatmap: (
      <section key="heatmap">
        <ChartCard title="Activity heatmap" subtitle="Net P&L by weekday and hour">
          <HourDayHeatmap cells={hourDay} />
        </ChartCard>
      </section>
    ),
    longShortSymbols: (
      <section key="longShortSymbols" className="grid grid-cols-1 lg:grid-cols-12">
        <ChartCard
          title="Long vs Short"
          subtitle={`${core.totalTrades} total trades`}
          className="lg:col-span-4"
          bodyFlush
        >
          <LongShortPanel
            longTrades={core.longTrades}
            shortTrades={core.shortTrades}
            longNet={core.longNet}
            shortNet={core.shortNet}
            longWinRate={longWinRate}
            shortWinRate={shortWinRate}
            totalTrades={core.totalTrades}
          />
        </ChartCard>

        <ChartCard
          title="Top symbols"
          subtitle={`${symbols.length} symbol${symbols.length === 1 ? '' : 's'} traded Sorted by net P&L`}
          className="lg:col-span-8"
        >
          <SymbolBarsChart data={topSymbols} />
        </ChartCard>
      </section>
    ),
    bottomSymbols:
      symbols.length > 5 ? (
        <section key="bottomSymbols" className="grid grid-cols-1 lg:grid-cols-12 bg-gray-100/60">
          <ChartCard
            title="Bottom symbols"
            subtitle="Worst performers by net P&L"
            className="lg:col-span-8"
          >
            <SymbolBarsChart data={bottomSymbols} />
          </ChartCard>
          <ChartCard
            title="Volume distribution"
            subtitle="Trades by symbol"
            className="lg:col-span-4"
          >
            <DonutChart
              segments={symbolDistribution}
              centerLabel="symbols"
              centerValue={String(symbols.length)}
            />
          </ChartCard>
        </section>
      ) : null,
    periodHeatmap: (
      <section key="periodHeatmap">
        <ChartCard title="Daily activity" subtitle={periodSubtitle}>
          <PeriodHeatmap cells={periodCells} />
        </ChartCard>
      </section>
    ),
    costs: (
      <section key="costs" className="grid grid-cols-2 sm:grid-cols-4 bg-gray-100/60">
        <KpiCard label="Total commission" value={formatMoney(core.totalCommission)} />
        <KpiCard label="Total swap" value={formatMoney(core.totalSwap)} />
        <KpiCard
          label="Avg win hold"
          value={formatHoldingTime(core.avgWinHoldingMs)}
          tone="positive"
        />
        <KpiCard
          label="Avg loss hold"
          value={formatHoldingTime(core.avgLossHoldingMs)}
          tone="negative"
        />
      </section>
    ),
  };

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div ref={scrollContainerRef} className="flex-1 min-h-0 min-w-0 overflow-auto">
        <div>
          {layout.order.map((id) => (layout.visible[id] ? sections[id] : null))}
        </div>
      </div>
      {hasVerticalScroll && scrollMetrics && (
        <div className="flex shrink-0 flex-col py-2 px-2 bg-white border-gray-200">
          <ManualScrollbar
            orientation="vertical"
            value={scrollMetrics.scrollTop}
            viewportSize={scrollMetrics.clientHeight}
            contentSize={scrollMetrics.scrollHeight}
            onChange={handleVerticalScrollbarChange}
            className="flex-1 min-h-0"
          />
        </div>
      )}
    </div>
  );
}

function ScoreRow({ label, value }: { label: string; value: number }) {
  const tone = value >= 75 ? 'text-green-700' : value >= 50 ? 'text-amber-600' : 'text-red-600';
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={cn('tabular-nums font-semibold', tone)}>{value.toFixed(0)}</span>
    </div>
  );
}

interface LongShortPanelProps {
  longTrades: number;
  shortTrades: number;
  longNet: number;
  shortNet: number;
  longWinRate: number;
  shortWinRate: number;
  totalTrades: number;
}

function LongShortPanel({
  longTrades,
  shortTrades,
  longNet,
  shortNet,
  longWinRate,
  shortWinRate,
  totalTrades,
}: LongShortPanelProps) {
  const longPct = totalTrades > 0 ? (longTrades / totalTrades) * 100 : 0;
  const shortPct = totalTrades > 0 ? (shortTrades / totalTrades) * 100 : 0;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center px-3 pb-3 pt-1">
        <LongShortGauge longPct={longPct} shortPct={shortPct} totalTrades={totalTrades} />
      </div>
      <div className="mt-auto grid grid-cols-2 border-t border-gray-200">
        <SideTile
          label="Long"
          trades={longTrades}
          sharePct={longPct}
          net={longNet}
          winRate={longWinRate}
          tone="positive"
          className="border-r border-gray-200"
        />
        <SideTile
          label="Short"
          trades={shortTrades}
          sharePct={shortPct}
          net={shortNet}
          winRate={shortWinRate}
          tone="negative"
        />
      </div>
    </div>
  );
}

function LongShortGauge({
  longPct,
  shortPct,
  totalTrades,
}: {
  longPct: number;
  shortPct: number;
  totalTrades: number;
}) {
  const W = 140;
  const H = 140;
  const cx = W / 2;
  const cy = H / 2;
  const r = 56;
  const stroke = 12;
  const circumference = 2 * Math.PI * r;
  const longRatio = Math.max(0, Math.min(1, longPct / 100));
  const shortRatio = Math.max(0, Math.min(1, shortPct / 100));
  const longLen = circumference * longRatio;
  const shortLen = circumference * shortRatio;
  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#ffffff" strokeWidth={stroke} />
        {longLen > 0 && (
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="#16a34a"
            strokeWidth={stroke}
            strokeLinecap="butt"
            strokeDasharray={`${longLen} ${circumference}`}
            strokeDashoffset={0}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        )}
        {shortLen > 0 && (
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="#dc2626"
            strokeWidth={stroke}
            strokeLinecap="butt"
            strokeDasharray={`${shortLen} ${circumference}`}
            strokeDashoffset={-longLen}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        )}
        <text x={cx} y={cy + 2} textAnchor="middle" fontSize={22} fontWeight={700} fill="#111827">
          {totalTrades}
        </text>
        <text x={cx} y={cy + 20} textAnchor="middle" fontSize={9} fill="#6b7280">
          trades
        </text>
      </svg>
      <div className="mt-1 text-[11px] text-gray-500 tabular-nums">
        <span className="text-green-600 font-medium">{longPct.toFixed(0)}%L</span>
        {' '}
        <span className="text-red-600 font-medium">{shortPct.toFixed(0)}%S</span>
      </div>
    </div>
  );
}

function SideTile({
  label,
  trades,
  sharePct,
  net,
  winRate,
  tone,
  className,
}: {
  label: string;
  trades: number;
  sharePct: number;
  net: number;
  winRate: number;
  tone: 'positive' | 'negative';
  className?: string;
}) {
  const positive = tone === 'positive';
  const labelClass = positive ? 'text-green-700' : 'text-red-700';
  const Arrow = positive ? ArrowUpRight : ArrowDownRight;
  const netClass = net > 0 ? 'text-green-700' : net < 0 ? 'text-red-700' : 'text-gray-700';
  const wrBarColor =
    winRate >= 60 ? 'bg-green-500' : winRate >= 45 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div
      className={cn(
        'p-3 flex flex-col gap-1.5',
        positive ? 'bg-green-50/40' : 'bg-red-50/40',
        className
      )}
    >
      <div className="flex items-center justify-between">
        <span className={cn('inline-flex items-center gap-1 text-[11px] font-semibold', labelClass)}>
          <Arrow className="h-3 w-3" />
          {label}
        </span>
        <span className="text-[10px] text-gray-500 tabular-nums">
          {trades}t {sharePct.toFixed(0)}%
        </span>
      </div>
      <div className={cn('text-base font-bold tabular-nums leading-none', netClass)}>
        {formatPnlSigned(net)}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="relative h-1 flex-1 overflow-hidden bg-gray-200/70">
          <div className={cn('absolute inset-y-0 left-0', wrBarColor)} style={{ width: `${Math.max(0, Math.min(100, winRate))}%` }} />
        </div>
        <span className="text-[10px] font-medium text-gray-600 tabular-nums">
          {winRate.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}
