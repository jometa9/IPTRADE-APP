'use client';

import { useOutletContext } from 'react-router-dom';
import { ConfigScreen } from '@/components/ConfigScreen';
import type { AppOutletContext } from '@/layouts/AppLayout';

export function ConfigPage() {
  const ctx = useOutletContext<AppOutletContext>();

  return (
    <ConfigScreen
      onPreferencesChange={ctx.onPreferencesChange}
      preferences={ctx.preferences}
      updatePreferences={ctx.updatePreferences}
    />
  );
}
