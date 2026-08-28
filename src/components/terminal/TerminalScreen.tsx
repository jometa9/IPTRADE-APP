'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Inbox } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TerminalProvider, useTerminal } from '@/context/TerminalContext';
import { useAccountOrders } from '@/context/AccountOrdersContext';
import { cn } from '@/lib/utils';
import { getPlatformDisplayName } from '@/lib/trading/utils';
import { Watermark } from '@/components/Watermark';
import { FullPageState } from '@/components/FullPageState';
import { NoAccountsEmpty } from '@/components/NoAccountsEmpty';
import { ManualScrollbar } from '@/components/ui/ManualScrollbar';
import type { TradingAccount } from '@/lib/trading/types';
import { formatNumber, formatPnl, pnlClass } from './format';
import { TerminalFilterHeader } from './TerminalFilterHeader';

const SELECTED_ACCOUNTS_STORAGE_KEY = 'iptrade.terminal.selectedAccounts.v1';

function loadPersistedSelectedAccountIds(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SELECTED_ACCOUNTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function savePersistedSelectedAccountIds(ids: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SELECTED_ACCOUNTS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
  }
}

function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function formatType(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase();
}

function formatPendingType(side: string, type: string): string {
  const t = formatType(type ?? '');
  const s = (side ?? '').toLowerCase();
  if (s && !t.split(/\s+/).includes(s)) return `${s} ${t}`.trim();
  return t;
}

type OptionalColumnKey =
  | 'server'
  | 'platform'
  | 'nickname'
  | 'openTime'
  | 'sl'
  | 'tp'
  | 'ticket'
  | 'price'
  | 'accountId';

const COLUMN_HIDE_PRIORITY: { key: OptionalColumnKey; width: number }[] = [
  { key: 'server',    width: 110 },
  { key: 'platform',  width: 110 },
  { key: 'nickname',  width: 110 },
  { key: 'openTime',  width: 140 },
  { key: 'sl',        width: 80 },
  { key: 'tp',        width: 80 },
  { key: 'ticket',    width: 100 },
  { key: 'price',     width: 90 },
  { key: 'accountId', width: 130 },
];

const COLUMN_HIDE_FILL_RATIO = 0.96;

interface TerminalScreenProps {
  accounts: TradingAccount[];
  onOpenAddScreen: () => void;
}

export function TerminalScreen({ accounts, onOpenAddScreen }: TerminalScreenProps) {
  if (accounts.length === 0) {
    return <NoAccountsEmpty onAddAccounts={onOpenAddScreen} />;
  }
  return (
    <TerminalProvider>
      <TerminalScreenInner accounts={accounts} />
    </TerminalProvider>
  );
}

function TerminalScreenInner({ accounts }: { accounts: TradingAccount[] }) {
  const { positions, pending, serverNowMs, error } = useTerminal();
  const { ordersByAccountId } = useAccountOrders();

  const [selectedAccountIds, setSelectedAccountIdsState] = useState<string[]>(() =>
    loadPersistedSelectedAccountIds()
  );
  const setSelectedAccountIds = useCallback((ids: string[]) => {
    setSelectedAccountIdsState(ids);
    savePersistedSelectedAccountIds(ids);
  }, []);

  const allSelected = selectedAccountIds.length === 0;
  const selectedSet = useMemo(() => new Set(selectedAccountIds), [selectedAccountIds]);

  const filteredPositions = useMemo(
    () => (allSelected ? positions : positions.filter((p) => selectedSet.has(p.account_id))),
    [allSelected, positions, selectedSet]
  );
  const filteredPending = useMemo(
    () => (allSelected ? pending : pending.filter((p) => selectedSet.has(p.account_id))),
    [allSelected, pending, selectedSet]
  );

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [forcedHiddenCols, setForcedHiddenCols] = useState<Set<OptionalColumnKey>>(new Set());
  const forcedHiddenColsRef = useRef(forcedHiddenCols);
  forcedHiddenColsRef.current = forcedHiddenCols;

  const [verticalScrollMetrics, setVerticalScrollMetrics] = useState<{
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  } | null>(null);

  const updateVerticalScrollMetrics = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setVerticalScrollMetrics({
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    });
  }, []);

  const handleVerticalScrollChange = useCallback((v: number) => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = v;
  }, []);

  const hasVerticalScroll =
    verticalScrollMetrics != null &&
    verticalScrollMetrics.scrollHeight > verticalScrollMetrics.clientHeight;

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
      updateVerticalScrollMetrics();
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth);
    updateVerticalScrollMetrics();
    el.addEventListener('scroll', updateVerticalScrollMetrics);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', updateVerticalScrollMetrics);
    };
  }, [updateVerticalScrollMetrics]);

  useEffect(() => {
    updateVerticalScrollMetrics();
  }, [updateVerticalScrollMetrics, filteredPositions.length, filteredPending.length]);

  useLayoutEffect(() => {
    const table = tableRef.current;
    const container = scrollContainerRef.current;
    if (!table || !container) return;

    const savedWidth = table.style.width;
    table.style.width = 'auto';
    const tableWidth = table.offsetWidth;
    table.style.width = savedWidth;

    const available = container.clientWidth * COLUMN_HIDE_FILL_RATIO;

    const hiddenSnapshot = forcedHiddenColsRef.current;
    const hiddenDueToSpace = COLUMN_HIDE_PRIORITY.filter((c) => hiddenSnapshot.has(c.key));
    const sumHiddenWidths = hiddenDueToSpace.reduce((sum, c) => sum + c.width, 0);
    const virtualTotal = tableWidth + sumHiddenWidths;

    const newHidden = new Set<OptionalColumnKey>();
    let running = virtualTotal;
    for (const col of COLUMN_HIDE_PRIORITY) {
      if (running <= available) break;
      newHidden.add(col.key);
      running -= col.width;
    }

    setForcedHiddenCols((prev) => {
      if (prev.size === newHidden.size && [...newHidden].every((k) => prev.has(k))) return prev;
      return newHidden;
    });
  }, [containerWidth, filteredPositions.length, filteredPending.length]);

  const visible = useMemo(
    () => ({
      accountId: !forcedHiddenCols.has('accountId'),
      platform: !forcedHiddenCols.has('platform'),
      server: !forcedHiddenCols.has('server'),
      nickname: !forcedHiddenCols.has('nickname'),
      price: !forcedHiddenCols.has('price'),
      openTime: !forcedHiddenCols.has('openTime'),
      sl: !forcedHiddenCols.has('sl'),
      tp: !forcedHiddenCols.has('tp'),
      ticket: !forcedHiddenCols.has('ticket'),
    }),
    [forcedHiddenCols],
  );

  const columnCount = useMemo(() => {
    let count = 4;
    if (visible.accountId) count++;
    if (visible.platform) count++;
    if (visible.server) count++;
    if (visible.nickname) count++;
    if (visible.price) count++;
    if (visible.openTime) count++;
    if (visible.sl) count++;
    if (visible.tp) count++;
    if (visible.ticket) count++;
    return count;
  }, [visible]);

  const sortedPositions = useMemo(
    () =>
      [...filteredPositions].sort(
        (a, b) => a.ticket - b.ticket || a.account_id.localeCompare(b.account_id),
      ),
    [filteredPositions],
  );

  const sortedPending = useMemo(
    () =>
      [...filteredPending].sort(
        (a, b) => a.ticket - b.ticket || a.account_id.localeCompare(b.account_id),
      ),
    [filteredPending],
  );

  const totals = useMemo(() => {
    let balance = 0;
    let equity = 0;
    let pnl = 0;
    let hasBalance = false;
    let hasEquity = false;
    let hasPnl = false;
    for (const [id, v] of Object.entries(ordersByAccountId)) {
      if (!allSelected && !selectedSet.has(id)) continue;
      if (v.balance != null) {
        balance += v.balance;
        hasBalance = true;
      }
      if (v.equity != null) {
        equity += v.equity;
        hasEquity = true;
      }
      if (v.pnl != null) {
        pnl += v.pnl;
        hasPnl = true;
      }
    }
    return {
      balance: hasBalance ? balance : null,
      equity: hasEquity ? equity : null,
      pnl: hasPnl ? pnl : null,
    };
  }, [ordersByAccountId, allSelected, selectedSet]);

  const isEmpty = filteredPositions.length === 0 && filteredPending.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600">
          {error}
        </div>
      )}
      <TerminalFilterHeader
        accounts={accounts}
        selectedAccountIds={selectedAccountIds}
        onChange={setSelectedAccountIds}
      />
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        <Watermark />
        <div ref={scrollContainerRef} className="relative z-10 flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {isEmpty ? (
          <FullPageState
            title="No open or pending orders"
            subtitle="Your active and pending trades will appear here once your connected accounts start sending data."
            showSpinner={false}
            icon={<Inbox className="h-6 w-6 text-gray-400 m-2" />}
            className="bg-white"
          />
        ) : (
          <Table ref={tableRef} className="[&_th]:px-4 [&_td]:px-4">
            <TableHeader className="[&_tr]:!border-t-0 [&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-gray-50 [&_th]:border-b [&_th]:border-gray-200">
              <TableRow className="bg-gray-50 hover:bg-gray-50">
                {visible.accountId && <TableHead>Account ID</TableHead>}
                {visible.platform && <TableHead>Platform</TableHead>}
                {visible.server && <TableHead>Server</TableHead>}
                {visible.nickname && <TableHead>Nickname</TableHead>}
                <TableHead>Symbol</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                {visible.price && <TableHead className="text-right">Price</TableHead>}
                {visible.openTime && <TableHead>Open time</TableHead>}
                {visible.sl && <TableHead className="text-right">SL</TableHead>}
                {visible.tp && <TableHead className="text-right">TP</TableHead>}
                <TableHead className="text-right">PnL</TableHead>
                {visible.ticket && <TableHead className="text-right">Ticket</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedPositions.map((p) => (
                <TableRow key={`${p.account_id}-${p.ticket}`}>
                  {visible.accountId && <TableCell className="whitespace-nowrap font-medium">{p.account_id}</TableCell>}
                  {visible.platform && <TableCell className="whitespace-nowrap">{getPlatformDisplayName(p.platform)}</TableCell>}
                  {visible.server && <TableCell className="whitespace-nowrap">{p.server ?? '—'}</TableCell>}
                  {visible.nickname && <TableCell className="whitespace-nowrap">{p.nickname ?? '—'}</TableCell>}
                  <TableCell className="whitespace-nowrap">{p.symbol}</TableCell>
                  <TableCell className="whitespace-nowrap capitalize">{p.side}</TableCell>
                  <TableCell className="text-right tabular-nums whitespace-nowrap">{formatNumber(p.volume, 2)}</TableCell>
                  {visible.price && <TableCell className="text-right tabular-nums whitespace-nowrap">{formatNumber(p.open_price, 5)}</TableCell>}
                  {visible.openTime && <TableCell className="whitespace-nowrap">{formatDateTime(serverNowMs - p.age_seconds * 1000)}</TableCell>}
                  {visible.sl && <TableCell className="text-right tabular-nums whitespace-nowrap">{formatNumber(p.sl, 5)}</TableCell>}
                  {visible.tp && <TableCell className="text-right tabular-nums whitespace-nowrap">{formatNumber(p.tp, 5)}</TableCell>}
                  <TableCell className={cn('text-right tabular-nums whitespace-nowrap', pnlClass(p.profit))}>{formatPnl(p.profit)}</TableCell>
                  {visible.ticket && <TableCell className="text-right tabular-nums whitespace-nowrap">{p.ticket}</TableCell>}
                </TableRow>
              ))}
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={columnCount}
                  className="sticky bottom-0 z-10 bg-gray-100 border-y border-gray-300 !p-0"
                >
                  <div className="flex items-center justify-end gap-x-6 px-4 py-2 text-sm tabular-nums">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">Balance</span>
                      <span className="font-medium text-gray-900">
                        {totals.balance != null ? formatNumber(totals.balance, 2) : '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">Equity</span>
                      <span className="font-medium text-gray-900">
                        {totals.equity != null ? formatNumber(totals.equity, 2) : '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">PnL</span>
                      <span className={cn('font-medium', pnlClass(totals.pnl))}>
                        {totals.pnl != null ? formatPnl(totals.pnl) : '—'}
                      </span>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
              {sortedPending.map((p, idx) => (
                <TableRow
                  key={`${p.account_id}-${p.ticket}`}
                  className={cn(idx === sortedPending.length - 1 && '!border-b')}
                >
                  {visible.accountId && <TableCell className="whitespace-nowrap font-medium">{p.account_id}</TableCell>}
                  {visible.platform && <TableCell className="whitespace-nowrap">{getPlatformDisplayName(p.platform)}</TableCell>}
                  {visible.server && <TableCell className="whitespace-nowrap">{p.server ?? '—'}</TableCell>}
                  {visible.nickname && <TableCell className="whitespace-nowrap">{p.nickname ?? '—'}</TableCell>}
                  <TableCell className="whitespace-nowrap">{p.symbol}</TableCell>
                  <TableCell className="whitespace-nowrap capitalize">{formatPendingType(p.side, p.type)}</TableCell>
                  <TableCell className="text-right tabular-nums whitespace-nowrap">{formatNumber(p.volume, 2)}</TableCell>
                  {visible.price && <TableCell className="text-right tabular-nums whitespace-nowrap">{formatNumber(p.price, 5)}</TableCell>}
                  {visible.openTime && <TableCell className="whitespace-nowrap">{formatDateTime(serverNowMs - p.age_seconds * 1000)}</TableCell>}
                  {visible.sl && <TableCell className="text-right tabular-nums whitespace-nowrap">{formatNumber(p.sl, 5)}</TableCell>}
                  {visible.tp && <TableCell className="text-right tabular-nums whitespace-nowrap">{formatNumber(p.tp, 5)}</TableCell>}
                  <TableCell className="text-right tabular-nums whitespace-nowrap text-gray-400">—</TableCell>
                  {visible.ticket && <TableCell className="text-right tabular-nums whitespace-nowrap">{p.ticket}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        </div>
        {hasVerticalScroll && verticalScrollMetrics && (
          <div className="relative z-10 flex shrink-0 flex-col py-2 px-2 bg-white border-l border-gray-200">
            <ManualScrollbar
              orientation="vertical"
              value={verticalScrollMetrics.scrollTop}
              viewportSize={verticalScrollMetrics.clientHeight}
              contentSize={verticalScrollMetrics.scrollHeight}
              onChange={handleVerticalScrollChange}
              className="flex-1 min-h-0"
            />
          </div>
        )}
      </div>
    </div>
  );
}
