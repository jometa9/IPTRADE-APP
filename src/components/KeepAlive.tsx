'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface KeepAliveProps {
  active: boolean;
  children: ReactNode;
  className?: string;
}

export function KeepAlive({ active, children, className }: KeepAliveProps) {
  return (
    <div
      className={cn('h-full w-full', className)}
      style={{ display: active ? undefined : 'none' }}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}
