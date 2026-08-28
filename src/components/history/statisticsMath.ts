import type { HistoryDeal } from '@/api';

const EPS = 0.005;

export interface CoreStats {
  netTotal: number;
  grossProfit: number;
  grossLoss: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  avgWinLossRatio: number;
  profitFactor: number;
  expectancy: number;
  bestTrade: number;
  worstTrade: number;
  totalCommission: number;
  totalSwap: number;
  avgHoldingMs: number;
  avgWinHoldingMs: number;
  avgLossHoldingMs: number;
  totalVolume: number;
  longTrades: number;
  shortTrades: number;
  longWins: number;
  shortWins: number;
  longNet: number;
  shortNet: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  currentStreak: number;
  currentStreakKind: 'win' | 'loss' | 'none';
  profitPerLot: number;
  kellyPercent: number;
  stdevTrade: number;
  sqn: number;
  zScore: number;
}

export function computeCoreStats(deals: HistoryDeal[]): CoreStats {
  let netTotal = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let breakEven = 0;
  let bestTrade = -Infinity;
  let worstTrade = Infinity;
  let totalCommission = 0;
  let totalSwap = 0;
  let totalVolume = 0;
  let holdingMsSum = 0;
  let holdingMsCount = 0;
  let winHoldSum = 0;
  let winHoldCount = 0;
  let lossHoldSum = 0;
  let lossHoldCount = 0;
  let longTrades = 0;
  let shortTrades = 0;
  let longWins = 0;
  let shortWins = 0;
  let longNet = 0;
  let shortNet = 0;

  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let curWinRun = 0;
  let curLossRun = 0;
  let lastKind: 'win' | 'loss' | 'none' = 'none';
  let prevWinLossKind: 'win' | 'loss' | 'none' = 'none';
  let runs = 0;

  const sorted = [...deals].sort((a, b) => closeOrOpenMs(a) - closeOrOpenMs(b));

  for (const d of sorted) {
    const net = d.net_profit;
    netTotal += net;
    totalCommission += d.commission;
    totalSwap += d.swap;
    totalVolume += d.volume;

    const isLong = d.side === 'buy';
    const isShort = d.side === 'sell';
    if (isLong) {
      longTrades += 1;
      longNet += net;
    } else if (isShort) {
      shortTrades += 1;
      shortNet += net;
    }

    if (net > EPS) {
      wins += 1;
      grossProfit += net;
      curWinRun += 1;
      curLossRun = 0;
      if (curWinRun > maxConsecutiveWins) maxConsecutiveWins = curWinRun;
      lastKind = 'win';
      if (prevWinLossKind !== 'win') runs += 1;
      prevWinLossKind = 'win';
      if (isLong) longWins += 1;
      if (isShort) shortWins += 1;
    } else if (net < -EPS) {
      losses += 1;
      grossLoss += Math.abs(net);
      curLossRun += 1;
      curWinRun = 0;
      if (curLossRun > maxConsecutiveLosses) maxConsecutiveLosses = curLossRun;
      lastKind = 'loss';
      if (prevWinLossKind !== 'loss') runs += 1;
      prevWinLossKind = 'loss';
    } else {
      breakEven += 1;
    }

    if (net > bestTrade) bestTrade = net;
    if (net < worstTrade) worstTrade = net;

    const hold = d.close_time_ms - d.open_time_ms;
    if (hold > 0) {
      holdingMsSum += hold;
      holdingMsCount += 1;
      if (net > EPS) {
        winHoldSum += hold;
        winHoldCount += 1;
      } else if (net < -EPS) {
        lossHoldSum += hold;
        lossHoldCount += 1;
      }
    }
  }

  const totalTrades = sorted.length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const expectancy = totalTrades > 0 ? netTotal / totalTrades : 0;
  const avgHoldingMs = holdingMsCount > 0 ? holdingMsSum / holdingMsCount : 0;
  const avgWinHoldingMs = winHoldCount > 0 ? winHoldSum / winHoldCount : 0;
  const avgLossHoldingMs = lossHoldCount > 0 ? lossHoldSum / lossHoldCount : 0;

  const currentStreak = lastKind === 'win' ? curWinRun : lastKind === 'loss' ? curLossRun : 0;

  const profitPerLot = totalVolume > EPS ? netTotal / totalVolume : 0;

  const p = winRate / 100;
  let kellyPercent = 0;
  if (avgLoss > EPS) {
    const b = avgWin / avgLoss;
    kellyPercent = (p - (1 - p) / b) * 100;
  } else if (avgWin > EPS) {
    kellyPercent = winRate;
  }
  if (!Number.isFinite(kellyPercent)) kellyPercent = 0;
  if (kellyPercent > 100) kellyPercent = 100;
  if (kellyPercent < -100) kellyPercent = -100;

  let stdevTrade = 0;
  let sqn = 0;
  if (totalTrades > 1) {
    let varSum = 0;
    for (const d of sorted) {
      const diff = d.net_profit - expectancy;
      varSum += diff * diff;
    }
    stdevTrade = Math.sqrt(varSum / (totalTrades - 1));
    if (stdevTrade > EPS) {
      sqn = (Math.sqrt(totalTrades) * expectancy) / stdevTrade;
    }
  }

  let zScore = 0;
  const decided = wins + losses;
  if (decided >= 2 && wins > 0 && losses > 0) {
    const N = decided;
    const W = wins;
    const L = losses;
    const x = 2 * W * L;
    const denominator = (x * (x - N)) / (N - 1);
    if (denominator > 0) {
      zScore = (N * (runs - 0.5) - x) / Math.sqrt(denominator);
    }
  }

  return {
    netTotal,
    grossProfit,
    grossLoss,
    totalTrades,
    wins,
    losses,
    breakEven,
    winRate,
    avgWin,
    avgLoss,
    avgWinLossRatio,
    profitFactor,
    expectancy,
    bestTrade: bestTrade === -Infinity ? 0 : bestTrade,
    worstTrade: worstTrade === Infinity ? 0 : worstTrade,
    totalCommission,
    totalSwap,
    avgHoldingMs,
    avgWinHoldingMs,
    avgLossHoldingMs,
    totalVolume,
    longTrades,
    shortTrades,
    longWins,
    shortWins,
    longNet,
    shortNet,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    currentStreak,
    currentStreakKind: lastKind,
    profitPerLot,
    kellyPercent,
    stdevTrade,
    sqn,
    zScore,
  };
}

export function closeOrOpenMs(d: HistoryDeal): number {
  return d.close_time_ms > 0 ? d.close_time_ms : d.open_time_ms;
}

export interface EquityPoint {
  timeMs: number;
  cumulative: number;
  drawdown: number;
}

export function computeEquityCurve(deals: HistoryDeal[]): EquityPoint[] {
  const sorted = [...deals].sort((a, b) => closeOrOpenMs(a) - closeOrOpenMs(b));
  if (sorted.length === 0) return [];
  const first = sorted[0];
  const firstClose = closeOrOpenMs(first);
  const baselineMs = first.open_time_ms > 0 && first.open_time_ms < firstClose
    ? first.open_time_ms
    : firstClose - 1;
  const out: EquityPoint[] = [{ timeMs: baselineMs, cumulative: 0, drawdown: 0 }];
  let cum = 0;
  let peak = 0;
  for (const d of sorted) {
    cum += d.net_profit;
    if (cum > peak) peak = cum;
    out.push({ timeMs: closeOrOpenMs(d), cumulative: cum, drawdown: cum - peak });
  }
  return out;
}

export interface DrawdownStats {
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxDrawdownStartMs: number;
  maxDrawdownEndMs: number;
  maxDrawdownDurationMs: number;
  avgDrawdown: number;
  recoveryFactor: number;
}

export function computeDrawdownStats(equity: EquityPoint[], netTotal: number): DrawdownStats {
  if (equity.length === 0) {
    return {
      maxDrawdown: 0,
      maxDrawdownPct: 0,
      maxDrawdownStartMs: 0,
      maxDrawdownEndMs: 0,
      maxDrawdownDurationMs: 0,
      avgDrawdown: 0,
      recoveryFactor: 0,
    };
  }
  let peak = 0;
  let peakTime = equity[0].timeMs;
  let maxDD = 0;
  let maxDDPeakValue = 0;
  let maxDDStart = equity[0].timeMs;
  let maxDDEnd = equity[0].timeMs;
  let drawdownSum = 0;
  let drawdownCount = 0;
  for (const p of equity) {
    if (p.cumulative > peak) {
      peak = p.cumulative;
      peakTime = p.timeMs;
    }
    const dd = p.cumulative - peak;
    if (dd < 0) {
      drawdownSum += Math.abs(dd);
      drawdownCount += 1;
    }
    if (dd < maxDD) {
      maxDD = dd;
      maxDDPeakValue = peak;
      maxDDStart = peakTime;
      maxDDEnd = p.timeMs;
    }
  }
  const maxDrawdown = Math.abs(maxDD);
  const maxDrawdownPct =
    Math.abs(maxDDPeakValue) > EPS ? (maxDrawdown / Math.abs(maxDDPeakValue)) * 100 : 0;
  const avgDrawdown = drawdownCount > 0 ? drawdownSum / drawdownCount : 0;
  const recoveryFactor = maxDrawdown > EPS ? netTotal / maxDrawdown : netTotal > 0 ? Infinity : 0;
  return {
    maxDrawdown,
    maxDrawdownPct,
    maxDrawdownStartMs: maxDDStart,
    maxDrawdownEndMs: maxDDEnd,
    maxDrawdownDurationMs: Math.max(0, maxDDEnd - maxDDStart),
    avgDrawdown,
    recoveryFactor,
  };
}

export interface DailyBucket {
  dayKey: string;
  dayMs: number;
  net: number;
  trades: number;
}

function dayKeyFromMs(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dayStartMsFromMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function computeDailyBuckets(deals: HistoryDeal[]): DailyBucket[] {
  const map = new Map<string, DailyBucket>();
  for (const d of deals) {
    const t = closeOrOpenMs(d);
    const key = dayKeyFromMs(t);
    let entry = map.get(key);
    if (!entry) {
      entry = { dayKey: key, dayMs: dayStartMsFromMs(t), net: 0, trades: 0 };
      map.set(key, entry);
    }
    entry.net += d.net_profit;
    entry.trades += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.dayMs - b.dayMs);
}

export interface RatioStats {
  sharpe: number;
  sortino: number;
  calmar: number;
  positiveDays: number;
  negativeDays: number;
  totalDays: number;
  dayWinRate: number;
  bestDay: number;
  bestDayMs: number;
  worstDay: number;
  worstDayMs: number;
  avgDailyPnl: number;
  stdevDaily: number;
  avgTradesPerDay: number;
  avgWinnersPerDay: number;
  avgLosersPerDay: number;
}

export function computeRatioStats(
  daily: DailyBucket[],
  maxDrawdown: number,
  core?: { wins: number; losses: number; totalTrades: number }
): RatioStats {
  if (daily.length === 0) {
    return {
      sharpe: 0,
      sortino: 0,
      calmar: 0,
      positiveDays: 0,
      negativeDays: 0,
      totalDays: 0,
      dayWinRate: 0,
      bestDay: 0,
      bestDayMs: 0,
      worstDay: 0,
      worstDayMs: 0,
      avgDailyPnl: 0,
      stdevDaily: 0,
      avgTradesPerDay: 0,
      avgWinnersPerDay: 0,
      avgLosersPerDay: 0,
    };
  }
  let sum = 0;
  let positiveDays = 0;
  let negativeDays = 0;
  let bestDay = -Infinity;
  let bestDayMs = 0;
  let worstDay = Infinity;
  let worstDayMs = 0;
  for (const d of daily) {
    sum += d.net;
    if (d.net > EPS) positiveDays += 1;
    else if (d.net < -EPS) negativeDays += 1;
    if (d.net > bestDay) {
      bestDay = d.net;
      bestDayMs = d.dayMs;
    }
    if (d.net < worstDay) {
      worstDay = d.net;
      worstDayMs = d.dayMs;
    }
  }
  const avgDailyPnl = sum / daily.length;
  let varSum = 0;
  let downsideVarSum = 0;
  let downsideCount = 0;
  for (const d of daily) {
    const diff = d.net - avgDailyPnl;
    varSum += diff * diff;
    if (d.net < 0) {
      downsideVarSum += d.net * d.net;
      downsideCount += 1;
    }
  }
  const stdev = Math.sqrt(varSum / daily.length);
  const downsideStdev = downsideCount > 0 ? Math.sqrt(downsideVarSum / downsideCount) : 0;
  const sharpe = stdev > EPS ? (avgDailyPnl / stdev) * Math.sqrt(252) : 0;
  const sortino = downsideStdev > EPS ? (avgDailyPnl / downsideStdev) * Math.sqrt(252) : 0;
  const annualReturn = avgDailyPnl * 252;
  const calmar = maxDrawdown > EPS ? annualReturn / maxDrawdown : 0;
  const avgTradesPerDay = core ? core.totalTrades / daily.length : 0;
  const avgWinnersPerDay = core ? core.wins / daily.length : 0;
  const avgLosersPerDay = core ? core.losses / daily.length : 0;

  return {
    sharpe,
    sortino,
    calmar,
    positiveDays,
    negativeDays,
    totalDays: daily.length,
    dayWinRate: daily.length > 0 ? (positiveDays / daily.length) * 100 : 0,
    bestDay: bestDay === -Infinity ? 0 : bestDay,
    bestDayMs,
    worstDay: worstDay === Infinity ? 0 : worstDay,
    worstDayMs,
    avgDailyPnl,
    stdevDaily: stdev,
    avgTradesPerDay,
    avgWinnersPerDay,
    avgLosersPerDay,
  };
}

export interface SymbolBucket {
  symbol: string;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  volume: number;
}

export function computeSymbolBuckets(deals: HistoryDeal[]): SymbolBucket[] {
  const map = new Map<string, SymbolBucket>();
  for (const d of deals) {
    let entry = map.get(d.symbol);
    if (!entry) {
      entry = { symbol: d.symbol, net: 0, trades: 0, wins: 0, losses: 0, winRate: 0, volume: 0 };
      map.set(d.symbol, entry);
    }
    entry.net += d.net_profit;
    entry.trades += 1;
    entry.volume += d.volume;
    if (d.net_profit > EPS) entry.wins += 1;
    else if (d.net_profit < -EPS) entry.losses += 1;
  }
  for (const b of map.values()) {
    b.winRate = b.trades > 0 ? (b.wins / b.trades) * 100 : 0;
  }
  return Array.from(map.values()).sort((a, b) => b.net - a.net);
}

export interface HourBucket {
  hour: number;
  net: number;
  trades: number;
}

export function computeHourBuckets(deals: HistoryDeal[]): HourBucket[] {
  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    net: 0,
    trades: 0,
  }));
  for (const d of deals) {
    const h = new Date(d.open_time_ms).getHours();
    buckets[h].net += d.net_profit;
    buckets[h].trades += 1;
  }
  return buckets;
}

export interface WeekdayBucket {
  weekday: number;
  net: number;
  trades: number;
}

export function computeWeekdayBuckets(deals: HistoryDeal[]): WeekdayBucket[] {
  const buckets: WeekdayBucket[] = Array.from({ length: 7 }, (_, w) => ({
    weekday: w,
    net: 0,
    trades: 0,
  }));
  for (const d of deals) {
    const w = new Date(d.open_time_ms).getDay();
    buckets[w].net += d.net_profit;
    buckets[w].trades += 1;
  }
  return buckets;
}

export interface HourDayCell {
  weekday: number;
  hour: number;
  net: number;
  trades: number;
}

export function computeHourDayMatrix(deals: HistoryDeal[]): HourDayCell[] {
  const cells: HourDayCell[] = [];
  const map = new Map<string, HourDayCell>();
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      const cell: HourDayCell = { weekday: w, hour: h, net: 0, trades: 0 };
      cells.push(cell);
      map.set(`${w}-${h}`, cell);
    }
  }
  for (const d of deals) {
    const date = new Date(d.open_time_ms);
    const w = date.getDay();
    const h = date.getHours();
    const cell = map.get(`${w}-${h}`);
    if (cell) {
      cell.net += d.net_profit;
      cell.trades += 1;
    }
  }
  return cells;
}

export interface HistogramBin {
  lo: number;
  hi: number;
  count: number;
}

export function computeHistogram(values: number[], binCount = 20): HistogramBin[] {
  if (values.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    return [{ lo: min, hi: max, count: values.length }];
  }
  const absMax = Math.max(Math.abs(min), Math.abs(max));
  const lo = -absMax;
  const hi = absMax;
  const step = (hi - lo) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    lo: lo + i * step,
    hi: lo + (i + 1) * step,
    count: 0,
  }));
  for (const v of values) {
    let idx = Math.floor((v - lo) / step);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    bins[idx].count += 1;
  }
  return bins;
}

export interface PeriodCell {
  dayMs: number;
  weekday: number;
  net: number;
  trades: number;
  inRange: boolean;
}

export function computePeriodCalendarCells(
  daily: DailyBucket[],
  fromMs: number,
  toMs: number
): PeriodCell[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
  const map = new Map<string, DailyBucket>();
  for (const d of daily) map.set(d.dayKey, d);

  const start = new Date(fromMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());

  const end = new Date(toMs);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const fromDay = new Date(fromMs);
  fromDay.setHours(0, 0, 0, 0);
  const toDay = new Date(toMs);
  toDay.setHours(0, 0, 0, 0);

  const out: PeriodCell[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    const yyyy = cursor.getFullYear();
    const mm = String(cursor.getMonth() + 1).padStart(2, '0');
    const dd = String(cursor.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    const bucket = map.get(key);
    const ts = cursor.getTime();
    const inRange = ts >= fromDay.getTime() && ts <= toDay.getTime();
    out.push({
      dayMs: ts,
      weekday: cursor.getDay(),
      net: bucket?.net ?? 0,
      trades: bucket?.trades ?? 0,
      inRange,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}


export interface DurationBucket {
  label: string;
  loMs: number;
  hiMs: number;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
}

const DURATION_BUCKET_DEFS: { label: string; loMs: number; hiMs: number }[] = [
  { label: '< 1m', loMs: 0, hiMs: 60_000 },
  { label: '1-15m', loMs: 60_000, hiMs: 15 * 60_000 },
  { label: '15-60m', loMs: 15 * 60_000, hiMs: 60 * 60_000 },
  { label: '1-4h', loMs: 60 * 60_000, hiMs: 4 * 60 * 60_000 },
  { label: '4-24h', loMs: 4 * 60 * 60_000, hiMs: 24 * 60 * 60_000 },
  { label: '1-7d', loMs: 24 * 60 * 60_000, hiMs: 7 * 24 * 60 * 60_000 },
  { label: '> 1w', loMs: 7 * 24 * 60 * 60_000, hiMs: Infinity },
];

export function computeDurationBuckets(deals: HistoryDeal[]): DurationBucket[] {
  const buckets: DurationBucket[] = DURATION_BUCKET_DEFS.map((b) => ({
    ...b,
    net: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
  }));
  for (const d of deals) {
    if (d.close_time_ms <= 0) continue;
    const hold = d.close_time_ms - d.open_time_ms;
    if (hold < 0) continue;
    const idx = buckets.findIndex((b) => hold >= b.loMs && hold < b.hiMs);
    const bucket = idx >= 0 ? buckets[idx] : buckets[buckets.length - 1];
    bucket.net += d.net_profit;
    bucket.trades += 1;
    if (d.net_profit > EPS) bucket.wins += 1;
    else if (d.net_profit < -EPS) bucket.losses += 1;
  }
  for (const b of buckets) {
    b.winRate = b.trades > 0 ? (b.wins / b.trades) * 100 : 0;
  }
  return buckets;
}

export interface ScoreBreakdown {
  winRateScore: number;
  profitFactorScore: number;
  avgWinLossScore: number;
  recoveryFactorScore: number;
  maxDrawdownScore: number;
  consistencyScore: number;
  total: number;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x) || Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function computeScoreBreakdown(
  core: CoreStats,
  drawdown: DrawdownStats,
  ratios: RatioStats
): ScoreBreakdown {
  const winRateScore = clamp01((core.winRate - 30) / 40) * 100;
  const pfRaw = core.profitFactor === Infinity ? 5 : core.profitFactor;
  const profitFactorScore = clamp01((pfRaw - 1) / 1.5) * 100;
  const avgRatioRaw =
    core.avgWinLossRatio === Infinity ? 3 : core.avgWinLossRatio;
  const avgWinLossScore = clamp01((avgRatioRaw - 0.5) / 1.5) * 100;
  const rfRaw = drawdown.recoveryFactor === Infinity ? 6 : drawdown.recoveryFactor;
  const recoveryFactorScore = clamp01(rfRaw / 5) * 100;
  const maxDrawdownScore = clamp01(1 - drawdown.maxDrawdownPct / 40) * 100;
  const cv = ratios.avgDailyPnl !== 0 ? Math.abs(ratios.stdevDaily / ratios.avgDailyPnl) : 5;
  const consistencyScore = clamp01(1 - Math.min(cv, 5) / 5) * 100;
  const total =
    (winRateScore +
      profitFactorScore +
      avgWinLossScore +
      recoveryFactorScore +
      maxDrawdownScore +
      consistencyScore) /
    6;
  return {
    winRateScore,
    profitFactorScore,
    avgWinLossScore,
    recoveryFactorScore,
    maxDrawdownScore,
    consistencyScore,
    total,
  };
}


export type IptradeGrade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface IptradeScoreFactor {
  id: 'profitability' | 'winQuality' | 'riskControl' | 'consistency' | 'edge';
  label: string;
  value: number;
  weight: number;
}

export interface IptradeScore {
  total: number;
  grade: IptradeGrade;
  tier: string;
  factors: IptradeScoreFactor[];
}

const GRADE_CUTS: { min: number; grade: IptradeGrade; tier: string }[] = [
  { min: 90, grade: 'S', tier: 'Top-tier edge' },
  { min: 75, grade: 'A', tier: 'Excellent' },
  { min: 60, grade: 'B', tier: 'Solid' },
  { min: 45, grade: 'C', tier: 'Average' },
  { min: 30, grade: 'D', tier: 'Below average' },
  { min: 0, grade: 'F', tier: 'No edge yet' },
];

function gradeOf(total: number): { grade: IptradeGrade; tier: string } {
  for (const g of GRADE_CUTS) {
    if (total >= g.min) return { grade: g.grade, tier: g.tier };
  }
  return { grade: 'F', tier: 'No edge yet' };
}

export interface IptradeScoreContext {
  totalTrades: number;
}

export function computeIptradeScore(
  core: CoreStats,
  drawdown: DrawdownStats,
  ratios: RatioStats,
  _ctx?: IptradeScoreContext
): IptradeScore {
  const pfRaw = core.profitFactor === Infinity ? 5 : core.profitFactor;
  const pfScore = clamp01((pfRaw - 1) / 1.5) * 100;
  const expectancyScore = clamp01(core.expectancy > 0 ? Math.min(core.expectancy / Math.max(core.avgWin, 1), 1) : 0) * 100;
  const profitabilityScore = pfScore * 0.7 + expectancyScore * 0.3;

  const winRateScore = clamp01((core.winRate - 30) / 40) * 100;
  const avgRatioRaw = core.avgWinLossRatio === Infinity ? 3 : core.avgWinLossRatio;
  const avgScore = clamp01((avgRatioRaw - 0.5) / 1.5) * 100;
  const winQualityScore = winRateScore * 0.5 + avgScore * 0.5;

  const maxDdScore = clamp01(1 - drawdown.maxDrawdownPct / 40) * 100;
  const rfRaw = drawdown.recoveryFactor === Infinity ? 6 : drawdown.recoveryFactor;
  const recoveryScore = clamp01(rfRaw / 5) * 100;
  const riskControlScore = maxDdScore * 0.6 + recoveryScore * 0.4;

  const cv = ratios.avgDailyPnl !== 0 ? Math.abs(ratios.stdevDaily / ratios.avgDailyPnl) : 5;
  const consistencyScore = clamp01(1 - Math.min(cv, 5) / 5) * 100;

  const sqn = Number.isFinite(core.sqn) ? core.sqn : 0;
  const edgeScore = clamp01((sqn + 0.5) / 2.7) * 100;

  const baseWeights = {
    profitability: 0.3,
    winQuality: 0.2,
    riskControl: 0.2,
    consistency: 0.15,
    edge: 0.15,
  };
  const factors: IptradeScoreFactor[] = [
    { id: 'profitability', label: 'Profitability', value: profitabilityScore, weight: baseWeights.profitability },
    { id: 'winQuality', label: 'Win quality', value: winQualityScore, weight: baseWeights.winQuality },
    { id: 'riskControl', label: 'Risk control', value: riskControlScore, weight: baseWeights.riskControl },
    { id: 'consistency', label: 'Consistency', value: consistencyScore, weight: baseWeights.consistency },
    { id: 'edge', label: 'Edge strength', value: edgeScore, weight: baseWeights.edge },
  ];
  const total = factors.reduce((s, f) => s + f.value * f.weight, 0);
  const { grade, tier } = gradeOf(total);

  return {
    total,
    grade,
    tier,
    factors,
  };
}

