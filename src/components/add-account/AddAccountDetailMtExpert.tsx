import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { addAccountCardButtonClassWithDisabled } from './cardButtonStyles';

export interface AddAccountDetailMtExpertProps {
  isInstalling: boolean;
  isInstalled: boolean;
  installResult: { copied?: number; targets?: string[]; warnings?: string[] } | null;
  onInstallClick: () => void;
  bare?: boolean;
}

export function AddAccountDetailMtExpert({
  isInstalling,
  isInstalled,
  installResult,
  onInstallClick,
  bare = false,
}: AddAccountDetailMtExpertProps) {
  return (
    <div className={bare ? 'flex min-w-0 flex-col gap-4 text-left' : 'flex min-w-0 flex-col gap-4 rounded-xl border border-gray-200 bg-gray-50 p-5 text-left'}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!bare && <h3 className="text-lg font-semibold text-gray-900">MetaTrader 4 &amp; 5</h3>}
        <ol className="mt-1 space-y-4 text-sm text-gray-600">
          <li className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold text-gray-400">Step 1</span>
            <span className="font-medium text-gray-800">Install IPTRADE</span>
            <span>Click the button below — this copies the add-on into your MetaTrader folders.</span>
          </li>
          <li className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold text-gray-400">Step 2</span>
            <span className="font-medium text-gray-800">Enable AutoTrading in MetaTrader</span>
            <span>Open or refresh your MetaTrader platform and turn on <strong className="font-medium text-gray-700">AutoTrading</strong>. If prompted, allow <strong className="font-medium text-gray-700">DLL imports</strong>.</span>
          </li>
          <li className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold text-gray-400">Step 3</span>
            <span className="font-medium text-gray-800">Attach IPTRADE to a chart</span>
            <span>Drag the IPTRADE add-on onto any chart and allow all permissions. Your accounts will show up here once connected.</span>
          </li>
        </ol>
      </div>
      <div className="w-full">
        <Button
          type="button"
          className={cn(addAccountCardButtonClassWithDisabled(isInstalling || isInstalled), 'mt-2')}
          onClick={onInstallClick}
          disabled={isInstalling || isInstalled}
        >
          {isInstalled ? 'Installed' : isInstalling ? 'Installing…' : 'Install in MetaTrader'}
        </Button>
      </div>
    </div>
  );
}
