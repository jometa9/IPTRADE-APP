export interface ApiKeys {
  apiKey: string;
  apiSecret: string;
}

export interface ElectronAPI {
  getPendingDeepLink?: () => Promise<string | null>;
  clearPendingDeepLink?: (url: string) => Promise<void>;
  getServerUrl?: () => Promise<string>;
  getApiKeys?: () => Promise<ApiKeys>;
  checkServerStatus?: () => Promise<{ ok: boolean; url: string }>;
  pingServer?: () => Promise<{ ok: boolean }>;
  openExternalLink?: (url: string) => Promise<void>;
  getPlatform?: () => Promise<string>;
  getIsFullScreen?: () => Promise<boolean>;
  setWindowButtonPosition?: (x: number | null, y: number | null) => Promise<void>;
  onNavigateToSettings?: (callback: () => void) => void;
  onDeepLink?: (callback: (data: { url: string }) => void) => void;
  onSystemSuspend?: (callback: () => void) => void;
  onSystemResume?: (callback: () => void) => void;
  onPrepareQuit?: (callback: () => void) => void;
  quitReady?: () => void;
  onFullScreenChange?: (callback: (isFullScreen: boolean) => void) => void;
  removeAllListeners?: (channel: string) => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
