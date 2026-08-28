export type StatsSectionId =
  | 'hero'
  | 'scoreEquity'
  | 'winRateRatios'
  | 'advanced'
  | 'dailyPnl'
  | 'drawdownDistribution'
  | 'duration'
  | 'timePatterns'
  | 'heatmap'
  | 'longShortSymbols'
  | 'bottomSymbols'
  | 'periodHeatmap'
  | 'costs';

export interface StatsSectionMeta {
  id: StatsSectionId;
  label: string;
  description: string;
}

export const STATS_SECTIONS: StatsSectionMeta[] = [
  { id: 'hero', label: 'Hero KPIs', description: 'Net P&L, profit factor, max DD, current streak' },
  { id: 'scoreEquity', label: 'Score & equity curve', description: 'IPTRADE Score radar + cumulative P&L' },
  { id: 'winRateRatios', label: 'Win rate & key ratios', description: 'Win rate gauge plus Sharpe/Sortino/Calmar/etc.' },
  { id: 'advanced', label: 'Advanced edge metrics', description: 'Kelly %, SQN, Z-score, stdev, profit/lot' },
  { id: 'dailyPnl', label: 'Daily P&L', description: 'Bars per active trading day' },
  { id: 'drawdownDistribution', label: 'Drawdown & P&L distribution', description: 'Drawdown curve and per-trade histogram' },
  { id: 'duration', label: 'Trade duration', description: 'Net P&L by hold-time bucket' },
  { id: 'timePatterns', label: 'Time patterns', description: 'By weekday and hour of day' },
  { id: 'heatmap', label: 'Hour × weekday heatmap', description: 'Activity matrix combining both axes' },
  { id: 'longShortSymbols', label: 'Long vs Short + top symbols', description: 'Side gauge plus top symbols by net' },
  { id: 'bottomSymbols', label: 'Bottom symbols + volume mix', description: 'Worst performers, only when >5 symbols' },
  { id: 'periodHeatmap', label: 'Daily activity calendar', description: 'Daily P&L heatmap for the selected range' },
  { id: 'costs', label: 'Costs footer', description: 'Commission, swap and avg holding times' },
];

export interface StatsPreferences {
  order: StatsSectionId[];
  visible: Record<StatsSectionId, boolean>;
}

const STATS_PREFS_KEY = 'iptrade.history.stats.preferences.v1';

const ALL_IDS: StatsSectionId[] = STATS_SECTIONS.map((s) => s.id);
const ALL_ID_SET = new Set<StatsSectionId>(ALL_IDS);

function isStatsSectionId(v: unknown): v is StatsSectionId {
  return typeof v === 'string' && ALL_ID_SET.has(v as StatsSectionId);
}

export function defaultStatsPreferences(): StatsPreferences {
  const visible = ALL_IDS.reduce<Record<StatsSectionId, boolean>>((acc, id) => {
    acc[id] = true;
    return acc;
  }, {} as Record<StatsSectionId, boolean>);
  return { order: [...ALL_IDS], visible };
}

export function isDefaultStatsPreferences(prefs: StatsPreferences): boolean {
  if (prefs.order.length !== ALL_IDS.length) return false;
  for (let i = 0; i < ALL_IDS.length; i++) {
    if (prefs.order[i] !== ALL_IDS[i]) return false;
  }
  for (const id of ALL_IDS) {
    if (prefs.visible[id] !== true) return false;
  }
  return true;
}

export function loadStatsPreferences(): StatsPreferences {
  if (typeof window === 'undefined') return defaultStatsPreferences();
  try {
    const raw = window.localStorage.getItem(STATS_PREFS_KEY);
    if (!raw) return defaultStatsPreferences();
    const parsed = JSON.parse(raw) as Partial<StatsPreferences>;
    const seen = new Set<StatsSectionId>();
    const order: StatsSectionId[] = [];
    if (Array.isArray(parsed.order)) {
      for (const id of parsed.order) {
        if (isStatsSectionId(id) && !seen.has(id)) {
          order.push(id);
          seen.add(id);
        }
      }
    }
    for (const id of ALL_IDS) {
      if (!seen.has(id)) order.push(id);
    }
    const visible = {} as Record<StatsSectionId, boolean>;
    const incomingVisible = (parsed.visible ?? {}) as Partial<Record<StatsSectionId, boolean>>;
    for (const id of ALL_IDS) {
      visible[id] = incomingVisible[id] !== false;
    }
    return { order, visible };
  } catch {
    return defaultStatsPreferences();
  }
}

export function saveStatsPreferences(prefs: StatsPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STATS_PREFS_KEY, JSON.stringify(prefs));
  } catch {
  }
}
