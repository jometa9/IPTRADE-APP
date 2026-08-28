'use client';

import { OrdersTotalsInline } from '@/components/TradingWindow';

interface HeaderStatusInfoProps {
  showResourcesPref?: boolean;
  resources?: { cpu_usage_percent?: number; ram_used_percent?: number } | null;
  showOrdersTotalsPref?: boolean;
}

export function HeaderStatusInfo({
  showResourcesPref,
  resources,
  showOrdersTotalsPref,
}: HeaderStatusInfoProps) {
  return (
    <div className="flex items-center gap-4">
      {showResourcesPref && resources && (
        <span className="text-sm text-gray-400">
          CPU {(resources as any).cpu_usage_percent ?? 0}% RAM {(resources as any).ram_used_percent ?? 0}%
        </span>
      )}
      {showOrdersTotalsPref && <OrdersTotalsInline />}
    </div>
  );
}
