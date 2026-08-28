import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { ApiStartupGate } from './components/ApiStartupGate';
import { ShuttingDownScreen } from './components/ShuttingDownScreen';
import { AppLayout } from './layouts/AppLayout';
import { HomePage } from './pages/HomePage';
import { ConfigPage } from './pages/ConfigPage';
import { LiveLogsPage } from './pages/LiveLogsPage';
import { AuthProvider } from './context/AuthContext';
import { SystemSuspendedProvider, useSystemSuspended } from './context/SystemSuspendedContext';
import { setSystemEngine, updatePreferences } from './api';

function App() {
  useLayoutEffect(() => {
    if (!window.electronAPI?.getPlatform) return;
    window.electronAPI
      .getPlatform()
      .then((p) => {
        document.documentElement.dataset.platform = p;
      })
      .catch(() => {});
  }, []);

  return (
    <ApiStartupGate>
      <AuthProvider>
        <SystemSuspendedProvider>
          <AppContent />
        </SystemSuspendedProvider>
      </AuthProvider>
    </ApiStartupGate>
  );
}

export default App;

const AppContent: React.FC = () => {
  const [isShuttingDown, setIsShuttingDown] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onPrepareQuit) return;
    api.onPrepareQuit(() => {
      setIsShuttingDown(true);
      api.quitReady?.();
    });
  }, []);
  const {
    setSystemSuspended,
    setSuppressNextOnlineSound,
    systemSuspended,
    currentCopierEnabled,
    setCopyEngineOnBeforeSuspend,
  } = useSystemSuspended();
  const systemSuspendedRef = useRef(systemSuspended);
  systemSuspendedRef.current = systemSuspended;
  const copyEngineOnBeforeSuspendRef = useRef<boolean>(false);

  useEffect(() => {
    if (!window.electronAPI?.onNavigateToSettings) return;
    const handler = () => { window.location.hash = '#/config'; };
    window.electronAPI.onNavigateToSettings(handler);
    return () => window.electronAPI?.removeAllListeners?.('navigate-to-settings');
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.onSystemSuspend || !window.electronAPI?.onSystemResume) return;
    const onSuspend = () => {
      const wasOn = currentCopierEnabled;
      copyEngineOnBeforeSuspendRef.current = wasOn;
      setCopyEngineOnBeforeSuspend(wasOn);
      setSystemSuspended(true);
      setSuppressNextOnlineSound(true);
      setSystemEngine('off').catch(() => {});
      updatePreferences({ global_copier_enabled: false }).catch(() => {});
    };
    const onResume = () => {
      const wasEngineOn = copyEngineOnBeforeSuspendRef.current;
      copyEngineOnBeforeSuspendRef.current = false;
      setCopyEngineOnBeforeSuspend(null);
      setSystemSuspended(false);
      if (wasEngineOn) {
        setSuppressNextOnlineSound(true);
        updatePreferences({ global_copier_enabled: true }).catch(() => {});
      }
      setSystemEngine('on').catch(() => {});
    };
    window.electronAPI.onSystemSuspend(onSuspend);
    window.electronAPI.onSystemResume(onResume);
    return () => {
      window.electronAPI?.removeAllListeners?.('system-suspend');
      window.electronAPI?.removeAllListeners?.('system-resume');
    };
  }, [
    setSystemSuspended,
    setSuppressNextOnlineSound,
    currentCopierEnabled,
    setCopyEngineOnBeforeSuspend,
  ]);

  if (isShuttingDown) return <div className="h-full min-h-0"><ShuttingDownScreen /></div>;

  return (
    <HashRouter>
      <div className="h-full min-h-0">
        <Routes>
          <Route path="/" element={<AppLayout isShuttingDown={isShuttingDown} />}>
            <Route index element={<HomePage />} />
            <Route path="config" element={<ConfigPage />} />
            <Route path="logs" element={<LiveLogsPage />} />
            <Route path="history" element={null} />
            <Route path="terminal" element={null} />
          </Route>
        </Routes>
      </div>
    </HashRouter>
  );
};
