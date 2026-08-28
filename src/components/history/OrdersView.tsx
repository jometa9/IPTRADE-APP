'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, GripVertical, Inbox } from 'lucide-react';
import { useHistory } from '@/context/HistoryContext';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ManualScrollbar } from '@/components/ui/ManualScrollbar';
import { FullPageState } from '@/components/FullPageState';
import type { HistoryDeal } from '@/api';
import { cn } from '@/lib/utils';
import { getPlatformDisplayName } from '@/lib/trading/utils';

const PREFS_STORAGE_KEY = 'iptrade.history.orders.preferences.v3';

export type SortDirection = 'asc' | 'desc';

interface AccountInfo {
  server: string | null;
  nickname: string | null;
  platform: string;
  connection_type: string | null;
}

export type ColumnId =
  | 'account'
  | 'platform'
  | 'server'
  | 'nickname'
  | 'symbol'
  | 'side'
  | 'volume'
  | 'open'
  | 'close'
  | 'sl'
  | 'tp'
  | 'openTime'
  | 'closeTime'
  | 'commission'
  | 'swap'
  | 'profit'
  | 'net'
  | 'ticket';

type ValueKind = 'string' | 'number';

interface ColumnDef {
  id: ColumnId;
  label: string;
  align: 'left' | 'right';
  valueKind: ValueKind;
  getSortValue: (deal: HistoryDeal, account: AccountInfo | undefined) => string | number | null;
  renderCell: (deal: HistoryDeal, account: AccountInfo | undefined) => React.ReactNode;
  cellClassName?: string;
}

export interface OrdersPreferences {
  sort: { columnId: ColumnId | null; direction: SortDirection };
  columnOrder: ColumnId[];
  visible: Record<ColumnId, boolean>;
}

function formatDateTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatNumber(value: number | null | undefined, fractionDigits = 2): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

function formatPnl(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  if (Math.abs(value) < 0.005) return '0.00';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pnlClass(value: number | null | undefined): string {
  if (value == null || Math.abs(value) < 0.005) return 'text-gray-600';
  return value > 0 ? 'text-green-600' : 'text-red-600';
}

const COLUMNS: Record<ColumnId, ColumnDef> = {
  account: {
    id: 'account',
    label: 'Account ID',
    align: 'left',
    valueKind: 'string',
    getSortValue: (d) => d.account_id ?? '',
    renderCell: (d) => d.account_id,
    cellClassName: 'whitespace-nowrap font-medium',
  },
  platform: {
    id: 'platform',
    label: 'Platform',
    align: 'left',
    valueKind: 'string',
    getSortValue: (d) => getPlatformDisplayName(d.platform),
    renderCell: (d) => getPlatformDisplayName(d.platform),
    cellClassName: 'whitespace-nowrap',
  },
  server: {
    id: 'server',
    label: 'Server',
    align: 'left',
    valueKind: 'string',
    getSortValue: (d, acct) => acct?.server ?? d.server ?? '',
    renderCell: (d, acct) => acct?.server ?? d.server ?? '—',
    cellClassName: 'whitespace-nowrap',
  },
  nickname: {
    id: 'nickname',
    label: 'Nickname',
    align: 'left',
    valueKind: 'string',
    getSortValue: (_d, acct) => acct?.nickname ?? '',
    renderCell: (_d, acct) => acct?.nickname ?? '—',
    cellClassName: 'whitespace-nowrap',
  },
  symbol: {
    id: 'symbol',
    label: 'Symbol',
    align: 'left',
    valueKind: 'string',
    getSortValue: (d) => d.symbol ?? '',
    renderCell: (d) => d.symbol,
    cellClassName: 'whitespace-nowrap',
  },
  side: {
    id: 'side',
    label: 'Side',
    align: 'left',
    valueKind: 'string',
    getSortValue: (d) => d.side ?? '',
    renderCell: (d) => <span className="capitalize">{d.side}</span>,
    cellClassName: 'whitespace-nowrap',
  },
  volume: {
    id: 'volume',
    label: 'Volume',
    align: 'right',
    valueKind: 'number',
    getSortValue: (d) => d.volume ?? 0,
    renderCell: (d) => formatNumber(d.volume, 2),
    cellClassName: 'text-right tabular-nums whitespace-nowrap',
  },
  open: {
    id: 'open',
    label: 'Open',
    align: 'right',
    valueKind: 'number',
    getSortValue: (d) => d.open_price ?? null,
    renderCell: (d) => formatNumber(d.open_price, 5),
    cellClassName: 'text-right tabular-nums whitespace-nowrap',
  },
  close: {
    id: 'close',
    label: 'Close',
    align: 'right',
    valueKind: 'number',
    getSortValue: (d) => d.close_price ?? null,
    renderCell: (d) => formatNumber(d.close_price, 5),
    cellClassName: 'text-right tabular-nums whitespace-nowrap',
  },
  sl: {
    id: 'sl',
    label: 'SL',
    align: 'right',
    valueKind: 'number',
    getSortValue: (d) => d.sl ?? null,
    renderCell: (d) => formatNumber(d.sl, 5),
    cellClassName: 'text-right tabular-nums whitespace-nowrap',
  },
  tp: {
    id: 'tp',
    label: 'TP',
    align: 'right',
    valueKind: 'number',
    getSortValue: (d) => d.tp ?? null,
    renderCell: (d) => formatNumber(d.tp, 5),
    cellClassName: 'text-right tabular-nums whitespace-nowrap',
  },
  openTime: {
    id: 'openTime',
    label: 'Open time',
    align: 'left',
    valueKind: 'number',
    getSortValue: (d) => d.open_time_ms ?? 0,
    renderCell: (d) => formatDateTime(d.open_time_ms),
    cellClassName: 'whitespace-nowrap',
  },
  closeTime: {
    id: 'closeTime',
    label: 'Close time',
    align: 'left',
    valueKind: 'number',
    getSortValue: (d) => d.close_time_ms ?? 0,
    renderCell: (d) => formatDateTime(d.close_time_ms),
    cellClassName: 'whitespace-nowrap',
  },
  commission: {
    id: 'commission',
    label: 'Commission',
    align: 'right',
    valueKind: 'number',
    getSortValue: (d) => d.commission ?? 0,
    renderCell: (d) => formatNumber(d.commission, 2),
    cellClassName: 'text-right tabular-nums whitespace-nowrap',
  },
  swap: {
    id: 'swap',
    label: 'Swap',
    align: 'right',
    valueKind: 'number',
    getSortValue: (d) => d.swap ?? 0,
    renderCell: (d) => formatNumber(d.swap, 2),
    cellClassName: 'text-right tabular-nums whitespace-nowrap',
  },
  profit: {
    id: 'profit',
    label: 'PnL',
    align: 'right',
    valueKind: 'number',
    getSortValue: (d) => d.profit ?? 0,
    renderCell: (d) => <span className={pnlClass(d.profit)}>{formatPnl(d.profit)}</span>,
    cellClassName: 'text-right tabular-nums whitespace-nowrap',
  },
  net: {
    id: 'net',
    label: 'Net PnL',
    align: 'right',
    valueKind: 'number',
    getSortValue: (d) => d.net_profit ?? 0,
    renderCell: (d) => (
      <span className={pnlClass(d.net_profit)}>{formatPnl(d.net_profit)}</span>
    ),
    cellClassName: 'text-right tabular-nums whitespace-nowrap',
  },
  ticket: {
    id: 'ticket',
    label: 'Ticket',
    align: 'left',
    valueKind: 'number',
    getSortValue: (d) => d.ticket ?? null,
    renderCell: (d) => d.ticket ?? '—',
    cellClassName: 'whitespace-nowrap',
  },
};

export const DEFAULT_ORDERS_COLUMN_ORDER: ColumnId[] = [
  'account',
  'platform',
  'server',
  'nickname',
  'symbol',
  'side',
  'volume',
  'open',
  'openTime',
  'close',
  'closeTime',
  'sl',
  'tp',
  'commission',
  'swap',
  'profit',
  'net',
  'ticket',
];

const ALL_COLUMN_IDS = new Set<ColumnId>(DEFAULT_ORDERS_COLUMN_ORDER);

function defaultVisibleMap(): Record<ColumnId, boolean> {
  const m = {} as Record<ColumnId, boolean>;
  for (const id of DEFAULT_ORDERS_COLUMN_ORDER) m[id] = true;
  return m;
}

export function defaultOrdersPreferences(): OrdersPreferences {
  return {
    sort: { columnId: null, direction: 'desc' },
    columnOrder: [...DEFAULT_ORDERS_COLUMN_ORDER],
    visible: defaultVisibleMap(),
  };
}

export function isDefaultOrdersPreferences(prefs: OrdersPreferences): boolean {
  if (prefs.sort.columnId !== null) return false;
  if (prefs.columnOrder.length !== DEFAULT_ORDERS_COLUMN_ORDER.length) return false;
  for (let i = 0; i < DEFAULT_ORDERS_COLUMN_ORDER.length; i++) {
    if (prefs.columnOrder[i] !== DEFAULT_ORDERS_COLUMN_ORDER[i]) return false;
  }
  for (const id of DEFAULT_ORDERS_COLUMN_ORDER) {
    if (prefs.visible[id] === false) return false;
  }
  return true;
}

export function loadOrdersPreferences(): OrdersPreferences {
  if (typeof window === 'undefined') {
    return defaultOrdersPreferences();
  }
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return defaultOrdersPreferences();
    const parsed = JSON.parse(raw) as Partial<OrdersPreferences>;
    const sortColumnId =
      parsed?.sort?.columnId && ALL_COLUMN_IDS.has(parsed.sort.columnId as ColumnId)
        ? (parsed.sort.columnId as ColumnId)
        : null;
    const sortDirection: SortDirection = parsed?.sort?.direction === 'asc' ? 'asc' : 'desc';

    const seen = new Set<ColumnId>();
    const order: ColumnId[] = [];
    if (Array.isArray(parsed?.columnOrder)) {
      for (const id of parsed.columnOrder) {
        if (ALL_COLUMN_IDS.has(id as ColumnId) && !seen.has(id as ColumnId)) {
          order.push(id as ColumnId);
          seen.add(id as ColumnId);
        }
      }
    }
    for (const id of DEFAULT_ORDERS_COLUMN_ORDER) {
      if (!seen.has(id)) order.push(id);
    }

    const visible = defaultVisibleMap();
    if (parsed?.visible && typeof parsed.visible === 'object') {
      for (const id of DEFAULT_ORDERS_COLUMN_ORDER) {
        const v = (parsed.visible as Record<string, unknown>)[id];
        if (typeof v === 'boolean') visible[id] = v;
      }
    }
    return {
      sort: { columnId: sortColumnId, direction: sortDirection },
      columnOrder: order,
      visible,
    };
  } catch {
    return defaultOrdersPreferences();
  }
}

export function saveOrdersPreferences(prefs: OrdersPreferences): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
  }
}

function compareValues(
  a: string | number | null,
  b: string | number | null,
  kind: ValueKind
): number {
  const aNull = a == null || a === '';
  const bNull = b == null || b === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (kind === 'number') {
    return (a as number) - (b as number);
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function defaultDealTime(d: HistoryDeal): number {
  return d.close_time_ms > 0 ? d.close_time_ms : d.open_time_ms;
}

interface OrdersViewProps {
  prefs: OrdersPreferences;
  onPrefsChange: React.Dispatch<React.SetStateAction<OrdersPreferences>>;
}

export function OrdersView({ prefs, onPrefsChange: setPrefs }: OrdersViewProps) {
  const { deals, allDeals, accounts, isLoading, isRefreshing } = useHistory();

  const accountMap = useMemo(() => {
    const m = new Map<string, AccountInfo>();
    for (const a of accounts) {
      m.set(a.account_id, {
        server: a.server,
        nickname: a.nickname,
        platform: a.platform,
        connection_type: a.connection_type,
      });
    }
    return m;
  }, [accounts]);

  const sortedDeals = useMemo(() => {
    const arr = [...deals];
    const { columnId, direction } = prefs.sort;
    if (columnId == null) {
      arr.sort((a, b) => defaultDealTime(b) - defaultDealTime(a));
      return arr;
    }
    const col = COLUMNS[columnId];
    const dir = direction === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const av = col.getSortValue(a, accountMap.get(a.account_id));
      const bv = col.getSortValue(b, accountMap.get(b.account_id));
      const cmp = compareValues(av, bv, col.valueKind);
      if (cmp !== 0) return cmp * dir;
      return defaultDealTime(b) - defaultDealTime(a);
    });
    return arr;
  }, [deals, prefs.sort, accountMap]);

  const orderedColumns = useMemo(
    () =>
      prefs.columnOrder
        .filter((id) => prefs.visible[id] !== false)
        .map((id) => COLUMNS[id]),
    [prefs.columnOrder, prefs.visible]
  );

  const cycleSort = useCallback((columnId: ColumnId) => {
    setPrefs((prev) => {
      const cur = prev.sort;
      let next: OrdersPreferences['sort'];
      if (cur.columnId !== columnId) {
        next = { columnId, direction: 'asc' };
      } else if (cur.direction === 'asc') {
        next = { columnId, direction: 'desc' };
      } else {
        next = { columnId: null, direction: 'desc' };
      }
      return { ...prev, sort: next };
    });
  }, []);

  const moveColumn = useCallback((sourceId: ColumnId, targetId: ColumnId, position: 'before' | 'after') => {
    setPrefs((prev) => {
      if (sourceId === targetId) return prev;
      const order = prev.columnOrder.filter((id) => id !== sourceId);
      const targetIdx = order.indexOf(targetId);
      if (targetIdx === -1) return prev;
      const insertAt = position === 'before' ? targetIdx : targetIdx + 1;
      order.splice(insertAt, 0, sourceId);
      return { ...prev, columnOrder: order };
    });
  }, []);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [scrollMetrics, setScrollMetrics] = useState<{
    scrollLeft: number;
    clientWidth: number;
    scrollWidth: number;
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  } | null>(null);

  const updateScrollState = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setScrollMetrics({
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    });
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    updateScrollState();
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    el.addEventListener('scroll', updateScrollState);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', updateScrollState);
    };
  }, [updateScrollState, sortedDeals.length, orderedColumns.length]);

  const handleVerticalScrollbarChange = useCallback((nextValue: number) => {
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = nextValue;
  }, []);

  const handleHorizontalScrollbarChange = useCallback((nextValue: number) => {
    const el = scrollContainerRef.current;
    if (el) el.scrollLeft = nextValue;
  }, []);

  const hasVerticalScroll = !!scrollMetrics && scrollMetrics.scrollHeight > scrollMetrics.clientHeight;
  const hasHorizontalScroll = !!scrollMetrics && scrollMetrics.scrollWidth > scrollMetrics.clientWidth;

  const busy = isLoading || isRefreshing;
  const showLoading = busy && allDeals.length === 0;
  const showEmpty = !showLoading && sortedDeals.length === 0;

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div ref={scrollContainerRef} className="flex-1 min-h-0 min-w-0 overflow-auto">
          {showLoading ? (
            <FullPageState
              title="Loading orders"
              subtitle="Fetching your trade history…"
              showSpinner
              className="bg-white"
            />
          ) : showEmpty ? (
            <FullPageState
              title="No orders in this period"
              subtitle="Closed trades for the selected filters will appear here once your accounts send data."
              showSpinner={false}
              icon={<Inbox className="h-6 w-6 text-gray-400 m-2" />}
              className="bg-white"
            />
          ) : (
            <Table>
              <TableHeader className="[&_tr]:!border-t-0 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-gray-50 [&_th]:border-b [&_th]:border-gray-200">
                <TableRow className="align-middle bg-gray-50 hover:bg-gray-50">
                  {orderedColumns.map((col) => (
                    <SortableHeader
                      key={col.id}
                      column={col}
                      sort={prefs.sort}
                      onSort={cycleSort}
                      onMoveColumn={moveColumn}
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedDeals.map((d, idx) => {
                  const isOdd = idx % 2 === 1;
                  return (
                    <TableRow
                      key={d.deal_id}
                      className={cn(
                        'group align-middle',
                        isOdd && 'bg-gray-100/60'
                      )}
                    >
                      {orderedColumns.map((col) => (
                        <TableCell
                          key={col.id}
                          className={cn('px-1.5 py-1.5', col.cellClassName)}
                        >
                          {col.renderCell(d, accountMap.get(d.account_id))}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
        {hasVerticalScroll && scrollMetrics && (
          <div className="flex shrink-0 flex-col py-2 px-2 bg-white border-l border-gray-200">
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
      {hasHorizontalScroll && scrollMetrics && (
        <div className="flex items-center px-2 py-2 bg-white border-t border-gray-200 shrink-0">
          <ManualScrollbar
            orientation="horizontal"
            value={scrollMetrics.scrollLeft}
            viewportSize={scrollMetrics.clientWidth}
            contentSize={scrollMetrics.scrollWidth}
            onChange={handleHorizontalScrollbarChange}
            className="flex-1"
          />
        </div>
      )}
    </div>
  );
}

interface SortableHeaderProps {
  column: ColumnDef;
  sort: OrdersPreferences['sort'];
  onSort: (id: ColumnId) => void;
  onMoveColumn: (sourceId: ColumnId, targetId: ColumnId, position: 'before' | 'after') => void;
}

function SortableHeader({ column, sort, onSort, onMoveColumn }: SortableHeaderProps) {
  const isActive = sort.columnId === column.id;
  const direction = isActive ? sort.direction : null;
  const thRef = useRef<HTMLTableCellElement | null>(null);
  const dragHandleArmedRef = useRef(false);
  const [dropIndicator, setDropIndicator] = useState<'before' | 'after' | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleHeaderClick = useCallback(() => {
    onSort(column.id);
  }, [column.id, onSort]);

  const handleThMouseDown = useCallback((e: React.MouseEvent<HTMLTableCellElement>) => {
    const target = e.target as HTMLElement;
    dragHandleArmedRef.current = !!target.closest('[data-drag-handle="true"]');
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent<HTMLTableCellElement>) => {
    if (!dragHandleArmedRef.current) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', column.id);
    if (thRef.current) {
      try {
        e.dataTransfer.setDragImage(thRef.current, 12, 12);
      } catch {
      }
    }
    setIsDragging(true);
  }, [column.id]);

  const handleDragEnd = useCallback(() => {
    dragHandleArmedRef.current = false;
    setIsDragging(false);
    setDropIndicator(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLTableCellElement>) => {
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    setDropIndicator(offsetX < rect.width / 2 ? 'before' : 'after');
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLTableCellElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDropIndicator(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLTableCellElement>) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData('text/plain') as ColumnId;
    if (sourceId && sourceId !== column.id && dropIndicator) {
      onMoveColumn(sourceId, column.id, dropIndicator);
    }
    setDropIndicator(null);
  }, [column.id, dropIndicator, onMoveColumn]);

  return (
    <TableHead
      ref={thRef}
      draggable
      onMouseDown={handleThMouseDown}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'group relative whitespace-nowrap select-none px-1.5 py-1.5',
        isDragging && 'opacity-60'
      )}
    >
      <div
        className={cn(
          'flex items-center cursor-pointer',
          column.align === 'right' && 'justify-end'
        )}
        onClick={handleHeaderClick}
      >
        {column.align === 'right' && (
          <span
            role="presentation"
            data-drag-handle="true"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'flex h-4 items-center justify-center text-gray-400 cursor-grab active:cursor-grabbing overflow-hidden',
              isDragging
                ? 'opacity-100 w-3.5'
                : 'opacity-0 w-0 group-hover:opacity-100 group-hover:w-3.5'
            )}
            aria-label="Reorder column"
          >
            <GripVertical className="h-3.5 w-3.5 shrink-0" />
          </span>
        )}
        {column.align === 'right' && (
          <span
            className={cn(
              'flex h-4 items-center justify-center text-gray-400 overflow-hidden',
              isActive
                ? 'opacity-100 text-gray-700 w-3.5 mr-1'
                : 'opacity-0 w-0 mr-0 group-hover:opacity-100 group-hover:w-3.5 group-hover:mr-1'
            )}
            aria-hidden="true"
          >
            {direction === 'asc' ? (
              <ArrowUp className="h-3.5 w-3.5 shrink-0" />
            ) : direction === 'desc' ? (
              <ArrowDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />
            )}
          </span>
        )}
        <span className="truncate">{column.label}</span>
        {column.align === 'left' && (
          <span
            className={cn(
              'flex h-4 items-center justify-center text-gray-400 overflow-hidden',
              isActive
                ? 'opacity-100 text-gray-700 w-3.5 ml-1'
                : 'opacity-0 w-0 ml-0 group-hover:opacity-100 group-hover:w-3.5 group-hover:ml-1'
            )}
            aria-hidden="true"
          >
            {direction === 'asc' ? (
              <ArrowUp className="h-3.5 w-3.5 shrink-0" />
            ) : direction === 'desc' ? (
              <ArrowDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />
            )}
          </span>
        )}
        {column.align === 'left' && (
          <span
            role="presentation"
            data-drag-handle="true"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              'flex h-4 items-center justify-center text-gray-400 cursor-grab active:cursor-grabbing overflow-hidden',
              isDragging
                ? 'opacity-100 w-3.5'
                : 'opacity-0 w-0 group-hover:opacity-100 group-hover:w-3.5'
            )}
            aria-label="Reorder column"
          >
            <GripVertical className="h-3.5 w-3.5 shrink-0" />
          </span>
        )}
      </div>
      {dropIndicator === 'before' && (
        <span className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-blue-500" />
      )}
      {dropIndicator === 'after' && (
        <span className="pointer-events-none absolute inset-y-0 right-0 w-0.5 bg-blue-500" />
      )}
    </TableHead>
  );
}
