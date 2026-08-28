import { useState } from 'react';
import { AddAccountDetailMtExpert } from './AddAccountDetailMtExpert';
import { AddAccountPickScreen } from './AddAccountPickScreen';
import type { AddAccountFlowProps, AddAccountKind } from './types';

export function AddAccountFlow({
  onAddAccountCtrader,
  onInstallClick,
  isInstalling,
  isInstalled,
  installResult,
  isWindows,
}: AddAccountFlowProps) {
  const [kind, setKind] = useState<Exclude<AddAccountKind, 'ctrader'> | null>(null);
  const [ctraderLoading, setCtraderLoading] = useState(false);

  const handleCtraderClick = async () => {
    if (ctraderLoading) return;
    setCtraderLoading(true);
    try {
      await onAddAccountCtrader();
    } finally {
      setCtraderLoading(false);
    }
  };

  const detailContent =
    kind === 'mtexpert' ? (
      <AddAccountDetailMtExpert
        bare
        isInstalling={isInstalling}
        isInstalled={isInstalled}
        installResult={installResult}
        onInstallClick={onInstallClick}
      />
    ) : null;

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center px-4 py-8 text-gray-600 pb-16">
      <p className="text-lg font-semibold text-gray-900">Add accounts</p>
      <div className="mt-2 text-sm text-gray-600 max-w-lg text-center">
        Finish the steps below—then your accounts will show in the list.
      </div>

      <AddAccountPickScreen
        isWindows={isWindows}
        onContinue={setKind}
        onCtraderClick={handleCtraderClick}
        ctraderLoading={ctraderLoading}
        selectedKind={kind}
        onDeselect={() => setKind(null)}
        detailContent={detailContent}
      />

    </div>
  );
}
