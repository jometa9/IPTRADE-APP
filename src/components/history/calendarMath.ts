import type { HistoryDeal } from '@/api';

export type Granularity = 'month' | 'quarter' | 'year';

export const WEEK_DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const QUARTER_WEEK_COLS = 5;
export const MONTH_LABELS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface DayAgg {
  pnl: number;
  count: number;
}

export interface DayCell {
  date: Date;
  inMonth: boolean;
  pnl: number;
  dealCount: number;
  hasDeals: boolean;
  isFuture: boolean;
}

export interface WeekRow {
  startDate: Date;
  endDate: Date;
  days: DayCell[];
  weekTotal: number;
  weekTradeCount: number;
}

export interface CalendarFilter {
  fromMs: number | null;
  toMs: number | null;
}

export interface CalendarStats {
  pnl: number;
  daysTraded: number;
  totalTrades: number;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function quarterIndex(d: Date): number {
  return Math.floor(d.getMonth() / 3);
}

export function startOfQuarter(d: Date): Date {
  return new Date(d.getFullYear(), quarterIndex(d) * 3, 1);
}

export function endOfQuarter(d: Date): Date {
  const startMonth = quarterIndex(d) * 3;
  return new Date(d.getFullYear(), startMonth + 3, 0, 23, 59, 59, 999);
}

export function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1);
}

export function endOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 12, 0, 23, 59, 59, 999);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function startOfWeekSunday(d: Date): Date {
  const day = d.getDay();
  const r = new Date(d);
  r.setDate(d.getDate() - day);
  return startOfDay(r);
}

export function endOfWeekSunday(d: Date): Date {
  const start = startOfWeekSunday(d);
  const r = new Date(start);
  r.setDate(start.getDate() + 6);
  return endOfDay(r);
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function dealCloseDate(d: HistoryDeal): Date | null {
  const ts = d.close_time_ms > 0 ? d.close_time_ms : d.open_time_ms;
  if (!ts) return null;
  return new Date(ts);
}

export function buildDealsByDay(deals: HistoryDeal[]): Map<string, DayAgg> {
  const map = new Map<string, DayAgg>();
  for (const d of deals) {
    const dt = dealCloseDate(d);
    if (!dt) continue;
    const k = dateKey(dt);
    const existing = map.get(k);
    if (existing) {
      existing.pnl += d.net_profit;
      existing.count += 1;
    } else {
      map.set(k, { pnl: d.net_profit, count: 1 });
    }
  }
  return map;
}

const EPS = 0.005;

export interface ExtendedAgg {
  pnl: number;
  count: number;
  wins: number;
  losses: number;
  bestPnl: number;
  worstPnl: number;
  volume: number;
}

function emptyExtAgg(): ExtendedAgg {
  return {
    pnl: 0,
    count: 0,
    wins: 0,
    losses: 0,
    bestPnl: -Infinity,
    worstPnl: Infinity,
    volume: 0,
  };
}

function applyDealToExt(agg: ExtendedAgg, deal: HistoryDeal): void {
  const net = deal.net_profit;
  agg.pnl += net;
  agg.count += 1;
  agg.volume += deal.volume;
  if (net > EPS) agg.wins += 1;
  else if (net < -EPS) agg.losses += 1;
  if (net > agg.bestPnl) agg.bestPnl = net;
  if (net < agg.worstPnl) agg.worstPnl = net;
}

export function finalizeExt(agg: ExtendedAgg): ExtendedAgg {
  return {
    ...agg,
    bestPnl: agg.bestPnl === -Infinity ? 0 : agg.bestPnl,
    worstPnl: agg.worstPnl === Infinity ? 0 : agg.worstPnl,
  };
}

export function buildExtendedByDay(deals: HistoryDeal[]): Map<string, ExtendedAgg> {
  const map = new Map<string, ExtendedAgg>();
  for (const d of deals) {
    const dt = dealCloseDate(d);
    if (!dt) continue;
    const k = dateKey(dt);
    let agg = map.get(k);
    if (!agg) {
      agg = emptyExtAgg();
      map.set(k, agg);
    }
    applyDealToExt(agg, d);
  }
  for (const [k, v] of map) map.set(k, finalizeExt(v));
  return map;
}

export function buildExtendedByMonth(deals: HistoryDeal[]): Map<string, ExtendedAgg> {
  const map = new Map<string, ExtendedAgg>();
  for (const d of deals) {
    const dt = dealCloseDate(d);
    if (!dt) continue;
    const k = monthKey(dt);
    let agg = map.get(k);
    if (!agg) {
      agg = emptyExtAgg();
      map.set(k, agg);
    }
    applyDealToExt(agg, d);
  }
  for (const [k, v] of map) map.set(k, finalizeExt(v));
  return map;
}

export function sumExtendedRange(
  byDay: Map<string, ExtendedAgg>,
  fromDate: Date,
  toDate: Date
): ExtendedAgg {
  const agg = emptyExtAgg();
  const cursor = startOfDay(fromDate);
  const end = startOfDay(toDate).getTime();
  while (cursor.getTime() <= end) {
    const day = byDay.get(dateKey(cursor));
    if (day) {
      agg.pnl += day.pnl;
      agg.count += day.count;
      agg.wins += day.wins;
      agg.losses += day.losses;
      agg.volume += day.volume;
      if (day.count > 0) {
        if (day.bestPnl > agg.bestPnl) agg.bestPnl = day.bestPnl;
        if (day.worstPnl < agg.worstPnl) agg.worstPnl = day.worstPnl;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return finalizeExt(agg);
}

export function sumExtendedDates(
  byDay: Map<string, ExtendedAgg>,
  dates: Date[]
): ExtendedAgg {
  const agg = emptyExtAgg();
  for (const date of dates) {
    const day = byDay.get(dateKey(date));
    if (!day) continue;
    agg.pnl += day.pnl;
    agg.count += day.count;
    agg.wins += day.wins;
    agg.losses += day.losses;
    agg.volume += day.volume;
    if (day.count > 0) {
      if (day.bestPnl > agg.bestPnl) agg.bestPnl = day.bestPnl;
      if (day.worstPnl < agg.worstPnl) agg.worstPnl = day.worstPnl;
    }
  }
  return finalizeExt(agg);
}

export function computeAnchorDay(filter: CalendarFilter, today: Date): Date {
  const todayStart = startOfDay(today);
  if (filter.toMs == null) return todayStart;
  const toDay = startOfDay(new Date(filter.toMs));
  return toDay.getTime() > todayStart.getTime() ? todayStart : toDay;
}

export function buildCalendarRows(
  currentMonth: Date,
  today: Date,
  dealsByDay: Map<string, DayAgg>
): WeekRow[] {
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const gridStart = startOfWeekSunday(monthStart);
  const todayStart = startOfDay(today);
  const rows: WeekRow[] = [];

  let weekStart = gridStart;
  while (weekStart.getTime() <= monthEnd.getTime()) {
    const days: DayCell[] = [];
    let weekTotal = 0;
    let weekTradeCount = 0;

    for (let j = 0; j < 7; j++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + j);
      const inMonth =
        d.getMonth() === currentMonth.getMonth() &&
        d.getFullYear() === currentMonth.getFullYear();
      const key = dateKey(d);
      const agg = dealsByDay.get(key);
      const pnl = agg?.pnl ?? 0;
      const dealCount = agg?.count ?? 0;
      const isFuture = d.getTime() > todayStart.getTime();
      days.push({
        date: d,
        inMonth,
        pnl,
        dealCount,
        hasDeals: dealCount > 0,
        isFuture,
      });

      if (inMonth) {
        weekTotal += pnl;
        weekTradeCount += dealCount;
      }
    }

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    rows.push({
      startDate: startOfDay(weekStart),
      endDate: endOfDay(weekEnd),
      days,
      weekTotal,
      weekTradeCount,
    });

    const next = new Date(weekStart);
    next.setDate(weekStart.getDate() + 7);
    weekStart = next;
  }
  return rows;
}

export function computeMonthStats(rows: WeekRow[]): CalendarStats {
  let pnl = 0;
  let daysTraded = 0;
  let totalTrades = 0;
  for (const row of rows) {
    for (const day of row.days) {
      if (!day.inMonth) continue;
      pnl += day.pnl;
      if (day.hasDeals) {
        daysTraded += 1;
        totalTrades += day.dealCount;
      }
    }
  }
  return { pnl, daysTraded, totalTrades };
}

export interface CalendarDerived {
  anchorDay: Date;
  currentMonth: Date;
  isCurrentMonth: boolean;
  rows: WeekRow[];
  stats: CalendarStats;
  monthLabel: string;
}

export function deriveCalendarState(
  filter: CalendarFilter,
  today: Date,
  dealsByDay: Map<string, DayAgg>
): CalendarDerived {
  const anchorDay = computeAnchorDay(filter, today);
  const currentMonth = startOfMonth(anchorDay);
  const isCurrentMonth =
    currentMonth.getFullYear() === today.getFullYear() &&
    currentMonth.getMonth() === today.getMonth();
  const rows = buildCalendarRows(currentMonth, today, dealsByDay);
  const stats = computeMonthStats(rows);
  const monthLabel = currentMonth.toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });
  return { anchorDay, currentMonth, isCurrentMonth, rows, stats, monthLabel };
}

export interface WeekCell {
  startDate: Date;
  endDate: Date;
  inMonth: boolean;
  pnl: number;
  dealCount: number;
  hasDeals: boolean;
  isFuture: boolean;
}

export interface MonthRow {
  monthDate: Date;
  monthLabel: string;
  weeks: (WeekCell | null)[];
  monthTotal: number;
  monthTradeCount: number;
  inQuarter: boolean;
}

export interface QuarterDerived {
  currentQuarter: Date;
  isCurrentQuarter: boolean;
  rows: MonthRow[];
  stats: CalendarStats;
  quarterLabel: string;
}

function buildMonthWeekCells(
  monthDate: Date,
  today: Date,
  dealsByDay: Map<string, DayAgg>
): WeekCell[] {
  const monthStart = startOfMonth(monthDate);
  const monthEnd = endOfMonth(monthDate);
  const todayStart = startOfDay(today);
  const cells: WeekCell[] = [];

  let weekStart = startOfWeekSunday(monthStart);
  if (weekStart.getMonth() !== monthStart.getMonth() || weekStart.getFullYear() !== monthStart.getFullYear()) {
    weekStart = new Date(weekStart);
    weekStart.setDate(weekStart.getDate() + 7);
  }

  while (weekStart.getTime() <= monthEnd.getTime()) {
    const rawWeekEnd = new Date(weekStart);
    rawWeekEnd.setDate(weekStart.getDate() + 6);
    const clippedEnd = rawWeekEnd.getTime() > monthEnd.getTime()
      ? new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate())
      : rawWeekEnd;
    let pnl = 0;
    let dealCount = 0;
    const cursor = new Date(weekStart);
    while (cursor.getTime() <= clippedEnd.getTime()) {
      const agg = dealsByDay.get(dateKey(cursor));
      if (agg) {
        pnl += agg.pnl;
        dealCount += agg.count;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    cells.push({
      startDate: startOfDay(weekStart),
      endDate: endOfDay(clippedEnd),
      inMonth: true,
      pnl,
      dealCount,
      hasDeals: dealCount > 0,
      isFuture: startOfDay(weekStart).getTime() > todayStart.getTime(),
    });
    const next = new Date(weekStart);
    next.setDate(weekStart.getDate() + 7);
    weekStart = next;
  }

  return cells;
}

export function buildQuarterRows(
  quarterStart: Date,
  today: Date,
  dealsByDay: Map<string, DayAgg>
): MonthRow[] {
  const rows: MonthRow[] = [];
  for (let i = 0; i < 3; i++) {
    const monthDate = new Date(quarterStart.getFullYear(), quarterStart.getMonth() + i, 1);
    const cells = buildMonthWeekCells(monthDate, today, dealsByDay);
    const padded: (WeekCell | null)[] = [...cells];
    while (padded.length < QUARTER_WEEK_COLS) padded.push(null);
    let monthTotal = 0;
    let monthTradeCount = 0;
    for (const c of cells) {
      monthTotal += c.pnl;
      monthTradeCount += c.dealCount;
    }
    rows.push({
      monthDate,
      monthLabel: monthDate.toLocaleDateString(undefined, { month: 'long' }),
      weeks: padded,
      monthTotal,
      monthTradeCount,
      inQuarter: true,
    });
  }
  return rows;
}

export function deriveQuarterState(
  filter: CalendarFilter,
  today: Date,
  dealsByDay: Map<string, DayAgg>
): QuarterDerived {
  const todayStart = startOfDay(today);
  let anchor: Date;
  if (filter.toMs != null) {
    const toDay = new Date(filter.toMs);
    anchor = toDay.getTime() > todayStart.getTime() ? todayStart : toDay;
  } else {
    anchor = today;
  }
  const currentQuarter = startOfQuarter(anchor);
  const todayQuarter = startOfQuarter(today);
  const isCurrentQuarter = currentQuarter.getTime() === todayQuarter.getTime();
  const rows = buildQuarterRows(currentQuarter, today, dealsByDay);

  let pnl = 0;
  let totalTrades = 0;
  let daysTraded = 0;
  const qEnd = endOfQuarter(currentQuarter).getTime();
  const cursor = new Date(currentQuarter);
  while (cursor.getTime() <= qEnd) {
    const agg = dealsByDay.get(dateKey(cursor));
    if (agg) {
      pnl += agg.pnl;
      totalTrades += agg.count;
      if (agg.count > 0) daysTraded += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  const qIdx = quarterIndex(currentQuarter) + 1;
  const quarterLabel = `Q${qIdx} ${currentQuarter.getFullYear()}`;
  return {
    currentQuarter,
    isCurrentQuarter,
    rows,
    stats: { pnl, daysTraded, totalTrades },
    quarterLabel,
  };
}

export interface MonthCell {
  monthDate: Date;
  monthLabel: string;
  pnl: number;
  dealCount: number;
  hasDeals: boolean;
  isFuture: boolean;
}

export interface QuarterRow {
  quarterStart: Date;
  quarterLabel: string;
  months: MonthCell[];
  quarterTotal: number;
  quarterTradeCount: number;
}

export interface YearDerived {
  currentYear: Date;
  isCurrentYear: boolean;
  rows: QuarterRow[];
  stats: CalendarStats;
  yearLabel: string;
}

export function buildDealsByMonth(deals: HistoryDeal[]): Map<string, DayAgg> {
  const map = new Map<string, DayAgg>();
  for (const d of deals) {
    const dt = dealCloseDate(d);
    if (!dt) continue;
    const k = `${dt.getFullYear()}-${dt.getMonth() + 1}`;
    const existing = map.get(k);
    if (existing) {
      existing.pnl += d.net_profit;
      existing.count += 1;
    } else {
      map.set(k, { pnl: d.net_profit, count: 1 });
    }
  }
  return map;
}

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

export function buildYearRows(
  yearStart: Date,
  today: Date,
  dealsByMonth: Map<string, DayAgg>
): QuarterRow[] {
  const rows: QuarterRow[] = [];
  const todayMonthStart = startOfMonth(today).getTime();

  for (let q = 0; q < 4; q++) {
    const months: MonthCell[] = [];
    let qTotal = 0;
    let qTradeCount = 0;
    for (let m = 0; m < 3; m++) {
      const monthDate = new Date(yearStart.getFullYear(), q * 3 + m, 1);
      const agg = dealsByMonth.get(monthKey(monthDate));
      const pnl = agg?.pnl ?? 0;
      const dealCount = agg?.count ?? 0;
      const isFuture = monthDate.getTime() > todayMonthStart;
      months.push({
        monthDate,
        monthLabel: MONTH_LABELS_SHORT[monthDate.getMonth()],
        pnl,
        dealCount,
        hasDeals: dealCount > 0,
        isFuture,
      });
      qTotal += pnl;
      qTradeCount += dealCount;
    }
    const quarterStart = new Date(yearStart.getFullYear(), q * 3, 1);
    rows.push({
      quarterStart,
      quarterLabel: `Q${q + 1}`,
      months,
      quarterTotal: qTotal,
      quarterTradeCount: qTradeCount,
    });
  }
  return rows;
}

export function deriveYearState(
  filter: CalendarFilter,
  today: Date,
  dealsByDay: Map<string, DayAgg>,
  dealsByMonth: Map<string, DayAgg>
): YearDerived {
  const todayStart = startOfDay(today);
  let anchor: Date;
  if (filter.toMs != null) {
    const toDay = new Date(filter.toMs);
    anchor = toDay.getTime() > todayStart.getTime() ? todayStart : toDay;
  } else {
    anchor = today;
  }
  const currentYear = startOfYear(anchor);
  const isCurrentYear = currentYear.getFullYear() === today.getFullYear();
  const rows = buildYearRows(currentYear, today, dealsByMonth);

  let pnl = 0;
  let totalTrades = 0;
  let daysTraded = 0;
  const yStart = currentYear.getTime();
  const yEnd = endOfYear(currentYear).getTime();
  const cursor = new Date(currentYear);
  while (cursor.getTime() <= yEnd) {
    const t = cursor.getTime();
    if (t >= yStart) {
      const agg = dealsByDay.get(dateKey(cursor));
      if (agg) {
        pnl += agg.pnl;
        totalTrades += agg.count;
        if (agg.count > 0) daysTraded += 1;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    currentYear,
    isCurrentYear,
    rows,
    stats: { pnl, daysTraded, totalTrades },
    yearLabel: String(currentYear.getFullYear()),
  };
}

export function formatCompactNumber(value: number, signed = false): string {
  if (Math.abs(value) < 0.5) return '0';
  const sign = value > 0 ? (signed ? '+' : '') : '-';
  const abs = Math.abs(value);
  const compact = (n: number, suffix: string): string => {
    const fixed = n.toFixed(1);
    const trimmed = fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
    return `${trimmed}${suffix}`;
  };
  if (abs >= 1_000_000_000) return `${sign}${compact(abs / 1_000_000_000, 'B')}`;
  if (abs >= 1_000_000) return `${sign}${compact(abs / 1_000_000, 'M')}`;
  if (abs >= 1_000) return `${sign}${compact(abs / 1_000, 'K')}`;
  return `${sign}${Math.round(abs)}`;
}
