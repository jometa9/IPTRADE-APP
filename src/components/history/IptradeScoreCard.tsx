'use client';

import { cn } from '@/lib/utils';
import type { IptradeGrade, IptradeScore } from './statisticsMath';

interface IptradeScoreCardProps {
  score: IptradeScore;
}

const GRADE_TONE: Record<IptradeGrade, { fg: string; bg: string; ring: string }> = {
  S: { fg: 'text-emerald-700', bg: 'bg-emerald-100', ring: 'ring-emerald-200' },
  A: { fg: 'text-green-700', bg: 'bg-green-100', ring: 'ring-green-200' },
  B: { fg: 'text-sky-700', bg: 'bg-sky-100', ring: 'ring-sky-200' },
  C: { fg: 'text-amber-700', bg: 'bg-amber-100', ring: 'ring-amber-200' },
  D: { fg: 'text-orange-700', bg: 'bg-orange-100', ring: 'ring-orange-200' },
  F: { fg: 'text-red-700', bg: 'bg-red-100', ring: 'ring-red-200' },
};

function barColor(value: number): string {
  if (value >= 75) return 'bg-green-500';
  if (value >= 60) return 'bg-sky-500';
  if (value >= 45) return 'bg-amber-500';
  if (value >= 30) return 'bg-orange-500';
  return 'bg-red-500';
}

export function IptradeScoreCard({ score }: IptradeScoreCardProps) {
  const tone = GRADE_TONE[score.grade];
  return (
    <div className="flex h-full flex-col items-start px-4 pt-2 pb-3">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex h-16 w-16 items-center justify-center text-3xl font-bold ring-2 ring-offset-1',
            tone.bg,
            tone.fg,
            tone.ring
          )}
          aria-label={`Grade ${score.grade}`}
        >
          {score.grade}
        </div>
        <div className="flex flex-col items-start">
          <div className="text-[10px] font-semibold uppercase text-gray-500">IPTRADE Score</div>
          <div className="text-3xl font-bold tabular-nums leading-none text-gray-900">
            {score.total.toFixed(0)}
            <span className="text-base text-gray-400">/100</span>
          </div>
          <div className={cn('mt-1 text-[11px] font-medium', tone.fg)}>{score.tier}</div>
        </div>
      </div>

      <div className="mt-4 w-full">
        {score.factors.map((f) => (
          <div key={f.id} className="mb-2 last:mb-0">
            <div className="mb-1 flex items-center justify-between text-[11px]">
              <span className="text-gray-500">{f.label}</span>
              <span className="tabular-nums font-medium text-gray-700">
                {f.value.toFixed(0)}
                <span className="ml-1 text-[10px] text-gray-400">×{(f.weight * 100).toFixed(0)}%</span>
              </span>
            </div>
            <div className="relative h-1.5 overflow-hidden bg-gray-200/70">
              <div
                className={cn('absolute inset-y-0 left-0 transition-all', barColor(f.value))}
                style={{ width: `${Math.max(0, Math.min(100, f.value))}%` }}
              />
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
