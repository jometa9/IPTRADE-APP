'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Check, ChevronDown, Layers, Sigma, Table2 } from 'lucide-react';
import { useHistory } from '@/context/HistoryContext';
import { ManualScrollbar } from '@/components/ui/ManualScrollbar';
import { FullPageState } from '@/components/FullPageState';
import { cn } from '@/lib/utils';
import {
  DIMENSIONS,
  METRICS,
  computePivot,
  formatMetricValue,
  type DimensionId,
  type MetricId,
} from './analyzeMath';

const ANALYZE_PREFS_KEY = 'iptrade.history.analyze.preferences.v1';

interface AnalyzePrefs {
  rowDim: DimensionId;
  colDim: DimensionId;
  metric: MetricId;
}

const DEFAULT_PREFS: AnalyzePrefs = {
  rowDim: 'symbol',
  colDim: 'weekday',
  metric: 'netPnl',
};

function loadPrefs(): AnalyzePrefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(ANALYZE_PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<AnalyzePrefs>;
    const valid = (id: unknown) =>
      DIMENSIONS.some((d) => d.id === id) ? (id as DimensionId) : null;
    const validMetric = (id: unknown) =>
      METRICS.some((m) => m.id === id) ? (id as MetricId) : null;
    return {
      rowDim: valid(p.rowDim) ?? DEFAULT_PREFS.rowDim,
      colDim: valid(p.colDim) ?? DEFAULT_PREFS.colDim,
      metric: validMetric(p.metric) ?? DEFAULT_PREFS.metric,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: AnalyzePrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ANALYZE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
  }
}

export function AnalyzeView() {
  const { deals, accounts, isLoading } = useHistory();
  const [prefs, setPrefs] = useState<AnalyzePrefs>(loadPrefs);
  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  const closedDeals = useMemo(() => deals.filter((d) => d.close_time_ms > 0), [deals]);

  const pivot = useMemo(
    () =>
      computePivot({
        deals: closedDeals,
        rowDim: prefs.rowDim,
        colDim: prefs.colDim,
        metric: prefs.metric,
        ctx: { accounts },
      }),
    [closedDeals, prefs.rowDim, prefs.colDim, prefs.metric, accounts]
  );

  const swap = () => setPrefs((p) => ({ ...p, rowDim: p.colDim, colDim: p.rowDim }));

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
  }, [updateScrollState, pivot.rowKeys.length, pivot.colKeys.length]);

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

  if (isLoading && deals.length === 0) {
    return (
      <FullPageState
        title="Loading analysis"
        subtitle="Crunching your trade history to build the pivot…"
        showSpinner
        className="bg-white"
      />
    );
  }
  if (closedDeals.length === 0) {
    return (
      <FullPageState
        title="No closed trades in this period"
        subtitle="Adjust your filters or wait for new closed trades to populate this view."
        showSpinner={false}
        icon={<Table2 className="h-6 w-6 text-gray-400 m-2" />}
        className="bg-white"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col border-b border-gray-200 bg-white text-sm lg:flex-row lg:items-center">
        <div className="flex h-9 items-center border-b border-gray-200 lg:order-last lg:ml-auto lg:border-b-0 lg:border-l">
          <div className="flex h-9 flex-1 items-center justify-center gap-1.5 border-r border-gray-200 px-3 lg:flex-none lg:justify-start">
            <span className="text-gray-400">Trades</span>
            <span className="tabular-nums text-gray-600">{closedDeals.length}</span>
          </div>
          <div className="flex h-9 flex-1 items-center justify-center gap-1.5 border-r border-gray-200 px-3 lg:flex-none lg:justify-start">
            <span className="text-gray-400">Rows</span>
            <span className="tabular-nums text-gray-600">{pivot.rowKeys.length}</span>
          </div>
          <div className="flex h-9 flex-1 items-center justify-center gap-1.5 px-3 lg:flex-none lg:justify-start">
            <span className="text-gray-400">Cols</span>
            <span className="tabular-nums text-gray-600">{pivot.colKeys.length}</span>
          </div>
        </div>
        <div className="flex items-center">
          <Selector
            icon={<Layers className="h-4 w-4 shrink-0" />}
            label="Rows"
            value={prefs.rowDim}
            options={DIMENSIONS.map((d) => ({ id: d.id, label: d.label }))}
            onChange={(v) => setPrefs((p) => ({ ...p, rowDim: v as DimensionId }))}
          />
          <button
            type="button"
            onClick={swap}
            className="flex h-9 w-9 shrink-0 items-center justify-center border-r border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            aria-label="Swap rows and columns"
          >
            <ArrowLeftRight className="h-4 w-4 shrink-0" />
          </button>
          <Selector
            icon={<Layers className="h-4 w-4 shrink-0 rotate-90" />}
            label="Columns"
            value={prefs.colDim}
            options={DIMENSIONS.map((d) => ({ id: d.id, label: d.label }))}
            onChange={(v) => setPrefs((p) => ({ ...p, colDim: v as DimensionId }))}
          />
          <Selector
            icon={<Sigma className="h-4 w-4 shrink-0" />}
            label="Metric"
            value={prefs.metric}
            options={METRICS.map((m) => ({ id: m.id, label: m.label }))}
            onChange={(v) => setPrefs((p) => ({ ...p, metric: v as MetricId }))}
          />
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div ref={scrollContainerRef} className="flex-1 min-h-0 min-w-0 overflow-auto">
          <PivotTable
            pivot={pivot}
            rowDimLabel={DIMENSIONS.find((d) => d.id === prefs.rowDim)?.label ?? ''}
            colDimLabel={DIMENSIONS.find((d) => d.id === prefs.colDim)?.label ?? ''}
          />
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

interface SelectorProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (next: string) => void;
}

function Selector({ icon, label, value, options, onChange }: SelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

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

  const current = options.find((o) => o.id === value);

  return (
    <div ref={ref} className="relative flex h-9 flex-1 items-center lg:flex-none">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center border-r border-gray-200 text-gray-500">
        {icon}
      </span>
      <span className="hidden h-9 shrink-0 items-center border-r border-gray-200 px-3 text-sm text-gray-400 lg:flex">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 flex-1 items-center justify-between gap-2 border-r border-gray-200 px-3 text-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900 lg:flex-none lg:justify-normal"
      >
        <span>{current?.label ?? ''}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 max-h-80 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {options.map((o) => {
            const checked = o.id === value;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
                className={cn(
                  'relative flex w-full cursor-pointer items-center rounded-none border-b border-gray-200 py-2 pl-3 pr-8 text-left text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 last:border-b-0',
                  checked && 'bg-gray-100 text-gray-900'
                )}
              >
                <span>{o.label}</span>
                {checked && (
                  <span className="absolute right-2 flex h-4 w-3.5 items-center justify-center">
                    <Check className="h-4 w-4" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function colorForCell(value: number | null, signed: boolean, min: number, max: number): string {
  if (value == null || !Number.isFinite(value)) return '';
  if (Math.abs(value) < 0.005 && signed) return '';
  if (signed) {
    const denom = Math.max(Math.abs(min), Math.abs(max), 1);
    const norm = Math.min(1, Math.abs(value) / denom);
    const intensity = Math.round(norm * 4);
    if (value > 0) {
      return ['', 'bg-green-50/60', 'bg-green-100/60', 'bg-green-200/60', 'bg-green-300/60'][intensity];
    }
    return ['', 'bg-red-50/60', 'bg-red-100/60', 'bg-red-200/60', 'bg-red-300/60'][intensity];
  }
  const denom = Math.max(max, 1);
  const norm = Math.min(1, value / denom);
  const intensity = Math.round(norm * 4);
  return ['', 'bg-sky-50/60', 'bg-sky-100/60', 'bg-sky-200/60', 'bg-sky-300/60'][intensity];
}

function textToneForCell(value: number | null, signed: boolean): string {
  if (value == null || !Number.isFinite(value)) return 'text-gray-300';
  if (signed) {
    if (Math.abs(value) < 0.005) return 'text-gray-500';
    return value > 0 ? 'text-green-700' : 'text-red-700';
  }
  return 'text-gray-800';
}

interface PivotTableProps {
  pivot: ReturnType<typeof computePivot>;
  rowDimLabel: string;
  colDimLabel: string;
}

function PivotTable({ pivot, rowDimLabel, colDimLabel }: PivotTableProps) {
  const { rowKeys, colKeys, cells, rowTotals, colTotals, grandTotal, metric, minValue, maxValue } = pivot;

  if (rowKeys.length === 0 || colKeys.length === 0) {
    return (
      <FullPageState
        title="Not enough data for this pivot"
        subtitle="Try a different combination of rows and columns, or expand your filters."
        showSpinner={false}
        icon={<Table2 className="h-6 w-6 text-gray-400 m-2" />}
        className="bg-white"
      />
    );
  }

  return (
    <table className="w-full caption-bottom border-collapse text-sm">
      <thead>
        <tr className="align-middle">
          <th className="sticky left-0 top-0 z-20 border-b border-r border-gray-200 bg-gray-50 px-1.5 py-1.5 text-left align-middle font-medium text-muted-foreground whitespace-nowrap">
            <div>{rowDimLabel}</div>
            <div className="text-gray-400">{colDimLabel}</div>
          </th>
          {colKeys.map((ck) => (
            <th
              key={ck}
              className="sticky top-0 z-10 border-b border-r border-gray-200 bg-gray-50 px-1.5 py-1.5 text-right align-middle font-medium text-muted-foreground whitespace-nowrap"
            >
              {ck}
            </th>
          ))}
          <th className="sticky right-0 top-0 z-20 border-b border-gray-200 bg-gray-100 px-1.5 py-1.5 text-right align-middle font-medium text-muted-foreground whitespace-nowrap">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {rowKeys.map((rk) => {
          const row = cells.get(rk);
          const rowTotal = rowTotals.get(rk) ?? null;
          return (
            <tr key={rk} className="group align-middle">
              <th
                scope="row"
                className="sticky left-0 z-10 border-b border-r border-gray-200 bg-white px-1.5 py-1.5 text-left align-middle font-medium text-muted-foreground whitespace-nowrap group-hover:bg-gray-50"
              >
                {rk}
              </th>
              {colKeys.map((ck) => {
                const v = row?.get(ck) ?? null;
                const bg = colorForCell(v, metric.signed, minValue, maxValue);
                const tone = textToneForCell(v, metric.signed);
                return (
                  <td
                    key={ck}
                    className={cn(
                      'border-b border-r border-gray-200 px-1.5 py-1.5 text-right align-middle tabular-nums',
                      bg,
                      tone
                    )}
                  >
                    {formatMetricValue(metric.id, v)}
                  </td>
                );
              })}
              <td
                className={cn(
                  'sticky right-0 z-10 border-b border-gray-200 bg-gray-100 px-1.5 py-1.5 text-right align-middle font-medium tabular-nums group-hover:bg-gray-200',
                  textToneForCell(rowTotal, metric.signed)
                )}
              >
                {formatMetricValue(metric.id, rowTotal)}
              </td>
            </tr>
          );
        })}
        <tr className="align-middle">
          <th
            scope="row"
            className="sticky bottom-0 left-0 z-20 border-t border-r border-gray-200 bg-gray-100 px-1.5 py-1.5 text-left align-middle font-medium text-muted-foreground whitespace-nowrap"
          >
            Total
          </th>
          {colKeys.map((ck) => {
            const v = colTotals.get(ck) ?? null;
            return (
              <td
                key={ck}
                className={cn(
                  'sticky bottom-0 z-10 border-t border-r border-gray-200 bg-gray-100 px-1.5 py-1.5 text-right align-middle font-medium tabular-nums',
                  textToneForCell(v, metric.signed)
                )}
              >
                {formatMetricValue(metric.id, v)}
              </td>
            );
          })}
          <td
            className={cn(
              'sticky bottom-0 right-0 z-20 border-t border-gray-200 bg-gray-200 px-1.5 py-1.5 text-right align-middle font-medium tabular-nums',
              textToneForCell(grandTotal, metric.signed)
            )}
          >
            {formatMetricValue(metric.id, grandTotal)}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
