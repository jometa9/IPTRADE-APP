import React, { createContext, useCallback, useContext, useState } from 'react';

const COPY_ENGINE_ON_BEFORE_OFFLINE_KEY = 'iptrade_copy_engine_on_before_offline';

function readCopyEngineOnBeforeOffline(): boolean | null {
  try {
    const v = localStorage.getItem(COPY_ENGINE_ON_BEFORE_OFFLINE_KEY);
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch {}
  return null;
}

interface SystemSuspendedContextType {
  systemSuspended: boolean;
  setSystemSuspended: (value: boolean) => void;
  suppressNextOfflineSound: boolean;
  setSuppressNextOfflineSound: (value: boolean) => void;
  suppressNextOnlineSound: boolean;
  setSuppressNextOnlineSound: (value: boolean) => void;
  currentCopierEnabled: boolean;
  setCurrentCopierEnabled: (value: boolean) => void;
  copyEngineOnBeforeSuspend: boolean | null;
  setCopyEngineOnBeforeSuspend: (value: boolean | null) => void;
  copyEngineOnBeforeOffline: boolean | null;
  setCopyEngineOnBeforeOffline: (value: boolean | null) => void;
}

const SystemSuspendedContext = createContext<SystemSuspendedContextType>({
  systemSuspended: false,
  setSystemSuspended: () => {},
  suppressNextOfflineSound: false,
  setSuppressNextOfflineSound: () => {},
  suppressNextOnlineSound: false,
  setSuppressNextOnlineSound: () => {},
  currentCopierEnabled: false,
  setCurrentCopierEnabled: () => {},
  copyEngineOnBeforeSuspend: null,
  setCopyEngineOnBeforeSuspend: () => {},
  copyEngineOnBeforeOffline: null,
  setCopyEngineOnBeforeOffline: () => {},
});

export function SystemSuspendedProvider({ children }: { children: React.ReactNode }) {
  const [systemSuspended, setSystemSuspended] = useState(false);
  const [suppressNextOfflineSound, setSuppressNextOfflineSound] = useState(false);
  const [suppressNextOnlineSound, setSuppressNextOnlineSound] = useState(false);
  const [currentCopierEnabled, setCurrentCopierEnabled] = useState(false);
  const [copyEngineOnBeforeSuspend, setCopyEngineOnBeforeSuspend] = useState<boolean | null>(null);
  const [copyEngineOnBeforeOffline, setCopyEngineOnBeforeOfflineState] = useState<boolean | null>(readCopyEngineOnBeforeOffline);
  const setCopyEngineOnBeforeOffline = useCallback((value: boolean | null) => {
    setCopyEngineOnBeforeOfflineState(value);
    try {
      if (value === null) localStorage.removeItem(COPY_ENGINE_ON_BEFORE_OFFLINE_KEY);
      else localStorage.setItem(COPY_ENGINE_ON_BEFORE_OFFLINE_KEY, value ? 'true' : 'false');
    } catch {}
  }, []);
  return (
    <SystemSuspendedContext.Provider
      value={{
        systemSuspended,
        setSystemSuspended,
        suppressNextOfflineSound,
        setSuppressNextOfflineSound,
        suppressNextOnlineSound,
        setSuppressNextOnlineSound,
        currentCopierEnabled,
        setCurrentCopierEnabled,
        copyEngineOnBeforeSuspend,
        setCopyEngineOnBeforeSuspend,
        copyEngineOnBeforeOffline,
        setCopyEngineOnBeforeOffline,
      }}
    >
      {children}
    </SystemSuspendedContext.Provider>
  );
}

export function useSystemSuspended() {
  return useContext(SystemSuspendedContext);
}
