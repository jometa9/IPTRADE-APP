import { useCallback } from 'react';

export const useExternalLink = () => {
  const openExternalLink = useCallback(async (url: string) => {
    const u = (url || '').trim();
    if (!u) return;
    if (window.electronAPI?.openExternalLink) {
      try {
        await window.electronAPI.openExternalLink(u);
      } catch {
        window.open(u, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    window.open(u, '_blank', 'noopener,noreferrer');
  }, []);
  return { openExternalLink };
};
