import type { HistoryAccount, HistoryDeal } from '@/api';

const HEADERS = [
  'account_id',
  'platform',
  'server',
  'nickname',
  'symbol',
  'side',
  'volume',
  'open_price',
  'close_price',
  'open_time_iso',
  'close_time_iso',
  'open_time_ms',
  'close_time_ms',
  'sl',
  'tp',
  'commission',
  'swap',
  'profit',
  'net_profit',
  'position_id',
  'ticket',
  'deal_id',
] as const;

function escapeCsvField(value: string | number | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toIso(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

function fmtNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '';
  return String(value);
}

interface BuildRowOpts {
  deal: HistoryDeal;
  account: HistoryAccount | undefined;
}

function buildRow({ deal, account }: BuildRowOpts): string {
  const cells: (string | number | null | undefined)[] = [
    deal.account_id,
    deal.platform,
    account?.server ?? deal.server ?? '',
    account?.nickname ?? '',
    deal.symbol,
    deal.side,
    fmtNumber(deal.volume),
    fmtNumber(deal.open_price),
    fmtNumber(deal.close_price),
    toIso(deal.open_time_ms),
    toIso(deal.close_time_ms),
    deal.open_time_ms,
    deal.close_time_ms,
    fmtNumber(deal.sl),
    fmtNumber(deal.tp),
    fmtNumber(deal.commission),
    fmtNumber(deal.swap),
    fmtNumber(deal.profit),
    fmtNumber(deal.net_profit),
    deal.position_id ?? '',
    deal.ticket ?? '',
    deal.deal_id,
  ];
  return cells.map(escapeCsvField).join(',');
}

export interface CsvExportOptions {
  deals: HistoryDeal[];
  accounts: HistoryAccount[];
  fromMs?: number | null;
  toMs?: number | null;
}

export function buildHistoryCsv(opts: CsvExportOptions): string {
  const accountMap = new Map<string, HistoryAccount>();
  for (const a of opts.accounts) accountMap.set(a.account_id, a);
  const sorted = [...opts.deals].sort((a, b) => {
    const ta = a.close_time_ms > 0 ? a.close_time_ms : a.open_time_ms;
    const tb = b.close_time_ms > 0 ? b.close_time_ms : b.open_time_ms;
    return tb - ta;
  });
  const lines: string[] = [];
  lines.push(HEADERS.join(','));
  for (const d of sorted) {
    lines.push(
      buildRow({
        deal: d,
        account: accountMap.get(d.account_id),
      })
    );
  }
  return lines.join('\r\n');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function defaultExportFilename(rangeFromMs?: number | null, rangeToMs?: number | null): string {
  const now = new Date();
  const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  if (rangeFromMs && rangeToMs) {
    const f = new Date(rangeFromMs);
    const t = new Date(rangeToMs);
    const fStr = `${f.getFullYear()}${pad2(f.getMonth() + 1)}${pad2(f.getDate())}`;
    const tStr = `${t.getFullYear()}${pad2(t.getMonth() + 1)}${pad2(t.getDate())}`;
    return `iptrade-history-${fStr}_${tStr}.csv`;
  }
  return `iptrade-history-${ymd}.csv`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
