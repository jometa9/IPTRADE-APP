import { ArrowLeft, ArrowRight, ArrowUpRight, Loader } from 'lucide-react';
import type { ReactNode } from 'react';
import { publicAssetUrl } from '@/lib/publicAssetUrl';
import { useExternalLink } from '@/hooks/useExternalLink';
import { cn, urls } from '@/lib/utils';
import type { AddAccountKind } from './types';

export interface AddAccountPickScreenProps {
  isWindows: boolean;
  onContinue: (kind: Exclude<AddAccountKind, 'ctrader'>) => void;
  onCtraderClick: () => Promise<void>;
  ctraderLoading: boolean;
  selectedKind: Exclude<AddAccountKind, 'ctrader'> | null;
  onDeselect: () => void;
  detailContent: ReactNode;
}

const pickGroupClass =
  'mx-auto mt-8 w-full max-w-2xl overflow-hidden rounded-xl border border-gray-200 bg-gray-50';

const pickConnectionRowClass =
  'group flex w-full min-w-0 flex-col gap-4 p-5 text-left transition-colors hover:bg-gray-100 sm:flex-row sm:items-start disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer';

const pickConnectionArrowClass =
  'h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-gray-900';

const iconClass = 'object-contain';

function CtraderIcon({ cls }: { cls: string }) {
  return <img src={publicAssetUrl('assets/ctrader.svg')} alt="" aria-hidden className={`self-start h-5 mb-4 ${cls}`} />;
}

function MtExpertIcon({ cls }: { cls: string }) {
  return (
    <div className="self-start mb-3 flex items-center gap-1.5">
      <img src={publicAssetUrl('assets/metatrader4.png')} alt="" aria-hidden className={`h-7 -mt-1 -ml-1 ${cls}`} />
      <img src={publicAssetUrl('assets/metatrader5.png')} alt="" aria-hidden className={`h-7 -mt-1 ${cls}`} />
    </div>
  );
}

interface SelectedRowHeaderProps {
  kind: Exclude<AddAccountKind, 'ctrader'>;
  onDeselect: () => void;
}

function SelectedRowHeader({ onDeselect }: SelectedRowHeaderProps) {
  const title = 'MetaTrader 4 & 5';
  const description =
    'Requires MetaTrader installed and open — installs the IPTRADE Expert Advisor in each platform.';

  return (
    <div className="relative flex w-full min-w-0 flex-col gap-4 p-5 sm:flex-row sm:items-center border-b border-gray-200">
      <button
        type="button"
        onClick={onDeselect}
        className="absolute top-3 right-3 inline-flex cursor-pointer items-center gap-1 rounded-md bg-white border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:text-gray-900 hover:border-gray-300 transition-colors "
        aria-label="Change platform"
      >
        <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
        Change
      </button>
      <div className="flex min-w-0 flex-1 flex-col text-left items-start">
        <MtExpertIcon cls={iconClass} />
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        <p className="mt-1 text-sm text-gray-600">{description}</p>
      </div>
    </div>
  );
}

export function AddAccountPickScreen({
  isWindows,
  onContinue,
  onCtraderClick,
  ctraderLoading,
  selectedKind,
  onDeselect,
  detailContent,
}: AddAccountPickScreenProps) {
  const { openExternalLink } = useExternalLink();

  if (selectedKind !== null) {
    return (
      <div className={pickGroupClass}>
        <SelectedRowHeader kind={selectedKind} onDeselect={onDeselect} />
        <div className="bg-white p-5">{detailContent}</div>
      </div>
    );
  }

  return (
    <div className={pickGroupClass}>
      <div className="flex flex-col md:flex-row">
        <button
          type="button"
          onClick={onCtraderClick}
          disabled={ctraderLoading}
          className={`${pickConnectionRowClass} ${isWindows ? 'md:border-r border-gray-200' : ''}`}
          aria-label="Continue with cTrader"
        >
          <div className="flex min-w-0 flex-1 flex-col items-start text-left">
            <CtraderIcon cls={iconClass} />
            <h3 className="text-lg font-semibold text-gray-900">cTrader</h3>
            <p className="mt-1 text-sm text-gray-600">
              Sign in through your browser — accounts link automatically.
            </p>
          </div>
          <span className="inline-flex shrink-0 self-end rounded p-1">
            {ctraderLoading ? (
              <Loader className="h-4 w-4 animate-spin text-gray-500" aria-hidden />
            ) : (
              <ArrowRight className={pickConnectionArrowClass} aria-hidden />
            )}
          </span>
        </button>

        {isWindows && (
          <button
            type="button"
            onClick={() => onContinue('mtexpert')}
            className={pickConnectionRowClass}
            aria-label="Continue with MetaTrader expert advisor"
          >
            <div className="flex min-w-0 flex-1 flex-col text-left items-start">
              <MtExpertIcon cls={iconClass} />
              <h3 className="text-lg font-semibold text-gray-900">MetaTrader 4 &amp; 5</h3>
              <p className="mt-1 text-sm text-gray-600">
                Requires MetaTrader installed and open — installs the IPTRADE Expert Advisor in each platform.
              </p>
            </div>
            <span className="inline-flex shrink-0 self-end rounded p-1">
              <ArrowRight className={pickConnectionArrowClass} aria-hidden />
            </span>
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => openExternalLink(urls.fiveMTrader)}
        className={cn(pickConnectionRowClass, 'border-t border-gray-200 bg-black hover:bg-neutral-800')}
        aria-label="Copy trades in the cloud with 5MTrader — opens 5mtrader.com"
      >
        <div className="flex min-w-0 flex-1 flex-col text-left items-start">
          <h3 className="text-lg font-semibold text-white">5MTrader</h3>
          <p className="mt-1 text-sm text-white/80">
            Copy trades in the cloud — no need to keep IPTRADE open. Go to 5mtrader.com to copy
            trades 24/7 straight from the cloud.
          </p>
        </div>
        <span className="inline-flex shrink-0 self-end rounded p-1">
          <ArrowUpRight className="h-4 w-4 shrink-0 text-white" aria-hidden />
        </span>
      </button>

    </div>
  );
}
