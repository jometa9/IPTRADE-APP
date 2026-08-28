export type CalendarMetricId =
  | 'netPnl'
  | 'tradeCount'
  | 'winRate'
  | 'bestTrade'
  | 'worstTrade'
  | 'volume'
  | 'avgTrade';

export interface CalendarMetricMeta {
  id: CalendarMetricId;
  label: string;
  description: string;
}

export const CALENDAR_METRICS: CalendarMetricMeta[] = [
  { id: 'netPnl', label: 'Net P&L', description: 'Sum of net profit (the headline figure)' },
  { id: 'tradeCount', label: 'Trade count', description: 'Number of trades closed in the cell' },
  { id: 'winRate', label: 'Win rate', description: 'Percentage of winning trades' },
  { id: 'bestTrade', label: 'Best trade', description: 'Single best trade P&L in the cell' },
  { id: 'worstTrade', label: 'Worst trade', description: 'Single worst trade P&L in the cell' },
  { id: 'volume', label: 'Volume', description: 'Total lots / contracts traded' },
  { id: 'avgTrade', label: 'Avg P&L per trade', description: 'Net P&L divided by trade count' },
];

export interface CalendarPreferences {
  order: CalendarMetricId[];
  visible: Record<CalendarMetricId, boolean>;
}

const CAL_PREFS_KEY = 'iptrade.history.calendar.preferences.v2';

const ALL_IDS: CalendarMetricId[] = CALENDAR_METRICS.map((m) => m.id);
const ALL_ID_SET = new Set<CalendarMetricId>(ALL_IDS);

const DEFAULT_VISIBLE: CalendarMetricId[] = ['netPnl', 'tradeCount'];

export const MAX_VISIBLE_CALENDAR_METRICS = 4;

function isCalendarMetricId(v: unknown): v is CalendarMetricId {
  return typeof v === 'string' && ALL_ID_SET.has(v as CalendarMetricId);
}

export function defaultCalendarPreferences(): CalendarPreferences {
  const visible = ALL_IDS.reduce<Record<CalendarMetricId, boolean>>((acc, id) => {
    acc[id] = DEFAULT_VISIBLE.includes(id);
    return acc;
  }, {} as Record<CalendarMetricId, boolean>);
  return { order: [...ALL_IDS], visible };
}

export function isDefaultCalendarPreferences(prefs: CalendarPreferences): boolean {
  if (prefs.order.length !== ALL_IDS.length) return false;
  for (let i = 0; i < ALL_IDS.length; i++) {
    if (prefs.order[i] !== ALL_IDS[i]) return false;
  }
  for (const id of ALL_IDS) {
    const expected = DEFAULT_VISIBLE.includes(id);
    if (prefs.visible[id] !== expected) return false;
  }
  return true;
}

export function visibleCalendarMetrics(prefs: CalendarPreferences): CalendarMetricId[] {
  return prefs.order.filter((id) => prefs.visible[id]);
}

export function loadCalendarPreferences(): CalendarPreferences {
  if (typeof window === 'undefined') return defaultCalendarPreferences();
  try {
    const raw = window.localStorage.getItem(CAL_PREFS_KEY);
    if (!raw) return defaultCalendarPreferences();
    const parsed = JSON.parse(raw) as Partial<CalendarPreferences>;
    const seen = new Set<CalendarMetricId>();
    const order: CalendarMetricId[] = [];
    if (Array.isArray(parsed.order)) {
      for (const id of parsed.order) {
        if (isCalendarMetricId(id) && !seen.has(id)) {
          order.push(id);
          seen.add(id);
        }
      }
    }
    for (const id of ALL_IDS) {
      if (!seen.has(id)) order.push(id);
    }
    const incomingVisible = (parsed.visible ?? {}) as Partial<Record<CalendarMetricId, boolean>>;
    const visible = {} as Record<CalendarMetricId, boolean>;
    for (const id of ALL_IDS) {
      visible[id] = incomingVisible[id] === true;
    }
    if (!ALL_IDS.some((id) => visible[id])) {
      for (const id of DEFAULT_VISIBLE) visible[id] = true;
    }
    const visibleInOrder = order.filter((id) => visible[id]);
    if (visibleInOrder.length > MAX_VISIBLE_CALENDAR_METRICS) {
      const keep = new Set(visibleInOrder.slice(0, MAX_VISIBLE_CALENDAR_METRICS));
      for (const id of ALL_IDS) {
        if (!keep.has(id)) visible[id] = false;
      }
    }
    return { order, visible };
  } catch {
    return defaultCalendarPreferences();
  }
}

export function saveCalendarPreferences(prefs: CalendarPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CAL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
  }
}
