import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

function useLockdown() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key?.toLowerCase() ?? '';
      const blocked =
        e.key === 'F12' ||
        e.key === 'F5' ||
        (mod && !e.shiftKey && k === 'r') ||
        (mod && e.shiftKey && k === 'r') ||
        (mod && e.shiftKey && k === 'i') ||
        (mod && e.shiftKey && k === 'j') ||
        (mod && k === 'u');
      if (blocked) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, []);
}

function Root() {
  useLockdown();
  return <App />;
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(<Root />);
