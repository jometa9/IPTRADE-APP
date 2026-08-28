'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPlatformDisplayName } from '@/lib/trading/utils';
import { sortAccountsByFavorite, useFavoriteAccounts } from '@/lib/favoriteAccounts';

export interface AccountsPickerItem {
  id: string;
  nickname?: string | null;
  server?: string | null;
  platform: string;
  eligible: boolean;
}

interface AccountsPickerProps {
  accounts: AccountsPickerItem[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  className?: string;
  triggerClassName?: string;
  emptyLabel?: string;
  ineligibleTooltip?: string;
  ineligibleLabel?: string;
}

export function AccountsPicker({
  accounts,
  selectedIds,
  onChange,
  className,
  triggerClassName,
  emptyLabel = 'No eligible accounts',
  ineligibleTooltip = 'Not available for EA connections — only API-based accounts (cTrader) are supported',
  ineligibleLabel = 'Not available for EA connections',
}: AccountsPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { isFavorite, toggleFavorite, favorites } = useFavoriteAccounts();

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

  const sortedAccounts = useMemo(() => {
    const sorted = sortAccountsByFavorite(accounts, (a) => a.id, favorites);
    return sorted.slice().sort((a, b) => Number(b.eligible) - Number(a.eligible));
  }, [accounts, favorites]);

  const eligibleCount = useMemo(() => accounts.filter((a) => a.eligible).length, [accounts]);

  const allSelected = selectedIds.length === 0;
  const summary = useMemo(() => {
    if (allSelected) return `All (${eligibleCount})`;
    if (selectedIds.length === 1) {
      const a = accounts.find((x) => x.id === selectedIds[0]);
      return a ? `${a.nickname ?? a.id}` : selectedIds[0];
    }
    return `${selectedIds.length} accounts`;
  }, [allSelected, accounts, eligibleCount, selectedIds]);

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const clearSelection = () => onChange([]);

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-9 items-center gap-2 px-3 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900',
          triggerClassName
        )}
      >
        {summary}
        <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-80 max-h-80 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          <button
            type="button"
            onClick={clearSelection}
            className={cn(
              'relative flex w-full cursor-pointer items-center rounded-none border-b border-gray-200 py-2 pl-3 pr-8 text-left text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 last:border-b-0',
              allSelected && 'bg-gray-100 text-gray-900'
            )}
          >
            <span>All accounts</span>
            {allSelected && (
              <span className="absolute right-2 flex h-4 w-3.5 items-center justify-center">
                <Check className="h-4 w-4" />
              </span>
            )}
          </button>
          {accounts.length === 0 && (
            <div className="px-3 py-3 text-sm text-gray-500">{emptyLabel}</div>
          )}
          {sortedAccounts.map((a) => {
            const checked = !allSelected && selectedIds.includes(a.id);
            const fav = isFavorite(a.id);
            const subtitle = [a.nickname || '', a.server || '', getPlatformDisplayName(a.platform)]
              .filter(Boolean)
              .join(' ');
            if (!a.eligible) {
              return (
                <div
                  key={a.id}
                  className="relative flex items-stretch border-b border-gray-200 last:border-b-0 text-gray-400 bg-gray-50/60"
                  title={ineligibleTooltip}
                >
                  <div className="flex min-w-0 flex-1 items-center py-2 pl-3 pr-3 text-left text-sm cursor-not-allowed">
                    <div className="flex min-w-0 flex-col">
                      <span className="block truncate">{a.id}</span>
                      <span className="block truncate text-xs mt-0.5">{subtitle}</span>
                      <span className="block truncate text-[11px] mt-0.5 italic">
                        {ineligibleLabel}
                      </span>
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div
                key={a.id}
                className={cn(
                  'relative flex items-stretch border-b border-gray-200 last:border-b-0',
                  checked ? 'bg-gray-100 text-gray-900' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                )}
              >
                <button
                  type="button"
                  onClick={() => toggle(a.id)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center py-2 pl-3 pr-11 text-left text-sm"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="block truncate">{a.id}</span>
                    <span className="block truncate text-xs mt-0.5">{subtitle}</span>
                  </div>
                </button>
                {checked && (
                  <span className="pointer-events-none absolute right-11 top-1/2 -translate-y-1/2 flex h-4 w-3.5 items-center justify-center">
                    <Check className="h-4 w-4" />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => toggleFavorite(a.id)}
                  aria-label={fav ? 'Remove from favorites' : 'Mark as favorite'}
                  aria-pressed={fav}
                  className={cn(
                    'flex w-9 shrink-0 cursor-pointer items-center justify-center',
                    fav ? 'text-yellow-500' : 'text-gray-300 hover:text-yellow-500'
                  )}
                >
                  <Star className={cn('h-4 w-4 shrink-0', fav && 'fill-current')} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
