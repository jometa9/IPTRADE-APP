import { Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FullPageState } from '@/components/FullPageState';

interface NoAccountsEmptyProps {
  onAddAccounts: () => void;
}

export function NoAccountsEmpty({ onAddAccounts }: NoAccountsEmptyProps) {
  return (
    <FullPageState
      title="No accounts configured"
      subtitle="Add a trading account to start tracking activity here."
      showSpinner={false}
      icon={<Users className="h-6 w-6 text-gray-400 m-2" />}
      className="bg-white"
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAddAccounts}
        className="mt-4 h-9 shrink-0 rounded-lg border border-gray-200 bg-gray-100 text-gray-700 hover:bg-gray-200 hover:text-gray-800"
      >
        Add accounts
      </Button>
    </FullPageState>
  );
}
