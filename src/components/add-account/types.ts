export type AddAccountKind = 'ctrader' | 'mtexpert';

export interface AddAccountFlowProps {
  onAddAccountCtrader: () => Promise<void>;
  onInstallClick: () => void;
  isInstalling: boolean;
  isInstalled: boolean;
  installResult: { copied?: number; targets?: string[]; warnings?: string[] } | null;
  isWindows: boolean;
  onBack?: () => void;
  atAccountLimit?: boolean;
}
