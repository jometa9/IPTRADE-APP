'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type {
  EquityPoint,
  DailyBucket,
  SymbolBucket,
  HourBucket,
  WeekdayBucket,
  HourDayCell,
  HistogramBin,
  PeriodCell,
  DurationBucket,
  ScoreBreakdown,
} from './statisticsMath';

const COLOR_GREEN = '#16a34a';
const COLOR_GREEN_SOFT = 'rgba(22, 163, 74, 0.18)';
const COLOR_RED = '#dc2626';
const COLOR_RED_SOFT = 'rgba(220, 38, 38, 0.18)';
const COLOR_GRID = '#e5e7eb';
const COLOR_AXIS = '#9ca3af';
const COLOR_AXIS_STRONG = '#6b7280';

const WEEK_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_LABELS_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatPnlShort(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

function formatPnlSigned(v: number): string {
  if (Math.abs(v) < 0.005) return '0.00';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateShort(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateLong(ms: number): string {
  const d = new Date(ms);
  return `${WEEK_LABELS[d.getDay()]} ${MONTH_LABELS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatVolume(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (v >= 100) return v.toFixed(0);
  return v.toFixed(2);
}


interface TooltipState {
  x: number;
  y: number;
  content: React.ReactNode;
}

const TOOLTIP_PAD = 10;

function ChartTooltip({
  state,
  containerWidth,
}: {
  state: TooltipState | null;
  containerWidth: number;
}) {
  if (!state) return null;
  const left =
    containerWidth > 0
      ? Math.max(TOOLTIP_PAD, Math.min(containerWidth - TOOLTIP_PAD, state.x))
      : state.x;
  return (
    <div
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full rounded-md border border-gray-200 bg-white/95 px-2.5 py-1.5 text-[11px] text-gray-700 backdrop-blur-sm"
      style={{ left, top: state.y - 8 }}
    >
      {state.content}
    </div>
  );
}

function useTooltipContainer() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const showAt = (e: { clientX: number; clientY: number }, content: React.ReactNode) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      content,
    });
  };
  const hide = () => setTooltip(null);
  return { ref, tooltip, width, showAt, hide };
}

function TooltipRow({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-gray-500">{label}</span>
      <span className={cn('tabular-nums font-medium text-gray-900', valueClass)}>{value}</span>
    </div>
  );
}


interface ResponsiveSvgProps {
  height?: number;
  className?: string;
  children: (width: number, height: number) => React.ReactNode;
}

function ResponsiveSvg({ height, className, children }: ResponsiveSvgProps) {
  const fill = height == null;
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = fill ? Math.round(rect.height) : (height as number);
      setSize((prev) =>
        Math.abs(prev.width - w) < 0.5 && Math.abs(prev.height - h) < 0.5 ? prev : { width: w, height: h }
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill, height]);
  return (
    <div
      ref={ref}
      className={cn('w-full', fill && 'h-full', className)}
      style={fill ? undefined : { height }}
    >
      {size.width > 0 && size.height > 0 && (
        <svg
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          style={{ display: 'block' }}
        >
          {children(size.width, size.height)}
        </svg>
      )}
    </div>
  );
}


interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
  bodyFlush?: boolean;
}

export function ChartCard({ title, subtitle, children, className, action, bodyFlush }: ChartCardProps) {
  return (
    <div className={cn('border-r border-b border-gray-200 flex flex-col', className)}>
      <div className="px-3 pt-3 pb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase  text-gray-500">{title}</div>
          {subtitle && <div className="mt-0.5 text-[11px] text-gray-400 truncate">{subtitle}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={cn('flex-1 min-h-0', bodyFlush ? '' : 'px-3 pb-3')}>{children}</div>
    </div>
  );
}


export function EquityCurveChart({ points }: { points: EquityPoint[] }) {
  if (points.length === 0) return <EmptyChart />;

  const minTime = points[0].timeMs;
  const maxTime = points[points.length - 1].timeMs;
  const minY = Math.min(0, ...points.map((p) => p.cumulative));
  const maxY = Math.max(0, ...points.map((p) => p.cumulative));
  const yPad = (maxY - minY) * 0.08 || 1;
  const yMin = minY - yPad;
  const yMax = maxY + yPad;

  let peakIdx = 0;
  let lowIdx = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].cumulative > points[peakIdx].cumulative) peakIdx = i;
    if (points[i].cumulative < points[lowIdx].cumulative) lowIdx = i;
  }
  const last = points[points.length - 1];
  const lastValue = last.cumulative;
  const positive = lastValue >= 0;
  const stroke = positive ? COLOR_GREEN : COLOR_RED;

  const padL = 36;
  const padR = 14;
  const padT = 14;
  const padB = 26;

  return (
    <ResponsiveSvg>
      {(W, H) => {
        const innerW = W - padL - padR;
        const innerH = H - padT - padB;
        const timeSpan = Math.max(1, maxTime - minTime);
        const ySpan = Math.max(1, yMax - yMin);
        const x = (t: number) => padL + ((t - minTime) / timeSpan) * innerW;
        const y = (v: number) => padT + (1 - (v - yMin) / ySpan) * innerH;
        const yZero = y(0);

        const linePath = points
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.timeMs).toFixed(2)},${y(p.cumulative).toFixed(2)}`)
          .join(' ');
        const areaPath = `${linePath} L${x(maxTime).toFixed(2)},${yZero.toFixed(2)} L${x(minTime).toFixed(2)},${yZero.toFixed(2)} Z`;

        const ticks = niceTicks(yMin, yMax, 5);
        const xTicks = niceTimeTicks(minTime, maxTime, 5);

        const peak = points[peakIdx];
        const low = points[lowIdx];

        return (
          <>
            <defs>
              <linearGradient id="equity-pos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_GREEN} stopOpacity={0.35} />
                <stop offset="100%" stopColor={COLOR_GREEN} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="equity-neg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_RED} stopOpacity={0.32} />
                <stop offset="100%" stopColor={COLOR_RED} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <g key={`gy-${t}`}>
                <line
                  x1={padL}
                  x2={W - padR}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={COLOR_GRID}
                  strokeWidth={1}
                  strokeDasharray={t === 0 ? '0' : '3 3'}
                />
                <text x={padL - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill={COLOR_AXIS}>
                  {formatPnlShort(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text
                key={`gx-${t}`}
                x={x(t)}
                y={H - 8}
                textAnchor="middle"
                fontSize={10}
                fill={COLOR_AXIS}
              >
                {formatDateShort(t)}
              </text>
            ))}
            <path d={areaPath} fill={positive ? 'url(#equity-pos)' : 'url(#equity-neg)'} />
            <path d={linePath} fill="none" stroke={stroke} strokeWidth={2.75} strokeLinejoin="round" strokeLinecap="round" />

            {peak.cumulative > 0.005 && peakIdx !== points.length - 1 && (
              <g>
                <circle cx={x(peak.timeMs)} cy={y(peak.cumulative)} r={4} fill="#fff" stroke={COLOR_GREEN} strokeWidth={2.25} />
                <text
                  x={x(peak.timeMs)}
                  y={y(peak.cumulative) - 8}
                  textAnchor="middle"
                  fontSize={10}
                  fontWeight={600}
                  fill={COLOR_GREEN}
                >
                  {formatPnlShort(peak.cumulative)}
                </text>
              </g>
            )}
            {low.cumulative < -0.005 && lowIdx !== peakIdx && (
              <g>
                <circle cx={x(low.timeMs)} cy={y(low.cumulative)} r={4} fill="#fff" stroke={COLOR_RED} strokeWidth={2.25} />
              </g>
            )}
            <circle cx={x(last.timeMs)} cy={y(last.cumulative)} r={4.5} fill={stroke} stroke="#fff" strokeWidth={2.25} />
          </>
        );
      }}
    </ResponsiveSvg>
  );
}


export function DailyPnlBarsChart({ data, height = 200 }: { data: DailyBucket[]; height?: number }) {
  const { ref, tooltip, width, showAt, hide } = useTooltipContainer();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  if (data.length === 0) return <EmptyChart />;

  const minY = Math.min(0, ...data.map((d) => d.net));
  const maxY = Math.max(0, ...data.map((d) => d.net));
  const yPad = (maxY - minY) * 0.08 || 1;
  const yMin = minY - yPad;
  const yMax = maxY + yPad;

  const padL = 36;
  const padR = 14;
  const padT = 12;
  const padB = 26;

  return (
    <div ref={ref} className="relative" style={{ height }}>
      <ResponsiveSvg height={height}>
        {(W) => {
          const innerW = W - padL - padR;
          const innerH = height - padT - padB;
          const ySpan = Math.max(1, yMax - yMin);
          const y = (v: number) => padT + (1 - (v - yMin) / ySpan) * innerH;
          const yZero = y(0);
          const slot = innerW / data.length;
          const barW = Math.max(2, slot * 0.72);
          const ticks = niceTicks(yMin, yMax, 4);
          const targetXTicks = Math.max(3, Math.min(8, Math.floor(W / 90)));
          const stride = Math.max(1, Math.floor(data.length / targetXTicks));

          return (
            <>
              {ticks.map((t) => (
                <g key={`gy-${t}`}>
                  <line
                    x1={padL}
                    x2={W - padR}
                    y1={y(t)}
                    y2={y(t)}
                    stroke={COLOR_GRID}
                    strokeWidth={1}
                    strokeDasharray={t === 0 ? '0' : '3 3'}
                  />
                  <text x={padL - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill={COLOR_AXIS}>
                    {formatPnlShort(t)}
                  </text>
                </g>
              ))}
              {data.map((d, i) => {
                const cx = padL + slot * (i + 0.5);
                const top = d.net >= 0 ? y(d.net) : yZero;
                const h = Math.max(1, Math.abs(yZero - y(d.net)));
                const isHovered = hoveredKey === d.dayKey;
                const positive = d.net >= 0;
                const empty = d.trades === 0;
                const avg = d.trades > 0 ? d.net / d.trades : 0;
                const content = (
                  <div className="flex flex-col gap-0.5 min-w-[170px]">
                    <div className="font-semibold text-gray-900">{formatDateLong(d.dayMs)}</div>
                    {empty ? (
                      <div className="text-gray-500">No trades on this day</div>
                    ) : (
                      <>
                        <TooltipRow
                          label="Net P&L"
                          value={formatPnlSigned(d.net)}
                          valueClass={positive ? 'text-green-700' : d.net < 0 ? 'text-red-700' : ''}
                        />
                        <TooltipRow label="Trades" value={d.trades} />
                        <TooltipRow label="Avg / trade" value={formatPnlSigned(avg)} />
                      </>
                    )}
                  </div>
                );
                return (
                  <g key={d.dayKey}>
                    <rect
                      x={cx - barW / 2}
                      y={top}
                      width={barW}
                      height={h}
                      fill={positive ? COLOR_GREEN : COLOR_RED}
                      opacity={empty ? 0 : isHovered ? 1 : 0.88}
                      style={{ transition: 'opacity 120ms ease' }}
                    />
                    <rect
                      x={cx - slot / 2}
                      y={padT}
                      width={slot}
                      height={innerH}
                      fill="transparent"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => {
                        setHoveredKey(d.dayKey);
                        showAt(e, content);
                      }}
                      onMouseMove={(e) => showAt(e, content)}
                      onMouseLeave={() => {
                        setHoveredKey(null);
                        hide();
                      }}
                    />
                  </g>
                );
              })}
              {data
                .map((d, i) => ({ d, i }))
                .filter(({ i }) => i % stride === 0 || i === data.length - 1)
                .map(({ d, i }) => {
                  const cx = padL + slot * (i + 0.5);
                  return (
                    <text
                      key={`xt-${d.dayKey}`}
                      x={cx}
                      y={height - 8}
                      textAnchor="middle"
                      fontSize={10}
                      fill={COLOR_AXIS}
                    >
                      {formatDateShort(d.dayMs)}
                    </text>
                  );
                })}
            </>
          );
        }}
      </ResponsiveSvg>
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}


export function DrawdownChart({ points, height = 180 }: { points: EquityPoint[]; height?: number }) {
  if (points.length === 0) return <EmptyChart />;
  const minTime = points[0].timeMs;
  const maxTime = points[points.length - 1].timeMs;
  const minDD = Math.min(0, ...points.map((p) => p.drawdown));
  const yMin = minDD * 1.08 || -1;
  const yMax = 0;

  const padL = 36;
  const padR = 14;
  const padT = 10;
  const padB = 26;

  return (
    <ResponsiveSvg height={height}>
      {(W) => {
        const innerW = W - padL - padR;
        const innerH = height - padT - padB;
        const timeSpan = Math.max(1, maxTime - minTime);
        const ySpan = Math.max(1, yMax - yMin);
        const x = (t: number) => padL + ((t - minTime) / timeSpan) * innerW;
        const y = (v: number) => padT + (1 - (v - yMin) / ySpan) * innerH;
        const yZero = y(0);
        const linePath = points
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.timeMs).toFixed(2)},${y(p.drawdown).toFixed(2)}`)
          .join(' ');
        const areaPath = `${linePath} L${x(maxTime).toFixed(2)},${yZero.toFixed(2)} L${x(minTime).toFixed(2)},${yZero.toFixed(2)} Z`;
        const ticks = niceTicks(yMin, 0, 3);
        const xTicks = niceTimeTicks(minTime, maxTime, 5);

        return (
          <>
            <defs>
              <linearGradient id="dd-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_RED} stopOpacity={0.05} />
                <stop offset="100%" stopColor={COLOR_RED} stopOpacity={0.32} />
              </linearGradient>
            </defs>
            {ticks.map((t) => (
              <g key={`gy-${t}`}>
                <line
                  x1={padL}
                  x2={W - padR}
                  y1={y(t)}
                  y2={y(t)}
                  stroke={COLOR_GRID}
                  strokeWidth={1}
                  strokeDasharray={t === 0 ? '0' : '3 3'}
                />
                <text x={padL - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill={COLOR_AXIS}>
                  {formatPnlShort(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={`gx-${t}`} x={x(t)} y={height - 8} textAnchor="middle" fontSize={10} fill={COLOR_AXIS}>
                {formatDateShort(t)}
              </text>
            ))}
            <path d={areaPath} fill="url(#dd-grad)" />
            <path d={linePath} fill="none" stroke={COLOR_RED} strokeWidth={2.75} strokeLinejoin="round" strokeLinecap="round" />
          </>
        );
      }}
    </ResponsiveSvg>
  );
}


export function SymbolBarsChart({ data, max = 10 }: { data: SymbolBucket[]; max?: number }) {
  const { ref, tooltip, width, showAt, hide } = useTooltipContainer();
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);

  if (data.length === 0) return <EmptyChart />;
  const slice = data.slice(0, max);
  const maxAbs = Math.max(1, ...slice.map((s) => Math.abs(s.net)));
  return (
    <div ref={ref} className="relative">
      <div className="flex flex-col gap-1.5">
        {slice.map((s) => {
          const pct = (Math.abs(s.net) / maxAbs) * 100;
          const positive = s.net >= 0;
          const isHovered = hoveredSymbol === s.symbol;
          const avg = s.trades > 0 ? s.net / s.trades : 0;
          const content = (
            <div className="flex flex-col gap-0.5 min-w-[200px]">
              <div className="font-semibold text-gray-900">{s.symbol}</div>
              <TooltipRow
                label="Net P&L"
                value={formatPnlSigned(s.net)}
                valueClass={positive ? 'text-green-700' : s.net < 0 ? 'text-red-700' : ''}
              />
              <TooltipRow label="Trades" value={s.trades} />
              <TooltipRow
                label="Wins / Losses"
                value={
                  <>
                    <span className="text-green-700">{s.wins}</span>
                    <span className="text-gray-400"> / </span>
                    <span className="text-red-700">{s.losses}</span>
                  </>
                }
              />
              <TooltipRow label="Win rate" value={`${s.winRate.toFixed(1)}%`} />
              <TooltipRow label="Avg / trade" value={formatPnlSigned(avg)} />
              <TooltipRow label="Volume" value={formatVolume(s.volume)} />
            </div>
          );
          return (
            <div
              key={s.symbol}
              className="flex items-center gap-3 text-xs"
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => {
                setHoveredSymbol(s.symbol);
                showAt(e, content);
              }}
              onMouseMove={(e) => showAt(e, content)}
              onMouseLeave={() => {
                setHoveredSymbol(null);
                hide();
              }}
            >
              <div className="w-20 shrink-0 truncate text-[12px] font-semibold text-gray-800">
                {s.symbol}
              </div>
              <div className="relative flex-1 h-7 bg-gray-100 overflow-hidden">
                <div
                  className={cn(
                    'absolute inset-y-0 left-0 transition-all',
                    positive ? 'bg-green-500/85' : 'bg-red-500/85',
                    isHovered && (positive ? 'bg-green-600' : 'bg-red-600')
                  )}
                  style={{ width: `${pct}%` }}
                />
                <div className="absolute inset-0 flex items-center justify-between px-2.5">
                  <span className="inline-flex items-center gap-1.5 text-[10px] tabular-nums">
                    <span className="font-medium text-gray-700">{s.trades}t</span>
                    <span
                      className={cn(
                        'px-1 py-px text-[9px] font-semibold',
                        s.winRate >= 60
                          ? 'bg-green-100 text-green-700'
                          : s.winRate >= 45
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-red-100 text-red-700'
                      )}
                    >
                      {s.winRate.toFixed(0)}%
                    </span>
                  </span>
                  <span
                    className={cn(
                      'text-[11px] font-bold tabular-nums',
                      positive ? 'text-green-800' : 'text-red-800'
                    )}
                  >
                    {formatPnlSigned(s.net)}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}


export function HourBarsChart({ data, height = 160 }: { data: HourBucket[]; height?: number }) {
  const { ref, tooltip, width, showAt, hide } = useTooltipContainer();
  const [hoveredHour, setHoveredHour] = useState<number | null>(null);

  if (data.every((d) => d.trades === 0)) return <EmptyChart />;
  const minY = Math.min(0, ...data.map((d) => d.net));
  const maxY = Math.max(0, ...data.map((d) => d.net));
  const yPad = (maxY - minY) * 0.08 || 1;
  const yMin = minY - yPad;
  const yMax = maxY + yPad;

  const padL = 32;
  const padR = 12;
  const padT = 10;
  const padB = 26;

  return (
    <div ref={ref} className="relative" style={{ height }}>
      <ResponsiveSvg height={height}>
        {(W) => {
          const innerW = W - padL - padR;
          const innerH = height - padT - padB;
          const ySpan = Math.max(1, yMax - yMin);
          const y = (v: number) => padT + (1 - (v - yMin) / ySpan) * innerH;
          const yZero = y(0);
          const slot = innerW / 24;
          const barW = slot * 0.72;
          const ticks = niceTicks(yMin, yMax, 3);
          const labelHours = W < 360 ? [0, 12, 23] : [0, 6, 12, 18, 23];

          return (
            <>
              {ticks.map((t) => (
                <g key={`gy-${t}`}>
                  <line
                    x1={padL}
                    x2={W - padR}
                    y1={y(t)}
                    y2={y(t)}
                    stroke={COLOR_GRID}
                    strokeWidth={1}
                    strokeDasharray={t === 0 ? '0' : '3 3'}
                  />
                  <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill={COLOR_AXIS}>
                    {formatPnlShort(t)}
                  </text>
                </g>
              ))}
              {data.map((d) => {
                const cx = padL + slot * (d.hour + 0.5);
                const top = d.net >= 0 ? y(d.net) : yZero;
                const h = Math.max(1, Math.abs(yZero - y(d.net)));
                const isHovered = hoveredHour === d.hour;
                const positive = d.net >= 0;
                const avg = d.trades > 0 ? d.net / d.trades : 0;
                const hourLabel = `${String(d.hour).padStart(2, '0')}:00 — ${String(d.hour).padStart(2, '0')}:59`;
                const content = (
                  <div className="flex flex-col gap-0.5 min-w-[170px]">
                    <div className="font-semibold text-gray-900">{hourLabel}</div>
                    {d.trades === 0 ? (
                      <div className="text-gray-500">No trades in this hour</div>
                    ) : (
                      <>
                        <TooltipRow
                          label="Net P&L"
                          value={formatPnlSigned(d.net)}
                          valueClass={positive ? 'text-green-700' : d.net < 0 ? 'text-red-700' : ''}
                        />
                        <TooltipRow label="Trades" value={d.trades} />
                        <TooltipRow label="Avg / trade" value={formatPnlSigned(avg)} />
                      </>
                    )}
                  </div>
                );
                const empty = d.trades === 0;
                return (
                  <g key={d.hour}>
                    <rect
                      x={cx - barW / 2}
                      y={top}
                      width={barW}
                      height={h}
                      fill={positive ? COLOR_GREEN : COLOR_RED}
                      opacity={empty ? 0 : isHovered ? 1 : 0.88}
                      style={{ transition: 'opacity 120ms ease' }}
                    />
                    <rect
                      x={cx - slot / 2}
                      y={padT}
                      width={slot}
                      height={innerH}
                      fill="transparent"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => {
                        setHoveredHour(d.hour);
                        showAt(e, content);
                      }}
                      onMouseMove={(e) => showAt(e, content)}
                      onMouseLeave={() => {
                        setHoveredHour(null);
                        hide();
                      }}
                    />
                  </g>
                );
              })}
              {labelHours.map((h) => {
                const cx = padL + slot * (h + 0.5);
                return (
                  <text key={`xt-${h}`} x={cx} y={height - 8} textAnchor="middle" fontSize={10} fill={COLOR_AXIS}>
                    {String(h).padStart(2, '0')}h
                  </text>
                );
              })}
            </>
          );
        }}
      </ResponsiveSvg>
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}


export function WeekdayBarsChart({ data, height = 160 }: { data: WeekdayBucket[]; height?: number }) {
  const { ref, tooltip, width, showAt, hide } = useTooltipContainer();
  const [hoveredDay, setHoveredDay] = useState<number | null>(null);

  if (data.every((d) => d.trades === 0)) return <EmptyChart />;
  const minY = Math.min(0, ...data.map((d) => d.net));
  const maxY = Math.max(0, ...data.map((d) => d.net));
  const yPad = (maxY - minY) * 0.08 || 1;
  const yMin = minY - yPad;
  const yMax = maxY + yPad;

  const padL = 32;
  const padR = 12;
  const padT = 10;
  const padB = 26;

  return (
    <div ref={ref} className="relative" style={{ height }}>
      <ResponsiveSvg height={height}>
        {(W) => {
          const innerW = W - padL - padR;
          const innerH = height - padT - padB;
          const ySpan = Math.max(1, yMax - yMin);
          const y = (v: number) => padT + (1 - (v - yMin) / ySpan) * innerH;
          const yZero = y(0);
          const slot = innerW / 7;
          const barW = slot * 0.62;
          const ticks = niceTicks(yMin, yMax, 3);

          return (
            <>
              {ticks.map((t) => (
                <g key={`gy-${t}`}>
                  <line
                    x1={padL}
                    x2={W - padR}
                    y1={y(t)}
                    y2={y(t)}
                    stroke={COLOR_GRID}
                    strokeWidth={1}
                    strokeDasharray={t === 0 ? '0' : '3 3'}
                  />
                  <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill={COLOR_AXIS}>
                    {formatPnlShort(t)}
                  </text>
                </g>
              ))}
              {data.map((d) => {
                const cx = padL + slot * (d.weekday + 0.5);
                const top = d.net >= 0 ? y(d.net) : yZero;
                const h = Math.max(1, Math.abs(yZero - y(d.net)));
                const isHovered = hoveredDay === d.weekday;
                const positive = d.net >= 0;
                const avg = d.trades > 0 ? d.net / d.trades : 0;
                const empty = d.trades === 0;
                const content = (
                  <div className="flex flex-col gap-0.5 min-w-[170px]">
                    <div className="font-semibold text-gray-900">{WEEK_LABELS_FULL[d.weekday]}</div>
                    {empty ? (
                      <div className="text-gray-500">No trades on this day</div>
                    ) : (
                      <>
                        <TooltipRow
                          label="Net P&L"
                          value={formatPnlSigned(d.net)}
                          valueClass={positive ? 'text-green-700' : d.net < 0 ? 'text-red-700' : ''}
                        />
                        <TooltipRow label="Trades" value={d.trades} />
                        <TooltipRow label="Avg / trade" value={formatPnlSigned(avg)} />
                      </>
                    )}
                  </div>
                );
                return (
                  <g key={d.weekday}>
                    <rect
                      x={cx - barW / 2}
                      y={top}
                      width={barW}
                      height={h}
                      fill={positive ? COLOR_GREEN : COLOR_RED}
                      opacity={empty ? 0.15 : isHovered ? 1 : 0.88}
                      style={{ transition: 'opacity 120ms ease' }}
                    />
                    <rect
                      x={cx - slot / 2}
                      y={padT}
                      width={slot}
                      height={innerH}
                      fill="transparent"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => {
                        setHoveredDay(d.weekday);
                        showAt(e, content);
                      }}
                      onMouseMove={(e) => showAt(e, content)}
                      onMouseLeave={() => {
                        setHoveredDay(null);
                        hide();
                      }}
                    />
                    <text x={cx} y={height - 8} textAnchor="middle" fontSize={10} fill={COLOR_AXIS_STRONG}>
                      {WEEK_LABELS[d.weekday]}
                    </text>
                  </g>
                );
              })}
            </>
          );
        }}
      </ResponsiveSvg>
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}


export function HourDayHeatmap({ cells }: { cells: HourDayCell[] }) {
  const { ref, tooltip, width, showAt, hide } = useTooltipContainer();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const { maxPos, maxNeg } = useMemo(() => {
    let pos = 0;
    let neg = 0;
    for (const c of cells) {
      if (c.net > pos) pos = c.net;
      if (-c.net > neg) neg = -c.net;
    }
    return { maxPos: pos, maxNeg: neg };
  }, [cells]);

  if (maxPos === 0 && maxNeg === 0) return <EmptyChart />;

  return (
    <div ref={ref} className="relative">
      <div className="overflow-x-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: '38px repeat(24, minmax(14px, 1fr))',
            gap: 2,
            minWidth: 24 * 14 + 38,
          }}
        >
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={`h-${h}`} className="text-[9px] text-center text-gray-400">
              {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
            </div>
          ))}
          {WEEK_LABELS.map((label, w) => (
            <div key={`row-${w}`} className="contents">
              <div className="text-[10px] font-medium text-gray-500 pr-1 flex items-center">{label}</div>
              {Array.from({ length: 24 }, (_, h) => {
                const cell = cells.find((c) => c.weekday === w && c.hour === h);
                const net = cell?.net ?? 0;
                const trades = cell?.trades ?? 0;
                const intensity =
                  net > 0
                    ? maxPos > 0
                      ? Math.min(1, net / maxPos)
                      : 0
                    : net < 0
                    ? maxNeg > 0
                      ? Math.min(1, -net / maxNeg)
                      : 0
                    : 0;
                const bg =
                  trades === 0
                    ? '#f3f4f6'
                    : net > 0
                    ? `rgba(22, 163, 74, ${0.18 + intensity * 0.7})`
                    : net < 0
                    ? `rgba(220, 38, 38, ${0.18 + intensity * 0.7})`
                    : '#f3f4f6';
                const cellKey = `${w}-${h}`;
                const isHovered = hoveredKey === cellKey;
                const positive = net >= 0;
                const avg = trades > 0 ? net / trades : 0;
                const hourLabel = `${String(h).padStart(2, '0')}:00 — ${String(h).padStart(2, '0')}:59`;
                const content = (
                  <div className="flex flex-col gap-0.5 min-w-[180px]">
                    <div className="font-semibold text-gray-900">
                      {WEEK_LABELS_FULL[w]} {hourLabel}
                    </div>
                    {trades === 0 ? (
                      <div className="text-gray-500">No trades in this slot</div>
                    ) : (
                      <>
                        <TooltipRow
                          label="Net P&L"
                          value={formatPnlSigned(net)}
                          valueClass={positive ? 'text-green-700' : net < 0 ? 'text-red-700' : ''}
                        />
                        <TooltipRow label="Trades" value={trades} />
                        <TooltipRow label="Avg / trade" value={formatPnlSigned(avg)} />
                      </>
                    )}
                  </div>
                );
                return (
                  <div
                    key={`c-${w}-${h}`}
                    style={{
                      background: bg,
                      height: 22,
                      cursor: 'pointer',
                      outline: isHovered ? '1.5px solid #d1d5db' : 'none',
                      outlineOffset: isHovered ? '-1.5px' : 0,
                      transition: 'outline 100ms ease',
                    }}
                    onMouseEnter={(e) => {
                      setHoveredKey(cellKey);
                      showAt(e, content);
                    }}
                    onMouseMove={(e) => showAt(e, content)}
                    onMouseLeave={() => {
                      setHoveredKey(null);
                      hide();
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}


export function HeatmapLegend() {
  return (
    <div className="flex items-center gap-2 text-[10px] text-gray-500">
      <span>Loss</span>
      <div
        className="h-2 w-32"
        style={{
          background:
            'linear-gradient(to right, rgba(220,38,38,0.85) 0%, rgba(220,38,38,0.18) 45%, #f3f4f6 50%, rgba(22,163,74,0.18) 55%, rgba(22,163,74,0.85) 100%)',
        }}
      />
      <span>Profit</span>
    </div>
  );
}


export function HistogramChart({ bins, height = 180 }: { bins: HistogramBin[]; height?: number }) {
  const { ref, tooltip, width, showAt, hide } = useTooltipContainer();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (bins.length === 0) return <EmptyChart />;
  const padL = 28;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  const totalCount = bins.reduce((s, b) => s + b.count, 0);

  return (
    <div ref={ref} className="relative" style={{ height }}>
      <ResponsiveSvg height={height}>
        {(W) => {
          const innerW = W - padL - padR;
          const innerH = height - padT - padB;
          const maxC = Math.max(1, ...bins.map((b) => b.count));
          const slot = innerW / bins.length;
          const ticks = [0, Math.round(maxC / 2), maxC];
          return (
            <>
              {ticks.map((t) => (
                <g key={`gy-${t}`}>
                  <line
                    x1={padL}
                    x2={W - padR}
                    y1={padT + innerH - (t / maxC) * innerH}
                    y2={padT + innerH - (t / maxC) * innerH}
                    stroke={COLOR_GRID}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  <text
                    x={padL - 6}
                    y={padT + innerH - (t / maxC) * innerH + 3}
                    textAnchor="end"
                    fontSize={9}
                    fill={COLOR_AXIS}
                  >
                    {t}
                  </text>
                </g>
              ))}
              {bins.map((b, i) => {
                const cx = padL + slot * (i + 0.5);
                const h = (b.count / maxC) * innerH;
                const isPositive = b.lo + (b.hi - b.lo) / 2 >= 0;
                const isHovered = hoveredIdx === i;
                const pct = totalCount > 0 ? (b.count / totalCount) * 100 : 0;
                const content = (
                  <div className="flex flex-col gap-0.5 min-w-[180px]">
                    <div className="font-semibold text-gray-900">
                      {formatPnlSigned(b.lo)} → {formatPnlSigned(b.hi)}
                    </div>
                    {b.count === 0 ? (
                      <div className="text-gray-500">No trades in this range</div>
                    ) : (
                      <>
                        <TooltipRow
                          label="Trades"
                          value={b.count}
                          valueClass={isPositive ? 'text-green-700' : 'text-red-700'}
                        />
                        <TooltipRow label="Share" value={`${pct.toFixed(1)}%`} />
                      </>
                    )}
                  </div>
                );
                return (
                  <g key={i}>
                    <rect
                      x={cx - slot * 0.42}
                      y={padT + innerH - h}
                      width={slot * 0.84}
                      height={h}
                      fill={isPositive ? COLOR_GREEN : COLOR_RED}
                      opacity={isHovered ? 1 : 0.85}
                      style={{ transition: 'opacity 120ms ease' }}
                    />
                    <rect
                      x={cx - slot / 2}
                      y={padT}
                      width={slot}
                      height={innerH}
                      fill="transparent"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => {
                        setHoveredIdx(i);
                        showAt(e, content);
                      }}
                      onMouseMove={(e) => showAt(e, content)}
                      onMouseLeave={() => {
                        setHoveredIdx(null);
                        hide();
                      }}
                    />
                  </g>
                );
              })}
              <text x={padL} y={height - 8} textAnchor="start" fontSize={10} fill={COLOR_AXIS}>
                {formatPnlShort(bins[0].lo)}
              </text>
              <text x={padL + innerW / 2} y={height - 8} textAnchor="middle" fontSize={10} fill={COLOR_AXIS_STRONG}>
                0
              </text>
              <text x={W - padR} y={height - 8} textAnchor="end" fontSize={10} fill={COLOR_AXIS}>
                {formatPnlShort(bins[bins.length - 1].hi)}
              </text>
            </>
          );
        }}
      </ResponsiveSvg>
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}


export function PeriodHeatmap({ cells }: { cells: PeriodCell[] }) {
  const { ref, tooltip, width, showAt, hide } = useTooltipContainer();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const { maxPos, maxNeg } = useMemo(() => {
    let pos = 0;
    let neg = 0;
    for (const c of cells) {
      if (!c.inRange) continue;
      if (c.net > pos) pos = c.net;
      if (-c.net > neg) neg = -c.net;
    }
    return { maxPos: pos, maxNeg: neg };
  }, [cells]);

  const weeks: PeriodCell[][] = useMemo(() => {
    const out: PeriodCell[][] = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [cells]);

  const monthLabelPositions = useMemo(() => {
    const out: { weekIndex: number; label: string }[] = [];
    let lastMonth = -1;
    weeks.forEach((week, i) => {
      const firstDay = week[0];
      if (!firstDay) return;
      const m = new Date(firstDay.dayMs).getMonth();
      if (m !== lastMonth) {
        out.push({ weekIndex: i, label: MONTH_LABELS[m] });
        lastMonth = m;
      }
    });
    return out;
  }, [weeks]);

  if (cells.length === 0) return <EmptyChart />;

  const LABEL_COL = 38;
  const GAP = 2;
  const MIN_CELL = 12;
  const MAX_ROW_HEIGHT = 36;
  const available = Math.max(0, width - LABEL_COL - GAP * weeks.length);
  const computedCellWidth = weeks.length > 0 ? available / weeks.length : 0;
  const cellHeight =
    width === 0
      ? weeks.length <= 8
        ? 28
        : weeks.length <= 14
        ? 22
        : weeks.length <= 28
        ? 18
        : 14
      : Math.max(MIN_CELL, Math.min(MAX_ROW_HEIGHT, Math.floor(computedCellWidth)));
  const labelHeight = Math.max(12, cellHeight - 4);

  return (
    <div ref={ref} className="relative">
      <div className="overflow-x-auto">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `${LABEL_COL}px repeat(${weeks.length}, minmax(${MIN_CELL}px, 1fr))`,
            gridTemplateRows: `${labelHeight}px repeat(7, ${cellHeight}px)`,
            gap: GAP,
            minWidth: weeks.length * MIN_CELL + LABEL_COL,
          }}
        >
          <div />
          {weeks.map((_, i) => {
            const lbl = monthLabelPositions.find((p) => p.weekIndex === i);
            return (
              <div key={`mh-${i}`} className="text-[10px] font-medium text-gray-500 flex items-center">
                {lbl?.label ?? ''}
              </div>
            );
          })}
          {WEEK_LABELS.map((label, w) => (
            <div key={`row-${w}`} className="contents">
              <div className="text-[10px] font-medium text-gray-500 pr-1 flex items-center">
                {label}
              </div>
              {weeks.map((week, wi) => {
                const cell = week[w];
                if (!cell) return <div key={`empty-${wi}-${w}`} />;
                const outOfRange = !cell.inRange;
                const intensity =
                  outOfRange
                    ? 0
                    : cell.net > 0
                    ? maxPos > 0
                      ? Math.min(1, cell.net / maxPos)
                      : 0
                    : cell.net < 0
                    ? maxNeg > 0
                      ? Math.min(1, -cell.net / maxNeg)
                      : 0
                    : 0;
                const bg = outOfRange
                  ? 'rgba(243, 244, 246, 0.45)'
                  : cell.trades === 0
                  ? '#f3f4f6'
                  : cell.net > 0
                  ? `rgba(22, 163, 74, ${0.18 + intensity * 0.7})`
                  : cell.net < 0
                  ? `rgba(220, 38, 38, ${0.18 + intensity * 0.7})`
                  : '#f3f4f6';
                const cellKey = `${wi}-${w}`;
                const isHovered = hoveredKey === cellKey;
                const positive = cell.net >= 0;
                const avg = cell.trades > 0 ? cell.net / cell.trades : 0;
                const content = (
                  <div className="flex flex-col gap-0.5 min-w-[180px]">
                    <div className="font-semibold text-gray-900">{formatDateLong(cell.dayMs)}</div>
                    {outOfRange ? (
                      <div className="text-gray-500">Outside selected filter range</div>
                    ) : cell.trades === 0 ? (
                      <div className="text-gray-500">No trades on this day</div>
                    ) : (
                      <>
                        <TooltipRow
                          label="Net P&L"
                          value={formatPnlSigned(cell.net)}
                          valueClass={positive ? 'text-green-700' : cell.net < 0 ? 'text-red-700' : ''}
                        />
                        <TooltipRow
                          label="Trades"
                          value={`${cell.trades} trade${cell.trades === 1 ? '' : 's'}`}
                        />
                        <TooltipRow label="Avg / trade" value={formatPnlSigned(avg)} />
                      </>
                    )}
                  </div>
                );
                return (
                  <div
                    key={`c-${wi}-${w}`}
                    style={{
                      background: bg,
                      opacity: outOfRange ? 0.35 : 1,
                      cursor: 'pointer',
                      outline: isHovered ? '1.5px solid #d1d5db' : 'none',
                      outlineOffset: isHovered ? '-1.5px' : 0,
                      transition: 'outline 100ms ease',
                    }}
                    onMouseEnter={(e) => {
                      setHoveredKey(cellKey);
                      showAt(e, content);
                    }}
                    onMouseMove={(e) => showAt(e, content)}
                    onMouseLeave={() => {
                      setHoveredKey(null);
                      hide();
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}


export function DurationBarsChart({
  data,
  height = 200,
}: {
  data: DurationBucket[];
  height?: number;
}) {
  const { ref, tooltip, width, showAt, hide } = useTooltipContainer();
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null);

  const totalTrades = data.reduce((s, b) => s + b.trades, 0);
  if (totalTrades === 0) return <EmptyChart />;

  const minY = Math.min(0, ...data.map((d) => d.net));
  const maxY = Math.max(0, ...data.map((d) => d.net));
  const yPad = (maxY - minY) * 0.15 || 1;
  const yMin = minY - yPad;
  const yMax = maxY + yPad;

  const padL = 36;
  const padR = 14;
  const padT = 14;
  const padB = 38;

  return (
    <div ref={ref} className="relative" style={{ height }}>
      <ResponsiveSvg height={height}>
        {(W) => {
          const innerW = W - padL - padR;
          const innerH = height - padT - padB;
          const ySpan = Math.max(1, yMax - yMin);
          const y = (v: number) => padT + (1 - (v - yMin) / ySpan) * innerH;
          const yZero = y(0);
          const slot = innerW / data.length;
          const barW = slot * 0.62;
          const ticks = niceTicks(yMin, yMax, 4);

          return (
            <>
              {ticks.map((t) => (
                <g key={`gy-${t}`}>
                  <line
                    x1={padL}
                    x2={W - padR}
                    y1={y(t)}
                    y2={y(t)}
                    stroke={COLOR_GRID}
                    strokeWidth={1}
                    strokeDasharray={t === 0 ? '0' : '3 3'}
                  />
                  <text x={padL - 8} y={y(t) + 3} textAnchor="end" fontSize={10} fill={COLOR_AXIS}>
                    {formatPnlShort(t)}
                  </text>
                </g>
              ))}
              {data.map((d, i) => {
                const cx = padL + slot * (i + 0.5);
                const top = d.net >= 0 ? y(d.net) : yZero;
                const h = Math.max(1, Math.abs(yZero - y(d.net)));
                const dim = d.trades === 0;
                const isHovered = hoveredLabel === d.label;
                const positive = d.net >= 0;
                const avg = d.trades > 0 ? d.net / d.trades : 0;
                const content = (
                  <div className="flex flex-col gap-0.5 min-w-[190px]">
                    <div className="font-semibold text-gray-900">Hold: {d.label}</div>
                    {dim ? (
                      <div className="text-gray-500">No trades in this bucket</div>
                    ) : (
                      <>
                        <TooltipRow
                          label="Net P&L"
                          value={formatPnlSigned(d.net)}
                          valueClass={positive ? 'text-green-700' : d.net < 0 ? 'text-red-700' : ''}
                        />
                        <TooltipRow label="Trades" value={d.trades} />
                        <TooltipRow
                          label="Wins / Losses"
                          value={
                            <>
                              <span className="text-green-700">{d.wins}</span>
                              <span className="text-gray-400"> / </span>
                              <span className="text-red-700">{d.losses}</span>
                            </>
                          }
                        />
                        <TooltipRow label="Win rate" value={`${d.winRate.toFixed(0)}%`} />
                        <TooltipRow label="Avg / trade" value={formatPnlSigned(avg)} />
                      </>
                    )}
                  </div>
                );
                return (
                  <g key={d.label}>
                    <rect
                      x={cx - barW / 2}
                      y={top}
                      width={barW}
                      height={h}
                      fill={positive ? COLOR_GREEN : COLOR_RED}
                      opacity={dim ? 0.1 : isHovered ? 1 : 0.88}
                      style={{ transition: 'opacity 120ms ease' }}
                    />
                    <rect
                      x={cx - slot / 2}
                      y={padT}
                      width={slot}
                      height={innerH}
                      fill="transparent"
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={(e) => {
                        setHoveredLabel(d.label);
                        showAt(e, content);
                      }}
                      onMouseMove={(e) => showAt(e, content)}
                      onMouseLeave={() => {
                        setHoveredLabel(null);
                        hide();
                      }}
                    />
                    <text
                      x={cx}
                      y={height - 22}
                      textAnchor="middle"
                      fontSize={10}
                      fontWeight={500}
                      fill={COLOR_AXIS_STRONG}
                    >
                      {d.label}
                    </text>
                    <text
                      x={cx}
                      y={height - 8}
                      textAnchor="middle"
                      fontSize={9}
                      fill={COLOR_AXIS}
                    >
                      {dim ? '—' : `${d.trades}t ${d.winRate.toFixed(0)}%`}
                    </text>
                  </g>
                );
              })}
            </>
          );
        }}
      </ResponsiveSvg>
      <ChartTooltip state={tooltip} containerWidth={width} />
    </div>
  );
}


const RADAR_LABELS: { key: keyof Omit<ScoreBreakdown, 'total'>; short: string }[] = [
  { key: 'winRateScore', short: 'Win %' },
  { key: 'profitFactorScore', short: 'PF' },
  { key: 'avgWinLossScore', short: 'W/L' },
  { key: 'recoveryFactorScore', short: 'Rec' },
  { key: 'maxDrawdownScore', short: 'DD' },
  { key: 'consistencyScore', short: 'Cons' },
];

export function ScoreRadarChart({ score }: { score: ScoreBreakdown }) {
  const W = 240;
  const H = 240;
  const cx = W / 2;
  const cy = H / 2;
  const r = 84;
  const N = RADAR_LABELS.length;

  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / N;

  const ringValues = [25, 50, 75, 100];
  const polygonPoints = RADAR_LABELS.map((entry, i) => {
    const v = score[entry.key];
    const ratio = Math.max(0, Math.min(1, v / 100));
    const a = angle(i);
    const x = cx + Math.cos(a) * r * ratio;
    const y = cy + Math.sin(a) * r * ratio;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const tone =
    score.total >= 75 ? 'good' : score.total >= 50 ? 'warn' : 'bad';
  const fillColor = tone === 'good' ? COLOR_GREEN : tone === 'warn' ? '#eab308' : COLOR_RED;
  const fillBg =
    tone === 'good'
      ? 'rgba(22,163,74,0.18)'
      : tone === 'warn'
      ? 'rgba(234,179,8,0.18)'
      : 'rgba(220,38,38,0.18)';
  const totalColor =
    tone === 'good' ? '#14532d' : tone === 'warn' ? '#713f12' : '#7f1d1d';

  return (
    <div className="flex flex-col items-center w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ maxWidth: 240, maxHeight: 240 }}>
        {ringValues.map((rv) => {
          const ratio = rv / 100;
          const points = RADAR_LABELS.map((_, i) => {
            const a = angle(i);
            const x = cx + Math.cos(a) * r * ratio;
            const y = cy + Math.sin(a) * r * ratio;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          }).join(' ');
          return (
            <polygon
              key={`ring-${rv}`}
              points={points}
              fill="none"
              stroke={COLOR_GRID}
              strokeWidth={1}
            />
          );
        })}
        {RADAR_LABELS.map((entry, i) => {
          const a = angle(i);
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          return (
            <line
              key={`spoke-${entry.key}`}
              x1={cx}
              y1={cy}
              x2={x}
              y2={y}
              stroke={COLOR_GRID}
              strokeWidth={1}
            />
          );
        })}
        <polygon points={polygonPoints} fill={fillBg} stroke={fillColor} strokeWidth={2.5} strokeLinejoin="round" />
        {RADAR_LABELS.map((entry, i) => {
          const a = angle(i);
          const labelR = r + 16;
          const x = cx + Math.cos(a) * labelR;
          const y = cy + Math.sin(a) * labelR;
          return (
            <text
              key={`lbl-${entry.key}`}
              x={x}
              y={y + 3}
              textAnchor={Math.cos(a) > 0.3 ? 'start' : Math.cos(a) < -0.3 ? 'end' : 'middle'}
              fontSize={10}
              fill="#4b5563"
              fontWeight={500}
            >
              {entry.short}
            </text>
          );
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize={32} fontWeight={800} fill={totalColor}>
          {score.total.toFixed(0)}
        </text>
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize={9} fill="#6b7280" letterSpacing={0.5}>
          / 100
        </text>
      </svg>
    </div>
  );
}


export function DonutChart({
  segments,
  centerLabel,
  centerValue,
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0) return <EmptyChart />;
  const W = 180;
  const H = 180;
  const cx = W / 2;
  const cy = H / 2;
  const rOuter = 78;
  const rInner = 50;
  let acc = 0;
  const arcs = segments.map((seg) => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += seg.value;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const x1 = cx + Math.cos(start) * rOuter;
    const y1 = cy + Math.sin(start) * rOuter;
    const x2 = cx + Math.cos(end) * rOuter;
    const y2 = cy + Math.sin(end) * rOuter;
    const x3 = cx + Math.cos(end) * rInner;
    const y3 = cy + Math.sin(end) * rInner;
    const x4 = cx + Math.cos(start) * rInner;
    const y4 = cy + Math.sin(start) * rInner;
    const large = end - start > Math.PI ? 1 : 0;
    const d = `M${x1},${y1} A${rOuter},${rOuter} 0 ${large} 1 ${x2},${y2} L${x3},${y3} A${rInner},${rInner} 0 ${large} 0 ${x4},${y4} Z`;
    return { d, seg };
  });
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: 'min(180px, 100%)', height: 'auto', flexShrink: 0 }}
      >
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill={a.seg.color}>
            <title>
              {a.seg.label}: {a.seg.value.toFixed(2)} ({((a.seg.value / total) * 100).toFixed(1)}%)
            </title>
          </path>
        ))}
        {(centerLabel || centerValue) && (
          <>
            {centerValue && (
              <text x={cx} y={cy - 2} textAnchor="middle" fontSize={20} fontWeight={700} fill="#111827">
                {centerValue}
              </text>
            )}
            {centerLabel && (
              <text x={cx} y={cy + 14} textAnchor="middle" fontSize={9} fill="#6b7280">
                {centerLabel}
              </text>
            )}
          </>
        )}
      </svg>
      <div className="flex flex-col gap-1.5 text-xs min-w-0 w-full sm:w-auto">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2 min-w-0">
            <span className="h-2.5 w-2.5 shrink-0" style={{ background: s.color }} />
            <span className="truncate text-gray-700">{s.label}</span>
            <span className="ml-auto tabular-nums text-gray-500">
              {((s.value / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}


export function WinRateGauge({ winRate, wins, losses }: { winRate: number; wins: number; losses: number }) {
  const W = 140;
  const H = 140;
  const cx = W / 2;
  const cy = H / 2;
  const r = 56;
  const stroke = 12;
  const circumference = 2 * Math.PI * r;
  const ratio = Math.max(0, Math.min(1, winRate / 100));
  const offset = circumference * (1 - ratio);
  const color = winRate >= 60 ? COLOR_GREEN : winRate >= 45 ? '#eab308' : COLOR_RED;
  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#ffffff" strokeWidth={stroke} />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="square"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
        <text x={cx} y={cy + 2} textAnchor="middle" fontSize={22} fontWeight={700} fill="#111827">
          {winRate.toFixed(0)}%
        </text>
        <text x={cx} y={cy + 20} textAnchor="middle" fontSize={9} fill="#6b7280">
          win rate
        </text>
      </svg>
      <div className="mt-1 text-[11px] text-gray-500 tabular-nums">
        <span className="text-green-600 font-medium">{wins}W</span>
        {' '}
        <span className="text-red-600 font-medium">{losses}L</span>
      </div>
    </div>
  );
}


function EmptyChart() {
  return (
    <div className="flex h-full min-h-[100px] items-center justify-center text-xs text-gray-400">
      No data
    </div>
  );
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const range = max - min;
  const rough = range / count;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.abs(rough) || 1)));
  const candidates = [1, 2, 2.5, 5, 10].map((m) => m * pow);
  let step = candidates[0];
  for (const c of candidates) {
    if (c >= rough) {
      step = c;
      break;
    }
    step = c;
  }
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step / 2; v += step) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

function niceTimeTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const out: number[] = [];
  const step = (max - min) / (count - 1);
  for (let i = 0; i < count; i++) out.push(min + step * i);
  return out;
}
