import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getPendingDeepLink: () => ipcRenderer.invoke('get-pending-deep-link'),
  clearPendingDeepLink: (url: string) => ipcRenderer.invoke('clear-pending-deep-link', url),
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  getApiKeys: () => ipcRenderer.invoke('get-api-keys'),
  checkServerStatus: () => ipcRenderer.invoke('check-server-status'),
  pingServer: () => ipcRenderer.invoke('ping-server'),
  openExternalLink: (url: string) => ipcRenderer.invoke('open-external-link', url),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  getIsFullScreen: () => ipcRenderer.invoke('get-is-full-screen'),
  setWindowButtonPosition: (x: number | null, y: number | null) =>
    ipcRenderer.invoke('set-window-button-position', { x, y }),
  onNavigateToSettings: (callback: () => void) => {
    ipcRenderer.on('navigate-to-settings', () => callback());
  },
  onDeepLink: (callback: (data: { url: string }) => void) => {
    ipcRenderer.on('deep-link', (_event: IpcRendererEvent, data: { url: string }) => callback(data));
  },
  onSystemSuspend: (callback: () => void) => {
    ipcRenderer.on('system-suspend', () => callback());
  },
  onSystemResume: (callback: () => void) => {
    ipcRenderer.on('system-resume', () => callback());
  },
  onPrepareQuit: (callback: () => void) => {
    ipcRenderer.on('prepare-quit', () => callback());
  },
  quitReady: () => {
    ipcRenderer.send('quit-ready');
  },
  onFullScreenChange: (callback: (isFullScreen: boolean) => void) => {
    ipcRenderer.on('fullscreen-changed', (_event, value: boolean) => callback(!!value));
  },
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
});
