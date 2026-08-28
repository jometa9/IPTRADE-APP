'use client';

import { useMemo } from 'react';
import { AccountsPicker } from '@/components/AccountsPicker';
import type { TradingAccount } from '@/lib/trading/types';

interface TerminalFilterHeaderProps {
  accounts: TradingAccount[];
  selectedAccountIds: string[];
  onChange: (ids: string[]) => void;
}

export function TerminalFilterHeader({ accounts, selectedAccountIds, onChange }: TerminalFilterHeaderProps) {
  const pickerAccounts = useMemo(
    () =>
      accounts.map((a) => ({
        id: a.accountId,
        nickname: a.nickname,
        server: a.server,
        platform: a.platform,
        eligible: true,
      })),
    [accounts]
  );

  return (
    <div className="flex items-center border-y border-gray-200 bg-white text-sm">
      <AccountsPicker
        className="ml-auto"
        accounts={pickerAccounts}
        selectedIds={selectedAccountIds}
        onChange={onChange}
      />
    </div>
  );
}
