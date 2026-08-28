'use client';

import { useOutletContext } from 'react-router-dom';
import { HomeContent } from '@/components/TradingWindow';
import type { AppOutletContext } from '@/layouts/AppLayout';

export function HomePage() {
  const ctx = useOutletContext<AppOutletContext>();
  return <HomeContent {...ctx} />;
}
